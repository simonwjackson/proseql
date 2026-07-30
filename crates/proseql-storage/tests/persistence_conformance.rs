use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::{EngineError, StorageOperation};
use proseql_formats::FormatRegistry;
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::{
    append_data, dry_run_migrations, load_collection_from_directory, load_collections_from_file,
    load_data, save_collection_to_directory, save_collections_to_file, save_data,
    AppendDataOptions, DryRunCollectionResult, DryRunInput, LoadCollectionConfig, LoadDataOptions,
    MigrationHost, MigrationStep, SaveCollectionConfig, SaveDataOptions, ValidationMode,
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

#[derive(Default)]
struct NoopWatchHandle;

impl WatchHandle for NoopWatchHandle {
    fn stop(&self) -> Result<(), EngineError> {
        Ok(())
    }
}

#[derive(Default)]
struct CountingHost {
    inner: MemoryStorageHost,
    writes: Mutex<Vec<String>>,
    removes: Mutex<Vec<String>>,
    appends: Mutex<Vec<String>>,
    append_payloads: Mutex<Vec<String>>,
}

impl CountingHost {
    fn write_paths(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }

    fn remove_paths(&self) -> Vec<String> {
        self.removes.lock().unwrap().clone()
    }

    fn append_paths(&self) -> Vec<String> {
        self.appends.lock().unwrap().clone()
    }

    fn append_payloads(&self) -> Vec<String> {
        self.append_payloads.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct FailingAppendHost {
    inner: MemoryStorageHost,
    append_calls: Mutex<Vec<(String, String)>>,
}

impl FailingAppendHost {
    fn append_calls(&self) -> Vec<(String, String)> {
        self.append_calls.lock().unwrap().clone()
    }
}

impl StorageHost for FailingAppendHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }

    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.write(path, data)
    }

    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.append_calls
            .lock()
            .unwrap()
            .push((path.to_owned(), data.to_owned()));
        Err(EngineError::Storage(Box::new(
            proseql_engine::errors::StorageError {
                path: path.to_owned(),
                operation: StorageOperation::Write,
                message: "append failed".to_owned(),
                cause: None,
            },
        )))
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

    fn list_directory(&self, dir_path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(dir_path)
    }

    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(root_path)
    }

    fn watch(
        &self,
        _path: &str,
        _on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Ok(Box::new(NoopWatchHandle))
    }

    fn watch_dir(
        &self,
        _path: &str,
        _on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Ok(Box::new(NoopWatchHandle))
    }
}

