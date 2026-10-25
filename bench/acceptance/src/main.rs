mod fixture;
mod native;
#[cfg_attr(not(feature = "heap-meter"), allow(dead_code))]
mod observe;
mod query;
mod sql;

#![allow(deprecated)] // Retained CLI selector; the removed Resident backend is refused.

use proseql_native::ExecutionModel;
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
            "resident" => Self::Native(native::open(root, kind, ExecutionModel::Resident)?),
            "streaming" => Self::Native(native::open(root, kind, ExecutionModel::Streaming)?),
            _ => return Err("backend must be sqlite|resident|streaming".into()),
        })
    }
    fn run(&mut self, kind: &str, workload: &str) -> Result<Answer, Error> {
        if workload == "idle" {
            std::thread::sleep(Duration::from_secs(1));
            return Ok(Answer::default());
        }
        if workload == "append" {
            return match self {
                Self::Sql(c) => sql::append(c, kind),
                Self::Native(r) => native::append(r, kind),
            };
        }
        let q = Query::new(kind, workload);
        match self {
            Self::Sql(c) => sql::query(c, kind, &q),
            Self::Native(r) => native::query(r, kind, &q),
        }
    }
}

/// A new ID routed to October already exists (with different content) in May.
/// Report a known Resident gap, not a benchmark-only preflight that hides it.
fn global_duplicate_probe(root: &Path, backend: &str, kind: &str) -> Result<bool, Error> {
    use std::io::Write;
    fixture::prepare(root, Some(120), 256)?;
    let mut stored = if kind == "raw" {
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
        return Err("usage: proseql-acceptance prepare|prepare16 ROOT | duplicate-check ROOT BACKEND samples|raw | ROOT sqlite|resident|streaming samples|raw WORKLOAD cold|warm".into());
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
        } else if !["append", "idle"].contains(&workload.as_str()) {
            opened.as_mut().unwrap().run(kind, workload)?;
        }
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
    let answer = if workload == "open" {
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
    println!(
        "{}",
        serde_json::json!({"backend":backend,"kind":kind,"workload":workload,"cache":cache,"wall_ms":wall_ms,"instructions":instructions,"append_new_rows":if workload=="append" {Some(1000)} else {None},"rss_before":rss_before,"rss_return":rss_return,"rss_peak":rss_peak,"rss_1s":rss_1s,"rust_heap_live_peak":heap,"sqlite_c_heap_live_peak":if backend=="sqlite" {Some(c_heap)} else {None},"answer":answer})
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
            for backend in ["sqlite", "resident", "streaming"] {
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
    fn global_conflict_probe_runs_both_public_models_and_can_gate_cutover() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        for backend in ["resident", "streaming"] {
            for kind in fixture::KINDS {
                let supported = global_duplicate_probe(
                    &tmp.path().join(format!("{backend}-{kind}")),
                    backend,
                    kind,
                )?;
                // Skeleton runs report the known miss. Verify can require the final
                // Streaming guarantee without changing this test or adding a preflight.
                if backend == "streaming" && std::env::var_os("ACCEPTANCE_REQUIRE_GLOBAL").is_some()
                {
                    assert!(supported, "Streaming must reject cross-partition conflicts");
                }
            }
        }
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
