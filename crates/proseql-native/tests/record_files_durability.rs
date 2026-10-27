//! Public-host durability proofs, including a killed writer process.
use proseql_engine::{
    descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, ValidationMode},
    errors::EngineError,
};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::{
    fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost},
    host::{StorageEvent, StorageHost, WatchHandle},
    persistence::DurableStorageHost,
    source_config::{DatabaseSourceConfig, RecordFilesSourceConfig},
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
fn config(root: &std::path::Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "items".into(),
            schema: SchemaNode::Unknown,
            id_strategy: IdStrategy::DerivedFromKey,
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
            validation_mode: ValidationMode::Strict,
        })],
        sources: vec![DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
            id: "items".into(),
            collection: "items".into(),
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
// A real filesystem adapter implementing replacement durability only. Removal
// deliberately uses the trait's safe unsupported defaults.
struct ReplaceOnly(FsStorageHost, Option<std::sync::atomic::AtomicUsize>);
impl StorageHost for ReplaceOnly {
    fn read(&self, p: &str) -> Result<String, EngineError> {
        self.0.read(p)
    }
    fn write(&self, p: &str, d: &str) -> Result<(), EngineError> {
        self.0.write(p, d)
    }
    fn append(&self, p: &str, d: &str) -> Result<(), EngineError> {
        self.0.append(p, d)
    }
    fn exists(&self, p: &str) -> Result<bool, EngineError> {
        self.0.exists(p)
    }
    fn remove(&self, p: &str) -> Result<(), EngineError> {
        self.0.remove(p)
    }
    fn ensure_dir(&self, p: &str) -> Result<(), EngineError> {
        self.0.ensure_dir(p)
    }
    fn list_directory(&self, p: &str) -> Result<Vec<String>, EngineError> {
        if p.ends_with("/lazy")
            && self
                .1
                .as_ref()
                .is_some_and(|count| count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 2)
        {
            return Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "listing".into(),
                    reason: "injected".into(),
                    message: "Third lazy listing refused".into(),
                },
            ));
        }
        self.0.list_directory(p)
    }
    fn list_recursive(&self, p: &str) -> Result<Vec<String>, EngineError> {
        self.0.list_recursive(p)
    }
    fn watch(
        &self,
        p: &str,
        c: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.0.watch(p, c)
    }
    fn watch_dir(
        &self,
        p: &str,
        c: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.0.watch_dir(p, c)
    }
}
impl DurableStorageHost for ReplaceOnly {
    fn replace_durable(&self, p: &str, d: &str) -> Result<(), EngineError> {
        self.0.replace_durable(p, d)
    }
}
#[test]
fn unsupported_removal_refuses_before_earlier_sorted_replacement() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.json"), "{\"text\":\"first\"}").unwrap();
    std::fs::write(dir.path().join("z.json"), "{\"text\":\"last\"}").unwrap();
    let host = Arc::new(ReplaceOnly(
        FsStorageHost::new_polling(Duration::from_secs(2)).unwrap(),
        None,
    ));
    assert!(host
        .remove_durable(dir.path().join("z.json").to_str().unwrap())
        .is_err());
    let runtime =
        NativeRuntime::open_sources_with_host(config(dir.path()), host, options()).unwrap();
    let error = runtime
        .mutate(|db| {
            db.update("items", "a", json!({"text":"not persisted"}))?;
            db.delete("items", "z")
        })
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("does not support durable removal"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.json")).unwrap(),
        "{\"text\":\"first\"}"
    );
    assert!(dir.path().join("z.json").exists());
    assert_eq!(
        runtime.find_by_id("items", "a").unwrap().unwrap()["text"],
        "first"
    );
}
struct Pause {
    ready: std::path::PathBuf,
    point: DurabilityFaultPoint,
}
impl DurabilityFaultInjector for Pause {
    fn check(&self, p: DurabilityFaultPoint) -> Result<(), EngineError> {
        if p == self.point {
            std::fs::write(&self.ready, "ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }
}
#[test]
#[ignore = "subprocess-only process interruption boundary"]
fn record_files_crash_child() {
    let root = std::path::PathBuf::from(std::env::var("RECORD_FILES_CRASH_ROOT").unwrap());
    let mode = std::env::var("RECORD_FILES_CRASH_MODE").unwrap();
    let point = match mode.as_str() {
        "committed" => DurabilityFaultPoint::Cleanup,
        "pending" => DurabilityFaultPoint::DirectorySync,
        "remove" => DurabilityFaultPoint::RemoveDirectorySync,
        _ => panic!("invalid mode"),
    };
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(Pause {
                ready: root.join("ready"),
                point,
            }),
        )
        .unwrap(),
    );
    let runtime =
        NativeRuntime::open_sources_with_host(config(&root.join("records")), host, options())
            .unwrap();
    runtime
        .mutate(|db| {
            if mode == "remove" {
                db.delete("items", "a")?;
                db.delete("items", "b").map(|_| ())
            } else {
                db.create("items", json!({"id":"a","text":"new a"}))?;
                db.create("items", json!({"id":"b","text":"new b"}))
                    .map(|_| ())
            }
        })
        .unwrap();
}
#[test]
fn killed_writer_reopens_committed_prefix_pending_create_and_unlinked_file() {
    for mode in ["committed", "pending", "remove"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("records");
        if mode == "remove" {
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("a.json"), "{}").unwrap();
            std::fs::write(root.join("b.json"), "{}").unwrap();
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "record_files_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("RECORD_FILES_CRASH_ROOT", dir.path())
            .env("RECORD_FILES_CRASH_MODE", mode)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !dir.path().join("ready").exists() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child did not reach {mode}");
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before {mode}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let runtime = NativeRuntime::open_sources_with_options(config(&root), options()).unwrap();
        assert_eq!(
            runtime.find_by_id("items", "a").unwrap().is_some(),
            mode == "committed"
        );
        assert_eq!(
            runtime.find_by_id("items", "b").unwrap().is_some(),
            mode == "remove"
        );
    }
}
#[test]
fn orphan_backup_restores_a_missing_destination_before_discovery() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".a.json.proseql-backup"),
        "{\"text\":\"old\"}",
    )
    .unwrap();
    let runtime = NativeRuntime::open_sources_with_options(config(dir.path()), options()).unwrap();
    assert_eq!(
        runtime.find_by_id("items", "a").unwrap().unwrap()["text"],
        "old"
    );
}

