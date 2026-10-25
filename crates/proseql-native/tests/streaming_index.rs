mod support;
use proseql_native::{ExecutionModel, FullScanPolicy, NativeRuntime};
use serde_json::json;
use std::fs;
use support::parity::{sample, ParityFixture, COLLECTION, SOURCE};

#[test]
fn find_hits_and_misses_match_resident_without_resident_partitions() {
    let fixture = ParityFixture::new(120);
    for id in ["steps:2025-02-03T04:00:00.000Z", "absent"] {
        fixture
            .assert_same(|runtime| runtime.find_by_id(COLLECTION, id))
            .unwrap();
    }
    let runtime = fixture.open(ExecutionModel::Streaming);
    runtime
        .find_by_id(COLLECTION, "steps:2025-02-03T04:00:00.000Z")
        .unwrap()
        .unwrap();
    assert!(runtime
        .lazy_partition_status(SOURCE)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
    runtime.close().unwrap();
}

#[test]
fn edited_unsorted_appended_and_deleted_files_match_fresh_full_scans() {
    let fixture = ParityFixture::new(120);
    let runtime = fixture.open(ExecutionModel::Streaming);
    runtime.find_by_id(COLLECTION, "absent").unwrap();
    let path = fixture.partition_path("2025-02");
    let mut lines = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    lines.reverse();
    let mut edited = serde_json::from_str::<serde_json::Value>(&lines[0]).unwrap();
    edited["id"] = json!("edited");
    lines[0] = edited.to_string();
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    let mut appended = sample("2025-02", 1, 1, "steps");
    appended["id"] = json!("external");
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{appended}"
    )
    .unwrap();
    for id in ["edited", "external", "absent"] {
        let resident = fixture.open(ExecutionModel::Resident);
        assert_eq!(
            runtime.find_by_id(COLLECTION, id),
            resident.find_by_id(COLLECTION, id)
        );
        resident.close().unwrap();
    }
    fs::remove_file(path).unwrap();
    assert_eq!(runtime.find_by_id(COLLECTION, "edited").unwrap(), None);
    runtime.close().unwrap();
}

#[test]
fn find_keeps_full_scan_error_policy_even_after_building_an_index() {
    let fixture = ParityFixture::new(120);
    let mut errors = Vec::new();
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let mut options = fixture.options(model);
        options.lazy_partitions.get_mut(SOURCE).unwrap().full_scan = FullScanPolicy::Error;
        let runtime = NativeRuntime::open_sources_with_options(fixture.config(), options).unwrap();
        errors.push(runtime.find_by_id(COLLECTION, "absent").unwrap_err());
        runtime.close().unwrap();
    }
    assert_eq!(errors[0], errors[1]);
}

#[test]
fn duplicate_ids_and_invalid_payloads_match_resident_errors() {
    let fixture = ParityFixture::new(120);
    let mut row = sample("2025-02", 1, 0, "steps");
    row["id"] = json!("steps:2025-01-01T00:00:00.000Z");
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{row}"
    )
    .unwrap();
    // Path payloads differ between harness copies; compare the error class
    // and message through the shared differential fixture.
    fixture
        .assert_same(|runtime| {
            runtime
                .find_by_id(COLLECTION, "absent")
                .map_err(|mut error| {
                    if let proseql_engine::errors::EngineError::SourceConfig(config) = &mut error {
                        config.path = None;
                    }
                    error
                })
        })
        .unwrap_err();

    let fixture = ParityFixture::new(120);
    let mut row = sample("2025-02", 1, 1, "steps");
    row["value"] = json!("invalid");
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{row}"
    )
    .unwrap();
    fixture
        .assert_same(|runtime| runtime.find_by_id(COLLECTION, "absent"))
        .unwrap_err();
}
