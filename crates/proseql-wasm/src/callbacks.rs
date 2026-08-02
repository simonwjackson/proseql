use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::errors::EngineError;
#[cfg(target_arch = "wasm32")]
use proseql_engine::errors::OperationError;
use proseql_engine::hooks::{
    AfterCreateContext, AfterDeleteContext, AfterUpdateContext, BeforeCreateContext,
    BeforeDeleteContext, BeforeUpdateContext, OnChangeContext,
};
use proseql_engine::id_gen::IdGenerator;
#[cfg(target_arch = "wasm32")]
use proseql_engine::value::{decode_boundary_input_value, encode_boundary_output_value};
#[cfg(target_arch = "wasm32")]
use serde::Serialize;
#[cfg(target_arch = "wasm32")]
use serde_json::json;
use serde_json::{Map, Value};

pub type DefaultCallback = Arc<dyn Fn() -> Value + Send + Sync>;
pub type PredicateCallback = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub type ComputedCallback = Arc<dyn Fn(&Value) -> Value + Send + Sync>;
pub type StringCollatorCallback = Arc<dyn Fn(&str, &str) -> Ordering + Send + Sync>;
pub type MigrationCallback =
    Arc<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError> + Send + Sync>;
pub type IdGeneratorFactory = Arc<dyn Fn() -> Box<dyn IdGenerator> + Send + Sync>;
pub type LifecycleCallback = Arc<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
pub type CodecEncodeCallback =
    Arc<dyn Fn(&Value, Option<usize>) -> Result<String, EngineError> + Send + Sync>;
pub type CodecDecodeCallback = Arc<dyn Fn(&str) -> Result<Value, EngineError> + Send + Sync>;
pub type BeforeCreateHook =
    Arc<dyn Fn(&BeforeCreateContext) -> Result<Value, EngineError> + Send + Sync>;
pub type BeforeUpdateHook =
    Arc<dyn Fn(&BeforeUpdateContext) -> Result<Value, EngineError> + Send + Sync>;
