//! Streaming reads for lazy partitioned collections.
//!
//! Normal built-in JSONL reads use chunk buffers, one borrowed row, a compact
//! query-local identity arena, and output/top-k/group workspace. Custom codecs
//! decode one complete partition through the registered codec; they never seek.
//! Erroneous partitions replay the document decoder to preserve error precedence.
//! Those two compatibility paths have a largest-partition transient memory bound.
//!
//! Streaming stats count selected paths (`partitions_visited`/`partitions_loaded`)
//! and existing files opened (`partitions_read`). Resident/pinned/cache counts
//! are zero. `candidate_rows` counts validated rows offered to the scan, including
//! rows rejected by filtering or pagination. `index_used` is Ordered only when
//! a positional time seek was used; `index_sorted` is false (the executor sorts).
//!
//! Under ExecutionModel::Streaming, schema-check and query callbacks may run in
//! a different order and a different number of times than under Resident (for
//! example, interleaved with filtering, or again when an error is reported).
//! Results and the first reported error are unchanged. Callbacks must be
//! side-effect-free predicates.
//!
//! Owner: `exec` (#14). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! The call sites in `bounded.rs` and `lib.rs` (added by the contract
//! skeleton) call [`NativeRuntime::streaming_read`] before the resident path.
//! `None` means "not handled here": the caller continues on the resident
//! path. The signature of `streaming_read`, [`ReadRequest`] and
//! [`ReadOutput`] are binding; everything else in this file is `exec`'s.

use crate::{BoundedQueryStats, NativeQueryStats, NativeRuntime};
use proseql_engine::errors::EngineError;
use proseql_engine::query::aggregate::{AggregateConfig, AggregateResult, GroupResult};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::{CursorConfig, CursorPageResult};
use serde_json::Value;

