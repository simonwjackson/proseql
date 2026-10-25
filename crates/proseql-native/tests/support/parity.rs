//! Differential harness: run the same operation on the same files under
//! an eager and a lazy runtime, and require the
//! same answer (values exactly, errors by tag and payload).
//!
//! The fixture is Logbook-shaped and synthetic: per-minute samples of two
//! metrics in UTC-month JSONL partitions, an ordered index on `atUtc`, an
//! equality index on `metric`, `append_only`, `duplicate_ids:
//! ignore_identical`, and a lazy policy (`max_loaded_partitions = 1`).

use std::fmt::Debug;
use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, IndexDescriptor, SchemaNode, StructField,
    ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_native::{
    FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use serde_json::{json, Value};

/// Test-only configuration choice. Eager and lazy runtimes use the same files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Eager,
    Lazy,
}

pub const SOURCE: &str = "samples";
pub const COLLECTION: &str = "samples";
pub const METRICS: [&str; 2] = ["steps", "heartRate"];

/// Months written by [`ParityFixture::new`]: (YYYY-MM, days).
pub const MONTHS: [(&str, u32); 3] = [("2025-01", 31), ("2025-02", 28), ("2025-03", 31)];

pub fn descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: COLLECTION.into(),
        schema: SchemaNode::Struct {
            fields: [
                ("id", SchemaNode::Str),
                ("metric", SchemaNode::Str),
                ("value", SchemaNode::Num),
                ("atUtc", SchemaNode::Str),
                ("dateUtc", SchemaNode::Str),
                ("source", SchemaNode::Str),
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
        indexes: vec![IndexDescriptor::Single("metric".into())],
        ordered_indexes: vec!["atUtc".into()],
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
        append_only: true,
        duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
        validation_mode: ValidationMode::Strict,
    }
}

/// One synthetic sample. `minute` counts minutes from the start of the day.
pub fn sample(month: &str, day: u32, minute: u32, metric: &str) -> Value {
    let date = format!("{month}-{day:02}");
    let at = format!("{date}T{:02}:{:02}:00.000Z", minute / 60, minute % 60);
    let value = f64::from((day * 7919 + minute * 31 + metric.len() as u32 * 13) % 997) / 10.0;
    json!({
        "id": format!("{metric}:{at}"),
        "metric": metric,
        "value": value,
        "atUtc": at,
        "dateUtc": date,
        "source": if minute.is_multiple_of(2) { "watch" } else { "phone" },
    })
}

pub struct ParityFixture {
    dir: tempfile::TempDir,
}

impl ParityFixture {
    /// [`MONTHS`], one sample per metric every `step_minutes` minutes.
    pub fn new(step_minutes: u32) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let fixture = Self { dir };
        fs::create_dir_all(fixture.root()).expect("partition root");
        for (month, days) in MONTHS {
            let mut text = String::new();
            for day in 1..=days {
                for minute in (0..24 * 60).step_by(step_minutes as usize) {
                    for metric in METRICS {
                        text.push_str(&sample(month, day, minute, metric).to_string());
                        text.push('\n');
                    }
                }
            }
            fs::write(fixture.partition_path(month), text).expect("partition file");
        }
        fixture
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn root(&self) -> PathBuf {
        self.dir.path().join(SOURCE)
    }

    /// The file of a `TimeBucket::Month` partition (`<root>/<YYYY-MM>.jsonl`).
    pub fn partition_path(&self, month: &str) -> PathBuf {
        self.root().join(format!("{month}.jsonl"))
    }

    pub fn config(&self) -> NativeSourceRuntimeConfig {
        NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(descriptor())],
            sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: SOURCE.into(),
                collection: COLLECTION.into(),
                root: self.root().to_string_lossy().into_owned(),
                format: "jsonl".into(),
                partition_by: PartitionKey::TimeBucket {
                    field: "atUtc".into(),
                    bucket: TimeBucket::Month,
                },
                prose: None,
            })],
        }
    }

    pub fn options(&self, model: RuntimeKind) -> NativeSourceRuntimeOptions {
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            lazy_partitions: if model == RuntimeKind::Lazy {
                IndexMap::from([(
                    SOURCE.to_owned(),
                    LazyPartitionPolicy {
                        max_loaded_partitions: 1,
                        full_scan: FullScanPolicy::Allow,
                    },
                )])
            } else {
                IndexMap::new()
            },
            ..Default::default()
        }
    }

    pub fn open(&self, model: RuntimeKind) -> NativeRuntime {
        self.try_open(model).expect("open fixture runtime")
    }

    pub fn try_open(&self, model: RuntimeKind) -> Result<NativeRuntime, EngineError> {
        NativeRuntime::open_sources_with_options(self.config(), self.options(model))
    }

    /// Run `op` on a fresh runtime of each model over the same files and
    /// require the same result. Returns the agreed result.
    ///
    /// Each model gets its own copy of the files, so a write under one model
    /// cannot change what the other sees.
    pub fn assert_same<T, F>(&self, op: F) -> Result<T, EngineError>
    where
        T: PartialEq + Debug,
        F: Fn(&NativeRuntime) -> Result<T, EngineError>,
    {
        let resident_copy = self.copy();
        let streaming_copy = self.copy();
        // Eager validates files during open; lazy validates during the operation.
        // SourceConfig paths identify different temporary copies. Existing
        // error tests compare all other payload fields, not those roots.
        let normalize = |mut error| {
            if let EngineError::SourceConfig(ref mut source) = error {
                source.path = None;
            }
            error
        };
        let resident = resident_copy
            .try_open(RuntimeKind::Eager)
            .and_then(|runtime| op(&runtime))
            .map_err(normalize);
        let streaming = streaming_copy
            .try_open(RuntimeKind::Lazy)
            .and_then(|runtime| op(&runtime))
            .map_err(normalize);
        assert_eq!(
            resident, streaming,
            "Eager and lazy disagree (left: eager, right: lazy)"
        );
        resident
    }

    /// An independent copy of the fixture files.
    pub fn copy(&self) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let copy = Self { dir };
        fs::create_dir_all(copy.root()).expect("partition root");
        for entry in fs::read_dir(self.root()).expect("read root") {
            let entry = entry.expect("dir entry");
            fs::copy(entry.path(), copy.root().join(entry.file_name())).expect("copy partition");
        }
        copy
    }
}
