//! Conformance: ordered (range) indexes, `CollectionDescriptor.ordered_indexes`.
//!
//! Every check runs the same operations on two databases: one declares
//! ordered indexes, the other does not. Query results, their order, cursor
//! pages and aggregates must be identical. `explain_query` proves that the
//! indexed database really took the index path, so a silent fallback to the
//! scan cannot make a test pass.

use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode},
    errors::EngineError,
    id_gen::SequentialGenerator,
    query::{
        execute_aggregate, AggregateConfig, CursorConfig, IndexUsed, QueryInput, QueryStats,
        SortOrder,
    },
    relationships::Database,
};
use serde_json::{json, Value};

const ORDERED: [&str; 4] = ["at", "ts", "n", "meta.at"];

// ── Fixtures ──────────────────────────────────────────────────────────────────

fn optional(schema: SchemaNode) -> SchemaNode {
    SchemaNode::Optional(Box::new(schema))
}

fn field(name: &str, schema: SchemaNode) -> StructField {
    StructField {
        name: name.into(),
        schema,
    }
}

/// `at` takes any JSON value (mixed types), `ts` ISO strings or null, `n`
/// numbers, `meta.at` any value behind a dot path.
fn schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            field("id", SchemaNode::Str),
            field("tag", SchemaNode::Str),
            field("at", optional(SchemaNode::Unknown)),
            field(
                "ts",
                optional(SchemaNode::NullOr(Box::new(SchemaNode::Str))),
            ),
            field("n", optional(SchemaNode::Num)),
            field(
                "meta",
                optional(SchemaNode::Struct {
                    fields: vec![field("at", optional(SchemaNode::Unknown))],
                }),
            ),
        ],
    }
}

fn descriptor(ordered: bool) -> CollectionDescriptor {
    CollectionDescriptor {
        name: "samples".into(),
        schema: schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: if ordered {
            ORDERED.iter().map(|field| (*field).to_owned()).collect()
        } else {
            vec![]
        },
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec![],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: false,
        validation_mode: ValidationMode::Strict,
    }
}

fn database(ordered: bool, registry: Arc<CallbackRegistry>) -> Database {
    let collection = Collection::new_with_clock(
        "samples",
        descriptor(ordered),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("s")),
        Box::new(FixedClock::new("2026-01-01T00:00:00.000Z")),
    );
    Database::new(IndexMap::from([("samples".into(), collection)]), registry)
}

/// An indexed database and an unindexed oracle that receive the same writes.
struct Pair {
    indexed: Database,
    plain: Database,
}

impl Pair {
    fn new() -> Self {
        Self::with_registry(Arc::new(CallbackRegistry::new()))
    }

    fn with_registry(registry: Arc<CallbackRegistry>) -> Self {
        Self {
            indexed: database(true, Arc::clone(&registry)),
            plain: database(false, registry),
        }
    }

    /// Apply one write to both; both must succeed or fail with the same tag.
    fn apply<R: std::fmt::Debug + PartialEq>(
        &mut self,
        write: impl Fn(&mut Database) -> Result<R, EngineError>,
    ) {
        let left = write(&mut self.indexed);
        let right = write(&mut self.plain);
        match (&left, &right) {
            (Ok(left), Ok(right)) => assert_eq!(left, right),
            (Err(left), Err(right)) => assert_eq!(left.tag(), right.tag()),
            _ => panic!("indexed {left:?} vs plain {right:?}"),
        }
    }

    fn create_all(&mut self, rows: &[Value]) {
        for row in rows {
            for db in [&mut self.indexed, &mut self.plain] {
                db.create("samples", row.clone())
                    .expect("fixture row is valid");
            }
        }
    }

    fn query(&self, input: &QueryInput) -> Vec<Value> {
        let indexed = self
            .indexed
            .query("samples", input.clone(), None)
            .expect("indexed query");
        let plain = self
            .plain
            .query("samples", input.clone(), None)
            .expect("plain query");
        assert_eq!(
            ids(&indexed),
            ids(&plain),
            "query {:?} sort {:?} offset {:?} limit {:?}",
            input.r#where,
            input.sort,
            input.offset,
            input.limit
        );
        assert_eq!(indexed, plain);
        let canonical = |db: &Database| {
            db.canonical_query_positions("samples", input, None, false)
                .expect("canonical positions")
        };
        assert_eq!(canonical(&self.indexed), canonical(&self.plain));
        indexed
    }

