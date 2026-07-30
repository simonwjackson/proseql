use std::cell::RefCell;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{
    mpsc::{self, Receiver, RecvError, Sender, TryRecvError},
    Arc, Condvar, Mutex, Weak,
};

#[cfg(not(target_arch = "wasm32"))]
use std::collections::VecDeque;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(not(target_arch = "wasm32"))]
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde::{de::MapAccess, ser::SerializeMap, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::callbacks::CallbackRegistry;
use crate::collection::{
    Collection, CreateManyResult, DeleteManyResult, SkippedEntry, UpdateManyResult, UpsertAction,
    UpsertManyResult, UpsertOutcome,
};
use crate::errors::{CollectionNotFoundError, EngineError, OperationError};
use crate::query::{
    apply_selection, matches_where_with_registry, paginate, sort_entities_with_registry, SortEntry,
    SortOrder,
};
use crate::relationships::{
    helpers::{col_nf, fk_field_names, payload_touches_fk_field, validate_fk_with_owner_snapshot},
    Database,
};

const DEFAULT_DEBOUNCE_MS: u64 = 10;
const UNSUPPORTED_WATCH_REASON: &str = "missing-reactive-scheduler";
const UNSUPPORTED_WATCH_MESSAGE: &str = "Reactive watch scheduling is unavailable on this target. Construct Database with Database::new_with_reactive_scheduler(...) and inject a host scheduler.";

thread_local! {
    static CURRENT_DELIVERIES: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

fn run_scheduler_job(job: Box<dyn FnOnce() + Send + 'static>) {
    let _ = panic::catch_unwind(AssertUnwindSafe(job));
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub collection: String,
    pub operation: ChangeOperation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOperation {
    Create,
    Update,
    Delete,
    Reload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactiveSchedulerAvailability {
    Available,
    Unsupported,
}

pub trait ReactiveTaskHandle: Send + Sync + 'static {
    fn cancel(&self);
}

struct NoopReactiveTaskHandle;

impl ReactiveTaskHandle for NoopReactiveTaskHandle {
    fn cancel(&self) {}
}

pub trait ReactiveScheduler: Send + Sync + 'static {
    fn availability(&self) -> ReactiveSchedulerAvailability {
        ReactiveSchedulerAvailability::Available
    }

    fn schedule(
        &self,
        delay_ms: u64,
        job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle>;

    fn pending_task_count(&self) -> usize {
        0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchQueryConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Value>,
    #[serde(
        default,
        with = "sort_entries_object",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub sort: Vec<SortEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debounce_ms: Option<i64>,
}

mod sort_entries_object {
    use super::*;

    pub fn serialize<S>(sort: &[SortEntry], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(sort.len()))?;
        for (field, order) in sort {
            let value = match order {
                SortOrder::Asc => "asc",
                SortOrder::Desc => "desc",
            };
            map.serialize_entry(field, value)?;
        }
        map.end()
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<SortEntry>, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Vec<SortEntry>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a sort object mapping field names to 'asc' or 'desc'")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::new();
                while let Some((field, order)) = map.next_entry::<String, SortOrder>()? {
                    entries.push((field, order));
                }
                Ok(entries)
            }
        }

        deserializer.deserialize_map(Visitor)
    }
}

#[derive(Default)]
pub struct ManualReactiveScheduler {
    state: Arc<Mutex<ManualSchedulerState>>,
}

#[derive(Default)]
struct ManualSchedulerState {
    now_ms: u64,
    next_id: u64,
    tasks: Vec<ManualTask>,
}

struct ManualTask {
    due_ms: u64,
    id: u64,
    job: Option<Box<dyn FnOnce() + Send + 'static>>,
}

struct ManualReactiveTaskHandle {
    state: Weak<Mutex<ManualSchedulerState>>,
    id: u64,
}

impl ReactiveTaskHandle for ManualReactiveTaskHandle {
    fn cancel(&self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let lock = state.lock();
        if let Ok(mut state) = lock {
            if let Some(index) = state.tasks.iter().position(|task| task.id == self.id) {
                state.tasks.swap_remove(index);
            }
        }
    }
}

impl ManualReactiveScheduler {
    pub fn advance(&self, millis: u64) {
        {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            state.now_ms = state.now_ms.saturating_add(millis);
        }
        self.run_due();
    }

    pub fn pending_task_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.tasks.len())
            .unwrap_or(0)
    }

    fn run_due(&self) {
        loop {
            let next_job = {
                let mut state = match self.state.lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                let now_ms = state.now_ms;
                let next_index = state
                    .tasks
                    .iter()
                    .enumerate()
                    .filter(|(_, task)| task.due_ms <= now_ms)
                    .min_by_key(|(_, task)| (task.due_ms, task.id))
                    .map(|(index, _)| index);
                next_index.and_then(|index| state.tasks.swap_remove(index).job)
            };

            match next_job {
                Some(job) => run_scheduler_job(job),
                None => break,
            }
        }
    }
}

