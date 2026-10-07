use std::fs;
use std::path::Path;

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::query::pipeline::query_input;
use proseql_formats::prose::{ProseCodecOptions, UnmatchedLines};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig};
use serde_json::json;

fn config(root: &Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "turns".into(),
            schema: SchemaNode::Struct {
                fields: ["id", "speaker", "text"]
                    .iter()
                    .map(|name| StructField {
                        name: (*name).into(),
                        schema: SchemaNode::Str,
                    })
                    .collect(),
            },
            id_strategy: IdStrategy::Provided,
            relationships: vec![],
            indexes: vec![],
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
            validation_mode: ValidationMode::Strict,
        })],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "turns".into(),
            collection: "turns".into(),
            root: root.join("turns").to_string_lossy().into_owned(),
            format: "prose".into(),
            partition_by: PartitionKey::Prefix {
                field: "id".into(),
                delimiter: ".".into(),
            },
            prose: Some(ProseCodecOptions {
                template: Some("[{id}] {speaker}: {text}".into()),
                overflow: vec![],
                unmatched_lines: UnmatchedLines::Error,
            }),
        })],
    }
}

fn open(root: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(
        config(root),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
    .unwrap()
}

#[test]
fn creates_partition_files_and_queries_them_as_one_collection_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"meeting-a.0001", "speaker":"SJ", "text":"35143"}),
            )?;
            db.create(
                "turns",
                json!({"id":"meeting-b.0001", "speaker":"DF", "text":"Second meeting"}),
            )
        })
        .unwrap();
    runtime.close().unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("turns/meeting-a.prose")).unwrap(),
        "@prose [{id}] {speaker}: {text}\n\n[meeting-a.0001] SJ: \"35143\""
    );
    assert!(fs::read_to_string(dir.path().join("turns/meeting-b.prose"))
        .unwrap()
        .contains("[meeting-b.0001] DF: Second meeting"));
    let runtime = open(dir.path());
    let records = runtime
        .read(|db| db.query("turns", query_input(None, vec![], None, None, None), None))
        .unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(
        runtime
            .find_by_id("turns", "meeting-a.0001")
            .unwrap()
            .unwrap()["text"],
        "35143"
    );
}

#[test]
fn updates_and_deletes_only_rewrite_the_changed_partition() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )?;
            db.create(
                "turns",
                json!({"id":"b.0001", "speaker":"DF", "text":"Two"}),
            )
        })
        .unwrap();
    let untouched = dir.path().join("turns/b.prose");
    let bytes = fs::read(&untouched).unwrap();
    let modified = fs::metadata(&untouched).unwrap().modified().unwrap();
    runtime
        .mutate(|db| db.update("turns", "a.0001", json!({"text":"Changed"})))
        .unwrap();
    assert!(fs::read_to_string(dir.path().join("turns/a.prose"))
        .unwrap()
        .contains("Changed"));
    runtime.mutate(|db| db.delete("turns", "a.0001")).unwrap();
    runtime.close().unwrap();
    assert_eq!(fs::read(&untouched).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&untouched).unwrap().modified().unwrap(),
        modified
    );
    let runtime = open(dir.path());
    assert!(runtime.find_by_id("turns", "a.0001").unwrap().is_none());
    assert!(runtime.find_by_id("turns", "b.0001").unwrap().is_some());
}

#[test]
fn malformed_reload_retains_the_last_valid_collection() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )
        })
        .unwrap();
    fs::write(
        dir.path().join("turns/a.prose"),
        "@prose [{id}] {speaker}: {text}\n\nbroken line",
    )
    .unwrap();
    assert!(runtime.reload().is_err());
    assert!(runtime.last_reload_error().unwrap().is_some());
    assert!(runtime.find_by_id("turns", "a.0001").unwrap().is_some());
}

#[test]
fn duplicate_ids_in_a_partition_fail_open_instead_of_losing_a_turn() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("turns")).unwrap();
    fs::write(
        dir.path().join("turns/a.prose"),
        "@prose [{id}] {speaker}: {text}\n\n[a.0001] SJ: One\n[a.0001] SJ: Two",
    )
    .unwrap();
    let result = NativeRuntime::open_sources_with_options(
        config(dir.path()),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    );
    assert!(result.is_err(), "duplicate records must not be collapsed");
}

#[test]
fn unsafe_keys_and_missing_delimiters_roll_back_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    for id in [
        "../escape.0001",
        "a/b.0001",
        "a\\b.0001",
        "missing-delimiter",
        ".0001",
    ] {
        assert!(
            runtime
                .mutate(|db| db.create("turns", json!({"id":id, "speaker":"SJ", "text":"Unsafe"})))
                .is_err(),
            "{id}"
        );
        assert!(runtime.find_by_id("turns", id).unwrap().is_none());
    }
    assert!(!dir.path().join("turns").exists());
}

#[test]
fn records_in_the_wrong_partition_fail_open() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("turns")).unwrap();
    fs::write(
        dir.path().join("turns/a.prose"),
        "@prose [{id}] {speaker}: {text}\n\n[b.0001] SJ: Misrouted",
    )
    .unwrap();
    let error = NativeRuntime::open_sources_with_options(
        config(dir.path()),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("wrong partition"), "{error}");
}

