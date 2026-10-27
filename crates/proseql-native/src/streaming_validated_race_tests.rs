use super::validated_fixture::{ParityFixture, RuntimeKind, COLLECTION};
use super::*;
use proseql_storage::{
    fs::FsStorageHost,
    host::{FileStat, StorageEvent, StorageHost, WatchHandle},
    persistence::DurableStorageHost,
};
use serde_json::json;
use std::{
    fs,
    io::Write,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

fn rows(
    runtime: &NativeRuntime,
    proven: bool,
) -> Result<(Vec<Value>, BoundedQueryStats), EngineError> {
    let input = QueryInput {
        select: Some(json!(["id", "value"])),
        ..Default::default()
    };
    query_rows(runtime, &input, proven)
}

fn query_rows(
    runtime: &NativeRuntime,
    input: &QueryInput,
    proven: bool,
) -> Result<(Vec<Value>, BoundedQueryStats), EngineError> {
    let (ReadOutput::Rows(rows), stats) = runtime
        .streaming_read_impl(
            COLLECTION,
            ReadRequest::Query {
                input,
                populate: None,
            },
            proven,
        )
        .unwrap()?
    else {
        panic!("rows")
    };
    Ok((rows, stats))
}

fn has_validation(runtime: &NativeRuntime, path: &std::path::Path) -> bool {
    let mut state = runtime.lock_open().unwrap();
    let host = Arc::clone(&state.host);
    let path = path.to_str().unwrap();
    let generation = proseql_storage::generation::SourceGeneration::observe(host.as_ref(), path)
        .unwrap()
        .unwrap();
    state
        .sources
        .as_mut()
        .unwrap()
        .lazy
        .get_mut(COLLECTION)
        .unwrap()
        .stream
        .index
        .checked_validation(host.as_ref(), path, &generation)
        .unwrap()
}

#[test]
fn streaming_validated_torn_final_line_keeps_ordinary_rows_and_stats() {
    for saved in [false, true] {
        for tail in [
            r#"{"id":"tail",}"#,
            r#"{"id":"tail","ignored":1e999}"#,
            r#"{"id":"tail","ignored":"\ud800"}"#,
        ] {
            let fixture = ParityFixture::new(720);
            let path = fixture.partition_path("2025-03");
            write!(
                fs::OpenOptions::new().append(true).open(&path).unwrap(),
                "{tail}"
            )
            .unwrap();
            let mut runtime = fixture.open(RuntimeKind::Lazy);
            let ordinary = rows(&runtime, false).unwrap();
            assert_eq!(ordinary.0.len(), 360);
            // The scan caller must not certify ignored tail bytes. Reading the
            // same generation again must not create such a certificate either.
            assert!(!has_validation(&runtime, &path));
            assert_eq!(rows(&runtime, true).unwrap(), ordinary);
            assert!(!has_validation(&runtime, &path));
            // Existing round-4 locator certificates can cover an ignored tail.
            // Even with that in-memory or saved proof, the tail is not a row.
            runtime.find_by_id(COLLECTION, "absent").unwrap();
            assert!(has_validation(&runtime, &path));
            if saved {
                runtime.close().unwrap();
                runtime = fixture.open(RuntimeKind::Lazy);
            }
            assert_eq!(
                rows(&runtime, true).unwrap(),
                ordinary,
                "saved={saved} tail={tail}"
            );
            assert_eq!(rows(&runtime, false).unwrap(), ordinary);
        }
    }
}

#[test]
fn streaming_validated_valid_unterminated_row_is_certified_and_keeps_rows_and_stats() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-03");
    let mut tail = super::validated_fixture::sample("2025-03", 31, 721, "steps");
    tail["id"] = json!("tail");
    write!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{tail}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let ordinary = rows(&runtime, false).unwrap();
    assert_eq!(ordinary.0.len(), 361);
    assert!(has_validation(&runtime, &path));
    assert_eq!(rows(&runtime, true).unwrap(), ordinary);
}

