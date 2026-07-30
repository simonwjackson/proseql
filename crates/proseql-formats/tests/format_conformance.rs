use proseql_formats::codecs::{
    hjson_codec, json5_codec, json_codec, jsonc_codec, jsonl_codec, prose_codec, toml_codec,
    toon_codec, yaml_codec,
};
use proseql_formats::prose::{
    compile_overflow_templates, compile_template, decode_headline, decode_overflow_lines,
    deserialize_value, encode_headline, encode_overflow_lines, jsonl_decode_lines,
    parse_directive_block, scan_directive, serialize_value,
};
use proseql_formats::{FormatCodec, FormatOptions, FormatRegistry, FormatRegistryError};
use serde_json::json;

#[test]
fn json_encode_matches_exact_default_indent_golden() {
    let codec = json_codec();
    let encoded = codec
        .encode(&json!({"id": "1", "name": "Alice"}), None)
        .unwrap();
    assert_eq!(encoded, "{\n  \"id\": \"1\",\n  \"name\": \"Alice\"\n}");
}

#[test]
fn json_encode_honors_indent_override_zero() {
    let codec = json_codec();
    let encoded = codec
        .encode(
            &json!({"a": 1, "b": 2}),
            Some(FormatOptions { indent: Some(0) }),
        )
        .unwrap();
    assert_eq!(encoded, "{\"a\":1,\"b\":2}");
}

#[test]
fn json_round_trips_nested_values() {
    let codec = json_codec();
    let value = json!({"user": {"name": "Alice", "tags": ["a", "b"]}});
    assert_eq!(
        codec.decode(&codec.encode(&value, None).unwrap()).unwrap(),
        value
    );
}

#[test]
fn yaml_supports_yaml_and_yml_extensions() {
    let codec = yaml_codec();
    assert_eq!(codec.extensions(), &["yaml", "yml"]);
}

#[test]
fn yaml_round_trips_nested_values() {
    let codec = yaml_codec();
    let value = json!({"user": {"name": "Alice", "age": 30}, "items": [1, 2]});
    assert_eq!(
        codec.decode(&codec.encode(&value, None).unwrap()).unwrap(),
        value
    );
}

#[test]
fn yaml_indent_option_reindents_nested_output() {
    let codec = yaml_codec();
    let encoded = codec
        .encode(
            &json!({"nested": {"key": "value"}}),
            Some(FormatOptions { indent: Some(4) }),
        )
        .unwrap();
    assert!(encoded.contains("    key: value"));
}

#[test]
fn toml_strips_nulls_recursively() {
    let codec = toml_codec();
    let encoded = codec
        .encode(
            &json!({"a": 1, "b": null, "nested": {"c": null, "d": [1, null, 2]}}),
            None,
        )
        .unwrap();
    let decoded = codec.decode(&encoded).unwrap();
    assert_eq!(decoded, json!({"a": 1, "nested": {"d": [1, 2]}}));
}

#[test]
fn toml_decode_maps_temporal_scalars_to_iso_strings() {
    let codec = toml_codec();
    let decoded = codec
        .decode(
            "datetime = 1979-05-27T07:32:00Z\ndate = 1979-05-27\ntime = 07:32:00\nlocal = 1979-05-27T07:32:00\n",
        )
        .unwrap();
    assert_eq!(
        decoded,
        json!({
            "datetime": "1979-05-27T07:32:00Z",
            "date": "1979-05-27",
            "time": "07:32:00",
            "local": "1979-05-27T07:32:00"
        })
    );
}

#[test]
fn toml_empty_object_matches_smol_toml_golden() {
    let codec = toml_codec();
    assert_eq!(codec.encode(&json!({}), None).unwrap(), "\n");
}

#[test]
fn toml_root_null_is_rejected() {
    let codec = toml_codec();
    let error = codec.encode(&serde_json::Value::Null, None).unwrap_err();
    assert!(error.contains("root null"), "{error}");
}

#[test]
fn json5_decodes_unquoted_keys_single_quotes_and_trailing_commas() {
    let codec = json5_codec();
    let decoded = codec.decode("{ name: 'test', value: 42, }").unwrap();
    assert_eq!(decoded, json!({"name": "test", "value": 42}));
}

#[test]
fn json5_encode_can_be_compact() {
    let codec = json5_codec();
    let encoded = codec
        .encode(&json!({"a": 1}), Some(FormatOptions { indent: Some(0) }))
        .unwrap();
    assert_eq!(encoded, "{a:1}");
}

