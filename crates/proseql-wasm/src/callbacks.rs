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
            js_sys::JSON::stringify(value)
                .ok()
                .and_then(|value| value.as_string())
        })
        .unwrap_or_else(|| format!("{value:?}"))
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
    function
        .apply(&wasm_bindgen::JsValue::NULL, &args)
        .map(|value| value.as_string().unwrap_or_default())
        .map_err(|error| callback_error(operation, "js-exception", js_value_to_string(&error)))
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
fn call_json_result<T: for<'de> serde::Deserialize<'de>>(
    function: &js_sys::Function,
    payload: &impl Serialize,
    operation: &str,
) -> Result<T, EngineError> {
    let payload_json = serde_json::to_string(payload)
        .map_err(|error| callback_error(operation, "serialize-payload", error.to_string()))?;
    let raw = call_json_callback(function, Some(payload_json.as_str()), operation)?;
    if let Ok(response) = serde_json::from_str::<InboundBridgeResponse<T>>(&raw) {
        return match response {
            InboundBridgeResponse::Ok { value } => Ok(value),
            InboundBridgeResponse::Error { error } => Err(error),
            InboundBridgeResponse::Defect { message } => {
                Err(callback_error(operation, "callback-defect", message))
            }
        };
    }
    serde_json::from_str(&raw)
        .map_err(|error| callback_error(operation, "invalid-callback-response", error.to_string()))
}

#[cfg(target_arch = "wasm32")]
fn call_json_void(
    function: &js_sys::Function,
    payload: &impl Serialize,
    operation: &str,
) -> Result<(), EngineError> {
    let payload_json = serde_json::to_string(payload)
        .map_err(|error| callback_error(operation, "serialize-payload", error.to_string()))?;
    let raw = call_json_callback(function, Some(payload_json.as_str()), operation)?;
    if let Ok(response) = serde_json::from_str::<InboundBridgeResponse<serde_json::Value>>(&raw) {
        return match response {
            InboundBridgeResponse::Ok { .. } => Ok(()),
            InboundBridgeResponse::Error { error } => Err(error),
            InboundBridgeResponse::Defect { message } => {
                Err(callback_error(operation, "callback-defect", message))
            }
        };
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn call_no_arg_string(function: &js_sys::Function, operation: &str) -> Result<String, EngineError> {
    call_json_callback(function, None, operation)
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
            let raw = call_no_arg_string(&callback, "defaultCallback")
                .unwrap_or_else(|_| "null".to_owned());
            serde_json::from_str(&raw).unwrap_or(Value::Null)
        });
    }

    pub fn register_predicate_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_predicate(id, move |value| {
            let payload = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
            call_json_callback(&callback, Some(payload.as_str()), "predicateCallback")
                .ok()
                .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
                .unwrap_or(false)
        });
    }

    pub fn register_computed_js(&mut self, id: String, callback: js_sys::Function) {
        self.register_computed(id, move |value| {
            call_json_result(&callback, value, "computedCallback").unwrap_or(Value::Null)
        });
    }

    pub fn register_collator_js(&mut self, callback: js_sys::Function) {
        self.register_collator(move |a, b| {
            let args = js_sys::Array::new();
            args.push(&wasm_bindgen::JsValue::from_str(a));
            args.push(&wasm_bindgen::JsValue::from_str(b));
            let value = callback
                .apply(&wasm_bindgen::JsValue::NULL, &args)
                .ok()
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            value.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
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
                    call_no_arg_string(&self.callback, "idGeneratorCallback").unwrap_or_default()
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
            let field_json =
                serde_json::to_string(field_value).unwrap_or_else(|_| "null".to_owned());
            let operand_json = serde_json::to_string(operand).unwrap_or_else(|_| "null".to_owned());
            let args = js_sys::Array::new();
            args.push(&wasm_bindgen::JsValue::from_str(field_json.as_str()));
            args.push(&wasm_bindgen::JsValue::from_str(operand_json.as_str()));
            callback
                .apply(&wasm_bindgen::JsValue::NULL, &args)
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
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
