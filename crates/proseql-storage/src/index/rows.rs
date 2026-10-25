//! Bounded text traversal used while constructing positional indexes.
use crate::host::StorageHost;
use proseql_engine::errors::{EngineError, SerializationError};
use proseql_engine::scan::RowLocation;

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
    let mut offset = start;
    let mut line_start = start;
    let mut row = first_row;
    let mut pending = Vec::new();
    while offset < end {
        let chunk = host.read_range(path, offset, (end - offset).min(64 * 1024) as usize)?;
        if chunk.is_empty() {
            return Err(crate::generation::changed(path));
        }
        offset += chunk.len() as u64;
        let mut pos = 0;
        for (i, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            pending.extend_from_slice(&chunk[pos..i]);
            if !pending.iter().all(u8::is_ascii_whitespace) {
                visit(
                    &pending,
                    RowLocation {
                        partition: 0,
                        offset: line_start,
                        ordinal: row,
                    },
                    false,
                )?;
                row += 1;
            }
            line_start += pending.len() as u64 + 1;
            pending.clear();
            pos = i + 1;
        }
        pending.extend_from_slice(&chunk[pos..]);
    }
    if !pending.iter().all(u8::is_ascii_whitespace) {
        visit(
            &pending,
            RowLocation {
                partition: 0,
                offset: line_start,
                ordinal: row,
            },
            true,
        )?;
    }
    Ok(())
}

pub(crate) fn parse_error(error: serde_json::Error) -> EngineError {
    let message = error.to_string();
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
