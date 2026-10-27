mod fixture;
mod native;
#[cfg_attr(not(feature = "heap-meter"), allow(dead_code))]
mod observe;
mod query;
mod sql;

use query::{Answer, Query};
use std::path::Path;
use std::time::{Duration, Instant};
type Error = Box<dyn std::error::Error + Send + Sync>;
#[cfg(feature = "heap-meter")]
#[global_allocator]
static METER: observe::Meter = observe::Meter::new();

#[allow(clippy::large_enum_variant)]
enum Backend {
    Sql(rusqlite::Connection),
    Native(proseql_native::NativeRuntime),
}
impl Backend {
    fn open(root: &Path, backend: &str, kind: &str) -> Result<Self, Error> {
        Ok(match backend {
            "sqlite" => Self::Sql(sql::open(root)?),
            "streaming" => Self::Native(native::open(root, kind)?),
            _ => return Err("backend must be sqlite|streaming".into()),
        })
    }
    fn append_rows(&mut self, kind: &str, rows: Vec<serde_json::Value>) -> Result<Answer, Error> {
        match self {
            Self::Sql(c) => sql::append_rows(c, kind, rows),
            Self::Native(r) => native::append_rows(r, kind, rows),
        }
    }
    fn run(&mut self, kind: &str, workload: &str) -> Result<Answer, Error> {
        if workload == "idle" {
            std::thread::sleep(Duration::from_secs(1));
            return Ok(Answer::default());
        }
        if workload == "append" {
            return self.append_rows(kind, fixture::append_rows(kind));
        }
        let q = Query::new(kind, workload);
        match self {
            Self::Sql(c) => sql::query(c, kind, &q),
            Self::Native(r) => native::query(r, kind, &q),
        }
    }
}