#[test]
fn lazy_refresh_error_does_not_consume_unaccepted_record_reload_diff() {
    use proseql_native::{FullScanPolicy, LazyPartitionPolicy};
    use proseql_storage::source_config::{PartitionKey, PartitionedSourceConfig};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("records");
    let lazy_root = dir.path().join("lazy");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&lazy_root).unwrap();
    std::fs::write(root.join("a.json"), r#"{"text":"old"}"#).unwrap();
    std::fs::write(
        lazy_root.join("one.jsonl"),
        "{\"id\":\"l\",\"group\":\"one\"}\n",
    )
    .unwrap();
    let mut cfg = config(&root);
    let mut descriptor = cfg.collections[0].descriptor.clone();
    descriptor.name = "logs".into();
    descriptor.append_only = true;
    descriptor.id_strategy = IdStrategy::Provided;
    cfg.collections
        .push(NativeCollectionConfig::new(descriptor));
    cfg.sources
        .push(DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "logs".into(),
            collection: "logs".into(),
            root: lazy_root.to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: PartitionKey::Field {
                field: "group".into(),
            },
            prose: None,
        }));
    let (send, receive) = std::sync::mpsc::channel();
    let mut opts = options();
    opts.lazy_partitions.insert(
        "logs".into(),
        LazyPartitionPolicy {
            max_loaded_partitions: 0,
            full_scan: FullScanPolicy::Allow,
        },
    );
    opts.on_record_files_reload = Some(Arc::new(move |diff| send.send(diff).unwrap()));
    let host = Arc::new(ReplaceOnly(
        FsStorageHost::new_polling(Duration::from_secs(2)).unwrap(),
        Some(std::sync::atomic::AtomicUsize::new(0)),
    ));
    let runtime = NativeRuntime::open_sources_with_host(cfg, host, opts).unwrap();
    std::fs::write(root.join("a.json"), r#"{"text":"changed"}"#).unwrap();
    assert!(runtime.reload().is_err());
    assert_eq!(
        runtime.find_by_id("items", "a").unwrap().unwrap()["text"],
        "old"
    );
    assert!(receive.try_recv().is_err());
    runtime.reload().unwrap();
    assert_eq!(receive.recv().unwrap().changed, vec!["a"]);
    assert_eq!(
        runtime.find_by_id("items", "a").unwrap().unwrap()["text"],
        "changed"
    );
}

#[test]
fn first_create_syncs_new_parent_chain_before_replacement() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct ParentSyncs(AtomicUsize);
    impl DurabilityFaultInjector for ParentSyncs {
        fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
            if point == DurabilityFaultPoint::ParentDirectorySync {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
            if point == DurabilityFaultPoint::AtomicReplace {
                assert_eq!(self.0.load(Ordering::SeqCst), 3);
            }
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("one/two");
    let syncs = Arc::new(ParentSyncs(AtomicUsize::new(0)));
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(Duration::from_secs(2), syncs.clone())
            .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(config(&root), host, options()).unwrap();
    runtime
        .mutate(|db| db.create("items", json!({"id":"a","text":"first"})))
        .unwrap();
    assert_eq!(syncs.0.load(Ordering::SeqCst), 3);
    assert!(root.join("a.json").exists());
    runtime
        .mutate(|db| db.create("items", json!({"id":"b","text":"second"})))
        .unwrap();
    assert_eq!(syncs.0.load(Ordering::SeqCst), 3);
}