impl StorageHost for CountingHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }

    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.writes.lock().unwrap().push(path.to_owned());
        self.inner.write(path, data)
    }

    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.appends.lock().unwrap().push(path.to_owned());
        self.append_payloads.lock().unwrap().push(data.to_owned());
        self.inner.append(path, data)
    }

    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.inner.exists(path)
    }

    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.removes.lock().unwrap().push(path.to_owned());
        self.inner.remove(path)
    }

    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.inner.ensure_dir(path)
    }

    fn list_directory(&self, dir_path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(dir_path)
    }

    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(root_path)
    }

    fn watch(
        &self,
        _path: &str,
        _on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Ok(Box::new(NoopWatchHandle))
    }

    fn watch_dir(
        &self,
        _path: &str,
        _on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Ok(Box::new(NoopWatchHandle))
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
fn path_mode_migration_stamps_enclosing_version_and_runs_only_once() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/db.json",
        r#"{"meta":{"owner":"ops"},"collections":{"users":[{"id":"u1","name":"Alice","age":30}]}}"#,
    )
    .unwrap();
    let calls = Arc::new(Mutex::new(0usize));
    let migration_host = TestMigrationHost::default()
        .with_callback("users-0-1", |data| Ok(data.clone()))
        .with_callback("users-1-2", {
            let calls = Arc::clone(&calls);
            move |data| {
                *calls.lock().unwrap() += 1;
                let mut out = data.clone();
                if let Some(Value::Object(user)) = out.get_mut("u1") {
                    let age = user.get("age").and_then(Value::as_i64).unwrap_or(0);
                    user.insert("age".into(), json!(age + 1));
                }
                Ok(out)
            }
        });

    let first = load_data(
        &host,
        &formats,
        "/data/db.json",
        &user_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".to_owned()),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".to_owned(),
                },
            ],
            path: Some("collections.users".to_owned()),
            ..LoadDataOptions::default()
        },
        Some(&migration_host),
    )
    .unwrap();
    assert_eq!(first["u1"]["age"], json!(31));
    assert_eq!(*calls.lock().unwrap(), 1);

    let written: Value = serde_json::from_str(&host.read("/data/db.json").unwrap()).unwrap();
    assert_eq!(written["meta"]["owner"], json!("ops"));
    assert_eq!(written["_version"], json!(2));
    assert!(written["collections"]["users"].is_array());

    let second = load_data(
        &host,
        &formats,
        "/data/db.json",
        &user_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".to_owned()),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".to_owned(),
                },
            ],
            path: Some("collections.users".to_owned()),
            ..LoadDataOptions::default()
        },
        Some(&migration_host),
    )
    .unwrap();
    assert_eq!(second["u1"]["age"], json!(31));
    assert_eq!(*calls.lock().unwrap(), 1);
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
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "items-v1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "items-v2".to_owned(),
                },
            ],
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
fn append_data_batches_all_records_into_one_host_append_call() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/data/events.jsonl", "existing\n").unwrap();
    host.appends.lock().unwrap().clear();
    host.append_payloads.lock().unwrap().clear();

    append_data(
        &host,
        &formats,
        "/data/events.jsonl",
        &user_schema(),
        &IndexMap::from([
            ("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30})),
            ("u2".to_owned(), json!({"id":"u2","name":"Bob","age":25})),
        ]),
        AppendDataOptions::default(),
    )
    .unwrap();

    assert_eq!(host.append_paths(), vec!["/data/events.jsonl".to_owned()]);
    assert_eq!(
        host.append_payloads(),
        vec!["{\"id\":\"u1\",\"name\":\"Alice\",\"age\":30}\n{\"id\":\"u2\",\"name\":\"Bob\",\"age\":25}\n".to_owned()]
    );
    assert_eq!(
        host.read("/data/events.jsonl").unwrap(),
        "existing\n{\"id\":\"u1\",\"name\":\"Alice\",\"age\":30}\n{\"id\":\"u2\",\"name\":\"Bob\",\"age\":25}\n"
    );
}

