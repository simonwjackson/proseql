//! Effect beta.103 check representations. Hosts register predicates for checks
//! without a platform-blind implementation (including JS RegExp in WASM).
use crate::{
    callbacks::CallbackRegistry,
    descriptor::{SchemaCheck, SchemaNode},
    errors::{EngineError, ValidationError, ValidationIssue},
    value::Value,
};

#[inline(never)]
fn unsupported(reason: String) -> EngineError {
    EngineError::Validation(ValidationError {
        message: reason.clone(),
        issues: vec![ValidationIssue {
            field: "(root)".into(),
            message: reason,
            value: None,
            expected: None,
            received: None,
        }],
    })
}

/// Check all host references before opening, even for empty collections.
#[inline(never)]
pub fn validate_schema_checks(
    schema: &SchemaNode,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    validate_schema_checks_with_callbacks(schema, Some(callbacks))
}

pub(crate) fn validate_schema_checks_with_callbacks(
    schema: &SchemaNode,
    callbacks: Option<&CallbackRegistry>,
) -> Result<(), EngineError> {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            validate_schema_checks_with_callbacks(inner, callbacks)?;
            for check in checks {
                if let Some(id) = check.callback_id() {
                    if !callbacks.is_some_and(|registry| registry.has_predicate(id)) {
                        return Err(unsupported(format!(
                            "Schema check predicate '{id}' is not registered"
                        )));
                    }
                } else {
                    validate_builtin(check)?;
                }
            }
        }
        SchemaNode::Struct { fields } => {
            for field in fields {
                validate_schema_checks_with_callbacks(&field.schema, callbacks)?;
            }
        }
        SchemaNode::Array { item: inner }
        | SchemaNode::Optional(inner)
        | SchemaNode::NullOr(inner)
        | SchemaNode::OptionalWithDefault { inner, .. } => {
            validate_schema_checks_with_callbacks(inner, callbacks)?
        }
        SchemaNode::Record { key, value } => {
            validate_schema_checks_with_callbacks(key, callbacks)?;
            validate_schema_checks_with_callbacks(value, callbacks)?;
        }
        SchemaNode::Unsupported { reason } => {
            return Err(unsupported(format!(
                "Unsupported schema combinator: {reason}"
            )))
        }
        _ => {}
    }
    Ok(())
}

#[cfg(not(feature = "native-checks"))]
fn validate_builtin(check: &SchemaCheck) -> Result<(), EngineError> {
    Err(unsupported(format!(
        "Schema check '{}' requires native-checks or a registered host predicate",
        check.id()
    )))
}

#[cfg(feature = "native-checks")]
fn validate_builtin(check: &SchemaCheck) -> Result<(), EngineError> {
    let fields: &[&str] = match check.id() {
        "effect/schema/isMinLength" => &["minLength"],
        "effect/schema/isMaxLength" => &["maxLength"],
        "effect/schema/isMinSize" => &["minSize"],
        "effect/schema/isMaxSize" => &["maxSize"],
        "effect/schema/isLengthBetween"
        | "effect/schema/isSizeBetween"
        | "effect/schema/isBetween" => &["minimum", "maximum"],
        "effect/schema/isGreaterThan" => &["exclusiveMinimum"],
        "effect/schema/isGreaterThanOrEqualTo" => &["minimum"],
        "effect/schema/isLessThan" => &["exclusiveMaximum"],
        "effect/schema/isLessThanOrEqualTo" => &["maximum"],
        "effect/schema/isMultipleOf" => &["divisor"],
        "effect/schema/isStartsWith" | "effect/schema/isEndsWith" | "effect/schema/isIncludes" => {
            let key = match check.id() {
                "effect/schema/isStartsWith" => "startsWith",
                "effect/schema/isEndsWith" => "endsWith",
                _ => "includes",
            };
            if check.payload()[key].is_string() {
                return Ok(());
            }
            return Err(unsupported(format!(
                "Invalid payload for schema check '{}'",
                check.id()
            )));
        }
        "effect/schema/isInt"
        | "effect/schema/isTrimmed"
        | "effect/schema/isLowercased"
        | "effect/schema/isUppercased"
        | "effect/schema/isCapitalized"
        | "effect/schema/isUncapitalized"
        | "effect/schema/isULID" => &[],
        "effect/schema/isUUID" => {
            let version = &check.payload()["version"];
            if version.is_null() || version.as_u64().is_some_and(|v| (1..=8).contains(&v)) {
                return Ok(());
            }
            return Err(unsupported("Invalid UUID version".into()));
        }
        "effect/schema/isPattern" => {
            #[cfg(feature = "ecmascript-regex")]
            {
                pattern(check)?;
                return Ok(());
            }
            #[cfg(not(feature = "ecmascript-regex"))]
            return Err(unsupported(
                "isPattern requires the ecmascript-regex feature or a registered host predicate"
                    .into(),
            ));
        }
        _ => {
            return Err(unsupported(format!(
                "Unsupported schema check '{}' without a host predicate",
                check.id()
            )))
        }
    };
    if fields
        .iter()
        .all(|field| check.payload()[field].as_f64().is_some_and(f64::is_finite))
    {
        Ok(())
    } else {
        Err(unsupported(format!(
            "Invalid payload for schema check '{}'",
            check.id()
        )))
    }
}

