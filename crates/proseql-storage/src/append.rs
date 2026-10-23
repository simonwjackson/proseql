//! Append-only JSONL files: torn final lines, line encoding and append plans.
//!
//! A full rewrite of a JSONL collection file joins compact lines with `\n` and
//! ends without a newline. An append writes complete `\n`-terminated lines with
//! the same encoder, so each record line is byte-identical to the line a
//! rewrite would produce.
//!
//! Only the final line of an append-only file can be incomplete:
//! - no trailing newline and it does not parse: an interrupted append. The
//!   loader ignores it and reports a [`TornLineDiagnostic`]; the next append
//!   truncates the file to the last complete line first.
//! - no trailing newline but it parses: a valid record (for example, the last
//!   line of a rewritten file). The next append writes the missing `\n` first.
//!
//! Every other malformed line stays a strict codec error.

use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, SerializationError};
use proseql_formats::FormatRegistry;
use serde_json::Value;

use crate::collection_file::encode_collection_file;
use crate::host::StorageHost;
use crate::persistence::CollectionStorageConfig;
use crate::source_config::NormalizedCollectionFileSourceConfig;

/// `true` for the formats that support append without rewrite.
pub fn is_append_format(format: &str) -> bool {
    matches!(format, "jsonl" | "ndjson")
}

/// The state of the final line of an append-only JSONL file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonlTail {
    /// Empty, or the content ends with `\n`.
    Complete,
    /// The final line has no `\n` but parses. The next append writes `\n` first.
    Unterminated,
    /// The final line has no `\n` and does not parse: an interrupted append.
    /// `keep` is the byte length through the last `\n` (0 when there is none);
    /// `line` is the 1-based physical line number of the torn line.
    Torn { keep: usize, line: usize },
}

/// Classify the final line of `raw`.
pub fn jsonl_tail(raw: &str) -> JsonlTail {
    jsonl_tail_bytes(raw.as_bytes())
}

/// Classify the final line of raw file bytes. The final line is examined
/// before any UTF-8 decoding, so an interrupted append that stops inside a
/// multi-byte sequence is `Torn`, not a read error.
pub fn jsonl_tail_bytes(raw: &[u8]) -> JsonlTail {
    if raw.is_empty() || raw.ends_with(b"\n") {
        return JsonlTail::Complete;
    }
    let keep = raw
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let parses = std::str::from_utf8(&raw[keep..])
        .is_ok_and(|last| !last.trim().is_empty() && serde_json::from_str::<Value>(last).is_ok());
    if parses {
        return JsonlTail::Unterminated;
    }
    JsonlTail::Torn {
        keep,
        line: raw[..keep].iter().filter(|byte| **byte == b'\n').count() + 1,
    }
}

/// An unterminated, unparseable final line that the loader ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TornLineDiagnostic {
    pub path: String,
    /// 1-based physical line number.
    pub line: usize,
    /// Length of the ignored bytes.
    pub bytes: usize,
    pub message: String,
}

impl TornLineDiagnostic {
    fn new(path: &str, raw: &[u8], keep: usize, line: usize) -> Self {
        let bytes = raw.len() - keep;
        Self {
            path: path.to_owned(),
            line,
            bytes,
            message: format!(
                "Ignored an interrupted append at line {line} of '{path}' ({bytes} bytes without a final newline); the next append removes it"
            ),
        }
    }
}

/// A loaded append-only collection file.
#[derive(Debug, Clone, Default)]
pub struct LoadedAppendFile {
    pub records: IndexMap<String, Value>,
    pub torn: Option<TornLineDiagnostic>,
}

/// Load an append-only JSONL collection file. A torn final line is ignored and
/// reported; everything else follows [`crate::collection_file::load_collection_file`]. When
/// `validate_ids` is set, array IDs must be present and unique, as for
/// partition files.
pub fn load_append_file(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    collection: &CollectionStorageConfig,
    validate_ids: bool,
) -> Result<LoadedAppendFile, EngineError> {
    if !host.exists(&source.path)? {
        return Ok(LoadedAppendFile::default());
    }
    let raw = host.read_bytes(&source.path)?;
    decode_append_bytes(host, formats, source, collection, &raw, validate_ids)
}

