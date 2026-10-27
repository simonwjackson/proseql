use super::validated_fixture::{ParityFixture, RuntimeKind, COLLECTION};
use super::*;
use proseql_engine::query::aggregate::AggregateConfig;
use serde_json::json;
use std::{fs, io::Write};

fn summary(
    runtime: &NativeRuntime,
    month: &str,
    proven: bool,
) -> Result<Vec<GroupResult>, EngineError> {
    let filter = json!({"atUtc":{"$gte":format!("{month}-01T00:00:00.000Z"), "$lt":format!("{month}~")}, "metric":{"$in":["steps", "heartRate"]}});
    let fields = ["dateUtc".into(), "metric".into()];
    let config = AggregateConfig {
        count: true,
        sum: vec!["value".into()],
        avg: vec!["value".into()],
        min: vec!["value".into()],
        max: vec!["value".into()],
    };
    let (ReadOutput::Grouped(groups), _) = runtime
        .streaming_read_impl(
            COLLECTION,
            ReadRequest::Grouped {
                filter: Some(&filter),
                group_by: &fields,
                config: &config,
            },
            proven,
        )
        .unwrap()?
    else {
        panic!("wrong output")
    };
    Ok(groups)
}

#[test]
fn streaming_validated_forced_on_off_answers_and_saved_restart_match() {
    let fixture = ParityFixture::new(120);
    let runtime = fixture.open(RuntimeKind::Lazy);
    for (month, _) in validated_fixture::MONTHS {
        let expected = summary(&runtime, month, false).unwrap();
        assert_eq!(summary(&runtime, month, true).unwrap(), expected);
        assert_eq!(summary(&runtime, month, false).unwrap(), expected);
    }
    runtime.close().unwrap();
    assert!(fixture.root().join(".proseql-index").is_dir());
    let runtime = fixture.open(RuntimeKind::Lazy);
    for (month, _) in validated_fixture::MONTHS {
        assert_eq!(
            summary(&runtime, month, true),
            summary(&runtime, month, false)
        );
    }
}

#[test]
fn streaming_validated_projection_forced_on_off_keeps_filter_fields_and_optional_output() {
    let fixture = ParityFixture::new(120);
    let runtime = fixture.open(RuntimeKind::Lazy);
    summary(&runtime, "2025-02", false).unwrap();
    for select in [
        json!(["value", "id", "missing"]),
        json!({"id":true,"value":true}),
    ] {
        let input = QueryInput {
            r#where: Some(
                json!({"metric":"steps", "atUtc":{"$gte":"2025-02-01T00:00:00.000Z", "$lt":"2025-03-01T00:00:00.000Z"}}),
            ),
            select: Some(select),
            limit: Some(7),
            offset: Some(3),
            ..Default::default()
        };
        let read = |proven| {
            let (ReadOutput::Rows(rows), _) = runtime
                .streaming_read_impl(
                    COLLECTION,
                    ReadRequest::Query {
                        input: &input,
                        populate: None,
                    },
                    proven,
                )
                .unwrap()
                .unwrap()
            else {
                panic!("rows")
            };
            rows
        };
        assert_eq!(read(true), read(false));
    }
}

#[test]
fn streaming_validated_unproven_invalid_filtered_out_row_keeps_exact_error() {
    let fixture = ParityFixture::new(120);
    let path = fixture.partition_path("2025-02");
    let mut row = validated_fixture::sample("2025-02", 1, 0, "excluded");
    row["value"] = json!("invalid");
    writeln!(
        fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{row}"
    )
    .unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    let error = summary(&runtime, "2025-02", false).unwrap_err();
    assert_eq!(summary(&runtime, "2025-02", true).unwrap_err(), error);
}

#[test]
fn streaming_validated_same_length_and_append_edits_invalidate_memory_and_saved_proofs() {
    for saved in [false, true] {
        for append in [false, true] {
            let fixture = ParityFixture::new(120);
            let mut runtime = fixture.open(RuntimeKind::Lazy);
            summary(&runtime, "2025-02", true).unwrap();
            if saved {
                runtime.close().unwrap();
                runtime = fixture.open(RuntimeKind::Lazy);
            }
            let path = fixture.partition_path("2025-02");
            if append {
                let mut row = validated_fixture::sample("2025-02", 1, 1, "excluded");
                row["value"] = json!("invalid");
                writeln!(
                    fs::OpenOptions::new().append(true).open(&path).unwrap(),
                    "{row}"
                )
                .unwrap();
            } else {
                let bytes = fs::read_to_string(&path).unwrap();
                let changed = bytes.replacen("\"watch\"", "false  ", 1);
                assert_ne!(bytes, changed);
                assert_eq!(bytes.len(), changed.len());
                fs::write(path, changed).unwrap();
            }
            let error = summary(&runtime, "2025-02", false).unwrap_err();
            assert_eq!(summary(&runtime, "2025-02", true).unwrap_err(), error);
        }
    }
}

#[test]
fn streaming_validated_schema_change_invalidates_every_file_proof() {
    let fixture = ParityFixture::new(120);
    let runtime = fixture.open(RuntimeKind::Lazy);
    for (month, _) in validated_fixture::MONTHS {
        summary(&runtime, month, true).unwrap();
    }
    runtime.close().unwrap();
    let mut config = fixture.config();
    let proseql_engine::descriptor::SchemaNode::Struct { fields } =
        &mut config.collections[0].descriptor.schema
    else {
        panic!("schema")
    };
    fields.push(proseql_engine::descriptor::StructField {
        name: "required".into(),
        schema: proseql_engine::descriptor::SchemaNode::Str,
    });
    let runtime =
        NativeRuntime::open_sources_with_options(config, fixture.options(RuntimeKind::Lazy))
            .unwrap();
    for (month, _) in validated_fixture::MONTHS {
        let error = summary(&runtime, month, false).unwrap_err();
        assert_eq!(summary(&runtime, month, true).unwrap_err(), error);
    }
}