    /// Walk forward cursor pages (bounded, so a page cycle cannot hang).
    fn cursor_pages(&self, input: &QueryInput, key: &str, limit: usize) {
        let mut after: Option<String> = None;
        for _ in 0..50 {
            let config = CursorConfig {
                key: key.into(),
                after: after.clone(),
                before: None,
                limit,
            };
            let indexed = self
                .indexed
                .query_cursor("samples", input, &config, None)
                .expect("indexed cursor");
            let plain = self
                .plain
                .query_cursor("samples", input, &config, None)
                .expect("plain cursor");
            assert_eq!(indexed, plain, "cursor page after {after:?}");
            if !indexed.page_info.has_next_page {
                return;
            }
            after = indexed.page_info.end_cursor.clone();
        }
    }

    fn count(&self, where_clause: &Value) -> Option<u64> {
        let run = |db: &Database| {
            let registry = Arc::new(CallbackRegistry::new());
            execute_aggregate(
                db.collection("samples").expect("collection"),
                Some(where_clause),
                &AggregateConfig::count(),
                &registry,
            )
            .expect("aggregate")
        };
        let indexed = run(&self.indexed);
        assert_eq!(indexed, run(&self.plain), "count {where_clause}");
        indexed.count
    }

    fn explain(&self, input: &QueryInput) -> QueryStats {
        self.indexed
            .explain_query("samples", input)
            .expect("explain")
    }
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn filter(where_clause: Value) -> QueryInput {
    QueryInput {
        r#where: Some(where_clause),
        ..QueryInput::default()
    }
}

fn sorted(where_clause: Option<Value>, field: &str, order: SortOrder) -> QueryInput {
    QueryInput {
        r#where: where_clause,
        sort: vec![(field.into(), order)],
        ..QueryInput::default()
    }
}

/// Rows with every value class: ISO strings with ties, numbers with ties and
/// `-0`, null, missing, booleans, arrays and objects.
fn mixed_rows() -> Vec<Value> {
    vec![
        json!({"id":"r01","tag":"a","at":"2026-01-01T00:00:00.000Z","ts":"2026-01-01T00:00:00.000Z","n":5,"meta":{"at":3}}),
        json!({"id":"r02","tag":"b","at":7,"ts":"2026-01-01T00:30:00.000Z","n":-0.0}),
        json!({"id":"r03","tag":"a","at":null,"ts":null,"meta":{"at":"x"}}),
        json!({"id":"r04","tag":"b","ts":"2026-01-01T01:00:00.000Z","n":5,"meta":{}}),
        json!({"id":"r05","tag":"a","at":"2026-01-01T00:00:00.000Z","ts":"2026-01-01T00:00:00.000Z","n":0,"meta":{"at":null}}),
        json!({"id":"r06","tag":"c","at":true,"ts":"2025-12-31T23:59:59.999Z","n":2.5}),
        json!({"id":"r07","tag":"a","at":[1,2],"ts":"2026-01-02T00:00:00.000Z","n":-3}),
        json!({"id":"r08","tag":"b","at":{"x":1},"n":5,"meta":{"at":-1}}),
        json!({"id":"r09","tag":"c","at":-2.5,"ts":"2026-01-01T00:59:59.999Z","n":10,"meta":{"at":"a"}}),
        json!({"id":"r10","tag":"a","at":"","ts":"2026-01-01T00:00:00.000Z"}),
        json!({"id":"r11","tag":"b","at":"B","ts":"2026-01-01T00:15:00.000Z","n":1e300}),
        json!({"id":"r12","tag":"c","at":7,"ts":"2026-01-01T00:45:00.000Z","n":-1e300,"meta":{"at":true}}),
        json!({"id":"r13","tag":"a","at":"b","ts":"2026-01-01T00:00:00.000Z","n":5}),
        json!({"id":"r14","tag":"b","at":"10","ts":"2026-01-01T02:00:00.000Z","n":7.25,"meta":{"at":2}}),
    ]
}

/// Range shapes the planner must handle, plus shapes it must leave alone.
fn range_filters(field: &str) -> Vec<Value> {
    let mut filters = Vec::new();
    let bounds = [
        json!("2026-01-01T00:00:00.000Z"),
        json!("2026-01-01T01:00:00.000Z"),
        json!(""),
        json!("B"),
        json!("a"),
        json!(0),
        json!(-0.0),
        json!(5),
        json!(7),
        json!(-2.5),
        json!(1e300),
        json!(null),
        json!(true),
        json!([1]),
    ];
    for operator in ["$gt", "$gte", "$lt", "$lte"] {
        for bound in &bounds {
            filters.push(json!({ field: { operator: bound } }));
        }
    }
    for (low, high) in [
        (
            json!("2026-01-01T00:00:00.000Z"),
            json!("2026-01-01T01:00:00.000Z"),
        ),
        (
            json!("2026-01-01T00:30:00.000Z"),
            json!("2026-01-01T00:30:00.000Z"),
        ),
        (json!(0), json!(5)),
        (json!(5), json!(5)),
        (json!(7), json!(-1)),
        (json!("a"), json!(5)),
        (json!("2026"), json!(null)),
    ] {
        filters.push(json!({ field: { "$gte": low, "$lt": high } }));
        filters.push(json!({ field: { "$gt": low, "$lte": high } }));
        filters.push(json!({ field: { "$gte": low, "$lte": high } }));
        filters.push(json!({ "$and": [{ field: { "$gte": low } }, { field: { "$lt": high } }] }));
    }
    filters.extend([
        json!({ field: { "$gte": "2026-01-01T00:00:00.000Z" }, "tag": "a" }),
        json!({ field: { "$gt": 0, "$ne": 5 } }),
        json!({ field: { "$gte": "2026", "$in": ["2026-01-01T00:00:00.000Z", 7] } }),
        json!({ field: { "$gte": "2026" }, "$or": [{"tag": "b"}, {"tag": "c"}] }),
        json!({ field: { "$gte": "2026" }, "$not": {"tag": "a"} }),
        json!({ "$and": [{ field: { "$gte": 0 } }, { "$and": [{ field: { "$lt": 6 } }, {"tag": "b"}] }] }),
        json!({ "$or": [{ field: { "$gt": 5 } }, { field: { "$lt": "a" } }] }),
        json!({ field: { "$gt": 1, "$eq": {"__proseqlUndefined__": 1} } }),
        json!({ field: { "$gt": "z" }, "$and": [{ field: { "$lt": "a" } }] }),
        json!({ field: "2026-01-01T00:00:00.000Z" }),
        json!({ field: { "$startsWith": "2026" } }),
    ]);
    filters
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn range_filters_match_unindexed_results_across_mixed_types() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    for field in ORDERED {
        for where_clause in range_filters(field) {
            pair.query(&filter(where_clause.clone()));
            pair.count(&where_clause);
            for (offset, limit) in [(Some(1), Some(2)), (None, Some(1)), (Some(20), None)] {
                pair.query(&QueryInput {
                    offset,
                    limit,
                    ..filter(where_clause.clone())
                });
            }
        }
    }
}

#[test]
fn range_filter_on_an_ordered_field_reports_the_ordered_index() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    let one_hour = filter(json!({
        "ts": {"$gte": "2026-01-01T00:00:00.000Z", "$lt": "2026-01-01T01:00:00.000Z"}
    }));
    let rows = pair.query(&one_hour);
    assert_eq!(
        ids(&rows),
        ["r01", "r02", "r05", "r09", "r10", "r11", "r12", "r13"]
    );
    // Only rows inside the range are visited (`ts` holds no numbers).
    assert_eq!(
        pair.explain(&one_hour),
        QueryStats {
            index_used: IndexUsed::Ordered,
            candidate_rows: rows.len(),
            index_sorted: false,
        }
    );
    let between = filter(json!({"$and": [{"n": {"$gt": 0}}, {"n": {"$lte": 5}}]}));
    pair.query(&between);
    assert_eq!(pair.explain(&between).index_used, IndexUsed::Ordered);