pub type BeforeDeleteHook =
    Arc<dyn Fn(&BeforeDeleteContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterCreateHook =
    Arc<dyn Fn(&AfterCreateContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterUpdateHook =
    Arc<dyn Fn(&AfterUpdateContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterDeleteHook =
    Arc<dyn Fn(&AfterDeleteContext) -> Result<(), EngineError> + Send + Sync>;
pub type OnChangeHook = Arc<dyn Fn(&OnChangeContext) -> Result<(), EngineError> + Send + Sync>;
pub type CustomOperatorCallback = Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>;

#[derive(Default)]
pub struct CallbackTable {
    defaults: HashMap<String, DefaultCallback>,
    predicates: HashMap<String, PredicateCallback>,
    computed: HashMap<String, ComputedCallback>,
    collator: Option<StringCollatorCallback>,
    migrations: HashMap<String, MigrationCallback>,
    before_create_hooks: HashMap<String, BeforeCreateHook>,
    before_update_hooks: HashMap<String, BeforeUpdateHook>,
    before_delete_hooks: HashMap<String, BeforeDeleteHook>,
    after_create_hooks: HashMap<String, AfterCreateHook>,
    after_update_hooks: HashMap<String, AfterUpdateHook>,
    after_delete_hooks: HashMap<String, AfterDeleteHook>,
    on_change_hooks: HashMap<String, OnChangeHook>,
    custom_operators: HashMap<String, (Vec<String>, CustomOperatorCallback)>,
    id_generators: HashMap<String, IdGeneratorFactory>,
    lifecycle_callbacks: HashMap<String, LifecycleCallback>,
    codec_encode_callbacks: HashMap<String, CodecEncodeCallback>,
    codec_decode_callbacks: HashMap<String, CodecDecodeCallback>,
}

impl CallbackTable {
    pub fn register_default(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn() -> Value + Send + Sync + 'static,
    ) {
        self.defaults.insert(id.into(), Arc::new(callback));
    }

    pub fn register_predicate(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&Value) -> bool + Send + Sync + 'static,
    ) {
        self.predicates.insert(id.into(), Arc::new(callback));
    }

    pub fn register_computed(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) {
        self.computed.insert(id.into(), Arc::new(callback));
    }

    pub fn register_collator(
        &mut self,
        callback: impl Fn(&str, &str) -> Ordering + Send + Sync + 'static,
    ) {
        self.collator = Some(Arc::new(callback));
    }

    pub fn register_migration(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError>
            + Send
            + Sync
            + 'static,
    ) {
        self.migrations.insert(id.into(), Arc::new(callback));
    }

    pub fn register_id_generator(
        &mut self,
        name: impl Into<String>,
        factory: impl Fn() -> Box<dyn IdGenerator> + Send + Sync + 'static,
    ) {
        self.id_generators.insert(name.into(), Arc::new(factory));
    }

    pub fn register_lifecycle(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn() -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.lifecycle_callbacks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_codec_encode(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&Value, Option<usize>) -> Result<String, EngineError> + Send + Sync + 'static,
    ) {
        self.codec_encode_callbacks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_codec_decode(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&str) -> Result<Value, EngineError> + Send + Sync + 'static,
    ) {
        self.codec_decode_callbacks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_before_create_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&BeforeCreateContext) -> Result<Value, EngineError> + Send + Sync + 'static,
    ) {
        self.before_create_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_before_update_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&BeforeUpdateContext) -> Result<Value, EngineError> + Send + Sync + 'static,
    ) {
        self.before_update_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_before_delete_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&BeforeDeleteContext) -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.before_delete_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_after_create_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&AfterCreateContext) -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.after_create_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_after_update_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&AfterUpdateContext) -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.after_update_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_after_delete_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&AfterDeleteContext) -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.after_delete_hooks
            .insert(id.into(), Arc::new(callback));
    }

    pub fn register_on_change_hook(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(&OnChangeContext) -> Result<(), EngineError> + Send + Sync + 'static,
    ) {
        self.on_change_hooks.insert(id.into(), Arc::new(callback));
    }

    pub fn register_custom_operator(
        &mut self,
        name: impl Into<String>,
        supported_types: Vec<String>,
        callback: impl Fn(&Value, &Value) -> bool + Send + Sync + 'static,
    ) {
        self.custom_operators
            .insert(name.into(), (supported_types, Arc::new(callback)));
    }

    pub(crate) fn build_registry(&self) -> CallbackRegistry {
        let mut registry = CallbackRegistry::new();
        #[cfg(target_arch = "wasm32")]
        registry.register_callback_abort_probe(callback_defect_pending);
        for (id, callback) in &self.defaults {
            let callback = Arc::clone(callback);
            registry.register_default(id.clone(), Box::new(move || callback()));
        }
        for (id, callback) in &self.predicates {
            let callback = Arc::clone(callback);
            registry.register_predicate(id.clone(), Box::new(move |value| callback(value)));
        }
        for (id, callback) in &self.computed {
            let callback = Arc::clone(callback);
            registry.register_computed(id.clone(), Box::new(move |value| callback(value)));
        }
        if let Some(collator) = &self.collator {
            let collator = Arc::clone(collator);
            registry.register_collator(Box::new(move |a, b| collator(a, b)));
        }
        for (id, callback) in &self.migrations {
            let callback = Arc::clone(callback);
            registry.register_migration(id.clone(), Box::new(move |data| callback(data)));
        }
        for (id, callback) in &self.before_create_hooks {
            let callback = Arc::clone(callback);
            registry.register_before_create_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.before_update_hooks {
            let callback = Arc::clone(callback);
            registry.register_before_update_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.before_delete_hooks {
            let callback = Arc::clone(callback);
            registry.register_before_delete_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.after_create_hooks {
            let callback = Arc::clone(callback);
            registry.register_after_create_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.after_update_hooks {
            let callback = Arc::clone(callback);
            registry.register_after_update_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.after_delete_hooks {
            let callback = Arc::clone(callback);
            registry.register_after_delete_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (id, callback) in &self.on_change_hooks {
            let callback = Arc::clone(callback);
            registry.register_on_change_hook(id.clone(), Box::new(move |ctx| callback(ctx)));
        }
        for (name, (supported_types, callback)) in &self.custom_operators {
            let callback = Arc::clone(callback);
            registry.register_custom_operator(
                name.clone(),
                supported_types.clone(),
                Box::new(move |field_value, operand| callback(field_value, operand)),
            );
        }
        for (name, factory) in &self.id_generators {
            let factory = Arc::clone(factory);
            registry.register_id_generator(name.clone(), Box::new(move || factory()));
        }
        for (id, callback) in &self.lifecycle_callbacks {
            let callback = Arc::clone(callback);
            registry.register_lifecycle_callback(id.clone(), Box::new(move || callback()));
        }
        for (id, callback) in &self.codec_encode_callbacks {
            let callback = Arc::clone(callback);
            registry.register_codec_encode(
                id.clone(),
                Box::new(move |value, indent| callback(value, indent)),
            );
        }
        for (id, callback) in &self.codec_decode_callbacks {
            let callback = Arc::clone(callback);
            registry.register_codec_decode(id.clone(), Box::new(move |raw| callback(raw)));
        }
        registry
    }
}

#[cfg(target_arch = "wasm32")]
fn callback_error(operation: &str, reason: &str, message: impl Into<String>) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_owned(),
        reason: reason.to_owned(),
        message: message.into(),
    })
}

#[cfg(target_arch = "wasm32")]
fn js_value_to_string(value: &wasm_bindgen::JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(value, &wasm_bindgen::JsValue::from_str("message"))
                .ok()
                .and_then(|message| message.as_string())
        })
        .or_else(|| {
            js_sys::JSON::stringify(value)
                .ok()
                .and_then(|value| value.as_string())
        })
        .unwrap_or_else(|| format!("{value:?}"))
}