#[test]
fn append_data_append_failure_is_single_call_and_leaves_file_unchanged() {
    let host = FailingAppendHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/data/events.jsonl", "existing\n").unwrap();

    let error = append_data(
        &host,
        &formats,
        "/data/events.jsonl",
        &user_schema(),
        &IndexMap::from([
            ("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30})),
            ("u2".to_owned(), json!({"id":"u2","name":"Bob","age":25})),
        ]),
        AppendDataOptions::default(),
    )
    .unwrap_err();

    match error {
        EngineError::Storage(error) => {
            assert_eq!(error.path, "/data/events.jsonl");
            assert_eq!(error.operation, StorageOperation::Write);
            assert_eq!(error.message, "append failed");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(
        host.append_calls(),
        vec![(
            "/data/events.jsonl".to_owned(),
            "{\"id\":\"u1\",\"name\":\"Alice\",\"age\":30}\n{\"id\":\"u2\",\"name\":\"Bob\",\"age\":25}\n".to_owned(),
        )]
    );
    assert_eq!(host.read("/data/events.jsonl").unwrap(), "existing\n");
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
fn append_data_preflights_all_records_before_any_append() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/data/events.jsonl", "existing\n").unwrap();
    host.appends.lock().unwrap().clear();

    let data = IndexMap::from([
        ("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30})),
        (
            "u2".to_owned(),
            json!({"id":"u2","name":"Bob","age":"oops"}),
        ),
    ]);

    let error = append_data(
        &host,
        &formats,
        "/data/events.jsonl",
        &user_schema(),
        &data,
        AppendDataOptions::default(),
    )
    .unwrap_err();

    assert!(matches!(error, EngineError::Validation(_)));
    assert!(host.append_paths().is_empty());
    assert_eq!(host.read("/data/events.jsonl").unwrap(), "existing\n");
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
    let migration_host = TestMigrationHost::default()
        .with_callback("scores-0-1", |data| Ok(data.clone()))
        .with_callback("scores-1-2", |data| {
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
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "scores-0-1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "scores-1-2".to_owned(),
                },
            ],
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
fn directory_sidecars_at_any_depth_are_metadata_for_load_and_dry_run() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users/u1.json",
        r#"{"id":"u1","name":"Alice","age":30}"#,
    )
    .unwrap();
    host.write("/data/users/nested/._version.json", r#"{"_version":99}"#)
        .unwrap();

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
    assert_eq!(
        loaded,
        IndexMap::from([("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30}),)])
    );

    host.write("/data/empty/nested/._version.json", r#"{"_version":77}"#)
        .unwrap();

    let dry_run = dry_run_migrations(
        &host,
        &formats,
        &[DryRunInput::Directory {
            dir_path: "/data/empty".to_owned(),
            extension: "json".to_owned(),
            collection: LoadCollectionConfig {
                name: "empty".to_owned(),
                schema: user_schema(),
                id_strategy: IdStrategy::Provided,
                version: Some(1),
                migrations: vec![MigrationStep {
                    from: 0,
                    to: 1,
                    description: Some("bootstrap".to_owned()),
                    callback_id: "empty-0-1".to_owned(),
                }],
            },
        }],
    )
    .unwrap();
    assert_eq!(
        dry_run.collections,
        vec![DryRunCollectionResult {
            name: "empty".to_owned(),
            file_path: "/data/empty/<json>".to_owned(),
            current_version: 0,
            target_version: 1,
            migrations_to_apply: vec![],
            status: proseql_storage::persistence::DryRunStatus::NoFile,
        }]
    );
}

#[test]
fn directory_mode_successful_migrations_write_back_after_validation_and_do_not_reapply() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users/u1.json",
        r#"{"id":"u1","name":"Alice","age":30}"#,
    )
    .unwrap();
    host.writes.lock().unwrap().clear();
    let calls = Arc::new(Mutex::new(0usize));
    let migration_host = TestMigrationHost::default().with_callback("users-0-1", {
        let calls = Arc::clone(&calls);
        move |data| {
            *calls.lock().unwrap() += 1;
            let mut out = data.clone();
            if let Some(Value::Object(user)) = out.get_mut("u1") {
                let age = user.get("age").and_then(Value::as_i64).unwrap_or(0);
                user.insert("age".into(), json!(age + 1));
            }
            Ok(out)
        }
    });

    let config = LoadCollectionConfig {
        name: "users".to_owned(),
        schema: user_schema(),
        id_strategy: IdStrategy::Provided,
        version: Some(1),
        migrations: vec![MigrationStep {
            from: 0,
            to: 1,
            description: None,
            callback_id: "users-0-1".to_owned(),
        }],
    };

    let loaded = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &config,
        Some(&migration_host),
    )
    .unwrap();

    assert_eq!(loaded["u1"]["age"], json!(31));
    assert_eq!(
        host.write_paths(),
        vec![
            "/data/users/u1.json".to_owned(),
            "/data/users/._version.json".to_owned(),
        ]
    );
    assert!(host.read("/data/users/u1.json").unwrap().contains("31"));
    assert_eq!(
        serde_json::from_str::<Value>(&host.read("/data/users/._version.json").unwrap()).unwrap(),
        json!({"_version": 1})
    );
    assert_eq!(*calls.lock().unwrap(), 1);

    host.writes.lock().unwrap().clear();
    let second = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &config,
        Some(&migration_host),
    )
    .unwrap();
    assert_eq!(second["u1"]["age"], json!(31));
    assert_eq!(*calls.lock().unwrap(), 1);
    assert!(host.write_paths().is_empty());
}

#[test]
fn directory_mode_migration_can_rename_and_split_records_remove_stale_originals_and_reload_stably()
{
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/users/u1.json",
        r#"{"id":"u1","name":"Alice","age":30}"#,
    )
    .unwrap();
    host.writes.lock().unwrap().clear();
    host.removes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default().with_callback("users-0-1", |data| {
        let Some(Value::Object(user)) = data.get("u1") else {
            panic!("expected u1 payload");
        };
        Ok(Map::from_iter([
            (
                "u1-renamed".to_owned(),
                json!({"id":"u1-renamed","name":user["name"],"age":31}),
            ),
            (
                "u1-shadow".to_owned(),
                json!({"id":"u1-shadow","name":"Alicia","age":29}),
            ),
        ]))
    });
    let config = LoadCollectionConfig {
        name: "users".to_owned(),
        schema: user_schema(),
        id_strategy: IdStrategy::Provided,
        version: Some(1),
        migrations: vec![MigrationStep {
            from: 0,
            to: 1,
            description: None,
            callback_id: "users-0-1".to_owned(),
        }],
    };

    let loaded = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &config,
        Some(&migration_host),
    )
    .unwrap();

    assert_eq!(
        loaded.keys().cloned().collect::<Vec<_>>(),
        vec!["u1-renamed", "u1-shadow"]
    );
    assert_eq!(loaded["u1-renamed"]["age"], json!(31));
    assert_eq!(loaded["u1-shadow"]["age"], json!(29));
    assert_eq!(
        host.write_paths(),
        vec![
            "/data/users/u1-renamed.json".to_owned(),
            "/data/users/u1-shadow.json".to_owned(),
            "/data/users/._version.json".to_owned(),
        ]
    );
    assert_eq!(host.remove_paths(), vec!["/data/users/u1.json".to_owned()]);
    assert!(!host.exists("/data/users/u1.json").unwrap());
    assert!(host.exists("/data/users/u1-renamed.json").unwrap());
    assert!(host.exists("/data/users/u1-shadow.json").unwrap());

    host.writes.lock().unwrap().clear();
    host.removes.lock().unwrap().clear();
    let reloaded = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &config,
        Some(&migration_host),
    )
    .unwrap();
    assert_eq!(reloaded, loaded);
    assert!(host.write_paths().is_empty());
    assert!(host.remove_paths().is_empty());
}

#[test]
fn directory_mode_migration_detects_output_collisions_before_writes_or_removals() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original_u1 = r#"{"id":"u1","name":"Alice","age":30}"#;
    let original_u2 = r#"{"id":"u2","name":"Bob","age":25}"#;
    host.write("/data/users/u1.json", original_u1).unwrap();
    host.write("/data/users/u2.json", original_u2).unwrap();
    host.writes.lock().unwrap().clear();
    host.removes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default().with_callback("users-0-1", |_data| {
        Ok(Map::from_iter([(
            "shared".to_owned(),
            json!({"id":"shared","name":"Collision","age":99}),
        )]))
    });

    let error = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: Some(1),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "users-0-1".to_owned(),
            }],
        },
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Storage(error) => {
            assert_eq!(error.operation, StorageOperation::Write);
            assert!(error.message.contains("collision"), "{}", error.message);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(host.write_paths().is_empty());
    assert!(host.remove_paths().is_empty());
    assert_eq!(host.read("/data/users/u1.json").unwrap(), original_u1);
    assert_eq!(host.read("/data/users/u2.json").unwrap(), original_u2);
    assert!(!host.exists("/data/users/._version.json").unwrap());
}

