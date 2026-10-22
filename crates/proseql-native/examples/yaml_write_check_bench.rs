//! Cost of the YAML write check on a large partition.
//!
//! Builds a synthetic meal log (one YAML partition of about `--lines` lines,
//! lists of items with long free-text fields) and measures, with the check
//! on and off:
//!
//! - `serialize`: `FormatRegistry::serialize` of the whole partition;
//! - `create`: one `NativeRuntime::mutate` create into that partition, which
//!   re-encodes the partition and replaces the file durably (fsync).
//!
//! Run in release mode:
//!
//! ```sh
//! cargo run --release --manifest-path crates/Cargo.toml -p proseql-native \
//!   --example yaml_write_check_bench -- --lines 8000 --runs 30
//! ```
//!
//! All data is synthetic.

use std::path::Path;
use std::time::{Duration, Instant};

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_formats::FormatRegistry;
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig};
use serde_json::{json, Map, Value};

const WORDS: &[&str] = &[
    "oat",
    "milk",
    "two",
    "tbsp",
    "peanut",
    "butter",
    "toast",
    "sourdough",
    "grilled",
    "chicken",
    "breast",
    "salad",
    "olive",
    "oil",
    "rice",
    "steamed",
    "broccoli",
    "banana",
    "greek",
    "yogurt",
];

fn food(seed: usize) -> String {
    let count = 4 + seed % 14;
    (0..count)
        .map(|index| WORDS[(seed * 7 + index * 3) % WORDS.len()])
        .collect::<Vec<_>>()
        .join(" ")
}

fn meal(index: usize) -> Value {
    json!({
        "id": format!("2026.meal-{index:05}"),
        "items": (0..3)
            .map(|item| json!({"food": food(index * 3 + item), "quantity": 1.0 + item as f64 / 2.0}))
            .collect::<Vec<_>>(),
    })
}

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

fn formats(check: bool) -> FormatRegistry {
    let mut formats = FormatRegistry::with_builtins();
    formats.set_write_check(check);
    formats
}

/// `min / median` in milliseconds. The minimum is the least disturbed by
/// other load on the machine.
fn summary(mut samples: Vec<Duration>) -> String {
    samples.sort();
    let ms = |duration: Duration| duration.as_secs_f64() * 1000.0;
    format!(
        "min {:.2} ms, median {:.2} ms",
        ms(samples[0]),
        ms(samples[samples.len() / 2])
    )
}

fn arg(name: &str, default: usize) -> usize {
    let args = std::env::args().collect::<Vec<_>>();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let target_lines = arg("--lines", 8000);
    let runs = arg("--runs", 30);

    // Grow the partition until its encoding reaches the target line count.
    let mut records = Map::new();
    let mut count = 0;
    let document = loop {
        let record = meal(count);
        records.insert(record["id"].as_str().unwrap().to_owned(), record);
        count += 1;
        if count % 50 == 0 {
            let text = formats(false)
                .serialize(&Value::Object(records.clone()), "yaml", None)
                .unwrap();
            if text.lines().count() >= target_lines {
                break text;
            }
        }
    };
    let value = Value::Object(records.clone());
    println!(
        "partition: {count} meals, {} lines, {} bytes",
        document.lines().count(),
        document.len()
    );

    for check in [false, true] {
        let registry = formats(check);
        let samples = (0..runs)
            .map(|_| {
                let start = Instant::now();
                registry.serialize(&value, "yaml", None).unwrap();
                start.elapsed()
            })
            .collect();
        println!("serialize check={check}: {}", summary(samples));
    }

    for check in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = NativeRuntime::open_sources_with_options(
            config(dir.path()),
            NativeSourceRuntimeOptions {
                formats: formats(check),
                watch_debounce: None,
                ..NativeSourceRuntimeOptions::default()
            },
        )
        .unwrap();
        let seed = records.values().cloned().collect::<Vec<_>>();
        runtime
            .mutate(|db| {
                for record in &seed {
                    db.create("meals", record.clone())?;
                }
                Ok(())
            })
            .unwrap();
        let samples = (0..runs)
            .map(|run| {
                let record = meal(count + run);
                let start = Instant::now();
                runtime.mutate(|db| db.create("meals", record)).unwrap();
                start.elapsed()
            })
            .collect();
        println!(
            "create (encode + durable replace) check={check}: {}",
            summary(samples)
        );
        runtime.close().unwrap();
    }
}