#[cfg(test)]
#[allow(dead_code)]
#[path = "../tests/support/parity.rs"]
mod validated_fixture;
#[cfg(test)]
#[path = "streaming_validated_race_tests.rs"]
mod validated_race_tests;
#[cfg(test)]
#[path = "streaming_validated_tests.rs"]
mod validated_tests;

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
    /// Scan lazy text. Must not be called with the runtime lock held.
    /// Returns None only for eager collections.
    pub(crate) fn streaming_read(
        &self,
        collection: &str,
        request: ReadRequest<'_>,
    ) -> Option<Result<(ReadOutput, BoundedQueryStats), EngineError>> {
        self.streaming_read_impl(collection, request, true)
    }

    fn streaming_read_impl(
        &self,
        collection: &str,
        request: ReadRequest<'_>,
        mut use_validation: bool,
    ) -> Option<Result<(ReadOutput, BoundedQueryStats), EngineError>> {
        let mut state = match self.lock_open() {
            Ok(state) => state,
            Err(error) => return Some(Err(error)),
        };
        let applies = state
            .sources
            .as_ref()
            .is_some_and(|sources| sources.is_lazy(collection));
        if !applies {
            return None;
        }
        loop {
            let mut retry_validating = false;
            let result = Some((|| {
                use proseql_engine::query::indexes::IndexUsed;
                use proseql_engine::scan::executor::{Executor, ScanOutput, ScanRequest};
                let filter = match &request {
                    ReadRequest::Query { input, .. }
                    | ReadRequest::QueryWithStats { input, .. }
                    | ReadRequest::Cursor { input, .. } => input.r#where.as_ref(),
                    ReadRequest::Aggregate { filter, .. } | ReadRequest::Grouped { filter, .. } => {
                        *filter
                    }
                };
                let indexed = match &request {
                    ReadRequest::Query { populate, .. }
                    | ReadRequest::QueryWithStats { populate, .. }
                    | ReadRequest::Cursor { populate, .. } => populate.is_none(),
                    _ => true,
                };
                let scan_request = match &request {
                    ReadRequest::Query { input, .. }
                    | ReadRequest::QueryWithStats { input, .. } => ScanRequest::Query(input, None),
                    ReadRequest::Cursor { input, cursor, .. } => {
                        ScanRequest::Query(input, Some(cursor))
                    }
                    ReadRequest::Aggregate { filter, config } => {
                        ScanRequest::Aggregate(*filter, config)
                    }
                    ReadRequest::Grouped {
                        filter,
                        group_by,
                        config,
                    } => ScanRequest::Grouped(*filter, group_by, config),
                };
                let sources = state.sources.as_ref().expect("streaming source");
                let (_, paths) = sources.lazy_scope(collection, filter, "query")?;
                let lazy = &sources.lazy[collection];
                let source = lazy.source.clone();
                let config = sources.config.collection_configs[collection].clone();
                let mut decode_config = config.clone();
                decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
                let callbacks = std::sync::Arc::clone(&sources.callbacks);
                let records = state
                    .database
                    .collection(collection)
                    .expect("lazy collection");
                let mut executor = Executor::new(
                    records,
                    std::sync::Arc::clone(&callbacks),
                    scan_request,
                    indexed,
                )?;
                let descriptor = records.descriptor.clone();
                let builtin = state.formats.borrowed_jsonl_compatible(&source.format);
                let prepared_decoder =
                    proseql_engine::scan::decoder::SimpleDecoder::new(&config.schema);
                let projection = prepared_decoder.as_ref().and_then(|decoder| {
                    if !matches!(
                        config.id_strategy,
                        proseql_engine::descriptor::IdStrategy::Provided
                    ) {
                        return None;
                    }
                    decoder.projection(&executor.required_fields()?)
                });
                let seek = if builtin {
                    range_bounds(&descriptor, filter)
                } else {
                    None
                };
                let host = std::sync::Arc::clone(&state.host);
                let formats = std::sync::Arc::clone(&state.formats);
                let mut stats = BoundedQueryStats {
                    partitions_visited: paths.len(),
                    partitions_read: 0,
                    partitions_resident: 0,
                    pinned_partitions: 0,
                    retained_partition_limit: 0,
                    candidate_rows: 0,
                };
                let mut index_used = IndexUsed::None;
                let mut identities = IdArena::default();
                let mut ordinal = 0;
                let mut read_indexes = crate::locate::read_indexes::ReadIndexes::default();
                let mut torn_diagnostics = Vec::new();
                let committed_indexes = &state.sources.as_ref().expect("source").lazy[collection]
                    .stream
                    .index;
                for (partition, path) in paths.iter().enumerate() {
                    let file_seek = seek.filter(|(field, lower, upper)| {
                        !covers_partition(&source, path, field, *lower, *upper)
                    });
                    let observed = if file_seek.is_some() || (builtin && projection.is_some()) {
                        let Some(stat) = host.stat(path)? else {
                            continue;
                        };
                        proseql_storage::generation::SourceGeneration::observe_stat(
                            host.as_ref(),
                            path,
                            stat,
                        )
                        .ok()
                    } else {
                        if !host.exists(path)? {
                            continue;
                        }
                        None
                    };
                    let proven = if use_validation && projection.is_some() && builtin {
                        match observed.as_ref() {
                            Some(observed) => read_indexes.checked_validation(
                                committed_indexes,
                                host.as_ref(),
                                path,
                                observed,
                            )?,
                            None => false,
                        }
                    } else {
                        false
                    };
                    let range = match file_seek.zip(observed.as_ref()) {
                        // An optional index is not the error authority. Failed
                        // refreshes fall back to canonical scanning; no staged
                        // metadata is committed unless the whole request succeeds.
                        Some(((field, lower, upper), observed)) => read_indexes
                            .time_index(
                                committed_indexes,
                                host.as_ref(),
                                path,
                                field,
                                observed.clone(),
                            )
                            .ok()
                            .flatten()
                            .and_then(|index| index.seek(lower, upper)),
                        None => None,
                    };
                    let mut pending_index = if let Some(((field, _, _), observed)) =
                        file_seek.filter(|_| range.is_none()).zip(observed.clone())
                    {
                        read_indexes
                            .begin_time_index(committed_indexes, path, field, observed)
                            .ok()
                            .flatten()
                    } else {
                        None
                    };
                    if let Some(range) = range {
                        index_used = IndexUsed::Ordered;
                        if range
                            .end_offset
                            .is_some_and(|end| range.start_offset >= end)
                        {
                            continue;
                        }
                    }
                    let identity_start = identities.entries.len();
                    identities.scopes.push((partition, range));
                    stats.partitions_read += 1;
                    let file = proseql_storage::partitioned::file_source(&source, path);
                    let mut uncertified_tail = false;
                    let partition_result = if !builtin {
                        (|| {
                            // Custom codecs retain their whole-document decode contract.
                            // One partition's records coexist with query workspace;
                            // positional indexes cannot interpret these custom rows.
                            let raw = host.read_bytes(path)?;
                            let mut loaded = proseql_storage::append::decode_append_bytes(
                                host.as_ref(),
                                &formats,
                                &file,
                                &decode_config,
                                &raw,
                                true,
                            )?;
                            crate::schema_checks::decode_loaded_records(
                                &config.schema,
                                &config.id_strategy,
                                &mut loaded.records,
                                &callbacks,
                            )?;
                            for (id, row) in &loaded.records {
                                proseql_storage::partitioned::check_partition_record(
                                    &source, path, id, row,
                                )?;
                            }
                            for row in loaded.records.values() {
                                validate_row(&config.schema, row, &callbacks)?;
                            }
                            for (index, (id, row)) in loaded.records.iter().enumerate() {
                                identities.push(id, partition, index as u64);
                                executor.push(row, ordinal);
                                ordinal += 1;
                            }
                            if let Some(torn) = loaded.torn {
                                torn_diagnostics.push(torn);
                            }
                            Ok(())
                        })()
                    } else {
                        let expected_key =
                            proseql_storage::partition_prune::partition_key_of_path(&source, path);
                        read_rows(
                            host.as_ref(),
                            path,
                            range,
                            |bytes, final_unterminated, _line, offset| {
                                use proseql_engine::scan::borrowed::BorrowedValue;
                                // Whole-file validation may have ignored a torn final
                                // fragment. Its proof never certifies that fragment as
                                // a row; keep ordinary JSON/torn-line handling here.
                                if final_unterminated {
                                    uncertified_tail = true;
                                } else if proven {
                                    if let Some((borrowed, present)) =
                                        prepared_decoder.as_ref().and_then(|decoder| {
                                            decoder
                                                .decode_proven_positioned(
                                                    bytes,
                                                    projection.expect("projection"),
                                                )
                                                .ok()
                                        })
                                    {
                                        if let Some(id) =
                                            borrowed.get("id").and_then(BorrowedValue::as_str)
                                        {
                                            if let Some(index) = pending_index.as_mut() {
                                                let field = file_seek.expect("index field").0;
                                                index.push_key(
                                                    borrowed.get(field).map_or(
                                                        Value::Null,
                                                        BorrowedValue::to_owned,
                                                    ),
                                                    offset,
                                                    final_unterminated,
                                                );
                                            }
                                            identities.push(id, partition, offset);
                                            executor.push_positioned(&borrowed, present, ordinal);
                                            ordinal += 1;
                                            return Ok(());
                                        }
                                    }
                                    // A changed file can fail parsing even before the
                                    // final generation check. Replay canonical errors.
                                }
                                let parsed = match &prepared_decoder {
                                    Some(decoder) => decoder
                                        .decode_positioned(bytes)
                                        .ok()
                                        .flatten()
                                        .map(|(row, present)| (row, Some(present)))
                                        // A canonical payload fallback can still
                                        // provide an eligible untransformed key.
                                        .or_else(|| {
                                            serde_json::from_slice::<BorrowedValue<'_>>(bytes)
                                                .ok()
                                                .map(|row| (row, None))
                                        }),
                                    None => serde_json::from_slice::<BorrowedValue<'_>>(bytes)
                                        .ok()
                                        .map(|row| (row, None)),
                                };
                                if let Some((mut borrowed, decoded)) = parsed {
                                    if let Some(index) = pending_index.as_mut() {
                                        let field = file_seek.expect("index field").0;
                                        index.push_key(
                                            borrowed
                                                .get(field)
                                                .map_or(Value::Null, BorrowedValue::to_owned),
                                            offset,
                                            final_unterminated,
                                        );
                                    }
                                    if matches!(
                                        config.id_strategy,
                                        proseql_engine::descriptor::IdStrategy::Provided
                                    ) && (decoded.is_some()
                                        || borrowed.decode_simple(&config.schema))
                                        && borrowed
                                            .get("id")
                                            .and_then(BorrowedValue::as_str)
                                            .is_some_and(|id| !id.is_empty())
                                        && borrowed_partition_matches(
                                            &source,
                                            expected_key.as_deref(),
                                            &borrowed,
                                        )
                                    {
                                        let id = borrowed
                                            .get("id")
                                            .and_then(BorrowedValue::as_str)
                                            .expect("validated borrowed ID");
                                        if final_unterminated {
                                            uncertified_tail = false;
                                        }
                                        identities.push(id, partition, offset);
                                        match decoded {
                                            Some(present) => executor
                                                .push_positioned(&borrowed, present, ordinal),
                                            None => executor.push_borrowed(&borrowed, ordinal),
                                        }
                                        ordinal += 1;
                                        return Ok(());
                                    }
                                } else {
                                    // A torn suffix or canonical replay must not publish
                                    // incomplete positional metadata.
                                    pending_index = None;
                                }
                                // Canonical storage decoding is intentionally row-local:
                                // every read row is decoded and validated before filtering.
                                // Complex schemas and callbacks use the ordinary decoder.
                                let mut terminated = Vec::new();
                                let bytes = if final_unterminated {
                                    bytes
                                } else {
                                    terminated.extend_from_slice(bytes);
                                    terminated.push(b'\n');
                                    &terminated
                                };
                                let mut loaded = proseql_storage::append::decode_append_bytes(
                                    host.as_ref(),
                                    &formats,
                                    &file,
                                    &decode_config,
                                    bytes,
                                    true,
                                )?;
                                crate::schema_checks::decode_loaded_records(
                                    &config.schema,
                                    &config.id_strategy,
                                    &mut loaded.records,
                                    &callbacks,
                                )?;
                                for (id, row) in loaded.records {
                                    proseql_storage::partitioned::check_partition_record(
                                        &source, path, &id, &row,
                                    )?;
                                    validate_row(&config.schema, &row, &callbacks)?;
                                    identities.push(&id, partition, offset);
                                    executor.push(&row, ordinal);
                                    ordinal += 1;
                                }
                                if final_unterminated && loaded.torn.is_none() {
                                    uncertified_tail = false;
                                }
                                if loaded.torn.is_some() {
                                    let torn = torn_diagnostic(host.as_ref(), path, offset)?;
                                    torn_diagnostics.push(torn);
                                }
                                Ok(())
                            },
                        )
                    };
                    if partition_result.is_ok() {
                        if let Some(observed) = observed {
                            if observed.check(host.as_ref())?
                                != proseql_storage::generation::GenerationCheck::Unchanged
                            {
                                // None of this attempt's rows, folds or stats may
                                // escape after a proof became stale. Retry the whole
                                // request without proofs, under the same runtime lock.
                                retry_validating = use_validation;
                                return Err(EngineError::Operation(proseql_engine::errors::OperationError {
                                    operation: "read".into(),
                                    reason: "source-changed".into(),
                                    message: format!("Source '{path}' changed while building its index; retry the operation"),
                                }));
                            }
                            // A complete-generation record must not bless bytes
                            // that canonical append decoding may have ignored.
                            if range.is_none() && !uncertified_tail {
                                read_indexes.stage_validation(path, observed);
                            }
                        }
                        if let Some(index) =
                            pending_index.and_then(|index| index.complete(host.as_ref()).ok())
                        {
                            read_indexes.stage_time_index(
                                path,
                                file_seek.expect("index field").0,
                                index,
                            );
                        }
                    }
                    if let Err(error) = partition_result {
                        // Earlier partitions can already contain a cross-file
                        // duplicate, which precedes this partition's load error.
                        identities.entries.truncate(identity_start);
                        identities.scopes.pop();
                        identities.validate(
                            host.as_ref(),
                            &source,
                            &paths,
                            (!builtin).then_some((&formats, &decode_config)),
                        )?;
                        // Error-only canonical replay keeps whole-partition parse,
                        // ID, schema and partition-error precedence and payloads.
                        return Err(validate_partition_after_error(
                            host.as_ref(),
                            &formats,
                            &source,
                            path,
                            &config,
                            &callbacks,
                        )
                        .err()
                        .unwrap_or(error));
                    }
                }
                if let Err(error) = identities.validate(
                    host.as_ref(),
                    &source,
                    &paths,
                    (!builtin).then_some((&formats, &decode_config)),
                ) {
                    if let EngineError::SourceConfig(source_error) = &error {
                        if let Some(path) = &source_error.path {
                            validate_partition_after_error(
                                host.as_ref(),
                                &formats,
                                &source,
                                path,
                                &config,
                                &callbacks,
                            )?;
                        }
                    }
                    return Err(error);
                }
                let candidate_rows = executor.candidate_rows;
                stats.candidate_rows = candidate_rows;
                let output = match executor.finish()? {
                    ScanOutput::Rows(rows) => match request {
                        ReadRequest::QueryWithStats { .. } => ReadOutput::RowsWithStats(
                            rows,
                            NativeQueryStats {
                                partitions_loaded: stats.partitions_visited,
                                partitions_read: stats.partitions_read,
                                partitions_resident: 0,
                                index_used,
                                candidate_rows,
                                index_sorted: false,
                            },
                        ),
                        _ => ReadOutput::Rows(rows),
                    },
                    ScanOutput::Page(page) => ReadOutput::Page(page),
                    ScanOutput::Aggregate(result) => ReadOutput::Aggregate(result),
                    ScanOutput::Grouped(groups) => ReadOutput::Grouped(groups),
                };
                // Finish can still fail (for example an invalid cursor). Only
                // a fully successful request may publish any derived state.
                let sources = state.sources.as_mut().expect("source");
                read_indexes
                    .commit(&mut sources.lazy.get_mut(collection).expect("lazy").stream.index);
                for torn in torn_diagnostics {
                    sources.torn.retain(|old| old.path != torn.path);
                    sources.torn.push(torn);
                }
                Ok((output, stats))
            })());
            if retry_validating {
                use_validation = false;
                continue;
            }
            return result;
        }
    }
}

