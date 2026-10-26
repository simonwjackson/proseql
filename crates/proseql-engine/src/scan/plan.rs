//! Field positions compiled against the prepared top-level decoder. Optional
//! fields use the presence mask, so absent fields never alias the next slot.
use super::borrowed::BorrowedValue;
use crate::descriptor::SchemaNode;
use serde_json::Value;

#[derive(Clone)]
pub(super) struct Field {
    pub name: String,
    position: Option<usize>,
    tail: Option<String>,
}
impl Field {
    pub fn new(name: &str, schema: Option<&SchemaNode>) -> Self {
        let (head, tail) = name
            .split_once('.')
            .map_or((name, None), |(head, tail)| (head, Some(tail.to_owned())));
        let position = match schema {
            Some(SchemaNode::Struct { fields }) => {
                fields.iter().position(|field| field.name == head)
            }
            _ => None,
        };
        Self {
            name: name.into(),
            position,
            tail,
        }
    }
    pub fn get<'a>(
        &self,
        row: &'a BorrowedValue<'a>,
        present: u128,
    ) -> Option<&'a BorrowedValue<'a>> {
        let position = self.position?;
        if present & (1u128 << position) == 0 {
            return None;
        }
        let BorrowedValue::Object(values) = row else {
            return None;
        };
        let compact = (present & ((1u128 << position) - 1)).count_ones() as usize;
        let value = &values.get(compact)?.1;
        match &self.tail {
            Some(tail) => value.get(tail),
            None => Some(value),
        }
    }
}
pub(super) struct PositionedRow<'a> {
    pub row: &'a BorrowedValue<'a>,
    pub present: u128,
}

pub(super) enum Filter {
    All(Vec<Self>),
    And(Vec<Option<Self>>),
    Or(Vec<Option<Self>>),
    Not(Box<Self>),
    Field(Field, Value),
    Constant(bool),
    Unsupported,
}
impl Filter {
    pub fn new(clause: &Value, schema: Option<&SchemaNode>) -> Self {
        let Some(fields) = clause.as_object() else {
            return Self::Constant(true);
        };
        Self::All(
            fields
                .iter()
                .map(|(name, condition)| match name.as_str() {
                    "$and" | "$or" => match condition.as_array() {
                        Some(children) => {
                            let children = children
                                .iter()
                                .map(|child| {
                                    (child.is_object()
                                        && !crate::value::is_boundary_undefined(child))
                                    .then(|| Self::new(child, schema))
                                })
                                .collect();
                            if name == "$and" {
                                Self::And(children)
                            } else {
                                Self::Or(children)
                            }
                        }
                        None => Self::Constant(false),
                    },
                    "$not" => Self::Not(Box::new(Self::new(condition, schema))),
                    name if name.starts_with('$') => Self::Unsupported,
                    name => Self::Field(Field::new(name, schema), condition.clone()),
                })
                .collect(),
        )
    }
    pub fn matches(&self, row: &PositionedRow<'_>) -> Option<bool> {
        match self {
            Self::All(children) => {
                for child in children {
                    if !child.matches(row)? {
                        return Some(false);
                    }
                }
                Some(true)
            }
            Self::And(children) | Self::Or(children) => {
                let and = matches!(self, Self::And(_));
                for child in children {
                    let matched = match child {
                        Some(child) => child.matches(row)?,
                        None => false,
                    };
                    if matched != and {
                        return Some(!and);
                    }
                }
                Some(and)
            }
            Self::Not(child) => child.matches(row).map(|answer| !answer),
            Self::Field(field, condition) => match field.get(row.row, row.present) {
                Some(value) => value.matches_field(condition),
                None => Some(
                    crate::value::is_boundary_undefined(condition)
                        || condition
                            .get("$eq")
                            .is_some_and(crate::value::is_boundary_undefined),
                ),
            },
            Self::Constant(value) => Some(*value),
            Self::Unsupported => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        descriptor::StructField,
        scan::{
            decoder::SimpleDecoder,
            fold::{Fold, GroupFold},
        },
    };
    use serde_json::json;
    #[test]
    fn compiled_positions_keep_optional_holes_nested_fields_duplicates_and_order() {
        let schema = SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "optional".into(),
                    schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                },
                StructField {
                    name: "g".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "value".into(),
                    schema: SchemaNode::Num,
                },
                StructField {
                    name: "nested".into(),
                    schema: SchemaNode::Unknown,
                },
            ],
        };
        let decoder = SimpleDecoder::new(&schema).unwrap();
        let rows = [
            json!({"g":"b","value":1e16,"nested":{"v":2}}),
            json!({"optional":"yes","g":"a","value":1.0,"nested":{"v":null}}),
            json!({"g":"b","value":-1e16,"nested":false}),
            json!({"g":"b","value":1.0,"nested":{"v":3}}),
        ];
        let config = crate::query::aggregate::AggregateConfig {
            count: true,
            sum: vec!["value".into(), "value".into()],
            avg: vec!["value".into(), "value".into()],
            min: vec!["nested.v".into()],
            max: vec!["value".into()],
        };
        let fields = vec!["g".into(), "optional".into()];
        let mut fold = Fold::new(&config, Some(&schema));
        let mut groups = GroupFold::new(&fields, &config, Some(&schema));
        for row in &rows {
            let bytes = serde_json::to_vec(row).unwrap();
            let (row, present) = decoder.decode_positioned(&bytes).unwrap().unwrap();
            let positioned = PositionedRow { row: &row, present };
            fold.push(&positioned);
            groups.push(&positioned);
            for filter in [
                json!({"value":{"$gte":0,"$lt":10}}),
                json!({"optional":{"$ne":1}}),
                json!({"nested.v":3}),
                json!({"$or":[null,{"g":"a"}]}),
                json!({"$and":[{"g":"b"},{"$not":{"value":1}}]}),
                json!({"$or":[{"g":"b"},{"$unsupported":1}]}),
            ] {
                assert_eq!(
                    Filter::new(&filter, Some(&schema)).matches(&positioned),
                    row.matches_where(&filter),
                    "{filter}"
                );
            }
        }
        assert_eq!(
            fold.finish(),
            crate::query::aggregate::compute_aggregates(&rows, &config)
        );
        assert_eq!(
            groups.finish(),
            crate::query::aggregate::compute_grouped_aggregates(&rows, &fields, &config)
        );
    }
}
