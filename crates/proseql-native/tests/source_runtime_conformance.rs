use std::sync::Arc;
use std::time::Duration;

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::fs::FsStorageHost;
use proseql_storage::source_config::{
    DatabaseSourceConfig, DocumentGraphFragmentErrorPolicy, DocumentGraphRootConfig,
    DocumentGraphSourceConfig, DocumentSourceConfig, SourceCollectionSelection,
    UnknownCollectionPolicy,
};
use serde_json::json;

fn descriptor(name: &str) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
        schema: SchemaNode::Struct {
            fields: vec![StructField {
                name: "value".into(),
                schema: SchemaNode::Num,
            }],
        },
        id_strategy: IdStrategy::DerivedFromKey,
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
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    }
}

fn graph(root: &str, id: &str, file: &str, collection: &str) -> DatabaseSourceConfig {
    DatabaseSourceConfig::DocumentGraph(DocumentGraphSourceConfig {
        id: id.into(),
        roots: vec![DocumentGraphRootConfig {
            id: Some(collection.into()),
            root: root.into(),
            optional: true,
            include: Some(vec![file.into()]),
            exclude: vec![],
            collections: Some(SourceCollectionSelection::Named(vec![collection.into()])),
        }],
        collections: Some(SourceCollectionSelection::Named(vec![collection.into()])),
        include: None,
        exclude: vec![],
        transform_callback_id: None,
        on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
    })
}

fn config(root: &str) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: ["sessions", "recoveryLog", "withingsWeightLog"]
            .map(|name| NativeCollectionConfig::new(descriptor(name)))
            .to_vec(),
        sources: vec![
            DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "coach".into(),
                root: root.into(),
                include: Some(vec!["**/*.yaml".into()]),
                exclude: vec!["recovery.yaml".into(), "withings.yaml".into()],
                format: Some("yaml".into()),
                collections: Some(SourceCollectionSelection::Named(vec!["sessions".into()])),
                unknown_collections: UnknownCollectionPolicy::Preserve,
                outbox: "generated.yaml".into(),
                optional: false,
            }),
            graph(root, "recovery", "recovery.yaml", "recoveryLog"),
            graph(root, "withings", "withings.yaml", "withingsWeightLog"),
        ],
    }
}

fn open(root: &str) -> NativeRuntime {
    NativeRuntime::open_sources_with_host(
        config(root),
        Arc::new(FsStorageHost::new_polling(Duration::from_millis(20)).unwrap()),
        NativeSourceRuntimeOptions::default(),
    )
    .unwrap()
}

#[test]
fn writes_only_changed_origins_preserves_unknown_sections_and_routes_new_records_to_outbox() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let journal = "# authored\nsessions:\n  old:\n    value: 1\n  untouched:\n    extra: keep\n    value: 4\nunknown:\n  keep: [one, two]\n";
    let generated = "# generated\nsessions:\n  other:\n    value: 2\n";
    let provider = "# importer owned\nrecoveryLog:\n  night:\n    value: 3\n";
    std::fs::write(root.join("journal.yaml"), journal).unwrap();
    std::fs::write(root.join("generated.yaml"), generated).unwrap();
    std::fs::write(root.join("recovery.yaml"), provider).unwrap();
    std::fs::write(
        root.join("fuel.yaml"),
        "# untouched file\nrecipes:\n  egg: {name: egg}\n",
    )
    .unwrap();
    let runtime = open(root.to_str().unwrap());
    runtime
        .mutate(|tx| tx.update("sessions", "old", json!({"value": 9})))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("generated.yaml")).unwrap(),
        generated
    );
    assert_eq!(
        std::fs::read_to_string(root.join("recovery.yaml")).unwrap(),
        provider
    );
    let updated = std::fs::read_to_string(root.join("journal.yaml")).unwrap();
    assert!(updated.contains("extra: keep"));
    let yaml = proseql_formats::FormatRegistry::with_builtins()
        .deserialize(&updated, "yaml")
        .unwrap();
    assert_eq!(yaml["unknown"], json!({"keep": ["one", "two"]}));
    assert_eq!(yaml["sessions"]["old"], json!({"value":9}));
    assert!(yaml["sessions"]["old"].get("id").is_none());
    runtime
        .mutate(|tx| tx.create("sessions", json!({"id":"fresh", "value": 7})))
        .unwrap();
    runtime.mutate(|tx| tx.delete("sessions", "old")).unwrap();
    let deleted = std::fs::read_to_string(root.join("journal.yaml")).unwrap();
    assert!(!deleted.contains("old:"));
    runtime.flush().unwrap();
    runtime.close().unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("journal.yaml")).unwrap(),
        deleted
    );
    assert_eq!(
        std::fs::read_to_string(root.join("fuel.yaml")).unwrap(),
        "# untouched file\nrecipes:\n  egg: {name: egg}\n"
    );
    let reopened = open(root.to_str().unwrap());
    assert_eq!(
        reopened.find_by_id("sessions", "fresh").unwrap(),
        Some(json!({"id":"fresh", "value":7}))
    );
    assert_eq!(reopened.find_by_id("sessions", "old").unwrap(), None);
    assert_eq!(
        reopened.find_by_id("sessions", "other").unwrap(),
        Some(json!({"id":"other", "value":2}))
    );
    reopened.close().unwrap();
}

