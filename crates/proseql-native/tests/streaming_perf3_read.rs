mod support;

use proseql_engine::query::QueryInput;
use serde_json::json;
use support::parity::{sample, ParityFixture, RuntimeKind, COLLECTION};

#[test]
fn checked_lookup_observations_detect_same_length_edits_and_new_files() {
    let fixture = ParityFixture::new(720);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let id = "steps:2025-02-01T00:00:00.000Z";
    let old = runtime.find_by_id(COLLECTION, id).unwrap().unwrap();
    assert_eq!(
        runtime.find_by_id(COLLECTION, id).unwrap(),
        Some(old.clone())
    );
    let path = fixture.partition_path("2025-02");
    let text = std::fs::read_to_string(&path).unwrap();
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut row: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    row["value"] = json!(9.9);
    let changed = row.to_string();
    assert_eq!(changed.len(), lines[0].len());
    lines[0] = changed;
    std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    assert_eq!(runtime.find_by_id(COLLECTION, id).unwrap(), Some(row));
    let row = sample("2025-04", 1, 0, "steps");
    std::fs::write(fixture.partition_path("2025-04"), format!("{row}\n")).unwrap();
    assert_eq!(
        runtime
            .find_by_id(COLLECTION, row["id"].as_str().unwrap())
            .unwrap(),
        Some(row)
    );
    std::fs::remove_file(path).unwrap();
    assert_eq!(runtime.find_by_id(COLLECTION, id).unwrap(), None);
}

#[test]
fn refreshed_time_bounds_never_hide_external_out_of_range_edits() {
    let fixture = ParityFixture::new(720);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let input = QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-01T00:00:00.000Z","$lt":"2025-02-01T01:00:00.000Z"}}),
        ),
        ..Default::default()
    };
    let initial = runtime.query_bounded(COLLECTION, input.clone()).unwrap();
    assert_eq!(
        runtime.query_bounded(COLLECTION, input.clone()).unwrap(),
        initial
    );
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut extra = sample("2025-02", 1, 30, "steps");
    extra["id"] = json!("external");
    text.push_str(&format!("{extra}\n"));
    std::fs::write(path, text).unwrap();
    let eager = fixture.open(RuntimeKind::Eager);
    assert_eq!(
        runtime.query_bounded(COLLECTION, input.clone()),
        eager.query_bounded(COLLECTION, input)
    );
}

#[test]
fn checked_whole_shard_bounds_skip_opens_but_stale_bounds_never_hide_matches() {
    use proseql_native::NativeRuntime;
    use proseql_storage::source_config::{DatabaseSourceConfig, PartitionKey};
    let fixture = ParityFixture::new(720);
    for month in ["2025-01", "2025-02", "2025-03"] {
        let path = fixture.partition_path(month);
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| {
                let mut row: serde_json::Value = serde_json::from_str(line).unwrap();
                row["source"] = json!(month);
                format!("{row}\n")
            })
            .collect::<String>();
        std::fs::write(path, text).unwrap();
    }
    let mut config = fixture.config();
    let DatabaseSourceConfig::Partitioned(source) = &mut config.sources[0] else {
        panic!("partitioned fixture");
    };
    source.partition_by = PartitionKey::Field {
        field: "source".into(),
    };
    let runtime = NativeRuntime::open_sources_with_options(
        config.clone(),
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    let input = QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2024-05-01T00:00:00.000Z","$lt":"2024-05-01T01:00:00.000Z"}}),
        ),
        ..Default::default()
    };
    let (first, first_stats) = runtime
        .query_bounded_with_stats(COLLECTION, input.clone())
        .unwrap();
    assert!(first.is_empty());
    assert_eq!(first_stats.partitions_read, 3);
    assert!(first_stats.candidate_rows > 0);
    let (later, stats) = runtime
        .query_bounded_with_stats(COLLECTION, input.clone())
        .unwrap();
    assert_eq!(first, later);
    assert_eq!(stats.partitions_read, 0);
    assert_eq!(stats.candidate_rows, 0);
    let january = fixture.partition_path("2025-01");
    let text = std::fs::read_to_string(&january).unwrap();
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut moved: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    moved["atUtc"] = json!("2024-05-01T00:00:00.000Z");
    lines[0] = moved.to_string();
    std::fs::write(january, format!("{}\n", lines.join("\n"))).unwrap();
    let (actual, stats) = runtime
        .query_bounded_with_stats(COLLECTION, input.clone())
        .unwrap();
    assert_eq!(actual, vec![moved]);
    assert_eq!(stats.partitions_read, 1);
    let february = fixture.partition_path("2025-02");
    let text = std::fs::read_to_string(&february).unwrap();
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut invalid: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    invalid["value"] = json!("invalid");
    lines[0] = invalid.to_string();
    std::fs::write(february, format!("{}\n", lines.join("\n"))).unwrap();
    // A rebuilt key-only index may skip invalid payloads outside its window.
    assert_eq!(
        runtime.query_bounded(COLLECTION, input.clone()).unwrap(),
        actual
    );
    // First use still reads and validates every row before it publishes bounds.
    let fresh =
        NativeRuntime::open_sources_with_options(config, fixture.options(RuntimeKind::Lazy))
            .unwrap();
    assert_eq!(
        fresh.query_bounded(COLLECTION, input).unwrap_err().tag(),
        "ValidationError"
    );
}
