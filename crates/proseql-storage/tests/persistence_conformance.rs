use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::{EngineError, StorageOperation};
use proseql_formats::FormatRegistry;
use proseql_storage::host::StorageHost;
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::{
    append_data, load_collection_from_directory, load_collections_from_file, load_data,
    save_collection_to_directory, save_collections_to_file, save_data, AppendDataOptions,
    LoadCollectionConfig, LoadDataOptions, MigrationHost, MigrationStep, SaveCollectionConfig,
    SaveDataOptions, ValidationMode,
};
use serde_json::{json, Map, Value};

fn user_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".to_owned(),
                schema: SchemaNode::Num,
            },
        ],
    }
}

fn payload_only_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "systemId".to_owned(),
                schema: SchemaNode::Str,
            },
        ],
    }
}

fn score_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "score".to_owned(),
                schema: SchemaNode::NumFromStr,
            },
        ],
    }
}

fn users() -> IndexMap<String, Value> {
    IndexMap::from([
        (
            "u1".to_owned(),
            json!({"id": "u1", "name": "Alice", "age": 30}),
        ),
        (
            "u2".to_owned(),
            json!({"id": "u2", "name": "Bob", "age": 25}),
        ),
    ])
}

type MigrationCallback =
    Arc<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError> + Send + Sync>;

#[derive(Default)]
struct TestMigrationHost {
    callbacks: IndexMap<String, MigrationCallback>,
}

impl TestMigrationHost {
    fn with_callback<F>(mut self, id: &str, callback: F) -> Self
    where
        F: Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError>
            + Send
            + Sync
            + 'static,
    {
        self.callbacks.insert(id.to_owned(), Arc::new(callback));
        self
    }
}

impl MigrationHost for TestMigrationHost {
    fn run_migration(
        &self,
        callback_id: &str,
        data: &Map<String, Value>,
    ) -> Result<Map<String, Value>, EngineError> {
        self.callbacks.get(callback_id).expect("missing callback")(data)
    }
}

#[test]
fn save_and_load_object_keyed_json_round_trips() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    save_data(
        &host,
        &formats,
        "/data/users.json",
        &user_schema(),
        &users(),
        SaveDataOptions::default(),
    )
    .unwrap();

    let loaded = load_data(
        &host,
        &formats,
        "/data/users.json",
        &user_schema(),
        LoadDataOptions::default(),
        None,
    )
    .unwrap();
    assert_eq!(loaded, users());
}