#[test]
fn directory_mode_multi_file_failure_does_not_partially_write_successful_earlier_migrations() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original_u1 = r#"{"id":"u1","name":"Alice","age":30}"#;
    let original_u2 = r#"{"id":"u2","name":"Bob","age":25}"#;
    host.write("/data/users/u1.json", original_u1).unwrap();
    host.write("/data/users/u2.json", original_u2).unwrap();
    host.writes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default().with_callback("users-0-1", |data| {
        let mut out = data.clone();
        if let Some(Value::Object(user)) = out.get_mut("u1") {
            let age = user.get("age").and_then(Value::as_i64).unwrap_or(0);
            user.insert("age".into(), json!(age + 1));
        }
        if let Some(Value::Object(user)) = out.get_mut("u2") {
            user.remove("age");
        }
        Ok(out)
    });

    let error = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: Some(1),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "users-0-1".to_owned(),
            }],
        },
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.reason, "post-migration-validation-failed");
            assert_eq!(error.from_version, 0);
            assert_eq!(error.to_version, 1);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/users/u1.json").unwrap(), original_u1);
    assert_eq!(host.read("/data/users/u2.json").unwrap(), original_u2);
    assert!(host.write_paths().is_empty());
}

#[test]
fn post_migration_validation_failure_is_wrapped_and_does_not_write_back_for_single_file() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = r#"{"_version":1,"u1":{"id":"u1","name":"Alice","age":30}}"#;
    host.write("/data/users.json", original).unwrap();
    host.write_paths();
    host.writes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default()
        .with_callback("users-0-1", |data| Ok(data.clone()))
        .with_callback("users-1-2", |data| {
            let mut out = data.clone();
            if let Some(Value::Object(user)) = out.get_mut("u1") {
                user.remove("age");
            }
            Ok(out)
        });

    let error = load_data(
        &host,
        &formats,
        "/data/users.json",
        &user_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".to_owned()),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".to_owned(),
                },
            ],
            ..LoadDataOptions::default()
        },
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.from_version, 1);
            assert_eq!(error.to_version, 2);
            assert_eq!(error.step, -1);
            assert_eq!(error.reason, "post-migration-validation-failed");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/users.json").unwrap(), original);
    assert!(host.write_paths().is_empty());
}

