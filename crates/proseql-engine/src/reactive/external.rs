//! Native hosts can publish an already evaluated query without retaining its
//! source collection. Delivery, debounce and subscription lifetimes still use
//! the engine's ordinary reactive machinery.
use super::*;

/// Cloneable publication capability, so a host can release its state lock
/// before invoking change callbacks.
pub struct ChangeEventPublisher {
    hub: ReactiveHub,
}

impl ChangeEventPublisher {
    pub fn new(database: &Database) -> Self {
        let hub = &database.reactive;
        Self {
            hub: ReactiveHub {
                state: Arc::clone(&hub.state),
                scheduler: Arc::clone(&hub.scheduler),
                registry: Arc::clone(&hub.registry),
            },
        }
    }

    pub fn publish(&self, event: ChangeEvent) {
        self.hub.publish(event);
    }
}

pub struct ExternalWatch {
    hub: ReactiveHub,
    config: WatchQueryConfig,
    revision: std::sync::atomic::AtomicU64,
}

impl ExternalWatch {
    /// Share the database scheduler so dropping a host watch never joins a
    /// private scheduler worker while the host lock is held.
    pub fn from_database(
        initial: Vec<Value>,
        debounce_ms: Option<i64>,
        database: &Database,
    ) -> Self {
        Self::new(
            initial,
            debounce_ms,
            Arc::clone(&database.reactive.registry),
            Arc::clone(&database.reactive.scheduler),
        )
    }

    pub fn new(
        initial: Vec<Value>,
        debounce_ms: Option<i64>,
        registry: Arc<CallbackRegistry>,
        scheduler: Arc<dyn ReactiveScheduler>,
    ) -> Self {
        let hub = ReactiveHub::new(&IndexMap::new(), registry, scheduler);
        hub.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshots
            .insert(String::new(), initial);
        Self {
            hub,
            revision: std::sync::atomic::AtomicU64::new(0),
            config: WatchQueryConfig {
                debounce_ms,
                ..Default::default()
            },
        }
    }

    pub fn subscribe(&self) -> Result<ValueSubscription, EngineError> {
        self.hub.ensure_watch_supported("watch")?;
        self.hub
            .subscribe_watch_internal("", self.config.clone(), WatchMode::Query)
    }

    /// Register now; call `deliver_initial` outside the host's state lock.
    pub fn subscribe_callback(
        &self,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<CallbackSubscription, EngineError> {
        self.hub.ensure_watch_supported("watch")?;
        let gate = Arc::new(DeliveryGate::new());
        let sink = WatchSink::Callback {
            callback: Arc::new(move |delivery| {
                if let WatchDelivery::Value(value) = delivery {
                    callback(value);
                }
            }),
            gate: Arc::clone(&gate),
        };
        let id =
            self.hub
                .register_watch_subscriber("", self.config.clone(), WatchMode::Query, sink)?;
        Ok(CallbackSubscription {
            _handle: self
                .hub
                .make_handle(SubscriptionKind::Watch, id, Some(gate)),
        })
    }

    pub fn deliver_initial(&self) {
        let sinks = self
            .hub
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .watch_subscribers
            .iter()
            .map(|(id, subscriber)| (*id, subscriber.sink.clone()))
            .collect::<Vec<_>>();
        for (id, sink) in sinks {
            if let Some(delivery) =
                take_initial_watch_delivery(&self.hub.state, &self.hub.registry, id)
            {
                let _ = deliver_watch_sink(id, &sink, delivery);
            }
        }
    }

    pub fn is_active(&self) -> bool {
        self.hub.watch_subscription_count() != 0
    }

    /// Ignore a slower scan that finished after a newer host revision.
    pub fn replace(&self, revision: u64, result: Vec<Value>) {
        let mut state = self.hub.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.watch_subscribers.is_empty()
            || revision < self.revision.load(std::sync::atomic::Ordering::Relaxed)
        {
            return;
        }
        self.revision
            .store(revision, std::sync::atomic::Ordering::Relaxed);
        state.snapshots.insert(String::new(), result);
        drop(state);
        self.hub.publish(ChangeEvent {
            collection: String::new(),
            operation: ChangeOperation::Reload,
        });
    }

    /// Result payload and serialized equality baseline; excludes caller-owned
    /// deliveries, allocator overhead and scheduler state.
    pub fn resident_bytes(&self) -> usize {
        let (values, serialized) = self.retained_sizes();
        values + serialized
    }

    /// Payload estimates, excluding map buckets, allocator and scheduler overhead.
    pub fn retained_sizes(&self) -> (usize, usize) {
        let state = self.hub.state.lock().unwrap_or_else(|e| e.into_inner());
        let values = state
            .snapshots
            .values()
            .flatten()
            .map(value_bytes)
            .sum::<usize>();
        let serialized = state
            .watch_subscribers
            .values()
            .map(|s| s.last_serialized.as_ref().map_or(0, String::capacity))
            .sum::<usize>();
        (values, serialized)
    }
}

fn value_bytes(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(s) => s.capacity(),
            Value::Array(values) => values.iter().map(value_bytes).sum(),
            Value::Object(values) => values
                .iter()
                .map(|(k, v)| k.capacity() + value_bytes(v))
                .sum(),
            _ => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slower_host_revision_cannot_overwrite_a_newer_result() {
        let publisher = ExternalWatch::new(
            vec![json!(0)],
            Some(0),
            Arc::new(CallbackRegistry::default()),
            Arc::new(ManualReactiveScheduler::default()),
        );
        let watch = publisher.subscribe().unwrap();
        assert_eq!(watch.recv().unwrap(), json!([0]));
        publisher.replace(2, vec![json!(2)]);
        assert_eq!(watch.recv().unwrap(), json!([2]));
        publisher.replace(1, vec![json!(1)]);
        assert!(watch.try_recv().is_err());
    }
}
