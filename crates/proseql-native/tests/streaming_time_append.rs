mod support;

use proseql_engine::query::QueryInput;
use proseql_native::ExecutionModel;
use serde_json::json;
use support::parity::{sample, ParityFixture, COLLECTION};

fn range() -> QueryInput {
    QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-20T00:00:00.000Z","$lt":"2025-02-20T01:00:00.000Z"}}),
        ),
        ..Default::default()
    }
}
fn append(runtime: &proseql_native::NativeRuntime) {
    let mut row = sample("2025-02", 28, 1439, "steps");
    row["atUtc"] = json!("2025-02-28T23:59:59.000Z");
    row["id"] = json!("steps:2025-02-28T23:59:59.000Z");
    runtime
        .mutate(|tx| tx.create(COLLECTION, row).map(|_| ()))
        .unwrap();
}

#[test]
fn checked_own_append_preserves_time_seek_and_results() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let first = runtime.query_bounded(COLLECTION, range()).unwrap();
    append(&runtime);
    let (after, stats) = runtime
        .query_bounded_with_stats(COLLECTION, range())
        .unwrap();
    assert_eq!(after, first);
    assert!(stats.candidate_rows < 128);
}

#[test]
fn external_same_length_edit_then_own_append_rebuilds_stale_time_index() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let first = runtime.query_bounded(COLLECTION, range()).unwrap();
    assert_eq!(first.len(), 2);
    let path = fixture.partition_path("2025-02");
    let text = std::fs::read_to_string(&path).unwrap();
    let (line, rest) = text.split_once('\n').unwrap();
    let mut row: serde_json::Value = serde_json::from_str(line).unwrap();
    let moved_id = row["id"].clone();
    row["atUtc"] = json!("2025-02-20T00:00:00.000Z");
    let edited = format!("{row}\n{rest}");
    assert_eq!(edited.len(), text.len());
    std::fs::write(path, edited).unwrap();
    append(&runtime);
    let (after, stats) = runtime
        .query_bounded_with_stats(COLLECTION, range())
        .unwrap();
    assert_eq!(after.len(), 3);
    assert!(after.iter().any(|row| row["id"] == moved_id));
    assert_eq!(
        stats.candidate_rows,
        28 * 24 * 2 + 1,
        "unsorted edited text must rebuild and disable the seek"
    );
}
