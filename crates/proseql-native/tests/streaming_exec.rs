mod support;

use proseql_engine::query::{AggregateConfig, CursorConfig, QueryInput, SortOrder};
use proseql_native::ExecutionModel;
use serde_json::{json, Value};
use support::parity::{ParityFixture, COLLECTION};

#[test]
fn streaming_reads_do_not_make_partitions_resident() {
    let fixture = ParityFixture::new(180);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let (rows, stats) = runtime
        .query_bounded_with_stats(
            COLLECTION,
            QueryInput {
                limit: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(stats.partitions_read, 3);
    assert_eq!(stats.partitions_resident, 0);
    assert!(runtime
        .lazy_partition_status(COLLECTION)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
}

#[test]
fn generated_filters_sorts_selections_and_pages_match() {
    let fixture = ParityFixture::new(360);
    let mut filters = vec![
        None,
        Some(json!({"metric":"steps"})),
        Some(json!({"metric":{"$in":["heartRate","steps"]}})),
        Some(json!({"$and":[{"atUtc":{"$gte":"2025-02-01"}},{"atUtc":{"$lt":"2025-03-01"}}]})),
    ];
    for op in ["$gte", "$gt", "$lt", "$lte", "$eq", "$ne", "$in"] {
        let operand = if op == "$in" {
            json!([24.4, 98.1, 50.0])
        } else {
            json!(50.0)
        };
        filters.push(Some(json!({"value": {op: operand}})));
    }
    for filter in filters {
        for sort in [
            vec![],
            vec![("value".into(), SortOrder::Asc)],
            vec![("dateUtc".into(), SortOrder::Desc)],
            vec![("atUtc".into(), SortOrder::Desc)],
        ] {
            for offset in [0, 3] {
                let input = QueryInput {
                    r#where: filter.clone(),
                    sort: sort.clone(),
                    offset: Some(offset),
                    limit: Some(7),
                    select: Some(json!(["id", "value"])),
                    ..Default::default()
                };
                fixture
                    .assert_same(|runtime| runtime.query_bounded(COLLECTION, input.clone()))
                    .unwrap();
                fixture
                    .assert_same(|runtime| runtime.query(COLLECTION, input.clone(), None))
                    .unwrap();
            }
        }
    }
}

#[test]
fn cursors_in_both_directions_match() {
    let fixture = ParityFixture::new(360);
    for order in [SortOrder::Asc, SortOrder::Desc] {
        for (after, before) in [
            (None, None),
            (Some("2025-02-02T00:00:00.000Z".into()), None),
            (None, Some("2025-03-02T00:00:00.000Z".into())),
        ] {
            let cursor = CursorConfig {
                key: "atUtc".into(),
                after,
                before,
                limit: 7,
            };
            let input = QueryInput {
                r#where: Some(json!({"metric":{"$in":["heartRate","steps"]}})),
                sort: vec![("atUtc".into(), order.clone())],
                select: Some(json!(["id"])),
                ..Default::default()
            };
            fixture
                .assert_same(|runtime| {
                    runtime.query_cursor_bounded(COLLECTION, input.clone(), &cursor)
                })
                .unwrap();
            fixture
                .assert_same(|runtime| {
                    runtime.query_cursor(COLLECTION, input.clone(), &cursor, None)
                })
                .unwrap();
        }
    }
}

#[test]
fn aggregate_order_and_group_order_match() {
    let fixture = ParityFixture::new(180);
    let config = AggregateConfig {
        count: true,
        sum: vec!["value".into()],
        avg: vec!["value".into()],
        min: vec!["value".into(), "atUtc".into()],
        max: vec!["value".into(), "atUtc".into()],
    };
    for filter in [
        None,
        Some(json!({"metric":{"$in":["heartRate","steps"]}})),
        Some(json!({"atUtc":{"$gte":"2025-02-01", "$lt":"2025-03-01"},"metric":"steps"})),
    ] {
        fixture
            .assert_same(|runtime| runtime.aggregate_bounded(COLLECTION, filter.clone(), &config))
            .unwrap();
        fixture
            .assert_same(|runtime| runtime.aggregate(COLLECTION, filter.clone(), &config))
            .unwrap();
        fixture
            .assert_same(|runtime| {
                runtime.aggregate_grouped_bounded(
                    COLLECTION,
                    filter.clone(),
                    &["dateUtc".into(), "metric".into()],
                    &config,
                )
            })
            .unwrap();
        fixture
            .assert_same(|runtime| {
                runtime.aggregate_grouped(
                    COLLECTION,
                    filter.clone(),
                    &["dateUtc".into(), "metric".into()],
                    &config,
                )
            })
            .unwrap();
    }
}

#[test]
fn every_read_row_is_validated_even_when_filter_and_limit_skip_it() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut bad = support::parity::sample("2025-02", 1, 0, "steps");
    bad["id"] = json!("invalid");
    bad["value"] = json!("not a number");
    text.push_str(&format!("{bad}\n"));
    std::fs::write(path, text).unwrap();
    let error = fixture
        .assert_same(|runtime| {
            runtime.query_bounded(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"metric":"heartRate"})),
                    limit: Some(1),
                    ..Default::default()
                },
            )
        })
        .unwrap_err();
    assert_eq!(error.tag(), "ValidationError");
}

