//! WASM boundary: `ordered_indexes` in descriptor JSON, as the TypeScript
//! compiler emits it, and the `explainQuery` dispatch method.

use proseql_wasm::Runtime;
use serde_json::{json, Value};

fn response(raw: &str) -> Value {
    serde_json::from_str(raw).expect("valid bridge response")
}

fn ok(raw: &str) -> Value {
    let response = response(raw);
    assert_eq!(response["kind"], json!("ok"), "{response}");
    response["value"].clone()
}

/// The descriptor JSON shape `compileDatabaseDescriptor` produces.
fn descriptor(ordered_indexes: Option<Value>) -> Value {
    let mut collection = json!({
        "name": "samples",
        "schema": {"kind": "struct", "fields": [
            {"name": "id", "schema": {"kind": "str"}},
            {"name": "timestamp", "schema": {"kind": "str"}},
            {"name": "bpm", "schema": {"kind": "num"}}
        ]},
        "id_strategy": {"kind": "provided"},
        "relationships": [],
        "indexes": [],
        "unique_fields": [],
        "before_create_hooks": [],
        "after_create_hooks": [],
        "before_update_hooks": [],
        "after_update_hooks": [],
        "before_delete_hooks": [],
        "after_delete_hooks": [],
        "on_change_hooks": [],
        "computed_fields": [],
        "search_index": [],
        "migrations": [],
        "append_only": false,
        "validation_mode": "strict"
    });
    if let Some(ordered_indexes) = ordered_indexes {
        collection["ordered_indexes"] = ordered_indexes;
    }
    json!({ "descriptor": { "collections": [collection], "sources": [] } })
}

fn rows() -> Vec<Value> {
    [
        ("a", "2026-01-01T00:10:00.000Z", 70),
        ("b", "2026-01-01T01:10:00.000Z", 71),
        ("c", "2026-01-01T00:40:00.000Z", 72),
        ("d", "2026-01-01T00:10:00.000Z", 73),
    ]
    .into_iter()
    .map(|(id, timestamp, bpm)| json!({"id": id, "timestamp": timestamp, "bpm": bpm}))
    .collect()
}

fn open(runtime: &mut Runtime, ordered_indexes: Option<Value>) -> u32 {
    let handle = ok(&runtime.create_database_json(&descriptor(ordered_indexes).to_string()))
        .as_u64()
        .expect("handle") as u32;
    for row in rows() {
        ok(&runtime.dispatch_json(
            handle,
            "create",
            Some(&json!({"collection": "samples", "data": row}).to_string()),
        ));
    }
    handle
}

#[test]
fn ordered_indexes_from_descriptor_json_plan_range_queries_with_identical_results() {
    let mut runtime = Runtime::new();
    let indexed = open(&mut runtime, Some(json!(["timestamp", "bpm"])));
    let plain = open(&mut runtime, None);
    let queries = [
        json!({"where": {"timestamp": {"$gte": "2026-01-01T00:00:00.000Z", "$lt": "2026-01-01T01:00:00.000Z"}}}),
        json!({"where": {"bpm": {"$gt": 70, "$lte": 72}}, "sort": {"bpm": "desc"}}),
        json!({"sort": {"bpm": "asc"}, "offset": 1, "limit": 2}),
        json!({"sort": {"timestamp": "desc"}, "limit": 3}),
    ];
    for query in queries {
        let payload = json!({"collection": "samples", "query": query}).to_string();
        assert_eq!(
            ok(&runtime.dispatch_json(indexed, "query", Some(&payload))),
            ok(&runtime.dispatch_json(plain, "query", Some(&payload))),
            "{payload}"
        );
    }

    let range = json!({"collection": "samples", "query": {"where": {
        "timestamp": {"$gte": "2026-01-01T00:00:00.000Z", "$lt": "2026-01-01T01:00:00.000Z"}
    }}})
    .to_string();
    assert_eq!(
        ok(&runtime.dispatch_json(indexed, "explainQuery", Some(&range))),
        json!({"index_used": "ordered", "candidate_rows": 3, "index_sorted": false})
    );
    assert_eq!(
        ok(&runtime.dispatch_json(plain, "explainQuery", Some(&range)))["index_used"],
        json!("none")
    );
    let by_bpm = json!({"collection": "samples", "query": {"sort": {"bpm": "desc"}, "limit": 1}})
        .to_string();
    assert_eq!(
        ok(&runtime.dispatch_json(indexed, "explainQuery", Some(&by_bpm)))["index_sorted"],
        json!(true)
    );
}

#[test]
fn an_ordered_index_on_an_undeclared_field_is_rejected_at_create_database() {
    let mut runtime = Runtime::new();
    let response = response(
        &runtime.create_database_json(&descriptor(Some(json!(["recordedAt"]))).to_string()),
    );
    assert_eq!(response["kind"], json!("error"), "{response}");
    assert_eq!(response["error"]["_tag"], json!("ValidationError"));
    assert_eq!(
        response["error"]["issues"][0]["field"],
        json!("ordered_indexes")
    );
}

#[test]
fn shared_memory_fixture_keeps_float_order_groups_and_comparable_objects() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../proseql-engine/tests/fixtures/lazy-memory.json"
    ))
    .unwrap();
    let mut runtime = Runtime::new();
    let mut config = descriptor(None);
    config["descriptor"]["collections"][0]["schema"] = json!({"kind":"struct","fields":[
        {"name":"id","schema":{"kind":"str"}},
        {"name":"group","schema":{"kind":"optional","inner":{"kind":"unknown"}}},
        {"name":"value","schema":{"kind":"num"}},
        {"name":"comparable","schema":{"kind":"unknown"}},
        {"name":"object","schema":{"kind":"optional","inner":{"kind":"unknown"}}}
    ]});
    let handle = ok(&runtime.create_database_json(&config.to_string()))
        .as_u64()
        .unwrap() as u32;
    for row in fixture["rows"].as_array().unwrap() {
        ok(&runtime.dispatch_json(
            handle,
            "create",
            Some(&json!({"collection":"samples","data":row}).to_string()),
        ));
    }
    let config = json!({"count":true,"sum":["value"],"avg":["value"],"min":["comparable","object"],"max":["comparable","object"]});
    let result = ok(&runtime.dispatch_json(
        handle,
        "aggregate",
        Some(&json!({"collection":"samples","config":config}).to_string()),
    ));
    assert_eq!(result, fixture["expected"]);
}