impl ReactiveScheduler for ManualReactiveScheduler {
    fn schedule(
        &self,
        delay_ms: u64,
        job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle> {
        if delay_ms == 0 {
            run_scheduler_job(job);
            return Box::new(NoopReactiveTaskHandle);
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Box::new(NoopReactiveTaskHandle),
        };
        let id = state.next_id;
        state.next_id = state.next_id.saturating_add(1);
        let due_ms = state.now_ms.saturating_add(delay_ms);
        state.tasks.push(ManualTask {
            due_ms,
            id,
            job: Some(job),
        });
        Box::new(ManualReactiveTaskHandle {
            state: Arc::downgrade(&self.state),
            id,
        })
    }

    fn pending_task_count(&self) -> usize {
        ManualReactiveScheduler::pending_task_count(self)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct ThreadReactiveScheduler {
    shared: Arc<ThreadSchedulerShared>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[cfg(not(target_arch = "wasm32"))]
struct ThreadSchedulerShared {
    state: Mutex<ThreadSchedulerState>,
    condvar: Condvar,
    worker_spawn_count: AtomicUsize,
}

#[cfg(not(target_arch = "wasm32"))]
struct ThreadSchedulerState {
    shutdown: bool,
    next_id: u64,
    tasks: VecDeque<ThreadTask>,
}

#[cfg(not(target_arch = "wasm32"))]
struct ThreadTask {
    due_at: Instant,
    id: u64,
    job: Box<dyn FnOnce() + Send + 'static>,
}

#[cfg(not(target_arch = "wasm32"))]
struct ThreadReactiveTaskHandle {
    shared: Weak<ThreadSchedulerShared>,
    id: u64,
}

#[cfg(not(target_arch = "wasm32"))]
impl ReactiveTaskHandle for ThreadReactiveTaskHandle {
    fn cancel(&self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let lock = shared.state.lock();
        if let Ok(mut state) = lock {
            if let Some(index) = state.tasks.iter().position(|task| task.id == self.id) {
                state.tasks.remove(index);
                shared.condvar.notify_all();
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for ThreadReactiveScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ThreadReactiveScheduler {
    pub fn new() -> Self {
        let shared = Arc::new(ThreadSchedulerShared {
            state: Mutex::new(ThreadSchedulerState {
                shutdown: false,
                next_id: 1,
                tasks: VecDeque::new(),
            }),
            condvar: Condvar::new(),
            worker_spawn_count: AtomicUsize::new(0),
        });
        let worker_shared = Arc::clone(&shared);
        let handle = std::thread::spawn(move || worker_loop(worker_shared));
        shared.worker_spawn_count.store(1, Ordering::SeqCst);
        Self {
            shared,
            worker: Mutex::new(Some(handle)),
        }
    }

    pub fn worker_spawn_count(&self) -> usize {
        self.shared.worker_spawn_count.load(Ordering::SeqCst)
    }

    pub fn pending_task_count(&self) -> usize {
        self.shared
            .state
            .lock()
            .map(|state| state.tasks.len())
            .unwrap_or(0)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ReactiveScheduler for ThreadReactiveScheduler {
    fn schedule(
        &self,
        delay_ms: u64,
        job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle> {
        if delay_ms == 0 {
            run_scheduler_job(job);
            return Box::new(NoopReactiveTaskHandle);
        }

        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(_) => return Box::new(NoopReactiveTaskHandle),
        };
        if state.shutdown {
            return Box::new(NoopReactiveTaskHandle);
        }
        let id = state.next_id;
        state.next_id = state.next_id.saturating_add(1);
        insert_thread_task(
            &mut state.tasks,
            ThreadTask {
                due_at: Instant::now() + Duration::from_millis(delay_ms),
                id,
                job,
            },
        );
        self.shared.condvar.notify_one();
        Box::new(ThreadReactiveTaskHandle {
            shared: Arc::downgrade(&self.shared),
            id,
        })
    }

    fn pending_task_count(&self) -> usize {
        ThreadReactiveScheduler::pending_task_count(self)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for ThreadReactiveScheduler {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.shutdown = true;
            state.tasks.clear();
        }
        self.shared.condvar.notify_all();
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn insert_thread_task(tasks: &mut VecDeque<ThreadTask>, task: ThreadTask) {
    let index = tasks
        .iter()
        .position(|existing| (existing.due_at, existing.id) > (task.due_at, task.id))
        .unwrap_or(tasks.len());
    tasks.insert(index, task);
}

#[cfg(not(target_arch = "wasm32"))]
fn worker_loop(shared: Arc<ThreadSchedulerShared>) {
    loop {
        let next_job = {
            let mut state = match shared.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };

            loop {
                if state.shutdown {
                    return;
                }

                let Some(task) = state.tasks.front() else {
                    state = match shared.condvar.wait(state) {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                    continue;
                };

                let now = Instant::now();
                if task.due_at <= now {
                    break state.tasks.pop_front().map(|task| task.job);
                }

                let wait = task.due_at.saturating_duration_since(now);
                let (next_state, _) = match shared.condvar.wait_timeout(state, wait) {
                    Ok(result) => result,
                    Err(_) => return,
                };
                state = next_state;
            }
        };

        if let Some(job) = next_job {
            run_scheduler_job(job);
        }
    }
}

#[derive(Default)]
pub struct ImmediateReactiveScheduler;

impl ReactiveScheduler for ImmediateReactiveScheduler {
    fn schedule(
        &self,
        _delay_ms: u64,
        job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle> {
        run_scheduler_job(job);
        Box::new(NoopReactiveTaskHandle)
    }
}

#[derive(Default)]
pub struct UnsupportedReactiveScheduler;

impl ReactiveScheduler for UnsupportedReactiveScheduler {
    fn availability(&self) -> ReactiveSchedulerAvailability {
        ReactiveSchedulerAvailability::Unsupported
    }

    fn schedule(
        &self,
        _delay_ms: u64,
        _job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle> {
        Box::new(NoopReactiveTaskHandle)
    }
}

pub struct ChangeEventSubscription {
    receiver: Receiver<ChangeEvent>,
    _handle: SubscriptionHandle,
}

impl ChangeEventSubscription {
    pub fn recv(&self) -> Result<ChangeEvent, RecvError> {
        self.receiver.recv()
    }

    pub fn try_recv(&self) -> Result<ChangeEvent, TryRecvError> {
        self.receiver.try_recv()
    }
}

pub struct ValueSubscription {
    receiver: Receiver<Value>,
    state: Weak<Mutex<ReactiveState>>,
    registry: Arc<CallbackRegistry>,
    subscriber_id: u64,
    _handle: SubscriptionHandle,
}

impl ValueSubscription {
    pub fn recv(&self) -> Result<Value, RecvError> {
        if let Some(value) = self.take_initial_value() {
            return Ok(value);
        }
        self.receiver.recv()
    }

    pub fn try_recv(&self) -> Result<Value, TryRecvError> {
        if let Some(value) = self.take_initial_value() {
            return Ok(value);
        }
        self.receiver.try_recv()
    }

    fn take_initial_value(&self) -> Option<Value> {
        let state = self.state.upgrade()?;
        take_initial_watch_output(&state, &self.registry, self.subscriber_id)
    }
}

pub struct CallbackSubscription {
    _handle: SubscriptionHandle,
}

enum SubscriptionKind {
    Event,
    Watch,
}

struct SubscriptionHandle {
    state: Weak<Mutex<ReactiveState>>,
    kind: SubscriptionKind,
    id: u64,
    callback_gate: Option<Arc<DeliveryGate>>,
}

impl Drop for SubscriptionHandle {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            if let Ok(mut state) = state.lock() {
                match self.kind {
                    SubscriptionKind::Event => {
                        state.event_subscribers.shift_remove(&self.id);
                    }
                    SubscriptionKind::Watch => {
                        if let Some(mut subscriber) = state.watch_subscribers.shift_remove(&self.id)
                        {
                            if let Some(handle) = subscriber.pending_task.take() {
                                handle.cancel();
                            }
                        }
                    }
                }
            }
        }

        if let Some(gate) = &self.callback_gate {
            gate.deactivate_and_wait(self.id);
        }
    }
}

struct DeliveryGate {
    state: Mutex<DeliveryGateState>,
    condvar: Condvar,
}

struct DeliveryGateState {
    active: bool,
    delivering: usize,
}

impl DeliveryGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(DeliveryGateState {
                active: true,
                delivering: 0,
            }),
            condvar: Condvar::new(),
        }
    }

    fn begin(&self) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        if !state.active {
            return false;
        }
        state.delivering = state.delivering.saturating_add(1);
        true
    }

    fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.delivering = state.delivering.saturating_sub(1);
            self.condvar.notify_all();
        }
    }

    fn deactivate_and_wait(&self, subscriber_id: u64) {
        let dropping_inside_callback =
            CURRENT_DELIVERIES.with(|stack| stack.borrow().contains(&subscriber_id));

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.active = false;
        if dropping_inside_callback {
            return;
        }
        while state.delivering > 0 {
            state = match self.condvar.wait(state) {
                Ok(state) => state,
                Err(_) => return,
            };
        }
    }
}

#[derive(Clone)]
enum EventSink {
    Channel(Sender<ChangeEvent>),
    Callback {
        callback: Arc<dyn Fn(ChangeEvent) + Send + Sync>,
        gate: Arc<DeliveryGate>,
    },
}

#[derive(Clone)]
enum WatchSink {
    Channel(Sender<Value>),
    Callback {
        callback: Arc<dyn Fn(Value) + Send + Sync>,
        gate: Arc<DeliveryGate>,
    },
}

#[derive(Clone)]
enum WatchMode {
    Query,
    ById { id: String },
}

struct ChannelDeliveryState {
    buffered: Option<Value>,
}

struct WatchSubscriber {
    collection: String,
    config: WatchQueryConfig,
    mode: WatchMode,
    generation: u64,
    initial_pending: bool,
    last_serialized: Option<String>,
    sink: WatchSink,
    channel_state: Option<ChannelDeliveryState>,
    pending_task: Option<Box<dyn ReactiveTaskHandle>>,
}

struct ReactiveState {
    next_subscription_id: u64,
    snapshots: IndexMap<String, Vec<Value>>,
    event_subscribers: IndexMap<u64, EventSink>,
    watch_subscribers: IndexMap<u64, WatchSubscriber>,
}

pub(crate) struct ReactiveHub {
    state: Arc<Mutex<ReactiveState>>,
    scheduler: Arc<dyn ReactiveScheduler>,
    registry: Arc<CallbackRegistry>,
}

impl ReactiveHub {
    pub(crate) fn new(
        collections: &IndexMap<String, Collection>,
        registry: Arc<CallbackRegistry>,
        scheduler: Arc<dyn ReactiveScheduler>,
    ) -> Self {
        let snapshots = collections
            .iter()
            .map(|(name, collection)| (name.clone(), snapshot_collection(collection)))
            .collect();
        Self {
            state: Arc::new(Mutex::new(ReactiveState {
                next_subscription_id: 1,
                snapshots,
                event_subscribers: IndexMap::new(),
                watch_subscribers: IndexMap::new(),
            })),
            scheduler,
            registry,
        }
    }

    pub(crate) fn sync_all_snapshots(&self, collections: &IndexMap<String, Collection>) {
        if let Ok(mut state) = self.state.lock() {
            state.snapshots = collections
                .iter()
                .map(|(name, collection)| (name.clone(), snapshot_collection(collection)))
                .collect();
        }
    }

    pub(crate) fn event_subscription_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.event_subscribers.len())
            .unwrap_or(0)
    }

    pub(crate) fn watch_subscription_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.watch_subscribers.len())
            .unwrap_or(0)
    }

    pub(crate) fn subscribe_change_events(&self) -> ChangeEventSubscription {
        let (sender, receiver) = mpsc::channel();
        let id = self.register_event_subscriber(EventSink::Channel(sender));
        ChangeEventSubscription {
            receiver,
            _handle: self.make_handle(SubscriptionKind::Event, id, None),
        }
    }

    pub(crate) fn subscribe_change_events_with_callback(
        &self,
        callback: Box<dyn Fn(ChangeEvent) + Send + Sync>,
    ) -> CallbackSubscription {
        let gate = Arc::new(DeliveryGate::new());
        let id = self.register_event_subscriber(EventSink::Callback {
            callback: Arc::from(callback),
            gate: Arc::clone(&gate),
        });
        CallbackSubscription {
            _handle: self.make_handle(SubscriptionKind::Event, id, Some(gate)),
        }
    }

    fn register_event_subscriber(&self, sink: EventSink) -> u64 {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let id = state.next_subscription_id;
        state.next_subscription_id = state.next_subscription_id.saturating_add(1);
        state.event_subscribers.insert(id, sink);
        id
    }

    pub(crate) fn subscribe_watch(
        &self,
        collection: &str,
        config: WatchQueryConfig,
    ) -> Result<ValueSubscription, EngineError> {
        self.ensure_watch_supported("watch")?;
        self.subscribe_watch_internal(collection, config, WatchMode::Query)
    }

    pub(crate) fn subscribe_watch_by_id(
        &self,
        collection: &str,
        id: &str,
        debounce_ms: Option<i64>,
    ) -> Result<ValueSubscription, EngineError> {
        self.ensure_watch_supported("watchById")?;
        self.subscribe_watch_internal(
            collection,
            WatchQueryConfig {
                debounce_ms,
                ..WatchQueryConfig::default()
            },
            WatchMode::ById { id: id.to_owned() },
        )
    }

    pub(crate) fn subscribe_watch_with_callback(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        self.ensure_watch_supported("watch")?;
        self.subscribe_watch_with_callback_internal(collection, config, WatchMode::Query, callback)
    }

    pub(crate) fn subscribe_watch_by_id_with_callback(
        &self,
        collection: &str,
        id: &str,
        debounce_ms: Option<i64>,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        self.ensure_watch_supported("watchById")?;
        self.subscribe_watch_with_callback_internal(
            collection,
            WatchQueryConfig {
                debounce_ms,
                ..WatchQueryConfig::default()
            },
            WatchMode::ById { id: id.to_owned() },
            callback,
        )
    }

    fn ensure_watch_supported(&self, operation: &str) -> Result<(), EngineError> {
        if self.scheduler.availability() == ReactiveSchedulerAvailability::Available {
            Ok(())
        } else {
            Err(unsupported_watch_error(operation))
        }
    }

    fn subscribe_watch_internal(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        mode: WatchMode,
    ) -> Result<ValueSubscription, EngineError> {
        let (sender, receiver) = mpsc::channel();
        let id =
            self.register_watch_subscriber(collection, config, mode, WatchSink::Channel(sender))?;
        Ok(ValueSubscription {
            receiver,
            state: Arc::downgrade(&self.state),
            registry: Arc::clone(&self.registry),
            subscriber_id: id,
            _handle: self.make_handle(SubscriptionKind::Watch, id, None),
        })
    }

    fn subscribe_watch_with_callback_internal(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        mode: WatchMode,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        let gate = Arc::new(DeliveryGate::new());
        let callback = Arc::<dyn Fn(Value) + Send + Sync>::from(callback);
        let sink = WatchSink::Callback {
            callback: Arc::clone(&callback),
            gate: Arc::clone(&gate),
        };
        let id = self.register_watch_subscriber(collection, config, mode, sink.clone())?;
        if let Some(initial_output) = take_initial_watch_output(&self.state, &self.registry, id) {
            let _ = deliver_watch_sink(id, &sink, initial_output);
        }
        Ok(CallbackSubscription {
            _handle: self.make_handle(SubscriptionKind::Watch, id, Some(gate)),
        })
    }

    fn register_watch_subscriber(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        mode: WatchMode,
        sink: WatchSink,
    ) -> Result<u64, EngineError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .snapshots
            .get(collection)
            .ok_or_else(|| missing_collection_error(collection))?;
        let id = state.next_subscription_id;
        state.next_subscription_id = state.next_subscription_id.saturating_add(1);
        let channel_state = match &sink {
            WatchSink::Channel(_) => Some(ChannelDeliveryState { buffered: None }),
            WatchSink::Callback { .. } => None,
        };
        state.watch_subscribers.insert(
            id,
            WatchSubscriber {
                collection: collection.to_owned(),
                config,
                mode,
                generation: 0,
                initial_pending: true,
                last_serialized: None,
                sink,
                channel_state,
                pending_task: None,
            },
        );
        Ok(id)
    }

    pub(crate) fn publish(&self, event: ChangeEvent) {
        let event_deliveries = {
            let state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            state
                .event_subscribers
                .iter()
                .map(|(id, sink)| (*id, sink.clone()))
                .collect::<Vec<_>>()
        };

        let mut dead_event_ids = Vec::new();
        for (id, sink) in event_deliveries {
            if !deliver_event_sink(id, &sink, event.clone()) {
                dead_event_ids.push(id);
            }
        }

        let (immediate_jobs, delayed_jobs) = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            for id in dead_event_ids {
                state.event_subscribers.shift_remove(&id);
            }

            let mut immediate_jobs = Vec::new();
            let mut delayed_jobs = Vec::new();
            for (id, subscriber) in &mut state.watch_subscribers {
                if subscriber.collection != event.collection {
                    continue;
                }
                if let Some(handle) = subscriber.pending_task.take() {
                    handle.cancel();
                }
                subscriber.generation = subscriber.generation.saturating_add(1);
                let generation = subscriber.generation;
                let delay_ms = clamp_debounce_ms(subscriber.config.debounce_ms);
                if delay_ms == 0 {
                    immediate_jobs.push((*id, generation));
                } else {
                    delayed_jobs.push((*id, generation, delay_ms));
                }
            }
            (immediate_jobs, delayed_jobs)
        };

        for (id, generation) in immediate_jobs {
            emit_watch_if_current(
                Arc::clone(&self.state),
                Arc::clone(&self.registry),
                id,
                generation,
            );
        }

        for (id, generation, delay_ms) in delayed_jobs {
            let state_arc = Arc::clone(&self.state);
            let registry = Arc::clone(&self.registry);
            let handle = self.scheduler.schedule(
                delay_ms,
                Box::new(move || emit_watch_if_current(state_arc, registry, id, generation)),
            );
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let Some(subscriber) = state.watch_subscribers.get_mut(&id) else {
                handle.cancel();
                continue;
            };
            if subscriber.generation != generation {
                handle.cancel();
                continue;
            }
            subscriber.pending_task = Some(handle);
        }
    }

