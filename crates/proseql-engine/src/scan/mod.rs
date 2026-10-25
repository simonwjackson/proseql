//! Query-while-scanning: the shared row seam and the borrowed-row executor.
//!
//! Seam owner: `exec` (#14). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! The types in this file above the `executor` marker are binding seams that
//! other builders use (`formats` implements [`RowSource`]; `index` reads
//! [`RowLocation`]). Change them only through the parent. Everything below the
//! marker belongs to `exec` and may change freely.
//!
//! This module is platform-blind: no I/O, no mmap, no threads. It must build
//! for `wasm32-unknown-unknown` and with `-C target-cpu=x86-64-v2`.

use crate::errors::{EngineError, OperationError};

/// Where a row came from.
///
/// `partition` is the index of the partition file in the scan's path order.
/// `offset` is the byte offset of the first byte of the line in that file.
/// `ordinal` is the row's position in natural order across the whole scan
/// (partition path order, then file order). It is the stable tie-breaker for
/// sorting and the first-encounter order for grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RowLocation {
    pub partition: u32,
    pub offset: u64,
    pub ordinal: u64,
}

/// One undecoded record: the bytes of one JSONL line, without the line
/// terminator. `final_unterminated` is true for a last line that has no
/// trailing newline; the decoder applies the append-only torn-line rules to
/// it (an unparseable unterminated final line is torn, not an error).
#[derive(Debug, Clone, Copy)]
pub struct RawRow<'a> {
    pub location: RowLocation,
    pub bytes: &'a [u8],
    pub final_unterminated: bool,
}

/// Supplies raw rows of one partition file in file order.
///
/// This is a lending iterator: a returned row borrows the source's reusable
/// buffer and is valid only until the next call. Implementations must not
/// hold a whole file in memory unless the host can only supply whole files
/// (and must document that bound).
pub trait RowSource {
    fn next_row(&mut self) -> Result<Option<RawRow<'_>>, EngineError>;
}

/// The error every unimplemented seam returns until its owner fills it in.
/// Production code never reaches it while `ExecutionModel::Resident` is the
/// default.
pub fn unimplemented_seam(seam: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: seam.to_owned(),
        reason: "streaming-unimplemented".to_owned(),
        message: format!("The query-while-scanning seam '{seam}' is not implemented yet"),
    })
}

/// A whole in-memory buffer as a [`RowSource`]. Splits on `\n`, strips a
/// trailing `\r`, skips empty lines, and marks an unterminated final line.
/// Used by tests and by hosts that can only supply whole files. The chunked
/// reader for bounded memory lives in `proseql_storage::readers` (`formats`).
pub struct SliceLines<'a> {
    bytes: &'a [u8],
    partition: u32,
    position: usize,
    ordinal: u64,
}

impl<'a> SliceLines<'a> {
    /// `first_ordinal` is the natural-order ordinal of this file's first row.
    pub fn new(bytes: &'a [u8], partition: u32, first_ordinal: u64) -> Self {
        Self {
            bytes,
            partition,
            position: 0,
            ordinal: first_ordinal,
        }
    }

    /// The ordinal the next row will get (the following file starts here).
    pub fn next_ordinal(&self) -> u64 {
        self.ordinal
    }
}

impl RowSource for SliceLines<'_> {
    fn next_row(&mut self) -> Result<Option<RawRow<'_>>, EngineError> {
        while self.position < self.bytes.len() {
            let start = self.position;
            let rest = &self.bytes[start..];
            let (line, consumed, terminated) = match rest.iter().position(|&byte| byte == b'\n') {
                Some(end) => (&rest[..end], end + 1, true),
                None => (rest, rest.len(), false),
            };
            self.position += consumed;
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let location = RowLocation {
                partition: self.partition,
                offset: start as u64,
                ordinal: self.ordinal,
            };
            self.ordinal += 1;
            return Ok(Some(RawRow {
                location,
                bytes: line,
                final_unterminated: !terminated,
            }));
        }
        Ok(None)
    }
}

// ── executor (owner: exec; free to change below this line) ─────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_lines_reports_offsets_ordinals_and_unterminated_final_line() {
        let bytes = b"{\"id\":\"a\"}\r\n\n{\"id\":\"b\"}\n{\"id\":\"c\"";
        let mut source = SliceLines::new(bytes, 2, 10);
        let mut seen = Vec::new();
        while let Some(row) = source.next_row().unwrap() {
            seen.push((
                row.location,
                String::from_utf8(row.bytes.to_vec()).unwrap(),
                row.final_unterminated,
            ));
        }
        assert_eq!(
            seen,
            vec![
                (
                    RowLocation {
                        partition: 2,
                        offset: 0,
                        ordinal: 10
                    },
                    "{\"id\":\"a\"}".to_owned(),
                    false
                ),
                (
                    RowLocation {
                        partition: 2,
                        offset: 13,
                        ordinal: 11
                    },
                    "{\"id\":\"b\"}".to_owned(),
                    false
                ),
                (
                    RowLocation {
                        partition: 2,
                        offset: 24,
                        ordinal: 12
                    },
                    "{\"id\":\"c\"".to_owned(),
                    true
                ),
            ]
        );
        assert_eq!(source.next_ordinal(), 13);
    }
}