    // Shapes the planner does not cover fall back to the scan.
    for uncovered in [
        json!({"$or": [{"ts": {"$gt": "2026"}}, {"tag": "a"}]}),
        json!({"ts": "2026-01-01T00:00:00.000Z"}),
        json!({"tag": {"$gt": "a"}}),
        json!({"ts": {"$gt": "2026", "$eq": {"__proseqlUndefined__": 1}}}),
    ] {
        let input = filter(uncovered);
        pair.query(&input);
        assert_eq!(pair.explain(&input).index_used, IndexUsed::None);
    }
    // Without the declaration the same query scans.
    assert_eq!(
        pair.plain
            .explain_query("samples", &one_hour)
            .expect("explain")
            .index_used,
        IndexUsed::None
    );
}

#[test]
fn sorts_on_single_type_fields_come_from_the_index_with_stable_ties() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    // `ts` holds strings and null/missing; `n` holds numbers and missing.
    for field in ["ts", "n"] {
        for order in [SortOrder::Asc, SortOrder::Desc] {
            for where_clause in [
                None,
                Some(json!({"tag": {"$ne": "c"}})),
                Some(json!({field: {"$gte": "2026-01-01T00:00:00.000Z"}})),
                Some(json!({field: {"$gt": 0, "$lt": 8}})),
            ] {
                for (offset, limit) in [(None, None), (Some(2), Some(3)), (None, Some(1))] {
                    let input = QueryInput {
                        offset,
                        limit,
                        ..sorted(where_clause.clone(), field, order.clone())
                    };
                    pair.query(&input);
                    let stats = pair.explain(&input);
                    assert!(stats.index_sorted, "{field} {order:?} {where_clause:?}");
                    assert_eq!(stats.index_used, IndexUsed::Ordered);
                }
            }
        }
        pair.cursor_pages(&sorted(None, field, SortOrder::Asc), field, 2);
    }
    let rows = pair.query(&sorted(None, "ts", SortOrder::Desc));
    assert_eq!(
        ids(&rows),
        [
            "r07", "r14", "r04", "r09", "r12", "r02", "r11", "r01", "r05", "r10", "r13", "r06",
            "r03", "r08"
        ],
        "descending keys, ties in insertion order, null and missing last"
    );
    pair.cursor_pages(
        &QueryInput {
            r#where: Some(json!({"ts": {"$gte": "2026-01-01T00:00:00.000Z"}})),
            ..QueryInput::default()
        },
        "ts",
        3,
    );
}