fn source_error(
    source: &proseql_storage::source_config::PartitionedSourceConfig,
    path: &str,
    message: String,
) -> EngineError {
    EngineError::SourceConfig(Box::new(proseql_engine::errors::SourceConfigError {
        message,
        source_id: Some(source.id.clone()),
        collection: Some(source.collection.clone()),
        path: Some(path.into()),
    }))
}

// Deliberately conservative: only a top-level range on an untransformed
// scalar field can seek. Other predicates remain correct full-file scans.
fn range_bounds<'a>(
    descriptor: &'a proseql_engine::descriptor::CollectionDescriptor,
    filter: Option<&'a Value>,
) -> Option<(&'a str, Option<&'a Value>, Option<&'a Value>)> {
    use proseql_engine::descriptor::SchemaNode;
    let SchemaNode::Struct { fields } = &descriptor.schema else {
        return None;
    };
    for field in &descriptor.ordered_indexes {
        let schema = &fields
            .iter()
            .find(|candidate| candidate.name == *field)?
            .schema;
        let ops = match filter
            .and_then(|filter| filter.get(field))
            .and_then(Value::as_object)
        {
            Some(ops) => ops,
            None => continue,
        };
        if ops
            .get("$eq")
            .is_some_and(proseql_engine::value::is_boundary_undefined)
        {
            continue;
        }
        let valid = |value: &&Value| {
            matches!(
                (schema, *value),
                (SchemaNode::Str, Value::String(_)) | (SchemaNode::Num, Value::Number(_))
            )
        };
        let lower = ops.get("$gte").or_else(|| ops.get("$gt")).filter(valid);
        let upper = ops.get("$lte").or_else(|| ops.get("$lt")).filter(valid);
        if lower.is_some() || upper.is_some() {
            return Some((field, lower, upper));
        }
    }
    None
}

