use std::sync::{Arc, Mutex};

use proseql_engine::{
    callbacks::CallbackRegistry,
    descriptor::MigrationDescriptor,
    errors::EngineError,
    migrations::{
        dry_run_report, post_migration_validation_error, run_migrations,
        validate_migration_registry, DryRunStatus,
    },
};
use serde_json::{json, Map, Value};

fn step(from: u32, to: u32, callback_id: &str) -> MigrationDescriptor {
    MigrationDescriptor {
        from,
        to,
        description: Some(format!("{}-{}", from, to)),
        callback_id: callback_id.into(),
    }
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

#[test]
fn validate_registry_accepts_version_zero_empty_registry() {
    validate_migration_registry("users", 0, &[]).unwrap();
}

#[test]
fn validate_registry_rejects_empty_registry_for_positive_version() {
    let error = validate_migration_registry("users", 1, &[]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "empty-registry"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_invalid_increment_forward_gap() {
    let error = validate_migration_registry("users", 3, &[step(0, 3, "x")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "invalid-increment"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_invalid_increment_same_version() {
    let error = validate_migration_registry("users", 2, &[step(1, 1, "x")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "invalid-increment"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_duplicate_from() {
    let error =
        validate_migration_registry("users", 2, &[step(0, 1, "a"), step(0, 1, "b")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "duplicate-from"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_missing_start() {
    let error = validate_migration_registry("users", 2, &[step(1, 2, "a")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "missing-start"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_gap_in_chain() {
    let error =
        validate_migration_registry("users", 3, &[step(0, 1, "a"), step(2, 3, "b")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "gap-in-chain"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_version_mismatch_when_last_too_low() {
    let error =
        validate_migration_registry("users", 3, &[step(0, 1, "a"), step(1, 2, "b")]).unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "version-mismatch"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_rejects_version_mismatch_when_last_too_high() {
    let error = validate_migration_registry(
        "users",
        2,
        &[step(0, 1, "a"), step(1, 2, "b"), step(2, 3, "c")],
    )
    .unwrap_err();
    match error {
        EngineError::Migration(error) => assert_eq!(error.reason, "version-mismatch"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn validate_registry_accepts_unordered_but_contiguous_chain() {
    validate_migration_registry(
        "users",
        3,
        &[step(2, 3, "c"), step(0, 1, "a"), step(1, 2, "b")],
    )
    .unwrap();
}

#[test]
fn run_migrations_is_noop_when_file_version_is_current_or_ahead() {
    let registry = CallbackRegistry::new();
    let data = map(json!({"u1": {"name": "Alice"}}));
    let output =
        run_migrations(&registry, "users", 3, 3, &[step(0, 1, "x")], data.clone()).unwrap();
    assert_eq!(output, data);
}

#[test]
fn run_migrations_sorts_and_runs_only_applicable_suffix() {
    let mut registry = CallbackRegistry::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    for (id, field, value) in [("m2", "v2", 2), ("m3", "v3", 3)] {
        let calls = Arc::clone(&calls);
        registry.register_migration(
            id,
            Box::new(move |data| {
                calls.lock().unwrap().push(id.to_owned());
                let mut out = data.clone();
                out.insert(field.into(), json!(value));
                Ok(out)
            }),
        );
    }
    registry.register_migration("m1", Box::new(|data| Ok(data.clone())));
    let output = run_migrations(
        &registry,
        "users",
        1,
        3,
        &[step(2, 3, "m3"), step(1, 2, "m2"), step(0, 1, "m1")],
        map(json!({"u1": {"name": "Alice"}})),
    )
    .unwrap();
    assert_eq!(calls.lock().unwrap().clone(), vec!["m2", "m3"]);
    assert_eq!(output["v2"], json!(2));
    assert_eq!(output["v3"], json!(3));
}

#[test]
fn run_migrations_uses_whole_map_callbacks() {
    let mut registry = CallbackRegistry::new();
    registry.register_migration(
        "rename",
        Box::new(|data| {
            let mut out = Map::new();
            for (id, value) in data {
                out.insert(format!("copy-{id}"), value.clone());
            }
            Ok(out)
        }),
    );
    let output = run_migrations(
        &registry,
        "users",
        0,
        1,
        &[step(0, 1, "rename")],
        map(json!({"u1": {"name": "Alice"}})),
    )
    .unwrap();
    assert!(output.contains_key("copy-u1"));
}

#[test]
fn run_migrations_wraps_missing_callback_as_transform_failed() {
    let registry = CallbackRegistry::new();
    let error = run_migrations(
        &registry,
        "users",
        0,
        1,
        &[step(0, 1, "missing")],
        map(json!({"u1": {"name": "Alice"}})),
    )
    .unwrap_err();
    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.reason, "transform-failed");
            assert_eq!(error.step, 0);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn run_migrations_wraps_non_migration_errors_with_step_index() {
    let mut registry = CallbackRegistry::new();
    registry.register_migration(
        "boom",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "migrate".into(),
                    reason: "boom".into(),
                    message: "boom".into(),
                },
            ))
        }),
    );
    let error = run_migrations(
        &registry,
        "users",
        0,
        1,
        &[step(0, 1, "boom")],
        map(json!({"u1": {"name": "Alice"}})),
    )
    .unwrap_err();
    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.reason, "transform-failed");
            assert_eq!(error.step, 0);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn run_migrations_preserves_existing_migration_error() {
    let mut registry = CallbackRegistry::new();
    registry.register_migration(
        "boom",
        Box::new(|_| {
            Err(EngineError::Migration(Box::new(
                proseql_engine::errors::MigrationError {
                    collection: "users".into(),
                    from_version: 0,
                    to_version: 1,
                    step: 7,
                    reason: "custom".into(),
                    message: "custom".into(),
                },
            )))
        }),
    );
    let error = run_migrations(
        &registry,
        "users",
        0,
        1,
        &[step(0, 1, "boom")],
        map(json!({"u1": {"name": "Alice"}})),
    )
    .unwrap_err();
    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.reason, "custom");
            assert_eq!(error.step, 7);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn post_migration_validation_helper_sets_step_minus_one() {
    let error = post_migration_validation_error("users", 1, 2, "bad");
    match error {
        EngineError::Migration(error) => {
            assert_eq!(error.step, -1);
            assert_eq!(error.reason, "post-migration-validation-failed");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn dry_run_reports_no_file() {
    let report = dry_run_report(false, 0, 3, &[step(0, 1, "a")]);
    assert_eq!(report.status, DryRunStatus::NoFile);
    assert!(report.migrations_to_apply.is_empty());
}

#[test]
fn dry_run_reports_ahead() {
    let report = dry_run_report(true, 4, 3, &[step(0, 1, "a")]);
    assert_eq!(report.status, DryRunStatus::Ahead);
}

#[test]
fn dry_run_reports_up_to_date() {
    let report = dry_run_report(true, 3, 3, &[step(0, 1, "a")]);
    assert_eq!(report.status, DryRunStatus::UpToDate);
}

#[test]
fn dry_run_reports_needed_suffix_chain_without_running_callbacks() {
    let report = dry_run_report(
        true,
        1,
        3,
        &[step(2, 3, "c"), step(1, 2, "b"), step(0, 1, "a")],
    );
    assert_eq!(report.status, DryRunStatus::NeedsMigration);
    assert_eq!(report.migrations_to_apply.len(), 2);
    assert_eq!(report.migrations_to_apply[0].from, 1);
    assert_eq!(report.migrations_to_apply[1].from, 2);
}
