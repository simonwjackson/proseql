//! Public-API first-ID cost, including the validation pass, on synthetic text.
use super::support::parity::{ParityFixture, COLLECTION};
use proseql_native::ExecutionModel;
use std::fs;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static VALIDATION: Mutex<(Option<Instant>, Duration)> = Mutex::new((None, Duration::ZERO));

fn observe(phase: &'static str, begin: bool) {
    if phase != "streaming_id_validation" {
        return;
    }
    let mut timing = VALIDATION.lock().unwrap();
    if begin {
        timing.0 = Some(Instant::now());
    } else {
        let elapsed = timing.0.take().unwrap().elapsed();
        timing.1 += elapsed;
    }
}

/// Run on aka in release mode with --features bench-observe and --ignored.
#[test]
#[ignore = "656k-row public API measurement, not a routine regression test"]
fn first_id_validation_656k_rows() {
    assert!(proseql_storage::diagnostics::set_observer(observe));
    let fixture = ParityFixture::new(120);
    for month in 1..=10 {
        let mut file = std::io::BufWriter::new(
            fs::File::create(fixture.partition_path(&format!("2025-{month:02}"))).unwrap(),
        );
        for i in 0..65_664 {
            let at = format!(
                "2025-{month:02}-01T{:02}:{:02}:{:02}.000Z",
                i / 3600,
                (i / 60) % 60,
                i % 60
            );
            let row = serde_json::json!({
                "id":format!("steps:{at}:synthetic-device-with-a-long-identity"),
                "metric":"steps", "atUtc":at, "dateUtc":format!("2025-{month:02}-01"),
                "value":i, "unit":"count", "source":"synthetic-watch", "endUtc":null,
                "device":"synthetic-device-with-a-long-identity", "quality":"measured", "note":"synthetic only"
            });
            writeln!(file, "{row}").unwrap();
        }
        file.flush().unwrap();
    }
    let start = Instant::now();
    let runtime = fixture.open(ExecutionModel::Streaming);
    let open = start.elapsed();
    let id = "steps:2025-10-01T18:00:00.000Z:synthetic-device-with-a-long-identity";
    let start = Instant::now();
    let row = runtime.find_by_id(COLLECTION, id).unwrap().unwrap();
    let first = start.elapsed();
    let validation = VALIDATION.lock().unwrap().1;
    assert_eq!(row["id"], id);
    assert!(runtime
        .lazy_partition_status(COLLECTION)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
    let start = Instant::now();
    for _ in 0..1000 {
        assert!(runtime.find_by_id(COLLECTION, id).unwrap().is_some());
    }
    let warm = start.elapsed();
    runtime.close().unwrap();
    println!("native_first_id rows=656640 open_ms={:.3} first_lookup_ms={:.3} validation_ms={:.3} warm_lookup_mean_us={:.3}",
        open.as_secs_f64()*1000.0,first.as_secs_f64()*1000.0,validation.as_secs_f64()*1000.0,warm.as_secs_f64()*1_000_000.0/1000.0);
}