#[test]
fn save_and_load_with_format_override_ignores_extension() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    save_data(
        &host,
        &formats,
        "/data/users.md",
        &user_schema(),
        &users(),
        SaveDataOptions {
            format: Some("yaml".to_owned()),
            ..SaveDataOptions::default()
        },
    )
    .unwrap();

    assert!(host.read("/data/users.md").unwrap().contains("name: Alice"));
    let loaded = load_data(
        &host,
        &formats,
        "/data/users.md",
        &user_schema(),
        LoadDataOptions {
            format: Some("yaml".to_owned()),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(loaded, users());
}

#[test]
fn save_and_load_path_mode_preserves_sibling_data_and_uses_array_shape() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/db.json",
        r#"{"meta":{"owner":"ops"},"collections":{"ignored":[]}}"#,
    )
    .unwrap();

    save_data(
        &host,
        &formats,
        "/data/db.json",
        &user_schema(),
        &users(),
        SaveDataOptions {
            path: Some("collections.users".to_owned()),
            ..SaveDataOptions::default()
        },
    )
    .unwrap();

    let raw: Value = serde_json::from_str(&host.read("/data/db.json").unwrap()).unwrap();
    assert_eq!(raw["meta"]["owner"], "ops");
    assert!(raw["collections"]["users"].is_array());

    let loaded = load_data(
        &host,
        &formats,
        "/data/db.json",
        &user_schema(),
        LoadDataOptions {
            path: Some("collections.users".to_owned()),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(loaded, users());
}

#[test]
fn load_missing_path_inside_document_returns_empty_map() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/data/db.json", r#"{"meta":{}}"#).unwrap();
    let loaded = load_data(
        &host,
        &formats,
        "/data/db.json",
        &user_schema(),
        LoadDataOptions {
            path: Some("collections.users".to_owned()),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap();
    assert!(loaded.is_empty());
}

#[test]
fn jsonl_strict_fails_on_first_bad_line_but_lenient_skips_bad_lines() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.jsonl",
        "{\"id\":\"u1\",\"name\":\"Alice\",\"age\":30}\nnot json\n{\"id\":\"u2\",\"name\":\"Bob\",\"age\":25}",
    )
    .unwrap();

    assert!(matches!(
        load_data(
            &host,
            &formats,
            "/data/users.jsonl",
            &user_schema(),
            LoadDataOptions::default(),
            None
        ),
        Err(EngineError::Serialization(_))
    ));

    let loaded = load_data(
        &host,
        &formats,
        "/data/users.jsonl",
        &user_schema(),
        LoadDataOptions {
            validation: ValidationMode::Lenient,
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(loaded.len(), 2);
}

#[test]
fn derived_ids_load_from_object_keys_and_save_without_physical_id_fields() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/games.yaml",
        "smw:\n  name: Super Mario World\n  systemId: snes\n",
    )
    .unwrap();

    let loaded = load_data(
        &host,
        &formats,
        "/data/games.yaml",
        &payload_only_schema(),
        LoadDataOptions {
            id_strategy: Some(IdStrategy::DerivedFromKey),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(loaded["smw"]["id"], "smw");

    save_data(
        &host,
        &formats,
        "/data/games.yaml",
        &payload_only_schema(),
        &loaded,
        SaveDataOptions {
            id_strategy: Some(IdStrategy::DerivedFromKey),
            ..SaveDataOptions::default()
        },
    )
    .unwrap();
    assert!(!host.read("/data/games.yaml").unwrap().contains("id: smw"));
}

#[test]
fn load_data_requires_migration_host_when_migrations_apply_and_does_not_rewrite() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = "_version: 1\nlegacy:\n  title: Legacy\n";
    host.write("/data/items.yaml", original).unwrap();

    let err = load_data(
        &host,
        &formats,
        "/data/items.yaml",
        &SchemaNode::Struct {
            fields: vec![StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            }],
        },
        LoadDataOptions {
            version: Some(2),
            migrations: vec![MigrationStep {
                from: 1,
                to: 2,
                description: None,
                callback_id: "items-v2".to_owned(),
            }],
            collection_name: Some("items".to_owned()),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap_err();
    match err {
        EngineError::Migration(error) => assert_eq!(error.reason, "missing-host"),
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/items.yaml").unwrap(), original);
}

#[test]
fn append_data_appends_jsonl_lines_without_rewriting_existing_bytes() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/data/events.jsonl", "existing\n").unwrap();

    append_data(
        &host,
        &formats,
        "/data/events.jsonl",
        &user_schema(),
        &IndexMap::from([("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30}))]),
        AppendDataOptions::default(),
    )
    .unwrap();

    let raw = host.read("/data/events.jsonl").unwrap();
    assert!(raw.starts_with("existing\n"), "{raw}");
    assert!(raw.contains("\"id\":\"u1\""), "{raw}");
}

#[test]
fn derived_ids_reject_array_formats_without_path() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let err = save_data(
        &host,
        &formats,
        "/data/games.jsonl",
        &payload_only_schema(),
        &IndexMap::from([(
            "smw".to_owned(),
            json!({"id":"smw","name":"SMW","systemId":"snes"}),
        )]),
        SaveDataOptions {
            id_strategy: Some(IdStrategy::DerivedFromKey),
            ..SaveDataOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::Validation(_)));
}

#[test]
fn versioned_load_runs_migrations_and_writes_back_current_version() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/scores.json",
        r#"{"_version":1,"u1":{"id":"u1","score":"7"}}"#,
    )
    .unwrap();
    let migration_host = TestMigrationHost::default().with_callback("scores-1-2", |data| {
        let mut out = data.clone();
        if let Some(Value::Object(user)) = out.get_mut("u1") {
            user.insert("score".to_owned(), Value::String("8".to_owned()));
        }
        Ok(out)
    });

    let loaded = load_data(
        &host,
        &formats,
        "/data/scores.json",
        &score_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("scores".to_owned()),
            migrations: vec![MigrationStep {
                from: 1,
                to: 2,
                description: None,
                callback_id: "scores-1-2".to_owned(),
            }],
            ..LoadDataOptions::default()
        },
        Some(&migration_host),
    )
    .unwrap();

    assert_eq!(loaded["u1"]["score"], 8.0);
    assert!(host
        .read("/data/scores.json")
        .unwrap()
        .contains("\"_version\": 2"));
}

#[test]
fn version_ahead_uses_migration_error_shape() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users.json",
        r#"{"_version":3,"u1":{"id":"u1","name":"Alice","age":30}}"#,
    )
    .unwrap();
    let err = load_data(
        &host,
        &formats,
        "/data/users.json",
        &user_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".to_owned()),
            ..LoadDataOptions::default()
        },
        None,
    )
    .unwrap_err();

    match err {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.reason, "version-ahead");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn encode_uses_schema_transforms_like_number_from_string() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let scores = IndexMap::from([("u1".to_owned(), json!({"id":"u1","score":7}))]);
    save_data(
        &host,
        &formats,
        "/data/scores.json",
        &score_schema(),
        &scores,
        SaveDataOptions::default(),
    )
    .unwrap();
    assert!(host
        .read("/data/scores.json")
        .unwrap()
        .contains("\"score\": \"7\""));
}

