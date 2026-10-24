//! Synthetic lazy-partition memory/decode benchmark. See docs/benchmarks/lazy-memory.md.
//! Preparation and each measurement must run in separate processes.
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::SortOrder;
use proseql_native::{
    FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, DocumentSourceConfig, PartitionKey,
    PartitionedSourceConfig, SourceCollectionSelection, TimeBucket, UnknownCollectionPolicy,
};
use serde_json::{json, Value};

#[path = "lazy_memory/allocator_os.rs"]
mod allocator_os;
#[path = "lazy_memory/sessions.rs"]
mod sessions;

#[cfg(all(
    feature = "phase-rss",
    not(any(feature = "heap-profile", feature = "allocation-meter"))
))]
#[path = "lazy_memory/rss_peak.rs"]
mod rss_peak;
#[cfg(all(
    feature = "phase-rss",
    not(any(feature = "heap-profile", feature = "allocation-meter"))
))]
static RSS_PEAK: std::sync::OnceLock<rss_peak::Tracker> = std::sync::OnceLock::new();

type Error = Box<dyn std::error::Error + Send + Sync>;
fn tag(error: EngineError) -> Error {
    format!("{}: {error}", error.tag()).into()
}

const COLLECTION: &str = "samples";
const MONTHS: usize = 10;
const ROW_BYTES: usize = 316;
static START: OnceLock<Instant> = OnceLock::new();
static PROFILING: AtomicBool = AtomicBool::new(false);

#[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
#[path = "lazy_memory/meter.rs"]
mod meter;

#[cfg(feature = "heap-profile")]
#[global_allocator]
static ALLOCATOR: dhat::Alloc = dhat::Alloc;
#[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
#[global_allocator]
static ALLOCATOR: meter::Meter<std::alloc::System> = meter::Meter::new(std::alloc::System);

#[derive(Debug)]
struct Args {
    root: PathBuf,
    rows: usize,
    ids: usize,
    mode: String,
    prepare: bool,
    profile: Option<PathBuf>,
    check: bool,
    bounded: bool,
    layout: bool,
    trim_end: bool,
    consumer: bool,
    idle_check: bool,
    idle_seconds: u64,
    cache_partitions: usize,
    source_kind: String,
    append_one: bool,
    history_copies: usize,
    source_sessions: bool,
    reclaim_idle: bool,
}

fn parse_args() -> Result<Args, Error> {
    let mut args = Args {
        root: PathBuf::from("/var/tmp/proseql-lazy-memory-v1"),
        rows: 43_000,
        ids: 10_000,
        mode: "zero".into(),
        prepare: false,
        profile: None,
        check: false,
        bounded: false,
        layout: false,
        trim_end: false,
        consumer: false,
        idle_check: false,
        idle_seconds: 0,
        cache_partitions: 1,
        source_kind: "month".into(),
        append_one: false,
        history_copies: 0,
        source_sessions: false,
        reclaim_idle: false,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let mut value = || {
            iter.next()
                .ok_or_else(|| format!("{flag} requires a value"))
        };
        match flag.as_str() {
            "--data-dir" => args.root = value()?.into(),
            "--rows-per-month" => args.rows = value()?.parse()?,
            "--id-rows" => args.ids = value()?.parse()?,
            "--mode" => args.mode = value()?,
            "--prepare-only" => args.prepare = true,
            "--heap-profile" => args.profile = Some(value()?.into()),
            "--check" => args.check = true,
            "--bounded" => args.bounded = true,
            "--layout-only" => args.layout = true,
            "--trim-end" => args.trim_end = true,
            "--fixture" => {
                args.consumer = match value()?.as_str() {
                    "legacy" => false,
                    "consumer" => true,
                    _ => return Err("fixture must be legacy|consumer".into()),
                };
            }
            "--idle-check" => args.idle_check = true,
            "--idle-seconds" => args.idle_seconds = value()?.parse()?,
            "--cache-partitions" => args.cache_partitions = value()?.parse()?,
            "--source-kind" => args.source_kind = value()?,
            "--append-one" => args.append_one = true,
            "--history-copies" => args.history_copies = value()?.parse()?,
            "--sessions" => args.source_sessions = true,
            "--reclaim-idle" => args.reclaim_idle = true,
            _ => {
                return Err(
                    format!("unknown argument {flag}; see docs/benchmarks/lazy-memory.md").into(),
                )
            }
        }
    }
    if !(1..=1_000_000).contains(&args.rows) || !(1..=139_420).contains(&args.ids) {
        return Err("rows-per-month must be 1..=1000000; id-rows must be 1..=139420".into());
    }
    if !["zero", "ascending", "scan", "cold", "eager-id", "empty"].contains(&args.mode.as_str()) {
        return Err("mode must be zero|ascending|scan|cold|eager-id|empty".into());
    }
    if !["month", "file", "documents", "sharded", "yaml-partitions"]
        .contains(&args.source_kind.as_str())
    {
        return Err("source-kind must be month|file|documents|sharded|yaml-partitions".into());
    }
    if args.history_copies > 9 || (args.history_copies > 0 && args.source_kind != "month") {
        return Err("history-copies must be 0..=9 and uses the month source kind".into());
    }
    if args.profile.is_some() && !cfg!(feature = "heap-profile") {
        return Err("--heap-profile needs --features heap-profile".into());
    }
    if args.reclaim_idle && !args.source_sessions {
        return Err("--reclaim-idle requires --sessions".into());
    }
    if args.source_sessions && args.check {
        return Err(
            "--check measures loaded rows, not session idle; use --idle-check for sessions".into(),
        );
    }
    if args.source_sessions
        && args.idle_check
        && !cfg!(feature = "allocation-meter")
        && args.profile.is_none()
    {
        return Err(
            "session --idle-check needs --features allocation-meter or an active --heap-profile"
                .into(),
        );
    }
    if args.check
        && (args.mode == "empty"
            || (args.cache_partitions == 0
                && !["eager-id"].contains(&args.mode.as_str())
                && ["month", "sharded"].contains(&args.source_kind.as_str())))
    {
        return Err(
            "loaded-row --check requires retained rows; use --idle-check for a zero cache".into(),
        );
    }
    if args.check && args.profile.is_none() {
        return Err("--check requires --heap-profile for allocated-byte assertions".into());
    }
    Ok(args)
}

