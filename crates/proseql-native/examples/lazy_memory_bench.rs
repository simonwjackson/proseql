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

#[path = "lazy_memory/allocator_os.rs"]
mod allocator_os;

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
            resident_rows,
        );
    let resident_measurement = PROFILING.load(Ordering::Relaxed).then_some(resident);
    println!(
        "LM_SUMMARY {}",
        json!({"mode": args.mode, "bounded": args.bounded, "rows_per_month": args.rows,
        "id_rows": args.ids, "data_bytes": MONTHS * args.rows * ROW_BYTES,
        "open_ms": open_ms, "open_rss": open_rss, "opened_heap": opened,
        "first_resident_heap_delta": resident_measurement, "resident_rows": resident_rows,
        "resident_bytes_per_row": resident_measurement.map(|bytes| bytes as f64 / resident_rows as f64),
        "id_data_bytes": fs::metadata(args.root.join("ids.jsonl"))?.len(),
        "final_heap": final_heap, "rss": proc_bytes("VmRSS:"), "rss_hwm": proc_bytes("VmHWM:"),
        "allocator": allocator_os::stats(), "check_failed": failed, "instrumented": cfg!(feature="bench-observe"), "profiled": PROFILING.load(Ordering::Relaxed)})
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
    if failed {
        return Err(
            "memory budget exceeded (1024 resident B/row; open + 2 partitions + 50 MiB peak)"
                .into(),
        );
    }
    Ok(())
}

fn layout_probe() -> Result<(), Error> {
    let schema = descriptor(false).schema;
    #[cfg(all(feature = "allocation-meter", not(feature = "heap-profile")))]
    let before = ALLOCATOR.live_and_peak().0;
    let row = proseql_engine::validator::decode_owned_value(&schema, synthetic_row(1, 0, 43_000))
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
        "resident_target_bytes":1024,"target_met_by_payload_alone":row_payload_bytes.map(|bytes|bytes<=1024)})
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
        return layout_probe();
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
    fn budgets_reject_resident_and_transient_regressions_independently() {
        let rows = 1000;
        let bound = 2 * rows as u64 * 1024 + 50 * 1024 * 1024;
        assert!(!over_budget(1024 * rows as u64, bound, 0, rows));
        assert!(over_budget(1024 * rows as u64 + 1, bound, 0, rows));
        assert!(over_budget(0, bound + 1, 0, rows));
    }
}
