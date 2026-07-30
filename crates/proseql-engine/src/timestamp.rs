//! Lightweight ISO 8601 timestamp generation without external crates.
//!
//! Uses `std::time::SystemTime` and Hinnant's civil-calendar algorithm
//! to produce `"YYYY-MM-DDTHH:MM:SS.mmmZ"` strings that match the TS
//! `new Date().toISOString()` format.
//!
//! Reference: http://howardhinnant.github.io/date_algorithms.html

// `SystemTime` panics on `wasm32-unknown-unknown`; gate it at compile time so
// wasm callers are forced to inject a host-side clock rather than getting a
// runtime panic.
#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};

/// Return the current UTC time as an ISO 8601 string.
///
/// Format: `"2024-07-29T18:02:01.234Z"` — identical to JS `Date.toISOString()`.
///
/// **Not available on `wasm32-unknown-unknown`** — `SystemTime::now()` panics in
/// WASM.  WASM callers must use [`crate::clock::Clock`] (inject a host clock via
/// [`crate::collection::Collection::new_with_clock`]).
#[cfg(not(target_arch = "wasm32"))]
pub fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    millis_to_iso(ms)
}

/// Convert milliseconds-since-epoch to an ISO 8601 UTC string.
pub fn millis_to_iso(ms: u64) -> String {
    let total_s = ms / 1000;
    let ms_part = (ms % 1000) as u32;

    // Time-of-day
    let h = ((total_s % 86400) / 3600) as u32;
    let min = ((total_s % 3600) / 60) as u32;
    let sec = (total_s % 60) as u32;

    // Days since 1970-01-01 → Y/M/D via Hinnant's civil_from_days algorithm.
    let (y, m, d) = civil_from_days(total_s / 86400);

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{sec:02}.{ms_part:03}Z")
}

/// Convert days-since-epoch (i64, may be negative for pre-1970) to (year, month, day).
///
/// Algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
fn civil_from_days(epoch_days: u64) -> (i32, u32, u32) {
    let z = epoch_days as i64 + 719_468;
    let era: i64 = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // day of era  [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // year of era  [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year  [0, 365]
    let mp = (5 * doy + 2) / 153; // month prime  [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // day          [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // month        [1, 12]
    let y = if m <= 2 { y + 1 } else { y } as i32;
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_formats_correctly() {
        // 0 ms = 1970-01-01T00:00:00.000Z
        assert_eq!(millis_to_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn known_timestamp_formats_correctly() {
        // 2024-01-01T00:00:00.000Z = 1704067200000 ms
        assert_eq!(millis_to_iso(1_704_067_200_000), "2024-01-01T00:00:00.000Z");
    }

    #[test]
    fn milliseconds_included() {
        // 2024-01-01T00:00:00.123Z = 1704067200123 ms
        assert_eq!(millis_to_iso(1_704_067_200_123), "2024-01-01T00:00:00.123Z");
    }

    // `now_iso` uses `SystemTime` which panics on wasm32.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn now_iso_returns_nonempty_string() {
        let s = now_iso();
        assert!(s.ends_with('Z'));
        assert!(s.contains('T'));
        assert_eq!(s.len(), 24); // "YYYY-MM-DDTHH:MM:SS.mmmZ"
    }
}