fn timestamp(month: usize, i: usize, rows: usize) -> String {
    let days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31][month - 1];
    let ms = i as u64 * days * 86_400_000 / rows as u64;
    format!(
        "2025-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms / 86_400_000 + 1,
        ms / 3_600_000 % 24,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn synthetic_row(month: usize, i: usize, rows: usize) -> Value {
    let mut row = json!({
        "id": format!("synthetic:{month:02}:{i:07}"),
        "timestamp": timestamp(month, i, rows),
        "metric": "synthetic-rate", "value": 50 + i % 100,
        "unit": "count/min", "source": "synthetic", "device": "generator-v1",
        "quality": 1, "version": 1, "active": true, "offset": 0, "note": ""
    });
    let len = serde_json::to_vec(&row)
        .expect("serialize synthetic row")
        .len();
    row["note"] = Value::String("x".repeat(ROW_BYTES - 1 - len));
    row
}

fn consumer_row(month: usize, i: usize, rows: usize) -> Value {
    let at = timestamp(month, i, rows);
    json!({
        "id": format!("synthetic:{month:02}:{i:07}:{}", "i".repeat(63)),
        "metric": if i.is_multiple_of(2) { "steps" } else { "heartRate" },
        "at": at.replace('Z', "+00:00"), "end": null, "value": 50 + i % 100,
        "source": if i.is_multiple_of(3) { "phone" } else { "watch" },
        "receivedAt": at, "rawId": format!("raw:{month:02}:{i:07}:{}", "r".repeat(33)),
        "month": format!("2025-{month:02}"), "date": &at[..10], "atUtc": at
    })
}

fn marker(args: &Args) -> String {
    let base = base_marker(args);
    if args.source_kind == "month" && args.history_copies == 0 {
        return base;
    }
    let mut value: Value = serde_json::from_str(&base).expect("fixture marker");
    value["source_kind"] = json!(args.source_kind);
    value["history_copies"] = json!(args.history_copies);
    value.to_string()
}

fn base_marker(args: &Args) -> String {
    if args.consumer {
        return json!({"generator":2,"fixture":"consumer","fields":11,
            "months":MONTHS,"rows_per_month":args.rows,"id_rows":args.ids})
        .to_string();
    }
    json!({"generator": 1, "months": MONTHS, "rows_per_month": args.rows,
        "id_rows": args.ids, "row_bytes": ROW_BYTES})
    .to_string()
}

fn prepare(args: &Args) -> Result<(), Error> {
    let marker_path = args.root.join("complete.json");
    if marker_path.exists() {
        if fs::read_to_string(marker_path)? != marker(args) {
            return Err("dataset parameters differ; use a new --data-dir".into());
        }
        return Ok(());
    }
    fs::create_dir_all(args.root.join(COLLECTION))?;
    for month in 1..=MONTHS {
        let path = args
            .root
            .join(COLLECTION)
            .join(format!("2025-{month:02}.jsonl"));
        let mut out = BufWriter::new(OpenOptions::new().create_new(true).write(true).open(path)?);
        for i in 0..args.rows {
            let row = if args.consumer {
                consumer_row(month, i, args.rows)
            } else {
                synthetic_row(month, i, args.rows)
            };
            serde_json::to_writer(&mut out, &row)?;
            out.write_all(b"\n")?;
        }
        out.flush()?;
    }
    for copy in 0..args.history_copies {
        let year = 2010 + copy;
        for month in 1..=MONTHS {
            let path = args
                .root
                .join(COLLECTION)
                .join(format!("{year}-{month:02}.jsonl"));
            let mut out =
                BufWriter::new(OpenOptions::new().create_new(true).write(true).open(path)?);
            for i in 0..args.rows {
                let mut row = if args.consumer {
                    consumer_row(month, i, args.rows)
                } else {
                    synthetic_row(month, i, args.rows)
                };
                for (key, value) in row.as_object_mut().expect("fixture object") {
                    if let Value::String(text) = value {
                        *text = if key == "id" {
                            text.replacen("synthetic:", &format!("archive{copy:02}:"), 1)
                        } else if key == "rawId" {
                            text.replacen("raw:", &format!("{copy:03}:"), 1)
                        } else {
                            text.replace("2025", &year.to_string())
                        };
                    }
                }
                serde_json::to_writer(&mut out, &row)?;
                out.write_all(b"\n")?;
            }
            out.flush()?;
        }
    }
    if args.source_kind == "yaml-partitions" {
        fs::create_dir_all(args.root.join("yaml-parts"))?;
        for month in 1..=MONTHS {
            let rows = (0..args.rows)
                .map(|i| {
                    if args.consumer {
                        consumer_row(month, i, args.rows)
                    } else {
                        synthetic_row(month, i, args.rows)
                    }
                })
                .collect::<Vec<_>>();
            let path = args
                .root
                .join("yaml-parts")
                .join(format!("2025-{month:02}.yaml"));
            let mut out =
                BufWriter::new(OpenOptions::new().create_new(true).write(true).open(path)?);
            let keyed = rows
                .into_iter()
                .map(|row| (row["id"].as_str().expect("fixture ID").to_owned(), row))
                .collect::<IndexMap<_, _>>();
            serde_json::to_writer(&mut out, &keyed)?;
            out.flush()?;
        }
    }
    if args.source_kind != "month" {
        let mut all = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(args.root.join("all.jsonl"))?,
        );
        let mut documents = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(args.root.join("records.yaml"))?,
        );
        documents.write_all(b"samples:\n")?;
        let mut shards = Vec::new();
        if args.source_kind == "sharded" {
            fs::create_dir_all(args.root.join("shards"))?;
            for shard in 0..256 {
                shards.push(BufWriter::new(
                    OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(args.root.join("shards").join(format!("{shard:02x}.jsonl")))?,
                ));
            }
        }
        for month in 1..=MONTHS {
            for i in 0..args.rows {
                let mut row = if args.consumer {
                    consumer_row(month, i, args.rows)
                } else {
                    synthetic_row(month, i, args.rows)
                };
                serde_json::to_writer(&mut all, &row)?;
                all.write_all(b"\n")?;
                documents.write_all(b"  ")?;
                serde_json::to_writer(&mut documents, &row["id"])?;
                documents.write_all(b": ")?;
                serde_json::to_writer(&mut documents, &row)?;
                documents.write_all(b"\n")?;
                if !shards.is_empty() {
                    let shard = i % 256;
                    row["shard"] = json!(format!("{shard:02x}"));
                    serde_json::to_writer(&mut shards[shard], &row)?;
                    shards[shard].write_all(b"\n")?;
                }
            }
        }
        all.flush()?;
        documents.flush()?;
        for shard in &mut shards {
            shard.flush()?;
        }
    }
    let mut out = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(args.root.join("ids.jsonl"))?,
    );
    for i in 0..args.ids {
        writeln!(out, "{{\"id\":\"synthetic-id:{i:07}\"}}")?;
    }
    out.flush()?;
    fs::write(args.root.join("empty.jsonl"), "")?;
    fs::write(marker_path, marker(args))?;
    println!("LM_DATA {}", marker(args));
    Ok(())
}

