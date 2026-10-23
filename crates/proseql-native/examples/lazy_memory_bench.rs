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
    CollectionFileSourceConfig, DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig,
    TimeBucket,
};
use serde_json::{json, Value};

type Error = Box<dyn std::error::Error + Send + Sync>;
fn tag(error: EngineError) -> Error {
    format!("{}: {error}", error.tag()).into()
}

const COLLECTION: &str = "samples";
const MONTHS: usize = 10;
const ROW_BYTES: usize = 316;
static START: OnceLock<Instant> = OnceLock::new();
static PROFILING: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "heap-profile")]
#[global_allocator]
static ALLOCATOR: dhat::Alloc = dhat::Alloc;

#[derive(Debug)]
struct Args {
    root: PathBuf,
    rows: usize,
    ids: usize,
    mode: String,
    prepare: bool,
    profile: Option<PathBuf>,
    check: bool,
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
    if !["zero", "ascending", "scan", "eager-id"].contains(&args.mode.as_str()) {
        return Err("mode must be zero|ascending|scan|eager-id".into());
    }
    if args.profile.is_some() && !cfg!(feature = "heap-profile") {
        return Err("--heap-profile needs --features heap-profile".into());
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

fn marker(args: &Args) -> String {
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
            serde_json::to_writer(&mut out, &synthetic_row(month, i, args.rows))?;
            out.write_all(b"\n")?;
        }
        out.flush()?;
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
    fs::write(marker_path, marker(args))?;
    println!("LM_DATA {}", marker(args));
    Ok(())
}

fn descriptor(ids: bool) -> CollectionDescriptor {
    let fields = if ids {
        vec![("id", SchemaNode::Str)]
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
            vec!["timestamp".into()]
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
    let ids = args.mode == "eager-id";
    let source = if ids {
        DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
            id: COLLECTION.into(),
            collection: COLLECTION.into(),
            path: args.root.join("ids.jsonl").to_string_lossy().into_owned(),
            format: Some("jsonl".into()),
            prose: None,
        })
    } else {
        DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: COLLECTION.into(),
            collection: COLLECTION.into(),
            root: args.root.join(COLLECTION).to_string_lossy().into_owned(),
            format: "jsonl".into(),
            prose: None,
            partition_by: PartitionKey::TimeBucket {
                field: "timestamp".into(),
                bucket: TimeBucket::Month,
            },
        })
    };
    let lazy_partitions = if ids {
        IndexMap::new()
    } else {
        IndexMap::from([(
            COLLECTION.into(),
            LazyPartitionPolicy {
                max_loaded_partitions: 1,
                full_scan: FullScanPolicy::Allow,
            },
        )])
    };
    (
        NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(descriptor(ids))],
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
    #[cfg(feature = "heap-profile")]
    if PROFILING.load(Ordering::Relaxed) {
        let stats = dhat::HeapStats::get();
        return json!({"live": stats.curr_bytes, "peak": stats.max_bytes,
            "allocated": stats.total_bytes, "allocations": stats.total_blocks});
    }
    Value::Null
}

fn checkpoint(phase: &'static str, begin: bool) {
    // Capture before diagnostic output allocations. Heap peak is cumulative,
    // not a phase-local peak; phase boundaries are not ownership attribution.
    let heap = heap();
    eprintln!(
        "LM_PHASE {}",
        json!({"phase": phase, "begin": begin,
        "elapsed_us": START.get_or_init(Instant::now).elapsed().as_micros(),
        "heap": heap, "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:")})
    );
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
    if args.mode == "eager-id" {
        resident = opened["live"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(before_open_heap["live"].as_u64().unwrap_or(0));
        assert_eq!(
            runtime
                .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
                .map_err(tag)?,
            args.ids
        );
    } else {
        let months = if args.mode == "scan" { 1 } else { MONTHS };
        for month in 1..=months {
            let width = match args.mode.as_str() {
                "ascending" => 1 + (month - 1) % 3,
                "scan" => MONTHS,
                _ => 1,
            };
            let end = (month + width).min(MONTHS + 1);
            let mut filter = json!({"timestamp": {"$gte": format!("2025-{month:02}-01T00:00:00.000Z"), "$lt": format!("2025-{end:02}-01T00:00:00.000Z")}});
            if args.mode != "ascending" {
                filter["value"] = json!({"$lt": -1});
            }
            let input = QueryInput {
                r#where: Some(filter),
                sort: vec![("timestamp".into(), SortOrder::Asc)],
                ..Default::default()
            };
            checkpoint("query_total", true);
            let start = Instant::now();
            let result = runtime.query(COLLECTION, input, None).map_err(tag)?;
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            checkpoint("query_total", false);
            let expected = if args.mode == "ascending" {
                (end - month) * args.rows
            } else {
                0
            };
            assert_eq!(result.len(), expected);
            assert_eq!(
                runtime
                    .lazy_partition_status(COLLECTION)
                    .map_err(tag)?
                    .unwrap()
                    .loaded
                    .len(),
                1
            );
            let snapshot = heap();
            println!(
                "LM_QUERY {}",
                json!({"month": month, "width": end-month,
                "elapsed_ms": elapsed_ms, "returned": result.len(),
                "partition_scope": end-month, "heap_with_results": snapshot,
                "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:")})
            );
            drop(result);
            if month == 1 {
                resident = heap()["live"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(opened["live"].as_u64().unwrap_or(0));
                checkpoint("first_resident_without_results", false);
            }
        }
    }
    let final_heap = heap();
    let resident_rows = if args.mode == "eager-id" {
        args.ids
    } else {
        args.rows
    };
    let failed = args.check
        && over_budget(
            resident,
            final_heap["peak"].as_u64().unwrap_or(0),
            opened["live"].as_u64().unwrap_or(0),
            args.rows,
        );
    println!(
        "LM_SUMMARY {}",
        json!({"mode": args.mode, "rows_per_month": args.rows,
        "id_rows": args.ids, "data_bytes": MONTHS * args.rows * ROW_BYTES,
        "open_ms": open_ms, "open_rss": open_rss, "opened_heap": opened,
        "first_resident_heap_delta": resident, "resident_rows": resident_rows,
        "resident_bytes_per_row": resident as f64 / resident_rows as f64,
        "id_data_bytes": fs::metadata(args.root.join("ids.jsonl"))?.len(),
        "final_heap": final_heap, "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:"),
        "check_failed": failed, "instrumented": cfg!(feature="bench-observe"), "profiled": PROFILING.load(Ordering::Relaxed)})
    );
    // End profile while the last partition (or eager IDs) is live, so DHAT eb
    // describes resident allocations. Their lifetimes are right-censored here.
    PROFILING.store(false, Ordering::Relaxed);
    #[cfg(feature = "heap-profile")]
    drop(_profile);
    runtime.close().map_err(tag)?;
    if failed {
        return Err(
            "memory budget exceeded (1024 resident B/row; open + 2 partitions + 50 MiB peak)"
                .into(),
        );
    }
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
    run(&args, profile)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn budgets_reject_resident_and_transient_regressions_independently() {
        let rows = 1000;
        let bound = 2 * rows as u64 * 1024 + 50 * 1024 * 1024;
        assert!(!over_budget(1024 * rows as u64, bound, 0, rows));
        assert!(over_budget(1024 * rows as u64 + 1, bound, 0, rows));
        assert!(over_budget(0, bound + 1, 0, rows));
    }
}
