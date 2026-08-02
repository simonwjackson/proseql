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

#[cfg(all(target_arch = "wasm32", feature = "panic-integration-test"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = __proseql_test_panic_bridge)]
pub fn proseql_test_panic_bridge() -> String {
    bridge::handle(|| -> Result<(), proseql_engine::errors::EngineError> {
        panic!("proseql wasm panic integration");
    })
}
