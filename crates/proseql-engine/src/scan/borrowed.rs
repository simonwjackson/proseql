//! Borrow JSON keys and unescaped strings from a line. Escaped strings use
//! serde's owned visitor. Complex schemas/operators use the canonical decoder.
use std::{borrow::Cow, fmt};

use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    ser::{SerializeMap, SerializeSeq},
    Deserialize, Deserializer, Serialize, Serializer,
};
use serde_json::{Number, Value};

use crate::descriptor::SchemaNode;

#[derive(Debug)]
pub enum BorrowedValue<'a> {
    Null,
    Bool(bool),
    Number(Number),
    String(Cow<'a, str>),
    Array(Vec<BorrowedValue<'a>>),
    Object(Vec<(Cow<'a, str>, BorrowedValue<'a>)>),
}
struct JsonVisitor;
impl<'de> Visitor<'de> for JsonVisitor {
    type Value = BorrowedValue<'de>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(BorrowedValue::Null)
    }
    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(BorrowedValue::Bool(value))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(BorrowedValue::Number(value.into()))
    }
    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(BorrowedValue::Number(value.into()))
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
        Number::from_f64(value)
            .map(BorrowedValue::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }
    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
        Ok(BorrowedValue::String(Cow::Borrowed(value)))
    }
    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(BorrowedValue::String(Cow::Owned(value.into())))
    }
    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(BorrowedValue::String(Cow::Owned(value)))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(BorrowedValue::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields: Vec<(Cow<'de, str>, BorrowedValue<'de>)> = Vec::new();
        while let Some(Key(key)) = map.next_key()? {
            let value = map.next_value()?;
            if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == &key) {
                *old = value;
            } else {
                fields.push((key, value));
            }
        }
        Ok(BorrowedValue::Object(fields))
    }
}
struct Key<'a>(Cow<'a, str>);
impl<'de> Deserialize<'de> for Key<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match deserializer.deserialize_str(JsonVisitor)? {
            BorrowedValue::String(key) => Ok(Key(key)),
            _ => unreachable!("string visitor"),
        }
    }
}
impl<'de> Deserialize<'de> for BorrowedValue<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}
impl Serialize for BorrowedValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => value.serialize(serializer),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(values) => {
                let mut seq = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    seq.serialize_element(value)?;
                }
                seq.end()
            }
            Self::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}