#[test]
fn sorts_that_the_index_cannot_reproduce_fall_back_with_identical_results() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    // `at` and `meta.at` mix strings, numbers, booleans, arrays and objects.
    for field in ["at", "meta.at"] {
        for order in [SortOrder::Asc, SortOrder::Desc] {
            let input = sorted(None, field, order);
            pair.query(&input);
            assert!(!pair.explain(&input).index_sorted);
        }
    }
    // Two sort keys are not served by the index.
    let input = QueryInput {
        sort: vec![("ts".into(), SortOrder::Asc), ("n".into(), SortOrder::Desc)],
        ..QueryInput::default()
    };
    pair.query(&input);
    assert!(!pair.explain(&input).index_sorted);
    // A top-level $search keeps relevance scoring on the ordinary path.
    let search = sorted(
        Some(json!({"$search": {"query": "b", "fields": ["tag"]}})),
        "ts",
        SortOrder::Asc,
    );
    pair.query(&search);
    assert!(!pair.explain(&search).index_sorted);
}

#[test]
fn a_registered_collator_keeps_string_sorts_off_the_index() {
    let mut registry = CallbackRegistry::new();
    registry.register_collator(Box::new(|left: &str, right: &str| right.cmp(left)));
    let mut pair = Pair::with_registry(Arc::new(registry));
    pair.create_all(&mixed_rows());
    let strings = sorted(None, "ts", SortOrder::Asc);
    pair.query(&strings);
    assert!(!pair.explain(&strings).index_sorted);
    // Numbers never use the collator, so their sort still uses the index.
    let numbers = sorted(None, "n", SortOrder::Asc);
    pair.query(&numbers);
    assert!(pair.explain(&numbers).index_sorted);
}