    fn make_handle(
        &self,
        kind: SubscriptionKind,
        id: u64,
        callback_gate: Option<Arc<DeliveryGate>>,
    ) -> SubscriptionHandle {
        SubscriptionHandle {
            state: Arc::downgrade(&self.state),
            kind,
            id,
            callback_gate,
        }
    }
}

fn snapshot_collection(collection: &Collection) -> Vec<Value> {
    collection.list().into_iter().cloned().collect()
}

fn clamp_debounce_ms(debounce_ms: Option<i64>) -> u64 {
    match debounce_ms {
        None => DEFAULT_DEBOUNCE_MS,
        Some(value) if value <= 0 => 0,
        Some(value) => value as u64,
    }
}

fn take_initial_watch_output(
    state: &Arc<Mutex<ReactiveState>>,
    registry: &CallbackRegistry,
    subscriber_id: u64,
) -> Option<Value> {
    loop {
        let (generation, collection, config, mode) = {
            let mut state_guard = state.lock().ok()?;
            let subscriber = state_guard.watch_subscribers.get_mut(&subscriber_id)?;
            if !subscriber.initial_pending {
                return None;
            }
            if let Some(channel_state) = subscriber.channel_state.as_mut() {
                if let Some(buffered) = channel_state.buffered.take() {
                    subscriber.initial_pending = false;
                    return Some(buffered);
                }
            }
            (
                subscriber.generation,
                subscriber.collection.clone(),
                subscriber.config.clone(),
                subscriber.mode.clone(),
            )
        };
        let snapshot = {
            let state_guard = state.lock().ok()?;
            state_guard.snapshots.get(&collection)?.clone()
        };

        let array_result = evaluate_watch_array(&snapshot, &config, registry, &mode);
        let serialized = serialize_value(&Value::Array(array_result.clone()));
        let output = map_watch_output(&mode, &array_result);

        let mut state_guard = state.lock().ok()?;
        let subscriber = state_guard.watch_subscribers.get_mut(&subscriber_id)?;
        if !subscriber.initial_pending {
            return None;
        }
        if let Some(channel_state) = subscriber.channel_state.as_mut() {
            if let Some(buffered) = channel_state.buffered.take() {
                subscriber.initial_pending = false;
                return Some(buffered);
            }
        }
        if subscriber.generation != generation {
            continue;
        }
        subscriber.last_serialized = Some(serialized);
        subscriber.initial_pending = false;
        return Some(output);
    }
}