#[test]
fn importer_replacements_creation_and_removal_reload_without_restart() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::write(root.join("journal.yaml"), "sessions:\n  old: {value: 1}\n").unwrap();
    std::fs::write(
        root.join("recovery.yaml"),
        "recoveryLog:\n  night: {value: 3}\n",
    )
    .unwrap();
    let runtime = open(root.to_str().unwrap());
    std::fs::write(
        root.join("recovery.tmp"),
        "recoveryLog:\n  later: {value: 30}\n",
    )
    .unwrap();
    std::fs::rename(root.join("recovery.tmp"), root.join("recovery.yaml")).unwrap();
    wait_until(|| {
        runtime
            .find_by_id("recoveryLog", "later")
            .unwrap()
            .is_some()
    });
    assert_eq!(runtime.find_by_id("recoveryLog", "night").unwrap(), None);
    std::fs::write(
        root.join("withings.yaml"),
        "withingsWeightLog:\n  reading: {value: 8}\n",
    )
    .unwrap();
    wait_until(|| {
        runtime
            .find_by_id("withingsWeightLog", "reading")
            .unwrap()
            .is_some()
    });
    std::fs::remove_file(root.join("withings.yaml")).unwrap();
    wait_until(|| {
        runtime
            .find_by_id("withingsWeightLog", "reading")
            .unwrap()
            .is_none()
    });
    std::fs::write(root.join("recovery.yaml"), "recoveryLog: invalid\n").unwrap();
    wait_until(|| runtime.last_reload_error().unwrap().is_some());
    assert_eq!(
        runtime.find_by_id("recoveryLog", "later").unwrap(),
        Some(json!({"id":"later", "value":30}))
    );
    runtime.close().unwrap();
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            std::time::Instant::now() < deadline,
            "managed reload timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn graph_mutations_fail_before_any_writable_change_reaches_disk() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = "sessions:\n  old: {value: 1}\n";
    let provider = "# provider\nrecoveryLog:\n  night: {value: 3}\n";
    std::fs::write(root.join("journal.yaml"), original).unwrap();
    std::fs::write(root.join("recovery.yaml"), provider).unwrap();
    let runtime = open(root.to_str().unwrap());
    let error = runtime
        .mutate(|tx| {
            tx.update("sessions", "old", json!({"value":99}))?;
            tx.update("recoveryLog", "night", json!({"value":5}))
        })
        .unwrap_err();
    assert!(error.to_string().contains("read-only"));
    assert_eq!(
        runtime.find_by_id("sessions", "old").unwrap(),
        Some(json!({"id":"old", "value":1}))
    );
    assert!(runtime
        .mutate(|tx| tx.create("recoveryLog", json!({"id":"new", "value":1})))
        .is_err());
    assert!(runtime
        .mutate(|tx| tx.delete("recoveryLog", "night"))
        .is_err());
    assert!(runtime
        .mutate(|tx| tx.update_if_revision("recoveryLog", "night", 0, json!({"value":2})))
        .is_err());
    runtime.close().unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("journal.yaml")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read_to_string(root.join("recovery.yaml")).unwrap(),
        provider
    );
}

struct ProviderTransform {
    warnings: Arc<std::sync::Mutex<Vec<String>>>,
}

impl proseql_storage::document_graph::DocumentGraphTransformHost for ProviderTransform {
    fn run_transform(
        &self,
        callback: &str,
        document: &serde_json::Value,
        context: &proseql_storage::document_graph::DocumentGraphTransformContext,
    ) -> Result<serde_json::Value, serde_json::Value> {
        assert_eq!(callback, "provider-rows");
        let mut rows = serde_json::Map::new();
        if let Some(array) = document.as_array() {
            for row in array {
                if row.get("__jsonlParseError") == Some(&json!(true)) {
                    self.warnings
                        .lock()
                        .unwrap()
                        .push(format!("{}:{}", context.path, row["line"]));
                    continue;
                }
                let Some(id) = row.get("id").and_then(|id| id.as_str()) else {
                    continue;
                };
                let mut payload = row.as_object().unwrap().clone();
                payload.shift_remove("id");
                rows.insert(id.into(), payload.into());
            }
        }
        Ok(json!({context.root_id.clone(): rows}))
    }
}

