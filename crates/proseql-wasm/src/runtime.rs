use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
use std::{cell::RefCell, rc::Rc};

use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::change_set::ChangeSet;
use proseql_engine::clock::{Clock, FixedClock};
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::CollectionDescriptor;
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::id_gen::{IdGenerator, SequentialGenerator};
use proseql_engine::reactive::CallbackSubscription;
use proseql_engine::relationships::Database;
use proseql_engine::value::{decode_boundary_input_value, encode_boundary_output_value};
use serde_json::{json, Value};

use crate::bridge;
use crate::callbacks::CallbackTable;
use crate::command;
use crate::projection::MaterializedProjection;
use crate::reactive::{unsupported_scheduler_factory, ReactiveSchedulerFactory};
use crate::types::{parse_json, CreateDatabaseInput};

pub type ClockFactory = Arc<dyn Fn() -> Box<dyn Clock> + Send + Sync + 'static>;
pub type FallbackIdGeneratorFactory = Arc<dyn Fn() -> Box<dyn IdGenerator> + Send + Sync + 'static>;

pub struct RuntimeConfig {
    pub clock_factory: ClockFactory,
    pub fallback_id_generator_factory: FallbackIdGeneratorFactory,
    pub reactive_scheduler_factory: ReactiveSchedulerFactory,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            clock_factory: Arc::new(|| {
                Box::new(FixedClock::new("1970-01-01T00:00:00.000Z")) as Box<dyn Clock>
            }),
            fallback_id_generator_factory: Arc::new(|| {
                Box::new(SequentialGenerator::new("bridge")) as Box<dyn IdGenerator>
            }),
            reactive_scheduler_factory: unsupported_scheduler_factory(),
        }
    }
}

pub(crate) struct DatabaseContext {
    pub db: Database,
    pub registry: Arc<CallbackRegistry>,
    pub collection_names: Vec<String>,
    pub next_subscription_id: u32,
    pub subscriptions: std::collections::HashMap<u32, CallbackSubscription>,
    /// Bounded deltas from the most recently completed dispatch.
    pub last_changes: ChangeSet,
    pub(crate) projection: MaterializedProjection,
}