#[test]
fn json5_decode_rejects_non_finite_numbers_but_not_same_text_in_strings_or_comments() {
    let codec = json5_codec();
    for raw in ["NaN", "Infinity", "-Infinity", "{ value: NaN }"] {
        let error = codec.decode(raw).unwrap_err();
        assert!(error.contains("non-finite"), "{raw}: {error}");
    }
    assert_eq!(
        codec.decode(r#"{ text: "NaN" }"#).unwrap(),
        json!({"text": "NaN"})
    );
    assert_eq!(
        codec.decode("// Infinity\n{ value: 1 }").unwrap(),
        json!({"value": 1})
    );
}

#[test]
fn jsonc_decodes_line_comments_block_comments_and_trailing_commas() {
    let codec = jsonc_codec();
    let raw = "{\n  // header\n  \"a\": 1,\n  /* block */\n  \"b\": 2,\n}";
    assert_eq!(codec.decode(raw).unwrap(), json!({"a": 1, "b": 2}));
}

#[test]
fn jsonc_preserves_comment_like_text_inside_strings() {
    let codec = jsonc_codec();
    let raw = r#"{
  "url": "https://example.com/path",
  "comment": "/* not a comment */",
  "slashes": "a//b"
}"#;
    assert_eq!(
        codec.decode(raw).unwrap(),
        json!({
            "url": "https://example.com/path",
            "comment": "/* not a comment */",
            "slashes": "a//b"
        })
    );
}

#[test]
fn jsonc_encode_outputs_clean_json() {
    let codec = jsonc_codec();
    let encoded = codec.encode(&json!({"a": 1}), None).unwrap();
    assert_eq!(encoded, "{\n  \"a\": 1\n}");
}

#[test]
fn hjson_decodes_hash_comments_unquoted_values_and_multiline_strings() {
    let codec = hjson_codec();
    let raw = "{\n  # comment\n  name: hello\n  text:\n    '''\n    Line 1\n    Line 2\n    '''\n}";
    let decoded = codec.decode(raw).unwrap();
    assert_eq!(decoded["name"], "hello");
    assert!(decoded["text"].as_str().unwrap().contains("Line 1"));
    assert!(decoded["text"].as_str().unwrap().contains("Line 2"));
}

#[test]
fn hjson_round_trips_common_values() {
    let codec = hjson_codec();
    let value = json!({"name": "Alice", "active": true, "items": [1, 2, 3], "nullable": null});
    assert_eq!(
        codec.decode(&codec.encode(&value, None).unwrap()).unwrap(),
        value
    );
}

#[test]
fn toon_round_trips_uniform_object_arrays() {
    let codec = toon_codec();
    let value = json!({"records": [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]});
    assert_eq!(
        codec.decode(&codec.encode(&value, None).unwrap()).unwrap(),
        value
    );
}

#[test]
fn jsonl_encodes_each_array_element_on_its_own_line() {
    let codec = jsonl_codec();
    let encoded = codec
        .encode(&json!([{"a": 1}, {"b": 2}, {"c": 3}]), None)
        .unwrap();
    assert_eq!(encoded, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}");
}

#[test]
fn jsonl_encodes_non_arrays_as_single_json_line() {
    let codec = jsonl_codec();
    let encoded = codec
        .encode(&json!({"id": "1", "name": "test"}), None)
        .unwrap();
    assert_eq!(encoded, "{\"id\":\"1\",\"name\":\"test\"}");
}

#[test]
fn jsonl_decode_skips_blank_lines() {
    let codec = jsonl_codec();
    let decoded = codec.decode("{\"a\":1}\n\n{\"b\":2}\n\n").unwrap();
    assert_eq!(decoded, json!([{"a": 1}, {"b": 2}]));
}

#[test]
fn jsonl_decode_reports_one_based_line_numbers() {
    let lines = jsonl_decode_lines("{\"id\":\"a\"}\n\n{bad json}\n{\"id\":\"c\"}");
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].line_number, 1);
    assert_eq!(lines[1].line_number, 3);
    assert!(lines[1].parse_error.is_some());
    assert_eq!(lines[2].line_number, 4);
}

#[test]
fn jsonl_decode_errors_include_line_number() {
    let codec = jsonl_codec();
    let error = codec.decode("{\"a\":1}\n{invalid json}").unwrap_err();
    assert!(error.contains("line 2"));
}