#[cfg(feature = "ecmascript-regex")]
fn pattern(check: &SchemaCheck) -> Result<regress::Regex, EngineError> {
    let source = check.payload()["source"]
        .as_str()
        .ok_or_else(|| unsupported("isPattern missing source".into()))?;
    let flags = check.payload()["flags"]
        .as_str()
        .ok_or_else(|| unsupported("isPattern missing flags".into()))?;
    let regex = if flags.contains('u') || flags.contains('v') {
        regress::Regex::with_flags(source, flags)
    } else {
        regress::Regex::from_unicode(source.encode_utf16().map(u32::from), flags)
    };
    regex.map_err(|error| unsupported(format!("Invalid schema pattern: {error}")))
}

#[inline(never)]
pub(crate) fn validate_checks(
    checks: &[SchemaCheck],
    value: &Value,
    callbacks: Option<&CallbackRegistry>,
) -> Result<(), EngineError> {
    for check in checks {
        let accepted = if let Some(id) = check.callback_id() {
            callbacks
                .and_then(|registry| registry.invoke_predicate(id, value))
                .ok_or_else(|| {
                    unsupported(format!("Schema check predicate '{id}' is not registered"))
                })?
        } else {
            validate_builtin(check)?;
            evaluate(check, value)
        };
        if !accepted {
            // Effect's default parse options return the first failed check.
            let message = check
                .callback_id()
                .and_then(|id| callbacks.and_then(|registry| registry.invoke_default(id)))
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("Expected {}", check.expected()));
            return Err(unsupported(message));
        }
    }
    Ok(())
}

#[cfg(not(feature = "native-checks"))]
fn evaluate(_: &SchemaCheck, _: &Value) -> bool {
    false
}

