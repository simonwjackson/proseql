//! Callback registry for host-provided functions used by the engine.
//!
//! Native Rust callbacks are synchronous closures; storage and JS hosts adapt
//! their runtime model to this seam.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::errors::EngineError;
use crate::hooks::{
    AfterCreateContext, AfterDeleteContext, AfterUpdateContext, BeforeCreateContext,
    BeforeDeleteContext, BeforeUpdateContext, OnChangeContext,
};
use crate::id_gen::IdGenerator;
use crate::value::Value as BoundaryValue;

pub type DefaultCallback = Box<dyn Fn() -> Value + Send + Sync>;
pub type PredicateCallback = Box<dyn Fn(&Value) -> bool + Send + Sync>;
pub type ComputedCallback = Box<dyn Fn(&Value) -> Value + Send + Sync>;
pub type StringCollatorFn = Box<dyn Fn(&str, &str) -> std::cmp::Ordering + Send + Sync>;
pub type MigrationCallback =
    Box<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError> + Send + Sync>;
pub type IdGeneratorFactory = Box<dyn Fn() -> Box<dyn IdGenerator> + Send + Sync>;
pub type PluginLifecycleCallback = Box<dyn Fn() -> Result<(), EngineError> + Send + Sync>;
pub type CodecEncodeCallback =
    Box<dyn Fn(&BoundaryValue, Option<usize>) -> Result<String, EngineError> + Send + Sync>;
pub type CodecDecodeCallback =
    Box<dyn Fn(&str) -> Result<BoundaryValue, EngineError> + Send + Sync>;

pub type BeforeCreateHookCallback =
    Box<dyn Fn(&BeforeCreateContext) -> Result<Value, EngineError> + Send + Sync>;
pub type BeforeUpdateHookCallback =
    Box<dyn Fn(&BeforeUpdateContext) -> Result<Value, EngineError> + Send + Sync>;