impl DatabaseContext {
    pub fn snapshot_all(&self) -> IndexMap<String, Vec<Value>> {
        self.collection_names
            .iter()
            .map(|name| {
                (
                    name.clone(),
                    self.db
                        .collection(name)
                        .map(|collection| {
                            collection.list().into_iter().cloned().collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                )
            })
            .collect()
    }
}

pub(crate) struct RuntimeCore {
    pub callbacks: CallbackTable,
    pub config: RuntimeConfig,
    pub next_handle: u32,
    pub databases: std::collections::HashMap<u32, DatabaseContext>,
}

impl RuntimeCore {
    pub fn new(config: RuntimeConfig) -> Self {
        Self {
            callbacks: CallbackTable::default(),
            config,
            next_handle: 1,
            databases: std::collections::HashMap::new(),
        }
    }

    pub fn create_database(&mut self, mut input: CreateDatabaseInput) -> Result<u32, EngineError> {
        let registry = Arc::new(self.callbacks.build_registry());
        let mut collections = IndexMap::new();
        let mut collection_names = Vec::new();

        for descriptor in input.descriptor.collections {
            collection_names.push(descriptor.name.clone());
            let collection = Collection::new_with_clock(
                descriptor.name.clone(),
                descriptor.clone(),
                Arc::clone(&registry),
                instantiate_id_generator(&descriptor, registry.as_ref(), &self.config),
                (self.config.clock_factory)(),
            );
            collections.insert(descriptor.name.clone(), collection);
        }

        let mut db = Database::new_with_reactive_scheduler(
            collections,
            Arc::clone(&registry),
            (self.config.reactive_scheduler_factory)(),
        );

        if !input.initial_collections.is_empty() {
            let mut initial_collections = IndexMap::new();
            for collection in &collection_names {
                if let Some(records) = input.initial_collections.remove(collection) {
                    initial_collections.insert(collection.clone(), records);
                }
            }
            for (collection, records) in input.initial_collections {
                initial_collections.insert(collection, records);
            }
            db.load_initial_collections_trusted(initial_collections)?;
        }

        // Bootstrap is represented canonically by the initial projection, not as
        // an ordinary mutation delta retained for the lifetime of the handle.
        db.take_committed_changes();

        let handle = self.next_handle.max(1);
        self.next_handle = handle.saturating_add(1);
        let projection = MaterializedProjection::from_database(&db, &collection_names);
        self.databases.insert(
            handle,
            DatabaseContext {
                db,
                registry,
                collection_names,
                next_subscription_id: 1,
                subscriptions: std::collections::HashMap::new(),
                last_changes: ChangeSet::default(),
                projection,
            },
        );
        Ok(handle)
    }

    pub fn drop_database(&mut self, handle: u32) -> bool {
        self.databases.remove(&handle).is_some()
    }

    pub fn database_mut(&mut self, handle: u32) -> Result<&mut DatabaseContext, EngineError> {
        self.databases.get_mut(&handle).ok_or_else(|| {
            EngineError::Operation(OperationError {
                operation: "database".to_owned(),
                reason: "unknown-handle".to_owned(),
                message: format!("Unknown database handle {handle}"),
            })
        })
    }
}

fn instantiate_id_generator(
    descriptor: &CollectionDescriptor,
    registry: &CallbackRegistry,
    config: &RuntimeConfig,
) -> Box<dyn IdGenerator> {
    if let Some(name) = descriptor.id_generator.as_deref() {
        if let Some(generator) = registry.instantiate_id_generator(name) {
            return generator;
        }
    }
    (config.fallback_id_generator_factory)()
}

fn is_mutation_method(method: &str) -> bool {
    matches!(
        method,
        "create"
            | "createMany"
            | "update"
            | "updateMany"
            | "delete"
            | "deleteMany"
            | "upsert"
            | "upsertMany"
            | "createWithRelationships"
            | "updateWithRelationships"
            | "deleteWithRelationships"
            | "deleteManyWithRelationships"
            | "transaction"
            | "reloadCollection"
            | "commitSnapshotTransaction"
    )
}

fn mutation_result_carries_owner_rows(method: &str) -> bool {
    matches!(
        method,
        "create"
            | "createMany"
            | "update"
            | "updateMany"
            | "upsertMany"
            | "createWithRelationships"
            | "updateWithRelationships"
    )
}

pub struct Runtime {
    inner: RuntimeCore,
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self::with_config(RuntimeConfig::default())
    }

    pub fn with_config(config: RuntimeConfig) -> Self {
        Self {
            inner: RuntimeCore::new(config),
        }
    }

    pub fn callbacks_mut(&mut self) -> &mut CallbackTable {
        &mut self.inner.callbacks
    }

    pub fn create_database_json(&mut self, input_json: &str) -> String {
        bridge::handle(|| {
            let input: CreateDatabaseInput = parse_json(input_json, "createDatabase")?;
            self.inner
                .create_database(input)
                .map(|handle| json!(handle))
        })
    }

    pub fn drop_database_json(&mut self, handle: u32) -> String {
        bridge::handle(|| Ok(json!(self.inner.drop_database(handle))))
    }

    pub fn dispatch_json(
        &mut self,
        handle: u32,
        method: &str,
        payload_json: Option<&str>,
    ) -> String {
        let response =
            bridge::handle(|| command::dispatch(&mut self.inner, handle, method, payload_json));
        self.finish_dispatch(handle, method, payload_json, &response);
        if is_mutation_method(method) {
            self.attach_projection_sync(handle, response)
        } else {
            response
        }
    }

    pub fn fast_find_by_id(
        &self,
        handle: u32,
        collection_index: u32,
        id: &str,
        expected_slot: u32,
        expected_generation: u32,
        expected_revision: u32,
    ) -> i32 {
        let Some(context) = self.inner.databases.get(&handle) else {
            return 0;
        };
        let Some(collection) = context.collection_names.get(collection_index as usize) else {
            return 0;
        };
        i32::from(context.projection.fast_find_authorized(
            &context.db,
            collection,
            id,
            expected_slot,
            expected_generation,
            expected_revision,
        ))
    }

    pub fn dispatch_projected_json(
        &mut self,
        handle: u32,
        method: &str,
        payload_json: Option<&str>,
    ) -> String {
        let parsed_payload =
            payload_json.and_then(|payload| serde_json::from_str::<Value>(payload).ok());
        let collection = parsed_payload
            .as_ref()
            .and_then(|payload| payload.get("collection"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let requested_id = parsed_payload
            .as_ref()
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let response = bridge::handle(|| {
            let result = command::dispatch(&mut self.inner, handle, method, payload_json)?;
            let Some(collection) = collection.as_deref() else {
                return Ok(result);
            };
            let context = self.inner.database_mut(handle)?;
            Ok(context.projection.describe_result(
                &context.db,
                method,
                collection,
                requested_id.as_deref(),
                result,
            ))
        });
        self.finish_dispatch(handle, method, payload_json, &response);
        response
    }

    fn finish_dispatch(
        &mut self,
        handle: u32,
        method: &str,
        payload_json: Option<&str>,
        response: &str,
    ) {
        if let Some(context) = self.inner.databases.get_mut(&handle) {
            let changes = context.db.take_committed_changes();
            let payload_collection = payload_json
                .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                .and_then(|payload| {
                    payload
                        .get("collection")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            if response.starts_with("{\"kind\":\"defect\"") {
                context.last_changes = ChangeSet::default();
                context
                    .projection
                    .replace_collections(&context.db, context.collection_names.iter().cloned());
                context.projection.invalidate();
                return;
            }
            if response.starts_with("{\"kind\":\"ok\"") && method == "reloadCollection" {
                let collection = payload_json
                    .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                    .and_then(|payload| {
                        payload
                            .get("collection")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    });
                context
                    .projection
                    .replace_collections(&context.db, collection);
            } else if response.starts_with("{\"kind\":\"ok\"")
                && method == "commitSnapshotTransaction"
            {
                let collections = serde_json::from_str::<Value>(response)
                    .ok()
                    .and_then(|response| response.get("value").cloned())
                    .and_then(|value| value.get("changedCollections").cloned())
                    .and_then(|collections| collections.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|collection| collection.as_str().map(str::to_owned));
                context
                    .projection
                    .replace_collections(&context.db, collections);
            } else {
                let observed_owner_collection = (response.starts_with("{\"kind\":\"ok\"")
                    && mutation_result_carries_owner_rows(method))
                .then_some(payload_collection.as_deref())
                .flatten();
                context
                    .projection
                    .apply_changes(&changes, observed_owner_collection);
                if response.starts_with("{\"kind\":\"ok\"") && method == "upsertMany" {
                    let unchanged = serde_json::from_str::<Value>(response)
                        .ok()
                        .and_then(|response| response.get("value").cloned())
                        .and_then(|value| value.get("unchanged").cloned())
                        .and_then(|values| values.as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .map(decode_boundary_input_value)
                        .collect::<Vec<_>>();
                    if let Some(collection) = payload_collection.as_deref() {
                        context.projection.observe_unchanged_values(
                            &context.db,
                            collection,
                            &unchanged,
                        );
                    }
                }
            }
            context.last_changes = changes;
        }
    }

    pub fn projection_handles_json(&mut self, handle: u32) -> String {
        bridge::handle(|| {
            let context = self.inner.databases.get_mut(&handle).ok_or_else(|| {
                EngineError::Operation(OperationError {
                    operation: "database".to_owned(),
                    reason: "unknown-handle".to_owned(),
                    message: format!("Unknown database handle {handle}"),
                })
            })?;
            context.projection.reset_materializations();
            Ok(context.projection.handles(&context.collection_names))
        })
    }

    /// Test-only bridge accessor. Production mutations carry this sync on the
    /// same response as their result/error/defect.
    pub fn projection_changes_json(&self, handle: u32) -> String {
        bridge::handle(|| {
            let context = self.inner.databases.get(&handle).ok_or_else(|| {
                EngineError::Operation(OperationError {
                    operation: "database".to_owned(),
                    reason: "unknown-handle".to_owned(),
                    message: format!("Unknown database handle {handle}"),
                })
            })?;
            Ok(context.projection.last_sync().clone())
        })
    }

    fn attach_projection_sync(&self, handle: u32, mut response: String) -> String {
        let Some(context) = self.inner.databases.get(&handle) else {
            return response;
        };
        let encoded = encode_boundary_output_value(context.projection.last_sync().clone());
        let Ok(sync_json) = serde_json::to_string(&encoded) else {
            return "{\"kind\":\"defect\",\"message\":\"failed to serialize projection sync\",\"projection\":{\"changes\":[],\"invalidated\":true}}".to_owned();
        };
        if response.pop() != Some('}') {
            return response;
        }
        response.push_str(",\"projection\":");
        response.push_str(&sync_json);
        response.push('}');
        response
    }

    pub fn synchronize_projection_json(&mut self, handle: u32, rows_json: &str) -> String {
        bridge::handle(|| {
            let rows: Value = parse_json(rows_json, "synchronizeProjection")?;
            let rows = rows.as_array().ok_or_else(|| {
                EngineError::Operation(OperationError {
                    operation: "synchronizeProjection".to_owned(),
                    reason: "invalid-payload".to_owned(),
                    message: "Expected an array of projected rows".to_owned(),
                })
            })?;
            let context = self.inner.database_mut(handle)?;
            for row in rows {
                let collection = row.get("collection").and_then(Value::as_str).unwrap_or("");
                let id = row.get("id").and_then(Value::as_str).unwrap_or("");
                let row_handle = row.get("handle").and_then(Value::as_str).unwrap_or("");
                if !context.projection.authorizes(collection, id, row_handle) {
                    return Err(EngineError::Operation(OperationError {
                        operation: "synchronizeProjection".to_owned(),
                        reason: "stale-materialized-handle".to_owned(),
                        message: format!("Stale materialized handle for '{collection}/{id}'"),
                    }));
                }
            }
            for row in rows {
                let collection = row["collection"].as_str().unwrap_or_default();
                let id = row["id"].as_str().unwrap_or_default();
                let value = row.get("value").cloned().unwrap_or(Value::Null);
                if !context
                    .db
                    .synchronize_materialized_value(collection, id, value)?
                {
                    return Err(EngineError::Operation(OperationError {
                        operation: "synchronizeProjection".to_owned(),
                        reason: "stale-materialized-handle".to_owned(),
                        message: format!("Missing materialized row '{collection}/{id}'"),
                    }));
                }
            }
            Ok(Value::Null)
        })
    }

    pub fn last_changes(&self, handle: u32) -> Option<&ChangeSet> {
        self.inner
            .databases
            .get(&handle)
            .map(|context| &context.last_changes)
    }

    pub fn dry_run_migrations_json(&mut self, input_json: &str) -> String {
        bridge::handle(|| {
            let input = parse_json(input_json, "dryRunMigrations")?;
            Ok(crate::types::dry_run_report_value(input))
        })
    }

    pub fn subscribe_watch_json(
        &mut self,
        handle: u32,
        command_json: &str,
        callback: impl Fn(Value) + Send + Sync + 'static,
    ) -> String {
        bridge::handle(|| command::subscribe_watch(&mut self.inner, handle, command_json, callback))
    }

    pub fn subscribe_watch_by_id_json(
        &mut self,
        handle: u32,
        command_json: &str,
        callback: impl Fn(Value) + Send + Sync + 'static,
    ) -> String {
        bridge::handle(|| {
            command::subscribe_watch_by_id(&mut self.inner, handle, command_json, callback)
        })
    }

    pub fn unsubscribe_json(&mut self, handle: u32, subscription_id: u32) -> String {
        bridge::handle(|| command::unsubscribe(&mut self.inner, handle, subscription_id))
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub struct WasmRuntime {
    inner: Rc<RefCell<Runtime>>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
impl WasmRuntime {
    #[wasm_bindgen::prelude::wasm_bindgen(constructor)]
    pub fn new(set_timeout: js_sys::Function, clear_timeout: js_sys::Function) -> Self {
        let config = RuntimeConfig {
            clock_factory: Arc::new(|| Box::new(WasmClock) as Box<dyn Clock>),
            fallback_id_generator_factory: Arc::new(|| {
                Box::new(WasmFallbackIdGenerator) as Box<dyn IdGenerator>
            }),
            reactive_scheduler_factory: crate::reactive::wasm_scheduler_factory(
                set_timeout,
                clear_timeout,
            ),
        };
        Self {
            inner: Rc::new(RefCell::new(Runtime::with_config(config))),
        }
    }

    pub fn register_default(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_default_js(id, callback);
    }

    pub fn register_predicate(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_predicate_js(id, callback);
    }

    pub fn register_computed(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_computed_js(id, callback);
    }

    pub fn register_collator(&self, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_collator_js(callback);
    }

    pub fn register_migration(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_migration_js(id, callback);
    }

    pub fn register_id_generator(&self, name: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_id_generator_js(name, callback);
    }

    pub fn register_lifecycle(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_lifecycle_js(id, callback);
    }

    pub fn register_codec_encode(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_codec_encode_js(id, callback);
    }

    pub fn register_codec_decode(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_codec_decode_js(id, callback);
    }

    pub fn register_before_create_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_before_create_hook_js(id, callback);
    }

    pub fn register_before_update_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_before_update_hook_js(id, callback);
    }

    pub fn register_before_delete_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_before_delete_hook_js(id, callback);
    }

    pub fn register_after_create_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_after_create_hook_js(id, callback);
    }

    pub fn register_after_update_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_after_update_hook_js(id, callback);
    }

    pub fn register_after_delete_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_after_delete_hook_js(id, callback);
    }

    pub fn register_on_change_hook(&self, id: String, callback: js_sys::Function) {
        self.inner
            .borrow_mut()
            .callbacks_mut()
            .register_on_change_hook_js(id, callback);
    }

    pub fn register_custom_operator(
        &self,
        name: String,
        supported_types_json: String,
        callback: js_sys::Function,
    ) -> String {
        bridge::handle(|| {
            self.inner
                .borrow_mut()
                .callbacks_mut()
                .register_custom_operator_js(name, supported_types_json, callback)?;
            Ok(json!(true))
        })
    }

    pub fn create_database(&self, input_json: String) -> String {
        self.inner
            .borrow_mut()
            .create_database_json(input_json.as_str())
    }

    pub fn drop_database(&self, handle: u32) -> String {
        self.inner.borrow_mut().drop_database_json(handle)
    }

    pub fn dispatch(&self, handle: u32, method: String, payload_json: Option<String>) -> String {
        self.inner
            .borrow_mut()
            .dispatch_json(handle, method.as_str(), payload_json.as_deref())
    }

    pub fn dispatch_projected(
        &self,
        handle: u32,
        method: String,
        payload_json: Option<String>,
    ) -> String {
        self.inner.borrow_mut().dispatch_projected_json(
            handle,
            method.as_str(),
            payload_json.as_deref(),
        )
    }

    pub fn fast_find_by_id(
        &self,
        handle: u32,
        collection_index: u32,
        id: String,
        expected_slot: u32,
        expected_generation: u32,
        expected_revision: u32,
    ) -> i32 {
        self.inner.try_borrow().map_or(0, |runtime| {
            runtime.fast_find_by_id(
                handle,
                collection_index,
                &id,
                expected_slot,
                expected_generation,
                expected_revision,
            )
        })
    }

    pub fn projection_handles(&self, handle: u32) -> String {
        self.inner.borrow_mut().projection_handles_json(handle)
    }

    pub fn synchronize_projection(&self, handle: u32, rows_json: String) -> String {
        self.inner
            .borrow_mut()
            .synchronize_projection_json(handle, &rows_json)
    }

    pub fn dry_run_migrations(&self, input_json: String) -> String {
        self.inner
            .borrow_mut()
            .dry_run_migrations_json(input_json.as_str())
    }

    pub fn subscribe_watch(
        &self,
        handle: u32,
        command_json: String,
        callback: js_sys::Function,
    ) -> String {
        self.inner
            .borrow_mut()
            .subscribe_watch_json(handle, command_json.as_str(), move |value| {
                let payload = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned());
                let _ = callback.call1(
                    &wasm_bindgen::JsValue::NULL,
                    &wasm_bindgen::JsValue::from_str(payload.as_str()),
                );
            })
    }

    pub fn subscribe_watch_by_id(
        &self,
        handle: u32,
        command_json: String,
        callback: js_sys::Function,
    ) -> String {
        self.inner.borrow_mut().subscribe_watch_by_id_json(
            handle,
            command_json.as_str(),
            move |value| {
                let payload = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned());
                let _ = callback.call1(
                    &wasm_bindgen::JsValue::NULL,
                    &wasm_bindgen::JsValue::from_str(payload.as_str()),
                );
            },
        )
    }

    pub fn unsubscribe(&self, handle: u32, subscription_id: u32) -> String {
        self.inner
            .borrow_mut()
            .unsubscribe_json(handle, subscription_id)
    }
}

#[cfg(target_arch = "wasm32")]
struct WasmClock;

#[cfg(target_arch = "wasm32")]
impl Clock for WasmClock {
    fn now_iso(&self) -> String {
        js_sys::Date::new_0().to_iso_string().into()
    }
}

#[cfg(target_arch = "wasm32")]
struct WasmFallbackIdGenerator;

#[cfg(target_arch = "wasm32")]
impl IdGenerator for WasmFallbackIdGenerator {
    fn generate(&mut self) -> String {
        let random = format!("{:016x}", (js_sys::Math::random() * u64::MAX as f64) as u64);
        format!("wasm-{random}")
    }
}
