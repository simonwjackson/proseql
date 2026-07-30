use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, StorageError, StorageOperation};

pub trait SaveSink: Send + Sync + 'static {
    fn save(&self, key: &str, value: &str) -> Result<(), EngineError>;
}

pub trait DebounceScheduler: Send + Sync + 'static {
    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>) -> Result<(), EngineError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Default)]
pub struct ThreadDebounceScheduler;

#[cfg(not(target_arch = "wasm32"))]
impl DebounceScheduler for ThreadDebounceScheduler {
    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>) -> Result<(), EngineError> {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            job();
        });
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct UnsupportedDebounceScheduler;

impl DebounceScheduler for UnsupportedDebounceScheduler {
    fn schedule(
        &self,
        _delay: Duration,
        _job: Box<dyn FnOnce() + Send>,
    ) -> Result<(), EngineError> {
        Err(EngineError::Storage(Box::new(StorageError {
            path: "(debounced-writer)".to_owned(),
            operation: StorageOperation::Write,
            message:
                "Automatic debounce scheduling requires a host-provided scheduler on this target"
                    .to_owned(),
            cause: None,
        })))
    }
}

struct PendingEntry {
    value: String,
    token: u64,
}

struct CompletedError {
    token: u64,
    error: EngineError,
}

struct State {
    entries: IndexMap<String, PendingEntry>,
    next_token: u64,
    in_flight_tokens: Vec<u64>,
    completed_errors: VecDeque<CompletedError>,
}

pub struct KeyedDebouncedWriter<S> {
    sink: Arc<S>,
    debounce: Duration,
    scheduler: Arc<dyn DebounceScheduler>,
    state: Arc<(Mutex<State>, Condvar)>,
}

impl<S: SaveSink> KeyedDebouncedWriter<S> {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(sink: Arc<S>, debounce: Duration) -> Self {
        Self::new_with_scheduler(sink, debounce, Arc::new(ThreadDebounceScheduler))
    }

    #[cfg(target_arch = "wasm32")]
    pub fn new(sink: Arc<S>, debounce: Duration) -> Self {
        Self::new_with_scheduler(sink, debounce, Arc::new(UnsupportedDebounceScheduler))
    }

    pub fn new_with_scheduler(
        sink: Arc<S>,
        debounce: Duration,
        scheduler: Arc<dyn DebounceScheduler>,
    ) -> Self {
        Self {
            sink,
            debounce,
            scheduler,
            state: Arc::new((
                Mutex::new(State {
                    entries: IndexMap::new(),
                    next_token: 1,
                    in_flight_tokens: Vec::new(),
                    completed_errors: VecDeque::new(),
                }),
                Condvar::new(),
            )),
        }
    }

    pub fn sink(&self) -> &Arc<S> {
        &self.sink
    }

    fn state_error() -> EngineError {
        EngineError::Storage(Box::new(StorageError {
            path: "(debounced-writer)".to_owned(),
            operation: StorageOperation::Write,
            message: "Debounced writer state is poisoned".to_owned(),
            cause: None,
        }))
    }

    fn finish_in_flight(
        state: &Arc<(Mutex<State>, Condvar)>,
        key: &str,
        token: u64,
        index: usize,
        payload: &str,
        error: Option<EngineError>,
    ) {
        let (lock, condvar) = state.as_ref();
        if let Ok(mut state) = lock.lock() {
            if let Some(position) = state
                .in_flight_tokens
                .iter()
                .position(|candidate| *candidate == token)
            {
                state.in_flight_tokens.swap_remove(position);
            }
            if let Some(error) = error {
                if !state.entries.contains_key(key) {
                    let insert_at = index.min(state.entries.len());
                    state.entries.insert_before(
                        insert_at,
                        key.to_owned(),
                        PendingEntry {
                            value: payload.to_owned(),
                            token,
                        },
                    );
                }
                state
                    .completed_errors
                    .push_back(CompletedError { token, error });
            }
            condvar.notify_all();
        }
    }

    fn schedule_token(
        sink: Arc<S>,
        state: Arc<(Mutex<State>, Condvar)>,
        scheduler: Arc<dyn DebounceScheduler>,
        debounce: Duration,
        key: String,
        token: u64,
    ) -> Result<(), EngineError> {
        scheduler.schedule(
            debounce,
            Box::new(move || {
                let (index, payload) = {
                    let (lock, _) = state.as_ref();
                    let mut state = match lock.lock() {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                    let Some((index, _, entry)) = state.entries.shift_remove_full(&key) else {
                        return;
                    };
                    if entry.token != token {
                        state.entries.insert_before(index, key.clone(), entry);
                        return;
                    }
                    let payload = entry.value.clone();
                    state.in_flight_tokens.push(token);
                    (index, payload)
                };

                let result = sink.save(&key, &payload).err();
                Self::finish_in_flight(&state, &key, token, index, &payload, result);
            }),
        )
    }

    pub fn schedule(&self, key: &str, value: &str) -> Result<(), EngineError> {
        let token = {
            let (lock, _) = self.state.as_ref();
            let mut state = lock.lock().map_err(|_| Self::state_error())?;
            let token = state.next_token;
            state.next_token = state.next_token.saturating_add(1);
            state.entries.insert(
                key.to_owned(),
                PendingEntry {
                    value: value.to_owned(),
                    token,
                },
            );
            token
        };

        Self::schedule_token(
            Arc::clone(&self.sink),
            Arc::clone(&self.state),
            Arc::clone(&self.scheduler),
            self.debounce,
            key.to_owned(),
            token,
        )
    }

    pub fn flush(&self) -> Result<(), EngineError> {
        let (pending, pending_tokens, barrier) = {
            let (lock, _) = self.state.as_ref();
            let mut state = lock.lock().map_err(|_| Self::state_error())?;
            let barrier = state.next_token.saturating_sub(1);
            let pending = std::mem::take(&mut state.entries)
                .into_iter()
                .map(|(key, entry)| (key, entry.value, entry.token))
                .collect::<Vec<_>>();
            let pending_tokens = pending
                .iter()
                .map(|(_, _, token)| *token)
                .collect::<Vec<_>>();
            (pending, pending_tokens, barrier)
        };

        let mut direct_error = None;
        for (key, value, _) in pending {
            if let Err(error) = self.sink.save(&key, &value) {
                direct_error = Some(error);
                break;
            }
        }

        let inflight_error = {
            let (lock, condvar) = self.state.as_ref();
            let mut state = lock.lock().map_err(|_| Self::state_error())?;
            loop {
                if !state.in_flight_tokens.iter().any(|token| *token <= barrier) {
                    break;
                }
                state = condvar.wait(state).map_err(|_| Self::state_error())?;
            }

            while let Some(index) = state.completed_errors.iter().position(|completed| {
                completed.token <= barrier && pending_tokens.contains(&completed.token)
            }) {
                let _ = state.completed_errors.remove(index);
            }

            let error_index = state.completed_errors.iter().position(|completed| {
                completed.token <= barrier && !pending_tokens.contains(&completed.token)
            });
            error_index.and_then(|index| {
                state
                    .completed_errors
                    .remove(index)
                    .map(|completed| completed.error)
            })
        };

        if let Some(error) = direct_error {
            return Err(error);
        }
        if let Some(error) = inflight_error {
            return Err(error);
        }
        Ok(())
    }
}
