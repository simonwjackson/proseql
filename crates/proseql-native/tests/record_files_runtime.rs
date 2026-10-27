use proseql_engine::descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::{EngineError, OperationError};
use proseql_formats::{FormatCodec, FormatOptions, FormatRegistry};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
    NativeSourceSessions, RecordFilesReload,
};
use proseql_storage::{
    fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost},
    source_config::{DatabaseSourceConfig, RecordFilesSourceConfig},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

fn config(root: &Path) -> NativeSourceRuntimeConfig {
    let mut descriptor = CollectionDescriptor {
        name: "records".into(),
        schema: SchemaNode::Unknown,
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec![],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: false,
        duplicate_ids: Default::default(),
        validation_mode: proseql_engine::descriptor::ValidationMode::Strict,
    };
    descriptor.schema = SchemaNode::Struct {
        fields: vec![StructField {
            name: "text".into(),
            schema: SchemaNode::Str,
        }],
    };
    descriptor.id_strategy = IdStrategy::DerivedFromKey;
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(descriptor)],
        sources: vec![DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
            id: "records".into(),
            collection: "records".into(),
            root: root.to_string_lossy().into_owned(),
            format: "json".into(),
        })],
    }
}
fn options() -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        watch_debounce: None,
        ..Default::default()
    }
}
fn open(root: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(config(root), options()).unwrap()
}
fn write(root: &Path, id: &str, text: &str) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(format!("{id}.json")),
        json!({"text":text}).to_string(),
    )
    .unwrap();
}
fn snapshot(root: &Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
    let mut files: Vec<_> = fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).unwrap(),
                entry.metadata().unwrap().modified().unwrap(),
            )
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
#[test]
fn stem_identity_selective_writes_and_silent_flush() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("records");
    let runtime = open(&root);
    runtime
        .mutate(|db| {
            db.create("records", json!({"id":"a", "text":"one"}))?;
            db.create("records", json!({"id":"b", "text":"two"}))
        })
        .unwrap();
    assert_eq!(snapshot(&root).len(), 2);
    let sibling = root.join("b.json");
    let bytes = fs::read(&sibling).unwrap();
    let modified = fs::metadata(&sibling).unwrap().modified().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"text":"two"})
    );
    let before = snapshot(&root);
    runtime
        .mutate(|db| db.update("records", "b", json!({"text":"two"})))
        .unwrap();
    runtime.flush().unwrap();
    assert_eq!(snapshot(&root), before);
    runtime
        .mutate(|db| db.update("records", "a", json!({"text":"changed"})))
        .unwrap();
    runtime.mutate(|db| db.delete("records", "a")).unwrap();
    runtime.close().unwrap();
    assert!(!root.join("a.json").exists());
    assert_eq!(fs::read(&sibling).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&sibling).unwrap().modified().unwrap(),
        modified
    );
    let before = snapshot(&root);
    let reopened = open(&root);
    assert_eq!(
        reopened.find_by_id("records", "b").unwrap().unwrap()["text"],
        "two"
    );
    reopened.flush().unwrap();
    reopened.close().unwrap();
    assert_eq!(snapshot(&root), before);
}
#[test]
fn ignored_entries_and_matching_bad_stems_and_shapes() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".props.json"), "bad").unwrap();
    fs::write(dir.path().join("other.txt"), "bad").unwrap();
    fs::create_dir(dir.path().join(".cache")).unwrap();
    fs::write(dir.path().join(".cache/a.json"), "bad").unwrap();
    fs::create_dir(dir.path().join("folder.json")).unwrap();
    write(dir.path(), "a", "hello");
    let runtime = open(dir.path());
    assert!(runtime.find_by_id("records", "a").unwrap().is_some());
    runtime.close().unwrap();
    for (name, raw) in [
        ("bad:name.json", "{}"),
        ("a.json", "[]"),
        ("a.json", "null"),
        ("a.json", "1"),
        ("a.json", ""),
        ("a.json", "{"),
        ("a.json", "{}"),
        ("a.json", r#"{"id":"a","text":"physical ID"}"#),
    ] {
        fs::write(dir.path().join(name), raw).unwrap();
        let error = NativeRuntime::open_sources_with_options(config(dir.path()), options())
            .err()
            .unwrap();
        assert!(error.to_string().contains(name), "{error}");
        if name != "a.json" {
            fs::remove_file(dir.path().join(name)).unwrap();
        }
    }
}
#[test]
fn provided_mismatch_and_unsupported_id_strategy_fail() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a", "value");
    let mut cfg = config(dir.path());
    cfg.collections[0].descriptor.id_strategy = IdStrategy::Provided;
    cfg.collections[0].descriptor.schema = SchemaNode::Unknown;
    for raw in [r#"{"text":"no ID"}"#, r#"{"id":"b","text":"mismatch"}"#] {
        fs::write(dir.path().join("a.json"), raw).unwrap();
        let error = NativeRuntime::open_sources_with_options(cfg.clone(), options())
            .err()
            .unwrap();
        assert!(error.to_string().contains("a.json"));
    }
    fs::write(dir.path().join("a.json"), r#"{"id":"a","text":"same"}"#).unwrap();
    NativeRuntime::open_sources_with_options(cfg.clone(), options())
        .unwrap()
        .close()
        .unwrap();
    cfg.collections[0].descriptor.id_strategy = IdStrategy::NamedGenerator {
        name: "custom".into(),
    };
    assert!(NativeRuntime::open_sources_with_options(cfg, options()).is_err());
}
#[test]
fn invalid_and_duplicate_ids_and_multi_file_preflight_leave_disk_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("missing");
    let runtime = open(&root);
    for id in ["a:b", "a/b", ".hidden", "a\\b"] {
        assert!(runtime
            .mutate(|db| db.create("records", json!({"id":id,"text":"invalid"})))
            .is_err());
        assert!(!root.exists());
    }
    runtime
        .mutate(|db| db.create("records", json!({"id":"a","text":"first"})))
        .unwrap();
    let before = snapshot(&root);
    assert!(matches!(
        runtime
            .mutate(|db| db.create("records", json!({"id":"a","text":"duplicate"})))
            .unwrap_err(),
        EngineError::DuplicateKey(_)
    ));
    assert!(runtime
        .mutate(|db| {
            db.create("records", json!({"id":"b","text":"valid"}))?;
            db.create("records", json!({"id":"z:bad","text":"invalid"}))
        })
        .is_err());
    assert_eq!(snapshot(&root), before);
    assert!(runtime.find_by_id("records", "b").unwrap().is_none());
}
struct CheckedCodec {
    encode_error: bool,
}
impl FormatCodec for CheckedCodec {
    fn name(&self) -> &str {
        "checked"
    }
    fn extensions(&self) -> &[&str] {
        &["json"]
    }
    fn encode(&self, value: &Value, _: Option<FormatOptions>) -> Result<String, String> {
        if value["text"] == "refuse" {
            if self.encode_error {
                return Err("injected codec error".into());
            }
            return Ok(json!({"text":"different"}).to_string());
        }
        Ok(value.to_string())
    }
    fn decode(&self, raw: &str) -> Result<Value, String> {
        serde_json::from_str(raw).map_err(|e| e.to_string())
    }
    fn round_trips_exactly(&self) -> bool {
        true
    }
}
#[test]
fn all_codec_and_write_checks_finish_before_first_replace_or_remove() {
    for encode_error in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "first");
        write(dir.path(), "b", "second");
        let mut formats = FormatRegistry::with_builtins();
        formats.register(Box::new(CheckedCodec { encode_error }));
        let runtime = NativeRuntime::open_sources_with_options(
            config(dir.path()),
            NativeSourceRuntimeOptions {
                formats,
                ..options()
            },
        )
        .unwrap();
        let before = snapshot(dir.path());
        assert!(runtime
            .mutate(|db| {
                db.delete("records", "a")?;
                db.update("records", "b", json!({"text":"refuse"}))
            })
            .is_err());
        assert_eq!(snapshot(dir.path()), before);
        assert!(runtime.find_by_id("records", "a").unwrap().is_some());
    }
}
#[test]
fn external_generations_conflict_before_any_replace_or_remove() {
    for remove in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "first");
        write(dir.path(), "b", "second");
        let runtime = open(dir.path());
        // Same parsed value, different generation, must still conflict.
        fs::write(dir.path().join("b.json"), "{ \"text\": \"second\" }\n").unwrap();
        let before = snapshot(dir.path());
        let error = runtime
            .mutate(|db| {
                db.update("records", "a", json!({"text":"not written"}))?;
                if remove {
                    db.delete("records", "b").map(|_| ())
                } else {
                    db.update("records", "b", json!({"text":"not written"}))
                        .map(|_| ())
                }
            })
            .unwrap_err();
        assert!(error.to_string().contains("changed since load"), "{error}");
        assert_eq!(snapshot(dir.path()), before);
        runtime.reload().unwrap();
        runtime
            .mutate(|db| db.update("records", "a", json!({"text":"allowed"})))
            .unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    write(dir.path(), "a", "external");
    assert!(runtime
        .mutate(|db| db.create("records", json!({"id":"a","text":"new"})))
        .is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("a.json")).unwrap(),
        json!({"text":"external"}).to_string()
    );
}
#[test]
fn explicit_reload_diff_is_generation_based_reentrant_and_keeps_bad_bytes_out() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a", "first");
    let runtime_slot: Arc<Mutex<Option<NativeRuntime>>> = Arc::new(Mutex::new(None));
    let slot = runtime_slot.clone();
    let diffs = Arc::new(Mutex::new(Vec::new()));
    let received = diffs.clone();
    let runtime = NativeRuntime::open_sources_with_options(
        config(dir.path()),
        NativeSourceRuntimeOptions {
            on_record_files_reload: Some(Arc::new(move |diff| {
                let runtime = slot.lock().unwrap().clone().unwrap();
                assert!(runtime.find_by_id("records", "a").unwrap().is_some());
                runtime
                    .mutate(|db| db.update("records", "a", json!({"text":"callback mutation"})))
                    .unwrap();
                received.lock().unwrap().push(diff);
            })),
            ..options()
        },
    )
    .unwrap();
    *runtime_slot.lock().unwrap() = Some(runtime.clone());
    runtime.reload().unwrap();
    assert!(diffs.lock().unwrap().is_empty());
    write(dir.path(), "b", "added");
    fs::write(dir.path().join("a.json"), "{ \"text\": \"first\" }\n").unwrap();
    runtime.reload().unwrap();
    assert_eq!(
        *diffs.lock().unwrap(),
        vec![RecordFilesReload {
            source_id: "records".into(),
            collection: "records".into(),
            added: vec!["b".into()],
            changed: vec!["a".into()],
            removed: vec![]
        }]
    );
    assert_eq!(
        runtime.find_by_id("records", "a").unwrap().unwrap()["text"],
        "callback mutation"
    );
    runtime.reload().unwrap();
    assert_eq!(diffs.lock().unwrap().len(), 1);
    fs::remove_file(dir.path().join("b.json")).unwrap();
    fs::write(dir.path().join("a.json"), "bad").unwrap();
    assert!(runtime.reload().is_err());
    assert!(runtime.find_by_id("records", "b").unwrap().is_some());
    assert_eq!(diffs.lock().unwrap().len(), 1);
    write(dir.path(), "a", "recovered");
    runtime.reload().unwrap();
    assert_eq!(diffs.lock().unwrap()[1].removed, vec!["b"]);
    assert_eq!(diffs.lock().unwrap()[1].changed, vec!["a"]);
    // Break the test-owned Arc cycle.
    *runtime_slot.lock().unwrap() = None;
}
#[test]
fn managed_reload_discovers_missing_root_add_edit_remove_and_no_self_echo() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("missing");
    let (send, receive) = std::sync::mpsc::channel();
    let runtime = NativeRuntime::open_sources_with_host(
        config(&root),
        Arc::new(FsStorageHost::new_polling(Duration::from_millis(10)).unwrap()),
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(10)),
            on_record_files_reload: Some(Arc::new(move |diff| send.send(diff).unwrap())),
            ..Default::default()
        },
    )
    .unwrap();
    write(&root, "a", "external");
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(3)).unwrap().added,
        vec!["a"]
    );
    write(&root, "a", "edited");
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .changed,
        vec!["a"]
    );
    fs::write(root.join("a.json"), "bad").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while runtime.last_reload_error().unwrap().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(runtime.last_reload_error().unwrap().is_some());
    assert_eq!(
        runtime.find_by_id("records", "a").unwrap().unwrap()["text"],
        "edited"
    );
    assert!(receive.try_recv().is_err());
    write(&root, "a", "recovered");
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .changed,
        vec!["a"]
    );
    runtime
        .mutate(|db| db.update("records", "a", json!({"text":"self"})))
        .unwrap();
    assert!(receive.recv_timeout(Duration::from_millis(200)).is_err());
    fs::remove_file(root.join("a.json")).unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .removed,
        vec!["a"]
    );
    runtime.close().unwrap();
}
struct FailAt {
    point: DurabilityFaultPoint,
    occurrence: usize,
    seen: AtomicUsize,
}
impl DurabilityFaultInjector for FailAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.point && self.seen.fetch_add(1, Ordering::SeqCst) == self.occurrence {
            return Err(EngineError::Operation(OperationError {
                operation: "durability-test".into(),
                reason: "injected".into(),
                message: "injected durability failure".into(),
            }));
        }
        Ok(())
    }
}
#[test]
fn prefix_commit_quarantine_and_removal_fault_boundaries() {
    for (point, occurrence, a_exists, b_exists) in [
        (DurabilityFaultPoint::AtomicReplace, 1, true, false),
        (DurabilityFaultPoint::RemoveUnlink, 0, true, true),
        (DurabilityFaultPoint::RemoveDirectorySync, 0, false, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let removing = matches!(
            point,
            DurabilityFaultPoint::RemoveUnlink | DurabilityFaultPoint::RemoveDirectorySync
        );
        if removing {
            write(dir.path(), "a", "first");
            write(dir.path(), "b", "second");
        }
        let host = Arc::new(
            FsStorageHost::new_polling_with_fault_injector(
                Duration::from_secs(2),
                Arc::new(FailAt {
                    point,
                    occurrence,
                    seen: AtomicUsize::new(0),
                }),
            )
            .unwrap(),
        );
        let runtime =
            NativeRuntime::open_sources_with_host(config(dir.path()), host, options()).unwrap();
        let result = runtime.mutate(|db| {
            if removing {
                db.delete("records", "a")?;
                db.delete("records", "b").map(|_| ())
            } else {
                db.create("records", json!({"id":"a","text":"one"}))?;
                db.create("records", json!({"id":"b","text":"two"}))
                    .map(|_| ())
            }
        });
        assert!(result.unwrap_err().to_string().contains("completed paths"));
        assert!(runtime.find_by_id("records", "a").is_err());
        assert!(runtime.flush().is_err());
        runtime.close().unwrap();
        let reopened = open(dir.path());
        assert_eq!(
            reopened.find_by_id("records", "a").unwrap().is_some(),
            a_exists
        );
        assert_eq!(
            reopened.find_by_id("records", "b").unwrap().is_some(),
            b_exists
        );
    }
}
#[test]
fn source_sessions_reopen_without_permanent_rows_and_keep_callback_service() {
    let dir = tempfile::tempdir().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let sessions = NativeSourceSessions::new(
        config(dir.path()),
        NativeSourceRuntimeOptions {
            on_record_files_reload: Some(Arc::new(move |diff| send.send(diff).unwrap())),
            ..options()
        },
    )
    .unwrap();
    sessions
        .with_session(|runtime| {
            runtime.mutate(|db| db.create("records", json!({"id":"a","text":"first"})))
        })
        .unwrap();
    write(dir.path(), "a", "outside");
    sessions
        .with_session(|runtime| {
            assert_eq!(
                runtime.find_by_id("records", "a")?.unwrap()["text"],
                "outside"
            );
            write(dir.path(), "b", "added");
            runtime.reload()
        })
        .unwrap();
    assert_eq!(receive.recv().unwrap().added, vec!["b"]);
}
#[test]
fn empty_overlapping_owners_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    let mut other = cfg.collections[0].clone();
    other.descriptor.name = "other".into();
    cfg.collections.push(other);
    cfg.sources
        .push(DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
            id: "other".into(),
            collection: "other".into(),
            root: dir.path().to_string_lossy().into_owned(),
            format: "json".into(),
        }));
    assert!(NativeRuntime::open_sources_with_options(cfg, options()).is_err());
}