fn descriptor(ids: bool, consumer: bool) -> CollectionDescriptor {
    let fields = if ids {
        vec![("id", SchemaNode::Str)]
    } else if consumer {
        vec![
            ("id", SchemaNode::Str),
            ("metric", SchemaNode::Str),
            ("at", SchemaNode::Str),
            ("end", SchemaNode::NullOr(Box::new(SchemaNode::Str))),
            ("value", SchemaNode::Num),
            ("source", SchemaNode::Str),
            ("receivedAt", SchemaNode::Str),
            ("rawId", SchemaNode::Str),
            ("month", SchemaNode::Str),
            ("date", SchemaNode::Str),
            ("atUtc", SchemaNode::Str),
        ]
    } else {
        vec![
            ("id", SchemaNode::Str),
            ("timestamp", SchemaNode::Str),
            ("metric", SchemaNode::Str),
            ("value", SchemaNode::Num),
            ("unit", SchemaNode::Str),
            ("source", SchemaNode::Str),
            ("device", SchemaNode::Str),
            ("quality", SchemaNode::Num),
            ("version", SchemaNode::Num),
            ("active", SchemaNode::Bool),
            ("offset", SchemaNode::Num),
            ("note", SchemaNode::Str),
        ]
    };
    CollectionDescriptor {
        name: COLLECTION.into(),
        schema: SchemaNode::Struct {
            fields: fields
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
        ordered_indexes: if ids {
            vec![]
        } else {
            vec![if consumer {
                "atUtc".into()
            } else {
                "timestamp".into()
            }]
        },
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

fn config(args: &Args) -> (NativeSourceRuntimeConfig, NativeSourceRuntimeOptions) {
    let ids = args.mode == "eager-id" || args.mode == "empty";
    let source = if ids {
        DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
            id: COLLECTION.into(),
            collection: COLLECTION.into(),
            path: args
                .root
                .join(if args.mode == "empty" {
                    "empty.jsonl"
                } else {
                    "ids.jsonl"
                })
                .to_string_lossy()
                .into_owned(),
            format: Some("jsonl".into()),
            prose: None,
        })
    } else if args.source_kind == "file" {
        DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
            id: COLLECTION.into(),
            collection: COLLECTION.into(),
            path: args.root.join("all.jsonl").to_string_lossy().into_owned(),
            format: Some("jsonl".into()),
            prose: None,
        })
    } else if args.source_kind == "documents" {
        DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: COLLECTION.into(),
            root: args.root.to_string_lossy().into_owned(),
            include: Some(vec!["records.yaml".into()]),
            exclude: vec![],
            format: Some("yaml".into()),
            collections: Some(SourceCollectionSelection::Named(vec![COLLECTION.into()])),
            unknown_collections: UnknownCollectionPolicy::Preserve,
            outbox: "records.yaml".into(),
            optional: false,
        })
    } else {
        DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: COLLECTION.into(),
            collection: COLLECTION.into(),
            root: args
                .root
                .join(if args.source_kind == "sharded" {
                    "shards"
                } else if args.source_kind == "yaml-partitions" {
                    "yaml-parts"
                } else {
                    COLLECTION
                })
                .to_string_lossy()
                .into_owned(),
            format: if args.source_kind == "yaml-partitions" {
                "yaml".into()
            } else {
                "jsonl".into()
            },
            prose: None,
            partition_by: if args.source_kind == "sharded" {
                PartitionKey::Field {
                    field: "shard".into(),
                }
            } else {
                PartitionKey::TimeBucket {
                    field: if args.consumer {
                        "atUtc".into()
                    } else {
                        "timestamp".into()
                    },
                    bucket: TimeBucket::Month,
                }
            },
        })
    };
    let lazy_partitions =
        if ids || ["file", "documents", "yaml-partitions"].contains(&args.source_kind.as_str()) {
            IndexMap::new()
        } else {
            IndexMap::from([(
                COLLECTION.into(),
                LazyPartitionPolicy {
                    max_loaded_partitions: args.cache_partitions,
                    full_scan: FullScanPolicy::Allow,
                },
            )])
        };
    let mut collection = descriptor(ids, args.consumer);
    if args.source_kind == "sharded" && !ids {
        if let SchemaNode::Struct { fields } = &mut collection.schema {
            fields.push(StructField {
                name: "shard".into(),
                schema: SchemaNode::Str,
            });
        }
    }
    (
        NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(collection)],
            sources: vec![source],
        },
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            lazy_partitions,
            ..Default::default()
        },
    )
}