#[test]
fn torn_suffix_is_ignored() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.extend_from_slice(b"{\"id\":\"\xc3");
    std::fs::write(path, bytes).unwrap();
    fixture
        .assert_same(|runtime| runtime.query_bounded(COLLECTION, QueryInput::default()))
        .unwrap();
}

#[test]
fn duplicates_across_partitions_are_detected() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut bad = support::parity::sample("2025-02", 1, 0, "steps");
    bad["id"] = Value::String("steps:2025-01-01T00:00:00.000Z".into());
    text.push_str(&format!("{bad}\n"));
    std::fs::write(path, text).unwrap();
    // Copies have different physical roots, so compare error payload apart from path.
    let error = fixture
        .assert_same(|runtime| {
            runtime
                .query_bounded(COLLECTION, QueryInput::default())
                .map_err(|mut error| {
                    if let proseql_engine::errors::EngineError::SourceConfig(ref mut e) = error {
                        e.path = None;
                    }
                    error
                })
        })
        .unwrap_err();
    assert_eq!(error.tag(), "SourceConfigError");
}

#[test]
fn streaming_stats_describe_physical_scan_not_resident_indexes() {
    let fixture = ParityFixture::new(720);
    let input = QueryInput {
        r#where: Some(json!({"metric":"steps"})),
        limit: Some(2),
        ..Default::default()
    };
    fixture
        .assert_same(|runtime| {
            runtime
                .query_with_stats(COLLECTION, input.clone(), None)
                .map(|(rows, _)| rows)
        })
        .unwrap();
    let runtime = fixture.open(ExecutionModel::Streaming);
    let (rows, stats) = runtime.query_with_stats(COLLECTION, input, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(stats.partitions_loaded, 3);
    assert_eq!(stats.partitions_read, 3);
    assert_eq!(stats.partitions_resident, 0);
    assert_eq!(stats.index_used, proseql_engine::query::IndexUsed::None);
    assert_eq!(stats.candidate_rows, 360);
    assert!(!stats.index_sorted);
}

#[test]
fn full_scan_error_does_not_depend_on_execution_model() {
    use proseql_native::{FullScanPolicy, NativeRuntime};
    let fixture = ParityFixture::new(720);
    let run = |model| {
        let mut options = fixture.options(model);
        options
            .lazy_partitions
            .get_mut(COLLECTION)
            .unwrap()
            .full_scan = FullScanPolicy::Error;
        let runtime = NativeRuntime::open_sources_with_options(fixture.config(), options).unwrap();
        let error = runtime
            .query_bounded(COLLECTION, QueryInput::default())
            .unwrap_err();
        let proseql_engine::errors::EngineError::Operation(ref operation) = error else {
            panic!("unexpected {error:?}");
        };
        assert_eq!(operation.reason, "lazy-full-scan");
        assert!(runtime
            .query_bounded(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"atUtc":{"$gte":"2025-02-01", "$lt":"2025-03-01"}})),
                    ..Default::default()
                }
            )
            .is_ok());
        error
    };
    assert_eq!(
        run(ExecutionModel::Resident),
        run(ExecutionModel::Streaming)
    );
}

