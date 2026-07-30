use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
use std::{
    collections::HashMap,
    sync::{Mutex, Weak},
};

#[cfg(target_arch = "wasm32")]
use proseql_engine::reactive::ReactiveTaskHandle;
use proseql_engine::reactive::{ReactiveScheduler, UnsupportedReactiveScheduler};

pub type ReactiveSchedulerFactory =
    Arc<dyn Fn() -> Arc<dyn ReactiveScheduler> + Send + Sync + 'static>;

pub fn unsupported_scheduler_factory() -> ReactiveSchedulerFactory {
    Arc::new(|| Arc::new(UnsupportedReactiveScheduler) as Arc<dyn ReactiveScheduler>)
}

#[cfg(target_arch = "wasm32")]
pub fn wasm_scheduler_factory(
    set_timeout: js_sys::Function,
    clear_timeout: js_sys::Function,
) -> ReactiveSchedulerFactory {
    let scheduler = Arc::new(WasmInjectedScheduler::new(set_timeout, clear_timeout));
    Arc::new(move || Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>)
}

#[cfg(target_arch = "wasm32")]
struct WasmInjectedScheduler {
    inner: Arc<WasmInjectedSchedulerInner>,
}

#[cfg(target_arch = "wasm32")]
struct WasmInjectedSchedulerInner {
    set_timeout: js_sys::Function,
    clear_timeout: js_sys::Function,
    next_id: Mutex<u64>,
    tasks: Mutex<HashMap<u64, WasmScheduledTask>>,
}

#[cfg(target_arch = "wasm32")]
struct WasmScheduledTask {
    timer_handle: wasm_bindgen::JsValue,
    _callback: wasm_bindgen::JsValue,
}

#[cfg(target_arch = "wasm32")]
struct WasmTaskHandle {
    inner: Weak<WasmInjectedSchedulerInner>,
    id: u64,
}

#[cfg(target_arch = "wasm32")]
impl WasmInjectedScheduler {
    fn new(set_timeout: js_sys::Function, clear_timeout: js_sys::Function) -> Self {
        Self {
            inner: Arc::new(WasmInjectedSchedulerInner {
                set_timeout,
                clear_timeout,
                next_id: Mutex::new(1),
                tasks: Mutex::new(HashMap::new()),
            }),
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl ReactiveTaskHandle for WasmTaskHandle {
    fn cancel(&self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let task = inner
            .tasks
            .lock()
            .ok()
            .and_then(|mut tasks| tasks.remove(&self.id));
        if let Some(task) = task {
            let _ = inner
                .clear_timeout
                .call1(&wasm_bindgen::JsValue::NULL, &task.timer_handle);
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl ReactiveScheduler for WasmInjectedScheduler {
    fn schedule(
        &self,
        delay_ms: u64,
        job: Box<dyn FnOnce() + Send + 'static>,
    ) -> Box<dyn ReactiveTaskHandle> {
        use wasm_bindgen::JsCast;

        let id = match self.inner.next_id.lock() {
            Ok(mut next_id) => {
                let id = *next_id;
                *next_id = next_id.saturating_add(1);
                id
            }
            Err(_) => {
                return Box::new(WasmTaskHandle {
                    inner: Arc::downgrade(&self.inner),
                    id: 0,
                })
            }
        };

        let inner = Arc::clone(&self.inner);
        let job = Arc::new(Mutex::new(Some(job)));
        let callback_job = Arc::clone(&job);
        let callback_inner = Arc::clone(&inner);
        let closure = wasm_bindgen::closure::Closure::wrap(Box::new(move || {
            if let Ok(mut tasks) = callback_inner.tasks.lock() {
                tasks.remove(&id);
            }
            let job = callback_job.lock().ok().and_then(|mut job| job.take());
            if let Some(job) = job {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            }
        }) as Box<dyn FnMut()>);
        let callback = closure.into_js_value();

        let timer_handle = inner
            .set_timeout
            .call2(
                &wasm_bindgen::JsValue::NULL,
                callback.unchecked_ref(),
                &wasm_bindgen::JsValue::from_f64(delay_ms as f64),
            )
            .unwrap_or(wasm_bindgen::JsValue::NULL);

        if let Ok(mut tasks) = inner.tasks.lock() {
            tasks.insert(
                id,
                WasmScheduledTask {
                    timer_handle,
                    _callback: callback,
                },
            );
        }

        Box::new(WasmTaskHandle {
            inner: Arc::downgrade(&self.inner),
            id,
        })
    }

    fn pending_task_count(&self) -> usize {
        self.inner
            .tasks
            .lock()
            .map(|tasks| tasks.len())
            .unwrap_or(0)
    }
}