/// A real filesystem host with an armed, one-shot edit at the first text
/// range read. The edit happens after metadata/proof lookup, before decoding.
struct TextEdit {
    path: String,
    replacement: String,
    after_read: bool,
}
struct EditingFsHost {
    inner: FsStorageHost,
    edit: Mutex<Option<TextEdit>>,
    index_reads: AtomicUsize,
}
impl EditingFsHost {
    fn new() -> Self {
        Self {
            inner: FsStorageHost::new_polling(std::time::Duration::from_secs(1)).unwrap(),
            edit: Mutex::new(None),
            index_reads: AtomicUsize::new(0),
        }
    }
    fn arm(&self, path: &std::path::Path, replacement: String, after_read: bool) {
        *self.edit.lock().unwrap() = Some(TextEdit {
            path: path.to_str().unwrap().into(),
            replacement,
            after_read,
        });
    }
}
impl StorageHost for EditingFsHost {
    fn supports_indexes(&self) -> bool {
        self.inner.supports_indexes()
    }
    fn read_index(&self, path: &str) -> Option<Vec<u8>> {
        let bytes = self.inner.read_index(path);
        if bytes.is_some() {
            self.index_reads.fetch_add(1, Ordering::Relaxed);
        }
        bytes
    }
    fn write_index_atomic(&self, path: &str, data: &[u8]) {
        self.inner.write_index_atomic(path, data);
    }
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }
    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, EngineError> {
        self.inner.read_bytes(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        let mut edit = self.edit.lock().unwrap();
        let pending = if edit.as_ref().is_some_and(|edit| edit.path == path) {
            edit.take()
        } else {
            None
        };
        drop(edit);
        match pending {
            Some(edit) if edit.after_read => {
                let bytes = self.inner.read_range(path, offset, len)?;
                fs::write(path, edit.replacement).unwrap();
                Ok(bytes)
            }
            Some(edit) => {
                fs::write(path, edit.replacement).unwrap();
                self.inner.read_range(path, offset, len)
            }
            None => self.inner.read_range(path, offset, len),
        }
    }
    fn stat(&self, path: &str) -> Result<Option<FileStat>, EngineError> {
        self.inner.stat(path)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.inner.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.inner.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.inner.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(path)
    }
    fn list_directory_with_stat(&self, path: &str) -> Result<Vec<(String, FileStat)>, EngineError> {
        self.inner.list_directory_with_stat(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch(path, callback)
    }
    fn watch_dir(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch_dir(path, callback)
    }
}
impl DurableStorageHost for EditingFsHost {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.replace_durable(path, data)
    }
    fn append_durable(&self, path: &str, keep: u64, data: &str) -> Result<(), EngineError> {
        self.inner.append_durable(path, keep, data)
    }
}

#[test]
fn streaming_validated_edit_after_proof_replays_ordinary_errors_rows_and_stats() {
    for invalid in [true, false] {
        let fixture = ParityFixture::new(720);
        let host = Arc::new(EditingFsHost::new());
        let runtime = NativeRuntime::open_sources_with_host(
            fixture.config(),
            host.clone(),
            fixture.options(RuntimeKind::Lazy),
        )
        .unwrap();
        let initial = rows(&runtime, false).unwrap();
        let path = fixture.partition_path("2025-01");
        let text = fs::read_to_string(&path).unwrap();
        let replacement = if invalid {
            text.replacen("\"watch\"", "false  ", 1)
        } else {
            text.replacen("steps:", "other:", 1)
        };
        assert_ne!(replacement, text);
        assert_eq!(replacement.len(), text.len());
        // Invalid bytes arrive before decoding. The valid edit happens after
        // the host captured old bytes, so success must discard provisional rows.
        host.arm(&path, replacement, !invalid);
        let proven = rows(&runtime, true);
        assert!(host.edit.lock().unwrap().is_none());
        let ordinary = rows(&runtime, false);
        if invalid {
            assert_eq!(ordinary.as_ref().unwrap_err().tag(), "ValidationError");
            let encoded = serde_json::to_value(ordinary.as_ref().unwrap_err()).unwrap();
            assert!(encoded.to_string().contains("source"));
        } else {
            assert_ne!(ordinary.as_ref().unwrap().0, initial.0);
        }
        assert_eq!(proven, ordinary, "invalid={invalid}");
    }
}

fn january_boundary_query() -> QueryInput {
    QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-01-31T00:00:00.000Z","$lt":"2025-02-02T00:00:00.000Z"}}),
        ),
        select: Some(json!(["id", "value"])),
        ..Default::default()
    }
}