#[test]
#[ignore = "subprocess-only relative working-directory test"]
fn relative_missing_root_watch_child() {
    let root = std::path::PathBuf::from(std::env::var("RECORD_FILES_RELATIVE_ROOT").unwrap());
    let (send, receive) = std::sync::mpsc::channel();
    let runtime = NativeRuntime::open_sources_with_host(
        config(&root),
        Arc::new(FsStorageHost::new_polling(Duration::from_millis(10)).unwrap()),
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(10)),
            on_record_files_reload: Some(Arc::new(move |diff| send.send(diff).unwrap())),
            ..Default::default()
        },
    )
    .unwrap();
    write(&root, "a", "relative external");
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(3)).unwrap().added,
        vec!["a"]
    );
    assert_eq!(
        runtime.find_by_id("records", "a").unwrap().unwrap()["text"],
        "relative external"
    );
    runtime
        .mutate(|db| db.create("records", json!({"id":"b", "text":"relative create"})))
        .unwrap();
    assert!(root.join("b.json").exists());
    runtime.close().unwrap();
}
#[test]
fn managed_watch_finds_missing_relative_and_nested_relative_roots() {
    for root in ["contacts", "nested/contacts", "."] {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "relative_missing_root_watch_child",
                "--ignored",
                "--nocapture",
            ])
            .current_dir(dir.path())
            .env("RECORD_FILES_RELATIVE_ROOT", root)
            .status()
            .unwrap();
        assert!(status.success(), "failed for {root}");
    }
}

