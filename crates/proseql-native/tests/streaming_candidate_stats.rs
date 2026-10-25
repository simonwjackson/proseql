mod support;

use proseql_engine::query::QueryInput;
use serde_json::json;
use support::parity::RuntimeKind;
use support::parity::{ParityFixture, COLLECTION};

fn check(model: RuntimeKind) {
    let fixture = ParityFixture::new(720);
    let runtime = fixture.open(model);
    let input = QueryInput {
        r#where: Some(json!({"atUtc":{"$gte":"2025-02-01", "$lt":"2025-03-01"},"metric":"steps"})),
        limit: Some(1),
        ..Default::default()
    };
    for _ in 0..2 {
        let (rows, stats) = runtime
            .query_bounded_with_stats(COLLECTION, input.clone())
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            stats.partitions_visited,
            if model == RuntimeKind::Lazy { 1 } else { 3 }
        );
        assert_eq!(
            stats.candidate_rows,
            if model == RuntimeKind::Lazy {
                28 * 2 * 2
            } else {
                90 * 2 * 2
            }
        );
    }
}

#[test]
fn eager_reports_collection_rows_before_filter_and_limit() {
    check(RuntimeKind::Eager);
}

#[test]
fn streaming_reports_validated_rows_before_filter_and_limit() {
    check(RuntimeKind::Lazy);
}