// Prefix bounds are deliberately stricter than calendar equality: timestamps
// allow arbitrary fractional precision, so midnight .000Z is not a lexical
// lower bound for every valid midnight fraction in the same bucket.
fn covers_partition(
    source: &proseql_storage::source_config::PartitionedSourceConfig,
    path: &str,
    field: &str,
    lower: Option<&Value>,
    upper: Option<&Value>,
) -> bool {
    use proseql_storage::source_config::PartitionKey;
    let PartitionKey::TimeBucket {
        field: partition_field,
        bucket,
    } = &source.partition_by
    else {
        return false;
    };
    if partition_field != field {
        return false;
    }
    let Some(key) = proseql_storage::partition_prune::partition_key_of_path(source, path) else {
        return false;
    };
    let lower_ok = lower.is_none_or(|bound| {
        bound.as_str().is_some_and(|value| {
            proseql_storage::partitioned::time_bucket_key(value, *bucket).is_some()
                && value <= key.as_str()
        })
    });
    let upper_ok = upper.is_none_or(|bound| {
        bound.as_str().is_some_and(|value| {
            proseql_storage::partitioned::time_bucket_key(value, *bucket).is_some()
                && value > format!("{key}~").as_str()
        })
    });
    lower_ok && upper_ok
}

/// All normal reads use the shared bounded framer. Hosts whose read_range
/// default reads whole files retain that host-specific fallback bound.
fn read_rows(
    host: &dyn proseql_storage::host::StorageHost,
    path: &str,
    range: Option<proseql_storage::index::SeekRange>,
    mut visit: impl FnMut(&[u8], bool, usize, u64) -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    use proseql_engine::scan::{framer::LineFramer, RowSource};
    use proseql_storage::readers::HostChunks;
    let start = range.map_or(0, |range| range.start_offset);
    let chunks = HostChunks::new(host, path, start);
    let mut lines =
        LineFramer::with_offset(chunks, 0, start, range.map_or(0, |range| range.start_row));
    let mut last_end = start;
    let mut final_row = false;
    while let Some(row) = lines.next_row()? {
        if range
            .and_then(|range| range.end_offset)
            .is_some_and(|end| row.location.offset >= end)
        {
            return Ok(());
        }
        visit(
            row.bytes,
            row.final_unterminated,
            row.location.ordinal as usize + 1,
            row.location.offset,
        )?;
        last_end =
            row.location.offset + row.bytes.len() as u64 + u64::from(!row.final_unterminated);
        final_row = row.final_unterminated;
    }
    // The shared framer skips whitespace rows. An unterminated whitespace
    // suffix is nevertheless a torn append in the canonical storage codec.
    if !final_row && range.and_then(|range| range.end_offset).is_none() {
        use proseql_storage::readers::ByteChunks;
        let mut tail = HostChunks::new(host, path, last_end);
        let mut whitespace = Vec::new();
        let mut offset = last_end;
        while let Some(bytes) = tail.next_chunk()? {
            if !bytes.iter().all(u8::is_ascii_whitespace) {
                return Ok(());
            }
            if let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') {
                offset += whitespace.len() as u64 + last_newline as u64 + 1;
                whitespace.clear();
                whitespace.extend_from_slice(&bytes[last_newline + 1..]);
            } else {
                whitespace.extend_from_slice(bytes);
            }
        }
        if !whitespace.is_empty() {
            visit(&whitespace, true, 0, offset)?;
        }
    }
    Ok(())
}