#[test]
fn registry_dispatches_and_lists_supported_extensions_in_registration_order() {
    let registry = FormatRegistry::new(vec![Box::new(json_codec()), Box::new(yaml_codec())]);
    assert_eq!(registry.supported_extensions(), &["json", "yaml", "yml"]);
    assert_eq!(
        registry.deserialize("{\"a\":1}", "json").unwrap(),
        json!({"a": 1})
    );
}

#[test]
fn registry_reports_unsupported_extensions_with_ts_shaped_error() {
    let registry = FormatRegistry::new(vec![Box::new(json_codec())]);
    match registry
        .serialize(&json!({"a": 1}), "xml", None)
        .unwrap_err()
    {
        FormatRegistryError::UnsupportedFormat(error) => {
            assert_eq!(error.format, "xml");
            assert!(error.message.contains(".xml"));
            assert!(error.message.contains(".json"));
        }
        other => panic!("expected UnsupportedFormatError, got {other:?}"),
    }
}

#[test]
fn registry_wraps_decode_errors_in_serialization_error() {
    let registry = FormatRegistry::new(vec![Box::new(json_codec())]);
    match registry.deserialize("{bad json", "json").unwrap_err() {
        FormatRegistryError::Serialization(error) => {
            assert_eq!(error.format, "json");
            assert!(error.message.contains("Failed to deserialize json data"));
        }
        other => panic!("expected SerializationError, got {other:?}"),
    }
}

#[test]
fn registry_last_registration_wins_for_duplicate_extensions() {
    let registry = FormatRegistry::new(vec![Box::new(json_codec()), Box::new(json5_codec())]);
    let encoded = registry
        .serialize(
            &json!({"a": 1}),
            "json5",
            Some(FormatOptions { indent: Some(0) }),
        )
        .unwrap();
    assert!(!encoded.contains('\n'));
}

#[test]
fn registry_duplicate_extension_uses_last_codec() {
    struct CompactJson;
    impl FormatCodec for CompactJson {
        fn name(&self) -> &str {
            "compact-json"
        }
        fn extensions(&self) -> &[&str] {
            &["json"]
        }
        fn encode(
            &self,
            data: &serde_json::Value,
            _options: Option<FormatOptions>,
        ) -> Result<String, String> {
            Ok(serde_json::to_string(data).unwrap())
        }
        fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
            serde_json::from_str(raw).map_err(|e| e.to_string())
        }
    }

    let registry = FormatRegistry::new(vec![Box::new(json_codec()), Box::new(CompactJson)]);
    assert_eq!(
        registry.serialize(&json!({"a": 1}), "json", None).unwrap(),
        "{\"a\":1}"
    );
    assert_eq!(registry.supported_extensions(), &["json"]);
}

#[test]
fn prose_serialize_value_matches_ts_shapes() {
    assert_eq!(serialize_value(&json!(null)), "~");
    assert_eq!(serialize_value(&json!(true)), "true");
    assert_eq!(serialize_value(&json!(42)), "42");
    assert_eq!(
        serialize_value(&json!(["a,b", "c]", "d\"e"])),
        "[\"a,b\", \"c]\", \"d\\\"e\"]"
    );
}

#[test]
fn prose_deserialize_value_matches_ts_heuristics() {
    assert_eq!(deserialize_value("~"), json!(null));
    assert_eq!(deserialize_value("false"), json!(false));
    assert_eq!(deserialize_value("-12.34"), json!(-12.34));
    assert_eq!(deserialize_value("[a, 2, true]"), json!(["a", 2, true]));
    assert_eq!(deserialize_value("hello"), json!("hello"));
}

#[test]
fn prose_compile_template_matches_segments_and_fields() {
    let template = compile_template("#{id} \"{title}\" by {author}").unwrap();
    assert_eq!(template.fields, vec!["id", "title", "author"]);
    assert_eq!(template.segments.len(), 6);
}

#[test]
fn prose_compile_overflow_templates_reports_indexed_errors() {
    let error = compile_overflow_templates(&["{a}{b}".to_string()]).unwrap_err();
    assert!(error.contains("index 0"));
}