fn proc_bytes(key: &str) -> Option<u64> {
    #[cfg(all(
        feature = "phase-rss",
        not(any(feature = "heap-profile", feature = "allocation-meter"))
    ))]
    if key == "VmHWM:" {
        // A reset segment is not the process acceptance high-water mark.
        return None;
    }
    fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix(key))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()
        .map(|kib| kib * 1024)
}

fn heap() -> Value {
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    {
        let (live, peak) = ALLOCATOR.live_and_peak();
        json!({"live":live,"peak":peak})
    }
    #[cfg(feature = "heap-profile")]
    if PROFILING.load(Ordering::Relaxed) {
        let stats = dhat::HeapStats::get();
        return json!({"live": stats.curr_bytes, "peak": stats.max_bytes,
            "allocated": stats.total_bytes, "allocations": stats.total_blocks});
    }
    #[cfg(any(not(feature = "allocation-meter"), feature = "heap-profile"))]
    Value::Null
}

#[cfg(all(
    feature = "phase-rss",
    not(any(feature = "heap-profile", feature = "allocation-meter"))
))]
fn checkpoint(phase: &'static str, begin: bool) {
    let tracker = RSS_PEAK.get_or_init(|| {
        let tracker = rss_peak::Tracker::new().expect("kernel RSS reset observer initialization");
        eprintln!("LM_RSS_OBSERVER {{\"schema\":\"proseql.phase-rss.v1\",\"pid\":{},\"reset\":\"/proc/self/clear_refs=5\",\"whole_process_acceptance_peak\":null,\"includes_observer_overhead\":true}}",std::process::id());
        tracker
    });
    let boundary = tracker
        .boundary(phase, begin)
        .expect("kernel phase RSS measurement");
    rss_peak::emit(
        phase,
        begin,
        START.get_or_init(Instant::now).elapsed().as_micros(),
        boundary,
    );
}