#[test]
fn updates_deletes_and_bulk_writes_keep_the_index_in_step() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    let checks = |pair: &Pair| {
        for field in ORDERED {
            for where_clause in range_filters(field).into_iter().take(40) {
                pair.query(&filter(where_clause));
            }
            pair.query(&sorted(None, field, SortOrder::Asc));
            pair.query(&sorted(None, field, SortOrder::Desc));
        }
    };
    // Move keys across types, into and out of the indexed classes.
    pair.apply(|db| db.update("samples", "r01", json!({"ts": "2026-01-03T00:00:00.000Z"})));
    pair.apply(|db| db.update("samples", "r02", json!({"at": "2026-01-01T00:10:00.000Z"})));
    pair.apply(|db| db.update("samples", "r06", json!({"at": 1, "n": 5})));
    pair.apply(|db| db.update("samples", "r09", json!({"meta": {"at": 4}})));
    pair.apply(|db| db.update("samples", "r10", json!({"ts": null, "at": null})));
    checks(&pair);
    pair.apply(|db| db.delete("samples", "r05"));
    pair.apply(|db| db.delete("samples", "r13"));
    pair.apply(|db| {
        db.update_many(
            "samples",
            json!({"tag": "b"}),
            json!({"ts": "2026-01-01T00:20:00.000Z"}),
        )
        .map(|result| format!("{result:?}"))
    });
    pair.apply(|db| {
        db.delete_many("samples", json!({"n": {"$lt": 0}}), false, None)
            .map(|result| format!("{result:?}"))
    });
    checks(&pair);
    // The WASM bulk fast paths patch and remove rows in place.
    let ids_of = |db: &Database, tag: &str| {
        db.query("samples", filter(json!({"tag": tag})), None)
            .expect("ids")
            .iter()
            .map(|row| row["id"].as_str().expect("id").to_owned())
            .collect::<Vec<_>>()
    };
    let tag_a = ids_of(&pair.plain, "a");
    pair.apply(|db| {
        db.authorized_update_many_ids_compact(
            "samples",
            &tag_a,
            json!({"ts": "2026-01-01T00:05:00.000Z"}),
        )
    });
    let tag_c = ids_of(&pair.plain, "c");
    pair.apply(|db| db.authorized_delete_many_ids_compact("samples", &tag_c, None));
    checks(&pair);
    pair.apply(|db| {
        db.create(
            "samples",
            json!({"id":"r15","tag":"z","ts":"2026-01-01T00:20:00.000Z"}),
        )
    });
    checks(&pair);
}

#[test]
fn rollback_reload_and_snapshot_restore_rebuild_the_index() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    let one_hour = filter(json!({
        "ts": {"$gte": "2026-01-01T00:00:00.000Z", "$lt": "2026-01-01T01:00:00.000Z"}
    }));
    let before = pair.query(&one_hour);

    // A failed transaction rolls back creates, updates and deletes.
    pair.apply(|db| {
        db.transaction(None, |tx| {
            tx.create(
                "samples",
                json!({"id":"t1","tag":"t","ts":"2026-01-01T00:01:00.000Z"}),
            )?;
            tx.update("samples", "r01", json!({"ts": "2027-01-01T00:00:00.000Z"}))?;
            tx.delete("samples", "r09")?;
            Err::<(), _>(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "test".into(),
                    reason: "abort".into(),
                    message: "abort".into(),
                },
            ))
        })
    });
    assert_eq!(pair.query(&one_hour), before);
    pair.query(&sorted(None, "ts", SortOrder::Desc));

    // An explicit rollback.
    for db in [&mut pair.indexed, &mut pair.plain] {
        let mut tx = db.begin_transaction(None).expect("begin");
        tx.update("samples", "r02", json!({"ts": "2020-01-01T00:00:00.000Z"}))
            .expect("update");
        // `rollback` reports the rollback as a TransactionError by design.
        let rolled_back = tx.rollback();
        assert!(matches!(
            rolled_back,
            Ok(()) | Err(EngineError::Transaction(_))
        ));
    }
    assert_eq!(pair.query(&one_hour), before);

    // A committed transaction keeps its writes.
    pair.apply(|db| {
        db.transaction(None, |tx| {
            tx.create(
                "samples",
                json!({"id":"t2","tag":"t","ts":"2026-01-01T00:02:00.000Z"}),
            )?;
            tx.delete("samples", "r10")
        })
    });
    let after_commit = pair.query(&one_hour);
    assert!(ids(&after_commit).contains(&"t2".to_owned()));
    assert!(!ids(&after_commit).contains(&"r10".to_owned()));

    // A reload replaces the whole state.
    let reloaded = vec![
        json!({"id":"z2","tag":"z","ts":"2026-01-01T00:40:00.000Z","n":1}),
        json!({"id":"z1","tag":"z","ts":"2026-01-01T00:40:00.000Z","n":1}),
        json!({"id":"z3","tag":"z","ts":"2026-01-01T03:00:00.000Z"}),
    ];
    pair.apply(|db| db.reload_collection("samples", reloaded.clone()));
    assert_eq!(ids(&pair.query(&one_hour)), ["z2", "z1"]);
    assert_eq!(
        ids(&pair.query(&sorted(None, "n", SortOrder::Desc))),
        ["z2", "z1", "z3"]
    );

    // A host snapshot commit replaces it again.
    pair.apply(|db| {
        db.commit_snapshot_transaction(IndexMap::from([("samples".to_owned(), mixed_rows())]))
            .map(|_| ())
    });
    assert_eq!(pair.query(&one_hour), before);
}