#[cfg(target_arch = "wasm32")]
fn call_callback_value(
    function: &js_sys::Function,
    args: &js_sys::Array,
    operation: &str,
) -> Result<wasm_bindgen::JsValue, EngineError> {
    function
        .apply(&wasm_bindgen::JsValue::NULL, args)
        .map_err(|error| callback_error(operation, "js-exception", js_value_to_string(&error)))
}

#[cfg(target_arch = "wasm32")]
fn call_json_callback(
    function: &js_sys::Function,
    payload_json: Option<&str>,
    operation: &str,
) -> Result<String, EngineError> {
    let args = js_sys::Array::new();
    if let Some(payload_json) = payload_json {
        args.push(&wasm_bindgen::JsValue::from_str(payload_json));
    }
    call_callback_value(function, &args, operation).and_then(|value| {
        value.as_string().ok_or_else(|| {
            callback_error(
                operation,
                "invalid-callback-return-type",
                format!(
                    "Expected a string bridge response, received {}",
                    js_value_to_string(&value)
                ),
            )
        })
    })
}

#[cfg(target_arch = "wasm32")]
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InboundBridgeResponse<T> {
    Ok { value: T },
    Error { error: EngineError },
    Defect { message: String },
}

#[cfg(target_arch = "wasm32")]
fn serialize_callback_payload(
    payload: &impl Serialize,
    operation: &str,
) -> Result<String, EngineError> {
    serde_json::to_value(payload)
        .map(encode_boundary_output_value)
        .and_then(|value| serde_json::to_string(&value))
        .map_err(|error| callback_error(operation, "serialize-payload", error.to_string()))
}