fn evaluate_watch_array(
    snapshot: &[Value],
    config: &WatchQueryConfig,
    registry: &CallbackRegistry,
    mode: &WatchMode,
) -> Vec<Value> {
    let mut values = snapshot.to_vec();

    match mode {
        WatchMode::Query => {
            if let Some(where_clause) = &config.r#where {
                values.retain(|value| {
                    matches_where_with_registry(value, where_clause, Some(registry))
                });
            }
        }
        WatchMode::ById { id } => {
            values.retain(|value| value.get("id").and_then(Value::as_str) == Some(id.as_str()));
        }
    }

    sort_entities_with_registry(&mut values, &config.sort, Some(registry));
    let values = paginate(&values, config.offset, config.limit);
    values
        .iter()
        .map(|value| apply_selection(value, config.select.as_ref()))
        .collect()
}

fn map_watch_output(mode: &WatchMode, array_result: &[Value]) -> Value {
    match mode {
        WatchMode::Query => Value::Array(array_result.to_vec()),
        WatchMode::ById { .. } => array_result.first().cloned().unwrap_or(Value::Null),
    }
}

fn serialize_value(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

fn deliver_event_sink(subscriber_id: u64, sink: &EventSink, event: ChangeEvent) -> bool {
    match sink {
        EventSink::Channel(sender) => sender.send(event).is_ok(),
        EventSink::Callback { callback, gate } => {
            deliver_callback(subscriber_id, gate, || callback(event))
        }
    }
}

fn deliver_watch_sink(subscriber_id: u64, sink: &WatchSink, value: Value) -> bool {
    match sink {
        WatchSink::Channel(sender) => sender.send(value).is_ok(),
        WatchSink::Callback { callback, gate } => {
            deliver_callback(subscriber_id, gate, || callback(value))
        }
    }
}

fn deliver_callback(subscriber_id: u64, gate: &DeliveryGate, invoke: impl FnOnce()) -> bool {
    if !gate.begin() {
        return false;
    }

    struct DeliveryGuard<'a> {
        gate: &'a DeliveryGate,
        subscriber_id: u64,
    }

    impl Drop for DeliveryGuard<'_> {
        fn drop(&mut self) {
            CURRENT_DELIVERIES.with(|stack| {
                let mut stack = stack.borrow_mut();
                if let Some(index) = stack
                    .iter()
                    .rposition(|current| *current == self.subscriber_id)
                {
                    stack.remove(index);
                }
            });
            self.gate.finish();
        }
    }

    CURRENT_DELIVERIES.with(|stack| stack.borrow_mut().push(subscriber_id));
    let _guard = DeliveryGuard {
        gate,
        subscriber_id,
    };
    panic::catch_unwind(AssertUnwindSafe(invoke)).is_ok()
}

