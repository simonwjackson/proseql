mod support;

use proseql_engine::{descriptor::SchemaNode, query::QueryInput};
use proseql_native::{ExecutionModel, NativeRuntime};
use serde_json::{json, Value};
use support::parity::{ParityFixture, COLLECTION};

#[test]
fn canonical_transform_fallback_still_builds_time_checkpoints() {
    let fixture = ParityFixture::new(60);
    let path = fixture.partition_path("2025-02");
    let text = std::fs::read_to_string(&path).unwrap();
    let mut transformed = String::new();
    for line in text.lines() {
        let mut row: Value = serde_json::from_str(line).unwrap();
        row["value"] = json!(row["value"].to_string());
        transformed.push_str(&format!("{row}\n"));
    }
    std::fs::write(path, transformed).unwrap();
    let mut config = fixture.config();
    let SchemaNode::Struct { fields } = &mut config.collections[0].descriptor.schema else {
        panic!("fixture struct")
    };
    fields
        .iter_mut()
        .find(|field| field.name == "value")
        .unwrap()
        .schema = SchemaNode::NumFromStr;
    let runtime = NativeRuntime::open_sources_with_options(
        config,
        fixture.options(ExecutionModel::Streaming),
    )
    .unwrap();
    let input = QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-20T00:00:00.000Z","$lt":"2025-02-20T01:00:00.000Z"}}),
        ),
        ..Default::default()
    };
    let first = runtime.query_bounded(COLLECTION, input.clone()).unwrap();
    let (second, stats) = runtime.query_bounded_with_stats(COLLECTION, input).unwrap();
    assert_eq!(first, second);
    assert!(second.iter().all(|row| row["value"].is_number()));
    assert!(
        stats.candidate_rows < 128,
        "canonical schema fallback must not disable an otherwise eligible time index"
    );
}
