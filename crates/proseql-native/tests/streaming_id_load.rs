mod support;
use serde_json::json;
use std::{fs, io::Write};
use support::parity::{ParityFixture, RuntimeKind, COLLECTION};

#[test]
fn candidate_decoding_matches_canonical_optional_nested_and_transformed_records() {
    use proseql_engine::descriptor::{SchemaNode, StructField};
    use proseql_native::NativeRuntime;
    for transformed in [false, true] {
        let fixture = ParityFixture::new(60);
        let path = fixture.partition_path("2025-02");
        let text = fs::read_to_string(&path).unwrap();
        let (_, suffix) = text.split_once('\n').unwrap();
        let mut row = support::parity::sample("2025-02", 1, 0, "steps");
        row["extra"] = if transformed {
            json!("42")
        } else {
            json!({"label":"escaped \"string\"", "values":[1, 2.5], "discarded":true})
        };
        row["notInSchema"] = json!({"ignored":[1, 2, 3]});
        let id = row["id"].as_str().unwrap().to_owned();
        // Duplicate JSON keys must retain last-key-wins semantics as well.
        let encoded = format!("{{\"id\":\"discarded\",{}", &row.to_string()[1..]);
        fs::write(&path, format!("{encoded}\n{suffix}")).unwrap();
        let mut config = fixture.config();
        let SchemaNode::Struct { fields } = &mut config.collections[0].descriptor.schema else {
            unreachable!()
        };
        fields.push(StructField {
            name: "extra".into(),
            schema: SchemaNode::Optional(Box::new(if transformed {
                SchemaNode::NumFromStr
            } else {
                SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "label".into(),
                            schema: SchemaNode::Str,
                        },
                        StructField {
                            name: "values".into(),
                            schema: SchemaNode::Array {
                                item: Box::new(SchemaNode::Num),
                            },
                        },
                    ],
                }
            })),
        });
        let eager = NativeRuntime::open_sources_with_options(
            config.clone(),
            fixture.options(RuntimeKind::Eager),
        )
        .unwrap();
        let lazy = NativeRuntime::open_sources_with_options(
            config.clone(),
            fixture.options(RuntimeKind::Lazy),
        )
        .unwrap();
        let expected = eager.find_by_id(COLLECTION, &id).unwrap();
        assert_eq!(lazy.find_by_id(COLLECTION, &id).unwrap(), expected);
        assert_eq!(lazy.find_by_id(COLLECTION, &id).unwrap(), expected);
        lazy.close().unwrap();
        let reopened =
            NativeRuntime::open_sources_with_options(config, fixture.options(RuntimeKind::Lazy))
                .unwrap();
        assert_eq!(reopened.find_by_id(COLLECTION, &id).unwrap(), expected);
    }
}

#[test]
fn warm_hit_still_checks_edits_duplicates_new_and_removed_files_elsewhere() {
    for change in ["invalid", "duplicate", "new", "removed", "same-length"] {
        let fixture = ParityFixture::new(60);
        let runtime = fixture.open(RuntimeKind::Lazy);
        let hit = "steps:2025-02-03T04:00:00.000Z";
        let expected = runtime.find_by_id(COLLECTION, hit).unwrap();
        assert!(expected.is_some());
        assert_eq!(runtime.find_by_id(COLLECTION, hit).unwrap(), expected);
        let other = fixture.partition_path("2025-01");
        match change {
            "invalid" | "duplicate" => {
                let mut row = support::parity::sample("2025-01", 1, 1, "steps");
                if change == "invalid" {
                    row["value"] = json!("invalid");
                } else {
                    row["id"] = json!(hit);
                }
                writeln!(
                    fs::OpenOptions::new().append(true).open(&other).unwrap(),
                    "{row}"
                )
                .unwrap();
            }
            "new" => {
                let mut row = support::parity::sample("2025-04", 1, 1, "steps");
                row["id"] = json!(hit);
                fs::write(fixture.partition_path("2025-04"), format!("{row}\n")).unwrap();
            }
            "same-length" => {
                let text = fs::read_to_string(&other).unwrap();
                fs::write(&other, text.replacen("steps:", "other:", 1)).unwrap();
            }
            _ => fs::remove_file(&other).unwrap(),
        }
        let cold = fixture.open(RuntimeKind::Lazy);
        assert_eq!(
            runtime.find_by_id(COLLECTION, hit),
            cold.find_by_id(COLLECTION, hit),
            "{change}"
        );
        if ["invalid", "duplicate", "new"].contains(&change) {
            assert!(runtime.find_by_id(COLLECTION, hit).is_err(), "{change}");
        }
    }
}
