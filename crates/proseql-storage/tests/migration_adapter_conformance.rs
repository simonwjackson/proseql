use proseql_engine::{
    callbacks::CallbackRegistry,
    descriptor::{IdStrategy, SchemaNode, StructField},
};
use proseql_formats::FormatRegistry;
use proseql_storage::{
    host::StorageHost,
    memory::MemoryStorageHost,
    persistence::{
        load_data, CallbackRegistryMigrationHost, LoadDataOptions, MigrationStep, ValidationMode,
    },
};
use serde_json::{json, Map, Value};

fn schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "score".into(),
                schema: SchemaNode::Num,
            },
        ],
    }
}

#[test]
fn callback_registry_migration_host_drives_load_data_migrations() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.json",
        r#"{"_version":1,"u1":{"id":"u1","name":"Alice","score":7}}"#,
    )
    .unwrap();
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_migration(
        "users-0-1",
        Box::new(|data: &Map<String, Value>| Ok(data.clone())),
    );
    callbacks.register_migration(
        "users-1-2",
        Box::new(|data: &Map<String, Value>| {
            let mut out = data.clone();
            if let Some(Value::Object(user)) = out.get_mut("u1") {
                user.insert("score".into(), json!(8));
            }
            Ok(out)
        }),
    );
    let adapter = CallbackRegistryMigrationHost::new(&callbacks);
    let loaded = load_data(
        &host,
        &formats,
        "/data/users.json",
        &schema(),
        LoadDataOptions {
            version: Some(2),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".into(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".into(),
                },
            ],
            collection_name: Some("users".into()),
            validation: ValidationMode::Strict,
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        Some(&adapter),
    )
    .unwrap();
    assert_eq!(loaded["u1"]["score"], json!(8));
}

#[test]
fn load_data_surfaces_missing_registry_callbacks_through_adapter() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.json",
        r#"{"_version":0,"u1":{"id":"u1","name":"Alice","score":7}}"#,
    )
    .unwrap();
    let callbacks = CallbackRegistry::new();
    let adapter = CallbackRegistryMigrationHost::new(&callbacks);
    let error = load_data(
        &host,
        &formats,
        "/data/users.json",
        &schema(),
        LoadDataOptions {
            version: Some(1),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "missing".into(),
            }],
            collection_name: Some("users".into()),
            validation: ValidationMode::Strict,
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        Some(&adapter),
    )
    .unwrap_err();
    match error {
        proseql_engine::errors::EngineError::Migration(error) => {
            assert_eq!(error.reason, "transform-failed")
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn load_data_with_missing_file_and_dry_run_like_no_file_is_non_mutating() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let callbacks = CallbackRegistry::new();
    let adapter = CallbackRegistryMigrationHost::new(&callbacks);
    let loaded = load_data(
        &host,
        &formats,
        "/data/missing.json",
        &schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".into()),
            validation: ValidationMode::Strict,
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        Some(&adapter),
    )
    .unwrap();
    assert!(loaded.is_empty());
    assert!(!host.exists("/data/missing.json").unwrap());
}

#[test]
fn migrated_writeback_preserves_new_version_header() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.json",
        r#"{"_version":1,"u1":{"id":"u1","name":"Alice","score":7}}"#,
    )
    .unwrap();
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_migration("users-0-1", Box::new(|data| Ok(data.clone())));
    callbacks.register_migration("users-1-2", Box::new(|data| Ok(data.clone())));
    let adapter = CallbackRegistryMigrationHost::new(&callbacks);
    let _ = load_data(
        &host,
        &formats,
        "/data/users.json",
        &schema(),
        LoadDataOptions {
            version: Some(2),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".into(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".into(),
                },
            ],
            collection_name: Some("users".into()),
            validation: ValidationMode::Strict,
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        Some(&adapter),
    )
    .unwrap();
    let written = host.read("/data/users.json").unwrap();
    assert!(written.contains("\"_version\": 2") || written.contains("\"_version\":2"));
}

#[test]
fn missing_registry_callback_is_contextualized_by_storage_runner() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.json",
        r#"{"_version":0,"u1":{"id":"u1","name":"Alice","score":7}}"#,
    )
    .unwrap();
    let callbacks = CallbackRegistry::new();
    let adapter = CallbackRegistryMigrationHost::new(&callbacks);
    let error = load_data(
        &host,
        &formats,
        "/data/users.json",
        &schema(),
        LoadDataOptions {
            version: Some(1),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "missing".into(),
            }],
            collection_name: Some("users".into()),
            validation: ValidationMode::Strict,
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        Some(&adapter),
    )
    .unwrap_err();
    match error {
        proseql_engine::errors::EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.from_version, 0);
            assert_eq!(error.to_version, 1);
            assert_eq!(error.step, 0);
            assert_eq!(error.reason, "transform-failed");
            assert!(error
                .message
                .contains("callback 'missing' is not registered"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}
