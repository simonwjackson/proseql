//! Callback registry for host-provided functions used by the engine.
//!
//! ## Registered callback kinds
//!
//! | Kind              | Used by                  | Signature                       |
//! |-------------------|--------------------------|---------------------------------|
//! | `DefaultCallback` | `OptionalWithDefault`    | `() -> Value`                   |
//! | `PredicateCallback` | `$removeBy` operator   | `(&Value) -> bool`              |
//!
//! ## Design decision: sync native execution
//!
//! Native Rust callbacks are synchronous closures.  This is appropriate because:
//!
//! - The native consumers (korrid, tests) supply Rust closures; no async boundary.
//! - The WASM boundary (U8) wraps JS async default functions into *sync* Rust
//!   closures at wasm-bindgen dispatch time, so the engine always sees a sync call.
//!
//! ## TS references
//! - `Schema.optional(T, { default: () => V })` / `Schema.optionalWith` — default seam
//! - `$remove: (item) => boolean` update operator — predicate seam

use std::collections::HashMap;

use crate::value::Value;

// ── Types ─────────────────────────────────────────────────────────────────────

/// A sync callback that produces a default `Value`.
///
/// The `Fn` bound (not `FnMut`) is intentional: defaults should be pure
/// functions callable multiple times without side effects.
pub type DefaultCallback = Box<dyn Fn() -> Value + Send + Sync>;

/// A sync predicate over a JSON `Value`.
///
/// Used by the `$removeBy` operator to filter array elements.
/// Mirrors TS `$remove: (item: U) => boolean`.
pub type PredicateCallback = Box<dyn Fn(&Value) -> bool + Send + Sync>;

// ── Registry ──────────────────────────────────────────────────────────────────

/// A registry mapping string callback IDs to their implementations.
///
/// The ID space is shared between:
/// - `OptionalWithDefault.default_callback_id` — schema field defaults
/// - `$removeBy` operator callback ids — array element predicates
/// - Named id generators (`CollectionDescriptor.id_generator`) — U7+
/// - Hook callback IDs — U7+
/// - Plugin operator IDs — U7+
#[derive(Default)]
pub struct CallbackRegistry {
    defaults: HashMap<String, DefaultCallback>,
    predicates: HashMap<String, PredicateCallback>,
}

impl CallbackRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    // ── Default callbacks ─────────────────────────────────────────────────────

    /// Register a default-value callback for an `OptionalWithDefault` field.
    ///
    /// If a callback with the same `id` is already registered it is replaced.
    pub fn register_default(&mut self, id: impl Into<String>, f: DefaultCallback) {
        self.defaults.insert(id.into(), f);
    }

    /// Invoke a registered default callback, returning `Some(value)` if registered.
    ///
    /// Returns `None` when no callback is registered for `id`.
    /// Callers that treat a missing callback as a loud error should convert `None`
    /// to an appropriate `EngineError` themselves.
    pub fn invoke_default(&self, id: &str) -> Option<Value> {
        self.defaults.get(id).map(|f| f())
    }

    /// Check whether a default callback is registered under the given id.
    pub fn has_default(&self, id: &str) -> bool {
        self.defaults.contains_key(id)
    }

    // ── Predicate callbacks ───────────────────────────────────────────────────

    /// Register a predicate callback for the `$removeBy` operator.
    ///
    /// The predicate is called once per array element; elements for which it
    /// returns `true` are removed.
    ///
    /// Mirrors TS `$remove: (item: U) => boolean`.
    pub fn register_predicate(&mut self, id: impl Into<String>, f: PredicateCallback) {
        self.predicates.insert(id.into(), f);
    }

    /// Invoke a registered predicate callback on a value.
    ///
    /// Returns `Some(result)` if the id is registered, `None` if not.
    pub fn invoke_predicate(&self, id: &str, value: &Value) -> Option<bool> {
        self.predicates.get(id).map(|f| f(value))
    }

    /// Check whether a predicate callback is registered under the given id.
    pub fn has_predicate(&self, id: &str) -> bool {
        self.predicates.contains_key(id)
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
        // Remove values greater than 5
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
}