#[cfg(not(all(
    feature = "phase-rss",
    not(any(feature = "heap-profile", feature = "allocation-meter"))
)))]
fn checkpoint(phase: &'static str, begin: bool) {
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let mut active = ALLOCATOR.pause();
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let local = if begin {
        None
    } else {
        ALLOCATOR.end(phase, &mut active)
    };
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let local = local.map(|sample| json!({"start_live":sample.start_live,"end_live":sample.end_live,
        "peak_live":sample.peak_live,"allocated_requested":sample.allocated,
        "peak_over_start":sample.peak_live.saturating_sub(sample.start_live),
        "peak_over_endpoints":sample.peak_live.saturating_sub(sample.start_live.max(sample.end_live))}));
    #[cfg(any(not(feature = "allocation-meter"), feature = "heap-profile"))]
    let local: Option<Value> = None;
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let meter = Some(ALLOCATOR.live_and_peak());
    #[cfg(any(not(feature = "allocation-meter"), feature = "heap-profile"))]
    let meter: Option<(usize, usize)> = None;
    let heap = heap();
    eprintln!(
        "LM_PHASE {}",
        json!({"phase": phase,"begin":begin,
        "elapsed_us":START.get_or_init(Instant::now).elapsed().as_micros(),
        "heap":heap,"rss":proc_bytes("VmRSS:"),"rss_hwm":proc_bytes("VmHWM:"),
        "local_heap":local,"meter_live_and_global_peak":meter})
    );
    drop(heap);
    drop(local);
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    ALLOCATOR.resume(phase, begin, active);
}

fn over_budget(resident: u64, peak: u64, open: u64, rows: usize) -> bool {
    resident > rows as u64 * 1024 || peak > open + 2 * rows as u64 * 1024 + 50 * 1024 * 1024
}

#[cfg(feature = "heap-profile")]
type Profile = Option<dhat::Profiler>;
#[cfg(not(feature = "heap-profile"))]
struct Profile;