#[test]
fn empty_record_roots_cannot_overlap_any_existing_source_kind() {
    use proseql_storage::source_config::{
        CollectionFileSourceConfig, DocumentGraphFragmentErrorPolicy, DocumentGraphRootConfig,
        DocumentGraphSourceConfig, DocumentSourceConfig, PartitionKey, PartitionedSourceConfig,
        SourceCollectionSelection, UnknownCollectionPolicy,
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let sources = vec![
        DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
            id: "other".into(),
            collection: "other".into(),
            path: dir.path().join("a.json").to_string_lossy().into_owned(),
            format: Some("json".into()),
            prose: None,
        }),
        DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "other".into(),
            collection: "other".into(),
            root: root.clone(),
            format: "json".into(),
            partition_by: PartitionKey::Field {
                field: "text".into(),
            },
            prose: None,
        }),
        DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "other".into(),
            root: root.clone(),
            include: Some(vec!["**/*.json".into()]),
            exclude: vec![],
            format: Some("json".into()),
            collections: Some(SourceCollectionSelection::Named(vec!["other".into()])),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "generated.json".into(),
            optional: true,
        }),
        DatabaseSourceConfig::DocumentGraph(DocumentGraphSourceConfig {
            id: "other".into(),
            roots: vec![DocumentGraphRootConfig {
                id: None,
                root: root.clone(),
                optional: true,
                include: Some(vec!["**/*.json".into()]),
                exclude: vec![],
                collections: None,
            }],
            collections: Some(SourceCollectionSelection::Named(vec!["other".into()])),
            include: None,
            exclude: vec![],
            transform_callback_id: None,
            on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
        }),
    ];
    for source in sources {
        let mut cfg = config(dir.path());
        let mut other = cfg.collections[0].clone();
        other.descriptor.name = "other".into();
        cfg.collections.push(other);
        cfg.sources.push(source);
        let error = NativeRuntime::open_sources_with_options(cfg, options())
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("overlaps another source"),
            "{error}"
        );
    }
}

