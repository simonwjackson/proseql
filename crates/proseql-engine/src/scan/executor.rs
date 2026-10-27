//! Query-local scan workspace. No row is installed in a Collection.
//!
//! The scalar operators remain the query module's operators. A bounded heap
//! replaces a stable full sort only when the schema proves a total comparator;
//! mixed values and host sorts keep the canonical stable-sort path.
use std::{cmp::Ordering, sync::Arc};

use serde_json::Value;

use crate::{
    callbacks::CallbackRegistry,
    collection::Collection,
    descriptor::SchemaNode,
    errors::EngineError,
    query::{
        aggregate::{
            compute_aggregates, compute_grouped_aggregates, AggregateConfig, AggregateResult,
            GroupResult,
        },
        candidate_order::CandidateOrder,
        filter::{get_nested_value, matches_where_with_registry},
        pipeline::{
            effective_cursor_sort, finish_cursor_matches, finish_query_matches, QueryInput,
        },
        search::extract_search_config,
        sort::{compare_entities, value_to_js_string, SortEntry},
        CursorConfig, CursorPageResult,
    },
};

use super::{
    borrowed::BorrowedValue,
    fold::{Fold as AggregateAccumulator, GroupFold as GroupedAggregateAccumulator},
    plan::{Field, Filter, PositionedRow},
};

pub enum ScanRequest<'a> {
    Query(&'a QueryInput, Option<&'a CursorConfig>),
    Aggregate(Option<&'a Value>, &'a AggregateConfig),
    Grouped(Option<&'a Value>, &'a [String], &'a AggregateConfig),
}
pub enum ScanOutput {
    Rows(Vec<Value>),
    Page(CursorPageResult),
    Aggregate(AggregateResult),
    Grouped(Vec<GroupResult>),
}

pub struct Executor<'a> {
    input: QueryInput,
    registry: Arc<CallbackRegistry>,
    order: Option<CandidateOrder>,
    borrowed_ranks: Option<Vec<(usize, Vec<Value>)>>,
    rank_fields: Vec<Field>,
    positioned_filter: Option<Filter>,
    workspace: Workspace<'a>,
    deferred_error: Option<EngineError>,
    pub candidate_rows: usize,
}
enum Workspace<'a> {
    Query {
        cursor: Option<&'a CursorConfig>,
        sort: Vec<SortEntry>,
        rows: Rows,
    },
    Aggregate {
        config: &'a AggregateConfig,
        accumulator: AggregateAccumulator<'a>,
        deferred: Option<Vec<Value>>,
    },
    Grouped {
        group_by: &'a [String],
        config: &'a AggregateConfig,
        accumulators: Vec<GroupedAggregateAccumulator<'a>>,
        deferred: Option<Vec<Value>>,
    },
}

enum Rows {
    All(Vec<Value>),
    Projected(Vec<RankedRow>),
    Top { ranked: TopK, natural: Option<TopK> },
}
struct RankedRow {
    row: Value,
    rank: usize,
    ordinal: u64,
}
struct TopK {
    rows: Vec<RankedRow>,
    capacity: usize,
    backward: bool,
    rank_ties: bool,
}
impl TopK {
    fn new(capacity: usize, backward: bool, rank_ties: bool) -> Self {
        Self {
            rows: Vec::new(),
            capacity,
            backward,
            rank_ties,
        }
    }
    fn compare(
        &self,
        a: &RankedRow,
        b: &RankedRow,
        sort: &[SortEntry],
        registry: &CallbackRegistry,
    ) -> Ordering {
        let order = compare_entities(&a.row, &b.row, sort, Some(registry))
            .then_with(|| {
                if self.rank_ties {
                    a.rank.cmp(&b.rank)
                } else {
                    Ordering::Equal
                }
            })
            .then_with(|| a.ordinal.cmp(&b.ordinal));
        if self.backward {
            order.reverse()
        } else {
            order
        }
    }
    fn push(&mut self, row: RankedRow, sort: &[SortEntry], registry: &CallbackRegistry) {
        if self.capacity == 0 {
            return;
        }
        if self.rows.len() < self.capacity {
            self.rows.push(row);
            let mut child = self.rows.len() - 1;
            while child > 0 {
                let parent = (child - 1) / 2;
                if self.compare(&self.rows[child], &self.rows[parent], sort, registry)
                    != Ordering::Greater
                {
                    break;
                }
                self.rows.swap(child, parent);
                child = parent;
            }
        } else if self.compare(&row, &self.rows[0], sort, registry) == Ordering::Less {
            self.rows[0] = row;
            let mut parent = 0;
            loop {
                let left = parent * 2 + 1;
                if left >= self.rows.len() {
                    break;
                }
                let right = left + 1;
                let child = if right < self.rows.len()
                    && self.compare(&self.rows[right], &self.rows[left], sort, registry)
                        == Ordering::Greater
                {
                    right
                } else {
                    left
                };
                if self.compare(&self.rows[child], &self.rows[parent], sort, registry)
                    != Ordering::Greater
                {
                    break;
                }
                self.rows.swap(child, parent);
                parent = child;
            }
        }
    }
    fn finish(mut self, sort: &[SortEntry], registry: &CallbackRegistry) -> Vec<Value> {
        let rank_ties = self.rank_ties;
        self.rows.sort_by(|a, b| {
            compare_entities(&a.row, &b.row, sort, Some(registry))
                .then_with(|| {
                    if rank_ties {
                        a.rank.cmp(&b.rank)
                    } else {
                        Ordering::Equal
                    }
                })
                .then_with(|| a.ordinal.cmp(&b.ordinal))
        });
        self.rows.into_iter().map(|row| row.row).collect()
    }
}

