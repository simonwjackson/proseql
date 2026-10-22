//! The registry's write check refuses YAML that does not read back.
//!
//! `BrokenYaml` wraps the real codec and damages its output when a string
//! holds a marker, the way the old wrapping bug did. All data is synthetic.

use proseql_formats::codecs::yaml_codec;
use proseql_formats::{
    FormatCodec, FormatOptions, FormatRegistry, FormatRegistryError, ROUND_TRIP_MISMATCH,
};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
enum Damage {
    /// Put a folded line at its key's column: the file does not parse.
    Unparseable,
    /// Write a different value: the file parses but reads back wrong.
    WrongValue,
}

struct BrokenYaml {
    damage: Damage,
    exact: bool,
}

impl FormatCodec for BrokenYaml {
    fn name(&self) -> &str {
        "yaml"
    }

    fn extensions(&self) -> &[&str] {
        &["yaml", "yml"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        let encoded = yaml_codec().encode(data, options)?;
        if !encoded.contains("BREAK") {
            return Ok(encoded);
        }
        Ok(match self.damage {
            Damage::Unparseable => encoded.replace("BREAK", "first\n    folded at the key column"),
            Damage::WrongValue => encoded.replace("BREAK", "changed"),
        })
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        yaml_codec().decode(raw)
    }

    fn round_trips_exactly(&self) -> bool {
        self.exact
    }
}

fn registry(damage: Damage, exact: bool) -> FormatRegistry {
    let mut formats = FormatRegistry::with_builtins();
    formats.register(Box::new(BrokenYaml { damage, exact }));
    formats
}

fn meal(food: &str) -> Value {
    json!({"meals": {"meal-x": {"items": [{"food": food, "quantity": 1.0}]}}})
}

fn refused(error: FormatRegistryError) -> (String, Value) {
    let FormatRegistryError::Serialization(error) = error else {
        panic!("expected SerializationError, got {error:?}");
    };
    assert_eq!(error.format, "yaml");
    assert!(
        error.message.starts_with("Refused to write yaml"),
        "{}",
        error.message
    );
    let cause = error.cause.expect("cause");
    assert_eq!(cause["reason"], ROUND_TRIP_MISMATCH);
    (error.message, cause)
}

#[test]
fn unparseable_output_is_refused() {
    let error = registry(Damage::Unparseable, true)
        .serialize(&meal("BREAK"), "yaml", None)
        .unwrap_err();
    let (message, cause) = refused(error);
    assert!(message.contains("decode failed"), "{message}");
    assert!(cause.get("pointer").is_none());
}

#[test]
fn output_that_reads_back_as_another_value_is_refused_with_its_location() {
    let error = registry(Damage::WrongValue, true)
        .serialize(&meal("BREAK"), "yml", None)
        .unwrap_err();
    let (message, cause) = refused(error);
    assert_eq!(cause["pointer"], "/meals/meal-x/items/0/food");
    assert!(message.contains("/meals/meal-x/items/0/food"), "{message}");
    // The error names where, never what: values can be private.
    assert!(!message.contains("BREAK") && !message.contains("changed"));
}

#[test]
fn good_output_passes_unchanged() {
    let formats = registry(Damage::WrongValue, true);
    let value = meal("oats");
    assert_eq!(
        formats.serialize(&value, "yaml", None).unwrap(),
        yaml_codec().encode(&value, None).unwrap()
    );
}

#[test]
fn codecs_without_an_exact_round_trip_are_not_checked() {
    let encoded = registry(Damage::WrongValue, false)
        .serialize(&meal("BREAK"), "yaml", None)
        .unwrap();
    assert!(encoded.contains("changed"));
}

#[test]
fn the_check_can_be_turned_off() {
    let mut formats = registry(Damage::Unparseable, true);
    assert!(formats.write_check());
    formats.set_write_check(false);
    assert!(formats
        .serialize(&meal("BREAK"), "yaml", None)
        .unwrap()
        .contains("folded at the key column"));
}

#[test]
fn the_builtin_yaml_codec_is_checked_and_json_number_forms_compare_as_js_numbers() {
    assert!(yaml_codec().round_trips_exactly());
    let formats = FormatRegistry::with_builtins();
    // 1 and 1.0 are the same JS number; the check must not refuse them.
    for value in [
        json!({"a": 1.0, "b": 1, "c": -0.0, "d": 1e21}),
        json!([1.5, 2]),
    ] {
        formats.serialize(&value, "yaml", None).unwrap();
    }
}