#[test]
fn post_migration_validation_failure_is_wrapped_and_does_not_write_back_for_directory_mode() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = r#"{"name":"Alice","age":30}"#;
    host.write("/data/users/u1.json", original).unwrap();
    host.writes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default().with_callback("users-0-1", |data| {
        let mut out = data.clone();
        if let Some(Value::Object(user)) = out.get_mut("u1") {
            user.remove("age");
        }
        Ok(out)
    });

    let error = load_collection_from_directory(
        &host,
        &formats,
        "/data/users",
        "json",
        &LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: Some(1),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "users-0-1".to_owned(),
            }],
        },
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.from_version, 0);
            assert_eq!(error.to_version, 1);
            assert_eq!(error.step, -1);
            assert_eq!(error.reason, "post-migration-validation-failed");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/users/u1.json").unwrap(), original);
    assert!(host.write_paths().is_empty());
}

#[test]
fn multi_collection_load_writes_back_once_after_all_migrations_and_preserves_siblings() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/db.yaml",
        "meta:\n  owner: ops\nusers:\n  _version: 1\n  u1:\n    id: u1\n    name: Alice\n    age: 30\ngames:\n  _version: 1\n  smw:\n    name: SMW\n    systemId: snes\n",
    )
    .unwrap();
    host.writes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default()
        .with_callback("users-0-1", |data| Ok(data.clone()))
        .with_callback("users-1-2", |data| Ok(data.clone()))
        .with_callback("games-0-1", |data| Ok(data.clone()))
        .with_callback("games-1-2", |data| Ok(data.clone()));

    let loaded = load_collections_from_file(
        &host,
        &formats,
        "/data/db.yaml",
        &[
            LoadCollectionConfig {
                name: "users".to_owned(),
                schema: user_schema(),
                id_strategy: IdStrategy::Provided,
                version: Some(2),
                migrations: vec![
                    MigrationStep {
                        from: 0,
                        to: 1,
                        description: None,
                        callback_id: "users-0-1".to_owned(),
                    },
                    MigrationStep {
                        from: 1,
                        to: 2,
                        description: None,
                        callback_id: "users-1-2".to_owned(),
                    },
                ],
            },
            LoadCollectionConfig {
                name: "games".to_owned(),
                schema: payload_only_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(2),
                migrations: vec![
                    MigrationStep {
                        from: 0,
                        to: 1,
                        description: None,
                        callback_id: "games-0-1".to_owned(),
                    },
                    MigrationStep {
                        from: 1,
                        to: 2,
                        description: None,
                        callback_id: "games-1-2".to_owned(),
                    },
                ],
            },
        ],
        Some(&migration_host),
    )
    .unwrap();

    assert_eq!(loaded["users"]["u1"]["age"], json!(30));
    assert_eq!(loaded["games"]["smw"]["id"], json!("smw"));
    assert_eq!(host.write_paths(), vec!["/data/db.yaml".to_owned()]);
    let written = host.read("/data/db.yaml").unwrap();
    assert!(written.contains("owner: ops"), "{written}");
    assert!(written.contains("_version: 2"), "{written}");
}