#[test]
fn custom_jsonl_codecs_keep_their_registered_decode_semantics() {
    use proseql_formats::{codecs::lenient_jsonl_codec, FormatRegistry};
    use proseql_native::NativeRuntime;
    let fixture = ParityFixture::new(720);
    let builtins = FormatRegistry::with_builtins();
    assert!(builtins.borrowed_jsonl_compatible("jsonl"));
    assert!(builtins.borrowed_jsonl_compatible("ndjson"));
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let mut options = fixture.options(model);
        options.formats.register(Box::new(lenient_jsonl_codec()));
        assert!(!options.formats.borrowed_jsonl_compatible("jsonl"));
        let runtime = NativeRuntime::open_sources_with_options(fixture.config(), options).unwrap();
        let rows = runtime
            .query_bounded(COLLECTION, QueryInput::default())
            .unwrap();
        assert_eq!(rows.len(), 360);
        assert_eq!(
            rows,
            fixture
                .open(ExecutionModel::Resident)
                .query_bounded(COLLECTION, QueryInput::default())
                .unwrap()
        );
        if model == ExecutionModel::Streaming {
            assert!(runtime
                .lazy_partition_status(COLLECTION)
                .unwrap()
                .unwrap()
                .loaded
                .is_empty());
        }
    }
}

#[test]
fn floating_point_order_survives_equality_union_and_overlapping_groups() {
    let fixture = ParityFixture::new(720);
    for (month, _) in support::parity::MONTHS {
        let mut rows = Vec::new();
        for (index, (metric, value)) in [
            ("steps", 1e16),
            ("heartRate", 1.0),
            ("steps", -1e16),
            ("heartRate", 2.0),
        ]
        .into_iter()
        .enumerate()
        {
            let mut row = support::parity::sample(month, 1, index as u32, metric);
            row["value"] = json!(value);
            rows.push(row.to_string());
        }
        std::fs::write(fixture.partition_path(month), rows.join("\n")).unwrap();
    }
    let config = AggregateConfig {
        count: true,
        sum: vec!["value".into(), "value".into()],
        avg: vec!["value".into()],
        ..Default::default()
    };
    for metrics in [json!(["steps", "heartRate"]), json!(["heartRate", "steps"])] {
        let filter = Some(json!({"metric":{"$in":metrics}}));
        fixture
            .assert_same(|runtime| runtime.aggregate_bounded(COLLECTION, filter.clone(), &config))
            .unwrap();
        // The same group spans both candidate ranks: do not combine sums.
        fixture
            .assert_same(|runtime| {
                runtime.aggregate_grouped_bounded(
                    COLLECTION,
                    filter.clone(),
                    &["dateUtc".into()],
                    &config,
                )
            })
            .unwrap();
    }
}

