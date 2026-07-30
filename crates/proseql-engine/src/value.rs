//! Boundary value type for the proseQL engine.
//!
//! All data entering or leaving the engine across any boundary — WASM, native
//! FFI, persistence round-trips — is expressed as [`Value`].  The choice to
//! re-export `serde_json::Value` directly is deliberate:
//!
//! - JSON/JS semantics are the authoritative observable behaviour (see
//!   CLAUDE.md: "TS types are the contract; Rust implements the semantics").
//! - `serde_json::Value` is a pure-Rust serialisation primitive with no I/O
//!   dependency, satisfying the engine's platform-blind rule.
//! - Every JSON number in JS is an IEEE 754 f64; `serde_json::Number` preserves
//!   the integer/float distinction for faithful round-trips while the engine
//!   treats all `Schema.Number` fields as f64 for JS-consistent arithmetic.
//!
//! If a future boundary requires a different wire type (e.g., MessagePack), the
//! conversion lives at that boundary crate, not here.

/// The canonical value type used throughout the proseQL engine.
///
/// Mirrors `serde_json::Value` semantics, which in turn mirror JS observable
/// value semantics:
/// - `Null` → JSON `null`, JS `null`
/// - `Bool` → JSON `true`/`false`
/// - `Number` → JSON number (integer or float)
/// - `String` → JSON string
/// - `Array` → JSON array
/// - `Object` → JSON object (insertion-ordered map)
pub use serde_json::Value;