#[test]
fn synchronized_materialized_rows_are_re_keyed() {
    let mut pair = Pair::new();
    pair.create_all(&mixed_rows());
    for db in [&mut pair.indexed, &mut pair.plain] {
        let mut row = db
            .collection("samples")
            .expect("collection")
            .get("r06")
            .expect("row")
            .clone();
        row["ts"] = json!("2026-01-01T00:33:00.000Z");
        assert!(db
            .synchronize_materialized_value("samples", "r06", row)
            .expect("synchronize"));
    }
    let rows = pair.query(&filter(
        json!({"ts": {"$gte": "2026-01-01T00:33:00.000Z", "$lt": "2026-01-01T00:34:00.000Z"}}),
    ));
    assert_eq!(ids(&rows), ["r06"]);
    pair.query(&sorted(None, "ts", SortOrder::Asc));
}

// ── Property-style check ──────────────────────────────────────────────────────

/// SplitMix64: small, deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

fn random_timestamp(rng: &mut Rng) -> String {
    // A narrow range of minutes so ties and boundary hits are common.
    format!(
        "2026-01-01T0{}:{:02}:00.000Z",
        rng.below(3),
        rng.below(4) * 15
    )
}

fn random_value(rng: &mut Rng) -> Option<Value> {
    Some(match rng.below(10) {
        0 => return None,
        1 => Value::Null,
        2 => json!(rng.below(2) == 0),
        3 => json!([rng.below(3)]),
        4 | 5 => json!(random_timestamp(rng)),
        6 => json!(*rng.pick(&["", "a", "B", "10"])),
        7 => json!(rng.below(5) as i64 - 2),
        8 => json!(*rng.pick(&[-0.0, 0.5, 2.5, 1e300])),
        _ => json!({"k": rng.below(2)}),
    })
}

fn random_row(rng: &mut Rng, id: &str) -> Value {
    let mut row = json!({"id": id, "tag": *rng.pick(&["a", "b", "c"])});
    if let Some(value) = random_value(rng) {
        row["at"] = value;
    }
    match rng.below(4) {
        0 => {}
        1 => row["ts"] = Value::Null,
        _ => row["ts"] = json!(random_timestamp(rng)),
    }
    if rng.below(4) != 0 {
        row["n"] = json!(rng.below(7) as f64 / 2.0 - 1.0);
    }
    if let Some(value) = random_value(rng) {
        row["meta"] = json!({ "at": value });
    }
    row
}

fn random_bound(rng: &mut Rng) -> Value {
    match rng.below(4) {
        0 | 1 => json!(random_timestamp(rng)),
        2 => json!(rng.below(5) as f64 / 2.0 - 1.0),
        _ => random_value(rng).unwrap_or(Value::Null),
    }
}