#[test]
fn custom_lenient_jsonl_and_transform_skip_only_malformed_rows_and_reload_missing_roots() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    std::fs::create_dir(temp.path().join("oura")).unwrap();
    std::fs::write(temp.path().join("oura/activity.jsonl"), "{\"id\":\"a\",\"value\":1}\n\n{broken\n{\"id\":\"b\",\"value\":2}\n{\"id\":\"a\",\"value\":9}\n{\"value\":20}\nnull\n").unwrap();
    let mut cfg = config(root);
    cfg.collections.extend(
        ["ouraActivityLog", "ouraTagLog"].map(|name| NativeCollectionConfig::new(descriptor(name))),
    );
    let mut source = graph(root, "oura", "oura/activity.jsonl", "ouraActivityLog");
    if let DatabaseSourceConfig::DocumentGraph(graph) = &mut source {
        graph.transform_callback_id = Some("provider-rows".into());
        graph.collections = Some(SourceCollectionSelection::Named(vec![
            "ouraActivityLog".into(),
            "ouraTagLog".into(),
        ]));
        graph.roots.push(DocumentGraphRootConfig {
            id: Some("ouraTagLog".into()),
            root: root.into(),
            optional: true,
            include: Some(vec!["oura/tags.jsonl".into()]),
            exclude: vec![],
            collections: Some(SourceCollectionSelection::Named(vec!["ouraTagLog".into()])),
        });
    }
    cfg.sources.push(source);
    let warnings = Arc::new(std::sync::Mutex::new(Vec::new()));
    let options = NativeSourceRuntimeOptions {
        formats: proseql_formats::FormatRegistry::new(vec![
            Box::new(proseql_formats::codecs::yaml_codec()),
            Box::new(proseql_formats::codecs::lenient_jsonl_codec()),
        ]),
        transforms: Some(Arc::new(ProviderTransform {
            warnings: warnings.clone(),
        })),
        ..Default::default()
    };
    let runtime = NativeRuntime::open_sources_with_host(
        cfg,
        Arc::new(FsStorageHost::new_polling(Duration::from_millis(20)).unwrap()),
        options,
    )
    .unwrap();
    assert_eq!(
        runtime.find_by_id("ouraActivityLog", "a").unwrap(),
        Some(json!({"id":"a", "value":9}))
    );
    assert_eq!(
        runtime.find_by_id("ouraActivityLog", "b").unwrap(),
        Some(json!({"id":"b", "value":2}))
    );
    assert_eq!(
        warnings.lock().unwrap().as_slice(),
        &[format!("{root}/oura/activity.jsonl:3")]
    );
    assert!(runtime
        .read(|db| Ok(db.collection("ouraTagLog").unwrap().is_empty()))
        .unwrap());
    assert!(runtime
        .mutate(|tx| tx.create("ouraActivityLog", json!({"id":"new", "value":1})))
        .is_err());
    std::fs::write(
        temp.path().join("oura/tags.jsonl"),
        "{\"id\":\"tag\",\"value\":4}\n",
    )
    .unwrap();
    wait_until(|| runtime.find_by_id("ouraTagLog", "tag").unwrap().is_some());
    runtime.close().unwrap();
}

struct PauseAt {
    root: std::path::PathBuf,
    point: proseql_storage::fs::DurabilityFaultPoint,
}

impl proseql_storage::fs::DurabilityFaultInjector for PauseAt {
    fn check(
        &self,
        point: proseql_storage::fs::DurabilityFaultPoint,
    ) -> Result<(), proseql_engine::errors::EngineError> {
        if point == self.point {
            std::fs::write(self.root.join("ready"), "ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "subprocess-only crash boundary"]
fn source_crash_child() {
    let root = std::path::PathBuf::from(std::env::var("PROSEQL_CRASH_ROOT").unwrap());
    let point = match std::env::var("PROSEQL_CRASH_POINT").unwrap().as_str() {
        "pending" => proseql_storage::fs::DurabilityFaultPoint::DirectorySync,
        "committed" | "committed-batch" => proseql_storage::fs::DurabilityFaultPoint::Cleanup,
        other => panic!("unknown point {other}"),
    };
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(PauseAt {
                root: root.clone(),
                point,
            }),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        config(root.to_str().unwrap()),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    if std::env::var("PROSEQL_CRASH_POINT").unwrap() == "committed-batch" {
        runtime
            .mutate(|tx| {
                tx.update("sessions", "a", json!({"value":11}))?;
                tx.update("sessions", "b", json!({"value":22}))
            })
            .unwrap();
    } else {
        runtime
            .mutate(|tx| tx.create("sessions", json!({"id":"fresh", "value":7})))
            .unwrap();
    }
}

fn kill_at(root: &std::path::Path, point: &str) {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "source_crash_child", "--ignored", "--nocapture"])
        .env("PROSEQL_CRASH_ROOT", root)
        .env("PROSEQL_CRASH_POINT", point)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !root.join("ready").exists() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("crash child did not reach boundary");
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("child exited before boundary: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn pending_first_outbox_write_is_recovered_before_discovery() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("journal.yaml"),
        "sessions:\n  old: {value: 1}\n",
    )
    .unwrap();
    kill_at(temp.path(), "pending");
    let runtime = open(temp.path().to_str().unwrap());
    assert_eq!(runtime.find_by_id("sessions", "fresh").unwrap(), None);
    assert!(!temp.path().join("generated.yaml").exists());
    runtime.close().unwrap();
}

#[test]
fn process_crash_between_file_commits_retains_the_committed_prefix() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("a.yaml"), "sessions:\n  a: {value: 1}\n").unwrap();
    std::fs::write(temp.path().join("b.yaml"), "sessions:\n  b: {value: 2}\n").unwrap();
    kill_at(temp.path(), "committed-batch");
    let runtime = open(temp.path().to_str().unwrap());
    assert_eq!(
        runtime.find_by_id("sessions", "a").unwrap(),
        Some(json!({"id":"a", "value":11}))
    );
    assert_eq!(
        runtime.find_by_id("sessions", "b").unwrap(),
        Some(json!({"id":"b", "value":2}))
    );
    runtime.close().unwrap();
}

#[test]
fn committed_outbox_survives_a_crash_during_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("journal.yaml"),
        "sessions:\n  old: {value: 1}\n",
    )
    .unwrap();
    kill_at(temp.path(), "committed");
    let runtime = open(temp.path().to_str().unwrap());
    assert_eq!(
        runtime.find_by_id("sessions", "fresh").unwrap(),
        Some(json!({"id":"fresh", "value":7}))
    );
    runtime.close().unwrap();
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
                    operation: "test-replace".into(),
                    reason: "disk-failure".into(),
                    message: "second replacement failed".into(),
                },
            ));
        }
        Ok(())
    }
}