#[test]
fn multi_collection_post_migration_validation_failure_is_wrapped_and_does_not_write_back() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = "meta:\n  owner: ops\nusers:\n  _version: 1\n  u1:\n    id: u1\n    name: Alice\n    age: 30\n";
    host.write("/data/db.yaml", original).unwrap();
    host.writes.lock().unwrap().clear();
    let migration_host = TestMigrationHost::default()
        .with_callback("users-0-1", |data| Ok(data.clone()))
        .with_callback("users-1-2", |data| {
            let mut out = data.clone();
            if let Some(Value::Object(user)) = out.get_mut("u1") {
                user.remove("age");
            }
            Ok(out)
        });

    let error = load_collections_from_file(
        &host,
        &formats,
        "/data/db.yaml",
        &[LoadCollectionConfig {
            name: "users".to_owned(),
            schema: user_schema(),
            id_strategy: IdStrategy::Provided,
            version: Some(2),
            migrations: vec![
                MigrationStep {
                    from: 0,
                    to: 1,
                    description: None,
                    callback_id: "users-0-1".to_owned(),
                },
                MigrationStep {
                    from: 1,
                    to: 2,
                    description: None,
                    callback_id: "users-1-2".to_owned(),
                },
            ],
        }],
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.from_version, 1);
            assert_eq!(error.to_version, 2);
            assert_eq!(error.step, -1);
            assert_eq!(error.reason, "post-migration-validation-failed");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/db.yaml").unwrap(), original);
    assert!(host.write_paths().is_empty());
}

#[test]
fn incomplete_migration_registry_fails_before_writeback_and_never_stamps_target_version() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = r#"{"u1":{"id":"u1","name":"Alice","age":30}}"#;
    host.write("/data/users.json", original).unwrap();
    host.writes.lock().unwrap().clear();
    let migration_host =
        TestMigrationHost::default().with_callback("users-0-1", |data| Ok(data.clone()));

    let error = load_data(
        &host,
        &formats,
        "/data/users.json",
        &user_schema(),
        LoadDataOptions {
            version: Some(2),
            collection_name: Some("users".to_owned()),
            migrations: vec![MigrationStep {
                from: 0,
                to: 1,
                description: None,
                callback_id: "users-0-1".to_owned(),
            }],
            ..LoadDataOptions::default()
        },
        Some(&migration_host),
    )
    .unwrap_err();

    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.reason, "version-mismatch");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(host.read("/data/users.json").unwrap(), original);
    assert!(host.write_paths().is_empty());
}

