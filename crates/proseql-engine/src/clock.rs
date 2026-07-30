//! Injectable clock abstraction for timestamp generation.
//!
//! The `Clock` trait keeps the engine free of hard-wired `SystemTime` calls,
//! which is essential for:
//!
//! - **WASM portability** — `std::time::SystemTime` panics on
//!   `wasm32-unknown-unknown`; a JS-side clock is injected instead.
//! - **Deterministic tests** — `FixedClock` returns a stable timestamp so tests
//!   can assert exact `createdAt`/`updatedAt` values.
//!
//! # TS reference
//! `const now = new Date().toISOString()` in `create.ts` / `update.ts`.
//! The Rust engine mirrors that by calling `clock.now_iso()` once per
//! operation and using the result for all timestamp fields in that call.

// `timestamp::now_iso()` uses `SystemTime`; only import it where `SystemClock`
// is compiled (non-wasm targets).
#[cfg(not(target_arch = "wasm32"))]
use crate::timestamp;

// ── Trait ─────────────────────────────────────────────────────────────────────

/// A clock that produces ISO 8601 UTC strings.
///
/// Implementations must be `Send` so a `Box<dyn Clock>` can be stored inside
/// a `Collection` that is sent across threads.
pub trait Clock: Send {
    /// Return the current time as an ISO 8601 UTC string.
    ///
    /// Format: `"YYYY-MM-DDTHH:MM:SS.mmmZ"` — identical to JS `Date.toISOString()`.
    fn now_iso(&self) -> String;
}

// ── Production: system clock (native only) ────────────────────────────────────
//
// `SystemClock` calls `timestamp::now_iso()` which uses `SystemTime::now()`.
// That call panics on `wasm32-unknown-unknown`.  The cfg gate turns that
// potential runtime panic into a compile-time error, forcing WASM callers to
// inject a host-side clock via `Collection::new_with_clock`.

/// A clock backed by `std::time::SystemTime`.
///
/// Use this in native production contexts (Linux, Android arm64, etc.).
///
/// **Not available on `wasm32-unknown-unknown`** — `SystemTime::now()` panics
/// in WASM.  WASM callers must implement [`Clock`] on a host-side type and
/// inject it via [`crate::collection::Collection::new_with_clock`].
#[cfg(not(target_arch = "wasm32"))]
pub struct SystemClock;

#[cfg(not(target_arch = "wasm32"))]
impl Clock for SystemClock {
    fn now_iso(&self) -> String {
        timestamp::now_iso()
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for SystemClock {
    fn default() -> Self {
        Self
    }
}

// ── Deterministic test clock ──────────────────────────────────────────────────

/// A clock that always returns the same fixed ISO 8601 string.
///
/// Used in conformance tests to make timestamp assertions exact and deterministic.
///
/// # Example
/// ```rust
/// # use proseql_engine::clock::{Clock, FixedClock};
/// let clock = FixedClock::new("2024-01-01T00:00:00.000Z");
/// assert_eq!(clock.now_iso(), "2024-01-01T00:00:00.000Z");
/// ```
pub struct FixedClock {
    value: String,
}

impl FixedClock {
    /// Create a clock that always returns `value`.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
        }
    }
}

impl Clock for FixedClock {
    fn now_iso(&self) -> String {
        self.value.clone()
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_clock_returns_constant_value() {
        let clock = FixedClock::new("2024-07-29T18:00:00.000Z");
        assert_eq!(clock.now_iso(), "2024-07-29T18:00:00.000Z");
        assert_eq!(clock.now_iso(), "2024-07-29T18:00:00.000Z");
    }

    // `SystemClock` uses `SystemTime` — not available on wasm32.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn system_clock_returns_iso8601() {
        let clock = SystemClock;
        let ts = clock.now_iso();
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
        assert_eq!(ts.len(), 24);
    }
}
