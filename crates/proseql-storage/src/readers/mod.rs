//! Bounded-memory byte readers for query-while-scanning.
//!
//! Seam owner: `formats` (#17). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! [`ByteChunks`] is the binding seam: it is how a native file, a browser
//! host or a test buffer supplies bytes without mmap and without holding a
//! whole file. `formats` implements a chunked JSONL line framer that turns
//! `ByteChunks` into a [`proseql_engine::scan::RowSource`], and the host
//! adapters. `exec` consumes them.

use crate::host::StorageHost;
use proseql_engine::errors::EngineError;

/// Default chunk size for bounded reads.
pub const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;

/// A sequence of byte chunks in file order. A returned chunk borrows the
/// reader's buffer and is valid until the next call. An empty slice is never
/// returned; `None` is end of input.
pub trait ByteChunks {
    fn next_chunk(&mut self) -> Result<Option<&[u8]>, EngineError>;
}

/// One in-memory buffer as a single chunk (tests, whole-file hosts).
pub struct SliceChunks<'a> {
    bytes: Option<&'a [u8]>,
}

impl<'a> SliceChunks<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes: (!bytes.is_empty()).then_some(bytes),
        }
    }
}

impl ByteChunks for SliceChunks<'_> {
    fn next_chunk(&mut self) -> Result<Option<&[u8]>, EngineError> {
        Ok(self.bytes.take())
    }
}

/// A file read through [`StorageHost::read_range`] in fixed-size chunks.
/// Memory is one chunk, whatever the file size, when the host overrides
/// `read_range`.
pub struct HostChunks<'h> {
    host: &'h dyn StorageHost,
    path: String,
    offset: u64,
    chunk_bytes: usize,
    buffer: Vec<u8>,
    done: bool,
}

impl<'h> HostChunks<'h> {
    pub fn new(host: &'h dyn StorageHost, path: impl Into<String>, start: u64) -> Self {
        Self::with_chunk_size(host, path, start, DEFAULT_CHUNK_BYTES)
    }

    pub fn with_chunk_size(
        host: &'h dyn StorageHost,
        path: impl Into<String>,
        start: u64,
        chunk_bytes: usize,
    ) -> Self {
        Self {
            host,
            path: path.into(),
            offset: start,
            chunk_bytes: chunk_bytes.max(1),
            buffer: Vec::new(),
            done: false,
        }
    }

    /// Byte offset of the next chunk.
    pub fn offset(&self) -> u64 {
        self.offset
    }
}

impl ByteChunks for HostChunks<'_> {
    fn next_chunk(&mut self) -> Result<Option<&[u8]>, EngineError> {
        if self.done {
            return Ok(None);
        }
        self.buffer = self
            .host
            .read_range(&self.path, self.offset, self.chunk_bytes)?;
        if self.buffer.len() < self.chunk_bytes {
            self.done = true;
        }
        if self.buffer.is_empty() {
            return Ok(None);
        }
        self.offset += self.buffer.len() as u64;
        Ok(Some(&self.buffer))
    }
}

// ── line framing and host adapters (owner: formats; free to change below) ──