#[test]
fn prose_encode_headline_quotes_only_when_delimiter_would_conflict() {
    let template = compile_template("#{id} \"{title}\" by {author}").unwrap();
    let record = json!({"id": 1, "title": "Say \"Hello\"", "author": "Tester"});
    assert_eq!(
        encode_headline(record.as_object().unwrap(), &template),
        "#1 \"Say \"Hello\"\" by Tester"
    );
}

#[test]
fn prose_decode_headline_round_trips_quoted_and_typed_values() {
    let template = compile_template("#{id} \"{title}\" ({year})").unwrap();
    let decoded = decode_headline("#1 \"Dune\" (1965)", &template).unwrap();
    assert_eq!(decoded, json!({"id": 1, "title": "Dune", "year": 1965}));
}

#[test]
fn prose_encode_overflow_lines_supports_multiline_values() {
    let templates = compile_overflow_templates(&["~ {description}".to_string()]).unwrap();
    let record = json!({"description": "Line one\nLine two\nLine three"});
    assert_eq!(
        encode_overflow_lines(record.as_object().unwrap(), &templates),
        vec!["  ~ Line one", "    Line two", "    Line three"]
    );
}

#[test]
fn prose_decode_overflow_lines_handles_continuations_and_template_matching() {
    let templates =
        compile_overflow_templates(&["tagged {tags}".to_string(), "~ {description}".to_string()])
            .unwrap();
    let result = decode_overflow_lines(
        &[
            "  tagged [sci-fi, classic]".to_string(),
            "  ~ Line one".to_string(),
            "    Line two".to_string(),
        ],
        &templates,
        2,
    );
    assert_eq!(
        result.fields,
        json!({"tags": ["sci-fi", "classic"], "description": "Line one\nLine two"})
    );
    assert_eq!(result.lines_consumed, 3);
}

#[test]
fn prose_scan_directive_requires_exact_prefix_and_single_instance() {
    let scan = scan_directive(&[
        "# Preamble".to_string(),
        "@prose {name}".to_string(),
        "Alice".to_string(),
    ])
    .unwrap();
    assert_eq!(scan.preamble_end, 0);
    assert_eq!(scan.directive_start, 1);
    let error = scan_directive(&["@prose {a}".to_string(), "@prose {b}".to_string()]).unwrap_err();
    assert!(error.contains("Multiple @prose directives"));
}

#[test]
fn prose_parse_directive_block_extracts_headline_overflow_and_body_start() {
    let block = parse_directive_block(
        &[
            "@prose #{id} {title}".to_string(),
            "  tagged {tags}".to_string(),
            "  ~ {description}".to_string(),
            "".to_string(),
            "#1 Dune".to_string(),
        ],
        0,
    );
    assert_eq!(block.headline_template, "#{id} {title}");
    assert_eq!(
        block.overflow_templates,
        vec!["tagged {tags}", "~ {description}"]
    );
    assert_eq!(block.body_start, 3);
}

#[test]
fn prose_codec_encode_matches_exact_golden_with_overflow() {
    let codec = prose_codec(
        Some("#{id} \"{title}\" by {author}".to_string()),
        vec!["tagged {tags}".to_string(), "~ {description}".to_string()],
    );
    let encoded = codec
        .encode(
            &json!([
                {
                    "id": 1,
                    "title": "Dune",
                    "author": "Frank Herbert",
                    "tags": ["sci-fi", "classic"],
                    "description": "A masterpiece"
                }
            ]),
            None,
        )
        .unwrap();
    assert_eq!(encoded, "@prose #{id} \"{title}\" by {author}\n  tagged {tags}\n  ~ {description}\n\n#1 \"Dune\" by Frank Herbert\n  tagged [sci-fi, classic]\n  ~ A masterpiece");
}

#[test]
fn prose_codec_decode_parses_records_and_ignores_passthrough() {
    let codec = prose_codec(None, vec![]);
    let decoded = codec.decode("# Books\n@prose #{id} {title}\n  ~ {description}\n\n##Sci-Fi\n#1 Dune\n  ~ A classic\n#2 Neuromancer\n  ~ Cyberpunk pioneer").unwrap();
    assert_eq!(
        decoded,
        json!([
            {"id": 1, "title": "Dune", "description": "A classic"},
            {"id": 2, "title": "Neuromancer", "description": "Cyberpunk pioneer"}
        ])
    );
}

