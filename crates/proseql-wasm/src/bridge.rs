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
    Error { error: EngineError },
    Defect { message: String },
}

fn response_ok<T>(value: T) -> String
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

fn response_error(error: EngineError) -> String {
    serde_json::to_string(&BridgeResponse::<Value>::Error { error }).unwrap_or_else(|_| {
        "{\"kind\":\"defect\",\"message\":\"failed to serialize engine error\"}".to_owned()
    })
}

fn response_defect(message: impl Into<String>) -> String {
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
    match panic::catch_unwind(AssertUnwindSafe(f)) {
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