#[test]
fn canonical_schema_decode_and_callbacks_remain_in_the_read_path() {
    use proseql_engine::descriptor::{SchemaCheck, SchemaNode};
    use proseql_native::NativeRuntime;
    let fixture = ParityFixture::new(720);
    for (month, _) in support::parity::MONTHS {
        let text = std::fs::read_to_string(fixture.partition_path(month)).unwrap();
        let text = text
            .lines()
            .map(|line| {
                let mut row: Value = serde_json::from_str(line).unwrap();
                row["value"] = Value::String(row["value"].to_string());
                row.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(fixture.partition_path(month), text).unwrap();
    }
    let run = |model| {
        let mut config = fixture.config();
        let SchemaNode::Struct { fields } = &mut config.collections[0].descriptor.schema else {
            unreachable!()
        };
        fields
            .iter_mut()
            .find(|field| field.name == "value")
            .unwrap()
            .schema = SchemaNode::Checked {
            inner: Box::new(SchemaNode::NumFromStr),
            checks: vec![SchemaCheck::new(
                "custom/finite",
                json!(null),
                "finite number",
                Some("finite".into()),
            )],
        };
        let mut options = fixture.options(model);
        options.callbacks.register_predicate(
            "finite",
            Box::new(|value| value.as_f64().is_some_and(f64::is_finite)),
        );
        let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
        runtime.aggregate_grouped_bounded(
            COLLECTION,
            None,
            &["metric".into()],
            &AggregateConfig {
                count: true,
                sum: vec!["value".into()],
                ..Default::default()
            },
        )
    };
    assert_eq!(
        run(ExecutionModel::Resident),
        run(ExecutionModel::Streaming)
    );
}

#[test]
fn cursor_errors_and_non_cursor_entrypoint_errors_match() {
    let fixture = ParityFixture::new(720);
    for cursor in [
        CursorConfig {
            key: "atUtc".into(),
            after: Some("a".into()),
            before: Some("z".into()),
            limit: 2,
        },
        CursorConfig {
            key: "atUtc".into(),
            after: None,
            before: None,
            limit: 0,
        },
        CursorConfig {
            key: "missing".into(),
            after: None,
            before: None,
            limit: 2,
        },
    ] {
        assert!(fixture
            .assert_same(|runtime| runtime.query_cursor_bounded(
                COLLECTION,
                QueryInput::default(),
                &cursor
            ))
            .is_err());
    }
    let cursor = CursorConfig {
        key: "atUtc".into(),
        after: None,
        before: None,
        limit: 2,
    };
    assert!(fixture
        .assert_same(|runtime| runtime.query(
            COLLECTION,
            QueryInput {
                cursor: Some(cursor.clone()),
                ..Default::default()
            },
            None
        ))
        .is_err());
}

fn without_source_path(
    mut error: proseql_engine::errors::EngineError,
) -> proseql_engine::errors::EngineError {
    if let proseql_engine::errors::EngineError::SourceConfig(ref mut source) = error {
        source.path = None;
    }
    error
}

#[test]
fn malformed_lines_duplicate_local_ids_and_missing_ids_keep_canonical_errors() {
    for suffix in ["not json\n", "{}\n", "null\n", "{\"id\":5}\n"] {
        let fixture = ParityFixture::new(720);
        let path = fixture.partition_path("2025-02");
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(suffix);
        std::fs::write(path, text).unwrap();
        assert!(fixture
            .assert_same(|runtime| runtime
                .query_bounded(COLLECTION, QueryInput::default())
                .map_err(without_source_path))
            .is_err());
    }
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str(&format!(
        "{}\n",
        support::parity::sample("2025-02", 1, 0, "steps")
    ));
    std::fs::write(path, text).unwrap();
    assert!(fixture
        .assert_same(|runtime| runtime
            .query_bounded(COLLECTION, QueryInput::default())
            .map_err(without_source_path))
        .is_err());
}

#[test]
fn populated_queries_stay_in_natural_order_and_search_uses_canonical_scoring() {
    let fixture = ParityFixture::new(720);
    fixture
        .assert_same(|runtime| {
            runtime.query(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"metric":{"$in":["heartRate","steps"]}})),
                    limit: Some(7),
                    ..Default::default()
                },
                Some(json!({})),
            )
        })
        .unwrap();
    fixture
        .assert_same(|runtime| {
            runtime.query_bounded(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"$search":{"query":"phone", "fields":["source"]}})),
                    limit: Some(7),
                    ..Default::default()
                },
            )
        })
        .unwrap();
}

#[test]
fn torn_whitespace_and_crlf_are_compatible() {
    let fixture = ParityFixture::new(720);
    for (month, _) in support::parity::MONTHS {
        let path = fixture.partition_path(month);
        let mut text = std::fs::read_to_string(&path)
            .unwrap()
            .replace('\n', "\r\n\r\n");
        text.push_str("  \t\r");
        std::fs::write(path, text).unwrap();
    }
    fixture
        .assert_same(|runtime| runtime.query_bounded(COLLECTION, QueryInput::default()))
        .unwrap();
}