#[test]
fn failed_second_file_reports_partial_commit_and_close_cannot_overwrite_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("a.yaml"), "sessions:\n  a: {value: 1}\n").unwrap();
    std::fs::write(temp.path().join("b.yaml"), "sessions:\n  b: {value: 2}\n").unwrap();
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(FailSecondReplace(std::sync::atomic::AtomicUsize::new(0))),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        config(root),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    let error = runtime
        .mutate(|tx| {
            tx.update("sessions", "a", json!({"value":11}))?;
            tx.update("sessions", "b", json!({"value":22}))
        })
        .unwrap_err();
    assert!(error.to_string().contains("completed paths"));
    assert!(error.to_string().contains("a.yaml"));
    assert!(error.to_string().contains("b.yaml"));
    assert!(runtime.find_by_id("sessions", "a").is_err());
    assert!(runtime.mutate(|tx| tx.delete("sessions", "b")).is_err());
    assert!(runtime.reload().is_err());
    assert!(runtime.flush().is_err());
    runtime.close().unwrap();
    let reopened = open(root);
    assert_eq!(
        reopened.find_by_id("sessions", "a").unwrap(),
        Some(json!({"id":"a", "value":11}))
    );
    assert_eq!(
        reopened.find_by_id("sessions", "b").unwrap(),
        Some(json!({"id":"b", "value":2}))
    );
    reopened.close().unwrap();
}

#[test]
fn no_op_mutations_and_intervening_edits_do_not_rewrite_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = "# retained\nsessions:\n  a: {value: 1}\n";
    std::fs::write(root.join("journal.yaml"), original).unwrap();
    let runtime = NativeRuntime::open_sources_with_host(
        config(root.to_str().unwrap()),
        Arc::new(FsStorageHost::new_polling(Duration::from_secs(2)).unwrap()),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    runtime
        .mutate(|tx| tx.update("sessions", "a", json!({"value":1})))
        .unwrap();
    // Rust distinguishes JSON integer and float representations; the database
    // contract treats both as the same JS Number.
    runtime
        .mutate(|tx| tx.update("sessions", "a", json!({"value":1.0})))
        .unwrap();
    runtime
        .mutate(|tx| {
            tx.create("sessions", json!({"id":"temporary", "value":5}))?;
            tx.delete("sessions", "temporary")
        })
        .unwrap();
    assert!(!root.join("generated.yaml").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("journal.yaml")).unwrap(),
        original
    );
    let external = "# edited\nsessions:\n  a: {value: 7}\nother:\n  keep: changed\n";
    std::fs::write(root.join("journal.yaml"), external).unwrap();
    let error = runtime
        .mutate(|tx| tx.update("sessions", "a", json!({"value":2})))
        .unwrap_err();
    assert!(error.to_string().contains("changed since load"));
    assert_eq!(
        std::fs::read_to_string(root.join("journal.yaml")).unwrap(),
        external
    );
    runtime.reload().unwrap();
    runtime
        .mutate(|tx| tx.update("sessions", "a", json!({"value":3})))
        .unwrap();
    assert!(std::fs::read_to_string(root.join("journal.yaml"))
        .unwrap()
        .contains("keep: changed"));
    runtime.close().unwrap();
}

#[test]
fn rejects_a_writable_outbox_owned_by_a_graph_even_when_the_file_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(temp.path().to_str().unwrap());
    if let DatabaseSourceConfig::Documents(source) = &mut cfg.sources[0] {
        source.outbox = "recovery.yaml".into();
        source.exclude.clear();
    }
    assert!(NativeRuntime::open_sources(cfg).is_err());
}

#[path = "../examples/support/coach.rs"]
mod coach;

fn schema_sample(schema: &SchemaNode) -> serde_json::Value {
    match schema {
        SchemaNode::Str => json!("fixture"),
        SchemaNode::Num => json!(1),
        SchemaNode::Bool => json!(false),
        SchemaNode::Literal { value } => value.clone(),
        SchemaNode::LiteralUnion { values } => values[0].clone(),
        SchemaNode::Array { item } => json!([schema_sample(item)]),
        SchemaNode::Struct { fields } => serde_json::Value::Object(
            fields
                .iter()
                .filter(|field| !matches!(field.schema, SchemaNode::Optional(_)))
                .map(|field| (field.name.clone(), schema_sample(&field.schema)))
                .collect(),
        ),
        other => panic!("Unexpected Coach schema node: {other:?}"),
    }
}

