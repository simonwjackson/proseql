mod support;

#[cfg(feature = "bench-observe")]
#[path = "streaming_index/measure.rs"]
mod measure;
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
fn find_keeps_full_scan_error_policy() {
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

#[test]
fn mutation_find_uses_the_same_nonresident_lookup() {
    let fixture = ParityFixture::new(120);
    fixture
        .assert_same(|runtime| {
            runtime.mutate(|mutation| {
                let found = mutation.find_by_id(COLLECTION, "steps:2025-02-03T04:00:00.000Z")?;
                assert!(found.is_some());
                mutation.find_by_id(COLLECTION, "absent")
            })
        })
        .unwrap();
}

#[test]
fn malformed_terminated_lines_keep_file_global_error_numbers() {
    let fixture = ParityFixture::new(120);
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "\n\n{{broken}}"
    )
    .unwrap();
    fixture
        .assert_same(|runtime| runtime.find_by_id(COLLECTION, "absent"))
        .unwrap_err();
}

#[test]
fn invalid_utf8_keeps_file_global_error_offset() {
    let fixture = ParityFixture::new(120);
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(fixture.partition_path("2025-02"))
        .unwrap()
        .write_all(b"{\"id\":\"bad\",\"metric\":\"\xff\"}\n")
        .unwrap();
    let resident = fixture.open(ExecutionModel::Resident);
    let streaming = fixture.open(ExecutionModel::Streaming);
    assert_eq!(
        resident.find_by_id(COLLECTION, "absent"),
        streaming.find_by_id(COLLECTION, "absent")
    );
}

#[test]
fn torn_and_unterminated_valid_lines_match_resident() {
    for torn in [false, true] {
        let fixture = ParityFixture::new(120);
        let path = fixture.partition_path("2025-02");
        let mut text = fs::read_to_string(&path).unwrap();
        text.pop();
        if torn {
            text.push_str("\n{\"id\":\"torn");
        }
        fs::write(path, text).unwrap();
        fixture
            .assert_same(|runtime| runtime.find_by_id(COLLECTION, "absent"))
            .unwrap();
    }
}

#[test]
fn returned_rows_use_schema_decoding_not_raw_json() {
    let fixture = ParityFixture::new(120);
    for month in ["2025-01", "2025-02", "2025-03"] {
        let path = fixture.partition_path(month);
        let text = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| {
                let mut value = serde_json::from_str::<serde_json::Value>(line).unwrap();
                value["value"] = json!(value["value"].to_string());
                format!("{value}\n")
            })
            .collect::<String>();
        fs::write(path, text).unwrap();
    }
    let mut results = Vec::new();
    for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
        let mut config = fixture.config();
        if let proseql_engine::descriptor::SchemaNode::Struct { fields } =
            &mut config.collections[0].descriptor.schema
        {
            fields
                .iter_mut()
                .find(|field| field.name == "value")
                .unwrap()
                .schema = proseql_engine::descriptor::SchemaNode::NumFromStr;
        }
        let runtime =
            NativeRuntime::open_sources_with_options(config, fixture.options(model)).unwrap();
        let row = runtime
            .find_by_id(COLLECTION, "steps:2025-02-03T04:00:00.000Z")
            .unwrap()
            .unwrap();
        assert!(row["value"].is_number());
        results.push(row);
        runtime.close().unwrap();
    }
    assert_eq!(results[0], results[1]);
}

#[derive(Clone, Copy)]
struct PartitionCodec {
    change_rows: bool,
}
impl proseql_formats::FormatCodec for PartitionCodec {
    // Identity, not the codec's name, must decide positional compatibility.
    fn name(&self) -> &str {
        "jsonl"
    }
    fn extensions(&self) -> &[&str] {
        &["jsonl", "ndjson"]
    }
    fn encode(
        &self,
        data: &serde_json::Value,
        options: Option<proseql_formats::FormatOptions>,
    ) -> Result<String, String> {
        proseql_formats::codecs::jsonl_codec().encode(data, options)
    }
    fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
        let mut decoded = proseql_formats::codecs::jsonl_codec().decode(raw)?;
        if self.change_rows {
            let rows = decoded.as_array_mut().unwrap();
            let count = rows.len();
            for row in rows.iter_mut() {
                row["id"] = json!(format!("decoded:{}", row["id"].as_str().unwrap()));
                row["value"] = json!(row["value"].as_f64().unwrap() + count as f64);
            }
            // The codec can change cardinality and order, not just fields.
            rows.reverse();
            rows.pop();
        }
        Ok(decoded)
    }
}

fn assert_partition_codec_parity(change_rows: bool) {
    let fixture = ParityFixture::new(120);
    let open = |model| {
        let mut options = fixture.options(model);
        options
            .formats
            .register(Box::new(PartitionCodec { change_rows }));
        NativeRuntime::open_sources_with_options(fixture.config(), options).unwrap()
    };
    let resident = open(ExecutionModel::Resident);
    let streaming = open(ExecutionModel::Streaming);
    for id in [
        "steps:2025-02-03T04:00:00.000Z",
        "decoded:steps:2025-02-03T04:00:00.000Z",
        "decoded:steps:2025-01-01T00:00:00.000Z",
        "absent",
    ] {
        assert_eq!(
            resident.find_by_id(COLLECTION, id),
            streaming.find_by_id(COLLECTION, id),
            "{id}"
        );
        assert_eq!(
            resident.mutate(|mutation| mutation.find_by_id(COLLECTION, id)),
            streaming.mutate(|mutation| mutation.find_by_id(COLLECTION, id)),
            "mutation {id}"
        );
    }
    assert!(streaming
        .lazy_partition_status(SOURCE)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
    resident.close().unwrap();
    streaming.close().unwrap();
}

#[test]
fn custom_delegating_jsonl_codec_matches_resident() {
    assert_partition_codec_parity(false);
}

#[test]
fn custom_partition_transform_matches_resident_ids_values_and_cardinality() {
    assert_partition_codec_parity(true);
}

#[test]
fn custom_partition_codec_refresh_matches_fresh_resident_after_append_and_removal() {
    let fixture = ParityFixture::new(120);
    let open = |model| {
        let mut options = fixture.options(model);
        options
            .formats
            .register(Box::new(PartitionCodec { change_rows: true }));
        NativeRuntime::open_sources_with_options(fixture.config(), options).unwrap()
    };
    let runtime = open(ExecutionModel::Streaming);
    let id = "decoded:steps:2025-02-03T04:00:00.000Z";
    runtime.find_by_id(COLLECTION, id).unwrap().unwrap();
    let mut row = sample("2025-02", 1, 1, "steps");
    row["id"] = json!("external");
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(fixture.partition_path("2025-02"))
            .unwrap(),
        "{row}"
    )
    .unwrap();
    for id in [id, "decoded:external", "external"] {
        let resident = open(ExecutionModel::Resident);
        assert_eq!(
            runtime.find_by_id(COLLECTION, id),
            resident.find_by_id(COLLECTION, id)
        );
        resident.close().unwrap();
    }
    fs::remove_file(fixture.partition_path("2025-02")).unwrap();
    assert_eq!(runtime.find_by_id(COLLECTION, id).unwrap(), None);
    runtime.close().unwrap();
}
