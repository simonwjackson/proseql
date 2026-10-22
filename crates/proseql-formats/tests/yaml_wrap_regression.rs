//! Regression: a wrapped plain scalar must continue deeper than its key.
//!
//! The encoder used to compute the continuation indent from the prefix's
//! leading spaces. For the first key of a list-item mapping (`- food: `) that
//! put the continuation at the key's own column, so the file did not parse.
//! All strings here are synthetic.

use proseql_formats::codecs::yaml_codec;
use proseql_formats::FormatCodec;
use serde_json::{json, Value};

const LONG: &str =
    "aaaa bbbbb cccccccc ddddddddd eeeee fffffffffff gggg hhhh iiiiii jjjjj kkk lll mmmm nnnnn";

fn round_trip(value: &Value) -> String {
    let codec = yaml_codec();
    let encoded = codec.encode(value, None).unwrap();
    let decoded = codec
        .decode(&encoded)
        .unwrap_or_else(|error| panic!("encoded YAML does not parse: {error}\n{encoded}"));
    assert_eq!(&decoded, value, "round trip changed the value:\n{encoded}");
    encoded
}

#[test]
fn wrapped_first_key_of_a_list_item_round_trips() {
    let encoded = round_trip(&json!({
        "meals": {
            "meal-x": {
                "items": [{"food": LONG, "quantity": 1.0}]
            }
        }
    }));
    // The value is long enough to wrap, so the test exercises the wrapper.
    assert!(encoded.lines().count() > 5, "{encoded}");
}

#[test]
fn wrapped_later_key_of_a_list_item_round_trips() {
    round_trip(&json!({
        "meals": {
            "meal-x": {
                "items": [{"quantity": 1.0, "food": LONG}]
            }
        }
    }));
}

#[test]
fn wrapped_keys_in_nested_lists_of_objects_round_trip() {
    round_trip(&json!({
        "days": [
            {
                "meals": [
                    {"food": LONG, "items": [{"food": LONG, "note": LONG}]},
                    {"items": [{"food": LONG}], "food": LONG}
                ]
            }
        ]
    }));
}

#[test]
fn wrapped_bare_list_items_round_trip() {
    round_trip(&json!({"notes": [LONG, [LONG, [LONG]]]}));
    round_trip(&json!([LONG, {"food": LONG}]));
}

#[test]
fn wrapped_first_key_continues_at_the_same_column_as_a_later_key() {
    let encoded = round_trip(&json!({"items": [{"food": LONG, "note": LONG}]}));
    assert_eq!(
        encoded,
        "items:\n  - food: aaaa bbbbb cccccccc ddddddddd eeeee fffffffffff gggg hhhh iiiiii jjjjj\n      kkk lll mmmm nnnnn\n    note: aaaa bbbbb cccccccc ddddddddd eeeee fffffffffff gggg hhhh iiiiii jjjjj\n      kkk lll mmmm nnnnn\n"
    );
}