fn emit_watch_if_current(
    state: Arc<Mutex<ReactiveState>>,
    registry: Arc<CallbackRegistry>,
    subscriber_id: u64,
    generation: u64,
) {
    let (sink, mode, config, snapshot, last_serialized) = {
        let mut state_guard = match state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let (collection, sink, mode, config, last_serialized) = {
            let Some(subscriber) = state_guard.watch_subscribers.get_mut(&subscriber_id) else {
                return;
            };
            if subscriber.generation != generation {
                return;
            }
            subscriber.pending_task = None;
            (
                subscriber.collection.clone(),
                subscriber.sink.clone(),
                subscriber.mode.clone(),
                subscriber.config.clone(),
                subscriber.last_serialized.clone(),
            )
        };
        let Some(snapshot) = state_guard.snapshots.get(&collection) else {
            return;
        };
        (sink, mode, config, snapshot.clone(), last_serialized)
    };

    let array_result = evaluate_watch_array(&snapshot, &config, &registry, &mode);
    let serialized_array = serialize_value(&Value::Array(array_result.clone()));
    if last_serialized.as_ref() == Some(&serialized_array) {
        return;
    }
    let output = map_watch_output(&mode, &array_result);

    let should_deliver = {
        let mut state_guard = match state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let Some(subscriber) = state_guard.watch_subscribers.get_mut(&subscriber_id) else {
            return;
        };
        if subscriber.generation != generation {
            return;
        }
        subscriber.last_serialized = Some(serialized_array);
        match &subscriber.sink {
            WatchSink::Channel(_) => {
                if subscriber.initial_pending {
                    if let Some(channel_state) = subscriber.channel_state.as_mut() {
                        channel_state.buffered = Some(output.clone());
                        false
                    } else {
                        subscriber.initial_pending = false;
                        true
                    }
                } else {
                    true
                }
            }
            WatchSink::Callback { .. } => {
                subscriber.initial_pending = false;
                true
            }
        }
    };

    if !should_deliver {
        return;
    }

    if !deliver_watch_sink(subscriber_id, &sink, output) {
        if let Ok(mut state_guard) = state.lock() {
            state_guard.watch_subscribers.shift_remove(&subscriber_id);
        }
    }
}

