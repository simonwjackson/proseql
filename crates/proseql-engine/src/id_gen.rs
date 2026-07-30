//! ID generation seam for the proseQL engine.
//!
//! The `IdGenerator` trait is the public contract; `id_gen.generate()` is called
//! once per entity creation when the caller has not supplied an id.
//!
//! Production: [`NanoIdGenerator`] — URL-safe random string, no external crates.
//! Tests: [`SequentialGenerator`] — deterministic, configurable prefix.
//!
//! # TS reference
//! The TS engine uses `generateId = createIdGenerator({ strategy: "nano", length: 21 })`.
//! The Rust engine matches that surface (non-UUID random string) but the exact
//! alphabet/length are an implementation detail that the conformance corpus does
//! not pin — tests always supply their own IDs or use [`SequentialGenerator`].

// `AtomicU64` + `SystemTime` are only needed by `NanoIdGenerator`, which is
// native-only (see cfg gate below).
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicU64, Ordering};

// ── Trait ─────────────────────────────────────────────────────────────────────

/// Contract for ID generation.  Must be `Send` so a `Box<dyn IdGenerator>` can
/// live inside a `Collection` that is sent across threads.
pub trait IdGenerator: Send {
    fn generate(&mut self) -> String;
}

// ── Production generator (native only) ───────────────────────────────────────
//
// `NanoIdGenerator` uses `std::time::SystemTime` which panics on
// `wasm32-unknown-unknown`.  It is cfg-gated so that WASM callers get a
// compile-time error instead of a runtime panic, forcing them to inject a
// host-side IdGenerator via `Collection::new_with_clock`.

/// Global atomic counter for the nano-id suffix, ensuring no two IDs collide
/// even if `SystemTime` resolution is coarser than the call rate.
#[cfg(not(target_arch = "wasm32"))]
static NANO_COUNTER: AtomicU64 = AtomicU64::new(0);

/// URL-safe random-ish ID (timestamp + counter + pseudo-random bits).
///
/// Format: `{ts_hex}{counter_hex}{rand_hex}` — 48 hex chars.
/// Not cryptographically strong but unique enough for an in-process engine.
///
/// Mirrors the TS `generateNanoId` surface: the output is a non-empty opaque
/// string without null bytes.
///
/// **Not available on `wasm32-unknown-unknown`** — uses `std::time::SystemTime`
/// which panics in WASM.  WASM callers must inject a host-side `IdGenerator`
/// implementation over the WASM boundary (U8).
#[cfg(not(target_arch = "wasm32"))]
pub struct NanoIdGenerator;

#[cfg(not(target_arch = "wasm32"))]
impl IdGenerator for NanoIdGenerator {
    fn generate(&mut self) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};

        let ts_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let counter = NANO_COUNTER.fetch_add(1, Ordering::Relaxed);
        // Cheap pseudo-random: XOR-shift from counter and ts
        let rand = ts_ns
            .wrapping_mul(6364136223846793005)
            .wrapping_add(counter);
        format!("{ts_ns:016x}{counter:08x}{rand:016x}")
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for NanoIdGenerator {
    fn default() -> Self {
        Self
    }
}

// ── Deterministic test generator ──────────────────────────────────────────────

/// Deterministic sequential ID generator for conformance tests.
///
/// Produces `"{prefix}-1"`, `"{prefix}-2"`, … on successive calls.
/// Use a unique prefix per test to avoid cross-test collisions when running
/// tests in the same process.
///
/// # Example
/// ```no_run
/// # use proseql_engine::id_gen::SequentialGenerator;
/// # use proseql_engine::id_gen::IdGenerator;
/// let mut gen = SequentialGenerator::new("user");
/// assert_eq!(gen.generate(), "user-1");
/// assert_eq!(gen.generate(), "user-2");
/// ```
pub struct SequentialGenerator {
    prefix: String,
    next: u64,
}

impl SequentialGenerator {
    /// Create a new generator with the given prefix.
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
            next: 1,
        }
    }
}

impl IdGenerator for SequentialGenerator {
    fn generate(&mut self) -> String {
        let id = format!("{}-{}", self.prefix, self.next);
        self.next += 1;
        id
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_generator_produces_deterministic_ids() {
        let mut gen = SequentialGenerator::new("test");
        assert_eq!(gen.generate(), "test-1");
        assert_eq!(gen.generate(), "test-2");
        assert_eq!(gen.generate(), "test-3");
    }

    #[test]
    fn sequential_generator_different_prefix_independent() {
        let mut a = SequentialGenerator::new("user");
        let mut b = SequentialGenerator::new("post");
        assert_eq!(a.generate(), "user-1");
        assert_eq!(b.generate(), "post-1");
        assert_eq!(a.generate(), "user-2");
    }

    // `NanoIdGenerator` uses `SystemTime` — not available on wasm32.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn nano_id_generator_produces_nonempty_unique_ids() {
        let mut gen = NanoIdGenerator;
        let id1 = gen.generate();
        let id2 = gen.generate();
        assert!(!id1.is_empty());
        assert!(!id2.is_empty());
        assert_ne!(id1, id2);
    }
}