fn validate_row(
    schema: &proseql_engine::descriptor::SchemaNode,
    row: &Value,
    callbacks: &proseql_engine::callbacks::CallbackRegistry,
) -> Result<(), EngineError> {
    if row
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(EngineError::Validation(
            proseql_engine::errors::ValidationError {
                message: "Loaded record is missing required field 'id'".into(),
                issues: vec![proseql_engine::errors::ValidationIssue {
                    field: "id".into(),
                    message: "Expected string, got absent".into(),
                    value: None,
                    expected: Some("string".into()),
                    received: Some("absent".into()),
                }],
            },
        ));
    }
    proseql_engine::validator::validate_value_with_callbacks(schema, row, Some(callbacks))
}

pub(crate) fn borrowed_partition_matches(
    source: &proseql_storage::source_config::PartitionedSourceConfig,
    expected: Option<&str>,
    row: &proseql_engine::scan::borrowed::BorrowedValue<'_>,
) -> bool {
    use proseql_storage::source_config::PartitionKey;
    let Some(value) = row
        .get(source.partition_by.field())
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    let key = match &source.partition_by {
        PartitionKey::Field { .. } => Some(value),
        PartitionKey::TimeBucket { bucket, .. } => {
            proseql_storage::partitioned::time_bucket_key(value, *bucket)
        }
        PartitionKey::Prefix { delimiter, .. } => value.split_once(delimiter).map(|(key, _)| key),
    };
    key.is_some_and(|key| {
        !key.is_empty()
            && !key.starts_with('.')
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            && Some(key) == expected
    })
}

