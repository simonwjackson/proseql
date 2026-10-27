//! Focused public-API probe for disposable-index publication costs.
#[allow(dead_code)]
#[path = "../src/fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../src/native.rs"]
mod native;
#[allow(dead_code)]
#[path = "../src/query.rs"]
mod query;
#[allow(dead_code)]
#[path = "../src/sql.rs"]
mod sql;
type Error = Box<dyn std::error::Error + Send + Sync>;

fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err("ROOT samples|raw|raw_month release|close|time|append".into());
    }
    let root = std::path::Path::new(&args[0]);
    let (kind, action) = (&args[1], &args[2]);
    let opened = std::time::Instant::now();
    let runtime = native::open(root, kind)?;
    let open_ms = opened.elapsed().as_secs_f64() * 1000.;
    let start = std::time::Instant::now();
    let answer = native::query(&runtime, kind, &query::Query::new(kind, "point"))?;
    let build_ms = start.elapsed().as_secs_f64() * 1000.;
    let extra = std::time::Instant::now();
    if action == "time" {
        native::query(&runtime, kind, &query::Query::new(kind, "hour"))?;
    }
    if action == "append" {
        native::append_rows(&runtime, kind, fixture::append_rows(kind))?;
    }
    let extra_ms = extra.elapsed().as_secs_f64() * 1000.;
    let publish = std::time::Instant::now();
    if action == "release" {
        runtime
            .release_streaming_indexes()
            .map_err(|e| e.to_string())?;
    } else {
        runtime.close().map_err(|e| e.to_string())?;
    }
    let publish_ms = publish.elapsed().as_secs_f64() * 1000.;
    runtime.close().map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::json!({"open_ms":open_ms,"build_ms":build_ms,"extra_ms":extra_ms,"publish_ms":publish_ms,"kind":kind,"action":action,"answer":answer})
    );
    Ok(())
}
