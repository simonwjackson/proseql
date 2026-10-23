use proseql_engine::{
    callbacks::CallbackRegistry,
    query::{
        aggregate::{
            compute_grouped_aggregates, AggregateAccumulator, GroupedAggregateAccumulator,
        },
        pipeline::QueryMatches,
        AggregateConfig, CursorConfig, QueryInput, SortOrder,
    },
};
use serde_json::{json, Value};
use std::sync::Arc;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/lazy-memory.json")).unwrap()
}

#[test]
fn row_accumulators_preserve_float_order_first_seen_groups_and_js_comparables() {
    let fixture = fixture();
    let rows = fixture["rows"].as_array().unwrap();
    let config = AggregateConfig {
        count: true,
        sum: vec!["value".into()],
        avg: vec!["value".into()],
        min: vec!["comparable".into(), "object".into()],
        max: vec!["comparable".into(), "object".into()],
    };
    // Every possible chunk boundary must make no difference to f64 evaluation.
    for width in 1..=rows.len() {
        let mut scalar = AggregateAccumulator::new(&config);
        let group_by = ["group".into()];
        let mut groups = GroupedAggregateAccumulator::new(&group_by, &config);
        for chunk in rows.chunks(width) {
            for row in chunk {
                scalar.push(row);
                groups.push(row);
            }
        }
        let result = scalar.finish();
        let expected = &fixture["expected"];
        assert_eq!(result.count, Some(5));
        assert_eq!(result.sum.as_ref().unwrap()["value"], 1.0);
        assert_eq!(result.avg.as_ref().unwrap()["value"], Some(0.2));
        assert_eq!(serde_json::to_value(result.min).unwrap(), expected["min"]);
        assert_eq!(serde_json::to_value(result.max).unwrap(), expected["max"]);
        let result = groups.finish();
        assert_eq!(result, compute_grouped_aggregates(rows, &group_by, &config));
        assert_eq!(
            result
                .iter()
                .map(|group| group.group.clone())
                .collect::<Vec<_>>(),
            vec![
                json!({"group":"z"}).as_object().unwrap().clone(),
                json!({"group":"a"}).as_object().unwrap().clone(),
                Default::default(),
                json!({"group":null}).as_object().unwrap().clone()
            ]
        );
    }
}

#[test]
fn matches_are_finished_once_with_global_stable_order_selection_and_cursors() {
    let fixture = fixture();
    let rows = fixture["rows"].as_array().unwrap();
    let input = QueryInput {
        sort: vec![("value".into(), SortOrder::Asc)],
        offset: Some(1),
        limit: Some(2),
        select: Some(json!(["id"])),
        ..Default::default()
    };
    let mut query = QueryMatches::new(input, Arc::new(CallbackRegistry::new()));
    for chunk in rows.chunks(2) {
        for row in chunk {
            query.push(row);
        }
    }
    assert_eq!(
        query.finish().unwrap(),
        vec![json!({"id":"d"}), json!({"id":"e"})]
    );
    let mut query = QueryMatches::new(
        QueryInput {
            select: Some(json!(["id"])),
            ..Default::default()
        },
        Arc::new(CallbackRegistry::new()),
    );
    for row in rows {
        query.push(row);
    }
    let page = query
        .finish_cursor(&CursorConfig {
            key: "id".into(),
            after: Some("b".into()),
            before: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(page.items, vec![json!({"id":"c"}), json!({"id":"d"})]);
}
