//! Cutover blockers: keep Resident as the compatible default, and state the
//! explicitly approved opt-in Streaming differences through public APIs.
mod support;

use proseql_engine::descriptor::{SchemaCheck, SchemaNode};
use proseql_engine::errors::EngineError;
use proseql_engine::query::{pipeline::QueryInput, AggregateConfig};
use proseql_engine::reactive::WatchQueryConfig;
use proseql_native::{ExecutionModel, FullScanPolicy, NativeRuntime};
use serde_json::json;
use support::parity::{sample, ParityFixture, COLLECTION, SOURCE};

fn reason(error: &EngineError) -> &str {
    match error {
        EngineError::Operation(error) => &error.reason,
        _ => panic!("expected OperationError, got {error:?}"),
    }
}

fn january() -> QueryInput {
    QueryInput {
        r#where: Some(json!({"atUtc":{"$startsWith":"2025-01"}})),
        ..Default::default()
    }
}

#[test]
fn resident_default_keeps_the_query_then_read_hydration_contract() {
    assert_eq!(ExecutionModel::default(), ExecutionModel::Resident);
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::default());
    let rows = runtime.query_bounded(COLLECTION, january()).unwrap();
    assert!(!rows.is_empty());
    runtime
        .read(|db| {
            let collection = db.collection(COLLECTION).unwrap();
            for row in rows {
                assert_eq!(collection.get(row["id"].as_str().unwrap()), Some(&row));
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn streaming_zero_limit_probe_cannot_hydrate_the_engine_for_a_later_read() {
    let fixture = ParityFixture::new(1440);
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let runtime = fixture.open(model);
        let rows = runtime
            .query_bounded(
                COLLECTION,
                QueryInput {
                    r#where: Some(json!({"atUtc":{"$startsWith":"2025-01"},"id":{"$in":[]}})),
                    limit: Some(0),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(rows.is_empty());
        let resident_rows = runtime
            .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
            .unwrap();
        if model == ExecutionModel::Resident {
            assert!(resident_rows > 0);
        } else {
            assert_eq!(resident_rows, 0);
        }
    }
}

#[test]
fn streaming_unwatched_invalid_edits_fail_like_resident_without_a_cache() {
    let fixture = ParityFixture::new(1440);
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let copy = fixture.copy();
        let mut config = copy.config();
        let SchemaNode::Struct { fields } = &mut config.collections[0].descriptor.schema else {
            unreachable!()
        };
        fields
            .iter_mut()
            .find(|field| field.name == "value")
            .unwrap()
            .schema = SchemaNode::Checked {
            inner: Box::new(SchemaNode::Num),
            checks: vec![SchemaCheck::new(
                "custom/nonnegative",
                json!(null),
                "nonnegative",
                Some("nonnegative".into()),
            )],
        };
        let mut options = copy.options(model);
        options
            .lazy_partitions
            .get_mut(SOURCE)
            .unwrap()
            .max_loaded_partitions = 0;
        options.callbacks.register_predicate(
            "nonnegative",
            Box::new(|value| value.as_f64().is_some_and(|number| number >= 0.0)),
        );
        let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
        let id = "steps:2025-01-01T00:00:00.000Z";
        assert!(runtime.find_by_id(COLLECTION, id).unwrap().is_some());
        assert!(runtime
            .lazy_partition_status(SOURCE)
            .unwrap()
            .unwrap()
            .loaded
            .is_empty());
        let mut invalid = sample("2025-01", 1, 0, "steps");
        invalid["value"] = json!(-1);
        std::fs::write(copy.partition_path("2025-01"), format!("{invalid}\n")).unwrap();
        // Neither runtime has a watch or accepted resident rows. Reload lists
        // the source; subsequent reads must fail, not return invalid data.
        runtime.reload().unwrap();
        let lookup_error = runtime.find_by_id(COLLECTION, id).unwrap_err();
        assert_eq!(lookup_error.tag(), "ValidationError");
        assert_eq!(
            runtime.query(COLLECTION, january(), None).unwrap_err(),
            lookup_error
        );
        assert_eq!(
            runtime.query_bounded(COLLECTION, january()).unwrap_err(),
            lookup_error
        );
        assert_eq!(
            runtime
                .aggregate(COLLECTION, None, &AggregateConfig::count())
                .unwrap_err(),
            lookup_error
        );
        assert_eq!(
            runtime
                .aggregate_grouped_bounded(
                    COLLECTION,
                    None,
                    &["metric".into()],
                    &AggregateConfig::count()
                )
                .unwrap_err(),
            lookup_error
        );
        assert!(runtime.last_reload_error().unwrap().is_none());
    }
}

#[test]
fn streaming_error_policy_has_no_history_dependent_id_hit_exception() {
    let fixture = ParityFixture::new(1440);
    let id = "steps:2025-01-01T00:00:00.000Z";
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let copy = fixture.copy();
        let mut options = copy.options(model);
        options.lazy_partitions.get_mut(SOURCE).unwrap().full_scan = FullScanPolicy::Error;
        let runtime = NativeRuntime::open_sources_with_options(copy.config(), options).unwrap();
        assert_eq!(
            reason(&runtime.find_by_id(COLLECTION, id).unwrap_err()),
            "lazy-full-scan"
        );
        runtime.query_bounded(COLLECTION, january()).unwrap();
        let watch = runtime
            .watch(
                COLLECTION,
                WatchQueryConfig {
                    r#where: january().r#where,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!watch.recv().unwrap().as_array().unwrap().is_empty());
        if model == ExecutionModel::Resident {
            assert!(runtime.find_by_id(COLLECTION, id).unwrap().is_some());
        } else {
            assert_eq!(
                reason(&runtime.find_by_id(COLLECTION, id).unwrap_err()),
                "lazy-full-scan"
            );
            runtime
                .mutate(|tx| {
                    assert_eq!(
                        reason(&tx.find_by_id(COLLECTION, id).unwrap_err()),
                        "lazy-full-scan"
                    );
                    let row = sample("2025-01", 1, 1, "steps");
                    tx.create(COLLECTION, row.clone())?;
                    assert_eq!(
                        tx.find_by_id(COLLECTION, row["id"].as_str().unwrap())?,
                        Some(row)
                    );
                    Ok(())
                })
                .unwrap();
        }
    }
    let allowed = fixture.open(ExecutionModel::Streaming);
    assert!(allowed.find_by_id(COLLECTION, id).unwrap().is_some());
}