#[test]
fn moving_a_partition_field_keeps_the_record_id_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    if let DatabaseSourceConfig::Partitioned(source) = &mut cfg.sources[0] {
        source.partition_by = PartitionKey::Field {
            field: "speaker".into(),
        };
    }
    let runtime = NativeRuntime::open_sources_with_options(
        cfg.clone(),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )
        })
        .unwrap();
    runtime
        .mutate(|db| db.update("turns", "a.0001", json!({"speaker":"DF"})))
        .unwrap();
    runtime.close().unwrap();
    assert!(!fs::read_to_string(dir.path().join("turns/SJ.prose"))
        .unwrap()
        .contains("a.0001"));
    assert!(fs::read_to_string(dir.path().join("turns/DF.prose"))
        .unwrap()
        .contains("[a.0001] DF: One"));
    let runtime = NativeRuntime::open_sources_with_options(
        cfg,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        runtime.find_by_id("turns", "a.0001").unwrap().unwrap()["speaker"],
        "DF"
    );
}

#[test]
fn a_new_external_file_cannot_be_overwritten_without_reload() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    fs::create_dir(dir.path().join("turns")).unwrap();
    let path = dir.path().join("turns/a.prose");
    let external = "@prose [{id}] {speaker}: {text}\n\n[a.0002] DF: External";
    fs::write(&path, external).unwrap();
    let error = runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )
        })
        .unwrap_err();
    assert!(error.to_string().contains("changed since load"), "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), external);
    runtime.reload().unwrap();
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )
        })
        .unwrap();
    assert!(runtime.find_by_id("turns", "a.0002").unwrap().is_some());
}

#[test]
fn two_partition_sources_cannot_own_the_same_empty_directory_and_format() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    let mut other = cfg.collections[0].clone();
    other.descriptor.name = "other".into();
    cfg.collections.push(other);
    let mut source = cfg.sources[0].clone();
    if let DatabaseSourceConfig::Partitioned(partition) = &mut source {
        partition.id = "other".into();
        partition.collection = "other".into();
    }
    cfg.sources.push(source);
    assert!(NativeRuntime::open_sources_with_options(
        cfg,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn versioned_array_partitions_are_rejected_before_a_file_can_lose_its_version() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    cfg.collections[0].descriptor.version = Some(1);
    assert!(NativeRuntime::open_sources_with_options(
        cfg,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn sibling_document_roots_do_not_overlap_partition_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    let mut other = cfg.collections[0].clone();
    other.descriptor.name = "other".into();
    cfg.collections.push(other);
    cfg.sources.push(DatabaseSourceConfig::Documents(
        proseql_storage::source_config::DocumentSourceConfig {
            id: "other".into(),
            root: dir.path().join("other").to_string_lossy().into_owned(),
            include: Some(vec!["**/*.prose".into()]),
            exclude: vec![],
            format: Some("yaml".into()),
            collections: Some(
                proseql_storage::source_config::SourceCollectionSelection::Named(vec![
                    "other".into()
                ]),
            ),
            unknown_collections: proseql_storage::source_config::UnknownCollectionPolicy::Error,
            outbox: "generated.prose".into(),
            optional: true,
        },
    ));
    let runtime = NativeRuntime::open_sources_with_options(
        cfg,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )
        })
        .unwrap();
}

struct FailSecondReplace(std::sync::atomic::AtomicUsize);
impl proseql_storage::fs::DurabilityFaultInjector for FailSecondReplace {
    fn check(
        &self,
        point: proseql_storage::fs::DurabilityFaultPoint,
    ) -> Result<(), proseql_engine::errors::EngineError> {
        if point == proseql_storage::fs::DurabilityFaultPoint::AtomicReplace
            && self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
        {
            return Err(proseql_engine::errors::EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "replace".into(),
                    reason: "injected-failure".into(),
                    message: "Second replacement failed".into(),
                },
            ));
        }
        Ok(())
    }
}

#[test]
fn partial_write_failure_quarantines_and_reopen_recovers_each_partition() {
    let dir = tempfile::tempdir().unwrap();
    let host = std::sync::Arc::new(
        proseql_storage::fs::FsStorageHost::new_polling_with_fault_injector(
            std::time::Duration::from_secs(2),
            std::sync::Arc::new(FailSecondReplace(std::sync::atomic::AtomicUsize::new(0))),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    let error = runtime
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"a.0001", "speaker":"SJ", "text":"One"}),
            )?;
            db.create(
                "turns",
                json!({"id":"b.0001", "speaker":"DF", "text":"Two"}),
            )
        })
        .unwrap_err();
    assert!(error.to_string().contains("completed paths"));
    assert!(runtime.find_by_id("turns", "a.0001").is_err());
    assert!(runtime.flush().is_err());
    runtime.close().unwrap();
    let reopened = open(dir.path());
    assert!(reopened.find_by_id("turns", "a.0001").unwrap().is_some());
    assert!(reopened.find_by_id("turns", "b.0001").unwrap().is_none());
    reopened
        .mutate(|db| {
            db.create(
                "turns",
                json!({"id":"b.0001", "speaker":"DF", "text":"Two"}),
            )
        })
        .unwrap();
}

#[test]
fn managed_reload_discovers_a_new_partition_under_an_initially_missing_root() {
    let dir = tempfile::tempdir().unwrap();
    let host = std::sync::Arc::new(
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_millis(10))
            .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        NativeSourceRuntimeOptions::default(),
    )
    .unwrap();
    fs::create_dir(dir.path().join("turns")).unwrap();
    fs::write(
        dir.path().join("turns/a.prose"),
        "@prose [{id}] {speaker}: {text}\n\n[a.0001] SJ: External",
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while runtime.find_by_id("turns", "a.0001").unwrap().is_none()
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        runtime.find_by_id("turns", "a.0001").unwrap().unwrap()["text"],
        "External"
    );
}
