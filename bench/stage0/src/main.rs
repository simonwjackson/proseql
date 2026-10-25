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
            "proseql" => Self::Native(native::open(root,kind)?),
            "spike" => Self::Spike(spike::Scanner::open(root,kind)?),
            _ => return Err("backend must be sqlite|proseql|spike".into()),
        })
    }
    fn run(&mut self, root: &Path, kind: &str, workload: &str) -> Result<Answer, Error> {
        if workload == "idle" { std::thread::sleep(Duration::from_secs(1)); return Ok(Answer::default()); }
        if workload == "append" {
            return match self {
                Self::Sql(c) => sql::append(c, kind),
                Self::Native(r) => native::append(r, kind),
                Self::Spike(_) => spike::append(root,kind),
            };
        }
        let q = Query::new(kind, workload);
        match self {
            Self::Sql(c) => sql::query(c,kind,&q),
            Self::Native(r) => native::query(r,kind,&q),
            Self::Spike(r) => r.query(&q),
        }
    }
}
fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 2 && args[0] == "prepare" {
        let m = fixture::prepare(Path::new(&args[1]), None)?;
        println!("{}",serde_json::to_string(&m)?);return Ok(());
    }
    if args.len() != 5 {return Err("usage: proseql-stage0 prepare ROOT | ROOT sqlite|proseql|spike samples|raw WORKLOAD cold|warm".into());}
    let root = Path::new(&args[0]);
    let (backend,kind,workload,cache) = (&args[1],&args[2],&args[3],&args[4]);
    if !fixture::KINDS.contains(&kind.as_str()) || !fixture::WORKLOADS.contains(&workload.as_str()) || !["cold","warm"].contains(&cache.as_str()) {return Err("invalid kind/workload/cache".into());}
    let mut opened = if workload == "open" {None} else {Some(Backend::open(root,backend,kind)?)};
    if cache == "warm" {
        if workload == "open" {drop(Backend::open(root,backend,kind)?);}
        else if !["append","idle"].contains(&workload.as_str()) {opened.as_mut().unwrap().run(root,kind,workload)?;}
    }
    observe::reset_rss_peak()?;
    #[cfg(feature = "heap-meter")] METER.reset();
    sql::heap(true);
    let rss_before = observe::status("VmRSS:")?;
    let counter = observe::Instructions::new()?;
    counter.start()?;
    let start = Instant::now();
    let answer = if workload == "open" {
        opened = Some(Backend::open(root,backend,kind)?); Answer::default()
    } else {opened.as_mut().unwrap().run(root,kind,workload)?};
    let wall_ms = start.elapsed().as_secs_f64()*1000.0;
    let instructions = counter.stop()?;
    let rss_return = observe::status("VmRSS:")?;
    let rss_peak = observe::status("VmHWM:")?;
    #[cfg(feature = "heap-meter")] let heap = Some(METER.sample());
    #[cfg(not(feature = "heap-meter"))] let heap: Option<(usize,usize)> = None;
    let c_heap = sql::heap(false);
    // Keep the backend open. This is not source-session teardown or malloc_trim.
    std::thread::sleep(Duration::from_secs(1));
    let rss_1s = observe::status("VmRSS:")?;
    println!("{}",serde_json::json!({"backend":backend,"kind":kind,"workload":workload,"cache":cache,"wall_ms":wall_ms,"instructions":instructions,"rss_before":rss_before,"rss_return":rss_return,"rss_peak":rss_peak,"rss_1s":rss_1s,"rust_heap_live_peak":heap,"sqlite_c_heap_live_peak":if backend=="sqlite" {Some(c_heap)} else {None},"answer":answer}));
    drop(opened);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_backends_agree_on_rows_groups_and_identical_duplicates() -> Result<(),Error> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("fixture");
        fixture::prepare(&root,Some(120))?;
        for kind in fixture::KINDS {
            let mut sqlite = Backend::open(&root,"sqlite",kind)?;
            let mut native = Backend::open(&root,"proseql",kind)?;
            let mut spike = Backend::open(&root,"spike",kind)?;
            for workload in ["point","hour","month","ten"] {
                let expected = sqlite.run(&root,kind,workload)?;
                assert!(expected.count > 0);
                assert_eq!(expected,native.run(&root,kind,workload)?,"native {kind} {workload}");
                assert_eq!(expected,spike.run(&root,kind,workload)?,"spike {kind} {workload}");
            }
            // Each text implementation needs independent bytes for append parity.
            drop(native);drop(spike);
            let expected = sqlite.run(&root,kind,"append")?;
            let mut spike = Backend::open(&root,"spike",kind)?;
            assert_eq!(expected,spike.run(&root,kind,"append")?);
            // Reopen native on scanner-written data: all 1,000 now exist, exactly.
            let mut native = Backend::open(&root,"proseql",kind)?;
            assert_eq!(expected,native.run(&root,kind,"append")?);
            // Replay again and validate the stale/unsorted sparse index fallback.
            assert_eq!(expected,spike.run(&root,kind,"append")?);
            let mut spike = Backend::open(&root,"spike",kind)?;
            for workload in ["point","hour","month","ten"] {
                let expected = sqlite.run(&root,kind,workload)?;
                assert_eq!(expected,spike.run(&root,kind,workload)?);
                assert_eq!(expected,native.run(&root,kind,workload)?);
            }
        }
        Ok(())
    }
    #[test]
    fn stale_index_and_same_timestamp_block_boundaries_are_safe() -> Result<(),Error> {
        use std::io::Write;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().join("fixture");
        fixture::prepare(&root,Some(120))?;
        let path = root.join("samples/2025-05.jsonl");
        let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
        for i in 0..600 {
            let mut row = fixture::point("samples");
            row["id"] = serde_json::json!(format!("tie-{i}"));
            writeln!(file,"{row}")?;
        }
        file.sync_data()?;
        let scan = spike::Scanner::open(&root,"samples")?;
        let mut q = Query::new("samples","hour");
        q.from = "2025-05-01T00:12:00.000Z";
        q.to = "2025-05-01T00:13:00.000Z";
        assert_eq!(scan.query(&q)?.count,602);
        // Corrupt sidecar is disposable, not an authoritative answer source.
        std::fs::write(path.with_extension("sparse.json"),"broken")?;
        assert_eq!(spike::Scanner::open(&root,"samples")?.query(&q)?.count,602);
        Ok(())
    }
}