impl BorrowedValue<'_> {
    pub fn get(&self, path: &str) -> Option<&Self> {
        let mut value = self;
        for part in path.split('.') {
            let Self::Object(fields) = value else {
                return None;
            };
            value = &fields.iter().find(|(key, _)| key == part)?.1;
        }
        Some(value)
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(value) => value.as_f64(),
            _ => None,
        }
    }
    pub fn to_owned(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(*value),
            Self::Number(value) => Value::Number(value.clone()),
            Self::String(value) => Value::String(value.to_string()),
            Self::Array(values) => Value::Array(values.iter().map(Self::to_owned).collect()),
            Self::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_owned()))
                    .collect(),
            ),
        }
    }
    pub fn scalar_eq(&self, value: &Value) -> bool {
        match (self, value) {
            (Self::Null, Value::Null) => true,
            (Self::Bool(a), Value::Bool(b)) => a == b,
            (Self::String(a), Value::String(b)) => a.as_ref() == b,
            (Self::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            _ => false,
        }
    }
    /// Success is a decoded row. Failure delegates error construction and
    /// transforms/checks to the canonical storage decoder, never a new error.
    pub fn decode_simple(&mut self, schema: &SchemaNode) -> bool {
        match schema {
            SchemaNode::Str => matches!(self, Self::String(_)),
            SchemaNode::Num => matches!(self, Self::Number(_)),
            SchemaNode::Bool => matches!(self, Self::Bool(_)),
            SchemaNode::Unknown => true,
            SchemaNode::NullOr(inner) if matches!(self, Self::Null) => {
                let _ = inner;
                true
            }
            SchemaNode::NullOr(inner)
            | SchemaNode::Optional(inner)
            | SchemaNode::OptionalWithDefault { inner, .. } => self.decode_simple(inner),
            SchemaNode::Struct { fields } => {
                let Self::Object(values) = self else {
                    return false;
                };
                for field in fields {
                    match values.iter_mut().find(|(name, _)| name == &field.name) {
                        Some((_, value)) => {
                            if !value.decode_simple(&field.schema) {
                                return false;
                            }
                        }
                        None => {
                            if !matches!(
                                field.schema,
                                SchemaNode::Optional(_) | SchemaNode::OptionalWithDefault { .. }
                            ) {
                                return false;
                            }
                        }
                    }
                }
                values.retain(|(name, _)| fields.iter().any(|field| field.name == *name));
                values.sort_by_key(|(name, _)| {
                    fields
                        .iter()
                        .position(|field| field.name == *name)
                        .unwrap_or(usize::MAX)
                });
                true
            }
            SchemaNode::Array { item } => match self {
                Self::Array(values) => values.iter_mut().all(|value| value.decode_simple(item)),
                _ => false,
            },
            _ => false,
        }
    }
    pub fn matches_where(&self, clause: &Value) -> Option<bool> {
        let Some(fields) = clause.as_object() else {
            return Some(true);
        };
        for (key, condition) in fields {
            let matched = match key.as_str() {
                "$and" | "$or" => {
                    let Some(children) = condition.as_array() else {
                        return Some(false);
                    };
                    let and = key == "$and";
                    let mut answer = and;
                    for child in children {
                        let matched = child.is_object()
                            && !crate::value::is_boundary_undefined(child)
                            && self.matches_where(child)?;
                        if matched != and {
                            answer = !and;
                            break;
                        }
                    }
                    answer
                }
                "$not" => !self.matches_where(condition)?,
                key if key.starts_with('$') => return None,
                key => match self.get(key) {
                    Some(value) => value.matches_field(condition)?,
                    None => {
                        crate::value::is_boundary_undefined(condition)
                            || condition
                                .get("$eq")
                                .is_some_and(crate::value::is_boundary_undefined)
                    }
                },
            };
            if !matched {
                return Some(false);
            }
        }
        Some(true)
    }
    fn matches_field(&self, condition: &Value) -> Option<bool> {
        if matches!(self, Self::Array(_) | Self::Object(_)) {
            return None;
        }
        let Some(ops) = condition.as_object() else {
            return Some(self.scalar_eq(condition));
        };
        if !ops.keys().any(|key| key.starts_with('$')) {
            return match self {
                Self::Object(_) => self.matches_where(condition),
                _ => Some(false),
            };
        }
        let mut matched = true;
        for (op, operand) in ops {
            matched &= match op.as_str() {
                "$eq" => self.scalar_eq(operand),
                "$ne" => !self.scalar_eq(operand),
                "$in" | "$nin" => {
                    let Some(values) = operand.as_array() else {
                        return Some(false);
                    };
                    let found = values.iter().any(|value| self.scalar_eq(value));
                    if op == "$in" {
                        found
                    } else {
                        !found
                    }
                }
                "$gt" | "$gte" | "$lt" | "$lte" => {
                    let order = match (self, operand) {
                        (Self::String(a), Value::String(b)) => Some(a.as_ref().cmp(b)),
                        (Self::Number(a), Value::Number(b)) => {
                            a.as_f64()?.partial_cmp(&b.as_f64()?)
                        }
                        (Self::String(_) | Self::Number(_), _) => None,
                        _ => return Some(false),
                    };
                    order.is_none_or(|order| match op.as_str() {
                        "$gt" => order.is_gt(),
                        "$gte" => order.is_ge(),
                        "$lt" => order.is_lt(),
                        _ => order.is_le(),
                    })
                }
                _ => return None,
            };
        }
        Some(matched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_filters_match_canonical_operators() {
        use serde_json::json;
        let values = [
            json!(null),
            json!(true),
            json!(false),
            json!(0),
            json!(50.0),
            json!("a"),
            json!("2025-02-01"),
        ];
        let mut filters = vec![
            json!({"missing":{"$ne":1}}),
            json!({"$and":[]}),
            json!({"$or":[]}),
            json!({"$not":{"value":"a"}}),
        ];
        for operator in ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"] {
            for operand in &values {
                filters.push(json!({"value":{operator: if operator == "$in" || operator == "$nin" { json!([operand, "a"]) } else { operand.clone() }}}));
            }
        }
        for value in values {
            let owned = json!({"value":value});
            let bytes = owned.to_string();
            let borrowed: BorrowedValue<'_> = serde_json::from_str(&bytes).unwrap();
            for filter in &filters {
                assert_eq!(
                    borrowed.matches_where(filter),
                    Some(crate::query::filter::matches_where(&owned, filter)),
                    "row={owned} filter={filter}"
                );
            }
        }
    }

    #[test]
    fn borrows_plain_strings_and_owns_escaped_strings() {
        let row: BorrowedValue<'_> =
            serde_json::from_slice(br#"{"a":"plain","b":"esca\nped"}"#).unwrap();
        assert!(matches!(
            row.get("a"),
            Some(BorrowedValue::String(Cow::Borrowed(_)))
        ));
        assert!(matches!(
            row.get("b"),
            Some(BorrowedValue::String(Cow::Owned(_)))
        ));
    }
}