pub type BeforeDeleteHookCallback =
    Box<dyn Fn(&BeforeDeleteContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterCreateHookCallback =
    Box<dyn Fn(&AfterCreateContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterUpdateHookCallback =
    Box<dyn Fn(&AfterUpdateContext) -> Result<(), EngineError> + Send + Sync>;
pub type AfterDeleteHookCallback =
    Box<dyn Fn(&AfterDeleteContext) -> Result<(), EngineError> + Send + Sync>;
pub type OnChangeHookCallback =
    Box<dyn Fn(&OnChangeContext) -> Result<(), EngineError> + Send + Sync>;
pub type CustomOperatorCallback = Box<dyn Fn(&Value, &Value) -> bool + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomOperatorEvaluation {
    Unknown,
    Ignored,
    Matched(bool),
}

struct CustomOperatorRegistration {
    supported_types: Vec<String>,
    evaluate: CustomOperatorCallback,
}

#[derive(Default)]
pub struct CallbackRegistry {
    defaults: HashMap<String, DefaultCallback>,
    predicates: HashMap<String, PredicateCallback>,
    computed: HashMap<String, ComputedCallback>,
    collator: Option<StringCollatorFn>,
    migrations: HashMap<String, MigrationCallback>,
    before_create_hooks: HashMap<String, BeforeCreateHookCallback>,
    before_update_hooks: HashMap<String, BeforeUpdateHookCallback>,
    before_delete_hooks: HashMap<String, BeforeDeleteHookCallback>,
    after_create_hooks: HashMap<String, AfterCreateHookCallback>,
    after_update_hooks: HashMap<String, AfterUpdateHookCallback>,
    after_delete_hooks: HashMap<String, AfterDeleteHookCallback>,
    on_change_hooks: HashMap<String, OnChangeHookCallback>,
    custom_operators: HashMap<String, CustomOperatorRegistration>,
    id_generators: HashMap<String, IdGeneratorFactory>,
    lifecycle_callbacks: HashMap<String, PluginLifecycleCallback>,
    codec_encode_callbacks: HashMap<String, CodecEncodeCallback>,
    codec_decode_callbacks: HashMap<String, CodecDecodeCallback>,
    global_before_create_hooks: Vec<String>,
    global_before_update_hooks: Vec<String>,
    global_before_delete_hooks: Vec<String>,
    global_after_create_hooks: Vec<String>,
    global_after_update_hooks: Vec<String>,
    global_after_delete_hooks: Vec<String>,
    global_on_change_hooks: Vec<String>,
}

impl CallbackRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_default(&mut self, id: impl Into<String>, f: DefaultCallback) {
        self.defaults.insert(id.into(), f);
    }

    pub fn invoke_default(&self, id: &str) -> Option<Value> {
        self.defaults.get(id).map(|f| f())
    }

    pub fn has_default(&self, id: &str) -> bool {
        self.defaults.contains_key(id)
    }

    pub fn register_predicate(&mut self, id: impl Into<String>, f: PredicateCallback) {
        self.predicates.insert(id.into(), f);
    }

    pub fn invoke_predicate(&self, id: &str, value: &Value) -> Option<bool> {
        self.predicates.get(id).map(|f| f(value))
    }

    pub fn has_predicate(&self, id: &str) -> bool {
        self.predicates.contains_key(id)
    }

    pub fn register_collator(&mut self, f: StringCollatorFn) {
        self.collator = Some(f);
    }

    pub fn collate_strings(&self, a: &str, b: &str) -> Option<std::cmp::Ordering> {
        self.collator.as_ref().map(|f| f(a, b))
    }

    pub fn register_computed(&mut self, id: impl Into<String>, f: ComputedCallback) {
        self.computed.insert(id.into(), f);
    }

    pub fn invoke_computed(&self, id: &str, entity: &Value) -> Option<Value> {
        self.computed.get(id).map(|f| f(entity))
    }

    pub fn register_migration(&mut self, id: impl Into<String>, f: MigrationCallback) {
        self.migrations.insert(id.into(), f);
    }

    pub fn invoke_migration(
        &self,
        id: &str,
        data: &Map<String, Value>,
    ) -> Option<Result<Map<String, Value>, EngineError>> {
        self.migrations.get(id).map(|f| f(data))
    }

    pub fn has_migration(&self, id: &str) -> bool {
        self.migrations.contains_key(id)
    }

    pub fn register_before_create_hook(
        &mut self,
        id: impl Into<String>,
        f: BeforeCreateHookCallback,
    ) {
        self.before_create_hooks.insert(id.into(), f);
    }

    pub fn before_create_hook(&self, id: &str) -> Option<&BeforeCreateHookCallback> {
        self.before_create_hooks.get(id)
    }

    pub fn register_before_update_hook(
        &mut self,
        id: impl Into<String>,
        f: BeforeUpdateHookCallback,
    ) {
        self.before_update_hooks.insert(id.into(), f);
    }

    pub fn before_update_hook(&self, id: &str) -> Option<&BeforeUpdateHookCallback> {
        self.before_update_hooks.get(id)
    }

    pub fn register_before_delete_hook(
        &mut self,
        id: impl Into<String>,
        f: BeforeDeleteHookCallback,
    ) {
        self.before_delete_hooks.insert(id.into(), f);
    }

    pub fn before_delete_hook(&self, id: &str) -> Option<&BeforeDeleteHookCallback> {
        self.before_delete_hooks.get(id)
    }

    pub fn register_after_create_hook(
        &mut self,
        id: impl Into<String>,
        f: AfterCreateHookCallback,
    ) {
        self.after_create_hooks.insert(id.into(), f);
    }

    pub fn after_create_hook(&self, id: &str) -> Option<&AfterCreateHookCallback> {
        self.after_create_hooks.get(id)
    }

    pub fn register_after_update_hook(
        &mut self,
        id: impl Into<String>,
        f: AfterUpdateHookCallback,
    ) {
        self.after_update_hooks.insert(id.into(), f);
    }

    pub fn after_update_hook(&self, id: &str) -> Option<&AfterUpdateHookCallback> {
        self.after_update_hooks.get(id)
    }

    pub fn register_after_delete_hook(
        &mut self,
        id: impl Into<String>,
        f: AfterDeleteHookCallback,
    ) {
        self.after_delete_hooks.insert(id.into(), f);
    }

    pub fn after_delete_hook(&self, id: &str) -> Option<&AfterDeleteHookCallback> {
        self.after_delete_hooks.get(id)
    }

    pub fn register_on_change_hook(&mut self, id: impl Into<String>, f: OnChangeHookCallback) {
        self.on_change_hooks.insert(id.into(), f);
    }

    pub fn on_change_hook(&self, id: &str) -> Option<&OnChangeHookCallback> {
        self.on_change_hooks.get(id)
    }

    pub fn register_custom_operator(
        &mut self,
        name: impl Into<String>,
        supported_types: Vec<String>,
        evaluate: CustomOperatorCallback,
    ) {
        self.custom_operators.insert(
            name.into(),
            CustomOperatorRegistration {
                supported_types,
                evaluate,
            },
        );
    }

    pub fn has_custom_operator(&self, name: &str) -> bool {
        self.custom_operators.contains_key(name)
    }

    pub fn custom_operator_names(&self) -> impl Iterator<Item = &str> {
        self.custom_operators.keys().map(String::as_str)
    }

    pub fn evaluate_custom_operator(
        &self,
        name: &str,
        field_value: &Value,
        operand: &Value,
    ) -> CustomOperatorEvaluation {
        let Some(operator) = self.custom_operators.get(name) else {
            return CustomOperatorEvaluation::Unknown;
        };
        let value_type = if field_value.is_string() {
            "string"
        } else if field_value.is_number() {
            "number"
        } else if field_value.is_boolean() {
            "boolean"
        } else if field_value.is_array() {
            "array"
        } else {
            return CustomOperatorEvaluation::Ignored;
        };
        if !operator
            .supported_types
            .iter()
            .any(|kind| kind == value_type)
        {
            return CustomOperatorEvaluation::Ignored;
        }
        CustomOperatorEvaluation::Matched((operator.evaluate)(field_value, operand))
    }

    pub fn register_id_generator(&mut self, name: impl Into<String>, factory: IdGeneratorFactory) {
        self.id_generators.insert(name.into(), factory);
    }

    pub fn has_id_generator(&self, name: &str) -> bool {
        self.id_generators.contains_key(name)
    }

    pub fn instantiate_id_generator(&self, name: &str) -> Option<Box<dyn IdGenerator>> {
        self.id_generators.get(name).map(|factory| factory())
    }

    pub fn register_lifecycle_callback(
        &mut self,
        id: impl Into<String>,
        callback: PluginLifecycleCallback,
    ) {
        self.lifecycle_callbacks.insert(id.into(), callback);
    }

    pub fn invoke_lifecycle_callback(&self, id: &str) -> Option<Result<(), EngineError>> {
        self.lifecycle_callbacks.get(id).map(|callback| callback())
    }

    pub fn has_lifecycle_callback(&self, id: &str) -> bool {
        self.lifecycle_callbacks.contains_key(id)
    }

    pub fn register_codec_encode(&mut self, id: impl Into<String>, callback: CodecEncodeCallback) {
        self.codec_encode_callbacks.insert(id.into(), callback);
    }

    pub fn register_codec_decode(&mut self, id: impl Into<String>, callback: CodecDecodeCallback) {
        self.codec_decode_callbacks.insert(id.into(), callback);
    }

    pub fn invoke_codec_encode(
        &self,
        id: &str,
        value: &BoundaryValue,
        indent: Option<usize>,
    ) -> Option<Result<String, EngineError>> {
        self.codec_encode_callbacks
            .get(id)
            .map(|callback| callback(value, indent))
    }

    pub fn invoke_codec_decode(
        &self,
        id: &str,
        raw: &str,
    ) -> Option<Result<BoundaryValue, EngineError>> {
        self.codec_decode_callbacks
            .get(id)
            .map(|callback| callback(raw))
    }

    pub fn has_codec_encode(&self, id: &str) -> bool {
        self.codec_encode_callbacks.contains_key(id)
    }

    pub fn has_codec_decode(&self, id: &str) -> bool {
        self.codec_decode_callbacks.contains_key(id)
    }

    pub fn set_global_before_create_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_before_create_hooks = hook_ids;
    }

    pub fn set_global_before_update_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_before_update_hooks = hook_ids;
    }

    pub fn set_global_before_delete_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_before_delete_hooks = hook_ids;
    }

    pub fn set_global_after_create_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_after_create_hooks = hook_ids;
    }

    pub fn set_global_after_update_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_after_update_hooks = hook_ids;
    }

    pub fn set_global_after_delete_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_after_delete_hooks = hook_ids;
    }

    pub fn set_global_on_change_hooks(&mut self, hook_ids: Vec<String>) {
        self.global_on_change_hooks = hook_ids;
    }

    pub fn global_before_create_hooks(&self) -> &[String] {
        &self.global_before_create_hooks
    }

    pub fn global_before_update_hooks(&self) -> &[String] {
        &self.global_before_update_hooks
    }

    pub fn global_before_delete_hooks(&self) -> &[String] {
        &self.global_before_delete_hooks
    }

    pub fn global_after_create_hooks(&self) -> &[String] {
        &self.global_after_create_hooks
    }

    pub fn global_after_update_hooks(&self) -> &[String] {
        &self.global_after_update_hooks
    }

    pub fn global_after_delete_hooks(&self) -> &[String] {
        &self.global_after_delete_hooks
    }

    pub fn global_on_change_hooks(&self) -> &[String] {
        &self.global_on_change_hooks
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::hooks::{BeforeCreateContext, OnChangeContext};
    use crate::id_gen::{IdGenerator, SequentialGenerator};

    #[test]
    fn invoke_registered_default_returns_value() {
        let mut registry = CallbackRegistry::new();
        registry.register_default("score_default", Box::new(|| json!(0)));

        let result = registry.invoke_default("score_default");
        assert_eq!(result, Some(json!(0)));
    }

    #[test]
    fn invoke_unregistered_default_returns_none() {
        let registry = CallbackRegistry::new();
        assert_eq!(registry.invoke_default("missing"), None);
    }

    #[test]
    fn registering_same_id_replaces_previous() {
        let mut registry = CallbackRegistry::new();
        registry.register_default("k", Box::new(|| json!(1)));
        registry.register_default("k", Box::new(|| json!(2)));
        assert_eq!(registry.invoke_default("k"), Some(json!(2)));
    }

    #[test]
    fn callback_is_callable_multiple_times() {
        let mut registry = CallbackRegistry::new();
        registry.register_default("tags", Box::new(|| json!([])));

        let a = registry.invoke_default("tags");
        let b = registry.invoke_default("tags");
        assert_eq!(a, Some(json!([])));
        assert_eq!(b, Some(json!([])));
    }

    #[test]
    fn invoke_registered_predicate_returns_result() {
        let mut registry = CallbackRegistry::new();
        registry.register_predicate(
            "gt5",
            Box::new(|v| v.as_f64().map(|n| n > 5.0).unwrap_or(false)),
        );

        assert_eq!(registry.invoke_predicate("gt5", &json!(3)), Some(false));
        assert_eq!(registry.invoke_predicate("gt5", &json!(7)), Some(true));
    }

    #[test]
    fn invoke_unregistered_predicate_returns_none() {
        let registry = CallbackRegistry::new();
        assert_eq!(registry.invoke_predicate("missing", &json!(1)), None);
    }

    #[test]
    fn custom_operator_ignores_incompatible_types() {
        let mut registry = CallbackRegistry::new();
        registry.register_custom_operator(
            "$odd",
            vec!["number".to_owned()],
            Box::new(|value, _| {
                value
                    .as_i64()
                    .map(|number| number % 2 == 1)
                    .unwrap_or(false)
            }),
        );
        assert_eq!(
            registry.evaluate_custom_operator("$odd", &json!("7"), &Value::Null),
            CustomOperatorEvaluation::Ignored
        );
        assert_eq!(
            registry.evaluate_custom_operator("$odd", &json!(7), &Value::Null),
            CustomOperatorEvaluation::Matched(true)
        );
    }

    #[test]
    fn hook_callbacks_can_be_looked_up() {
        let mut registry = CallbackRegistry::new();
        registry.register_before_create_hook(
            "normalize",
            Box::new(|ctx: &BeforeCreateContext| Ok(ctx.data.clone())),
        );
        let context = BeforeCreateContext {
            operation: crate::errors::HookOperation::Create,
            collection: "users".to_owned(),
            data: json!({"id":"u1"}),
        };
        let result = registry.before_create_hook("normalize").unwrap()(&context).unwrap();
        assert_eq!(result, json!({"id":"u1"}));
    }

    #[test]
    fn id_generators_can_be_instantiated() {
        let mut registry = CallbackRegistry::new();
        registry.register_id_generator(
            "seq",
            Box::new(|| Box::new(SequentialGenerator::new("plugin")) as Box<dyn IdGenerator>),
        );
        let mut generator = registry.instantiate_id_generator("seq").unwrap();
        assert_eq!(generator.generate(), "plugin-1");
    }

    #[test]
    fn on_change_hooks_can_be_looked_up() {
        let mut registry = CallbackRegistry::new();
        registry.register_on_change_hook("track", Box::new(|_| Ok(())));
        let ctx = OnChangeContext::Create {
            collection: "users".to_owned(),
            entity: json!({"id":"u1"}),
        };
        assert!(registry.on_change_hook("track").unwrap()(&ctx).is_ok());
    }
}