#[cfg(feature = "native-checks")]
fn evaluate(check: &SchemaCheck, value: &Value) -> bool {
    let p = check.payload();
    let n = |key: &str| p[key].as_f64().unwrap_or(f64::NAN);
    let text = value.as_str().unwrap_or("");
    let number = value.as_f64().unwrap_or(f64::NAN);
    let length = value
        .as_array()
        .map(|a| a.len())
        .or_else(|| value.as_str().map(|s| s.encode_utf16().count()))
        .map(|n| n as f64)
        .unwrap_or(f64::NAN);
    // Sets cross the JSON boundary as arrays. Size checks use their cardinality.
    let size = value.as_array().map(|a| a.len() as f64).unwrap_or(f64::NAN);
    match check.id() {
        "effect/schema/isMinLength" => length >= n("minLength"),
        "effect/schema/isMaxLength" => length <= n("maxLength"),
        "effect/schema/isLengthBetween" => length >= n("minimum") && length <= n("maximum"),
        "effect/schema/isMinSize" => size >= n("minSize"),
        "effect/schema/isMaxSize" => size <= n("maxSize"),
        "effect/schema/isSizeBetween" => size >= n("minimum") && size <= n("maximum"),
        "effect/schema/isGreaterThan" => number > n("exclusiveMinimum"),
        "effect/schema/isGreaterThanOrEqualTo" => number >= n("minimum"),
        "effect/schema/isLessThan" => number < n("exclusiveMaximum"),
        "effect/schema/isLessThanOrEqualTo" => number <= n("maximum"),
        "effect/schema/isBetween" => {
            (if p["exclusiveMinimum"] == true {
                number > n("minimum")
            } else {
                number >= n("minimum")
            }) && (if p["exclusiveMaximum"] == true {
                number < n("maximum")
            } else {
                number <= n("maximum")
            })
        }
        "effect/schema/isInt" => number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0,
        "effect/schema/isMultipleOf" => multiple_of(number, n("divisor")),
        "effect/schema/isStartsWith" => text.starts_with(p["startsWith"].as_str().unwrap_or("")),
        "effect/schema/isEndsWith" => text.ends_with(p["endsWith"].as_str().unwrap_or("")),
        "effect/schema/isIncludes" => text.contains(p["includes"].as_str().unwrap_or("")),
        "effect/schema/isTrimmed" => text.trim_matches(js_whitespace) == text,
        "effect/schema/isLowercased" => text.to_lowercase() == text,
        "effect/schema/isUppercased" => text.to_uppercase() == text,
        "effect/schema/isCapitalized" => text
            .chars()
            .next()
            .is_none_or(|c| c.len_utf16() == 2 || c.to_string().to_uppercase() == c.to_string()),
        "effect/schema/isUncapitalized" => text
            .chars()
            .next()
            .is_none_or(|c| c.len_utf16() == 2 || c.to_string().to_lowercase() == c.to_string()),
        "effect/schema/isULID" => {
            text.len() == 26
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() && !b"ILOUilou".contains(&b))
        }
        "effect/schema/isUUID" => uuid(text, p["version"].as_u64()),
        "effect/schema/isPattern" => {
            #[cfg(feature = "ecmascript-regex")]
            {
                pattern(check).is_ok_and(|regex| {
                    let flags = p["flags"].as_str().unwrap_or("");
                    let units = text.encode_utf16().collect::<Vec<_>>();
                    let matched = if flags.contains('u') || flags.contains('v') {
                        regex.find_from_utf16(&units, 0).next()
                    } else {
                        regex.find_from_ucs2(&units, 0).next()
                    };
                    matched.is_some_and(|matched| !flags.contains('y') || matched.start() == 0)
                })
            }
            #[cfg(not(feature = "ecmascript-regex"))]
            {
                false
            }
        }
        _ => false,
    }
}

#[cfg(feature = "native-checks")]
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(feature = "native-checks")]
fn uuid(text: &str, version: Option<u64>) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return false;
    }
    if version.is_none()
        && (bytes.iter().all(|b| *b == b'0' || *b == b'-')
            || bytes
                .iter()
                .all(|b| b.eq_ignore_ascii_case(&b'f') || *b == b'-'))
    {
        return true;
    }
    (match version {
        Some(v) => bytes[14] == b'0' + v as u8,
        None => (b'1'..=b'8').contains(&bytes[14]),
    }) && b"89aAbB".contains(&bytes[19])
}