#[test]
fn prose_codec_learns_template_on_first_decode_for_future_encode() {
    let codec = prose_codec(None, vec![]);
    let decoded = codec.decode("@prose {id}: {name}\n\na: Alice").unwrap();
    assert_eq!(decoded, json!([{"id": "a", "name": "Alice"}]));
    let reencoded = codec.encode(&decoded, None).unwrap();
    assert_eq!(reencoded, "@prose {id}: {name}\n\na: Alice");
}

#[test]
fn prose_codec_encode_requires_array_input() {
    let codec = prose_codec(Some("#{id} {name}".to_string()), vec![]);
    let error = codec.encode(&json!({"not": "array"}), None).unwrap_err();
    assert!(error.contains("expects an array"));
}

#[test]
fn prose_codec_decode_requires_directive() {
    let codec = prose_codec(Some("#{id} {name}".to_string()), vec![]);
    let error = codec.decode("no directive here\njust text").unwrap_err();
    assert!(error.contains("No @prose directive"));
}

#[test]
fn prose_codec_multiple_round_trips_are_stable() {
    let codec = prose_codec(Some("{id}: {name} ({score})".to_string()), vec![]);
    let original = json!([
        {"id": "alice", "name": "Alice", "score": 95},
        {"id": "bob", "name": "Bob", "score": 87}
    ]);
    let encoded1 = codec.encode(&original, None).unwrap();
    let decoded1 = codec.decode(&encoded1).unwrap();
    let encoded2 = codec.encode(&decoded1, None).unwrap();
    assert_eq!(decoded1, original);
    assert_eq!(encoded2, encoded1);
}

#[test]
fn json5_encode_supports_unicode_identifier_keys() {
    let codec = json5_codec();
    assert_eq!(
        codec
            .encode(
                &json!({"Δelta": 1, "ключ": 2, "$ok": 3}),
                Some(FormatOptions { indent: Some(0) }),
            )
            .unwrap(),
        "{Δelta:1,ключ:2,$ok:3}"
    );
}

#[test]
fn json5_encode_matches_runtime_golden_output() {
    let codec = json5_codec();
    assert_eq!(
        codec
            .encode(
                &json!({"a": 1, "name": "test"}),
                Some(FormatOptions { indent: Some(0) }),
            )
            .unwrap(),
        "{a:1,name:'test'}"
    );
    assert_eq!(
        codec
            .encode(
                &json!({"a": {"name": "test"}, "items": [1, "x"]}),
                Some(FormatOptions { indent: Some(4) }),
            )
            .unwrap(),
        "{\n    a: {\n        name: 'test',\n    },\n    items: [\n        1,\n        'x',\n    ],\n}"
    );
    assert_eq!(
        codec
            .encode(
                &json!({
                    "quote": "\"",
                    "apostrophe": "'",
                    "slash": "\\",
                    "line": "a\nb",
                    "tab": "a\tb"
                }),
                None,
            )
            .unwrap(),
        "{\n  quote: '\"',\n  apostrophe: \"'\",\n  slash: '\\\\',\n  line: 'a\\nb',\n  tab: 'a\\tb',\n}"
    );
}

#[test]
fn yaml_encode_indents_block_sequences_and_quotes_ambiguous_keys() {
    let codec = yaml_codec();
    assert_eq!(
        codec
            .encode(&json!({"items": [{"name": "A"}, {"name": "B"}]}), None,)
            .unwrap(),
        "items:\n  - name: A\n  - name: B\n"
    );
    assert_eq!(
        codec
            .encode(
                &json!({"true": "value", "items": [{"x": 1, "ys": [1, 2]}]}),
                None,
            )
            .unwrap(),
        "\"true\": value\nitems:\n  - x: 1\n    ys:\n      - 1\n      - 2\n"
    );
}

#[test]
fn yaml_encode_quotes_plain_scalar_indicator_and_comment_hazards() {
    let codec = yaml_codec();
    let value = json!({
        "text": "foo # bar",
        "tag": "#tag",
        "dash": "- no",
        "question": "? what",
        "foo # bar": "value",
        "#tag": "value",
        "- no": "value",
        "? what": "value"
    });
    let encoded = codec.encode(&value, None).unwrap();
    assert_eq!(
        encoded,
        "text: \"foo # bar\"\ntag: \"#tag\"\ndash: \"- no\"\nquestion: \"? what\"\n\"foo # bar\": value\n\"#tag\": value\n\"- no\": value\n\"? what\": value\n"
    );
    assert_eq!(codec.decode(&encoded).unwrap(), value);
}

