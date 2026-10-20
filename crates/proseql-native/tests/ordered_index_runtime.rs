//! Native runtime: ordered indexes on a partitioned JSONL source.
//! Synthetic heart-rate rows only.

use std::path::Path;

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::query::{IndexUsed, QueryInput, SortOrder};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig};
use serde_json::{json, Value};

fn config(root: &Path, ordered_indexes: &[&str]) -> NativeSourceRuntimeConfig {
    let field = |name: &str, schema: SchemaNode| StructField {
        name: name.into(),
        schema,
    };
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "heartrate".into(),
            schema: SchemaNode::Struct {
                fields: vec![
                    field("id", SchemaNode::Str),
                    field("timestamp", SchemaNode::Str),
                    field("bpm", SchemaNode::Num),
                    field("month", SchemaNode::Str),
                ],
            },
            id_strategy: IdStrategy::Provided,
            relationships: vec![],
            indexes: vec![],
            ordered_indexes: ordered_indexes.iter().map(|f| (*f).to_owned()).collect(),
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
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "heartrate".into(),
            collection: "heartrate".into(),
            root: root.join("heartrate").to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: PartitionKey::Field {
                field: "month".into(),
            },
            prose: None,
        })],
    }
}

fn open(root: &Path, ordered_indexes: &[&str]) -> Result<NativeRuntime, EngineError> {
    NativeRuntime::open_sources_with_options(
        config(root, ordered_indexes),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
}

fn sample(timestamp: &str, bpm: u32) -> Value {
    json!({
        "id": format!("heartrate:{timestamp}"),
        "timestamp": timestamp,
        "bpm": bpm,
        "month": &timestamp[..7],
    })
}

fn one_hour() -> QueryInput {
    QueryInput {
        r#where: Some(json!({"timestamp": {
            "$gte": "2026-02-01T10:00:00.000Z",
            "$lt": "2026-02-01T11:00:00.000Z"
        }})),
        ..QueryInput::default()
    }
}

fn latest(limit: usize) -> QueryInput {
    QueryInput {
        sort: vec![("timestamp".into(), SortOrder::Desc)],
        limit: Some(limit),
        ..QueryInput::default()
    }
}

fn run(runtime: &NativeRuntime, input: &QueryInput) -> Vec<Value> {
    runtime
        .read(|db| db.query("heartrate", input.clone(), None))
        .expect("query")
}

fn ids(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|row| row["id"].as_str().unwrap()).collect()
}

#[test]
fn range_and_sorted_queries_use_the_index_and_match_the_unindexed_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let indexed = open(dir.path(), &["timestamp"]).unwrap();
    let stamps = [
        "2026-01-31T23:59:59.999Z",
        "2026-02-01T10:00:00.000Z",
        "2026-02-01T10:30:00.000Z",
        "2026-02-01T10:59:59.999Z",
        "2026-02-01T11:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
    ];
    indexed
        .mutate(|db| {
            for (offset, stamp) in stamps.iter().enumerate() {
                db.create("heartrate", sample(stamp, 60 + offset as u32))?;
            }
            Ok(())
        })
        .unwrap();
    let in_hour = run(&indexed, &one_hour());
    assert_eq!(
        ids(&in_hour),
        [
            "heartrate:2026-02-01T10:00:00.000Z",
            "heartrate:2026-02-01T10:30:00.000Z",
            "heartrate:2026-02-01T10:59:59.999Z"
        ]
    );
    let stats = indexed
        .read(|db| db.explain_query("heartrate", &one_hour()))
        .unwrap();
    assert_eq!(stats.index_used, IndexUsed::Ordered);
    assert_eq!(stats.candidate_rows, 3);
    let newest = run(&indexed, &latest(2));
    assert!(
        indexed
            .read(|db| db.explain_query("heartrate", &latest(2)))
            .unwrap()
            .index_sorted
    );

    // A failed mutation rolls back, and the index with it.
    let failed = indexed.mutate(|db| {
        db.create("heartrate", sample("2026-02-01T10:15:00.000Z", 99))?;
        Err::<(), _>(EngineError::Operation(OperationError {
            operation: "test".into(),
            reason: "abort".into(),
            message: "abort".into(),
        }))
    });
    assert!(failed.is_err());
    assert_eq!(run(&indexed, &one_hour()), in_hour);
    indexed.close().unwrap();

    // The same files opened without the index give the same answers; opened
    // with it again, the index is rebuilt from the loaded partitions.
    let plain = open(dir.path(), &[]).unwrap();
    assert_eq!(run(&plain, &one_hour()), in_hour);
    assert_eq!(run(&plain, &latest(2)), newest);
    assert_eq!(
        plain
            .read(|db| db.explain_query("heartrate", &one_hour()))
            .unwrap()
            .index_used,
        IndexUsed::None
    );
    plain.close().unwrap();
    let reopened = open(dir.path(), &["timestamp"]).unwrap();
    assert_eq!(run(&reopened, &one_hour()), in_hour);
    assert_eq!(run(&reopened, &latest(2)), newest);
    reopened.close().unwrap();
}

#[test]
fn an_ordered_index_on_an_undeclared_field_fails_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let error = open(dir.path(), &["recordedAt"]).err().expect("open fails");
    let EngineError::Validation(error) = error else {
        panic!("expected ValidationError, got {error:?}");
    };
    assert_eq!(error.issues.len(), 1);
    assert_eq!(error.issues[0].field, "ordered_indexes");
    assert!(error.issues[0].message.contains("'recordedAt'"));
}
