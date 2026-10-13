//! Byte-preserving edits for independently decodable block-style YAML maps.
//!
//! This is deliberately not a YAML lexer. Candidate key lines are decoded by
//! the configured codec, and every complete entry must decode independently to
//! its loaded value. Flow maps, complex/multiline keys, document directives and
//! cross-collection aliases cannot be spliced. A final whole-document check
//! rejects unsafe splices (including scalar chomping interactions with retained
//! blank lines). Failures stop the save; no filesystem work happens here.

use std::collections::HashSet;
use std::ops::Range;

use proseql_formats::FormatRegistry;
use serde_json::{Map, Value};

use crate::document_source::{same_persisted_map, same_persisted_value};

struct Entry {
    key: String,
    body: Range<usize>,
    trivia: Range<usize>,
}

struct BlockMap {
    prefix: Range<usize>,
    entries: Vec<Entry>,
    indent: usize,
}

/// Preserve the loaded bytes unless a value changed. Recurse once to preserve
/// records within changed collections, not arbitrary fields inside records.
/// Failure tells the caller to stop the save, never to rewrite untouched blocks.
pub(crate) fn splice_document(
    formats: &FormatRegistry,
    format: &str,
    raw: &str,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Result<String, &'static str> {
    if !matches!(format, "yaml" | "yml") {
        return Err("byte-preserving document edits are only supported for YAML");
    }
    let candidate = splice_map(formats, format, raw, before, after, 0, 1)
        .ok_or("cannot segment or encode independently decodable collection blocks")?;
    validate_document(formats, format, &candidate, after)?;
    Ok(candidate)
}

pub(crate) fn validate_document(
    formats: &FormatRegistry,
    format: &str,
    candidate: &str,
    after: &Map<String, Value>,
) -> Result<(), &'static str> {
    let parsed = formats
        .deserialize(candidate, format)
        .map_err(|_| "emitted document does not parse with the configured codec")?;
    let matches = parsed
        .as_object()
        .is_some_and(|parsed| same_persisted_map(parsed, after));
    if !matches {
        return Err("emitted document does not match the projected persisted state");
    }
    debug_assert!(same_persisted_map(
        parsed.as_object().expect("checked object"),
        after
    ));
    Ok(())
}

fn splice_map(
    formats: &FormatRegistry,
    format: &str,
    raw: &str,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    indent: usize,
    depth: usize,
) -> Option<String> {
    let blocks = segment_map(formats, format, raw, before, indent)?;
    let mut result = raw[blocks.prefix].to_owned();
    for entry in &blocks.entries {
        let body = &raw[entry.body.clone()];
        if let Some(value) = after.get(&entry.key) {
            if same_persisted_value(&before[&entry.key], value) {
                result.push_str(body);
            } else {
                let records = (depth > 0)
                    .then(|| {
                        let old = before[&entry.key].as_object()?;
                        let new = value.as_object()?;
                        if new.is_empty() {
                            return None;
                        }
                        let header_end = body.find('\n')? + 1;
                        // Inline/flow collection values cannot have record spans.
                        let header = formats
                            .deserialize(body[..header_end].trim_start(), format)
                            .ok()?;
                        if !header.get(&entry.key)?.is_null() {
                            return None;
                        }
                        let rest = &body[header_end..];
                        let child_indent = rest
                            .lines()
                            .filter(|line| !is_trivia(line))
                            .map(|line| line.len() - line.trim_start_matches(' ').len())
                            .min()?;
                        if child_indent <= blocks.indent {
                            return None;
                        }
                        let records =
                            splice_map(formats, format, rest, old, new, child_indent, depth - 1)?;
                        Some(format!("{}{records}", &body[..header_end]))
                    })
                    .flatten();
                result.push_str(
                    &records.or_else(|| {
                        emit_entry(formats, format, &entry.key, value, blocks.indent)
                    })?,
                );
            }
        }
        // Separators stay in place even when the adjacent entry is replaced or
        // deleted. They are not owned by the serializer of either neighbor.
        result.push_str(&raw[entry.trivia.clone()]);
    }
    for (key, value) in after {
        if !before.contains_key(key) {
            if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&emit_entry(formats, format, key, value, blocks.indent)?);
        }
    }
    Some(result)
}

fn emit_entry(
    formats: &FormatRegistry,
    format: &str,
    key: &str,
    value: &Value,
    indent: usize,
) -> Option<String> {
    let entry = Map::from_iter([(key.to_owned(), value.clone())]);
    let text = formats
        .serialize(&Value::Object(entry), format, None)
        .ok()?;
    let padding = " ".repeat(indent);
    Some(
        text.split_inclusive('\n')
            .map(|line| format!("{padding}{line}"))
            .collect(),
    )
}

fn is_trivia(line: &str) -> bool {
    let text = line.trim();
    text.is_empty() || text.starts_with('#')
}

fn unindent(raw: &str, indent: usize) -> Option<String> {
    let padding = " ".repeat(indent);
    raw.split_inclusive('\n')
        .map(|line| {
            if line.trim().is_empty() {
                Some(line.to_owned())
            } else {
                line.strip_prefix(&padding).map(str::to_owned)
            }
        })
        .collect()
}

fn segment_map(
    formats: &FormatRegistry,
    format: &str,
    raw: &str,
    before: &Map<String, Value>,
    indent: usize,
) -> Option<BlockMap> {
    let mut starts = Vec::new();
    let mut seen = HashSet::new();
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        if !is_trivia(line) {
            let spaces = line.len() - line.trim_start_matches(' ').len();
            if spaces < indent {
                return None;
            }
            if spaces == indent {
                if line[indent..].starts_with(['{', '[']) {
                    return None;
                }
                let header = formats.deserialize(&line[indent..], format).ok()?;
                let header = header.as_object()?;
                if header.len() != 1 {
                    return None;
                }
                let key = header.keys().next()?.clone();
                if !before.contains_key(&key) || !seen.insert(key.clone()) {
                    return None;
                }
                starts.push((offset, key));
            }
        }
        offset += line.len();
    }
    if starts.len() != before.len() {
        return None;
    }
    let prefix = 0..starts.first().map_or(raw.len(), |(start, _)| *start);
    let mut entries = Vec::new();
    for (index, (start, key)) in starts.iter().enumerate() {
        let end = starts.get(index + 1).map_or(raw.len(), |(start, _)| *start);
        let text = unindent(&raw[*start..end], indent)?;
        let parsed = formats.deserialize(&text, format).ok()?;
        let parsed = parsed.as_object()?;
        if parsed.len() != 1
            || !parsed
                .get(key)
                .is_some_and(|value| same_persisted_value(value, &before[key]))
        {
            return None;
        }
        let mut body_end = *start;
        let mut line_end = *start;
        for line in raw[*start..end].split_inclusive('\n') {
            line_end += line.len();
            if !is_trivia(line) {
                body_end = line_end;
            }
        }
        entries.push(Entry {
            key: key.clone(),
            body: *start..body_end,
            trivia: body_end..end,
        });
    }
    Some(BlockMap {
        prefix,
        entries,
        indent,
    })
}
