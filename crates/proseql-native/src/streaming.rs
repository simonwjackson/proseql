//! Streaming reads for lazy partitioned collections.
//!
//! Owner: `exec` (#14). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! The call sites in `bounded.rs` and `lib.rs` (added by the contract
//! skeleton) call [`NativeRuntime::streaming_read`] before the resident path.
//! `None` means "not handled here": the caller continues on the resident
//! path. The signature of `streaming_read`, [`ReadRequest`] and
//! [`ReadOutput`] are binding; everything else in this file is `exec`'s.

// Skeleton: the owner removes this allow once the seam is implemented.
#![allow(dead_code)]

use crate::{BoundedQueryStats, NativeQueryStats, NativeRuntime};
use proseql_engine::errors::EngineError;
use proseql_engine::query::aggregate::{AggregateConfig, AggregateResult, GroupResult};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::{CursorConfig, CursorPageResult};
use serde_json::Value;

/// A read on one collection, as the public API received it.
pub(crate) enum ReadRequest<'a> {
    /// `query`, `query_bounded`, `query_bounded_with_stats`.
    Query {
        input: &'a QueryInput,
        populate: Option<&'a Value>,
    },
    /// `query_with_stats`: rows plus `NativeQueryStats`.
    QueryWithStats {
        input: &'a QueryInput,
        populate: Option<&'a Value>,
    },
    /// `query_cursor`, `query_cursor_bounded`.
    Cursor {
        input: &'a QueryInput,
        cursor: &'a CursorConfig,
        populate: Option<&'a Value>,
    },
    /// `aggregate`, `aggregate_bounded`.
    Aggregate {
        filter: Option<&'a Value>,
        config: &'a AggregateConfig,
    },
    /// `aggregate_grouped`, `aggregate_grouped_bounded`.
    Grouped {
        filter: Option<&'a Value>,
        group_by: &'a [String],
        config: &'a AggregateConfig,
    },
}

/// The answer to a [`ReadRequest`], variant for variant.
pub(crate) enum ReadOutput {
    Rows(Vec<Value>),
    RowsWithStats(Vec<Value>, NativeQueryStats),
    Page(CursorPageResult),
    Aggregate(AggregateResult),
    Grouped(Vec<GroupResult>),
}

impl NativeRuntime {
    /// Run `request` by scanning text, if `collection` is lazy and its
    /// execution model is `Streaming`. Must not be called with the runtime
    /// lock held. Returns `None` to fall back to the resident path.
    pub(crate) fn streaming_read(
        &self,
        _collection: &str,
        _request: ReadRequest<'_>,
    ) -> Option<Result<(ReadOutput, BoundedQueryStats), EngineError>> {
        None
    }
}
