use super::{rows, SeekRange};
use crate::generation::{GenerationCheck, SourceGeneration};
use crate::host::StorageHost;
use proseql_engine::errors::EngineError;
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Debug, Clone)]
struct Checkpoint {
    key: Value,
    offset: u64,
    row: u64,
}

/// Sparse ordered checkpoints. Non-scalar, mixed-type or decreasing keys
/// disable seeking rather than imposing a different comparison order.
#[derive(Debug, Clone, Default)]
pub struct TimeIndex {
    generation: Option<SourceGeneration>,
    path: String,
    field: String,
    stride: usize,
    entries: Vec<Checkpoint>,
    last: Option<Value>,
    rows: u64,
    resume: u64,
    ordered: bool,
}

fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::String(a), Value::String(b)) => Some(a.cmp(b)),
        (Value::Number(a), Value::Number(b)) => a.as_f64()?.partial_cmp(&b.as_f64()?),
        _ => None,
    }
}

impl TimeIndex {
    pub fn build(
        host: &dyn StorageHost,
        path: &str,
        field: &str,
        stride: usize,
    ) -> Result<Self, EngineError> {
        let mut index = Self {
            path: path.into(),
            field: field.into(),
            stride: stride.max(1),
            ordered: true,
            ..Self::default()
        };
        index.extend(host, path, 0, SourceGeneration::observe(host, path)?)?;
        Ok(index)
    }

    pub fn refresh(&mut self, host: &dyn StorageHost) -> Result<(), EngineError> {
        let Some(generation) = self.generation.as_ref() else {
            *self = Self::build(host, &self.path, &self.field, self.stride)?;
            return Ok(());
        };
        let (check, current) = generation.advance(host)?;
        match check {
            GenerationCheck::Unchanged => Ok(()),
            GenerationCheck::Appended { .. } if self.resume == generation.covered_len => {
                // Publication is atomic even when parsing the new suffix fails.
                let mut next = self.clone();
                next.extend(host, &self.path, self.resume, current)?;
                *self = next;
                Ok(())
            }
            _ => {
                *self = Self::build(host, &self.path, &self.field, self.stride)?;
                Ok(())
            }
        }
    }

    fn extend(
        &mut self,
        host: &dyn StorageHost,
        path: &str,
        start: u64,
        generation: Option<SourceGeneration>,
    ) -> Result<(), EngineError> {
        let end = generation.as_ref().map_or(0, |g| g.covered_len);
        self.resume = end;
        rows::visit_lines(
            host,
            path,
            start,
            end,
            self.rows,
            |bytes, location, final_line| {
                // An arbitrary field path is supported, not just Logbook's time key.
                let value: Value = match serde_json::from_slice(bytes) {
                    Ok(value) => value,
                    Err(_) if final_line => {
                        self.resume = location.offset;
                        return Ok(());
                    }
                    Err(error) => return Err(rows::parse_error(error)),
                };
                if final_line {
                    self.resume = location.offset;
                }
                let key = proseql_engine::query::filter::get_nested_value(&value, &self.field)
                    .cloned()
                    .unwrap_or(Value::Null);
                if compare(&key, &key).is_none()
                    || self.last.as_ref().is_some_and(|last| {
                        !matches!(compare(last, &key), Some(Ordering::Less | Ordering::Equal))
                    })
                {
                    self.ordered = false;
                }
                if self.rows.is_multiple_of(self.stride as u64) {
                    self.entries.push(Checkpoint {
                        key: key.clone(),
                        offset: location.offset,
                        row: self.rows,
                    });
                }
                self.last = Some(key);
                self.rows += 1;
                Ok(())
            },
        )?;
        if let Some(generation) = &generation {
            if generation.check(host)? != GenerationCheck::Unchanged {
                return Err(crate::generation::changed(path));
            }
        }
        self.generation = generation;
        Ok(())
    }

    pub fn generation(&self) -> Option<&SourceGeneration> {
        self.generation.as_ref()
    }

    /// Call `refresh` (or check `generation`) before seeking. A cached index
    /// alone cannot inspect a host; IndexState performs that check on access.
    pub fn seek(&self, lower: Option<&Value>, upper: Option<&Value>) -> Option<SeekRange> {
        if !self.ordered || self.generation.is_none() {
            return None;
        }
        if [lower, upper].into_iter().flatten().any(|bound| {
            self.last
                .as_ref()
                .is_some_and(|key| compare(key, bound).is_none())
        }) {
            return None;
        }
        // Strictly-before is essential: equal keys can straddle checkpoints.
        let pos = lower.map_or(0, |lower| {
            self.entries
                .partition_point(|entry| compare(&entry.key, lower) == Some(Ordering::Less))
                .saturating_sub(1)
        });
        let end_offset = upper.and_then(|upper| {
            self.entries
                .iter()
                .find(|entry| compare(&entry.key, upper) == Some(Ordering::Greater))
                .map(|entry| entry.offset)
        });
        let start = self.entries.get(pos);
        Some(SeekRange {
            start_offset: start.map_or(0, |entry| entry.offset),
            start_row: start.map_or(0, |entry| entry.row),
            end_offset: end_offset.map(|end| end.max(start.map_or(0, |entry| entry.offset))),
        })
    }

    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.path.capacity()
            + self.field.capacity()
            + self.entries.capacity() * std::mem::size_of::<Checkpoint>()
            + self
                .entries
                .iter()
                .map(|entry| entry.key.as_str().map_or(0, str::len))
                .sum::<usize>()
            + self
                .last
                .as_ref()
                .and_then(Value::as_str)
                .map_or(0, str::len)
            + self.generation.as_ref().map_or(0, |g| g.path.capacity())
    }
}