fn unsupported_watch_error(operation: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_owned(),
        reason: UNSUPPORTED_WATCH_REASON.to_owned(),
        message: UNSUPPORTED_WATCH_MESSAGE.to_owned(),
    })
}

fn missing_collection_error(collection: &str) -> EngineError {
    EngineError::CollectionNotFound(CollectionNotFoundError {
        collection: collection.to_owned(),
        message: format!("Collection '{}' not found", collection),
    })
}

fn fk_skip_reason(error: &EngineError) -> String {
    match error {
        EngineError::ForeignKey(error) => format!("Foreign key violation: {}", error.message),
        other => format!("Foreign key violation: {other}"),
    }
}

impl Database {
    pub fn new_with_reactive_scheduler(
        collections: IndexMap<String, Collection>,
        registry: Arc<CallbackRegistry>,
        scheduler: Arc<dyn ReactiveScheduler>,
    ) -> Self {
        let reactive = ReactiveHub::new(&collections, Arc::clone(&registry), scheduler);
        Self {
            collections,
            registry,
            reactive,
            active_transaction_kind: crate::transactions::ActiveTransactionKind::None,
            reactive_event_suppression_depth: 0,
        }
    }

    pub fn subscribe_change_events(&self) -> ChangeEventSubscription {
        self.reactive.subscribe_change_events()
    }