#[test]
fn yaml_multiline_control_strings_encode_as_safe_quoted_scalars() {
    let codec = yaml_codec();
    let value = json!({"line": "a\n\u{0007}"});
    let encoded = codec.encode(&value, None).unwrap();
    assert_eq!(encoded, "line: \"a\\n\\a\"\n");
    assert_eq!(codec.decode(&encoded).unwrap(), value);
}

#[test]
fn yaml_encode_matches_runtime_golden_for_ambiguous_control_and_wrapped_strings() {
    let codec = yaml_codec();
    assert_eq!(
        codec
            .encode(
                &json!({
                    "yes": "yes",
                    "no": "no",
                    "nullish": "null",
                    "num": "01",
                    "bool": "true",
                    "colon": "a: b"
                }),
                None,
            )
            .unwrap(),
        "yes: yes\nno: no\nnullish: \"null\"\nnum: \"01\"\nbool: \"true\"\ncolon: \"a: b\"\n"
    );
    assert_eq!(
        codec
            .encode(
                &json!({
                    "tab": "a\tb",
                    "line": "a\nb",
                    "bell": "\u{0007}",
                    "esc": "\u{001b}"
                }),
                None,
            )
            .unwrap(),
        "tab: a\tb\nline: |-\n  a\n  b\nbell: \"\\a\"\nesc: \"\\e\"\n"
    );
    assert_eq!(
        codec
            .encode(
                &json!({
                    "text": "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
                }),
                None,
            )
            .unwrap(),
        "text: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod\n  tempor incididunt ut labore et dolore magna aliqua.\n"
    );
}

#[test]
fn toml_encode_matches_inline_array_spacing_golden() {
    let codec = toml_codec();
    assert_eq!(
        codec
            .encode(&json!({"items": [1, 2], "nested": {"items": [1, 2]}}), None)
            .unwrap(),
        "items = [ 1, 2 ]\n\n[nested]\nitems = [ 1, 2 ]\n"
    );
}

#[test]
fn jsonc_missing_value_and_extra_comma_probes_return_errors_without_panicking() {
    let codec = jsonc_codec();
    for raw in ["{\"a\":,\"b\":1}", "{\"a\":1,,\"b\":2}"] {
        assert!(codec.decode(raw).is_err(), "{raw}");
    }
}

#[test]
fn hjson_encode_matches_runtime_golden_output() {
    let codec = hjson_codec();
    assert_eq!(
        codec
            .encode(
                &json!({
                    "yes": "yes",
                    "no": "no",
                    "nullish": "null",
                    "num": "01",
                    "bool": "true",
                    "colon": "a: b"
                }),
                None,
            )
            .unwrap(),
        "{\n  yes: yes\n  no: no\n  nullish: \"null\"\n  num: 01\n  bool: \"true\"\n  colon: a: b\n}"
    );
    assert_eq!(
        codec
            .encode(
                &json!({
                    "tab": "a\tb",
                    "line": "a\nb",
                    "bell": "\u{0007}",
                    "esc": "\u{001b}"
                }),
                None,
            )
            .unwrap(),
        "{\n  tab: '''a\tb'''\n  line:\n    '''\n    a\n    b\n    '''\n  bell: \"\\u0007\"\n  esc: \"\\u001b\"\n}"
    );
    assert_eq!(
        codec
            .encode(
                &json!({"tags": ["a", "b"]}),
                Some(FormatOptions { indent: Some(4) }),
            )
            .unwrap(),
        "{\n    tags:\n    [\n        a\n        b\n    ]\n}"
    );
}

#[test]
fn invalid_prose_template_returns_error_without_panicking() {
    let codec = prose_codec(Some("{a}{b}".to_string()), vec![]);
    let error = codec.encode(&json!([]), None).unwrap_err();
    assert!(error.contains("Adjacent fields"));
}

#[test]
fn prose_object_fallback_matches_javascript_string_coercion() {
    assert_eq!(serialize_value(&json!({"a": 1})), "[object Object]");
}

#[test]
fn builtins_cover_expected_extensions() {
    let registry = FormatRegistry::with_builtins();
    assert_eq!(
        registry.supported_extensions(),
        &[
            "json", "yaml", "yml", "toml", "json5", "jsonc", "jsonl", "ndjson", "hjson", "toon",
            "prose"
        ]
    );
}