#[test]
fn partition_error_precedence_is_not_changed_by_pushdown() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut invalid = support::parity::sample("2025-02", 1, 1, "steps");
    invalid["value"] = json!("invalid");
    text.push_str(&format!("{invalid}\nmalformed\n"));
    std::fs::write(path, text).unwrap();
    let error = fixture
        .assert_same(|runtime| {
            runtime
                .query_bounded(COLLECTION, QueryInput::default())
                .map_err(without_source_path)
        })
        .unwrap_err();
    assert_eq!(error.tag(), "SerializationError");

    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut duplicate = support::parity::sample("2025-02", 1, 0, "steps");
    duplicate["id"] = json!("steps:2025-01-01T00:00:00.000Z");
    text.push_str(&format!("{duplicate}\n"));
    std::fs::write(path, text).unwrap();
    let path = fixture.partition_path("2025-03");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut invalid = support::parity::sample("2025-03", 1, 1, "steps");
    invalid["value"] = json!("invalid");
    text.push_str(&format!("{invalid}\n"));
    std::fs::write(path, text).unwrap();
    let error = fixture
        .assert_same(|runtime| {
            runtime
                .query_bounded(COLLECTION, QueryInput::default())
                .map_err(without_source_path)
        })
        .unwrap_err();
    assert_eq!(error.tag(), "SourceConfigError");
}

struct DropSourceCodec;
impl proseql_formats::FormatCodec for DropSourceCodec {
    fn name(&self) -> &str {
        "drop-source"
    }
    fn extensions(&self) -> &[&str] {
        &["jsonl"]
    }
    fn encode(
        &self,
        value: &Value,
        options: Option<proseql_formats::FormatOptions>,
    ) -> Result<String, String> {
        proseql_formats::codecs::jsonl_codec().encode(value, options)
    }
    fn decode(&self, raw: &str) -> Result<Value, String> {
        let mut rows = proseql_formats::codecs::jsonl_codec().decode(raw)?;
        for row in rows.as_array_mut().ok_or("expected rows")? {
            row.as_object_mut()
                .ok_or("expected row")?
                .shift_remove("source");
        }
        Ok(rows)
    }
}
#[test]
fn a_custom_codec_that_changes_rows_is_not_bypassed() {
    use proseql_engine::descriptor::SchemaNode;
    use proseql_native::NativeRuntime;
    let fixture = ParityFixture::new(720);
    let run = |model| {
        let mut config = fixture.config();
        let SchemaNode::Struct { fields } = &mut config.collections[0].descriptor.schema else {
            unreachable!()
        };
        fields
            .iter_mut()
            .find(|field| field.name == "source")
            .unwrap()
            .schema = SchemaNode::Optional(Box::new(SchemaNode::Str));
        let mut options = fixture.options(model);
        options.formats.register(Box::new(DropSourceCodec));
        let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
        let (rows, stats) = runtime
            .query_with_stats(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"atUtc":{"$gte":"2025-02-01", "$lt":"2025-03-01"}})),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(rows.iter().all(|row| row.get("source").is_none()));
        if model == ExecutionModel::Streaming {
            assert_eq!(stats.index_used, proseql_engine::query::IndexUsed::None);
        }
        rows
    };
    assert_eq!(
        run(ExecutionModel::Resident),
        run(ExecutionModel::Streaming)
    );
}

#[test]
fn codec_path_preserves_duplicate_before_later_partition_error() {
    let fixture = ParityFixture::new(720);
    let path = fixture.partition_path("2025-02");
    let mut text = std::fs::read_to_string(&path).unwrap();
    let mut duplicate = support::parity::sample("2025-02", 1, 1, "steps");
    duplicate["id"] = json!("steps:2025-01-01T00:00:00.000Z");
    text.push_str(&format!("{duplicate}\n"));
    std::fs::write(path, text).unwrap();
    let path = fixture.partition_path("2025-03");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("{}\n");
    std::fs::write(path, text).unwrap();
    let run = |model| {
        let mut options = fixture.options(model);
        options
            .formats
            .register(Box::new(proseql_formats::codecs::lenient_jsonl_codec()));
        let runtime =
            proseql_native::NativeRuntime::open_sources_with_options(fixture.config(), options)
                .unwrap();
        runtime
            .query_bounded(COLLECTION, QueryInput::default())
            .unwrap_err()
    };
    let resident = run(ExecutionModel::Resident);
    assert_eq!(resident.tag(), "SourceConfigError");
    assert_eq!(resident, run(ExecutionModel::Streaming));
}