#[cfg(target_arch = "wasm32")]
fn deserialize_callback_value<T: serde::de::DeserializeOwned>(
    raw: &str,
    operation: &str,
) -> Result<T, EngineError> {
    if !raw.contains("\"__proseql") {
        return serde_json::from_str(raw).map_err(|error| {
            callback_error(operation, "invalid-callback-response", error.to_string())
        });
    }
    serde_json::from_str(raw)
        .map(decode_boundary_input_value)
        .and_then(serde_json::from_value)
        .map_err(|error| callback_error(operation, "invalid-callback-response", error.to_string()))
}

#[cfg(target_arch = "wasm32")]
fn callback_value_requires_boundary_encoding(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(callback_value_requires_boundary_encoding),
        Value::Object(object) => {
            object.keys().any(|key| key.starts_with("__proseql"))
                || object
                    .values()
                    .any(callback_value_requires_boundary_encoding)
        }
        Value::Number(number) => {
            let safe_integer = number
                .as_i64()
                .is_some_and(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
                || number
                    .as_u64()
                    .is_some_and(|value| value <= 9_007_199_254_740_991);
            !safe_integer
        }
        _ => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn decode_json_result<T: serde::de::DeserializeOwned>(
    raw: &str,
    operation: &str,
) -> Result<T, EngineError> {
    if let Ok(response) = deserialize_callback_value::<InboundBridgeResponse<T>>(raw, operation) {
        return match response {
            InboundBridgeResponse::Ok { value } => Ok(value),
            InboundBridgeResponse::Error { error } => Err(error),
            InboundBridgeResponse::Defect { message } => {
                Err(callback_error(operation, "callback-defect", message))
            }
        };
    }
    deserialize_callback_value(raw, operation)
}

#[cfg(target_arch = "wasm32")]
fn call_json_result<T: serde::de::DeserializeOwned>(
    function: &js_sys::Function,
    payload: &impl Serialize,
    operation: &str,
) -> Result<T, EngineError> {
    let payload_json = serialize_callback_payload(payload, operation)?;
    let raw = call_json_callback(function, Some(payload_json.as_str()), operation)?;
    decode_json_result(&raw, operation)
}

#[cfg(target_arch = "wasm32")]
fn call_json_void(
    function: &js_sys::Function,
    payload: &impl Serialize,
    operation: &str,
) -> Result<(), EngineError> {
    let payload_json = serialize_callback_payload(payload, operation)?;
    let raw = call_json_callback(function, Some(payload_json.as_str()), operation)?;
    match deserialize_callback_value::<InboundBridgeResponse<serde_json::Value>>(&raw, operation)? {
        InboundBridgeResponse::Ok { .. } => Ok(()),
        InboundBridgeResponse::Error { error } => Err(error),
        InboundBridgeResponse::Defect { message } => {
            Err(callback_error(operation, "callback-defect", message))
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn call_no_arg_string(function: &js_sys::Function, operation: &str) -> Result<String, EngineError> {
    call_json_callback(function, None, operation)
}

#[cfg(target_arch = "wasm32")]
fn callback_defect_message(operation: &str, error: &EngineError) -> String {
    match error {
        EngineError::Operation(operation_error) => {
            format!("{operation}: {}", operation_error.message)
        }
        _ => format!("{operation}: {error}"),
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static PENDING_CALLBACK_DEFECT: std::cell::RefCell<Option<String>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(target_arch = "wasm32")]
fn callback_defect_pending() -> bool {
    PENDING_CALLBACK_DEFECT.with(|pending| pending.borrow().is_some())
}

#[cfg(target_arch = "wasm32")]
fn record_callback_defect(operation: &str, error: &EngineError) {
    PENDING_CALLBACK_DEFECT.with(|pending| {
        let mut pending = pending.borrow_mut();
        if pending.is_none() {
            *pending = Some(callback_defect_message(operation, error));
        }
    });
}

pub(crate) fn clear_pending_callback_defect() {
    #[cfg(target_arch = "wasm32")]
    PENDING_CALLBACK_DEFECT.with(|pending| pending.borrow_mut().take());
}

pub(crate) fn take_pending_callback_defect() -> Option<String> {
    #[cfg(target_arch = "wasm32")]
    {
        return PENDING_CALLBACK_DEFECT.with(|pending| pending.borrow_mut().take());
    }
    #[cfg(not(target_arch = "wasm32"))]
    None
}

#[cfg(target_arch = "wasm32")]
fn panic_callback_defect(operation: &str, error: EngineError) -> ! {
    panic!("{}", callback_defect_message(operation, &error))
}

#[cfg(target_arch = "wasm32")]
fn before_create_payload(ctx: &BeforeCreateContext) -> Value {
    json!({
        "operation": "create",
        "collection": ctx.collection,
        "data": ctx.data,
    })
}

#[cfg(target_arch = "wasm32")]
fn before_update_payload(ctx: &BeforeUpdateContext) -> Value {
    json!({
        "operation": "update",
        "collection": ctx.collection,
        "id": ctx.id,
        "existing": ctx.existing,
        "update": ctx.update,
    })
}

#[cfg(target_arch = "wasm32")]
fn before_delete_payload(ctx: &BeforeDeleteContext) -> Value {
    json!({
        "operation": "delete",
        "collection": ctx.collection,
        "id": ctx.id,
        "entity": ctx.entity,
    })
}

#[cfg(target_arch = "wasm32")]
fn after_create_payload(ctx: &AfterCreateContext) -> Value {
    json!({
        "operation": "create",
        "collection": ctx.collection,
        "entity": ctx.entity,
    })
}

#[cfg(target_arch = "wasm32")]
fn after_update_payload(ctx: &AfterUpdateContext) -> Value {
    json!({
        "operation": "update",
        "collection": ctx.collection,
        "id": ctx.id,
        "previous": ctx.previous,
        "current": ctx.current,
        "update": ctx.update,
    })
}

#[cfg(target_arch = "wasm32")]
fn after_delete_payload(ctx: &AfterDeleteContext) -> Value {
    json!({
        "operation": "delete",
        "collection": ctx.collection,
        "id": ctx.id,
        "entity": ctx.entity,
    })
}

#[cfg(target_arch = "wasm32")]
fn on_change_payload(ctx: &OnChangeContext) -> Value {
    match ctx {
        OnChangeContext::Create { collection, entity } => {
            json!({"type": "create", "collection": collection, "entity": entity})
        }
        OnChangeContext::Update {
            collection,
            id,
            previous,
            current,
        } => json!({
            "type": "update",
            "collection": collection,
            "id": id,
            "previous": previous,
            "current": current,
        }),
        OnChangeContext::Delete {
            collection,
            id,
            entity,
        } => {
            json!({"type": "delete", "collection": collection, "id": id, "entity": entity})
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl CallbackTable {
    pub fn register_default_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_default(id, move || {
            match call_no_arg_string(&callback, "defaultCallback") {
                Ok(raw) => deserialize_callback_value(&raw, "defaultCallback")
                    .unwrap_or_else(|error| panic_callback_defect("defaultCallback", error)),
                Err(error) => panic_callback_defect("defaultCallback", error),
            }
        });
    }

    pub fn register_predicate_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_predicate(id, move |value| {
            if callback_defect_pending() {
                return false;
            }
            let payload = serialize_callback_payload(value, "predicateCallback")
                .unwrap_or_else(|error| panic_callback_defect("predicateCallback", error));
            match call_json_callback(&callback, Some(payload.as_str()), "predicateCallback") {
                Ok(raw) => serde_json::from_str::<bool>(&raw).unwrap_or_else(|error| {
                    panic_callback_defect(
                        "predicateCallback",
                        callback_error(
                            "predicateCallback",
                            "invalid-callback-response",
                            error.to_string(),
                        ),
                    )
                }),
                Err(error) => panic_callback_defect("predicateCallback", error),
            }
        });
    }

    pub fn register_computed_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_computed(id, move |value| {
            if callback_defect_pending() {
                return Value::Null;
            }
            let payload = if callback_value_requires_boundary_encoding(value) {
                serialize_callback_payload(value, "computedCallback")
            } else {
                serde_json::to_string(value).map_err(|error| {
                    callback_error("computedCallback", "serialize-payload", error.to_string())
                })
            };
            let result = payload.and_then(|payload| {
                call_json_callback(&callback, Some(payload.as_str()), "computedCallback")
            });
            match result.and_then(|raw| decode_json_result(&raw, "computedCallback")) {
                Ok(value) => value,
                Err(error) => {
                    record_callback_defect("computedCallback", &error);
                    Value::Null
                }
            }
        });
    }

    pub fn register_collator_js(&mut self, callback: js_sys::Function) {
        self.register_collator(move |a, b| {
            if callback_defect_pending() {
                return Ordering::Equal;
            }
            let args = js_sys::Array::new();
            args.push(&wasm_bindgen::JsValue::from_str(a));
            args.push(&wasm_bindgen::JsValue::from_str(b));
            let value = match call_callback_value(&callback, &args, "collatorCallback") {
                Ok(value) => value
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .unwrap_or_else(|| {
                        panic_callback_defect(
                            "collatorCallback",
                            callback_error(
                                "collatorCallback",
                                "invalid-callback-return-type",
                                format!(
                                    "Expected a finite numeric collator result, received {}",
                                    js_value_to_string(&value)
                                ),
                            ),
                        )
                    }),
                Err(error) => panic_callback_defect("collatorCallback", error),
            };
            value.partial_cmp(&0.0).unwrap_or_else(|| {
                panic_callback_defect(
                    "collatorCallback",
                    callback_error(
                        "collatorCallback",
                        "invalid-callback-return-type",
                        format!("Expected an orderable finite collator result, received {value}"),
                    ),
                )
            })
        });
    }

    pub fn register_migration_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_migration(id, move |data| {
            call_json_result(&callback, data, "migrationCallback")
        });
    }

    pub fn register_id_generator_js(&mut self, name: String, callback: js_sys::Function) {
        self.register_id_generator(name, move || {
            let callback = callback.clone();
            struct JsGenerator {
                callback: js_sys::Function,
            }
            impl IdGenerator for JsGenerator {
                fn generate(&mut self) -> String {
                    match call_no_arg_string(&self.callback, "idGeneratorCallback") {
                        Ok(id) => id,
                        Err(error) => panic_callback_defect("idGeneratorCallback", error),
                    }
                }
            }
            Box::new(JsGenerator { callback }) as Box<dyn IdGenerator>
        });
    }

    pub fn register_lifecycle_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_lifecycle(id, move || {
            let _ = call_json_callback(&callback, None, "lifecycleCallback")?;
            Ok(())
        });
    }

    pub fn register_codec_encode_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_codec_encode(id, move |value, indent| {
            call_json_result(
                &callback,
                &json!({"value": value, "indent": indent}),
                "codecEncodeCallback",
            )
        });
    }

    pub fn register_codec_decode_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_codec_decode(id, move |raw| {
            call_json_result(&callback, &json!({"raw": raw}), "codecDecodeCallback")
        });
    }

    pub fn register_before_create_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_before_create_hook(id, move |ctx| {
            call_json_result(&callback, &before_create_payload(ctx), "beforeCreateHook")
        });
    }

    pub fn register_before_update_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_before_update_hook(id, move |ctx| {
            call_json_result(&callback, &before_update_payload(ctx), "beforeUpdateHook")
        });
    }

    pub fn register_before_delete_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_before_delete_hook(id, move |ctx| {
            call_json_void(&callback, &before_delete_payload(ctx), "beforeDeleteHook")
        });
    }

    pub fn register_after_create_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_after_create_hook(id, move |ctx| {
            call_json_void(&callback, &after_create_payload(ctx), "afterCreateHook")
        });
    }

    pub fn register_after_update_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_after_update_hook(id, move |ctx| {
            call_json_void(&callback, &after_update_payload(ctx), "afterUpdateHook")
        });
    }

    pub fn register_after_delete_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_after_delete_hook(id, move |ctx| {
            call_json_void(&callback, &after_delete_payload(ctx), "afterDeleteHook")
        });
    }

    pub fn register_on_change_hook_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_on_change_hook(id, move |ctx| {
            call_json_void(&callback, &on_change_payload(ctx), "onChangeHook")
        });
    }

    pub fn register_custom_operator_js(
        &mut self,
        name: String,
        supported_types_json: String,
        callback: js_sys::Function,
    ) -> Result<(), EngineError> {
        let supported_types: Vec<String> =
            serde_json::from_str(&supported_types_json).map_err(|error| {
                callback_error(
                    "registerCustomOperator",
                    "invalid-supported-types",
                    error.to_string(),
                )
            })?;
        self.register_custom_operator(name, supported_types, move |field_value, operand| {
            if callback_defect_pending() {
                return false;
            }
            let result = serialize_callback_payload(field_value, "customOperatorCallback")
                .and_then(|field_json| {
                    serialize_callback_payload(operand, "customOperatorCallback")
                        .map(|operand_json| (field_json, operand_json))
                })
                .and_then(|(field_json, operand_json)| {
                    let args = js_sys::Array::new();
                    args.push(&wasm_bindgen::JsValue::from_str(field_json.as_str()));
                    args.push(&wasm_bindgen::JsValue::from_str(operand_json.as_str()));
                    call_callback_value(&callback, &args, "customOperatorCallback")
                })
                .and_then(|value| {
                    value.as_bool().ok_or_else(|| {
                        callback_error(
                            "customOperatorCallback",
                            "invalid-callback-return-type",
                            format!(
                                "Expected a boolean custom operator result, received {}",
                                js_value_to_string(&value)
                            ),
                        )
                    })
                });
            match result {
                Ok(value) => value,
                Err(error) => {
                    record_callback_defect("customOperatorCallback", &error);
                    false
                }
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proseql_engine::id_gen::SequentialGenerator;
    use serde_json::json;

    #[test]
    fn lifecycle_and_codec_callbacks_round_trip_through_registry() {
        let mut table = CallbackTable::default();
        table.register_lifecycle("boot", || Ok(()));
        table.register_codec_encode("enc", |value, indent| {
            Ok(format!(
                "{}:{}",
                indent.unwrap_or(0),
                serde_json::to_string(value).unwrap()
            ))
        });
        table.register_codec_decode("dec", |raw| Ok(json!({"raw": raw})));
        let registry = table.build_registry();

        assert!(registry.invoke_lifecycle_callback("boot").unwrap().is_ok());
        assert_eq!(
            registry
                .invoke_codec_encode("enc", &json!({"a": 1}), Some(2))
                .unwrap()
                .unwrap(),
            "2:{\"a\":1}"
        );
        assert_eq!(
            registry.invoke_codec_decode("dec", "x").unwrap().unwrap(),
            json!({"raw": "x"})
        );
    }

    #[test]
    fn hooks_and_id_generators_round_trip_through_registry() {
        let mut table = CallbackTable::default();
        table.register_before_create_hook("normalize", |ctx| {
            let mut data = ctx.data.as_object().cloned().unwrap_or_default();
            data.insert("name".to_owned(), json!("Normalized"));
            Ok(Value::Object(data))
        });
        table.register_id_generator("ids", || Box::new(SequentialGenerator::new("custom")));
        let registry = table.build_registry();

        let context = BeforeCreateContext {
            operation: proseql_engine::errors::HookOperation::Create,
            collection: "users".to_owned(),
            data: json!({"id": "u1", "name": "Alice"}),
        };
        assert_eq!(
            registry.before_create_hook("normalize").unwrap()(&context).unwrap()["name"],
            json!("Normalized")
        );
        let mut generator = registry.instantiate_id_generator("ids").unwrap();
        assert_eq!(generator.generate(), "custom-1");
    }
}