    pub fn subscribe_change_events_with_callback(
        &self,
        callback: Box<dyn Fn(ChangeEvent) + Send + Sync>,
    ) -> CallbackSubscription {
        self.reactive
            .subscribe_change_events_with_callback(callback)
    }

    pub fn watch(
        &self,
        collection: &str,
        config: WatchQueryConfig,
    ) -> Result<ValueSubscription, EngineError> {
        self.reactive.subscribe_watch(collection, config)
    }

    pub fn watch_with_callback(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        self.reactive
            .subscribe_watch_with_callback(collection, config, callback)
    }

    pub fn watch_by_id(
        &self,
        collection: &str,
        id: &str,
        debounce_ms: Option<i64>,
    ) -> Result<ValueSubscription, EngineError> {
        self.reactive
            .subscribe_watch_by_id(collection, id, debounce_ms)
    }

    pub fn watch_by_id_with_callback(
        &self,
        collection: &str,
        id: &str,
        debounce_ms: Option<i64>,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        self.reactive
            .subscribe_watch_by_id_with_callback(collection, id, debounce_ms, callback)
    }

    pub fn event_subscription_count(&self) -> usize {
        self.reactive.event_subscription_count()
    }

    pub fn watch_subscription_count(&self) -> usize {
        self.reactive.watch_subscription_count()
    }

    pub fn publish_change_event(&self, event: ChangeEvent) {
        self.reactive.publish(event);
    }

    pub fn reload_collection(
        &mut self,
        collection: &str,
        records: Vec<Value>,
    ) -> Result<(), EngineError> {
        self.collections
            .get_mut(collection)
            .ok_or_else(|| missing_collection_error(collection))?
            .replace_loaded_records(records)?;

        self.reactive.sync_all_snapshots(&self.collections);
        self.reactive.publish(ChangeEvent {
            collection: collection.to_owned(),
            operation: ChangeOperation::Reload,
        });
        Ok(())
    }

    pub fn create_many(
        &mut self,
        collection: &str,
        inputs: Vec<Value>,
        skip_duplicates: bool,
    ) -> Result<CreateManyResult, EngineError> {
        let relationships = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_state();

        let internal = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .create_many_internal(inputs, skip_duplicates)?;
        let mut result = internal.result;

        if skip_duplicates {
            let mut valid_created: Vec<Value> = Vec::new();
            let mut invalid_ids: Vec<String> = Vec::new();
            for entity in result.created {
                match validate_fk_with_owner_snapshot(
                    collection,
                    &relationships,
                    &entity,
                    &snapshot,
                    &self.collections,
                ) {
                    Ok(()) => valid_created.push(entity),
                    Err(error) => {
                        if let Some(id) = entity.get("id").and_then(Value::as_str) {
                            invalid_ids.push(id.to_owned());
                        }
                        result.skipped.push(SkippedEntry {
                            data: entity,
                            reason: fk_skip_reason(&error),
                        });
                    }
                }
            }
            if let Some(owner) = self.collections.get_mut(collection) {
                for id in invalid_ids {
                    owner.delete_raw(&id);
                }
            }
            result.created = valid_created;
        } else if let Some(error) = result.created.iter().find_map(|entity| {
            validate_fk_with_owner_snapshot(
                collection,
                &relationships,
                entity,
                &snapshot,
                &self.collections,
            )
            .err()
        }) {
            if let Some(owner) = self.collections.get_mut(collection) {
                owner.restore_state(snapshot);
            }
            return Err(error);
        }

        if let Some(owner) = self.collections.get(collection) {
            for entity in &result.created {
                owner.run_after_create_entity(entity.clone());
            }
        }
        self.sync_reactive_snapshots();
        if !result.created.is_empty() {
            self.emit_owner_change_event(collection, ChangeOperation::Create);
        }
        Ok(result)
    }

