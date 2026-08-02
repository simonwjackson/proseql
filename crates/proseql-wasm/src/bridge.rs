use std::panic::{self, AssertUnwindSafe};

use proseql_engine::{errors::EngineError, value::encode_boundary_output_value};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum BridgeResponse<T>
where
    T: Serialize,
{
    Ok { value: T },
    Error { error: Value },
    Defect { message: String },
}

pub(crate) fn response_ok<T>(value: T) -> String
where
    T: Serialize,
{
    let value = serde_json::to_value(value)
        .map(encode_boundary_output_value)
        .unwrap_or(Value::Null);
    serde_json::to_string(&BridgeResponse::Ok { value }).unwrap_or_else(|_| {
        "{\"kind\":\"defect\",\"message\":\"failed to serialize ok response\"}".to_owned()
    })
}

pub(crate) fn response_error(error: EngineError) -> String {
    let error = serde_json::to_value(error)
        .map(encode_boundary_output_value)
        .unwrap_or(Value::Null);
    serde_json::to_string(&BridgeResponse::<Value>::Error { error }).unwrap_or_else(|_| {
        "{\"kind\":\"defect\",\"message\":\"failed to serialize engine error\"}".to_owned()
    })
}

pub(crate) fn response_defect(message: impl Into<String>) -> String {
    serde_json::to_string(&BridgeResponse::<Value>::Defect {
        message: message.into(),
    })
    .unwrap_or_else(|_| {
        "{\"kind\":\"defect\",\"message\":\"failed to serialize defect\"}".to_owned()
    })
}

pub(crate) fn handle<T>(f: impl FnOnce() -> Result<T, EngineError>) -> String
where
    T: Serialize,
{
    crate::callbacks::clear_pending_callback_defect();
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    if let Some(message) = crate::callbacks::take_pending_callback_defect() {
        return response_defect(format!("unexpected defect: {message}"));
    }
    match result {
        Ok(Ok(value)) => response_ok(value),
        Ok(Err(error)) => response_error(error),
        Err(payload) => response_defect(if let Some(message) = payload.downcast_ref::<String>() {
            format!("unexpected defect: {message}")
        } else if let Some(message) = payload.downcast_ref::<&str>() {
            format!("unexpected defect: {message}")
        } else {
            "unexpected defect".to_owned()
        }),
    }
}

#[cfg(test)]
mod tests {
    use proseql_engine::errors::{EngineError, ValidationError, ValidationIssue};
    use serde_json::{json, Value};

    use super::response_error;

    #[test]
    fn typed_error_values_use_the_exact_boundary_codec() {
        let error = EngineError::Validation(ValidationError {
            message: "invalid boundary value".to_owned(),
            issues: vec![ValidationIssue {
                field: "payload".to_owned(),
                message: "invalid".to_owned(),
                value: Some(json!({
                    "explicitUndefined": {"__proseqlInternalUndefined__": 1},
                    "negativeZero": Value::from(-0.0),
                    "sparse": [
                        {"__proseqlInternalArrayHole__": 1},
                        "second"
                    ],
                    "reserved": {"__proseqlArrayHole__": 1}
                })),
                expected: None,
                received: None,
            }],
        });

        let response: Value = serde_json::from_str(&response_error(error)).unwrap();
        let value = &response["error"]["issues"][0]["value"];
        assert_eq!(
            value["explicitUndefined"],
            json!({"__proseqlUndefined__": 1})
        );
        assert!(value["negativeZero"]
            .as_f64()
            .is_some_and(f64::is_sign_negative));
        assert_eq!(value["sparse"][0], json!({"__proseqlArrayHole__": 1}));
        assert!(value["reserved"].get("__proseqlEscaped__").is_some());
    }
}