fn discarded_time_index_case(proven: bool, duplicate: bool) {
    let fixture = ParityFixture::new(720);
    let host = Arc::new(EditingFsHost::new());
    let runtime = NativeRuntime::open_sources_with_host(
        fixture.config(),
        host.clone(),
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    // Establish validation records without creating a time index.
    rows(&runtime, false).unwrap();
    assert_eq!(index_counts(&runtime), (0, 0, 3));
    let january = fixture.partition_path("2025-01");
    let original = fs::read_to_string(&january).unwrap();
    let mut records = original
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["id"] = if duplicate {
        records[0]["id"].clone()
    } else {
        json!("other:2025-01-01T12:00:00.000Z")
    };
    let changed = records
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    assert_eq!(changed.len(), original.len());
    fs::write(january, changed).unwrap();
    let february = fixture.partition_path("2025-02");
    let text = fs::read_to_string(&february).unwrap();
    host.arm(&february, text.replacen("steps:", "other:", 1), true);
    let input = january_boundary_query();
    let before = index_snapshot(&runtime);
    let first = query_rows(&runtime, &input, proven);
    assert!(host.edit.lock().unwrap().is_none());
    let fresh = fixture.open(RuntimeKind::Lazy);
    let ordinary = query_rows(&fresh, &input, false);
    if duplicate {
        let error = ordinary.as_ref().unwrap_err();
        assert_eq!(error.tag(), "SourceConfigError");
        assert!(serde_json::to_string(error)
            .unwrap()
            .contains("Partition records need unique string IDs"));
    } else {
        assert_eq!(ordinary.as_ref().unwrap().0.len(), 8);
        assert_eq!(ordinary.as_ref().unwrap().1.candidate_rows, 236);
    }
    if proven {
        assert_eq!(first, ordinary, "duplicate={duplicate}");
        if duplicate {
            assert_eq!(index_snapshot(&runtime), before);
        }
    } else {
        assert_eq!(index_snapshot(&runtime), before);
        assert!(
            matches!(first, Err(EngineError::Operation(ref error)) if error.reason == "source-changed")
        );
        // A failed ordinary request must not leave an index that changes the
        // next ordinary request's error or physical candidate statistics.
        assert_eq!(
            query_rows(&runtime, &input, false),
            ordinary,
            "duplicate={duplicate}"
        );
    }
}

#[test]
fn streaming_validated_retry_discards_time_indexes_until_duplicate_checks_succeed() {
    for duplicate in [true, false] {
        discarded_time_index_case(true, duplicate);
    }
}

#[test]
fn streaming_validated_ordinary_failure_discards_time_indexes_until_duplicate_checks_succeed() {
    for duplicate in [true, false] {
        discarded_time_index_case(false, duplicate);
    }
}

fn index_snapshot(runtime: &NativeRuntime) -> Vec<u8> {
    let state = runtime.lock_open().unwrap();
    crate::locate::read_indexes::snapshot(
        &state.sources.as_ref().unwrap().lazy[COLLECTION]
            .stream
            .index,
    )
}

fn index_counts(runtime: &NativeRuntime) -> (usize, usize, usize) {
    let state = runtime.lock_open().unwrap();
    crate::locate::read_indexes::counts(
        &state.sources.as_ref().unwrap().lazy[COLLECTION]
            .stream
            .index,
    )
}

fn finish_error(runtime: &NativeRuntime) -> EngineError {
    let mut input = january_boundary_query();
    input.sort = vec![("metric".into(), proseql_engine::query::SortOrder::Asc)];
    let cursor = CursorConfig {
        key: "atUtc".into(),
        after: None,
        before: None,
        limit: 2,
    };
    let error = runtime
        .streaming_read_impl(
            COLLECTION,
            ReadRequest::Cursor {
                input: &input,
                cursor: &cursor,
                populate: None,
            },
            true,
        )
        .unwrap()
        .err()
        .expect("invalid cursor must fail in Executor::finish");
    assert!(serde_json::to_string(&error)
        .unwrap()
        .contains("cursor.key"));
    error
}

#[test]
fn streaming_validated_failed_finish_keeps_indexes_and_validation_byte_identical() {
    for refresh in [false, true] {
        let fixture = ParityFixture::new(720);
        let runtime = fixture.open(RuntimeKind::Lazy);
        if refresh {
            query_rows(&runtime, &january_boundary_query(), false).unwrap();
            let path = fixture.partition_path("2025-01");
            let text = fs::read_to_string(&path).unwrap();
            fs::write(path, text.replacen("steps:", "other:", 1)).unwrap();
        }
        let before = index_snapshot(&runtime);
        assert_eq!(finish_error(&runtime).tag(), "ValidationError");
        assert_eq!(index_snapshot(&runtime), before, "refresh={refresh}");
    }
}

#[test]
fn streaming_validated_failed_sidecar_load_request_keeps_store_prefix_cache_byte_identical() {
    let fixture = ParityFixture::new(720);
    let prime = fixture.open(RuntimeKind::Lazy);
    query_rows(&prime, &january_boundary_query(), false).unwrap();
    prime.close().unwrap();
    assert!(fs::read_dir(fixture.root().join(".proseql-index"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_str()
            .unwrap()
            .contains(".time-")));
    let host = Arc::new(EditingFsHost::new());
    let runtime = NativeRuntime::open_sources_with_host(
        fixture.config(),
        host.clone(),
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    let before = index_snapshot(&runtime);
    assert_eq!(finish_error(&runtime).tag(), "ValidationError");
    assert!(
        host.index_reads.load(Ordering::Relaxed) >= 2,
        "the failed request must load the saved time sidecars"
    );
    assert_eq!(index_snapshot(&runtime), before);
    assert_eq!(index_counts(&runtime), (0, 0, 0));
}

#[test]
fn streaming_validated_success_commits_time_indexes_and_validation_together() {
    let fixture = ParityFixture::new(720);
    let runtime = fixture.open(RuntimeKind::Lazy);
    assert_eq!(index_counts(&runtime), (0, 0, 0));
    let input = january_boundary_query();
    let first = query_rows(&runtime, &input, true).unwrap();
    assert_eq!(first.0.len(), 8);
    assert_eq!(first.1.candidate_rows, 236);
    assert_eq!(index_counts(&runtime), (2, 2, 2));
    let committed = index_snapshot(&runtime);
    let warm = query_rows(&runtime, &input, true).unwrap();
    assert_eq!(warm.0, first.0);
    assert!(warm.1.candidate_rows < first.1.candidate_rows);
    assert_eq!(
        index_snapshot(&runtime),
        committed,
        "unchanged cache hits must stay borrowed"
    );
}

#[test]
fn streaming_validated_failed_validation_sidecar_request_keeps_records_and_store_byte_identical() {
    use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey};
    let fixture = ParityFixture::new(720);
    let mut duplicate = None;
    for (month, _) in super::validated_fixture::MONTHS {
        let path = fixture.partition_path(month);
        let text = fs::read_to_string(&path).unwrap();
        let mut records = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        for row in &mut records {
            row["source"] = json!(month);
        }
        if month == "2025-01" {
            duplicate = Some(records[0]["id"].clone());
        }
        if month == "2025-02" {
            records[0]["id"] = duplicate.clone().unwrap();
        }
        fs::write(
            path,
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
    }
    let mut config = fixture.config();
    let DatabaseSourceConfig::Partitioned(source) = &mut config.sources[0] else {
        panic!("partitioned")
    };
    source.partition_by = PartitionKey::Field {
        field: "source".into(),
    };
    let prime = NativeRuntime::open_sources_with_options(
        config.clone(),
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    for (month, _) in super::validated_fixture::MONTHS {
        let input = QueryInput {
            r#where: Some(json!({"source": month})),
            select: Some(json!(["id", "value"])),
            ..Default::default()
        };
        query_rows(&prime, &input, false).unwrap();
    }
    prime.close().unwrap();
    let host = Arc::new(EditingFsHost::new());
    let runtime = NativeRuntime::open_sources_with_host(
        config,
        host.clone(),
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    let before = index_snapshot(&runtime);
    assert_eq!(rows(&runtime, true).unwrap_err().tag(), "SourceConfigError");
    assert!(
        host.index_reads.load(Ordering::Relaxed) >= 3,
        "load every file's validation certificate before cross-file duplicate checks"
    );
    assert_eq!(index_snapshot(&runtime), before);
    assert_eq!(index_counts(&runtime), (0, 0, 0));
}

#[test]
fn streaming_validated_failed_finish_discards_torn_diagnostics() {
    let fixture = ParityFixture::new(720);
    write!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-01"))
            .unwrap(),
        "{{\"id\":\"tail\",}}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let diagnostics = || {
        let state = runtime.lock_open().unwrap();
        format!("{:?}", state.sources.as_ref().unwrap().torn)
    };
    let before = diagnostics();
    assert_eq!(finish_error(&runtime).tag(), "ValidationError");
    assert_eq!(diagnostics(), before);
}
