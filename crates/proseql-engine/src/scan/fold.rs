//! Folds over borrowed or canonical rows. Only a new group or a new min/max
//! retains an owned value. Hashing and group-key verification serialize into
//! writers, not per-row Strings. Hash collisions always get exact comparison.
use std::{
    collections::HashMap,
    hash::Hasher,
    io::{self, Write},
};

use serde_json::{Map, Value};

use super::{
    borrowed::BorrowedValue,
    plan::{Field, PositionedRow},
};
use crate::descriptor::SchemaNode;
use crate::query::{
    aggregate::{AggregateConfig, AggregateResult, GroupResult},
    filter::get_nested_value,
};
use std::sync::Arc;

#[derive(Clone, Copy)]
pub(super) enum Cell<'a> {
    Borrowed(&'a BorrowedValue<'a>),
    Owned(&'a Value),
}
impl Cell<'_> {
    fn number(self) -> Option<f64> {
        match self {
            Self::Borrowed(value) => value.as_f64(),
            Self::Owned(value) => value.as_f64(),
        }
    }
    fn is_null(self) -> bool {
        match self {
            Self::Borrowed(value) => matches!(value, BorrowedValue::Null),
            Self::Owned(value) => value.is_null(),
        }
    }
    fn owned(self) -> Value {
        match self {
            Self::Borrowed(value) => value.to_owned(),
            Self::Owned(value) => value.clone(),
        }
    }
    fn compare(self, other: &Value) -> i64 {
        if let (Some(a), Some(b)) = (self.number(), other.as_f64()) {
            return if a < b {
                -1
            } else if a > b {
                1
            } else {
                0
            };
        }
        if let (Self::Borrowed(BorrowedValue::String(a)), Value::String(b)) = (self, other) {
            return match a.as_ref().cmp(b) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            };
        }
        crate::query::aggregate::compare_for_min_max(&self.owned(), other)
    }
    fn scalar_key(self) -> Option<Value> {
        match self {
            Self::Borrowed(BorrowedValue::String(value)) => Some(Value::String(value.to_string())),
            Self::Borrowed(BorrowedValue::Bool(value)) => Some(Value::Bool(*value)),
            Self::Borrowed(BorrowedValue::Null) => Some(Value::Null),
            Self::Owned(value) if value.is_string() || value.is_boolean() || value.is_null() => {
                Some(value.clone())
            }
            _ => None,
        }
    }
    fn matches_scalar_key(self, expected: &Value) -> bool {
        match (self, expected) {
            (Self::Borrowed(BorrowedValue::String(value)), Value::String(expected)) => {
                value.as_ref() == expected
            }
            (Self::Borrowed(BorrowedValue::Bool(value)), Value::Bool(expected)) => {
                value == expected
            }
            (Self::Borrowed(BorrowedValue::Null), Value::Null) => true,
            (Self::Owned(value), expected) => value == expected,
            _ => false,
        }
    }
    fn json(self, writer: &mut impl Write) {
        match self {
            Self::Borrowed(value) => serde_json::to_writer(writer, value),
            Self::Owned(value) => serde_json::to_writer(writer, value),
        }
        .expect("infallible JSON group writer");
    }
}
pub(super) trait Row {
    fn cell(&self, field: &Field) -> Option<Cell<'_>>;
}
impl Row for Value {
    fn cell(&self, field: &Field) -> Option<Cell<'_>> {
        get_nested_value(self, &field.name).map(Cell::Owned)
    }
}
impl Row for BorrowedValue<'_> {
    fn cell(&self, field: &Field) -> Option<Cell<'_>> {
        self.get(&field.name).map(Cell::Borrowed)
    }
}
impl Row for PositionedRow<'_> {
    fn cell(&self, field: &Field) -> Option<Cell<'_>> {
        field.get(self.row, self.present).map(Cell::Borrowed)
    }
}
struct FoldFields([Vec<(Field, usize)>; 4]);
impl FoldFields {
    fn new(config: &AggregateConfig, schema: Option<&SchemaNode>) -> Self {
        Self(
            [&config.sum, &config.avg, &config.min, &config.max].map(|fields| {
                fields
                    .iter()
                    .enumerate()
                    .map(|(index, name)| {
                        (
                            Field::new(name, schema),
                            fields
                                .iter()
                                .position(|field| field == name)
                                .unwrap_or(index),
                        )
                    })
                    .collect()
            }),
        )
    }
}

