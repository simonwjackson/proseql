//! JSONL framing shared by synchronous hosts and asynchronous browser feeds.
//! Memory is bounded by a chunk plus the longest physical line, not file size.

use super::{ByteChunks, RawRow, RowLocation, RowSource};
use crate::errors::{EngineError, OperationError};

// Portable scalar word-at-a-time delimiter search. A zero-byte mask is only
// a candidate: exact byte comparison handles endianness and subtraction carry.
pub(super) fn newline_position(bytes: &[u8]) -> Option<usize> {
    let mut chunks = bytes.chunks_exact(8);
    for (index, chunk) in chunks.by_ref().enumerate() {
        let word =
            u64::from_ne_bytes(chunk.try_into().expect("eight-byte chunk")) ^ 0x0a0a_0a0a_0a0a_0a0a;
        if word.wrapping_sub(0x0101_0101_0101_0101) & !word & 0x8080_8080_8080_8080 != 0 {
            if let Some(position) = chunk.iter().position(|byte| *byte == b'\n') {
                return Some(index * 8 + position);
            }
        }
    }
    chunks
        .remainder()
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|position| bytes.len() - chunks.remainder().len() + position)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scalar_delimiter_search_matches_byte_search_at_every_word_boundary() {
        for fill in [0, 1, 9, 10, 11, 127, 255] {
            for length in 0..96 {
                for position in 0..=length {
                    let mut bytes = vec![fill; length];
                    if position < length {
                        bytes[position] = b'\n';
                    }
                    assert_eq!(
                        super::newline_position(&bytes),
                        bytes.iter().position(|byte| *byte == b'\n')
                    );
                }
            }
        }
    }
}

/// Push adapter for hosts whose chunk reads are asynchronous. Drain `next_row`
/// before feeding another chunk. `None` means this chunk is drained; only a
/// chunk marked final ends the file and emits an unterminated final row.
pub struct ChunkLines {
    input: Vec<u8>,
    position: usize,
    line: Vec<u8>,
    offset: u64,
    line_start: u64,
    partition: u32,
    ordinal: u64,
    final_chunk: bool,
    row_ready: bool,
}

impl ChunkLines {
    pub fn new(partition: u32, start_offset: u64, first_ordinal: u64) -> Self {
        Self {
            input: Vec::new(),
            position: 0,
            line: Vec::new(),
            offset: start_offset,
            line_start: start_offset,
            partition,
            ordinal: first_ordinal,
            final_chunk: false,
            row_ready: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8], final_chunk: bool) -> Result<(), EngineError> {
        if self.position != self.input.len() || self.row_ready || self.final_chunk {
            return Err(EngineError::Operation(OperationError {
                operation: "scan-chunk".into(),
                reason: "chunk-not-drained".into(),
                message:
                    "Drain the current chunk before feeding another; a final chunk ends the file"
                        .into(),
            }));
        }
        self.input.clear();
        self.input.extend_from_slice(bytes);
        self.position = 0;
        self.final_chunk = final_chunk;
        Ok(())
    }

    pub fn next_ordinal(&self) -> u64 {
        self.ordinal
    }

    /// Retained allocation, including the reusable chunk and line buffers.
    pub fn buffered_bytes(&self) -> usize {
        self.input.capacity() + self.line.capacity()
    }

    // Separate advancing from lending so the pull adapter can refill between
    // advances without holding a borrow of the row buffer.
    fn advance(&mut self) -> Option<(RowLocation, bool)> {
        if self.row_ready {
            self.line.clear();
            self.line_start = self.offset;
            self.row_ready = false;
        }
        loop {
            let remaining = &self.input[self.position..];
            let newline = newline_position(remaining);
            let (end, terminated) = match newline {
                Some(end) => (end, true),
                None => (remaining.len(), false),
            };
            self.line.extend_from_slice(&remaining[..end]);
            let consumed = end + usize::from(terminated);
            self.position += consumed;
            self.offset += consumed as u64;
            if !terminated && !self.final_chunk {
                return None;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.iter().all(u8::is_ascii_whitespace) {
                self.line.clear();
                self.line_start = self.offset;
                if self.position == self.input.len() {
                    return None;
                }
                continue;
            }
            let location = RowLocation {
                partition: self.partition,
                offset: self.line_start,
                ordinal: self.ordinal,
            };
            self.ordinal += 1;
            self.row_ready = true;
            return Some((location, !terminated));
        }
    }

    fn row(&self, location: RowLocation, final_unterminated: bool) -> RawRow<'_> {
        RawRow {
            location,
            bytes: &self.line,
            final_unterminated,
        }
    }
}

impl RowSource for ChunkLines {
    fn next_row(&mut self) -> Result<Option<RawRow<'_>>, EngineError> {
        Ok(self
            .advance()
            .map(|(location, final_line)| self.row(location, final_line)))
    }
}

/// A bounded pull reader. Offsets and ordinals match `SliceLines`, including
/// blank lines and CRLF. Bytes are not decoded here: the decoder must classify
/// an unparseable `final_unterminated` row as torn for append-only sources.
pub struct LineFramer<C: ByteChunks> {
    chunks: C,
    lines: ChunkLines,
    done: bool,
}

impl<C: ByteChunks> LineFramer<C> {
    pub fn new(chunks: C, partition: u32, first_ordinal: u64) -> Self {
        Self::with_offset(chunks, partition, 0, first_ordinal)
    }

    /// `chunks` must begin at `start_offset`, a physical line boundary.
    /// `first_ordinal` is the ordinal at that boundary, not a physical line count.
    pub fn with_offset(chunks: C, partition: u32, start_offset: u64, first_ordinal: u64) -> Self {
        Self {
            chunks,
            lines: ChunkLines::new(partition, start_offset, first_ordinal),
            done: false,
        }
    }

    pub fn next_ordinal(&self) -> u64 {
        self.lines.next_ordinal()
    }

    /// Framer allocations only; the byte source may retain another chunk.
    pub fn buffered_bytes(&self) -> usize {
        self.lines.buffered_bytes()
    }
}

impl<C: ByteChunks> RowSource for LineFramer<C> {
    fn next_row(&mut self) -> Result<Option<RawRow<'_>>, EngineError> {
        loop {
            if let Some((location, final_line)) = self.lines.advance() {
                return Ok(Some(self.lines.row(location, final_line)));
            }
            if self.done {
                return Ok(None);
            }
            match self.chunks.next_chunk()? {
                Some(bytes) => self.lines.push(bytes, false)?,
                None => {
                    self.lines.push(&[], true)?;
                    self.done = true;
                }
            }
        }
    }
}