#[test]
fn all_42_legacy_schemas_open_the_coach_shaped_fixture_and_a_partial_mvp_preserves_other_collections(
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/coach-schema.json")).unwrap();
    let cfg = coach::config(root, &schema).unwrap();
    assert_eq!(cfg.collections.len(), 42);
    let mut documents =
        std::collections::BTreeMap::<String, serde_json::Map<String, serde_json::Value>>::new();
    let oura_files = schema["ouraFiles"].as_object().unwrap();
    std::fs::create_dir(temp.path().join("oura")).unwrap();
    for collection in &cfg.collections {
        let descriptor = &collection.descriptor;
        let name = &descriptor.name;
        let payload = schema_sample(&descriptor.schema);
        if let Some(file) = oura_files.get(name) {
            if ["ouraVo2MaxLog", "ouraSessionLog", "ouraTagLog"].contains(&name.as_str()) {
                continue;
            }
            let mut row = payload.as_object().unwrap().clone();
            row.insert("id".into(), json!("fixture"));
            let mut raw = format!("{}\n", serde_json::Value::Object(row));
            if name == "ouraActivityLog" {
                raw.push_str("{malformed\n");
            }
            std::fs::write(temp.path().join(file.as_str().unwrap()), raw).unwrap();
            continue;
        }
        let file = match name.as_str() {
            "recoveryLog" => "recovery.yaml",
            "withingsWeightLog" => "withings.yaml",
            "settings" | "readiness" => "settings.yaml",
            "sessions" | "setLog" => "journal.yaml",
            "recipes" | "foods" | "days" => "fuel.yaml",
            _ => "training.yaml",
        };
        documents
            .entry(file.into())
            .or_default()
            .insert(name.clone(), json!({"fixture": payload.clone()}));
        if ["sessions", "setLog", "recipes", "gains"].contains(&name.as_str()) {
            documents
                .entry("generated.yaml".into())
                .or_default()
                .insert(name.clone(), json!({"second": payload}));
        }
    }
    documents.get_mut("journal.yaml").unwrap().insert(
        "futureCollection".into(),
        json!({"keep":{"nested":[1,"two",true]}}),
    );
    let formats = proseql_formats::FormatRegistry::with_builtins();
    assert_eq!(documents.len(), 7);
    for (file, document) in documents {
        std::fs::write(
            temp.path().join(file),
            formats.serialize(&document.into(), "yaml", None).unwrap(),
        )
        .unwrap();
    }
    let warnings = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = warnings.clone();
    let mut options = coach::options(Arc::new(move |path, line| {
        sink.lock().unwrap().push(format!("{path}:{line}"))
    }));
    options.watch_debounce = None;
    let runtime = NativeRuntime::open_sources_with_options(cfg.clone(), options).unwrap();
    let count = runtime
        .read(|db| {
            Ok(cfg
                .collections
                .iter()
                .map(|collection| {
                    db.collection(&collection.descriptor.name)
                        .unwrap()
                        .list()
                        .len()
                })
                .sum::<usize>())
        })
        .unwrap();
    assert_eq!(count, 43);
    assert_eq!(
        warnings.lock().unwrap().as_slice(),
        &[format!("{root}/oura/activity.jsonl:2")]
    );
    for source in &cfg.sources {
        if let DatabaseSourceConfig::DocumentGraph(source) = source {
            if let Some(SourceCollectionSelection::Named(names)) = &source.collections {
                for name in names {
                    let error = runtime
                        .mutate(|tx| tx.create(name, json!({"id":"forbidden"})))
                        .unwrap_err();
                    assert!(
                        matches!(error, proseql_engine::errors::EngineError::Operation(error) if error.reason == "read-only-source")
                    );
                }
            }
        }
    }
    for name in ["ouraVo2MaxLog", "ouraSessionLog", "ouraTagLog"] {
        assert!(runtime
            .read(|db| Ok(db.collection(name).unwrap().is_empty()))
            .unwrap());
    }
    let original_journal = std::fs::read_to_string(temp.path().join("journal.yaml")).unwrap();
    runtime
        .mutate(|tx| tx.update("sessions", "second", json!({"planTitle":"changed"})))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("journal.yaml")).unwrap(),
        original_journal
    );
    runtime.close().unwrap();
    let mut partial = cfg;
    partial
        .collections
        .retain(|collection| collection.descriptor.name == "sessions");
    partial
        .sources
        .retain(|source| matches!(source, DatabaseSourceConfig::Documents(_)));
    if let DatabaseSourceConfig::Documents(source) = &mut partial.sources[0] {
        source.collections = Some(SourceCollectionSelection::Named(vec!["sessions".into()]));
    }
    let before = formats.deserialize(&original_journal, "yaml").unwrap();
    let runtime = NativeRuntime::open_sources_with_options(
        partial,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    runtime
        .mutate(|tx| tx.update("sessions", "fixture", json!({"planTitle":"MVP edit"})))
        .unwrap();
    runtime.close().unwrap();
    let after = formats
        .deserialize(
            &std::fs::read_to_string(temp.path().join("journal.yaml")).unwrap(),
            "yaml",
        )
        .unwrap();
    assert_eq!(after["setLog"], before["setLog"]);
    assert_eq!(after["futureCollection"], before["futureCollection"]);
    assert_eq!(after["sessions"]["fixture"]["planTitle"], json!("MVP edit"));
}

struct ReadThenReplace {
    inner: FsStorageHost,
    path: String,
    replacement: String,
    changed: std::sync::atomic::AtomicBool,
}