pub(super) struct Fold<'a> {
    config: &'a AggregateConfig,
    fields: Arc<FoldFields>,
    count: u64,
    sum: Vec<f64>,
    avg: Vec<(f64, u64)>,
    min: Vec<Option<Value>>,
    max: Vec<Option<Value>>,
}
impl<'a> Fold<'a> {
    pub fn new(config: &'a AggregateConfig, schema: Option<&SchemaNode>) -> Self {
        Self::with_fields(config, Arc::new(FoldFields::new(config, schema)))
    }
    fn with_fields(config: &'a AggregateConfig, fields: Arc<FoldFields>) -> Self {
        Self {
            config,
            fields,
            count: 0,
            sum: vec![0.0; config.sum.len()],
            avg: vec![(0.0, 0); config.avg.len()],
            min: vec![None; config.min.len()],
            max: vec![None; config.max.len()],
        }
    }
    pub fn push(&mut self, row: &impl Row) {
        if self.config.count {
            self.count += 1;
        }
        // The canonical accumulator uses a map per configured field: repeated
        // field names accumulate repeatedly into that same slot.
        for (field, first) in &self.fields.0[0] {
            if let Some(value) = row.cell(field).and_then(Cell::number) {
                self.sum[*first] += value;
            }
        }
        for (field, first) in &self.fields.0[1] {
            if let Some(value) = row.cell(field).and_then(Cell::number) {
                self.avg[*first].0 += value;
                self.avg[*first].1 += 1;
            }
        }
        for (fields, slots, minimum) in [
            (&self.fields.0[2], &mut self.min, true),
            (&self.fields.0[3], &mut self.max, false),
        ] {
            for (field, first) in fields {
                let Some(value) = row.cell(field).filter(|value| !value.is_null()) else {
                    continue;
                };
                if slots[*first].as_ref().is_none_or(|current| {
                    if minimum {
                        value.compare(current) < 0
                    } else {
                        value.compare(current) > 0
                    }
                }) {
                    slots[*first] = Some(value.owned());
                }
            }
        }
    }
    pub fn finish(self) -> AggregateResult {
        let unique = |fields: &[String], index: usize| {
            fields[..index].iter().all(|field| field != &fields[index])
        };
        AggregateResult {
            count: self.config.count.then_some(self.count),
            sum: (!self.config.sum.is_empty()).then(|| {
                self.config
                    .sum
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| unique(&self.config.sum, *index))
                    .map(|(index, field)| (field.clone(), self.sum[index]))
                    .collect()
            }),
            avg: (!self.config.avg.is_empty()).then(|| {
                self.config
                    .avg
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| unique(&self.config.avg, *index))
                    .map(|(index, field)| {
                        let (sum, count) = self.avg[index];
                        (field.clone(), (count > 0).then(|| sum / count as f64))
                    })
                    .collect()
            }),
            min: (!self.config.min.is_empty()).then(|| {
                self.config
                    .min
                    .iter()
                    .enumerate()
                    .zip(self.min)
                    .filter(|((index, _), _)| unique(&self.config.min, *index))
                    .filter_map(|((_, field), value)| value.map(|value| (field.clone(), value)))
                    .collect()
            }),
            max: (!self.config.max.is_empty()).then(|| {
                self.config
                    .max
                    .iter()
                    .enumerate()
                    .zip(self.max)
                    .filter(|((index, _), _)| unique(&self.config.max, *index))
                    .filter_map(|((_, field), value)| value.map(|value| (field.clone(), value)))
                    .collect()
            }),
        }
    }
}

