//! Property: for every generated JSON value, YAML encode then decode returns
//! the same value (JS number semantics), at indents 2 and 4 and line widths
//! 20, 80 and 120.
//!
//! The generator is seeded and deterministic, so a failure names a seed that
//! reproduces it. Set `PROSEQL_YAML_PROPERTY_CASES` to run more cases.
//! All strings are synthetic.

#[path = "support/yaml_values.rs"]
mod yaml_values;

use proseql_formats::codecs::yaml_codec_with;
use proseql_formats::{FormatCodec, FormatOptions};
use serde_json::Value;
use yaml_values::{same, value, Rng, SPECIAL};

fn cases() -> u64 {
    std::env::var("PROSEQL_YAML_PROPERTY_CASES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1500)
}

fn check(seed: u64, value: &Value, indent: usize, width: usize) {
    let codec = yaml_codec_with(2, width);
    let encoded = codec
        .encode(
            value,
            Some(FormatOptions {
                indent: Some(indent),
            }),
        )
        .unwrap();
    let decoded = codec.decode(&encoded).unwrap_or_else(|error| {
        panic!("seed {seed} indent {indent} width {width}: does not parse: {error}\n{encoded}\nvalue: {value}")
    });
    assert!(
        same(&decoded, value),
        "seed {seed} indent {indent} width {width}: value changed\n{encoded}\nvalue:   {value}\ndecoded: {decoded}"
    );
}

#[test]
fn yaml_encode_then_decode_returns_the_same_value() {
    for seed in 0..cases() {
        let mut rng = Rng::new(seed);
        let value = value(&mut rng, 4);
        for indent in [2, 4] {
            for width in [20, 80, 120] {
                check(seed, &value, indent, width);
            }
        }
    }
}

#[test]
fn every_special_string_round_trips_in_every_position() {
    for (index, text) in SPECIAL.iter().enumerate() {
        let text = Value::String((*text).to_owned());
        let long = Value::String(format!(
            "{} {}",
            "word ".repeat(30).trim_end(),
            text.as_str().unwrap()
        ));
        let shapes = [
            text.clone(),
            serde_json::json!({ "k": text }),
            serde_json::json!({ text.as_str().unwrap(): 1 }),
            serde_json::json!([text]),
            serde_json::json!([{ "k": text, "j": text }]),
            serde_json::json!({ "items": [{ "k": long, "j": long }], "deep": [[long]] }),
        ];
        for shape in &shapes {
            for indent in [2, 4] {
                for width in [20, 80, 120] {
                    check(index as u64, shape, indent, width);
                }
            }
        }
    }
}