fn random_query(rng: &mut Rng) -> QueryInput {
    let field = *rng.pick(&ORDERED);
    let mut conditions = serde_json::Map::new();
    for _ in 0..=rng.below(2) {
        let operator = *rng.pick(&["$gt", "$gte", "$lt", "$lte"]);
        conditions.insert(operator.to_owned(), random_bound(rng));
    }
    let mut where_clause = match rng.below(4) {
        0 => json!({ field: Value::Object(conditions) }),
        1 => {
            json!({ "$and": [{ field: Value::Object(conditions) }, { field: { "$lt": random_bound(rng) } }] })
        }
        2 => json!({ field: Value::Object(conditions), "tag": *rng.pick(&["a", "b"]) }),
        _ => json!({}),
    };
    if where_clause
        .as_object()
        .is_some_and(serde_json::Map::is_empty)
    {
        where_clause = json!({"tag": {"$ne": "z"}});
    }
    // Sorts use the single-type fields only: the unindexed comparator is not
    // a total order over mixed types, and Rust's sort may panic on it.
    let sort = match rng.below(3) {
        0 => vec![],
        _ => vec![(
            (*rng.pick(&["ts", "n"])).to_owned(),
            if rng.below(2) == 0 {
                SortOrder::Asc
            } else {
                SortOrder::Desc
            },
        )],
    };
    QueryInput {
        r#where: (rng.below(5) != 0).then_some(where_clause),
        sort,
        offset: (rng.below(3) == 0).then(|| rng.below(4) as usize),
        limit: (rng.below(2) == 0).then(|| 1 + rng.below(5) as usize),
        ..QueryInput::default()
    }
}

#[test]
fn random_writes_and_queries_match_the_unindexed_path() {
    let mut index_plans = 0;
    let mut index_sorts = 0;
    for seed in 0..8u64 {
        let mut rng = Rng(0x0dd5_eed0 ^ seed);
        let mut pair = Pair::new();
        let mut next_id = 0u64;
        let mut live: Vec<String> = Vec::new();
        for step in 0..160 {
            match rng.below(10) {
                0..=3 => {
                    next_id += 1;
                    let id = format!("p{next_id:03}");
                    let row = random_row(&mut rng, &id);
                    pair.apply(|db| db.create("samples", row.clone()));
                    live.push(id);
                }
                4 | 5 if !live.is_empty() => {
                    let id = rng.pick(&live).clone();
                    let mut patch = random_row(&mut rng, &id);
                    patch.as_object_mut().expect("object").remove("id");
                    pair.apply(|db| db.update("samples", &id, patch.clone()));
                }
                6 if !live.is_empty() => {
                    let index = rng.below(live.len() as u64) as usize;
                    let id = live.remove(index);
                    pair.apply(|db| db.delete("samples", &id));
                }
                7 => {
                    let tag = *rng.pick(&["a", "b", "c"]);
                    let ts = random_timestamp(&mut rng);
                    pair.apply(|db| {
                        db.update_many("samples", json!({"tag": tag}), json!({"ts": ts}))
                            .map(|result| format!("{result:?}"))
                    });
                }
                8 => {
                    // A transaction that rolls back.
                    let row = random_row(&mut rng, "rolled-back");
                    let victim = live.first().cloned();
                    pair.apply(|db| {
                        db.transaction(None, |tx| {
                            tx.create("samples", row.clone())?;
                            if let Some(victim) = &victim {
                                tx.update(
                                    "samples",
                                    victim,
                                    json!({"ts": "1999-01-01T00:00:00.000Z"}),
                                )?;
                            }
                            Err::<(), _>(EngineError::Operation(
                                proseql_engine::errors::OperationError {
                                    operation: "test".into(),
                                    reason: "abort".into(),
                                    message: "abort".into(),
                                },
                            ))
                        })
                    });
                }
                _ => {}
            }
            for _ in 0..3 {
                let input = random_query(&mut rng);
                pair.query(&input);
                let stats = pair.explain(&input);
                index_plans += usize::from(stats.index_used == IndexUsed::Ordered);
                index_sorts += usize::from(stats.index_sorted);
                if let Some(where_clause) = &input.r#where {
                    pair.count(where_clause);
                }
            }
            if step % 40 == 39 {
                for field in ["ts", "n"] {
                    pair.cursor_pages(&sorted(None, field, SortOrder::Asc), field, 4);
                }
            }
        }
    }
    // The random queries must exercise the index paths, not only fallbacks.
    assert!(index_plans > 1_000, "index plans: {index_plans}");
    assert!(index_sorts > 300, "index sorts: {index_sorts}");
}