pub(super) struct GroupFold<'a> {
    fields: &'a [String],
    positions_fields: Vec<Field>,
    fold_fields: Arc<FoldFields>,
    config: &'a AggregateConfig,
    positions: HashMap<u64, Vec<usize>>,
    groups: Vec<(Vec<u8>, Fold<'a>)>,
    scalar_keys: Vec<Option<Vec<Option<Value>>>>,
    recent: [Option<usize>; 2],
}
fn write_key(row: &impl Row, fields: &[Field], writer: &mut impl Write) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            writer.write_all(b"\0").expect("group separator");
        }
        match row.cell(field) {
            Some(value) => value.json(writer),
            None => writer
                .write_all(b"__PTDB_UNDEFINED__")
                .expect("undefined group key"),
        }
    }
}
struct HashWriter(std::collections::hash_map::DefaultHasher);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct CompareWriter<'a> {
    expected: &'a [u8],
    position: usize,
    equal: bool,
}
impl Write for CompareWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.equal &= self
            .expected
            .get(self.position..self.position.saturating_add(bytes.len()))
            == Some(bytes);
        self.position = self.position.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<'a> GroupFold<'a> {
    pub fn new(
        fields: &'a [String],
        config: &'a AggregateConfig,
        schema: Option<&SchemaNode>,
    ) -> Self {
        Self {
            fields,
            positions_fields: fields.iter().map(|name| Field::new(name, schema)).collect(),
            fold_fields: Arc::new(FoldFields::new(config, schema)),
            config,
            positions: HashMap::new(),
            groups: Vec::new(),
            scalar_keys: Vec::new(),
            recent: [None; 2],
        }
    }
    pub fn push(&mut self, row: &impl Row) {
        // Time-ordered data repeatedly visits the same few scalar groups.
        // Exact scalar comparison avoids serializing and hashing those keys
        // twice per row. Numbers/objects retain canonical JSON-key semantics.
        for index in self.recent.into_iter().flatten() {
            if self.scalar_keys[index].as_ref().is_some_and(|key| {
                self.positions_fields
                    .iter()
                    .zip(key)
                    .all(|(field, expected)| match (row.cell(field), expected) {
                        (None, None) => true,
                        (Some(value), Some(expected)) => value.matches_scalar_key(expected),
                        _ => false,
                    })
            }) {
                self.groups[index].1.push(row);
                return;
            }
        }
        let mut writer = HashWriter(std::collections::hash_map::DefaultHasher::new());
        write_key(row, &self.positions_fields, &mut writer);
        let hash = writer.0.finish();
        let found = self.positions.get(&hash).and_then(|positions| {
            positions.iter().copied().find(|index| {
                let mut writer = CompareWriter {
                    expected: &self.groups[*index].0,
                    position: 0,
                    equal: true,
                };
                write_key(row, &self.positions_fields, &mut writer);
                writer.equal && writer.position == writer.expected.len()
            })
        });
        let index = found.unwrap_or_else(|| {
            let mut key = Vec::new();
            write_key(row, &self.positions_fields, &mut key);
            let index = self.groups.len();
            let scalar_key = self
                .positions_fields
                .iter()
                .map(|field| match row.cell(field) {
                    None => Some(None),
                    Some(value) => value.scalar_key().map(Some),
                })
                .collect();
            self.scalar_keys.push(scalar_key);
            self.groups.push((
                key,
                Fold::with_fields(self.config, Arc::clone(&self.fold_fields)),
            ));
            self.positions.entry(hash).or_default().push(index);
            index
        });
        self.recent = [Some(index), self.recent[0]];
        self.groups[index].1.push(row);
    }
    pub fn finish(self) -> Vec<GroupResult> {
        self.groups
            .into_iter()
            .map(|(key, fold)| {
                let values: Vec<&[u8]> = key.split(|byte| *byte == 0).collect();
                let mut group = Map::new();
                for (index, field) in self.fields.iter().enumerate() {
                    let value = values.get(index).copied().unwrap_or(b"__PTDB_UNDEFINED__");
                    if value != b"__PTDB_UNDEFINED__" {
                        group.insert(
                            field.clone(),
                            serde_json::from_slice(value).unwrap_or(Value::Null),
                        );
                    }
                }
                let aggregate = fold.finish();
                GroupResult {
                    group,
                    count: aggregate.count,
                    sum: aggregate.sum,
                    avg: aggregate.avg,
                    min: aggregate.min,
                    max: aggregate.max,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recent_scalar_groups_keep_canonical_keys_order_and_float_additions() {
        let mut rows = Vec::new();
        for number in [1e16, 1.0, -1e16] {
            for key in [
                json!("a\n"),
                json!(true),
                json!(null),
                json!(1),
                json!(-0.0),
                json!([1]),
                json!({"a":1}),
                json!("__PTDB_UNDEFINED__"),
            ] {
                rows.push(json!({"g":key,"value":number}));
                rows.push(json!({"g":key,"value":number}));
            }
            rows.push(json!({"value":number}));
        }
        let fields = vec!["g".into()];
        let config = AggregateConfig {
            count: true,
            sum: vec!["value".into()],
            ..Default::default()
        };
        let expected = crate::query::aggregate::compute_grouped_aggregates(&rows, &fields, &config);
        let mut owned = GroupFold::new(&fields, &config, None);
        let mut borrowed = GroupFold::new(&fields, &config, None);
        for row in &rows {
            owned.push(row);
            let text = serde_json::to_string(row).unwrap();
            let row: BorrowedValue<'_> = serde_json::from_str(&text).unwrap();
            borrowed.push(&row);
        }
        assert_eq!(owned.finish(), expected);
        assert_eq!(borrowed.finish(), expected);
    }
}
