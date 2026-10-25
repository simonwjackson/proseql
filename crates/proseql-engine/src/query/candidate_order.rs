//! Preserve the existing planner's observable candidate order while a host
//! streams raw partitions. Equality `$in` unions use condition-value order,
//! except when an eligible ordered-index sort takes authority instead.
use super::{
    filter::get_nested_value,
    indexes::{canonical_equality_key, equality_candidate_spec, equality_key},
    ordered_index::RangeSpec,
    pipeline::QueryInput,
    search::extract_search_config,
    CursorConfig, SortEntry, SortOrder,
};
use crate::{
    callbacks::CallbackRegistry, collection::Collection, descriptor::IndexDescriptor,
    value::is_boundary_undefined,
};
use serde_json::Value;
use std::collections::HashMap;

pub(crate) struct CandidateOrder {
    fields: Vec<String>,
    ranks: HashMap<String, usize>,
    ordered_sort: Option<SortProbe>,
}
struct SortProbe {
    field: String,
    strings: bool,
    numbers: bool,
    valid: bool,
    strings_bytewise: bool,
}
impl SortProbe {
    fn observe(&mut self, row: &Value) {
        match get_nested_value(row, &self.field) {
            None | Some(Value::Null) => {}
            Some(value) if is_boundary_undefined(value) => {}
            Some(Value::String(_)) => self.strings = true,
            Some(Value::Number(number)) if number.as_f64().is_some() => self.numbers = true,
            _ => self.valid = false,
        }
    }
    fn can_sort(&self) -> bool {
        self.valid && !(self.numbers && self.strings) && (!self.strings || self.strings_bytewise)
    }
}
impl CandidateOrder {
    pub fn new(
        collection: &Collection,
        input: &QueryInput,
        cursor: Option<&CursorConfig>,
        registry: &CallbackRegistry,
    ) -> Option<Self> {
        let spec = equality_candidate_spec(
            input.r#where.as_ref()?,
            collection
                .descriptor
                .indexes
                .iter()
                .map(|index| match index {
                    IndexDescriptor::Single(field) => std::slice::from_ref(field),
                    IndexDescriptor::Compound(fields) => fields.as_slice(),
                }),
        )?;
        let fields = spec.fields.to_vec();
        let mut ranks = HashMap::new();
        for combination in spec.combinations {
            let key = canonical_equality_key(combination);
            let rank = ranks.len();
            ranks.entry(key).or_insert(rank);
        }
        let sort: Vec<SortEntry> = if input.sort.is_empty() {
            cursor
                .map(|cursor| vec![(cursor.key.clone(), SortOrder::Asc)])
                .unwrap_or_default()
        } else {
            input.sort.clone()
        };
        let ordered_sort = match sort.as_slice() {
            [(field, _)]
                if collection.descriptor.ordered_indexes.contains(field)
                    && !registry.has_host_sort()
                    && extract_search_config(&input.r#where).is_none()
                    && RangeSpec::extract(input.r#where.as_ref().unwrap(), field).is_some() =>
            {
                Some(SortProbe {
                    field: field.clone(),
                    strings: false,
                    numbers: false,
                    valid: true,
                    strings_bytewise: !registry.has_collator(),
                })
            }
            _ => None,
        };
        let mut plan = Self {
            fields,
            ranks,
            ordered_sort,
        };
        // Full-scope queries also see the cache they started with, even outside
        // the requested paths. Such rows can disable an ordered-index sort.
        for (_, row) in collection.entries() {
            plan.observe(row);
        }
        Some(plan)
    }
    pub fn observe(&mut self, row: &Value) {
        if let Some(probe) = &mut self.ordered_sort {
            probe.observe(row);
        }
    }
    pub(crate) fn rank(&self, row: &Value) -> Option<usize> {
        self.ranks.get(&equality_key(row, &self.fields)?).copied()
    }
    pub fn accepts(&self, row: &Value) -> bool {
        self.rank(row).is_some()
    }
    pub(crate) fn keys_and_ranks(&self) -> impl Iterator<Item = (&str, usize)> {
        self.ranks.iter().map(|(key, rank)| (key.as_str(), *rank))
    }
    pub(crate) fn fields(&self) -> &[String] {
        &self.fields
    }
    pub(crate) fn rank_count(&self) -> usize {
        self.ranks.len()
    }
    pub(crate) fn ordered_sort_overrides_equality(&self) -> bool {
        self.ordered_sort.as_ref().is_some_and(SortProbe::can_sort)
    }
    pub fn reorders(&self) -> bool {
        self.ranks.len() > 1
    }
    pub fn apply(&self, rows: &mut Vec<Value>) {
        if self.ordered_sort.as_ref().is_some_and(SortProbe::can_sort) {
            return;
        }
        rows.retain(|row| self.accepts(row));
        if self.reorders() {
            rows.sort_by_cached_key(|row| self.rank(row).unwrap_or(usize::MAX));
        }
    }
}