#[test]
fn dry_run_migrations_reports_all_statuses_without_writes_or_callbacks() {
    let host = CountingHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/data/needs.json",
        r#"{"_version":1,"u1":{"id":"u1","name":"Alice","age":30}}"#,
    )
    .unwrap();
    host.write(
        "/data/up-to-date.json",
        r#"{"_version":2,"u1":{"id":"u1","name":"Alice","age":30}}"#,
    )
    .unwrap();
    host.write(
        "/data/ahead.json",
        r#"{"_version":3,"u1":{"id":"u1","name":"Alice","age":30}}"#,
    )
    .unwrap();
    host.writes.lock().unwrap().clear();

    let result = dry_run_migrations(
        &host,
        &formats,
        &[
            DryRunInput::SingleFile {
                file_path: "/data/needs.json".to_owned(),
                collection: LoadCollectionConfig {
                    name: "needs".to_owned(),
                    schema: user_schema(),
                    id_strategy: IdStrategy::Provided,
                    version: Some(2),
                    migrations: vec![
                        MigrationStep {
                            from: 0,
                            to: 1,
                            description: Some("bootstrap".to_owned()),
                            callback_id: "needs-0-1".to_owned(),
                        },
                        MigrationStep {
                            from: 1,
                            to: 2,
                            description: Some("bump".to_owned()),
                            callback_id: "needs-1-2".to_owned(),
                        },
                    ],
                },
            },
            DryRunInput::SingleFile {
                file_path: "/data/up-to-date.json".to_owned(),
                collection: LoadCollectionConfig {
                    name: "up-to-date".to_owned(),
                    schema: user_schema(),
                    id_strategy: IdStrategy::Provided,
                    version: Some(2),
                    migrations: vec![
                        MigrationStep {
                            from: 0,
                            to: 1,
                            description: Some("bootstrap".to_owned()),
                            callback_id: "unused-0-1".to_owned(),
                        },
                        MigrationStep {
                            from: 1,
                            to: 2,
                            description: Some("unused".to_owned()),
                            callback_id: "unused".to_owned(),
                        },
                    ],
                },
            },
            DryRunInput::SingleFile {
                file_path: "/data/ahead.json".to_owned(),
                collection: LoadCollectionConfig {
                    name: "ahead".to_owned(),
                    schema: user_schema(),
                    id_strategy: IdStrategy::Provided,
                    version: Some(2),
                    migrations: vec![
                        MigrationStep {
                            from: 0,
                            to: 1,
                            description: Some("bootstrap".to_owned()),
                            callback_id: "unused-0-1".to_owned(),
                        },
                        MigrationStep {
                            from: 1,
                            to: 2,
                            description: Some("unused".to_owned()),
                            callback_id: "unused".to_owned(),
                        },
                    ],
                },
            },
            DryRunInput::SingleFile {
                file_path: "/data/no-file.json".to_owned(),
                collection: LoadCollectionConfig {
                    name: "no-file".to_owned(),
                    schema: user_schema(),
                    id_strategy: IdStrategy::Provided,
                    version: Some(2),
                    migrations: vec![
                        MigrationStep {
                            from: 0,
                            to: 1,
                            description: Some("bootstrap".to_owned()),
                            callback_id: "unused-0-1".to_owned(),
                        },
                        MigrationStep {
                            from: 1,
                            to: 2,
                            description: Some("unused".to_owned()),
                            callback_id: "unused".to_owned(),
                        },
                    ],
                },
            },
        ],
    )
    .unwrap();

    assert_eq!(
        result.collections,
        vec![
            DryRunCollectionResult {
                name: "needs".to_owned(),
                file_path: "/data/needs.json".to_owned(),
                current_version: 1,
                target_version: 2,
                migrations_to_apply: vec![proseql_storage::persistence::DryRunMigration {
                    from: 1,
                    to: 2,
                    description: Some("bump".to_owned()),
                }],
                status: proseql_storage::persistence::DryRunStatus::NeedsMigration,
            },
            DryRunCollectionResult {
                name: "up-to-date".to_owned(),
                file_path: "/data/up-to-date.json".to_owned(),
                current_version: 2,
                target_version: 2,
                migrations_to_apply: vec![],
                status: proseql_storage::persistence::DryRunStatus::UpToDate,
            },
            DryRunCollectionResult {
                name: "ahead".to_owned(),
                file_path: "/data/ahead.json".to_owned(),
                current_version: 3,
                target_version: 2,
                migrations_to_apply: vec![],
                status: proseql_storage::persistence::DryRunStatus::Ahead,
            },
            DryRunCollectionResult {
                name: "no-file".to_owned(),
                file_path: "/data/no-file.json".to_owned(),
                current_version: 0,
                target_version: 2,
                migrations_to_apply: vec![],
                status: proseql_storage::persistence::DryRunStatus::NoFile,
            },
        ]
    );
    assert!(host.write_paths().is_empty());
}

#[test]
fn callback_backed_plugin_codec_round_trips_non_builtin_extension_through_storage() {
    let host = MemoryStorageHost::default();
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_codec_encode(
        "upper-encode",
        Box::new(|value, _| {
            let record = value
                .as_object()
                .and_then(|root| root.get("u1"))
                .and_then(Value::as_object)
                .expect("object-keyed record");
            Ok(format!("NAME={}", record["name"].as_str().unwrap()))
        }),
    );
    callbacks.register_codec_decode(
        "upper-decode",
        Box::new(|raw: &str| {
            let name = raw.strip_prefix("NAME=").unwrap_or(raw);
            Ok(json!({"u1":{"id":"u1","name":name,"age":30}}))
        }),
    );
    let formats = proseql_formats::format_registry_with_plugin_codecs(
        Arc::new(callbacks),
        &[proseql_engine::plugins::PluginCodecMetadata {
            name: "upper".to_owned(),
            extensions: vec!["upper".to_owned()],
            encode_callback_id: "upper-encode".to_owned(),
            decode_callback_id: "upper-decode".to_owned(),
        }],
    );
    let data = IndexMap::from([("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30}))]);

    save_data(
        &host,
        &formats,
        "/data/users.upper",
        &user_schema(),
        &data,
        SaveDataOptions::default(),
    )
    .unwrap();
    assert_eq!(host.read("/data/users.upper").unwrap(), "NAME=Alice");

    let loaded = load_data(
        &host,
        &formats,
        "/data/users.upper",
        &user_schema(),
        LoadDataOptions::default(),
        None,
    )
    .unwrap();
    assert_eq!(loaded, data);
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