/// Ordinary reads keep only 64-bit hashes (8 bytes per visited row). Only hash
/// collisions replay the visited windows to recover exact candidate locations.
/// They then use the same text verification and error ordering as before.
#[derive(Default)]
struct IdArena {
    entries: Vec<u64>,
    scopes: Vec<(usize, Option<proseql_storage::index::SeekRange>)>,
}
fn identity_hash(id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hasher);
    hasher.finish()
}
impl IdArena {
    fn push(&mut self, id: &str, _partition: usize, _offset: u64) {
        if self.entries.len() == self.entries.capacity() {
            self.entries.reserve_exact(4096);
        }
        self.entries.push(identity_hash(id));
    }
    fn validate(
        mut self,
        host: &dyn proseql_storage::host::StorageHost,
        source: &proseql_storage::source_config::PartitionedSourceConfig,
        paths: &[String],
        codec: Option<(
            &proseql_formats::FormatRegistry,
            &proseql_storage::persistence::CollectionStorageConfig,
        )>,
    ) -> Result<(), EngineError> {
        self.entries.sort_unstable();
        let mut collisions: Vec<_> = self
            .entries
            .windows(2)
            .filter(|pair| pair[0] == pair[1])
            .map(|pair| pair[0])
            .collect();
        collisions.dedup();
        if collisions.is_empty() {
            return Ok(());
        }
        drop(self.entries);
        let mut candidates = IdCandidates::default();
        for (partition, range) in self.scopes {
            let path = &paths[partition];
            if let Some((formats, config)) = codec {
                let raw = host.read_bytes(path)?;
                let loaded = proseql_storage::append::decode_append_bytes(
                    host,
                    formats,
                    &proseql_storage::partitioned::file_source(source, path),
                    config,
                    &raw,
                    true,
                )?;
                for (index, id) in loaded.records.keys().enumerate() {
                    if collisions.binary_search(&identity_hash(id)).is_ok() {
                        candidates.push(id, partition, index as u64);
                    }
                }
            } else {
                read_rows(host, path, range, |bytes, final_line, _, offset| {
                    match proseql_engine::scan::field::decode_field(bytes, "id") {
                        Ok(Some(Value::String(id))) => {
                            if collisions.binary_search(&identity_hash(&id)).is_ok() {
                                candidates.push(&id, partition, offset);
                            }
                        }
                        Err(_) if final_line => {}
                        _ => {
                            return Err(crate::operation_error(
                                "streaming-source-changed",
                                format!(
                                "Record at '{path}:{offset}' changed during identity verification"
                            ),
                            ))
                        }
                    }
                    Ok(())
                })?;
            }
        }
        candidates.validate(host, source, paths, codec)
    }
}