impl<'a> Executor<'a> {
    pub fn new(
        collection: &Collection,
        registry: Arc<CallbackRegistry>,
        request: ScanRequest<'a>,
        indexed: bool,
    ) -> Result<Self, EngineError> {
        let (input, cursor) = match request {
            ScanRequest::Query(input, cursor) => (input.clone(), cursor),
            ScanRequest::Aggregate(filter, _) | ScanRequest::Grouped(filter, _, _) => (
                QueryInput {
                    r#where: filter.cloned(),
                    ..Default::default()
                },
                None,
            ),
        };
        let order = indexed
            .then(|| CandidateOrder::new(collection, &input, cursor, &registry))
            .flatten();
        let reorders = order.as_ref().is_some_and(CandidateOrder::reorders);
        let search = extract_search_config(&input.r#where).is_some();
        let mut deferred_error = None;
        let workspace = match request {
            ScanRequest::Query(_, cursor) => {
                let sort = match cursor {
                    Some(cursor) => match effective_cursor_sort(&input, cursor) {
                        Ok(sort) => sort,
                        Err(error) => {
                            deferred_error = Some(error);
                            input.sort.clone()
                        }
                    },
                    None => input.sort.clone(),
                };
                let total = !registry.has_collator()
                    && !registry.has_host_sort()
                    && sort
                        .iter()
                        .all(|(field, _)| total_field(&collection.descriptor.schema, field));
                // Cursor key validation must still see missing keys; use the
                // canonical path if the schema does not require that key.
                let cursor_safe = cursor.is_none_or(|cursor| {
                    required_field(&collection.descriptor.schema, &cursor.key)
                });
                let capacity = cursor
                    .map(|cursor| cursor.limit.saturating_add(1))
                    .or_else(|| {
                        input
                            .limit
                            .map(|limit| limit.saturating_add(input.offset.unwrap_or(0)))
                    });
                let rows = if !search && total && cursor_safe && capacity.is_some() {
                    let capacity = capacity.unwrap_or(0);
                    let backward = cursor.is_some_and(|cursor| cursor.before.is_some());
                    Rows::Top {
                        ranked: TopK::new(capacity, backward, reorders),
                        natural: (reorders && !sort.is_empty())
                            .then(|| TopK::new(capacity, backward, false)),
                    }
                } else if !search && sort.is_empty() && cursor.is_none() {
                    Rows::Projected(Vec::new())
                } else {
                    Rows::All(Vec::new())
                };
                Workspace::Query { cursor, sort, rows }
            }
            ScanRequest::Aggregate(_, config) => Workspace::Aggregate {
                config,
                accumulator: AggregateAccumulator::new(config, Some(&collection.descriptor.schema)),
                deferred: (search || reorders).then(Vec::new),
            },
            ScanRequest::Grouped(_, group_by, config) => {
                // Groups containing every equality-index key are disjoint
                // across candidate ranks. Each accumulator still receives
                // individual rows in order; no floating partial sum is merged.
                let disjoint = order.as_ref().is_some_and(|order| {
                    order.fields().iter().all(|field| group_by.contains(field))
                });
                let count = if reorders && disjoint {
                    order.as_ref().map_or(1, CandidateOrder::rank_count)
                } else {
                    1
                };
                Workspace::Grouped {
                    group_by,
                    config,
                    accumulators: (0..count)
                        .map(|_| {
                            GroupedAggregateAccumulator::new(
                                group_by,
                                config,
                                Some(&collection.descriptor.schema),
                            )
                        })
                        .collect(),
                    deferred: (search || (reorders && !disjoint)).then(Vec::new),
                }
            }
        };
        let borrowed_ranks = order.as_ref().and_then(|order| {
            order
                .keys_and_ranks()
                .map(|(key, rank)| {
                    let values = key
                        .split('\0')
                        .map(|part| {
                            serde_json::from_str::<Value>(part)
                                .ok()
                                .filter(|value| !value.is_object() && !value.is_array())
                        })
                        .collect::<Option<Vec<_>>>()?;
                    Some((rank, values))
                })
                .collect::<Option<Vec<_>>>()
        });
        let positioned_filter = input
            .r#where
            .as_ref()
            .map(|filter| Filter::new(filter, Some(&collection.descriptor.schema)));
        let rank_fields = order
            .as_ref()
            .map(|order| {
                order
                    .fields()
                    .iter()
                    .map(|field| Field::new(field, Some(&collection.descriptor.schema)))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            input,
            positioned_filter,
            rank_fields,
            registry,
            order,
            borrowed_ranks,
            workspace,
            deferred_error,
            candidate_rows: 0,
        })
    }

    /// Fields sufficient for a non-deferred scalar fold or simple projection.
    /// Workspaces that may own a complete row keep the complete decoder.
    pub fn required_fields(&self) -> Option<Vec<String>> {
        let mut fields = vec!["id".into()];
        if !self
            .positioned_filter
            .as_ref()
            .is_none_or(|filter| filter.required_fields(&mut fields))
        {
            return None;
        }
        if self.order.is_some() && self.borrowed_ranks.is_none() {
            return None;
        }
        fields.extend(self.rank_fields.iter().map(|field| field.name.clone()));
        let config = match &self.workspace {
            Workspace::Aggregate {
                config,
                deferred: None,
                ..
            } => *config,
            Workspace::Grouped {
                group_by,
                config,
                deferred: None,
                ..
            } => {
                fields.extend(group_by.iter().cloned());
                *config
            }
            Workspace::Query {
                cursor: None,
                sort,
                rows,
            } if sort.is_empty() && !matches!(rows, Rows::All(_)) => {
                match self.input.select.as_ref()? {
                    Value::Array(names) if !names.is_empty() => {
                        for name in names {
                            fields.push(name.as_str()?.into());
                        }
                    }
                    Value::Object(names)
                        if !names.is_empty()
                            && names.values().all(|value| value == &Value::Bool(true)) =>
                    {
                        fields.extend(names.keys().cloned())
                    }
                    _ => return None,
                }
                return Some(fields);
            }
            _ => return None,
        };
        for names in [&config.sum, &config.avg, &config.min, &config.max] {
            fields.extend(names.iter().cloned());
        }
        Some(fields)
    }

    /// Borrowed scalar fast path. Unsupported operators/sort callbacks retain
    /// the canonical path, after the host has validated the complete row.
    pub fn push_borrowed(&mut self, row: &BorrowedValue<'_>, ordinal: u64) {
        self.push_borrowed_inner(row, ordinal, None);
    }
    /// Only rows from SimpleDecoder::decode_positioned may use this layout.
    pub fn push_positioned(&mut self, row: &BorrowedValue<'_>, present: u128, ordinal: u64) {
        self.push_borrowed_inner(row, ordinal, Some(present));
    }
    fn push_borrowed_inner(
        &mut self,
        row: &BorrowedValue<'_>,
        ordinal: u64,
        present: Option<u128>,
    ) {
        // Ordered-sort eligibility observes all rows, including equality
        // candidates that do not match. Sort workspaces own their candidates.
        if matches!(&self.workspace, Workspace::Query { sort, .. } if !sort.is_empty()) {
            self.push(&row.to_owned(), ordinal);
            return;
        }
        let rank = match (&self.order, &self.borrowed_ranks) {
            (Some(order), Some(ranks)) => ranks
                .iter()
                .find(|(_, values)| {
                    order
                        .fields()
                        .iter()
                        .zip(&self.rank_fields)
                        .zip(values)
                        .all(|((name, field), value)| {
                            present
                                .map_or_else(|| row.get(name), |present| field.get(row, present))
                                .is_some_and(|cell| cell.scalar_eq(value))
                        })
                })
                .map(|(rank, _)| *rank),
            (None, _) => Some(0),
            _ => {
                self.push(&row.to_owned(), ordinal);
                return;
            }
        };
        let Some(rank) = rank else {
            self.candidate_rows += 1;
            return;
        };
        let matched = match present.map_or_else(
            || {
                self.input
                    .r#where
                    .as_ref()
                    .map_or(Some(true), |filter| row.matches_where(filter))
            },
            |present| {
                self.positioned_filter
                    .as_ref()
                    .map_or(Some(true), |filter| {
                        filter.matches(&PositionedRow { row, present })
                    })
            },
        ) {
            Some(matched) => matched,
            None => {
                self.push(&row.to_owned(), ordinal);
                return;
            }
        };
        self.candidate_rows += 1;
        if !matched {
            return;
        }
        match &mut self.workspace {
            Workspace::Aggregate {
                accumulator,
                deferred: None,
                ..
            } => match present {
                Some(present) => accumulator.push(&PositionedRow { row, present }),
                None => accumulator.push(row),
            },
            Workspace::Grouped {
                accumulators,
                deferred: None,
                ..
            } => {
                let index = if accumulators.len() > 1 { rank } else { 0 };
                match present {
                    Some(present) => accumulators[index].push(&PositionedRow { row, present }),
                    None => accumulators[index].push(row),
                }
            }
            Workspace::Query {
                rows: Rows::Top { ranked, natural },
                sort,
                ..
            } => {
                // An unsorted page needs no owned row once its rank/ordinal
                // cannot displace the current worst output candidate.
                let accepts = |heap: &TopK| {
                    heap.capacity > 0
                        && (heap.rows.len() < heap.capacity
                            || heap.rows.first().is_some_and(|worst| {
                                (if heap.rank_ties {
                                    rank.cmp(&worst.rank)
                                } else {
                                    Ordering::Equal
                                })
                                .then_with(|| ordinal.cmp(&worst.ordinal))
                                .is_lt()
                            }))
                };
                if accepts(ranked) {
                    ranked.push(
                        RankedRow {
                            row: row.select(self.input.select.as_ref()),
                            rank,
                            ordinal,
                        },
                        sort,
                        &self.registry,
                    );
                }
                if let Some(natural) = natural {
                    if accepts(natural) {
                        natural.push(
                            RankedRow {
                                row: row.select(self.input.select.as_ref()),
                                rank,
                                ordinal,
                            },
                            sort,
                            &self.registry,
                        );
                    }
                }
            }
            Workspace::Query {
                rows: Rows::Projected(rows),
                ..
            } => rows.push(RankedRow {
                row: row.select(self.input.select.as_ref()),
                rank,
                ordinal,
            }),
            Workspace::Query {
                rows: Rows::All(rows),
                ..
            }
            | Workspace::Aggregate {
                deferred: Some(rows),
                ..
            }
            | Workspace::Grouped {
                deferred: Some(rows),
                ..
            } => rows.push(row.to_owned()),
        }
    }

    pub fn push(&mut self, row: &Value, ordinal: u64) {
        self.candidate_rows += 1;
        if let Some(order) = &mut self.order {
            order.observe(row);
        }
        let rank = match &self.order {
            Some(order) => match order.rank(row) {
                Some(rank) => rank,
                None => return,
            },
            None => 0,
        };
        if !self
            .input
            .r#where
            .as_ref()
            .is_none_or(|filter| matches_where_with_registry(row, filter, Some(&self.registry)))
        {
            return;
        }
        match &mut self.workspace {
            Workspace::Query {
                rows: Rows::All(rows),
                ..
            } => rows.push(row.clone()),
            Workspace::Query {
                rows: Rows::Projected(rows),
                ..
            } => rows.push(RankedRow {
                row: crate::query::select::apply_selection(row, self.input.select.as_ref()),
                rank,
                ordinal,
            }),
            Workspace::Query {
                cursor,
                sort,
                rows: Rows::Top { ranked, natural },
            } => {
                if let Some(cursor) = cursor {
                    let key = get_nested_value(row, &cursor.key)
                        .map(value_to_js_string)
                        .unwrap_or_default();
                    if cursor.after.as_ref().is_some_and(|after| key <= *after)
                        || cursor.before.as_ref().is_some_and(|before| key >= *before)
                    {
                        return;
                    }
                }
                ranked.push(
                    RankedRow {
                        row: if sort.is_empty() {
                            crate::query::select::apply_selection(row, self.input.select.as_ref())
                        } else {
                            row.clone()
                        },
                        rank,
                        ordinal,
                    },
                    sort,
                    &self.registry,
                );
                if let Some(natural) = natural {
                    natural.push(
                        RankedRow {
                            row: if sort.is_empty() {
                                crate::query::select::apply_selection(
                                    row,
                                    self.input.select.as_ref(),
                                )
                            } else {
                                row.clone()
                            },
                            rank,
                            ordinal,
                        },
                        sort,
                        &self.registry,
                    );
                }
            }
            Workspace::Aggregate {
                deferred: Some(rows),
                ..
            }
            | Workspace::Grouped {
                deferred: Some(rows),
                ..
            } => rows.push(row.clone()),
            Workspace::Aggregate { accumulator, .. } => accumulator.push(row),
            Workspace::Grouped { accumulators, .. } => {
                let index = if accumulators.len() > 1 { rank } else { 0 };
                accumulators[index].push(row);
            }
        }
    }

    pub fn finish(self) -> Result<ScanOutput, EngineError> {
        if let Some(error) = self.deferred_error {
            return Err(error);
        }
        let Self {
            input,
            registry,
            order,
            workspace,
            ..
        } = self;
        let order_rows = |rows: &mut Vec<Value>| {
            if let Some(order) = &order {
                order.apply(rows);
            }
        };
        match workspace {
            Workspace::Query { cursor, sort, rows } => {
                let mut input = input;
                if matches!(rows, Rows::Projected(_))
                    || (sort.is_empty() && matches!(rows, Rows::Top { .. }))
                {
                    input.select = None;
                }
                let rows = match rows {
                    Rows::Projected(mut rows) => {
                        rows.sort_by_key(|row| (row.rank, row.ordinal));
                        rows.into_iter().map(|row| row.row).collect()
                    }
                    Rows::All(mut rows) => {
                        order_rows(&mut rows);
                        rows
                    }
                    Rows::Top { ranked, natural } => {
                        let heap = if order
                            .as_ref()
                            .is_some_and(CandidateOrder::ordered_sort_overrides_equality)
                        {
                            natural.unwrap_or(ranked)
                        } else {
                            ranked
                        };
                        heap.finish(&sort, &registry)
                    }
                };
                match cursor {
                    Some(cursor) => {
                        finish_cursor_matches(rows, &input, cursor, Some(&sort), &registry)
                            .map(ScanOutput::Page)
                    }
                    None => {
                        crate::query::pipeline::validate_regular_query(&input)?;
                        finish_query_matches(rows, &input, &registry).map(ScanOutput::Rows)
                    }
                }
            }
            Workspace::Aggregate {
                config,
                accumulator,
                deferred,
            } => match deferred {
                None => Ok(ScanOutput::Aggregate(accumulator.finish())),
                Some(mut rows) => {
                    order_rows(&mut rows);
                    let rows = finish_query_matches(rows, &input, &registry)?;
                    Ok(ScanOutput::Aggregate(compute_aggregates(&rows, config)))
                }
            },
            Workspace::Grouped {
                group_by,
                config,
                accumulators,
                deferred,
            } => match deferred {
                None => Ok(ScanOutput::Grouped(
                    accumulators
                        .into_iter()
                        .flat_map(GroupedAggregateAccumulator::finish)
                        .collect(),
                )),
                Some(mut rows) => {
                    order_rows(&mut rows);
                    let rows = finish_query_matches(rows, &input, &registry)?;
                    Ok(ScanOutput::Grouped(compute_grouped_aggregates(
                        &rows, group_by, config,
                    )))
                }
            },
        }
    }
}

fn field_schema<'a>(schema: &'a SchemaNode, path: &str) -> Option<&'a SchemaNode> {
    let mut schema = schema;
    for part in path.split('.') {
        while let SchemaNode::Optional(inner)
        | SchemaNode::NullOr(inner)
        | SchemaNode::OptionalWithDefault { inner, .. } = schema
        {
            schema = inner;
        }
        let SchemaNode::Struct { fields } = schema else {
            return None;
        };
        schema = &fields.iter().find(|field| field.name == part)?.schema;
    }
    Some(schema)
}
fn total_field(schema: &SchemaNode, path: &str) -> bool {
    let Some(mut schema) = field_schema(schema, path) else {
        return false;
    };
    while let SchemaNode::Optional(inner)
    | SchemaNode::NullOr(inner)
    | SchemaNode::OptionalWithDefault { inner, .. } = schema
    {
        schema = inner;
    }
    matches!(
        schema,
        SchemaNode::Str | SchemaNode::Num | SchemaNode::NumFromStr | SchemaNode::Bool
    )
}
fn required_field(schema: &SchemaNode, path: &str) -> bool {
    let mut schema = schema;
    for part in path.split('.') {
        let SchemaNode::Struct { fields } = schema else {
            return false;
        };
        let Some(field) = fields.iter().find(|field| field.name == part) else {
            return false;
        };
        schema = &field.schema;
    }
    !matches!(
        schema,
        SchemaNode::Optional(_) | SchemaNode::OptionalWithDefault { .. }
    )
}
