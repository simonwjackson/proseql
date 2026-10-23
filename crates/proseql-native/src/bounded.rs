//! Opt-in partition-at-a-time reads. Existing full-scope and watch interfaces
//! remain unchanged. Query operators stay in the shared engine.
use crate::{sources_trim, NativeRuntime};
use proseql_engine::{
    callbacks::CallbackRegistry,
    errors::EngineError,
    query::{
        aggregate::{
            AggregateAccumulator, AggregateConfig, AggregateResult, GroupResult,
            GroupedAggregateAccumulator,
        },
        pipeline::{QueryInput, QueryMatches},
        CursorConfig, CursorPageResult,
    },
    relationships::Database,
};
use serde_json::Value;
use std::sync::Arc;

/// Bounded-read working set. Pinned partitions and delivered/retained watch
/// snapshots are additional memory, not hidden inside the cache limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedQueryStats {
    pub partitions_visited: usize,
    pub partitions_read: usize,
    pub partitions_resident: usize,
    pub pinned_partitions: usize,
    pub retained_partition_limit: usize,
}

impl NativeRuntime {
    /// Read lazy partitions one at a time in path/file order. At most N cached
    /// unpinned partitions plus one incoming partition's records coexist.
    /// Matching rows are additional output workspace; sorting/pagination/
    /// search/selection run once globally, not once per partition. Watches
    /// retain their existing pin/snapshot semantics and are reported separately.
    /// Non-lazy collections use the ordinary engine query.
    pub fn query_bounded(
        &self,
        collection: &str,
        input: QueryInput,
    ) -> Result<Vec<Value>, EngineError> {
        self.query_bounded_with_stats(collection, input)
            .map(|(rows, _)| rows)
    }

    pub fn query_bounded_with_stats(
        &self,
        collection: &str,
        input: QueryInput,
    ) -> Result<(Vec<Value>, BoundedQueryStats), EngineError> {
        proseql_engine::query::pipeline::validate_regular_query(&input)?;
        self.bounded_fold(
            collection,
            input.r#where.as_ref(),
            |callbacks, records| {
                QueryMatches::for_collection(input.clone(), callbacks, records, None)
            },
            |matches, row| {
                matches.push(row);
                Ok(())
            },
            QueryMatches::finish,
            |database| database.query(collection, input.clone(), None),
        )
    }

    pub fn query_cursor_bounded(
        &self,
        collection: &str,
        input: QueryInput,
        cursor: &CursorConfig,
    ) -> Result<CursorPageResult, EngineError> {
        self.bounded_fold(
            collection,
            input.r#where.as_ref(),
            |callbacks, records| {
                QueryMatches::for_collection(input.clone(), callbacks, records, Some(cursor))
            },
            |matches, row| {
                matches.push(row);
                Ok(())
            },
            |matches| matches.finish_cursor(cursor),
            |database| database.query_cursor(collection, &input, cursor, None),
        )
        .map(|(page, _)| page)
    }

    /// Aggregate individual matching rows in natural order, without monthly
    /// partial sums. Search and multi-value equality-index unions deliberately
    /// buffer matches: existing native query ordering affects f64 sums.
    pub fn aggregate_bounded(
        &self,
        collection: &str,
        filter: Option<Value>,
        config: &AggregateConfig,
    ) -> Result<AggregateResult, EngineError> {
        self.bounded_fold(
            collection,
            filter.as_ref(),
            |callbacks, records| {
                (
                    AggregateAccumulator::new(config),
                    QueryMatches::for_collection(
                        QueryInput {
                            r#where: filter.clone(),
                            ..Default::default()
                        },
                        callbacks,
                        records,
                        None,
                    ),
                )
            },
            |(accumulator, matches), row| {
                if matches.needs_ordered_rows() {
                    matches.push(row);
                } else if matches.matches_natural_candidate(row) {
                    accumulator.push(row);
                }
                Ok(())
            },
            |(accumulator, matches)| {
                if matches.needs_ordered_rows() {
                    matches.finish().map(|rows| {
                        proseql_engine::query::aggregate::compute_aggregates(&rows, config)
                    })
                } else {
                    Ok(accumulator.finish())
                }
            },
            |database| {
                database
                    .query(
                        collection,
                        QueryInput {
                            r#where: filter.clone(),
                            ..Default::default()
                        },
                        None,
                    )
                    .map(|rows| proseql_engine::query::aggregate::compute_aggregates(&rows, config))
            },
        )
        .map(|(result, _)| result)
    }