/// A new ID routed to October already exists (with different content) in May.
/// This independent probe never primes the measured append runtime.
fn global_duplicate_probe(root: &Path, backend: &str, kind: &str) -> Result<bool, Error> {
    use std::io::Write;
    fixture::prepare(root, Some(120), 256)?;
    let mut stored = if kind.starts_with("raw") {
        fixture::raw(fixture::row(5, 12, 0, false))
    } else {
        fixture::row(5, 12, 0, false)
    };
    let source_id = stored["id"].as_str().unwrap().to_owned();
    let id = fixture::append_rows(kind)[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    stored["id"] = serde_json::json!(id);
    if kind == "raw" {
        stored["shard"] = serde_json::json!(format!(
            "{:02x}",
            (fixture::hash(id.as_bytes()) % 256 + 1) % 256
        ));
    }
    let stem = if kind == "raw" {
        stored["shard"].as_str().unwrap()
    } else {
        "2025-05"
    };
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(root.join(kind).join(format!("{stem}.jsonl")))?;
    writeln!(file, "{stored}")?;
    file.sync_data()?;
    sql::open(root)?.execute(&format!("INSERT INTO {kind} SELECT ?1,metric,at,end_time,value,source,received_at,raw_id,month,date,time,shard FROM {kind} WHERE id=?2"), rusqlite::params![id, source_id])?;
    let sizes = || -> Result<Vec<u64>, Error> {
        fixture::paths(root, kind)?
            .iter()
            .map(|p| Ok(std::fs::metadata(p)?.len()))
            .collect()
    };
    let before = sizes()?;
    let mut runtime = Backend::open(root, backend, kind)?;
    let refused = match runtime.run(kind, "append") {
        Ok(_) => false,
        Err(error) if error.to_string().to_lowercase().contains("duplicate") => true,
        Err(error) => return Err(error),
    };
    if refused && sizes()? != before {
        return Err("duplicate refusal published a partial append".into());
    }
    Ok(refused)
}

fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 2 && ["prepare", "prepare16"].contains(&args[0].as_str()) {
        let m = fixture::prepare(
            Path::new(&args[1]),
            None,
            if args[0] == "prepare16" { 16 } else { 256 },
        )?;
        println!(
            "{}",
            serde_json::json!({"fixture":m,"sqlite":sql::info(Path::new(&args[1]))?})
        );
        return Ok(());
    }
    if args.len() == 4 && args[0] == "duplicate-check" && fixture::KINDS.contains(&args[3].as_str())
    {
        println!(
            "{}",
            serde_json::json!({"global_duplicate_checks":global_duplicate_probe(Path::new(&args[1]), &args[2], &args[3])?})
        );
        return Ok(());
    }
    if args.len() != 5 {
        return Err("usage: proseql-acceptance prepare|prepare16 ROOT | duplicate-check ROOT BACKEND samples|raw|raw_month | ROOT sqlite|streaming samples|raw|raw_month WORKLOAD cold|warm".into());
    }
    let root = Path::new(&args[0]);
    let (backend, kind, workload, cache) = (&args[1], &args[2], &args[3], &args[4]);
    if !fixture::KINDS.contains(&kind.as_str())
        || !fixture::WORKLOADS.contains(&workload.as_str())
        || !["cold", "warm"].contains(&cache.as_str())
    {
        return Err("invalid kind/workload/cache".into());
    }
    let mut opened = if workload == "open" {
        None
    } else {
        Some(Backend::open(root, backend, kind)?)
    };
    if cache == "warm" {
        if workload == "open" {
            drop(Backend::open(root, backend, kind)?);
        } else if !["append", "append-range", "idle"].contains(&workload.as_str()) {
            opened.as_mut().unwrap().run(kind, workload)?;
        }
    }
    // Both cache modes prime a checked time index before the sync pattern.
    // No ID/mutation preflight: the timed append still builds global membership.
    if workload == "append-range" {
        opened.as_mut().unwrap().run(kind, "sync-range")?;
    }
    observe::reset_rss_peak()?;
    #[cfg(feature = "heap-meter")]
    METER.reset();
    sql::heap(true);
    let rss_before = observe::status("VmRSS:")?;
    // perf can be disabled by the host. Absence is explicit, never a zero count.
    let counter = match observe::Instructions::new() {
        Ok(counter) => Some(counter),
        Err(error) => {
            eprintln!("instructions unmeasured: {error}");
            None
        }
    };
    if let Some(counter) = &counter {
        counter.start()?;
    }
    let start = Instant::now();
    let mut sync_stages_ms = None;
    let answer = if workload == "append-range" {
        let runtime = opened.as_mut().unwrap();
        runtime.append_rows(kind, fixture::sync_rows(kind))?;
        let append_ms = start.elapsed().as_secs_f64() * 1000.0;
        let range_start = Instant::now();
        let answer = runtime.run(kind, "sync-range")?;
        sync_stages_ms = Some((append_ms, range_start.elapsed().as_secs_f64() * 1000.0));
        answer
    } else if workload == "open" {
        opened = Some(Backend::open(root, backend, kind)?);
        Answer::default()
    } else {
        opened.as_mut().unwrap().run(kind, workload)?
    };
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let instructions = counter.map(|c| c.stop()).transpose()?;
    let rss_return = observe::status("VmRSS:")?;
    let rss_peak = observe::status("VmHWM:")?;
    #[cfg(feature = "heap-meter")]
    let heap = Some(METER.sample());
    #[cfg(not(feature = "heap-meter"))]
    let heap: Option<(usize, usize)> = None;
    let c_heap = sql::heap(false);
    // Keep the backend alive: no malloc_trim, close, or source-session teardown.
    std::thread::sleep(Duration::from_secs(1));
    let rss_1s = observe::status("VmRSS:")?;
    let mut rss_release_1s = None;
    let mut release_ms = None;
    #[cfg(feature = "heap-meter")]
    let mut heap_after_release = None;
    #[cfg(not(feature = "heap-meter"))]
    let heap_after_release: Option<(usize, usize)> = None;
    if workload == "point" {
        if let Some(Backend::Native(runtime)) = &opened {
            let start = Instant::now();
            runtime
                .release_streaming_indexes()
                .map_err(|e| e.to_string())?;
            release_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            std::thread::sleep(Duration::from_secs(1));
            rss_release_1s = Some(observe::status("VmRSS:")?);
            #[cfg(feature = "heap-meter")]
            {
                heap_after_release = Some(METER.sample());
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"sync_stages_ms":sync_stages_ms,"rss_release_1s":rss_release_1s,"release_ms":release_ms,"rust_heap_after_release":heap_after_release,"backend":backend,"kind":kind,"workload":workload,"cache":cache,"wall_ms":wall_ms,"instructions":instructions,"append_new_rows":if ["append","append-range"].contains(&workload.as_str()) {Some(1000)} else {None},"rss_before":rss_before,"rss_return":rss_return,"rss_peak":rss_peak,"rss_1s":rss_1s,"rust_heap_live_peak":heap,"sqlite_c_heap_live_peak":if backend=="sqlite" {Some(c_heap)} else {None},"answer":answer})
    );
    drop(opened);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_models_match_sqlite_and_persist_new_rows_and_duplicate_replays() -> Result<(), Error>
    {
        let tmp = tempfile::tempdir()?;
        for kind in fixture::KINDS {
            let mut expected = Vec::new();
            for backend in ["sqlite", "streaming"] {
                let root = tmp.path().join(format!("{kind}-{backend}"));
                fixture::prepare(&root, Some(120), 256)?;
                let mut runtime = Backend::open(&root, backend, kind)?;
                let mut answers = Vec::new();
                for workload in ["point", "hour", "month", "ten", "append", "append", "ten"] {
                    let answer = runtime.run(kind, workload)?;
                    assert!(answer.count > 0);
                    answers.push(answer);
                }
                if backend == "sqlite" {
                    expected = answers;
                } else {
                    assert_eq!(expected, answers, "{backend}/{kind}");
                }
                drop(runtime);
                let after = Backend::open(&root, backend, kind)?.run(kind, "ten")?;
                assert_eq!(after.count, 2800);
            }
        }
        Ok(())
    }
    #[test]
    fn append_then_same_month_range_matches_and_release_preserves_lookup() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        for kind in fixture::KINDS {
            let mut expected = None;
            for backend in ["sqlite", "streaming"] {
                let root = tmp.path().join(format!("sync-{kind}-{backend}"));
                fixture::prepare(&root, Some(120), 256)?;
                let mut runtime = Backend::open(&root, backend, kind)?;
                runtime.run(kind, "sync-range")?;
                runtime.append_rows(kind, fixture::sync_rows(kind))?;
                let answer = runtime.run(kind, "sync-range")?;
                assert_eq!(answer.count, 1000);
                if let Some(expected) = &expected {
                    assert_eq!(&answer, expected);
                }
                expected = Some(answer);
                let before = runtime.run(kind, "point")?;
                if let Backend::Native(r) = &runtime {
                    r.release_streaming_indexes().map_err(|e| e.to_string())?;
                }
                assert_eq!(before, runtime.run(kind, "point")?);
            }
        }
        assert!(Backend::open(tmp.path(), "resident", "samples").is_err());
        Ok(())
    }
    #[test]
    fn sqlite_rejects_cross_partition_conflicts_without_partial_append() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        for kind in fixture::KINDS {
            assert!(global_duplicate_probe(
                &tmp.path().join(kind),
                "sqlite",
                kind
            )?);
        }
        Ok(())
    }
    #[test]
    fn global_conflict_probe_requires_streaming_guarantee() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        for backend in ["streaming"] {
            for kind in fixture::KINDS {
                let supported = global_duplicate_probe(
                    &tmp.path().join(format!("{backend}-{kind}")),
                    backend,
                    kind,
                )?;
                assert!(supported, "Streaming must reject cross-partition conflicts");
            }
        }
        Ok(())
    }
    #[test]
    fn monthly_raw_keeps_complete_rows_and_prunes_month_files() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("monthly");
        fixture::prepare(&root, Some(120), 256)?;
        assert_eq!(fixture::paths(&root, "raw_month")?.len(), 10);
        let runtime = native::open(&root, "raw_month")?;
        let query = Query::new("raw_month", "hour");
        let (rows, stats) = runtime
            .query_bounded_with_stats(
                "raw_month",
                proseql_engine::query::pipeline::QueryInput {
                    r#where: Some(query.filter()),
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
        assert_eq!(stats.partitions_read, 1);
        let answer = Answer::rows(rows);
        assert_eq!(answer.count, 90);
        assert_eq!(
            answer,
            Backend::open(&root, "sqlite", "raw_month")?.run("raw_month", "hour")?
        );
        assert_eq!(
            answer,
            Backend::open(&root, "streaming", "raw")?.run("raw", "hour")?
        );
        Ok(())
    }
    #[test]
    fn controlled_partition_sweep_keeps_logical_aggregate_answers() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        let mut answers = Vec::new();
        for shards in [16, 256] {
            let root = tmp.path().join(shards.to_string());
            let manifest = fixture::prepare(&root, Some(120), shards)?;
            assert_eq!(manifest.rows_per_kind, 1800);
            assert_eq!(fixture::paths(&root, "raw")?.len(), shards as usize);
            answers.push(Backend::open(&root, "streaming", "raw")?.run("raw", "ten")?);
        }
        assert_eq!(answers[0], answers[1]);
        Ok(())
    }
}
