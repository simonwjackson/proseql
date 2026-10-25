//! Source-compatible bounded query entry points. Lazy collections always scan;
//! eager collections use the resident engine.
use crate::streaming::{ReadOutput, ReadRequest};
use crate::NativeRuntime;
use proseql_engine::{
    errors::EngineError,
    query::{
        aggregate::{AggregateConfig, AggregateResult, GroupResult},
        pipeline::QueryInput,
        CursorConfig, CursorPageResult,
    },
    relationships::Database,
};
use serde_json::Value;

/// Physical read statistics. Lazy residency, pin and retention counts are zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedQueryStats {
    pub partitions_visited: usize,
    pub partitions_read: usize,
    pub partitions_resident: usize,
    pub pinned_partitions: usize,
    pub retained_partition_limit: usize,
    /// Rows examined after partition pruning and positional seeking, including
    /// rows rejected by filters or pagination. Eager
    /// reads count collection rows, rather than engine index candidates.
    pub candidate_rows: usize,
}

impl NativeRuntime {
    /// Scan lazy text without retaining partitions. Output, sorting and
    /// aggregate state can still allocate. Non-lazy collections use the engine.
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
        if let Some(read) = self.streaming_read(
            collection,
            ReadRequest::Query {
                input: &input,
                populate: None,
            },
        ) {
            return read.map(|(output, stats)| match output {
                ReadOutput::Rows(rows) => (rows, stats),
                _ => unreachable!("streaming query returns rows"),
            });
        }
        self.eager_bounded(collection, |database| {
            database.query(collection, input, None)
        })
    }

    pub fn query_cursor_bounded(
        &self,
        collection: &str,
        input: QueryInput,
        cursor: &CursorConfig,
    ) -> Result<CursorPageResult, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            ReadRequest::Cursor {
                input: &input,
                cursor,
                populate: None,
            },
        ) {
            return read.map(|(output, _)| match output {
                ReadOutput::Page(page) => page,
                _ => unreachable!("streaming cursor query returns a page"),
            });
        }
        self.eager_bounded(collection, |database| {
            database.query_cursor(collection, &input, cursor, None)
        })
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
        if let Some(read) = self.streaming_read(
            collection,
            ReadRequest::Aggregate {
                filter: filter.as_ref(),
                config,
            },
        ) {
            return read.map(|(output, _)| match output {
                ReadOutput::Aggregate(result) => result,
                _ => unreachable!("streaming aggregate returns an aggregate"),
            });
        }
        self.aggregate(collection, filter, config)
    }

    pub fn aggregate_grouped_bounded(
        &self,
        collection: &str,
        filter: Option<Value>,
        group_by: &[String],
        config: &AggregateConfig,
    ) -> Result<Vec<GroupResult>, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            ReadRequest::Grouped {
                filter: filter.as_ref(),
                group_by,
                config,
            },
        ) {
            return read.map(|(output, _)| match output {
                ReadOutput::Grouped(groups) => groups,
                _ => unreachable!("streaming grouped aggregate returns groups"),
            });
        }
        self.aggregate_grouped(collection, filter, group_by, config)
    }

    fn eager_bounded<R>(
        &self,
        collection: &str,
        eager: impl FnOnce(&Database) -> Result<R, EngineError>,
    ) -> Result<(R, BoundedQueryStats), EngineError> {
        let state = self.lock_open()?;
        let count = state
            .sources
            .as_ref()
            .map_or(0, |sources| sources.eager_partition_count(collection));
        eager(&state.database).map(|result| {
            (
                result,
                BoundedQueryStats {
                    partitions_visited: count,
                    partitions_read: 0,
                    partitions_resident: count,
                    pinned_partitions: 0,
                    retained_partition_limit: 0,
                    candidate_rows: state
                        .database
                        .collection(collection)
                        .map_or(0, |rows| rows.len()),
                },
            )
        })
    }
}