#[test]
fn load_and_save_multi_collection_file_round_trip() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let mut collections = IndexMap::new();
    collections.insert(
        "users".to_owned(),
        LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: None,
            migrations: vec![],
        },
    );
    collections.insert(
        "games".to_owned(),
        LoadCollectionConfig {
            name: "games".to_owned(),
            schema: payload_only_schema(),
            id_strategy: IdStrategy::DerivedFromKey,
            version: None,
            migrations: vec![],
        },
    );

    let data = IndexMap::from([
        ("users".to_owned(), users()),
        (
            "games".to_owned(),
            IndexMap::from([(
                "smw".to_owned(),
                json!({"id":"smw","name":"SMW","systemId":"snes"}),
            )]),
        ),
    ]);

    save_collections_to_file(
        &host,
        &formats,
        "/data/db.yaml",
        &[
            SaveCollectionConfig {
                name: "users".to_owned(),
                schema: user_schema(),
                id_strategy: IdStrategy::Provided,
                version: Some(1),
            },
            SaveCollectionConfig {
                name: "games".to_owned(),
                schema: payload_only_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
            },
        ],
        &data,
    )
    .unwrap();

    let loaded = load_collections_from_file(
        &host,
        &formats,
        "/data/db.yaml",
        &collections.values().cloned().collect::<Vec<_>>(),
        None,
    )
    .unwrap();
    assert_eq!(loaded["users"], users());
    assert_eq!(loaded["games"]["smw"]["id"], "smw");
}

#[test]
fn directory_helpers_write_one_file_per_record_and_load_back() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    save_collection_to_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &SaveCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: None,
        },
        &users(),
    )
    .unwrap();

    assert!(host.exists("/data/users/u1.json").unwrap());
    let loaded = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: None,
            migrations: vec![],
        },
        None,
    )
    .unwrap();
    assert_eq!(loaded, users());
}

#[test]
fn missing_extension_uses_storage_error_shape() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let err = load_data(
        &host,
        &formats,
        "/data/users",
        &user_schema(),
        LoadDataOptions::default(),
        None,
    )
    .unwrap_err();
    match err {
        EngineError::Storage(error) => {
            assert_eq!(error.operation, StorageOperation::Read);
            assert_eq!(error.path, "/data/users");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}