    pub fn aggregate_grouped_bounded(
        &self,
        collection: &str,
        filter: Option<Value>,
        group_by: &[String],
        config: &AggregateConfig,
    ) -> Result<Vec<GroupResult>, EngineError> {
        self.bounded_fold(
            collection,
            filter.as_ref(),
            |callbacks, records| {
                (
                    GroupedAggregateAccumulator::new(group_by, config),
                    QueryMatches::for_collection(
                        QueryInput {
                            r#where: filter.clone(),
                            ..Default::default()
                        },
                        callbacks,
                        records,
                        None,
                    ),
                )
            },
            |(accumulator, matches), row| {
                if matches.needs_ordered_rows() {
                    matches.push(row);
                } else if matches.matches_natural_candidate(row) {
                    accumulator.push(row);
                }
                Ok(())
            },
            |(accumulator, matches)| {
                if matches.needs_ordered_rows() {
                    matches.finish().map(|rows| {
                        proseql_engine::query::aggregate::compute_grouped_aggregates(
                            &rows, group_by, config,
                        )
                    })
                } else {
                    Ok(accumulator.finish())
                }
            },
            |database| {
                database
                    .query(
                        collection,
                        QueryInput {
                            r#where: filter.clone(),
                            ..Default::default()
                        },
                        None,
                    )
                    .map(|rows| {
                        proseql_engine::query::aggregate::compute_grouped_aggregates(
                            &rows, group_by, config,
                        )
                    })
            },
        )
        .map(|(result, _)| result)
    }

    fn bounded_fold<A, R>(
        &self,
        collection: &str,
        filter: Option<&Value>,
        make: impl FnOnce(Arc<CallbackRegistry>, &proseql_engine::collection::Collection) -> A,
        mut visit: impl FnMut(&mut A, &Value) -> Result<(), EngineError>,
        finish: impl FnOnce(A) -> Result<R, EngineError>,
        eager: impl FnOnce(&Database) -> Result<R, EngineError>,
    ) -> Result<(R, BoundedQueryStats), EngineError> {
        let mut state = self.lock_open()?;
        self.drain_unpins(&mut state);
        let state = &mut *state;
        let Some(sources) = state
            .sources
            .as_mut()
            .filter(|sources| sources.is_lazy(collection))
        else {
            let count = state
                .sources
                .as_ref()
                .map_or(0, |sources| sources.eager_partition_count(collection));
            return eager(&state.database).map(|result| {
                (
                    result,
                    BoundedQueryStats {
                        partitions_visited: count,
                        partitions_read: 0,
                        partitions_resident: count,
                        pinned_partitions: 0,
                        retained_partition_limit: 0,
                    },
                )
            });
        };
        let (_, paths) = sources.lazy_scope(collection, filter, "query")?;
        let mut accumulator = make(
            Arc::clone(&sources.callbacks),
            state
                .database
                .collection(collection)
                .expect("lazy collection"),
        );
        let result = sources.lazy_visit(
            &mut state.database,
            state.host.as_ref(),
            &state.formats,
            collection,
            &paths,
            |row| visit(&mut accumulator, row),
        );
        let trimmed = sources_trim(state);
        let read = result?;
        trimmed?;
        let sources = state.sources.as_ref().expect("source runtime");
        let status = sources.lazy_read_stats(collection, paths.len(), read);
        finish(accumulator).map(|result| (result, status))
    }
}
