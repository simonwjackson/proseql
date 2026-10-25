mod support;

use proseql_engine::query::QueryInput;
use serde_json::json;
use support::parity::RuntimeKind;
use support::parity::{sample, ParityFixture, COLLECTION};

#[test]
#[ignore = "synthetic aka append-then-range profile"]
fn measure_append_then_range() {
    let fixture = ParityFixture::new(2);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let input = QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-01T00:00:00.000Z","$lt":"2025-02-01T01:00:00.000Z"}}),
        ),
        ..Default::default()
    };
    let expected = runtime.query_bounded(COLLECTION, input.clone()).unwrap();
    for index in 0..3 {
        let mut row = sample("2025-02", 28, 1439, "steps");
        let at = format!("2025-02-28T23:59:59.{index:03}Z");
        row["id"] = json!(format!("steps:{at}"));
        row["atUtc"] = json!(at);
        runtime
            .mutate(|tx| tx.create(COLLECTION, row).map(|_| ()))
            .unwrap();
        let start = std::time::Instant::now();
        let (actual, stats) = runtime
            .query_bounded_with_stats(COLLECTION, input.clone())
            .unwrap();
        println!(
            "append_then_range trial={index} wall_ms={} candidate_rows={}",
            start.elapsed().as_secs_f64() * 1000.0,
            stats.candidate_rows
        );
        assert_eq!(expected, actual);
    }
}

#[test]
fn append_built_membership_does_not_bypass_first_lookup_payload_validation() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut bad = sample("2025-02", 28, 1, "steps");
    bad["value"] = json!("invalid");
    text.push_str(&format!("{bad}\n"));
    std::fs::write(&path, text).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let created = sample("2025-03", 31, 1, "steps");
    runtime
        .mutate(|tx| tx.create(COLLECTION, created.clone()).map(|_| ()))
        .unwrap();
    let mut duplicate = sample("2025-01", 31, 1, "steps");
    duplicate["id"] = created["id"].clone();
    let january = fixture.partition_path("2025-01");
    let text = std::fs::read_to_string(&january).unwrap();
    std::fs::write(january, format!("{text}{duplicate}\n")).unwrap();
    let error = runtime
        .find_by_id(COLLECTION, created["id"].as_str().unwrap())
        .unwrap_err();
    assert_eq!(error.tag(), "ValidationError");
}

#[test]
fn first_range_validates_full_file_and_later_seek_skips_unread_invalid_rows() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = String::new();
    for minute in 0..3600 {
        let row = sample("2025-02", minute / 1440 + 1, minute % 1440, "steps");
        text.push_str(&format!("{row}\n"));
    }
    let mut bad = sample("2025-02", 4, 0, "steps");
    bad["value"] = json!("invalid");
    std::fs::write(&path, format!("{text}{bad}\n")).unwrap();
    let input = QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-01T00:00:00.000Z","$lt":"2025-02-01T01:00:00.000Z"}}),
        ),
        ..Default::default()
    };
    let runtime = fixture.open(RuntimeKind::Lazy);
    assert!(runtime.query_bounded(COLLECTION, input.clone()).is_err());
    bad["value"] = json!(1);
    std::fs::write(&path, format!("{text}{bad}\n")).unwrap();
    let (first, stats) = runtime
        .query_bounded_with_stats(COLLECTION, input.clone())
        .unwrap();
    assert_eq!(first.len(), 60);
    assert_eq!(stats.candidate_rows, 3601);
    bad["value"] = json!("invalid");
    std::fs::write(&path, format!("{text}{bad}\n")).unwrap();
    let (later, stats) = runtime.query_bounded_with_stats(COLLECTION, input).unwrap();
    assert_eq!(first, later);
    assert!(stats.candidate_rows < 3601);
}