impl proseql_storage::host::StorageHost for ReadThenReplace {
    fn read(&self, path: &str) -> Result<String, proseql_engine::errors::EngineError> {
        let content = self.inner.read(path)?;
        if path == self.path && !self.changed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.inner.write(path, &self.replacement)?;
        }
        Ok(content)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), proseql_engine::errors::EngineError> {
        self.inner.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), proseql_engine::errors::EngineError> {
        self.inner.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, proseql_engine::errors::EngineError> {
        self.inner.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), proseql_engine::errors::EngineError> {
        self.inner.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), proseql_engine::errors::EngineError> {
        self.inner.ensure_dir(path)
    }
    fn list_directory(
        &self,
        path: &str,
    ) -> Result<Vec<String>, proseql_engine::errors::EngineError> {
        self.inner.list_directory(path)
    }
    fn list_recursive(
        &self,
        path: &str,
    ) -> Result<Vec<String>, proseql_engine::errors::EngineError> {
        self.inner.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        callback: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, proseql_engine::errors::EngineError>
    {
        self.inner.watch(path, callback)
    }
    fn watch_dir(
        &self,
        path: &str,
        callback: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, proseql_engine::errors::EngineError>
    {
        self.inner.watch_dir(path, callback)
    }
}
impl proseql_storage::persistence::DurableStorageHost for ReadThenReplace {
    fn replace_durable(
        &self,
        path: &str,
        content: &str,
    ) -> Result<(), proseql_engine::errors::EngineError> {
        self.inner.replace_durable(path, content)
    }
}

#[test]
fn an_edit_during_load_cannot_become_the_baseline_for_stale_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    let path = temp.path().join("journal.yaml");
    std::fs::write(
        &path,
        "sessions:\n  old: {value: 1}\nunknown:\n  keep: before\n",
    )
    .unwrap();
    let replacement = "sessions:\n  old: {value: 2}\nunknown:\n  keep: after\n";
    let host = Arc::new(ReadThenReplace {
        inner: FsStorageHost::new_polling(Duration::from_secs(2)).unwrap(),
        path: path.to_str().unwrap().into(),
        replacement: replacement.into(),
        changed: std::sync::atomic::AtomicBool::new(false),
    });
    let runtime = NativeRuntime::open_sources_with_host(
        config(root),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(runtime
        .mutate(|tx| tx.update("sessions", "old", json!({"value":9})))
        .is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), replacement);
    runtime.close().unwrap();
}

struct RejectSelectedYaml;
impl proseql_formats::FormatCodec for RejectSelectedYaml {
    fn name(&self) -> &str {
        "selective-yaml"
    }
    fn extensions(&self) -> &[&str] {
        &["yaml"]
    }
    fn encode(
        &self,
        data: &serde_json::Value,
        options: Option<proseql_formats::FormatOptions>,
    ) -> Result<String, String> {
        if data["sessions"]["b"]["value"] == json!(99) {
            return Err("selected serialization failure".into());
        }
        proseql_formats::codecs::yaml_codec().encode(data, options)
    }
    fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
        proseql_formats::codecs::yaml_codec().decode(raw)
    }
}

#[test]
fn serialization_failure_in_a_later_file_leaves_all_files_and_records_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    let a = "# first\nsessions:\n  a: {value: 1}\n";
    let b = "# second\nsessions:\n  b: {value: 2}\n";
    std::fs::write(temp.path().join("a.yaml"), a).unwrap();
    std::fs::write(temp.path().join("b.yaml"), b).unwrap();
    let runtime = NativeRuntime::open_sources_with_options(
        config(temp.path().to_str().unwrap()),
        NativeSourceRuntimeOptions {
            formats: proseql_formats::FormatRegistry::new(vec![Box::new(RejectSelectedYaml)]),
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(runtime
        .mutate(|tx| {
            tx.update("sessions", "a", json!({"value":11}))?;
            tx.update("sessions", "b", json!({"value":99}))
        })
        .is_err());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("a.yaml")).unwrap(),
        a
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("b.yaml")).unwrap(),
        b
    );
    assert_eq!(
        runtime.find_by_id("sessions", "a").unwrap(),
        Some(json!({"id":"a", "value":1}))
    );
    runtime
        .mutate(|tx| tx.update("sessions", "b", json!({"value":22})))
        .unwrap();
    runtime.close().unwrap();
}

#[test]
fn graph_fragment_diagnostics_are_available_without_mutating_provider_files() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("recovery.yaml"), "recoveryLog: invalid\n").unwrap();
    let mut cfg = config(temp.path().to_str().unwrap());
    if let DatabaseSourceConfig::DocumentGraph(source) = &mut cfg.sources[1] {
        source.on_fragment_error = DocumentGraphFragmentErrorPolicy::SkipFragment;
    }
    let runtime = NativeRuntime::open_sources_with_options(
        cfg,
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(runtime.document_graph_diagnostics().unwrap().len(), 1);
    assert_eq!(
        runtime.document_graph_diagnostics().unwrap()[0].source_id,
        "recovery"
    );
    runtime.close().unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("recovery.yaml")).unwrap(),
        "recoveryLog: invalid\n"
    );
}

#[test]
fn opens_split_writable_documents_and_optional_read_only_graphs_together() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("journal.yaml"),
        "sessions:\n  old:\n    value: 1\nunknown:\n  keep: [one, two]\n",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("generated.yaml"),
        "sessions:\n  new:\n    value: 2\n",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("recovery.yaml"),
        "recoveryLog:\n  night:\n    value: 3\n",
    )
    .unwrap();
    let runtime = open(temp.path().to_str().unwrap());
    assert_eq!(
        runtime.find_by_id("sessions", "old").unwrap(),
        Some(json!({"id":"old", "value":1}))
    );
    assert_eq!(
        runtime.find_by_id("sessions", "new").unwrap(),
        Some(json!({"id":"new", "value":2}))
    );
    assert_eq!(
        runtime.find_by_id("recoveryLog", "night").unwrap(),
        Some(json!({"id":"night", "value":3}))
    );
    assert_eq!(
        runtime
            .read(|db| Ok(db.collection("withingsWeightLog").unwrap().list().len()))
            .unwrap(),
        0
    );
    runtime.close().unwrap();
}