#[cfg(feature = "native-checks")]
fn multiple_of(value: f64, divisor: f64) -> bool {
    if !value.is_finite() || !divisor.is_finite() || divisor == 0.0 {
        return false;
    }
    // Effect uses decimal coefficients (BigInt for scientific notation), not
    // binary floating-point remainder. The shortest f64 decimal has <=17 digits.
    fn decimal(value: f64) -> (u128, i32) {
        let text = value.abs().to_string();
        let (mantissa, exponent) = text
            .split_once('e')
            .map_or((text.as_str(), 0), |(m, e)| (m, e.parse().unwrap_or(0)));
        let decimals = mantissa.split_once('.').map_or(0, |(_, tail)| tail.len()) as i32;
        let digits = mantissa.replace('.', "");
        let trimmed = digits.trim_end_matches('0');
        let zeros = digits.len() - trimmed.len();
        (
            trimmed.parse().unwrap_or(0),
            exponent - decimals + zeros as i32,
        )
    }
    let (a, ae) = decimal(value);
    let (b, be) = decimal(divisor);
    if a == 0 {
        return true;
    }
    if ae < be {
        let distance = (be - ae) as u32;
        return distance <= 17 && a % (b * 10_u128.pow(distance)) == 0;
    }
    let mut remainder = a % b;
    for _ in 0..(ae - be) {
        remainder = (remainder * 10) % b;
    }
    remainder == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validator::{
        decode_owned_value, decode_value, decode_value_with_callbacks, validate_value,
    };
    use serde_json::json;

    fn checked(id: &str, payload: Value, inner: SchemaNode) -> SchemaNode {
        SchemaNode::Checked {
            inner: Box::new(inner),
            checks: vec![SchemaCheck::new(
                format!("effect/schema/{id}"),
                payload,
                "the check to pass",
                None,
            )],
        }
    }

    macro_rules! case {
        ($name:ident, $id:literal, $payload:expr, $inner:expr, $valid:expr, $invalid:expr) => {
            #[cfg(feature = "native-checks")]
            #[test]
            fn $name() {
                let schema = checked($id, $payload, $inner);
                let valid = $valid;
                let invalid = $invalid;
                assert!(decode_value(&schema, &valid).is_ok());
                assert!(decode_owned_value(&schema, valid.clone()).is_ok());
                assert!(validate_value(&schema, &valid).is_ok());
                assert!(decode_value(&schema, &invalid).is_err());
                assert!(decode_owned_value(&schema, invalid.clone()).is_err());
                assert!(validate_value(&schema, &invalid).is_err());
            }
        };
    }
    case!(
        min_length,
        "isMinLength",
        json!({"minLength":3}),
        SchemaNode::Str,
        json!("abc"),
        json!("ab")
    );
    case!(
        max_length,
        "isMaxLength",
        json!({"maxLength":2}),
        SchemaNode::Str,
        json!("😀"),
        json!("abc")
    );
    case!(
        length_between,
        "isLengthBetween",
        json!({"minimum":2,"maximum":3}),
        SchemaNode::Str,
        json!("ab"),
        json!("a")
    );
    case!(
        greater,
        "isGreaterThan",
        json!({"exclusiveMinimum":2}),
        SchemaNode::Num,
        json!(3),
        json!(2)
    );
    case!(
        greater_equal,
        "isGreaterThanOrEqualTo",
        json!({"minimum":2}),
        SchemaNode::Num,
        json!(2),
        json!(1)
    );
    case!(
        less,
        "isLessThan",
        json!({"exclusiveMaximum":2}),
        SchemaNode::Num,
        json!(1),
        json!(2)
    );
    case!(
        less_equal,
        "isLessThanOrEqualTo",
        json!({"maximum":2}),
        SchemaNode::Num,
        json!(2),
        json!(3)
    );
    case!(
        between,
        "isBetween",
        json!({"minimum":1,"maximum":3,"exclusiveMinimum":true,"exclusiveMaximum":true}),
        SchemaNode::Num,
        json!(2),
        json!(3)
    );
    case!(
        integer,
        "isInt",
        Value::Null,
        SchemaNode::Num,
        json!(1),
        json!(9007199254740992_f64)
    );
    case!(
        multiple,
        "isMultipleOf",
        json!({"divisor":0.1}),
        SchemaNode::Num,
        json!(0.3),
        json!(0.31)
    );
    case!(
        uuid_check,
        "isUUID",
        json!({"version":4}),
        SchemaNode::Str,
        json!("550e8400-e29b-41d4-a716-446655440000"),
        json!("550e8400-e29b-11d4-a716-446655440000")
    );
    case!(
        ulid,
        "isULID",
        Value::Null,
        SchemaNode::Str,
        json!("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        json!("01ARZ3NDEKTSV4RRFFQ69G5FAI")
    );
    case!(
        trimmed,
        "isTrimmed",
        Value::Null,
        SchemaNode::Str,
        json!("abc"),
        json!("\u{feff}abc")
    );
    case!(
        lowercase,
        "isLowercased",
        Value::Null,
        SchemaNode::Str,
        json!("àbc"),
        json!("Àbc")
    );
    case!(
        uppercase,
        "isUppercased",
        Value::Null,
        SchemaNode::Str,
        json!("ÀBC"),
        json!("àBC")
    );
    case!(
        capitalized,
        "isCapitalized",
        Value::Null,
        SchemaNode::Str,
        json!("Àbc"),
        json!("àbc")
    );
    case!(
        uncapitalized,
        "isUncapitalized",
        Value::Null,
        SchemaNode::Str,
        json!("àBC"),
        json!("Àbc")
    );
    case!(
        starts_with,
        "isStartsWith",
        json!({"startsWith":"ab"}),
        SchemaNode::Str,
        json!("abc"),
        json!("cab")
    );
    case!(
        ends_with,
        "isEndsWith",
        json!({"endsWith":"ab"}),
        SchemaNode::Str,
        json!("cab"),
        json!("abc")
    );
    case!(
        includes,
        "isIncludes",
        json!({"includes":"ab"}),
        SchemaNode::Str,
        json!("cabc"),
        json!("acb")
    );
    case!(
        min_size,
        "isMinSize",
        json!({"minSize":2}),
        SchemaNode::Array {
            item: Box::new(SchemaNode::Num)
        },
        json!([1, 2]),
        json!([1])
    );
    case!(
        max_size,
        "isMaxSize",
        json!({"maxSize":2}),
        SchemaNode::Array {
            item: Box::new(SchemaNode::Num)
        },
        json!([1, 2]),
        json!([1, 2, 3])
    );
    case!(
        size_between,
        "isSizeBetween",
        json!({"minimum":1,"maximum":2}),
        SchemaNode::Array {
            item: Box::new(SchemaNode::Num)
        },
        json!([1, 2]),
        json!([])
    );

    #[cfg(feature = "ecmascript-regex")]
    #[test]
    fn ecmascript_pattern_matrix() {
        // The engine host test runs this same matrix with JS RegExp.
        for (source, flags, valid, invalid) in [
            ("(?<=a)b", "", "ab", "cb"),
            (r"^(a)\1$", "", "aa", "ab"),
            ("^hello$", "i", "HELLO", "world"),
            ("^.$", "u", "😀", "ab"),
            ("^a.b$", "s", "a\nb", "ab"),
            ("a", "y", "abc", "ba"),
            ("a", "g", "ba", "bc"),
            ("^.$", "", "a", "😀"),
            ("^😀$", "", "😀", "a"),
        ] {
            let schema = checked(
                "isPattern",
                json!({"source":source,"flags":flags}),
                SchemaNode::Str,
            );
            assert!(
                decode_value(&schema, &json!(valid)).is_ok(),
                "{source}/{flags}"
            );
            assert!(
                decode_value(&schema, &json!(invalid)).is_err(),
                "{source}/{flags}"
            );
        }
    }

    #[test]
    fn host_predicates_are_required_at_open_and_enforced() {
        let mut schema = checked("custom", Value::Null, SchemaNode::Str);
        if let SchemaNode::Checked { checks, .. } = &mut schema {
            checks[0] = SchemaCheck::new(
                "custom",
                Value::Null,
                "the check to pass",
                Some("custom".into()),
            );
        }
        let mut registry = CallbackRegistry::new();
        assert!(validate_schema_checks(&schema, &registry).is_err());
        registry.register_predicate("custom", Box::new(|v| v == "allowed"));
        assert!(validate_schema_checks(&schema, &registry).is_ok());
        assert!(decode_value_with_callbacks(&schema, &json!("allowed"), Some(&registry)).is_ok());
        assert!(decode_value_with_callbacks(&schema, &json!("blocked"), Some(&registry)).is_err());
    }

    #[test]
    fn unknown_and_malformed_checks_fail_at_open() {
        let registry = CallbackRegistry::new();
        assert!(validate_schema_checks(
            &checked("unknown", Value::Null, SchemaNode::Str),
            &registry
        )
        .is_err());
        assert!(validate_schema_checks(
            &checked("isMinLength", json!({"minLength":"3"}), SchemaNode::Str),
            &registry
        )
        .is_err());
    }

    #[test]
    fn empty_checks_keep_descriptor_bytes_unchanged() {
        let schema = SchemaNode::Checked {
            inner: Box::new(SchemaNode::Str),
            checks: vec![],
        };
        assert_eq!(
            serde_json::to_string(&schema).unwrap(),
            serde_json::to_string(&SchemaNode::Str).unwrap()
        );
    }
}