/// Locations are needed only for collision candidates. Large file offsets use
/// a lossless wide side table; hashes never prove identity by themselves.
#[derive(Default)]
struct IdCandidates {
    entries: Vec<IdEntry>,
    wide: Vec<(usize, u64)>,
}
#[derive(Clone, Copy)]
struct IdEntry {
    hash: u64,
    location: u64,
}
fn id_location(entry: IdEntry, wide: &[(usize, u64)]) -> (usize, u64) {
    if entry.location >> 63 == 0 {
        (
            (entry.location >> 32) as usize,
            entry.location & u64::from(u32::MAX),
        )
    } else {
        wide[(entry.location & !(1 << 63)) as usize]
    }
}
impl IdCandidates {
    fn push(&mut self, id: &str, partition: usize, offset: u64) {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hasher);
        if self.entries.len() == self.entries.capacity() {
            self.entries.reserve_exact(4096);
        }
        let location = if partition < (1 << 31) && offset <= u64::from(u32::MAX) {
            ((partition as u64) << 32) | offset
        } else {
            let index = self.wide.len() as u64;
            self.wide.push((partition, offset));
            index | (1 << 63)
        };
        self.entries.push(IdEntry {
            hash: hasher.finish(),
            location,
        });
    }
    fn validate(
        mut self,
        host: &dyn proseql_storage::host::StorageHost,
        source: &proseql_storage::source_config::PartitionedSourceConfig,
        paths: &[String],
        codec: Option<(
            &proseql_formats::FormatRegistry,
            &proseql_storage::persistence::CollectionStorageConfig,
        )>,
    ) -> Result<(), EngineError> {
        self.entries
            .sort_unstable_by_key(|entry| (entry.hash, id_location(*entry, &self.wide)));
        let mut duplicate: Option<(IdEntry, bool, String)> = None;
        let mut start = 0;
        while start < self.entries.len() {
            let mut end = start + 1;
            while end < self.entries.len() && self.entries[end].hash == self.entries[start].hash {
                end += 1;
            }
            if end > start + 1 {
                let mut verified = Vec::<(IdEntry, String)>::new();
                for entry in &self.entries[start..end] {
                    let (partition, offset) = id_location(*entry, &self.wide);
                    let id = match codec {
                        None => read_id_at(host, &paths[partition], offset)?,
                        Some((formats, config)) => {
                            let path = &paths[partition];
                            let raw = host.read_bytes(path)?;
                            let loaded = proseql_storage::append::decode_append_bytes(
                                host,
                                formats,
                                &proseql_storage::partitioned::file_source(source, path),
                                config,
                                &raw,
                                true,
                            )?;
                            loaded
                                .records
                                .get_index(offset as usize)
                                .map(|(id, _)| id.clone())
                                .ok_or_else(|| {
                                    crate::operation_error(
                                        "streaming-source-changed",
                                        format!("Record in '{path}' disappeared during the read"),
                                    )
                                })?
                        }
                    };
                    if let Some((first, _)) = verified.iter().find(|(_, previous)| *previous == id)
                    {
                        if duplicate.as_ref().is_none_or(|(old, _, _)| {
                            (partition, offset) < id_location(*old, &self.wide)
                        }) {
                            duplicate =
                                Some((*entry, id_location(*first, &self.wide).0 == partition, id));
                        }
                    } else {
                        verified.push((*entry, id));
                    }
                }
            }
            start = end;
        }
        if let Some((entry, same_partition, id)) = duplicate {
            return Err(source_error(
                source,
                &paths[id_location(entry, &self.wide).0],
                if same_partition {
                    "Partition records need unique string IDs".into()
                } else {
                    format!("Duplicate partition record '{id}'")
                },
            ));
        }
        Ok(())
    }
}
fn read_id_at(
    host: &dyn proseql_storage::host::StorageHost,
    path: &str,
    offset: u64,
) -> Result<String, EngineError> {
    use proseql_engine::scan::{borrowed::BorrowedValue, framer::LineFramer, RowSource};
    let mut lines = LineFramer::with_offset(
        proseql_storage::readers::HostChunks::new(host, path, offset),
        0,
        offset,
        0,
    );
    let row = lines.next_row()?.ok_or_else(|| {
        crate::operation_error(
            "streaming-source-changed",
            format!("Record at '{path}:{offset}' disappeared during the read"),
        )
    })?;
    let value: BorrowedValue<'_> = serde_json::from_slice(row.bytes).map_err(|_| {
        crate::operation_error(
            "streaming-source-changed",
            format!("Record at '{path}:{offset}' changed during the read"),
        )
    })?;
    value
        .get("id")
        .and_then(BorrowedValue::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            crate::operation_error(
                "streaming-source-changed",
                format!("Record at '{path}:{offset}' lost its ID during the read"),
            )
        })
}