#[test]
fn saves_preserve_untouched_yaml_blocks_and_records_byte_for_byte() {
    let prefix = "# TypeScript yaml output\nproposals:\n  plain:\n    notes: This is a long plain scalar that the TypeScript library wraps at a\n      different column from the Rust serializer and must keep its original bytes.\n\n\n";
    let record =
        "  untouched:\n    value: 4\n    notes: 'The coach said \"keep these bytes\" today.'\n\n";
    let suffix = "\n# next collection\nweekReads:\n  folded:\n    notes: \"This double-quoted string is folded across\n      two lines in the original document.\"\n\ncalibrations:\n  quoted:\n    notes: 'The coach said \"keep these bytes\" today.'\n\n";
    let original = format!("{prefix}sessions:\n{record}  old:\n    value: 1\n{suffix}");
    for operation in ["insert", "update", "delete"] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("generated.yaml");
        std::fs::write(&path, &original).unwrap();
        let options = NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        };
        let mut config = config(temp.path().to_str().unwrap());
        for name in ["proposals", "weekReads", "calibrations"] {
            let mut collection = descriptor(name);
            collection.schema = SchemaNode::Struct {
                fields: vec![StructField {
                    name: "notes".into(),
                    schema: SchemaNode::Str,
                }],
            };
            config
                .collections
                .push(NativeCollectionConfig::new(collection));
        }
        if let DatabaseSourceConfig::Documents(source) = &mut config.sources[0] {
            source.collections = Some(SourceCollectionSelection::Named(vec![
                "sessions".into(),
                "proposals".into(),
                "weekReads".into(),
                "calibrations".into(),
            ]));
        }
        let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
        match operation {
            "insert" => {
                runtime
                    .mutate(|tx| tx.create("sessions", json!({"id":"new", "value":7})))
                    .unwrap();
            }
            "update" => {
                runtime
                    .mutate(|tx| tx.update("sessions", "old", json!({"value":9})))
                    .unwrap();
            }
            "delete" => {
                runtime.mutate(|tx| tx.delete("sessions", "old")).unwrap();
            }
            _ => unreachable!(),
        }
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.starts_with(prefix), "{operation}: prefix changed");
        assert!(saved.ends_with(suffix), "{operation}: suffix changed");
        assert!(
            saved.contains(record),
            "{operation}: untouched record changed: {saved}"
        );
        let formats = proseql_formats::FormatRegistry::with_builtins();
        let before = formats.deserialize(&original, "yaml").unwrap();
        let after = formats.deserialize(&saved, "yaml").unwrap();
        for name in ["proposals", "weekReads", "calibrations"] {
            assert_eq!(before[name], after[name]);
        }
        let mut expected = before["sessions"].clone();
        match operation {
            "insert" => {
                expected["new"] = json!({"value":7});
            }
            "update" => {
                expected["old"] = json!({"value":9});
            }
            "delete" => {
                expected.as_object_mut().unwrap().remove("old");
            }
            _ => unreachable!(),
        }
        assert_eq!(after["sessions"], expected);
        runtime.flush().unwrap();
        runtime.close().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
    }
}

