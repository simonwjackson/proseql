//! Boundary value type for the proseQL engine.
//!
//! All data entering or leaving the engine across any boundary — WASM, native
//! FFI, persistence round-trips — is expressed as [`Value`].  The choice to
//! re-export `serde_json::Value` directly is deliberate:
//!
//! - JSON/JS semantics are the authoritative observable behaviour (see
//!   CLAUDE.md: "TS types are the contract; Rust implements the semantics").
//! - `serde_json::Value` is a pure-Rust serialisation primitive with no I/O
//!   dependency, satisfying the engine's platform-blind rule.
//! - Every JSON number in JS is an IEEE 754 f64; `serde_json::Number` preserves
//!   the integer/float distinction for faithful round-trips while the engine
//!   treats all `Schema.Number` fields as f64 for JS-consistent arithmetic.
//!
//! If a future boundary requires a different wire type (e.g., MessagePack), the
//! conversion lives at that boundary crate, not here.

use serde_json::Map;

/// The canonical value type used throughout the proseQL engine.
///
/// Mirrors `serde_json::Value` semantics, which in turn mirror JS observable
/// value semantics:
/// - `Null` → JSON `null`, JS `null`
/// - `Bool` → JSON `true`/`false`
/// - `Number` → JSON number (integer or float)
/// - `String` → JSON string
/// - `Array` → JSON array
/// - `Object` → JSON object (insertion-ordered map)
pub use serde_json::Value;

pub const BOUNDARY_UNDEFINED_SENTINEL_KEY: &str = "__proseqlUndefined__";
pub const BOUNDARY_INTERNAL_UNDEFINED_SENTINEL_KEY: &str = "__proseqlInternalUndefined__";
pub const BOUNDARY_ESCAPED_SENTINEL_KEY: &str = "__proseqlEscaped__";
pub const BOUNDARY_FLOAT64_SENTINEL_KEY: &str = "__proseqlFloat64__";

pub fn is_boundary_undefined(value: &Value) -> bool {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .is_some_and(|object| {
            object
                .get(BOUNDARY_UNDEFINED_SENTINEL_KEY)
                .and_then(Value::as_i64)
                == Some(1)
                || object
                    .get(BOUNDARY_INTERNAL_UNDEFINED_SENTINEL_KEY)
                    .and_then(Value::as_i64)
                    == Some(1)
        })
}

pub fn is_internal_boundary_undefined(value: &Value) -> bool {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get(BOUNDARY_INTERNAL_UNDEFINED_SENTINEL_KEY))
        .and_then(Value::as_i64)
        == Some(1)
}

fn is_boundary_escaped_entries(value: &Value) -> bool {
    value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get(BOUNDARY_ESCAPED_SENTINEL_KEY))
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry
                    .as_array()
                    .is_some_and(|pair| pair.len() == 2 && pair[0].is_string())
            })
        })
}

fn has_reserved_boundary_key(object: &Map<String, Value>) -> bool {
    object.contains_key(BOUNDARY_UNDEFINED_SENTINEL_KEY)
        || object.contains_key(BOUNDARY_ESCAPED_SENTINEL_KEY)
        || object.contains_key(BOUNDARY_FLOAT64_SENTINEL_KEY)
}

fn decode_boundary_float64(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let hex = object.get(BOUNDARY_FLOAT64_SENTINEL_KEY)?.as_str()?;
    if hex.len() != 16 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let bits = u64::from_str_radix(hex, 16).ok()?;
    let number = f64::from_bits(bits);
    let json_number = if number.is_finite()
        && number.fract() == 0.0
        && !number.is_sign_negative()
        && number.abs() < (i64::MAX as f64)
    {
        serde_json::Number::from(number as i64)
    } else {
        serde_json::Number::from_f64(number)?
    };
    Some(Value::Number(json_number))
}

pub fn decode_boundary_input_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(decode_boundary_input_value)
                .collect(),
        ),
        Value::Object(object) if is_boundary_escaped_entries(&Value::Object(object.clone())) => {
            let mut decoded = Map::new();
            if let Some(entries) = object
                .get(BOUNDARY_ESCAPED_SENTINEL_KEY)
                .and_then(Value::as_array)
            {
                for entry in entries {
                    let pair = entry.as_array().expect("validated escaped boundary entry");
                    let key = pair[0]
                        .as_str()
                        .expect("validated escaped boundary key")
                        .to_owned();
                    let item = decode_boundary_input_value(pair[1].clone());
                    decoded.insert(key, item);
                }
            }
            Value::Object(decoded)
        }
        Value::Object(object) => {
            if let Some(number) = decode_boundary_float64(&Value::Object(object.clone())) {
                number
            } else {
                Value::Object(
                    object
                        .into_iter()
                        .map(|(key, item)| (key, decode_boundary_input_value(item)))
                        .collect(),
                )
            }
        }
        other => other,
    }
}

pub fn encode_boundary_output_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(encode_boundary_output_value)
                .collect(),
        ),
        Value::Object(object) => {
            if is_internal_boundary_undefined(&Value::Object(object.clone())) {
                return Value::Object(Map::from_iter([(
                    BOUNDARY_UNDEFINED_SENTINEL_KEY.to_owned(),
                    Value::from(1),
                )]));
            }
            let encoded_entries = object
                .into_iter()
                .map(|(key, item)| {
                    let encoded = encode_boundary_output_value(item);
                    (key, encoded)
                })
                .collect::<Vec<_>>();
            let encoded_object = Value::Object(encoded_entries.iter().cloned().collect());
            let needs_escape = encoded_object.as_object().is_some_and(|object| {
                has_reserved_boundary_key(object)
                    || is_boundary_undefined(&encoded_object)
                    || is_boundary_escaped_entries(&encoded_object)
            });
            if needs_escape {
                Value::Object(Map::from_iter([(
                    BOUNDARY_ESCAPED_SENTINEL_KEY.to_owned(),
                    Value::Array(
                        encoded_entries
                            .into_iter()
                            .map(|(key, item)| Value::Array(vec![Value::String(key), item]))
                            .collect(),
                    ),
                )]))
            } else {
                encoded_object
            }
        }
        other => other,
    }
}
