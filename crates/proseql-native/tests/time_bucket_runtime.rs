//! `PartitionKey::TimeBucket` conformance: routing, wrong-partition and
//! timestamp rejection on write and on load. Synthetic data only.

use std::fs;
use std::path::{Path, PathBuf};

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use serde_json::{json, Value};

fn config(dir: &Path, bucket: TimeBucket, append_only: bool) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "heartrate".into(),
            schema: SchemaNode::Struct {
                fields: [
                    ("id", SchemaNode::Str),
                    ("timestamp", SchemaNode::Str),
                    ("bpm", SchemaNode::Num),
                ]
                .into_iter()
                .map(|(name, schema)| StructField {
                    name: name.into(),
                    schema,
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
            append_only,
            duplicate_ids: Default::default(),
            validation_mode: ValidationMode::Strict,
        })],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "heartrate".into(),
            collection: "heartrate".into(),
            root: root(dir).to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: PartitionKey::TimeBucket {
                field: "timestamp".into(),
                bucket,
            },
            prose: None,
        })],
    }
}

fn root(dir: &Path) -> PathBuf {
    dir.join("heartrate")
}

fn open(dir: &Path, bucket: TimeBucket, append_only: bool) -> Result<NativeRuntime, EngineError> {
    NativeRuntime::open_sources_with_options(
        config(dir, bucket, append_only),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
}

fn sample(timestamp: &str) -> Value {
    json!({"id": format!("heartrate:{timestamp}"), "timestamp": timestamp, "bpm": 80})
}

fn files(dir: &Path) -> Vec<String> {
    let mut names = fs::read_dir(root(dir))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn source_config_error(error: &EngineError) -> &proseql_engine::errors::SourceConfigError {
    match error {
        EngineError::SourceConfig(config) => config,
        other => panic!("expected SourceConfigError, got {other:?}"),
    }
}

#[test]
fn each_bucket_routes_records_without_a_redundant_field() {
    for (bucket, expected) in [
        (TimeBucket::Year, vec!["2025.jsonl", "2026.jsonl"]),
        (TimeBucket::Month, vec!["2025-12.jsonl", "2026-04.jsonl"]),
        (
            TimeBucket::Day,
            vec!["2025-12-31.jsonl", "2026-04-01.jsonl", "2026-04-02.jsonl"],
        ),
    ] {
        for append_only in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let runtime = open(dir.path(), bucket, append_only).unwrap();
            runtime
                .mutate(|db| {
                    db.create("heartrate", sample("2026-04-01T08:15:00.123Z"))?;
                    db.create("heartrate", sample("2026-04-02T00:00:00Z"))?;
                    db.create("heartrate", sample("2025-12-31T23:59:59.999Z"))
                })
                .unwrap();
            assert_eq!(files(dir.path()), expected, "{bucket:?} {append_only}");
            runtime.close().unwrap();
            let reopened = open(dir.path(), bucket, append_only).unwrap();
            assert!(reopened
                .find_by_id("heartrate", "heartrate:2026-04-01T08:15:00.123Z")
                .unwrap()
                .is_some());
        }
    }
}

#[test]
fn non_utc_or_malformed_timestamps_fail_before_any_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path(), TimeBucket::Month, true).unwrap();
    runtime
        .mutate(|db| db.create("heartrate", sample("2026-04-01T08:15:00Z")))
        .unwrap();
    let before = fs::read(root(dir.path()).join("2026-04.jsonl")).unwrap();
    for timestamp in [
        "2026-04-01T10:15:00+02:00",
        "2026-04-01T08:15:00",
        "2026-04-01",
        "2026-04-31T08:15:00Z",
        "April 1, 2026",
    ] {
        let error = runtime
            .mutate(|db| db.create("heartrate", sample(timestamp)))
            .unwrap_err();
        let config = source_config_error(&error);
        assert!(
            config.message.contains("UTC timestamp"),
            "{timestamp}: {error}"
        );
    }
    let error = runtime
        .mutate(|db| {
            db.create(
                "heartrate",
                json!({"id": "heartrate:x", "timestamp": "2026-04-01T08:16:00Z", "bpm": 1}),
            )?;
            db.create(
                "heartrate",
                json!({"id": "heartrate:y", "timestamp": "2026-04-01T08:17:00+00:00", "bpm": 1}),
            )
        })
        .unwrap_err();
    source_config_error(&error);
    assert!(runtime
        .find_by_id("heartrate", "heartrate:x")
        .unwrap()
        .is_none());
    assert_eq!(files(dir.path()), ["2026-04.jsonl"]);
    assert_eq!(
        fs::read(root(dir.path()).join("2026-04.jsonl")).unwrap(),
        before
    );
}

#[test]
fn a_non_utc_timestamp_on_load_fails_naming_the_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(root(dir.path())).unwrap();
    let path = root(dir.path()).join("2026-04.jsonl");
    fs::write(
        &path,
        format!(
            "{}\n",
            serde_json::to_string(&sample("2026-04-01T10:15:00+02:00")).unwrap()
        ),
    )
    .unwrap();
    let error = open(dir.path(), TimeBucket::Month, true).err().unwrap();
    let config = source_config_error(&error);
    assert_eq!(config.path.as_deref(), Some(path.to_str().unwrap()));
    assert!(config.message.contains("UTC timestamp"), "{error}");
}

#[test]
fn a_record_in_the_wrong_bucket_fails_on_load() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(root(dir.path())).unwrap();
    let path = root(dir.path()).join("2026-04.jsonl");
    fs::write(
        &path,
        format!(
            "{}\n",
            serde_json::to_string(&sample("2026-05-01T00:00:00Z")).unwrap()
        ),
    )
    .unwrap();
    let error = open(dir.path(), TimeBucket::Month, true).err().unwrap();
    let config = source_config_error(&error);
    assert_eq!(config.path.as_deref(), Some(path.to_str().unwrap()));
    assert!(config.message.contains("wrong partition"), "{error}");
}

#[test]
fn duplicate_ids_across_buckets_fail_on_load() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(root(dir.path())).unwrap();
    for (file, timestamp) in [
        ("2026-04.jsonl", "2026-04-01T00:00:00Z"),
        ("2026-05.jsonl", "2026-05-01T00:00:00Z"),
    ] {
        fs::write(
            root(dir.path()).join(file),
            format!(
                "{}\n",
                json!({"id": "heartrate:same", "timestamp": timestamp, "bpm": 1})
            ),
        )
        .unwrap();
    }
    let error = open(dir.path(), TimeBucket::Month, true).err().unwrap();
    assert!(
        source_config_error(&error).message.contains("Duplicate"),
        "{error}"
    );
}
