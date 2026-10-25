//! Full-size stage-0 append shapes. Synthetic data only.
//! prepare ROOT creates 656,640 rows in both shapes; append ROOT MODEL SHAPE
//! times 1,000 new rows, with global checks under Streaming. Resident retains
//! its documented loaded/routed-only check (not global parity).
//! point-release measures two lookup/release cycles. point-release-trim adds
//! the existing explicit GlibcTrim policy as a separate diagnostic, never a
//! no-trim qualification. repeat measures distinct prepared 1,000-row batches.
//! append-range primes an October range and appends at its last timestamp so
//! source time order stays valid, then measures the same range after each batch.
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
use std::time::{Duration, Instant};

#[cfg(feature = "allocation-meter")]
#[path = "lazy_memory/meter.rs"]
mod meter;
#[cfg(feature = "allocation-meter")]
#[global_allocator]
static METER: meter::Meter<std::alloc::System> = meter::Meter::new(std::alloc::System);

#[cfg(feature = "bench-observe")]
static PREFIX_PROOF: std::sync::Mutex<(Option<Instant>, Duration)> =
    std::sync::Mutex::new((None, Duration::ZERO));

#[cfg(feature = "bench-observe")]
fn observe(phase: &'static str, begin: bool) {
    if phase != "streaming_append_prefix_proof" {
        return;
    }
    let mut state = PREFIX_PROOF.lock().unwrap();
    if begin {
        state.0 = Some(Instant::now());
    } else if let Some(start) = state.0.take() {
        state.1 += start.elapsed();
    }
}
fn heap_start() {
    #[cfg(feature = "allocation-meter")]
    METER.resume("query_total", true, 0);
}
fn heap_end() -> Value {
    #[cfg(feature = "allocation-meter")]
    {
        let mut active = METER.pause();
        let sample = METER.end("query_total", &mut active).unwrap();
        METER.resume("query_total", false, active);
        json!({"start_live":sample.start_live, "end_live":sample.end_live,
            "peak_live":sample.peak_live, "allocated":sample.allocated,
            "global_live_peak":METER.live_and_peak()})
    }
    #[cfg(not(feature = "allocation-meter"))]
    Value::Null
}

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
fn point_release(root: &Path, kind: &str, trim: bool) -> Result<(), Error> {
    let runtime = open(root, kind, ExecutionModel::Streaming)?;
    // Diagnostic only: use the existing session owner's explicit allocator
    // policy. Do not change the runtime default or qualify no-trim targets.
    let reclaimer = if trim {
        Some(
            proseql_native::NativeSourceSessions::new(
                NativeSourceRuntimeConfig {
                    collections: vec![],
                    sources: vec![],
                },
                NativeSourceRuntimeOptions::default(),
            )
            .map_err(engine_error)?
            .reclaim_idle_memory(proseql_native::IdleMemoryReclaim::GlibcTrim)
            .map_err(engine_error)?,
        )
    } else {
        None
    };
    let expected = if kind == "raw" {
        raw(row(5, 12, 0, false))
    } else {
        row(5, 12, 0, false)
    };
    let idle = rss("VmRSS:")?;
    for cycle in 0..2 {
        fs::write("/proc/self/clear_refs", "5")?;
        heap_start();
        let start = Instant::now();
        assert_eq!(
            runtime
                .find_by_id(kind, expected["id"].as_str().unwrap())
                .map_err(engine_error)?,
            Some(expected.clone())
        );
        let lookup_ms = start.elapsed().as_secs_f64() * 1000.0;
        let heap = heap_end();
        let peak = rss("VmHWM:")?;
        std::thread::sleep(Duration::from_secs(1));
        let retained = rss("VmRSS:")?;
        let release = Instant::now();
        runtime.release_streaming_indexes().map_err(engine_error)?;
        let release_ms = release.elapsed().as_secs_f64() * 1000.0;
        std::thread::sleep(Duration::from_secs(1));
        let released_rss = rss("VmRSS:")?;
        let trim_start = Instant::now();
        let trimmed = reclaimer
            .as_ref()
            .map(|owner| owner.release_unused_memory());
        let trim_ms = trim.then(|| trim_start.elapsed().as_secs_f64() * 1000.0);
        if trim {
            std::thread::sleep(Duration::from_secs(1));
        }
        let trimmed_rss = if trim { Some(rss("VmRSS:")?) } else { None };
        println!(
            "{}",
            json!({"mode":if trim {"point-release-trim"} else {"point-release"}, "shape":kind, "cycle":cycle,
            "lookup_ms":lookup_ms,"release_ms":release_ms,"idle_rss":idle,"peak_rss":peak,
            "retained_rss":retained,"released_rss":released_rss,"heap":heap,
            "trimmed":trimmed,"trim_ms":trim_ms,"trimmed_rss":trimmed_rss})
        );
    }
    Ok(())
}
fn range_after_append(
    runtime: &NativeRuntime,
    kind: &str,
) -> Result<(usize, usize, String), Error> {
    let (rows, stats) = runtime.query_with_stats(kind, proseql_engine::query::pipeline::QueryInput {
        r#where: Some(json!({"atUtc":{"$gte":"2025-10-31T23:00:00.000Z", "$lt":"2025-11-01T00:00:00.000Z"}})),
        ..Default::default()
    }, None).map_err(engine_error)?;
    Ok((
        rows.len(),
        stats.candidate_rows,
        format!("{:?}", stats.index_used),
    ))
}
fn repeat(root: &Path, kind: &str, batches: usize, after_range: bool) -> Result<(), Error> {
    let runtime = open(root, kind, ExecutionModel::Streaming)?;
    let initial_rows = if after_range {
        range_after_append(&runtime, kind)?.0
    } else {
        0
    };
    for batch in 0..batches {
        let records = (0..1000)
            .map(|i| {
                let mut record = row(10, if after_range { 31 * 1440 - 1 } else { i }, 0, true);
                let prefix = if after_range {
                    format!("repeat-{batch}-{i}")
                } else {
                    format!("repeat-{batch}")
                };
                record["id"] = json!(format!("{prefix}:{}", record["id"].as_str().unwrap()));
                if kind == "raw" {
                    raw(record)
                } else {
                    record
                }
            })
            .collect::<Vec<_>>();
        let targets = if kind == "raw" {
            records
                .iter()
                .map(|row| row["shard"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
        } else {
            1
        };
        #[cfg(feature = "bench-observe")]
        {
            PREFIX_PROOF.lock().unwrap().1 = Duration::ZERO;
        }
        fs::write("/proc/self/clear_refs", "5")?;
        heap_start();
        let start = Instant::now();
        let created = runtime
            .mutate(|db| db.create_many(kind, records.clone()))
            .map_err(engine_error)?;
        let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(created.created, records);
        let heap = heap_end();
        let range_start = Instant::now();
        let range = if after_range {
            Some(range_after_append(&runtime, kind)?)
        } else {
            None
        };
        let range_ms = after_range.then(|| range_start.elapsed().as_secs_f64() * 1000.0);
        if let Some((rows, _, _)) = &range {
            assert_eq!(*rows, initial_rows + (batch + 1) * 1000);
        }
        #[cfg(feature = "bench-observe")]
        let prefix_ms = Some(PREFIX_PROOF.lock().unwrap().1.as_secs_f64() * 1000.0);
        #[cfg(not(feature = "bench-observe"))]
        let prefix_ms: Option<f64> = None;
        println!(
            "{}",
            json!({"mode":if after_range {"append-range"} else {"repeat"}, "shape":kind,"batch":batch,"new_rows":1000,
            "wall_ms":wall_ms,"prefix_proof_ms":prefix_ms,"peak_rss":rss("VmHWM:")?,"heap":heap,
            "range_ms":range_ms,"range_rows_candidates_index":range,"targets_this_batch":targets})
        );
    }
    Ok(())
}
fn main() -> Result<(), Error> {
    #[cfg(feature = "bench-observe")]
    assert!(proseql_storage::diagnostics::set_observer(observe));
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command, root] if command == "prepare" => prepare(Path::new(root)),
        [command, root, kind] if ["point-release", "point-release-trim"].contains(&command.as_str()) && ["samples", "raw"].contains(&kind.as_str()) => point_release(Path::new(root), kind, command == "point-release-trim"),
        [command, root, kind, batches] if ["repeat", "append-range"].contains(&command.as_str()) && ["samples", "raw"].contains(&kind.as_str()) => repeat(Path::new(root), kind, batches.parse()?, command == "append-range"),
        [command, root, model, kind] if command == "append" && ["samples", "raw"].contains(&kind.as_str()) => {
            let model = match model.as_str() { "resident" => ExecutionModel::Resident, "streaming" => ExecutionModel::Streaming, _ => return Err("model must be resident|streaming".into()) };
            append(Path::new(root), kind, model)
        }
        _ => Err("usage: streaming_append_bench prepare ROOT | append ROOT resident|streaming samples|raw | point-release|point-release-trim ROOT samples|raw | repeat|append-range ROOT samples|raw BATCHES".into()),
    }
}