/// Decode the caller's exact captured bytes, without another host read or
/// snapshot copy. The caller owns conflict-baseline publication after success.
pub fn decode_append_bytes(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    collection: &CollectionStorageConfig,
    raw: &[u8],
    validate_ids: bool,
) -> Result<LoadedAppendFile, EngineError> {
    let read_error = |error: std::str::Utf8Error| {
        EngineError::Storage(Box::new(proseql_engine::errors::StorageError {
            path: source.path.clone(),
            operation: proseql_engine::errors::StorageOperation::Read,
            message: format!("Failed to read '{}': {error}", source.path),
            cause: None,
        }))
    };
    let (parsed, torn) = {
        let _phase = crate::diagnostics::span("decode_storage");
        if let Some(decoded) = formats.deserialize_append_jsonl(raw, &source.format) {
            let decoded = decoded.map_err(|error| match error {
                proseql_formats::codecs::AppendJsonlError::Utf8(error) => read_error(error),
                proseql_formats::codecs::AppendJsonlError::Parse(message) => {
                    crate::persistence::format_error(
                        proseql_formats::FormatRegistryError::Serialization(SerializationError {
                            format: "jsonl".into(),
                            message: format!("Failed to deserialize jsonl data: {message}"),
                            cause: Some(Value::String(message)),
                        }),
                    )
                }
            })?;
            (
                decoded.value,
                decoded
                    .torn
                    .map(|(keep, line)| TornLineDiagnostic::new(&source.path, raw, keep, line)),
            )
        } else {
            // Custom codecs keep their whole-file interface. Tail recovery is
            // independent of their decode result; no built-in codec is substituted.
            let (keep, torn) = match jsonl_tail_bytes(raw) {
                JsonlTail::Torn { keep, line } => (
                    keep,
                    Some(TornLineDiagnostic::new(&source.path, raw, keep, line)),
                ),
                _ => (raw.len(), None),
            };
            let complete = std::str::from_utf8(&raw[..keep]).map_err(read_error)?;
            (
                formats
                    .deserialize(complete, &source.format)
                    .map_err(crate::persistence::format_error)?,
                torn,
            )
        }
    };
    if validate_ids {
        let _phase = crate::diagnostics::span("decoded_id_validation");
        crate::collection_file::validate_decoded_ids(&parsed, source)?;
    }
    let records = crate::persistence::load_decoded_data(
        host,
        formats,
        &source.path,
        &collection.schema,
        crate::persistence::LoadDataOptions {
            version: collection.version,
            migrations: collection.migrations.clone(),
            collection_name: Some(collection.name.clone()),
            format: Some(source.format.clone()),
            path: None,
            validation: crate::persistence::ValidationMode::Strict,
            id_strategy: Some(collection.id_strategy.clone()),
        },
        parsed,
    )?;
    Ok(LoadedAppendFile { records, torn })
}

/// Encode `records` as complete `\n`-terminated lines with the rewrite encoder.
pub fn encode_append_lines(
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    collection: &CollectionStorageConfig,
    records: &IndexMap<String, Value>,
) -> Result<String, EngineError> {
    if records.is_empty() {
        return Ok(String::new());
    }
    let encoded = encode_collection_file(formats, source, collection, records)?;
    let body = encoded.strip_suffix('\n').unwrap_or(&encoded);
    if body.split('\n').count() != records.len() {
        return Err(EngineError::Serialization(Box::new(SerializationError {
            format: source.format.clone(),
            message: format!(
                "Cannot append to '{}': the codec did not encode one line per record",
                source.path
            ),
            cause: None,
        })));
    }
    Ok(format!("{body}\n"))
}

/// One planned append: truncate `path` to `keep_len`, then append `data`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAppend {
    pub path: String,
    pub keep_len: u64,
    pub data: String,
}

/// Plan an append of complete `lines` after the loaded bytes `current`.
pub fn plan_append(path: &str, current: &[u8], lines: String) -> PlannedAppend {
    let (keep_len, data) = match jsonl_tail_bytes(current) {
        JsonlTail::Complete => (current.len(), lines),
        JsonlTail::Unterminated => (current.len(), format!("\n{lines}")),
        JsonlTail::Torn { keep, .. } => (keep, lines),
    };
    PlannedAppend {
        path: path.to_owned(),
        keep_len: keep_len as u64,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_final_lines() {
        assert_eq!(jsonl_tail(""), JsonlTail::Complete);
        assert_eq!(jsonl_tail("{\"id\":\"a\"}\n"), JsonlTail::Complete);
        assert_eq!(jsonl_tail("{\"id\":\"a\"}"), JsonlTail::Unterminated);
        assert_eq!(
            jsonl_tail("{\"id\":\"a\"}\n{\"id\":\"b\""),
            JsonlTail::Torn { keep: 11, line: 2 }
        );
        assert_eq!(jsonl_tail("{\"id\""), JsonlTail::Torn { keep: 0, line: 1 });
        assert_eq!(
            jsonl_tail("{\"id\":\"a\"}\n  "),
            JsonlTail::Torn { keep: 11, line: 2 }
        );
    }

    #[test]
    fn plans_newline_and_truncation() {
        let lines = "{\"id\":\"c\"}\n".to_owned();
        assert_eq!(plan_append("f", b"", lines.clone()).data, lines);
        let unterminated = plan_append("f", b"{\"id\":\"a\"}", lines.clone());
        assert_eq!(unterminated.keep_len, 10);
        assert_eq!(unterminated.data, format!("\n{lines}"));
        let torn = plan_append("f", b"{\"id\":\"a\"}\n{\"id", lines.clone());
        assert_eq!(torn.keep_len, 11);
        // A torn line that stops inside a UTF-8 sequence.
        let mut raw = b"{\"id\":\"a\"}\n{\"id\":\"\xC3".to_vec();
        assert_eq!(
            jsonl_tail_bytes(&raw),
            JsonlTail::Torn { keep: 11, line: 2 }
        );
        raw.push(b'\n');
        assert_eq!(jsonl_tail_bytes(&raw), JsonlTail::Complete);
        let torn = plan_append("f", b"{\"id\":\"a\"}\n{\"id\":\"\xC3", lines.clone());
        assert_eq!(torn.keep_len, 11);
        assert_eq!(torn.data, lines);
    }
}