    pub fn update_many(
        &mut self,
        collection: &str,
        where_clause: Value,
        updates: Value,
    ) -> Result<UpdateManyResult, EngineError> {
        let relationships = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_state();
        let internal = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .update_many_internal(
                |entity| {
                    matches_where_with_registry(entity, &where_clause, Some(self.registry.as_ref()))
                },
                updates,
            )?;
        let result = internal.result;

        if internal
            .contexts
            .iter()
            .any(|(_, _, _, transformed_updates)| {
                payload_touches_fk_field(transformed_updates, &fk_field_names(&relationships))
            })
        {
            if let Some(error) = result.updated.iter().find_map(|entity| {
                validate_fk_with_owner_snapshot(
                    collection,
                    &relationships,
                    entity,
                    &snapshot,
                    &self.collections,
                )
                .err()
            }) {
                if let Some(owner) = self.collections.get_mut(collection) {
                    owner.restore_state(snapshot);
                }
                return Err(error);
            }
        }

        if let Some(owner) = self.collections.get(collection) {
            for (id, previous, current, transformed_updates) in &internal.contexts {
                owner.run_after_update_context(
                    id,
                    previous.clone(),
                    current.clone(),
                    transformed_updates.clone(),
                );
            }
        }
        self.sync_reactive_snapshots();
        if result.count > 0 {
            self.emit_owner_change_event(collection, ChangeOperation::Update);
        }
        Ok(result)
    }

    pub fn delete_many(
        &mut self,
        collection: &str,
        where_clause: Value,
        soft: bool,
        limit: Option<usize>,
    ) -> Result<DeleteManyResult, EngineError> {
        let result = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .delete_many(
                |entity| {
                    matches_where_with_registry(entity, &where_clause, Some(self.registry.as_ref()))
                },
                soft,
                limit,
            )?;

        self.sync_reactive_snapshots();
        if result.count > 0 {
            self.emit_owner_change_event(collection, ChangeOperation::Delete);
        }
        Ok(result)
    }

    pub fn upsert(
        &mut self,
        collection: &str,
        where_clause: Value,
        create_data: Value,
        update_data: Value,
    ) -> Result<UpsertOutcome, EngineError> {
        let relationships = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_state();
        let internal = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .upsert_internal(where_clause, create_data, update_data)?;
        let result = internal.result;

        let should_validate = match &internal.post {
            crate::collection::InternalUpsertPost::Created(_) => true,
            crate::collection::InternalUpsertPost::Updated {
                transformed_updates,
                ..
            } => payload_touches_fk_field(transformed_updates, &fk_field_names(&relationships)),
        };

        if should_validate {
            if let Err(error) = validate_fk_with_owner_snapshot(
                collection,
                &relationships,
                &result.entity,
                &snapshot,
                &self.collections,
            ) {
                if let Some(owner) = self.collections.get_mut(collection) {
                    owner.restore_state(snapshot);
                }
                return Err(error);
            }
        }

        if let Some(owner) = self.collections.get(collection) {
            match &internal.post {
                crate::collection::InternalUpsertPost::Created(entity) => {
                    owner.run_after_create_entity(entity.clone())
                }
                crate::collection::InternalUpsertPost::Updated {
                    id,
                    previous,
                    current,
                    transformed_updates,
                } => owner.run_after_update_context(
                    id,
                    previous.clone(),
                    current.clone(),
                    transformed_updates.clone(),
                ),
            }
        }
        self.sync_reactive_snapshots();
        self.emit_owner_change_event(
            collection,
            match result.action {
                UpsertAction::Created => ChangeOperation::Create,
                UpsertAction::Updated => ChangeOperation::Update,
            },
        );
        Ok(result)
    }

    pub fn upsert_many(
        &mut self,
        collection: &str,
        inputs: Vec<(Value, Value, Value)>,
    ) -> Result<UpsertManyResult, EngineError> {
        let relationships = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_state();
        let internal = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .upsert_many_internal(inputs)?;
        let result = internal.result;

        let created_error = result.created.iter().find_map(|entity| {
            validate_fk_with_owner_snapshot(
                collection,
                &relationships,
                entity,
                &snapshot,
                &self.collections,
            )
            .err()
        });
        let updated_error = result.updated.iter().find_map(|entity| {
            validate_fk_with_owner_snapshot(
                collection,
                &relationships,
                entity,
                &snapshot,
                &self.collections,
            )
            .err()
        });
        if let Some(error) = created_error.or(updated_error) {
            if let Some(owner) = self.collections.get_mut(collection) {
                owner.restore_state(snapshot);
            }
            return Err(error);
        }

        if let Some(owner) = self.collections.get(collection) {
            for entity in &internal.created_contexts {
                owner.run_after_create_entity(entity.clone());
            }
            for (id, previous, current, updates) in &internal.updated_contexts {
                owner.run_after_update_context(
                    id,
                    previous.clone(),
                    current.clone(),
                    updates.clone(),
                );
            }
        }
        self.sync_reactive_snapshots();
        if !result.created.is_empty() {
            self.emit_owner_change_event(collection, ChangeOperation::Create);
        }
        if !result.updated.is_empty() {
            self.emit_owner_change_event(collection, ChangeOperation::Update);
        }
        Ok(result)
    }

    pub(crate) fn sync_reactive_snapshots(&self) {
        self.reactive.sync_all_snapshots(&self.collections);
    }

    pub(crate) fn emit_owner_change_event(&self, collection: &str, operation: ChangeOperation) {
        if self.reactive_event_suppression_depth > 0 {
            return;
        }
        self.reactive.publish(ChangeEvent {
            collection: collection.to_owned(),
            operation,
        });
    }
}