fn run(args: &Args, _profile: Profile) -> Result<(), Error> {
    if fs::read_to_string(args.root.join("complete.json"))? != marker(args) {
        return Err("dataset parameters differ; run --prepare-only with a new --data-dir".into());
    }
    #[cfg(feature = "bench-observe")]
    assert!(proseql_storage::diagnostics::set_observer(checkpoint));
    let (config, options) = config(args);
    let before_open_heap = heap();
    checkpoint("open", true);
    let start = Instant::now();
    let runtime = NativeRuntime::open_sources_with_options(config, options).map_err(tag)?;
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    checkpoint("open", false);
    let opened = heap();
    let open_rss = proc_bytes("VmRSS:");
    let mut resident = 0;
    let mut measured_resident_rows = 0;
    if args.mode == "eager-id" || args.mode == "empty" {
        resident = opened["live"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(before_open_heap["live"].as_u64().unwrap_or(0));
        assert_eq!(
            runtime
                .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
                .map_err(tag)?,
            if args.mode == "empty" { 0 } else { args.ids }
        );
        if args.mode != "empty" {
            measured_resident_rows = args.ids;
        }
    } else {
        let months = if args.mode == "scan" || args.mode == "cold" {
            1
        } else {
            MONTHS
        };
        for ordinal in 1..=months {
            let month = if args.mode == "cold" { MONTHS } else { ordinal };
            let width = match args.mode.as_str() {
                "ascending" => 1 + (month - 1) % 3,
                "scan" => MONTHS,
                _ => 1,
            };
            let end = (month + width).min(MONTHS + 1);
            let time_field = if args.consumer { "atUtc" } else { "timestamp" };
            let mut filter = json!({time_field: {"$gte": format!("2025-{month:02}-01T00:00:00.000Z"), "$lt": format!("2025-{end:02}-01T00:00:00.000Z")}});
            if args.mode != "ascending" {
                filter["value"] = json!({"$lt": -1});
            }
            let input = QueryInput {
                r#where: Some(filter),
                sort: vec![(time_field.into(), SortOrder::Asc)],
                ..Default::default()
            };
            checkpoint("query_total", true);
            let start = Instant::now();
            let (result, scope) = if args.bounded {
                runtime
                    .query_bounded_with_stats(COLLECTION, input)
                    .map(|(rows, stats)| (rows, Some(stats)))
            } else {
                runtime
                    .query(COLLECTION, input, None)
                    .map(|rows| (rows, None))
            }
            .map_err(tag)?;
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            checkpoint("query_total", false);
            let expected = if args.mode == "ascending" {
                (end - month) * args.rows
            } else {
                0
            };
            assert_eq!(result.len(), expected);
            if let Some(status) = runtime.lazy_partition_status(COLLECTION).map_err(tag)? {
                assert!(status.loaded.len() <= args.cache_partitions);
            }
            let snapshot = heap();
            println!(
                "LM_QUERY {}",
                json!({"month": month, "width": end-month,
                "elapsed_ms": elapsed_ms, "returned": result.len(),
                "requested_months": end-month, "partitions_read":scope.as_ref().map(|stats|stats.partitions_read),
                "partitions_visited":scope.as_ref().map(|stats|stats.partitions_visited), "heap_with_results": snapshot,
                "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:")})
            );
            drop(result);
            if month == 1 {
                resident = heap()["live"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(opened["live"].as_u64().unwrap_or(0));
                measured_resident_rows = runtime
                    .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
                    .map_err(tag)?;
                checkpoint("first_resident_without_results", false);
            }
        }
    }
    if args.append_one {
        checkpoint("append_total", true);
        let row = if args.mode == "eager-id" || args.mode == "empty" {
            json!({"id":"synthetic-appended-id"})
        } else {
            let mut row = if args.consumer {
                consumer_row(10, args.rows + 1, args.rows + 2)
            } else {
                synthetic_row(10, args.rows + 1, args.rows + 2)
            };
            row["id"] = json!("synthetic-appended-row");
            if args.source_kind == "sharded" {
                row["shard"] = json!("ff");
            }
            row
        };
        drop(
            runtime
                .mutate(|tx| tx.create(COLLECTION, row))
                .map_err(tag)?,
        );
        checkpoint("append_total", false);
    }
    let idle_rows = runtime
        .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
        .map_err(tag)?;
    checkpoint("idle_now", false);
    let idle_rss = proc_bytes("VmRSS:");
    let idle_allocator = allocator_os::stats();
    if args.idle_seconds > 0 {
        std::thread::sleep(std::time::Duration::from_secs(args.idle_seconds));
        checkpoint("idle_after_wait", false);
    }
    let final_heap = heap();
    if ["file", "documents", "yaml-partitions"].contains(&args.source_kind.as_str()) {
        resident = opened["live"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(before_open_heap["live"].as_u64().unwrap_or(0));
    }
    let resident_rows = measured_resident_rows;
    let failed = args.check
        && over_budget(
            resident,
            final_heap["peak"].as_u64().unwrap_or(0),
            opened["live"].as_u64().unwrap_or(0),
            resident_rows,
        );
    let resident_measurement = (PROFILING.load(Ordering::Relaxed)
        || cfg!(feature = "allocation-meter"))
    .then_some(resident);
    let data_bytes = match args.source_kind.as_str() {
        "file" => fs::metadata(args.root.join("all.jsonl"))?.len(),
        "documents" => fs::metadata(args.root.join("records.yaml"))?.len(),
        kind => fs::read_dir(args.root.join(match kind {
            "sharded" => "shards",
            "yaml-partitions" => "yaml-parts",
            _ => COLLECTION,
        }))?
        .map(|entry| {
            entry
                .and_then(|entry| entry.metadata())
                .map(|metadata| metadata.len())
        })
        .sum::<Result<u64, _>>()?,
    };
    println!(
        "LM_SUMMARY {}",
        json!({"mode": args.mode, "bounded": args.bounded, "rows_per_month": args.rows,
        "id_rows": args.ids, "data_bytes": data_bytes,
        "open_ms": open_ms, "open_rss": open_rss, "opened_heap": opened,
        "first_resident_heap_delta": resident_measurement, "resident_rows": resident_rows,
        "resident_bytes_per_row": resident_measurement.filter(|_|resident_rows>0).map(|bytes| bytes as f64 / resident_rows as f64),
        "id_data_bytes": fs::metadata(args.root.join("ids.jsonl"))?.len(),
        "final_heap": final_heap, "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:"),
        "allocator": allocator_os::stats(), "idle_rows":idle_rows,
        "idle_rss":idle_rss,"idle_allocator":idle_allocator,"idle_seconds":args.idle_seconds,
        "fixture":if args.consumer {"consumer"} else {"legacy"},
        "cache_partitions":args.cache_partitions,"source_kind":args.source_kind,"appended":args.append_one,"history_copies":args.history_copies,
        "check_failed": failed || (args.idle_check && idle_rows != 0), "instrumented": cfg!(feature="bench-observe"), "profiled": PROFILING.load(Ordering::Relaxed)})
    );
    if args.trim_end {
        let before_rss = proc_bytes("VmRSS:");
        let before_allocator = allocator_os::stats();
        let released = allocator_os::trim();
        println!(
            "LM_ALLOCATOR_TRIM {}",
            json!({"released":released,"before_rss":before_rss,
            "after_rss":proc_bytes("VmRSS:"),"before_allocator":before_allocator,
            "after_allocator":allocator_os::stats(),"peak_unchanged":proc_bytes("VmHWM:")})
        );
    }
    // End profile while the last partition (or eager IDs) is live, so DHAT eb
    // describes resident allocations. Their lifetimes are right-censored here.
    PROFILING.store(false, Ordering::Relaxed);
    #[cfg(feature = "heap-profile")]
    drop(_profile);
    runtime.close().map_err(tag)?;
    if args.idle_check && idle_rows != 0 {
        return Err(format!(
            "idle retention: {idle_rows} decoded historical rows remain; expected zero"
        )
        .into());
    }
    if failed {
        return Err(
            "memory budget exceeded (1024 resident B/row; open + 2 partitions + 50 MiB peak)"
                .into(),
        );
    }
    Ok(())
}

fn layout_probe(consumer: bool) -> Result<(), Error> {
    let schema = descriptor(false, consumer).schema;
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let before = ALLOCATOR.live_and_peak().0;
    let row = proseql_engine::validator::decode_owned_value(
        &schema,
        if consumer {
            consumer_row(1, 0, 65_348)
        } else {
            synthetic_row(1, 0, 43_000)
        },
    )
    .map_err(tag)?;
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let row_payload_bytes = Some(ALLOCATOR.live_and_peak().0 - before);
    #[cfg(any(not(feature = "allocation-meter"), feature = "heap-profile"))]
    let row_payload_bytes: Option<usize> = None;
    let object = row.as_object().expect("fixture object");
    println!(
        "LM_LAYOUT {}",
        json!({"canonical_value_bytes":std::mem::size_of::<Value>(),
        "map_header_bytes":std::mem::size_of::<serde_json::Map<String,Value>>(),
        "field_pair_bytes_without_indexmap_hash":std::mem::size_of::<(String,Value)>(),
        "fields":object.len(),"field_name_bytes":object.keys().map(String::len).sum::<usize>(),
        "string_value_bytes":object.values().filter_map(Value::as_str).map(str::len).sum::<usize>(),
        "row_payload_requested_heap_bytes":row_payload_bytes,
        "resident_target_bytes":1024,"target_met_by_payload_alone":row_payload_bytes.map(|bytes|bytes<=1024),
        "compact_handoff_target_bytes":500,"compact_target_met_by_payload_alone":row_payload_bytes.map(|bytes|bytes<=500)})
    );
    Ok(())
}

fn main() {
    if let Err(error) = main_result() {
        eprintln!("lazy_memory_bench: {error}");
        std::process::exit(1);
    }
}

fn main_result() -> Result<(), Error> {
    let args = parse_args()?;
    if args.prepare {
        return prepare(&args);
    }
    if args.layout {
        return layout_probe(args.consumer);
    }
    START.get_or_init(Instant::now);
    #[cfg(feature = "heap-profile")]
    let profile = args.profile.as_ref().map(|path| {
        PROFILING.store(true, Ordering::Relaxed);
        dhat::Profiler::builder()
            .file_name(path)
            .trim_backtraces(Some(32))
            .build()
    });
    #[cfg(not(feature = "heap-profile"))]
    let profile = Profile;
    if args.source_sessions {
        sessions::run(&args, profile)
    } else {
        run(&args, profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    #[test]
    fn sparse_schema_does_not_allocate_slots_for_absent_optional_fields() {
        let mut fields = vec![StructField {
            name: "id".into(),
            schema: SchemaNode::Str,
        }];
        fields.extend((0..100).map(|index| StructField {
            name: format!("optional{index}"),
            schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
        }));
        let schema = SchemaNode::Struct { fields };
        let before = ALLOCATOR.live_and_peak().0;
        let value =
            proseql_engine::validator::decode_owned_value(&schema, json!({"id":"row"})).unwrap();
        let payload = ALLOCATOR.live_and_peak().0 - before;
        drop(value);
        eprintln!("CAPACITY_PROOF sparse_struct_live_bytes={payload}");
        assert!(
            payload < 256,
            "one present field retained {payload} bytes instead of a compact object"
        );
    }

    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    #[test]
    fn filtered_record_does_not_retain_slots_for_rejected_keys() {
        let schema = SchemaNode::Record {
            key: Box::new(SchemaNode::Literal {
                value: json!("keep"),
            }),
            value: Box::new(SchemaNode::Str),
        };
        let before = ALLOCATOR.live_and_peak().0;
        let input = Value::Object(
            (0..100)
                .map(|index| (format!("drop{index}"), json!(false)))
                .chain(std::iter::once(("keep".into(), json!("v"))))
                .collect(),
        );
        let value = proseql_engine::validator::decode_owned_value(&schema, input).unwrap();
        let payload = ALLOCATOR.live_and_peak().0 - before;
        assert_eq!(value, json!({"keep":"v"}));
        drop(value);
        eprintln!("CAPACITY_PROOF filtered_record_live_bytes={payload}");
        assert!(
            payload < 256,
            "one retained Record key kept {payload} bytes of capacity"
        );
    }

    #[test]
    fn fixed_shape_is_synthetic_flat_deterministic_and_utc() {
        for month in 1..=MONTHS {
            for i in [0, 42_999] {
                let row = synthetic_row(month, i, 43_000);
                assert_eq!(serde_json::to_vec(&row).unwrap().len() + 1, ROW_BYTES);
                assert_eq!(row.as_object().unwrap().len(), 12);
                assert!(row
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|v| !v.is_array() && !v.is_object()));
                assert!(row["timestamp"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("2025-{month:02}-")));
                assert!(row["timestamp"].as_str().unwrap().ends_with('Z'));
                assert_eq!(row, synthetic_row(month, i, 43_000));
            }
        }
    }

    #[test]
    fn every_synthetic_source_kind_opens_and_returns_the_same_rows() {
        for kind in ["month", "file", "documents", "sharded", "yaml-partitions"] {
            let dir = tempfile::tempdir().unwrap();
            let args = Args {
                root: dir.path().into(),
                rows: 2,
                ids: 2,
                mode: "scan".into(),
                prepare: false,
                profile: None,
                check: false,
                bounded: true,
                layout: false,
                trim_end: false,
                consumer: true,
                idle_check: false,
                idle_seconds: 0,
                cache_partitions: 1,
                source_kind: kind.into(),
                append_one: false,
                history_copies: 0,
                source_sessions: false,
                reclaim_idle: false,
            };
            prepare(&args).unwrap();
            let (config, options) = config(&args);
            let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
            let rows = runtime
                .query_bounded(COLLECTION, QueryInput::default())
                .unwrap();
            assert_eq!(rows.len(), MONTHS * args.rows, "source kind {kind}");
            drop(rows);
            let mut appended = consumer_row(10, 2, 3);
            if kind == "sharded" {
                appended["shard"] = json!("ff");
            }
            runtime
                .mutate(|tx| tx.create(COLLECTION, appended))
                .unwrap();
            assert_eq!(
                runtime
                    .query_bounded(COLLECTION, QueryInput::default())
                    .unwrap()
                    .len(),
                MONTHS * args.rows + 1
            );
            runtime.close().unwrap();
        }
    }

    #[test]
    fn consumer_fixture_preserves_reported_fields_and_string_lengths() {
        let row = consumer_row(1, 0, 65_348);
        assert_eq!(row.as_object().unwrap().len(), 11);
        assert_eq!(row["id"].as_str().unwrap().len(), 84);
        assert_eq!(row["rawId"].as_str().unwrap().len(), 48);
        assert!(row["end"].is_null());
        assert!(row["at"].as_str().unwrap().ends_with("+00:00"));
        assert!(row["atUtc"].as_str().unwrap().ends_with('Z'));
        assert!(row["value"].is_number());
        assert_eq!(row, consumer_row(1, 0, 65_348));
    }

    #[test]
    fn budgets_reject_resident_and_transient_regressions_independently() {
        let rows = 1000;
        let bound = 2 * rows as u64 * 1024 + 50 * 1024 * 1024;
        assert!(!over_budget(1024 * rows as u64, bound, 0, rows));
        assert!(over_budget(1024 * rows as u64 + 1, bound, 0, rows));
        assert!(over_budget(0, bound + 1, 0, rows));
    }
}
