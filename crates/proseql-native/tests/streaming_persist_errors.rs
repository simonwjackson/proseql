mod support;
use proseql_engine::query::QueryInput;
use serde_json::json;
use std::{fs, io::Write};
use support::parity::{ParityFixture, RuntimeKind, COLLECTION};

fn range() -> QueryInput {
    QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-03T00:00:00.000Z", "$lt":"2025-02-03T01:00:00.000Z"}}),
        ),
        ..Default::default()
    }
}

#[test]
fn invalid_payload_in_original_or_appended_text_has_the_same_error_without_sidecars() {
    for appended in [false, true] {
        let fixture = ParityFixture::new(60);
        let runtime = fixture.open(RuntimeKind::Lazy);
        runtime.query_bounded(COLLECTION, range()).unwrap();
        runtime.close().unwrap();
        let path = fixture.partition_path("2025-02");
        let mut invalid = support::parity::sample("2025-02", 28, 59, "steps");
        invalid["id"] = json!("bad");
        invalid["value"] = json!("invalid");
        if appended {
            writeln!(
                fs::OpenOptions::new().append(true).open(&path).unwrap(),
                "{invalid}"
            )
            .unwrap();
        } else {
            let text = fs::read_to_string(&path).unwrap();
            fs::write(&path, format!("{invalid}\n{text}")).unwrap();
        }
        let with = fixture.open(RuntimeKind::Lazy);
        let with_error = with.query_bounded(COLLECTION, range()).unwrap_err();
        with.close().unwrap();
        fs::remove_dir_all(path.parent().unwrap().join(".proseql-index")).unwrap();
        let without = fixture.open(RuntimeKind::Lazy);
        assert_eq!(
            with_error,
            without.query_bounded(COLLECTION, range()).unwrap_err()
        );
        without.close().unwrap();
    }
}

#[test]
fn failed_scan_never_writes_time_metadata_and_cached_files_still_check_global_duplicates() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(RuntimeKind::Lazy);
    runtime.find_by_id(COLLECTION, "absent").unwrap();
    runtime.close().unwrap();
    let first = fs::read_to_string(fixture.partition_path("2025-01")).unwrap();
    let mut row: serde_json::Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
    row["atUtc"] = json!("2025-02-01T00:00:00.000Z");
    row["dateUtc"] = json!("2025-02-01");
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{row}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let error = runtime.find_by_id(COLLECTION, "absent").unwrap_err();
    assert!(error.to_string().contains("Duplicate partition record"));
    runtime.close().unwrap();
    let dir = fixture
        .partition_path("2025-02")
        .parent()
        .unwrap()
        .join(".proseql-index");
    fs::remove_dir_all(&dir).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    assert_eq!(error, runtime.find_by_id(COLLECTION, "absent").unwrap_err());
    runtime.close().unwrap();

    let fixture = ParityFixture::new(60);
    let mut invalid = support::parity::sample("2025-02", 3, 0, "steps");
    invalid["value"] = json!("bad");
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{invalid}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    assert!(runtime.query_bounded(COLLECTION, range()).is_err());
    runtime.close().unwrap();
    let dir = fixture
        .partition_path("2025-02")
        .parent()
        .unwrap()
        .join(".proseql-index");
    assert!(
        !dir.exists(),
        "failed scan has no persistent time publication"
    );
}

#[test]
fn checked_own_append_is_saved_on_release_and_reopened() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(RuntimeKind::Lazy);
    runtime.find_by_id(COLLECTION, "absent").unwrap();
    let mut row = support::parity::sample("2025-02", 28, 59, "steps");
    row["id"] = json!("own");
    runtime
        .mutate(|m| m.create(COLLECTION, row.clone()))
        .unwrap();
    runtime.release_streaming_indexes().unwrap();
    let reopened = fixture.open(RuntimeKind::Lazy);
    assert_eq!(reopened.find_by_id(COLLECTION, "own").unwrap(), Some(row));
    reopened.close().unwrap();
    runtime.close().unwrap();
}

#[test]
fn membership_only_sidecars_never_reorder_validation_before_duplicate_errors() {
    let fixture = ParityFixture::new(60);
    let path = fixture.partition_path("2025-01");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut invalid: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    invalid["value"] = json!("bad");
    lines[0] = invalid.to_string();
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    // Append builds membership, deliberately without validating old payloads.
    let runtime = fixture.open(RuntimeKind::Lazy);
    let mut new = support::parity::sample("2025-03", 28, 59, "steps");
    new["id"] = json!("own");
    runtime.mutate(|m| m.create(COLLECTION, new)).unwrap();
    runtime.close().unwrap();
    let mut duplicate = support::parity::sample("2025-02", 28, 59, "steps");
    duplicate["id"] = invalid["id"].clone();
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{duplicate}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let with = runtime.find_by_id(COLLECTION, "absent").unwrap_err();
    runtime.close().unwrap();
    fs::remove_dir_all(path.parent().unwrap().join(".proseql-index")).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let without = runtime.find_by_id(COLLECTION, "absent").unwrap_err();
    assert_eq!(with, without);
    runtime.close().unwrap();
}

#[test]
fn grown_time_sidecar_never_hides_a_suffix_id_duplicating_the_prefix() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(RuntimeKind::Lazy);
    runtime.query_bounded(COLLECTION, range()).unwrap();
    runtime.close().unwrap();
    let path = fixture.partition_path("2025-02");
    let mut duplicate = support::parity::sample("2025-02", 28, 1439, "steps");
    duplicate["id"] = json!("steps:2025-02-03T00:00:00.000Z");
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{duplicate}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let with = runtime.query_bounded(COLLECTION, range());
    runtime.close().unwrap();
    fs::remove_dir_all(path.parent().unwrap().join(".proseql-index")).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let without = runtime.query_bounded(COLLECTION, range());
    assert!(without
        .as_ref()
        .unwrap_err()
        .to_string()
        .contains("Partition records need unique string IDs"));
    assert_eq!(with, without);
    runtime.close().unwrap();
}

#[test]
fn older_validation_cannot_authorize_newer_invalid_membership() {
    let fixture = ParityFixture::new(60);
    let runtime = fixture.open(RuntimeKind::Lazy);
    runtime.find_by_id(COLLECTION, "absent").unwrap();
    runtime.close().unwrap();
    let path = fixture.partition_path("2025-01");
    let mut invalid = support::parity::sample("2025-01", 31, 1439, "steps");
    invalid["id"] = json!("invalid-gap");
    invalid["value"] = json!("bad");
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{invalid}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let mut new = support::parity::sample("2025-03", 28, 1439, "steps");
    new["id"] = json!("own");
    runtime.mutate(|m| m.create(COLLECTION, new)).unwrap();
    runtime.close().unwrap();
    let mut duplicate = support::parity::sample("2025-02", 28, 1439, "steps");
    duplicate["id"] = json!("steps:2025-01-01T00:00:00.000Z");
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{duplicate}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let with = runtime.find_by_id(COLLECTION, "absent");
    runtime.close().unwrap();
    fs::remove_dir_all(path.parent().unwrap().join(".proseql-index")).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let without = runtime.find_by_id(COLLECTION, "absent");
    assert!(matches!(
        &without,
        Err(proseql_engine::errors::EngineError::Validation(_))
    ));
    assert_eq!(with, without);
    runtime.close().unwrap();
}
