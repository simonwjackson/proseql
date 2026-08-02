mod bridge;
pub mod callbacks;
mod command;
mod projection;
pub mod reactive;
pub mod runtime;
mod types;

pub use callbacks::CallbackTable;
pub use runtime::{Runtime, RuntimeConfig};

#[cfg(target_arch = "wasm32")]
pub use runtime::WasmRuntime;

#[cfg(all(target_arch = "wasm32", feature = "transport-candidates"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_transport_candidate_json)]
pub fn transport_candidate_json(count: u32) -> String {
    let slots = (0..count).collect::<Vec<_>>();
    serde_json::json!({"k": "q", "r": slots}).to_string()
}

#[cfg(all(target_arch = "wasm32", feature = "transport-candidates"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_transport_candidate_native)]
pub fn transport_candidate_native(count: u32) -> js_sys::Array {
    let output = js_sys::Array::new_with_length(count);
    for slot in 0..count {
        output.set(slot, wasm_bindgen::JsValue::from(slot));
    }
    output
}

#[cfg(all(target_arch = "wasm32", feature = "transport-candidates"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_transport_candidate_buffer)]
pub fn transport_candidate_buffer(count: u32) -> js_sys::Uint32Array {
    let slots = (0..count).collect::<Vec<_>>();
    js_sys::Uint32Array::from(slots.as_slice())
}

#[cfg(all(target_arch = "wasm32", feature = "transport-candidates"))]
thread_local! {
    static TRANSPORT_CANDIDATE_REUSABLE: std::cell::RefCell<Vec<u32>> = const {
        std::cell::RefCell::new(Vec::new())
    };
}

#[cfg(all(target_arch = "wasm32", feature = "transport-candidates"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_transport_candidate_reusable_view)]
pub fn transport_candidate_reusable_view(count: u32) -> js_sys::Uint32Array {
    TRANSPORT_CANDIDATE_REUSABLE.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        buffer.clear();
        buffer.extend(0..count);
        // Profile-only candidate: the caller consumes this dispatch-scoped view
        // before any subsequent allocation or WASM call.
        unsafe { js_sys::Uint32Array::view(buffer.as_slice()) }
    })
}

#[cfg(all(target_arch = "wasm32", feature = "panic-integration-test"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_test_panic_bridge)]
pub fn proseql_test_panic_bridge() -> String {
    bridge::handle(|| -> Result<(), proseql_engine::errors::EngineError> {
        panic!("proseql wasm panic integration");
    })
}