fn torn_diagnostic(
    host: &dyn proseql_storage::host::StorageHost,
    path: &str,
    offset: u64,
) -> Result<proseql_storage::append::TornLineDiagnostic, EngineError> {
    use proseql_storage::readers::{ByteChunks, HostChunks};
    let mut chunks = HostChunks::new(host, path, 0);
    let mut remaining = offset;
    let mut line = 1;
    while remaining > 0 {
        let Some(bytes) = chunks.next_chunk()? else {
            break;
        };
        let keep = bytes.len().min(remaining as usize);
        line += bytes[..keep].iter().filter(|byte| **byte == b'\n').count();
        remaining -= keep as u64;
    }
    let bytes = host
        .stat(path)?
        .map_or(0, |stat| stat.len.saturating_sub(offset)) as usize;
    Ok(proseql_storage::append::TornLineDiagnostic { path: path.into(), line, bytes, message: format!("Ignored an interrupted append at line {line} of '{path}' ({bytes} bytes without a final newline); the next append removes it") })
}

/// Only erroneous files use a document-sized fallback. This is the same
/// decoder and phase order as lazy::read_partition, including error payloads.
fn validate_partition_after_error(
    host: &dyn proseql_storage::host::StorageHost,
    formats: &proseql_formats::FormatRegistry,
    source: &proseql_storage::source_config::PartitionedSourceConfig,
    path: &str,
    config: &proseql_storage::persistence::CollectionStorageConfig,
    callbacks: &proseql_engine::callbacks::CallbackRegistry,
) -> Result<(), EngineError> {
    let mut decode_config = config.clone();
    decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
    let raw = host.read_bytes(path)?;
    let mut loaded = proseql_storage::append::decode_append_bytes(
        host,
        formats,
        &proseql_storage::partitioned::file_source(source, path),
        &decode_config,
        &raw,
        true,
    )?;
    crate::schema_checks::decode_loaded_records(
        &config.schema,
        &config.id_strategy,
        &mut loaded.records,
        callbacks,
    )?;
    for (id, row) in &loaded.records {
        proseql_storage::partitioned::check_partition_record(source, path, id, row)?;
    }
    for row in loaded.records.values() {
        validate_row(&config.schema, row, callbacks)?;
    }
    Ok(())
}
