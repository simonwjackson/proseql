//! YAML writes through the native runtime always leave files it can open.
//!
//! The shape matches the production failure: a partitioned YAML collection
//! of meals, one file per year, each meal with a list of items and a long
//! free-text `food` field. All data is synthetic.

use std::fs;
use std::path::Path;

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_formats::codecs::yaml_codec;
use proseql_formats::{FormatCodec, FormatOptions, FormatRegistry, ROUND_TRIP_MISMATCH};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig};
use serde_json::{json, Value};

const LONG_FOOD: &str =
    "aaaa bbbbb cccccccc ddddddddd eeeee fffffffffff gggg hhhh iiiiii jjjjj kkk lll mmmm nnnnn ooo";

fn field(name: &str, schema: SchemaNode) -> StructField {
    StructField {
        name: name.into(),
        schema,
    }
}

fn config(root: &Path) -> NativeSourceRuntimeConfig {
    let item = SchemaNode::Struct {
        fields: vec![
            field("food", SchemaNode::Str),
            field("quantity", SchemaNode::Num),
        ],
    };
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "meals".into(),
            schema: SchemaNode::Struct {
                fields: vec![
                    field("id", SchemaNode::Str),
                    field(
                        "items",
                        SchemaNode::Array {
                            item: Box::new(item),
                        },
                    ),
                ],
            },
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
            validation_mode: ValidationMode::Strict,
        })],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: "meals".into(),
            collection: "meals".into(),
            root: root.join("meals").to_string_lossy().into_owned(),
            format: "yaml".into(),
            partition_by: PartitionKey::Prefix {
                field: "id".into(),
                delimiter: ".".into(),
            },
            prose: None,
        })],
    }
}

fn open(root: &Path, formats: FormatRegistry) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(
        config(root),
        NativeSourceRuntimeOptions {
            formats,
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
    .unwrap()
}

fn meal(id: &str, foods: &[&str]) -> Value {
    json!({
        "id": id,
        "items": foods
            .iter()
            .map(|food| json!({"food": food, "quantity": 1.0}))
            .collect::<Vec<_>>(),
    })
}

/// Damages its output when a string holds `BREAK`, the way the old wrapping
/// bug did: a folded line lands on its key's column.
struct BrokenYaml;

impl FormatCodec for BrokenYaml {
    fn name(&self) -> &str {
        "yaml"
    }

    fn extensions(&self) -> &[&str] {
        &["yaml", "yml"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        let encoded = yaml_codec().encode(data, options)?;
        Ok(encoded.replace("BREAK", "BREAK\n        folded at the key column"))
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        yaml_codec().decode(raw)
    }

    fn round_trips_exactly(&self) -> bool {
        true
    }
}

fn broken_formats() -> FormatRegistry {
    let mut formats = FormatRegistry::with_builtins();
    formats.register(Box::new(BrokenYaml));
    formats
}

#[test]
fn long_first_item_fields_write_files_that_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path(), FormatRegistry::with_builtins());
    runtime
        .mutate(|db| {
            for index in 0..20 {
                db.create(
                    "meals",
                    meal(
                        &format!("2026.meal-{index:04}"),
                        &[LONG_FOOD, "tea", LONG_FOOD],
                    ),
                )?;
            }
            Ok(())
        })
        .unwrap();
    runtime.close().unwrap();
    let text = fs::read_to_string(dir.path().join("meals/2026.yaml")).unwrap();
    assert!(text.contains("  - food: aaaa"), "{text}");
    let runtime = open(dir.path(), FormatRegistry::with_builtins());
    assert_eq!(
        runtime
            .find_by_id("meals", "2026.meal-0019")
            .unwrap()
            .unwrap()["items"][2]["food"],
        LONG_FOOD
    );
}

#[test]
fn a_write_that_would_not_read_back_is_refused_and_leaves_the_file_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path(), FormatRegistry::with_builtins());
    runtime
        .mutate(|db| db.create("meals", meal("2026.meal-a", &["oats"])))
        .unwrap();
    runtime.close().unwrap();
    let path = dir.path().join("meals/2026.yaml");
    let before = fs::read(&path).unwrap();

    let runtime = open(dir.path(), broken_formats());
    let error = runtime
        .mutate(|db| db.create("meals", meal("2026.meal-b", &["BREAK"])))
        .unwrap_err();
    let EngineError::Serialization(error) = error else {
        panic!("expected SerializationError, got {error:?}");
    };
    assert_eq!(error.cause.as_ref().unwrap()["reason"], ROUND_TRIP_MISMATCH);
    assert_eq!(fs::read(&path).unwrap(), before, "file must be unchanged");
    assert!(runtime
        .find_by_id("meals", "2026.meal-b")
        .unwrap()
        .is_none());

    // Nothing reached disk, so the runtime is not quarantined: the next
    // good write succeeds.
    runtime
        .mutate(|db| db.create("meals", meal("2026.meal-c", &["rice"])))
        .unwrap();
    runtime.close().unwrap();

    let runtime = open(dir.path(), FormatRegistry::with_builtins());
    assert!(runtime
        .find_by_id("meals", "2026.meal-a")
        .unwrap()
        .is_some());
    assert!(runtime
        .find_by_id("meals", "2026.meal-b")
        .unwrap()
        .is_none());
    assert!(runtime
        .find_by_id("meals", "2026.meal-c")
        .unwrap()
        .is_some());
}

#[test]
fn a_refused_partition_stops_every_partition_of_the_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path(), broken_formats());
    let error = runtime
        .mutate(|db| {
            db.create("meals", meal("2025.meal-a", &["oats"]))?;
            db.create("meals", meal("2026.meal-b", &["BREAK"]))
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::Serialization(_)), "{error:?}");
    // Every partition is encoded and checked before the first write.
    assert!(!dir.path().join("meals/2025.yaml").exists());
    assert!(!dir.path().join("meals/2026.yaml").exists());
    assert!(runtime
        .find_by_id("meals", "2025.meal-a")
        .unwrap()
        .is_none());
}
