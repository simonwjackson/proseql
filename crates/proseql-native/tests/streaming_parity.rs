//! Smoke test for the differential harness. Builders add seam-specific
//! differential tests in their own `tests/streaming_<seam>.rs` files.

mod support;

use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::{AggregateConfig, SortOrder};
use proseql_native::ExecutionModel;
use serde_json::json;
use support::parity::{ParityFixture, COLLECTION};

#[test]
fn execution_model_defaults_to_streaming() {
    assert_eq!(ExecutionModel::default(), ExecutionModel::Streaming);
}

#[test]
fn harness_compares_reads_under_both_models() {
    let fixture = ParityFixture::new(60);
    let range = json!({
        "atUtc": { "$gte": "2025-02-03T00:00:00.000Z", "$lt": "2025-02-04T00:00:00.000Z" },
        "metric": "steps",
    });

    let rows = fixture
        .assert_same(|runtime| {
            runtime.query_bounded(
                COLLECTION,
                QueryInput {
                    r#where: Some(range.clone()),
                    sort: vec![("atUtc".into(), SortOrder::Desc)],
                    limit: Some(5),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(rows.len(), 5);

    fixture
        .assert_same(|runtime| runtime.find_by_id(COLLECTION, "steps:2025-03-10T05:00:00.000Z"))
        .unwrap()
        .expect("sample exists");

    fixture
        .assert_same(|runtime| {
            runtime.aggregate_grouped_bounded(
                COLLECTION,
                Some(json!({ "atUtc": { "$gte": "2025-01-01T00:00:00.000Z" } })),
                &["dateUtc".to_owned(), "metric".to_owned()],
                &AggregateConfig {
                    count: true,
                    sum: vec!["value".into()],
                    ..Default::default()
                },
            )
        })
        .unwrap();
}
