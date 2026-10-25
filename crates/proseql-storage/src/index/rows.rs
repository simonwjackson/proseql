//! Bounded text traversal used while constructing positional indexes.
use crate::host::StorageHost;
use crate::readers::{ByteChunks, LineFramer};
use proseql_engine::errors::{EngineError, SerializationError};
use proseql_engine::scan::{RowLocation, RowSource};

struct CheckedChunks<'a> {
    host: &'a dyn StorageHost,
    path: &'a str,
    offset: u64,
    end: u64,
    buffer: Vec<u8>,
}
impl ByteChunks for CheckedChunks<'_> {
    fn next_chunk(&mut self) -> Result<Option<&[u8]>, EngineError> {
        if self.offset >= self.end {
            return Ok(None);
        }
        self.buffer = self.host.read_range(
            self.path,
            self.offset,
            (self.end - self.offset).min(64 * 1024) as usize,
        )?;
        if self.buffer.is_empty() {
            return Err(crate::generation::changed(self.path));
        }
        self.offset += self.buffer.len() as u64;
        Ok(Some(&self.buffer))
    }
}

/// Visit nonempty JSONL lines. The buffer is bounded by a chunk plus the
/// longest line. The final unterminated line is passed to the caller, which
/// decides whether it is a valid record or a torn append.
pub fn visit_lines(
    host: &dyn StorageHost,
    path: &str,
    start: u64,
    end: u64,
    first_row: u64,
    mut visit: impl FnMut(&[u8], RowLocation, bool) -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let chunks = CheckedChunks {
        host,
        path,
        offset: start,
        end,
        buffer: Vec::new(),
    };
    let mut lines = LineFramer::with_offset(chunks, 0, start, first_row);
    while let Some(row) = lines.next_row()? {
        visit(row.bytes, row.location, row.final_unterminated)
            .map_err(|error| file_error(host, path, row.location.offset, error))?;
    }
    Ok(())
}

// Keep the resident codec's file-global error payloads without retaining the
// prefix. Extra prefix I/O happens only on an error, never on successful reads.
fn file_error(
    host: &dyn StorageHost,
    path: &str,
    line_offset: u64,
    mut error: EngineError,
) -> EngineError {
    if let EngineError::Serialization(serialization) = &mut error {
        let prefix = "JSONL parse error on line 1:";
        if serialization.message.contains(prefix) {
            let mut position = 0;
            let mut number = 1;
            while position < line_offset {
                let Ok(bytes) = host.read_range(
                    path,
                    position,
                    (line_offset - position).min(64 * 1024) as usize,
                ) else {
                    return error;
                };
                if bytes.is_empty() {
                    return error;
                }
                number += bytes.iter().filter(|byte| **byte == b'\n').count();
                position += bytes.len() as u64;
            }
            let actual = format!("JSONL parse error on line {number}:");
            serialization.message = serialization.message.replacen(prefix, &actual, 1);
            if let Some(serde_json::Value::String(cause)) = &mut serialization.cause {
                *cause = cause.replacen(prefix, &actual, 1);
            }
        }
    }
    if let EngineError::Storage(storage) = &mut error {
        if storage.message.contains("utf-8") {
            if let Some((prefix, index)) = storage.message.rsplit_once("from index ") {
                if let Ok(index) = index.parse::<u64>() {
                    storage.message = format!("{prefix}from index {}", line_offset + index);
                }
            }
        }
    }
    error
}

pub(crate) fn parse_error(error: serde_json::Error) -> EngineError {
    let message = format!("JSONL parse error on line 1: {error}");
    EngineError::Serialization(Box::new(SerializationError {
        format: "jsonl".into(),
        message: format!("Failed to deserialize jsonl data: {message}"),
        cause: Some(serde_json::Value::String(message)),
    }))
}

/// Read one candidate line without retaining the file's payloads.
pub fn read_line(host: &dyn StorageHost, path: &str, offset: u64) -> Result<Vec<u8>, EngineError> {
    let mut line = Vec::new();
    loop {
        let chunk = host.read_range(path, offset + line.len() as u64, 1024)?;
        if let Some(end) = chunk.iter().position(|byte| *byte == b'\n') {
            line.extend_from_slice(&chunk[..end]);
            break;
        }
        if chunk.is_empty() {
            break;
        }
        line.extend_from_slice(&chunk);
    }
    Ok(line)
}
