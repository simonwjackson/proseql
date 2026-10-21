//! Native post-durability dispatch. Engine proxies only enqueue owned contexts;
//! originals run after the runtime lock is released and cannot veto a commit.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::hooks::{
    AfterCreateContext, AfterDeleteContext, AfterUpdateContext, OnChangeContext,
};

use crate::NativeRuntimeConfig;

enum Event {
    Create(String, AfterCreateContext),
    Update(String, AfterUpdateContext),
    Delete(String, AfterDeleteContext),
    Change(String, OnChangeContext),
}

pub(crate) struct Dispatch {
    originals: CallbackRegistry,
    queue: Arc<Mutex<Vec<Event>>>,
}

impl Dispatch {
    pub fn install(config: &NativeRuntimeConfig, registry: &mut CallbackRegistry) -> Arc<Self> {
        let queue = Arc::new(Mutex::new(Vec::new()));
        let mut originals = CallbackRegistry::new();
        macro_rules! defer {
            ($field:ident, $global:ident, $take:ident, $register:ident, $event:ident) => {
                let ids: HashSet<String> = config
                    .collections
                    .iter()
                    .flat_map(|collection| collection.descriptor.$field.iter().cloned())
                    .chain(registry.$global().iter().cloned())
                    .collect();
                for id in ids {
                    if let Some(callback) = registry.$take(&id) {
                        originals.$register(id.clone(), callback);
                        let queue = Arc::clone(&queue);
                        registry.$register(
                            id.clone(),
                            Box::new(move |context| {
                                queue
                                    .lock()
                                    .expect("native callback queue poisoned")
                                    .push(Event::$event(id.clone(), context.clone()));
                                Ok(())
                            }),
                        );
                    }
                }
            };
        }
        defer!(
            after_create_hooks,
            global_after_create_hooks,
            take_after_create_hook,
            register_after_create_hook,
            Create
        );
        defer!(
            after_update_hooks,
            global_after_update_hooks,
            take_after_update_hook,
            register_after_update_hook,
            Update
        );
        defer!(
            after_delete_hooks,
            global_after_delete_hooks,
            take_after_delete_hook,
            register_after_delete_hook,
            Delete
        );
        defer!(
            on_change_hooks,
            global_on_change_hooks,
            take_on_change_hook,
            register_on_change_hook,
            Change
        );
        Arc::new(Self { originals, queue })
    }

    pub fn batch(self: &Arc<Self>) -> Batch {
        Batch {
            dispatch: Arc::clone(self),
        }
    }
}

/// Dropping an unsuccessful mutation discards all post-commit effects.
pub(crate) struct Batch {
    dispatch: Arc<Dispatch>,
}

impl Batch {
    pub fn finish(self) -> impl FnOnce() {
        let events = std::mem::take(
            &mut *self
                .dispatch
                .queue
                .lock()
                .expect("native callback queue poisoned"),
        );
        let dispatch = Arc::clone(&self.dispatch);
        move || {
            for event in events {
                // After-hook errors are intentionally swallowed, like WASM.
                let _ = match event {
                    Event::Create(id, ctx) => {
                        dispatch
                            .originals
                            .after_create_hook(&id)
                            .expect("registered hook")(&ctx)
                    }
                    Event::Update(id, ctx) => {
                        dispatch
                            .originals
                            .after_update_hook(&id)
                            .expect("registered hook")(&ctx)
                    }
                    Event::Delete(id, ctx) => {
                        dispatch
                            .originals
                            .after_delete_hook(&id)
                            .expect("registered hook")(&ctx)
                    }
                    Event::Change(id, ctx) => {
                        dispatch
                            .originals
                            .on_change_hook(&id)
                            .expect("registered hook")(&ctx)
                    }
                };
            }
        }
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        self.dispatch
            .queue
            .lock()
            .expect("native callback queue poisoned")
            .clear();
    }
}
