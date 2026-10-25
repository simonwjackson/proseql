//! Full-size stage-0 append shapes. Synthetic data only.
//! prepare ROOT creates 656,640 rows in both shapes; append ROOT MODEL SHAPE
//! times 1,000 new rows, with global checks under Streaming. Resident retains
//! its documented loaded/routed-only check (not global parity).
use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_native::{
    ExecutionModel, FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::time::Instant;

type Error = Box<dyn std::error::Error + Send + Sync>;
fn engine_error(error: proseql_engine::errors::EngineError) -> Error {
    format!("{}: {error}", error.tag()).into()
}
const DAYS: [usize; 10] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31];

// Copied from bench/stage0/src/fixture.rs so that each logical record and
// the strict new-ID batch match the SQLite acceptance fixture exactly.
fn row(month: usize, minute: usize, metric: usize, append: bool) -> Value {
    let at = format!(
        "2025-{month:02}-{:02}T{:02}:{:02}:00.000Z",
        minute / 1440 + 1,
        minute / 60 % 24,
        minute % 60
    );
    json!({"id": format!("synthetic:{month:02}:{minute:07}:{metric}:{}{}", if append {"append:"} else {""}, "i".repeat(60)), "metric": if metric == 0 {"steps"} else {"heartRate"}, "at": at.replace('Z', "+00:00"), "end": null, "value": (50 + minute % 100) as f64, "source": if minute.is_multiple_of(3) {"phone"} else {"watch"}, "receivedAt": at, "rawId": format!("raw:{month:02}:{minute:07}:{}", "r".repeat(33)), "month": format!("2025-{month:02}"), "date": &at[..10], "atUtc": at})
}
fn raw(mut row: Value) -> Value {
    let hash = row["id"]
        .as_str()
        .unwrap()
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        });
    row["shard"] = json!(format!("{:02x}", hash % 256));
    row
}
fn prepare(root: &Path) -> Result<(), Error> {
    if root.exists() {
        return Err("fixture root must not exist".into());
    }
    fs::create_dir_all(root.join("samples"))?;
    fs::create_dir(root.join("raw"))?;
    let mut shards = (0..256)
        .map(|i| File::create(root.join(format!("raw/{i:02x}.jsonl"))).map(BufWriter::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut count = 0;
    for (month, days) in DAYS.iter().enumerate() {
        let mut out = BufWriter::new(File::create(
            root.join(format!("samples/2025-{:02}.jsonl", month + 1)),
        )?);
        for minute in 0..days * 1440 {
            for metric in 0..if minute % 2 == 0 { 2 } else { 1 } {
                let record = row(month + 1, minute, metric, false);
                writeln!(out, "{record}")?;
                let record = raw(record);
                let shard = usize::from_str_radix(record["shard"].as_str().unwrap(), 16)?;
                writeln!(shards[shard], "{record}")?;
                count += 1;
            }
        }
        out.flush()?;
        out.get_ref().sync_all()?;
    }
    for shard in &mut shards {
        shard.flush()?;
        shard.get_ref().sync_all()?;
    }
    println!(
        "{}",
        json!({"rows_per_shape": count, "months": 10, "shards": 256})
    );
    Ok(())
}
fn open(root: &Path, kind: &str, model: ExecutionModel) -> Result<NativeRuntime, Error> {
    let mut fields = [
        "id",
        "metric",
        "at",
        "source",
        "receivedAt",
        "rawId",
        "month",
        "date",
        "atUtc",
    ]
    .into_iter()
    .map(|name| StructField {
        name: name.into(),
        schema: SchemaNode::Str,
    })
    .collect::<Vec<_>>();
    fields.push(StructField {
        name: "value".into(),
        schema: SchemaNode::Num,
    });
    fields.push(StructField {
        name: "end".into(),
        schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
    });
    if kind == "raw" {
        fields.push(StructField {
            name: "shard".into(),
            schema: SchemaNode::Str,
        });
    }
    let descriptor = CollectionDescriptor {
        name: kind.into(),
        schema: SchemaNode::Struct { fields },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
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
    };
    let config = NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(descriptor)],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: kind.into(),
            collection: kind.into(),
            root: root.join(kind).to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: if kind == "raw" {
                PartitionKey::Field {
                    field: "shard".into(),
                }
            } else {
                PartitionKey::TimeBucket {
                    field: "atUtc".into(),
                    bucket: TimeBucket::Month,
                }
            },
            prose: None,
        })],
    };
    let options = NativeSourceRuntimeOptions {
        execution_model: model,
        watch_debounce: None,
        lazy_partitions: IndexMap::from([(
            kind.into(),
            LazyPartitionPolicy {
                max_loaded_partitions: 1,
                full_scan: FullScanPolicy::Allow,
            },
        )]),
        ..Default::default()
    };
    NativeRuntime::open_sources_with_options(config, options).map_err(engine_error)
}
fn rss(field: &str) -> Result<u64, Error> {
    let status = fs::read_to_string("/proc/self/status")?;
    let line = status
        .lines()
        .find(|line| line.starts_with(field))
        .ok_or("missing RSS field")?;
    Ok(line
        .split_whitespace()
        .nth(1)
        .ok_or("missing RSS value")?
        .parse::<u64>()?
        * 1024)
}
fn append(root: &Path, kind: &str, model: ExecutionModel) -> Result<(), Error> {
    let runtime = open(root, kind, model)?;
    let records = (0..1000)
        .map(|i| {
            let record = row(10, i, 0, true);
            if kind == "raw" {
                raw(record)
            } else {
                record
            }
        })
        .collect::<Vec<_>>();
    let status = runtime
        .lazy_partition_status(kind)
        .map_err(engine_error)?
        .unwrap();
    let mut before = 0;
    for path in &status.partitions {
        before += fs::metadata(path)?.len();
    }
    let rss_before = rss("VmRSS:")?;
    fs::write("/proc/self/clear_refs", "5")?;
    let start = Instant::now();
    let created = runtime
        .mutate(|db| db.create_many(kind, records.clone()))
        .map_err(engine_error)?;
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let peak = rss("VmHWM:")?;
    let rss_return = rss("VmRSS:")?;
    assert_eq!(created.created, records);
    let status = runtime
        .lazy_partition_status(kind)
        .map_err(engine_error)?
        .unwrap();
    // Count appended lines from the persisted files, not the returned batch.
    let mut appended = 0;
    let mut after = 0;
    for path in &status.partitions {
        after += fs::metadata(path)?.len();
        for line in BufReader::new(File::open(path)?).lines() {
            if line?.contains(":append:") {
                appended += 1;
            }
        }
    }
    assert_eq!(appended, 1000);
    if model == ExecutionModel::Streaming {
        assert!(status.loaded.is_empty());
        runtime
            .read(|db| {
                assert!(db.collection(kind).unwrap().is_empty());
                Ok(())
            })
            .map_err(engine_error)?;
    }
    println!(
        "{}",
        json!({"shape": kind, "model": format!("{model:?}"), "wall_ms": wall_ms, "rss_before": rss_before, "rss_peak": peak, "rss_return": rss_return, "appended_verified": appended, "bytes_added": after - before, "partitions_resident": status.loaded.len(), "duplicate_scope": if model == ExecutionModel::Streaming { "global locator" } else { "loaded/routed only" }, "durability": "append_durable, file sync per target, directory sync for new files"})
    );
    Ok(())
}
fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command, root] if command == "prepare" => prepare(Path::new(root)),
        [command, root, model, kind] if command == "append" && ["samples", "raw"].contains(&kind.as_str()) => {
            let model = match model.as_str() { "resident" => ExecutionModel::Resident, "streaming" => ExecutionModel::Streaming, _ => return Err("model must be resident|streaming".into()) };
            append(Path::new(root), kind, model)
        }
        _ => Err("usage: streaming_append_bench prepare ROOT | append ROOT resident|streaming samples|raw".into()),
    }
}
