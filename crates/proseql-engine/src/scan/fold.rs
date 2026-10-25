//! Folds over borrowed or canonical rows. Only a new group or a new min/max
//! retains an owned value. Hashing and group-key verification serialize into
//! writers, not per-row Strings. Hash collisions always get exact comparison.
use std::{
    collections::HashMap,
    hash::Hasher,
    io::{self, Write},
};

use serde_json::{Map, Value};

use super::borrowed::BorrowedValue;
use crate::query::{
    aggregate::{AggregateConfig, AggregateResult, GroupResult},
    filter::get_nested_value,
};

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
    fn json(self, writer: &mut impl Write) {
        match self {
            Self::Borrowed(value) => serde_json::to_writer(writer, value),
            Self::Owned(value) => serde_json::to_writer(writer, value),
        }
        .expect("infallible JSON group writer");
    }
}
pub(super) trait Row {
    fn cell(&self, field: &str) -> Option<Cell<'_>>;
}
impl Row for Value {
    fn cell(&self, field: &str) -> Option<Cell<'_>> {
        get_nested_value(self, field).map(Cell::Owned)
    }
}
impl Row for BorrowedValue<'_> {
    fn cell(&self, field: &str) -> Option<Cell<'_>> {
        self.get(field).map(Cell::Borrowed)
    }
}

pub(super) struct Fold<'a> {
    config: &'a AggregateConfig,
    count: u64,
    sum: Vec<f64>,
    avg: Vec<(f64, u64)>,
    min: Vec<Option<Value>>,
    max: Vec<Option<Value>>,
}
impl<'a> Fold<'a> {
    pub fn new(config: &'a AggregateConfig) -> Self {
        Self {
            config,
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
        for (index, field) in self.config.sum.iter().enumerate() {
            if let Some(value) = row.cell(field).and_then(Cell::number) {
                let first = self
                    .config
                    .sum
                    .iter()
                    .position(|name| name == field)
                    .unwrap_or(index);
                self.sum[first] += value;
            }
        }
        for (index, field) in self.config.avg.iter().enumerate() {
            if let Some(value) = row.cell(field).and_then(Cell::number) {
                let first = self
                    .config
                    .avg
                    .iter()
                    .position(|name| name == field)
                    .unwrap_or(index);
                self.avg[first].0 += value;
                self.avg[first].1 += 1;
            }
        }
        for (fields, slots, minimum) in [
            (&self.config.min, &mut self.min, true),
            (&self.config.max, &mut self.max, false),
        ] {
            for (index, field) in fields.iter().enumerate() {
                let Some(value) = row.cell(field).filter(|value| !value.is_null()) else {
                    continue;
                };
                let first = fields
                    .iter()
                    .position(|name| name == field)
                    .unwrap_or(index);
                if slots[first].as_ref().is_none_or(|current| {
                    if minimum {
                        value.compare(current) < 0
                    } else {
                        value.compare(current) > 0
                    }
                }) {
                    slots[first] = Some(value.owned());
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
    config: &'a AggregateConfig,
    positions: HashMap<u64, Vec<usize>>,
    groups: Vec<(Vec<u8>, Fold<'a>)>,
}
fn write_key(row: &impl Row, fields: &[String], writer: &mut impl Write) {
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
    pub fn new(fields: &'a [String], config: &'a AggregateConfig) -> Self {
        Self {
            fields,
            config,
            positions: HashMap::new(),
            groups: Vec::new(),
        }
    }
    pub fn push(&mut self, row: &impl Row) {
        let mut writer = HashWriter(std::collections::hash_map::DefaultHasher::new());
        write_key(row, self.fields, &mut writer);
        let hash = writer.0.finish();
        let found = self.positions.get(&hash).and_then(|positions| {
            positions.iter().copied().find(|index| {
                let mut writer = CompareWriter {
                    expected: &self.groups[*index].0,
                    position: 0,
                    equal: true,
                };
                write_key(row, self.fields, &mut writer);
                writer.equal && writer.position == writer.expected.len()
            })
        });
        let index = found.unwrap_or_else(|| {
            let mut key = Vec::new();
            write_key(row, self.fields, &mut key);
            let index = self.groups.len();
            self.groups.push((key, Fold::new(self.config)));
            self.positions.entry(hash).or_default().push(index);
            index
        });
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
