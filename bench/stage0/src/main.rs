mod fixture;
mod native;
#[cfg(feature = "heap-meter")]
mod observe;
#[cfg(not(feature = "heap-meter"))]
#[allow(dead_code)]
mod observe;
mod query;
mod spike;
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
    Spike(spike::Scanner),
}
impl Backend {
    fn open(root: &Path, backend: &str, kind: &str) -> Result<Self, Error> {
        Ok(match backend {
            "sqlite" => Self::Sql(sql::open(root)?),
            "proseql" => Self::Native(native::open(root, kind)?),
            "spike" => Self::Spike(spike::Scanner::open(root, kind)?),
            _ => return Err("backend must be sqlite|proseql|spike".into()),
        })
    }
    fn run(&mut self, root: &Path, kind: &str, workload: &str) -> Result<Answer, Error> {
        if workload == "idle" {
            std::thread::sleep(Duration::from_secs(1));
            return Ok(Answer::default());
        }
        if workload == "append" {
            return match self {
                Self::Sql(c) => sql::append(c, kind),
                Self::Native(r) => native::append(r, kind),
                Self::Spike(_) => spike::append(root, kind),
            };
        }
        let q = Query::new(kind, workload);
        match self {
            Self::Sql(c) => sql::query(c, kind, &q),
            Self::Native(r) => native::query(r, kind, &q),
            Self::Spike(r) => r.query(&q),
        }
    }
}
fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 2 && args[0] == "prepare" {
        let m = fixture::prepare(Path::new(&args[1]), None)?;
        println!("{}", serde_json::json!({"fixture":m,"sqlite":sql::info(Path::new(&args[1]))?}));
        return Ok(());
    }
    if args.len() != 5 {
        return Err("usage: proseql-stage0 prepare ROOT | ROOT sqlite|proseql|spike samples|raw WORKLOAD cold|warm".into());
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
            opened.as_mut().unwrap().run(root, kind, workload)?;
        }
    }
    observe::reset_rss_peak()?;
    #[cfg(feature = "heap-meter")]
    METER.reset();
    sql::heap(true);
    let rss_before = observe::status("VmRSS:")?;
    let counter = observe::Instructions::new()?;
    counter.start()?;
    let start = Instant::now();
    let answer = if workload == "open" {
        opened = Some(Backend::open(root, backend, kind)?);
        Answer::default()
    } else {
        opened.as_mut().unwrap().run(root, kind, workload)?
    };
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let instructions = counter.stop()?;
    let rss_return = observe::status("VmRSS:")?;
    let rss_peak = observe::status("VmHWM:")?;
    #[cfg(feature = "heap-meter")]
    let heap = Some(METER.sample());
    #[cfg(not(feature = "heap-meter"))]
    let heap: Option<(usize, usize)> = None;
    let c_heap = sql::heap(false);
    // Keep the backend open. This is not source-session teardown or malloc_trim.
    std::thread::sleep(Duration::from_secs(1));
    let rss_1s = observe::status("VmRSS:")?;
    println!(
        "{}",
        serde_json::json!({"backend":backend,"kind":kind,"workload":workload,"cache":cache,"wall_ms":wall_ms,"instructions":instructions,"rss_before":rss_before,"rss_return":rss_return,"rss_peak":rss_peak,"rss_1s":rss_1s,"rust_heap_live_peak":heap,"sqlite_c_heap_live_peak":if backend=="sqlite" {Some(c_heap)} else {None},"answer":answer})
    );
    drop(opened);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_backends_agree_on_rows_groups_and_identical_duplicates() -> Result<(), Error> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("fixture");
        let native_root = tmp.path().join("native");
        let spike_root = tmp.path().join("spike");
        for path in [&root, &native_root, &spike_root] {
            fixture::prepare(path, Some(1000))?;
        }
        for kind in fixture::KINDS {
            let mut sqlite = Backend::open(&root, "sqlite", kind)?;
            let mut native = Backend::open(&native_root, "proseql", kind)?;
            let mut spike = Backend::open(&spike_root, "spike", kind)?;
            for workload in ["point", "hour", "month", "ten"] {
                let expected = sqlite.run(&root, kind, workload)?;
                assert!(expected.count > 0);
                assert_eq!(
                    expected,
                    native.run(&native_root, kind, workload)?,
                    "native {kind} {workload}"
                );
                assert_eq!(
                    expected,
                    spike.run(&spike_root, kind, workload)?,
                    "spike {kind} {workload}"
                );
            }
            let expected = sqlite.run(&root, kind, "append")?;
            assert_eq!(expected, spike.run(&spike_root, kind, "append")?);
            assert_eq!(expected, native.run(&native_root, kind, "append")?);
            // Replays verify exact duplicates; reopen validates rebuilt unsorted indexes.
            assert_eq!(expected, sqlite.run(&root, kind, "append")?);
            assert_eq!(expected, spike.run(&spike_root, kind, "append")?);
            assert_eq!(expected, native.run(&native_root, kind, "append")?);
            drop(spike);
            let mut spike = Backend::open(&spike_root, "spike", kind)?;
            for workload in ["point", "hour", "month", "ten"] {
                let expected = sqlite.run(&root, kind, workload)?;
                assert_eq!(expected, spike.run(&spike_root, kind, workload)?);
                assert_eq!(expected, native.run(&native_root, kind, workload)?);
            }
        }
        Ok(())
    }
    #[test]
    fn conflicting_duplicates_fail_without_publishing_new_rows() -> Result<(),Error> {
        use std::io::Write;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("fixture");
        fixture::prepare(&root,Some(1000))?;
        let path = root.join("samples/2025-10.jsonl");
        let id = fixture::row(10,900,0,false)["id"].as_str().unwrap().to_owned();
        let mut rows = std::fs::read_to_string(&path)?.lines().map(serde_json::from_str::<serde_json::Value>).collect::<Result<Vec<_>,_>>()?;
        for row in &mut rows {if row["id"].as_str() == Some(&id) {row["value"] = serde_json::json!(-1.0);}}
        let mut file = std::fs::File::create(&path)?;
        for row in rows {writeln!(file,"{row}")?;}
        file.sync_data()?;
        let size = std::fs::metadata(&path)?.len();
        let conn = sql::open(&root)?;
        conn.execute("UPDATE samples SET value=-1 WHERE id=?1",[&id])?;
        drop(conn);
        let mut backends = [Backend::open(&root,"sqlite","samples")?,Backend::open(&root,"proseql","samples")?,Backend::open(&root,"spike","samples")?];
        let expected = backends[0].run(&root,"samples","ten")?;
        for backend in &mut backends {
            assert!(backend.run(&root,"samples","append").is_err());
            assert_eq!(std::fs::metadata(&path)?.len(),size);
            assert_eq!(backend.run(&root,"samples","ten")?,expected);
        }
        Ok(())
    }

    #[test]
    fn stale_index_and_same_timestamp_block_boundaries_are_safe() -> Result<(), Error> {
        use std::io::Write;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("fixture");
        fixture::prepare(&root, Some(120))?;
        let path = root.join("samples/2025-05.jsonl");
        let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
        for i in 0..600 {
            let mut row = fixture::point("samples");
            row["id"] = serde_json::json!(format!("tie-{i}"));
            writeln!(file, "{row}")?;
        }
        file.sync_data()?;
        let scan = spike::Scanner::open(&root, "samples")?;
        let mut q = Query::new("samples", "hour");
        q.from = "2025-05-01T00:12:00.000Z";
        q.to = "2025-05-01T00:13:00.000Z";
        assert_eq!(scan.query(&q)?.count, 602);
        // Sort the same records so repeated timestamps cross sparse block boundaries.
        let mut rows = std::fs::read_to_string(&path)?
            .lines()
            .map(serde_json::from_str::<serde_json::Value>)
            .collect::<Result<Vec<_>, _>>()?;
        rows.sort_by(|a, b| a["atUtc"].as_str().cmp(&b["atUtc"].as_str()));
        let mut out = std::fs::File::create(&path)?;
        for row in rows {
            writeln!(out, "{row}")?;
        }
        out.sync_data()?;
        assert_eq!(
            spike::Scanner::open(&root, "samples")?.query(&q)?.count,
            602
        );
        std::fs::remove_file(path.with_extension("sparse.json"))?;
        assert_eq!(
            spike::Scanner::open(&root, "samples")?.query(&q)?.count,
            602
        );
        // Corrupt sidecar is disposable, not an authoritative answer source.
        std::fs::write(path.with_extension("sparse.json"), "broken")?;
        assert_eq!(
            spike::Scanner::open(&root, "samples")?.query(&q)?.count,
            602
        );
        Ok(())
    }
}