#[test]
fn record_files_use_the_shared_schema_encoder_for_transformed_fields() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.json"), r#"{"number":"12"}"#).unwrap();
    let mut cfg = config(dir.path());
    cfg.collections[0].descriptor.schema = SchemaNode::Struct {
        fields: vec![StructField {
            name: "number".into(),
            schema: SchemaNode::NumFromStr,
        }],
    };
    let runtime = NativeRuntime::open_sources_with_options(cfg.clone(), options()).unwrap();
    assert_eq!(
        runtime.find_by_id("records", "a").unwrap().unwrap()["number"],
        12
    );
    runtime
        .mutate(|db| db.update("records", "a", json!({"number":"13"})))
        .unwrap();
    let physical: Value =
        serde_json::from_slice(&fs::read(dir.path().join("a.json")).unwrap()).unwrap();
    assert_eq!(physical, json!({"number":"13"}));
    runtime.close().unwrap();
    let reopened = NativeRuntime::open_sources_with_options(cfg, options()).unwrap();
    assert_eq!(
        reopened.find_by_id("records", "a").unwrap().unwrap()["number"],
        13
    );
}

#[test]
fn compound_record_extensions_are_rejected_before_writes() {
    for format in ["card.json", ".card.json", "json.", "..json"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("missing");
        let mut cfg = config(&root);
        if let DatabaseSourceConfig::RecordFiles(source) = &mut cfg.sources[0] {
            source.format = format.into();
        }
        let error = NativeRuntime::open_sources_with_options(cfg, options())
            .err()
            .expect("compound format must fail at open");
        assert!(
            error.to_string().contains("compound extensions"),
            "{format}: {error}"
        );
        assert!(!root.exists(), "format rejection must not create the root");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[test]
fn a_single_leading_dot_and_extension_case_normalize_without_changing_stem_ids() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    if let DatabaseSourceConfig::RecordFiles(source) = &mut cfg.sources[0] {
        source.format = ".JSON".into();
    }
    let runtime = NativeRuntime::open_sources_with_options(cfg, options()).unwrap();
    runtime
        .mutate(|db| db.create("records", json!({"id":"alice", "text":"first"})))
        .unwrap();
    runtime.reload().unwrap();
    assert!(runtime.find_by_id("records", "alice").unwrap().is_some());
    runtime
        .mutate(|db| db.update("records", "alice", json!({"text":"second"})))
        .unwrap();
    assert_eq!(
        snapshot(dir.path())
            .into_iter()
            .map(|entry| entry.0)
            .collect::<Vec<_>>(),
        vec!["alice.json"]
    );
}

fn bounded_watch_child(name: &str, root: &str) {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--ignored", "--nocapture"])
        .env("PROSEQL_MEMORY_WATCH_ROOT", root)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{name} failed for {root}");
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("{name} did not terminate for {root} within 5 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "bounded subprocess-only memory watcher check"]
fn memory_missing_root_watch_child() {
    use proseql_storage::{host::StorageHost, memory::MemoryStorageHost};
    let root = std::env::var("PROSEQL_MEMORY_WATCH_ROOT").unwrap();
    let host = Arc::new(MemoryStorageHost::default());
    let (send, receive) = std::sync::mpsc::channel();
    let runtime = NativeRuntime::open_sources_with_host(
        config(Path::new(&root)),
        host.clone(),
        NativeSourceRuntimeOptions {
            on_record_files_reload: Some(Arc::new(move |diff| send.send(diff).unwrap())),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(runtime.find_by_id("records", "alice").unwrap().is_none());
    let path = proseql_storage::path::join_path(&root, "alice.json");
    host.write(&path, r#"{"text":"added"}"#).unwrap();
    let added = receive.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        added,
        RecordFilesReload {
            source_id: "records".into(),
            collection: "records".into(),
            added: vec!["alice".into()],
            changed: vec![],
            removed: vec![]
        }
    );
    assert_eq!(
        runtime.find_by_id("records", "alice").unwrap().unwrap()["text"],
        "added"
    );
    host.write(&path, r#"{"text":"edited"}"#).unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .changed,
        vec!["alice"]
    );
    assert_eq!(
        runtime.find_by_id("records", "alice").unwrap().unwrap()["text"],
        "edited"
    );
    host.remove(&path).unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .removed,
        vec!["alice"]
    );
    assert!(runtime.find_by_id("records", "alice").unwrap().is_none());
    runtime.close().unwrap();
}

#[test]
fn memory_missing_relative_and_nested_roots_receive_managed_changes() {
    for root in ["missing", "nested/missing", ".", "/missing"] {
        bounded_watch_child("memory_missing_root_watch_child", root);
    }
}

struct UnavailableAncestors(proseql_storage::memory::MemoryStorageHost);
impl proseql_storage::host::StorageHost for UnavailableAncestors {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.0.read(path)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.0.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.0.append(path, data)
    }
    fn exists(&self, _path: &str) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.0.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.0.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.0.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.0.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        callback: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, EngineError> {
        self.0.watch(path, callback)
    }
    fn watch_dir(
        &self,
        path: &str,
        callback: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, EngineError> {
        self.0.watch_dir(path, callback)
    }
}
impl proseql_storage::persistence::DurableStorageHost for UnavailableAncestors {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        proseql_storage::persistence::DurableStorageHost::replace_durable(&self.0, path, data)
    }
}
#[test]
#[ignore = "bounded subprocess-only unavailable-ancestor check"]
fn unavailable_watch_ancestor_child() {
    let host = Arc::new(UnavailableAncestors(
        proseql_storage::memory::MemoryStorageHost::default(),
    ));
    let error = NativeRuntime::open_sources_with_host(
        config(Path::new("missing")),
        host,
        NativeSourceRuntimeOptions::default(),
    )
    .err()
    .expect("unavailable ancestors must fail without looping");
    assert!(
        matches!(&error, EngineError::Operation(operation) if operation.reason == "watch-root")
    );
    assert!(
        error.to_string().contains("No existing source ancestor"),
        "{error}"
    );
}
#[test]
fn unavailable_watch_ancestors_terminate_with_an_error() {
    bounded_watch_child("unavailable_watch_ancestor_child", "missing");
}
