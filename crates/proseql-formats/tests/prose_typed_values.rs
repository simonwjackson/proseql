//! A Prose file must give back every value with the type it was written with.
//! Each case comes from real data that changed type on a round trip.
use proseql_formats::codecs::prose_codec;
use proseql_formats::FormatCodec;
use serde_json::{json, Value};

fn round_trip(template: &str, records: Value) -> Value {
    let codec = prose_codec(Some(template.to_owned()), vec![]);
    let encoded = codec.encode(&records, None).unwrap();
    codec.decode(&encoded).unwrap()
}

#[test]
fn a_spoken_number_in_the_last_field_stays_a_string() {
    // 2026-10-01 call, turn 209: Susan reads out a booking total.
    let records = json!([{"id": "t209", "t": "19:00", "speaker": "SV", "text": "35143"}]);
    assert_eq!(
        round_trip("[{id}] {t} {speaker}: {text}", records.clone()),
        records
    );
}

#[test]
fn strings_that_read_as_other_types_stay_strings_in_any_field() {
    let records = json!([
        {"id": "1", "a": "true", "b": "~", "c": "007"},
        {"id": "2", "a": "false", "b": "[x, y]", "c": "-3.5"},
        {"id": "3", "a": "\"quoted\"", "b": "\"open", "c": "plain"}
    ]);
    assert_eq!(
        round_trip("{id} | {a} | {b} | {c}", records.clone()),
        records
    );
}

#[test]
fn typed_values_keep_their_types() {
    let records = json!([
        {"id": "1", "n": 42, "f": -3.5, "b": true, "z": null, "tags": ["a", "42", 7]}
    ]);
    assert_eq!(
        round_trip("{id}: {n} {f} {b} {z} {tags}", records.clone()),
        records
    );
}

#[test]
fn an_array_that_contains_the_next_delimiter_keeps_its_type() {
    let records = json!([{"id": "1", "tags": ["crescent", "columbia"], "rest": "x"}]);
    assert_eq!(round_trip("{id}, {tags}, {rest}", records.clone()), records);
}

#[test]
fn a_value_that_starts_with_a_quote_survives_a_quoted_template_literal() {
    let records = json!([{"id": 1, "title": "\"Hi\" there", "author": "Liz"}]);
    assert_eq!(
        round_trip("#{id} \"{title}\" by {author}", records.clone()),
        records
    );
}

#[test]
fn a_number_that_contains_the_next_delimiter_fails_to_encode() {
    let codec = prose_codec(Some("{a}.{b}".to_owned()), vec![]);
    let error = codec
        .encode(&json!([{"a": 3.25, "b": "x"}]), None)
        .unwrap_err();
    assert!(error.contains("field 'a'"), "{error}");
}