#[test]
fn unsupported_document_shape_rolls_back_before_any_file_is_written() {
    let temp = tempfile::tempdir().unwrap();
    let first = "# supported\nsessions:\n  a: {value: 1}\n";
    let second = "{sessions: {b: {value: 2}}, neighbour: {notes: 'Leave \"this\" alone.'}}\n";
    std::fs::write(temp.path().join("a.yaml"), first).unwrap();
    std::fs::write(temp.path().join("b.yaml"), second).unwrap();
    let runtime = NativeRuntime::open_sources_with_options(
        config(temp.path().to_str().unwrap()),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    // No-op saves need not segment even an unsupported document.
    runtime
        .mutate(|tx| tx.update("sessions", "b", json!({"value":2})))
        .unwrap();
    let error = runtime
        .mutate(|tx| {
            tx.update("sessions", "a", json!({"value":11}))?;
            tx.update("sessions", "b", json!({"value":22}))
        })
        .unwrap_err();
    let proseql_engine::errors::EngineError::Operation(error) = error else {
        panic!("Expected typed document-shape error");
    };
    assert_eq!(error.reason, "unsupported-document-shape");
    assert!(error.message.contains("b.yaml"));
    assert!(error.message.contains("cannot segment"));
    assert_eq!(
        runtime.find_by_id("sessions", "a").unwrap(),
        Some(json!({"id":"a", "value":1}))
    );
    assert_eq!(
        runtime.find_by_id("sessions", "b").unwrap(),
        Some(json!({"id":"b", "value":2}))
    );
    runtime.flush().unwrap();
    runtime.close().unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("a.yaml")).unwrap(),
        first
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("b.yaml")).unwrap(),
        second
    );
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn mismatched_document_splice_rolls_back_before_any_file_is_written() {
    let temp = tempfile::tempdir().unwrap();
    let first = "# first\nsessions:\n  a: {value: 1}\n";
    let second = "# second\nsessions:\n  b:\n    value: 2\n\nneighbour: {keep: true}\n";
    std::fs::write(temp.path().join("a.yaml"), first).unwrap();
    std::fs::write(temp.path().join("b.yaml"), second).unwrap();
    struct DocumentContextYaml;
    impl proseql_formats::FormatCodec for DocumentContextYaml {
        fn name(&self) -> &str {
            "document-context-yaml"
        }
        fn extensions(&self) -> &[&str] {
            &["yaml"]
        }
        fn encode(
            &self,
            data: &serde_json::Value,
            options: Option<proseql_formats::FormatOptions>,
        ) -> Result<String, String> {
            let mut data = data.clone();
            if data.get("b").is_some() {
                data["b"]["value"] = json!(999);
            }
            proseql_formats::codecs::yaml_codec().encode(&data, options)
        }
        fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
            proseql_formats::codecs::yaml_codec().decode(raw)
        }
    }
    let runtime = NativeRuntime::open_sources_with_options(
        config(temp.path().to_str().unwrap()),
        NativeSourceRuntimeOptions {
            formats: proseql_formats::FormatRegistry::new(vec![Box::new(DocumentContextYaml)]),
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap();
    let error = runtime
        .mutate(|tx| {
            tx.update("sessions", "a", json!({"value":11}))?;
            tx.update("sessions", "b", json!({"value":22}))
        })
        .unwrap_err();
    let proseql_engine::errors::EngineError::Operation(error) = error else {
        panic!("Expected typed document-shape error");
    };
    assert_eq!(error.reason, "unsupported-document-shape");
    assert!(error.message.contains("b.yaml"));
    assert!(error.message.contains("does not match"));
    assert_eq!(
        runtime.find_by_id("sessions", "a").unwrap(),
        Some(json!({"id":"a", "value":1}))
    );
    assert_eq!(
        runtime.find_by_id("sessions", "b").unwrap(),
        Some(json!({"id":"b", "value":2}))
    );
    runtime.close().unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("a.yaml")).unwrap(),
        first
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("b.yaml")).unwrap(),
        second
    );
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn coach_settings_and_plan_load_updates_preserve_hand_edited_neighbour_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_str().unwrap();
    let schema = serde_json::from_str(include_str!("fixtures/coach-schema.json")).unwrap();
    let config = coach::config(root, &schema).unwrap();
    let sample = |name: &str| {
        schema_sample(
            &config
                .collections
                .iter()
                .find(|collection| collection.descriptor.name == name)
                .unwrap()
                .descriptor
                .schema,
        )
    };
    let formats = proseql_formats::FormatRegistry::with_builtins();
    let emit = |name: &str, records: serde_json::Value| {
        formats
            .serialize(&json!({name: records}), "yaml", None)
            .unwrap()
    };
    let settings = sample("settings");
    let plans = sample("plans");
    let readiness = emit("readiness", json!({"fixture":sample("readiness")}));
    let app_suffix = format!("\n\n# preserve readiness and this blank line\n\n{readiness}");
    let app = format!(
        "# hand-edited app\n{}{app_suffix}",
        emit("settings", json!({"fixture":settings.clone()}))
    );
    let training_prefix = format!(
        "# hand-edited training\n{}\n# series\n{}\n\n# plans\n",
        emit("lifts", json!({"fixture":sample("lifts")})),
        emit("series", json!({"fixture":sample("series")}))
    );
    // The final untouched collection deliberately has no terminating newline.
    let training_suffix = format!(
        "\n# empty gains stays in flow style\ngains: {{}}\n\n# recomp\n{}",
        emit("recomp", json!({"fixture":sample("recomp")})).trim_end_matches('\n')
    );
    let plan_records = emit(
        "plans",
        json!({"fixture":plans.clone(), "untouched":plans.clone()}),
    );
    let untouched_plan = plan_records[plan_records.find("  untouched:").unwrap()..].to_owned();
    let training = format!("{training_prefix}{plan_records}{training_suffix}");
    std::fs::write(temp.path().join("app.yaml"), &app).unwrap();
    std::fs::write(temp.path().join("training.yaml"), &training).unwrap();
    let mut options = coach::options(Arc::new(|_, _| {}));
    options.watch_debounce = None;
    let runtime = NativeRuntime::open_sources_with_options(config.clone(), options).unwrap();
    runtime
        .mutate(|tx| tx.update("settings", "fixture", json!({"restSeconds":2})))
        .unwrap();
    let mut items = plans["items"].clone();
    items[0]["load"] = json!(2);
    runtime
        .mutate(|tx| tx.update("plans", "fixture", json!({"items":items.clone()})))
        .unwrap();
    runtime.close().unwrap();
    let app_saved = std::fs::read_to_string(temp.path().join("app.yaml")).unwrap();
    let training_saved = std::fs::read_to_string(temp.path().join("training.yaml")).unwrap();
    assert!(app_saved.starts_with("# hand-edited app\nsettings:\n"));
    assert!(app_saved.ends_with(&app_suffix));
    assert!(training_saved.starts_with(&training_prefix));
    assert!(training_saved.ends_with(&training_suffix));
    assert!(training_saved.contains(&untouched_plan));
    assert!(!training_saved.ends_with('\n'));
    assert!(!temp.path().join("generated.yaml").exists());
    let mut expected_app = formats.deserialize(&app, "yaml").unwrap();
    expected_app["settings"]["fixture"]["restSeconds"] = json!(2);
    assert_eq!(
        formats.deserialize(&app_saved, "yaml").unwrap(),
        expected_app
    );
    let mut expected_training = formats.deserialize(&training, "yaml").unwrap();
    expected_training["plans"]["fixture"]["items"] = items.clone();
    assert_eq!(
        formats.deserialize(&training_saved, "yaml").unwrap(),
        expected_training
    );
    let mut options = coach::options(Arc::new(|_, _| {}));
    options.watch_debounce = None;
    let reopened = NativeRuntime::open_sources_with_options(config, options).unwrap();
    assert_eq!(
        reopened.find_by_id("settings", "fixture").unwrap().unwrap()["restSeconds"],
        2
    );
    assert_eq!(
        reopened.find_by_id("plans", "fixture").unwrap().unwrap()["items"],
        items
    );
    reopened.close().unwrap();
}
