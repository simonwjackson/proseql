use std::sync::Mutex;

use proseql_engine::value::Value;
use serde_json::{Map, Number};

use crate::{FormatCodec, FormatOptions};

pub use crate::codecs::jsonl_decode_lines;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProseSegment {
    Literal { text: String },
    Field { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledTemplate {
    pub segments: Vec<ProseSegment>,
    pub fields: Vec<String>,
}

pub fn compile_template(template: &str) -> Result<CompiledTemplate, String> {
    let mut segments = Vec::new();
    let mut fields = Vec::new();
    let mut pos = 0usize;
    let mut literal_start = 0usize;
    let mut last_segment_was_field = false;

    while pos < template.len() {
        let ch = template[pos..].chars().next().unwrap_or_default();
        if ch == '{' {
            if pos > literal_start {
                segments.push(ProseSegment::Literal {
                    text: template[literal_start..pos].to_owned(),
                });
                last_segment_was_field = false;
            }

            if last_segment_was_field {
                return Err(format!(
                    "Adjacent fields with no literal separator at position {pos}: fields must be separated by literal text"
                ));
            }

            let close_pos = template[pos + 1..]
                .find('}')
                .map(|offset| pos + 1 + offset)
                .ok_or_else(|| {
                    format!(
                        "Unclosed brace in template at position {pos}: \"{}\"",
                        &template[pos..]
                    )
                })?;

            let field_name = &template[pos + 1..close_pos];
            if field_name.is_empty() {
                return Err(format!("Empty field name in template at position {pos}"));
            }

            segments.push(ProseSegment::Field {
                name: field_name.to_owned(),
            });
            fields.push(field_name.to_owned());
            last_segment_was_field = true;
            pos = close_pos + 1;
            literal_start = pos;
        } else {
            pos += ch.len_utf8();
        }
    }

    if pos > literal_start {
        segments.push(ProseSegment::Literal {
            text: template[literal_start..pos].to_owned(),
        });
    }

    Ok(CompiledTemplate { segments, fields })
}

pub fn compile_overflow_templates(overflow: &[String]) -> Result<Vec<CompiledTemplate>, String> {
    overflow
        .iter()
        .enumerate()
        .map(|(index, template)| {
            compile_template(template)
                .map_err(|error| format!("Error in overflow template at index {index}: {error}"))
        })
        .collect()
}

pub fn serialize_value(value: &Value) -> String {
    match value {
        Value::Null => "~".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(items) => {
            let elements = items
                .iter()
                .map(|item| {
                    let serialized = serialize_value(item);
                    if serialized.contains(',')
                        || serialized.contains(']')
                        || serialized.contains('"')
                    {
                        format!("\"{}\"", serialized.replace('"', r#"\""#))
                    } else {
                        serialized
                    }
                })
                .collect::<Vec<_>>();
            format!("[{}]", elements.join(", "))
        }
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

pub fn deserialize_value(text: &str) -> Value {
    if text == "~" {
        return Value::Null;
    }
    if text == "true" {
        return Value::Bool(true);
    }
    if text == "false" {
        return Value::Bool(false);
    }
    if is_simple_number(text) {
        if let Some(number) = Number::from_string_unchecked(text.to_owned()) {
            return Value::Number(number);
        }
    }
    if text.starts_with('[') && text.ends_with(']') {
        let inner = text[1..text.len() - 1].trim();
        if inner.is_empty() {
            return Value::Array(Vec::new());
        }
        return Value::Array(parse_array_elements(inner));
    }
    Value::String(text.to_owned())
}

pub fn encode_headline(record: &Map<String, Value>, template: &CompiledTemplate) -> String {
    let mut result = String::new();
    for (index, segment) in template.segments.iter().enumerate() {
        match segment {
            ProseSegment::Literal { text } => result.push_str(text),
            ProseSegment::Field { name } => {
                let serialized = serialize_value(record.get(name).unwrap_or(&Value::Null));
                if let Some(next_literal) = find_next_literal(&template.segments, index) {
                    if serialized.contains(next_literal) {
                        result.push('"');
                        result.push_str(&serialized.replace('"', r#"\""#));
                        result.push('"');
                    } else {
                        result.push_str(&serialized);
                    }
                } else {
                    result.push_str(&serialized);
                }
            }
        }
    }
    result
}

pub fn decode_headline(line: &str, template: &CompiledTemplate) -> Option<Value> {
    let mut result = Map::new();
    let mut pos = 0usize;

    for (index, segment) in template.segments.iter().enumerate() {
        match segment {
            ProseSegment::Literal { text } => {
                if !starts_with_at(line, text, pos) {
                    return None;
                }
                pos += text.len();
            }
            ProseSegment::Field { name } => {
                let field_value =
                    if let Some(next_literal) = find_next_literal(&template.segments, index) {
                        let capture = capture_field_value(line, pos, next_literal)?;
                        pos = capture.end_pos;
                        capture.value
                    } else {
                        let value = line[pos..].to_owned();
                        pos = line.len();
                        value
                    };
                result.insert(name.clone(), deserialize_value(&field_value));
            }
        }
    }

    if pos != line.len() {
        return None;
    }

    Some(Value::Object(result))
}

const OVERFLOW_INDENT: &str = "  ";
const CONTINUATION_INDENT: &str = "    ";

pub fn encode_overflow_lines(
    record: &Map<String, Value>,
    overflow_templates: &[CompiledTemplate],
) -> Vec<String> {
    let mut lines = Vec::new();
    for template in overflow_templates {
        if let Some(field_name) = find_multi_line_field(record, &template.fields) {
            lines.extend(encode_multi_line_overflow(record, template, &field_name));
        } else {
            lines.push(format!(
                "{OVERFLOW_INDENT}{}",
                encode_headline(record, template)
            ));
        }
    }
    lines
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodeOverflowResult {
    pub fields: Value,
    pub lines_consumed: usize,
}

pub fn decode_overflow_lines(
    lines: &[String],
    overflow_templates: &[CompiledTemplate],
    base_indent: usize,
) -> DecodeOverflowResult {
    let mut fields = Map::new();
    let mut line_index = 0usize;
    let mut last_matched_field: Option<String> = None;

    while line_index < lines.len() {
        let line = &lines[line_index];
        let indent = measure_indent(line);
        if indent < base_indent {
            break;
        }

        if indent > base_indent {
            if let Some(field_name) = &last_matched_field {
                append_continuation(&mut fields, field_name, line[indent..].to_owned());
            }
            line_index += 1;
            continue;
        }

        let content = line[base_indent..].to_owned();
        let mut matched = false;
        for template in overflow_templates {
            if let Some(Value::Object(decoded)) = decode_headline(&content, template) {
                for (field_name, value) in decoded {
                    last_matched_field = Some(field_name.clone());
                    fields.insert(field_name, value);
                }
                matched = true;
                break;
            }
        }

        if !matched {
            if let Some(field_name) = &last_matched_field {
                if indent > base_indent {
                    append_continuation(&mut fields, field_name, line[indent..].to_owned());
                }
            }
        }

        line_index += 1;
    }

    DecodeOverflowResult {
        fields: Value::Object(fields),
        lines_consumed: line_index,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanDirectiveResult {
    pub preamble_end: isize,
    pub directive_start: usize,
}

pub fn scan_directive(lines: &[String]) -> Result<ScanDirectiveResult, String> {
    let mut directive_index = None;

    for (index, line) in lines.iter().enumerate() {
        if line.starts_with("@prose ") {
            if let Some(first) = directive_index {
                return Err(format!(
                    "Multiple @prose directives found: first at line {}, second at line {}. Only one directive per file is allowed.",
                    first + 1,
                    index + 1
                ));
            }
            directive_index = Some(index);
        }
    }

    let directive_start = directive_index.ok_or_else(|| {
        "No @prose directive found. The file must contain a line starting with '@prose ' to define the record template.".to_owned()
    })?;

    Ok(ScanDirectiveResult {
        preamble_end: if directive_start > 0 {
            directive_start as isize - 1
        } else {
            -1
        },
        directive_start,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveBlock {
    pub headline_template: String,
    pub overflow_templates: Vec<String>,
    pub body_start: usize,
}

pub fn parse_directive_block(lines: &[String], directive_start: usize) -> DirectiveBlock {
    let headline_template = lines[directive_start]["@prose ".len()..].to_owned();
    let mut overflow_templates = Vec::new();
    let mut line_index = directive_start + 1;

    while line_index < lines.len() {
        let line = &lines[line_index];
        if !line.is_empty() && (line.starts_with(' ') || line.starts_with('\t')) {
            overflow_templates.push(line.trim_start().to_owned());
            line_index += 1;
        } else {
            break;
        }
    }

    DirectiveBlock {
        headline_template,
        overflow_templates,
        body_start: line_index,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProseEntry {
    Record {
        fields: Value,
        headline: String,
        overflow_lines: Vec<String>,
    },
    Passthrough {
        lines: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseBodyResult {
    pub entries: Vec<ProseEntry>,
}

pub fn parse_body(
    lines: &[String],
    body_start: usize,
    headline_template: &CompiledTemplate,
) -> ParseBodyResult {
    let mut entries = Vec::new();
    let mut line_index = body_start;
    let mut current_passthrough = Vec::new();

    let flush_passthrough = |entries: &mut Vec<ProseEntry>, lines: &mut Vec<String>| {
        if !lines.is_empty() {
            entries.push(ProseEntry::Passthrough {
                lines: std::mem::take(lines),
            });
        }
    };

    while line_index < lines.len() {
        let line = &lines[line_index];
        if !line.is_empty() && (line.starts_with(' ') || line.starts_with('\t')) {
            match entries.last_mut() {
                Some(ProseEntry::Record { overflow_lines, .. }) => {
                    overflow_lines.push(line.clone())
                }
                _ => current_passthrough.push(line.clone()),
            }
            line_index += 1;
            continue;
        }

        if let Some(decoded) = decode_headline(line, headline_template) {
            flush_passthrough(&mut entries, &mut current_passthrough);
            entries.push(ProseEntry::Record {
                fields: decoded,
                headline: line.clone(),
                overflow_lines: Vec::new(),
            });
        } else {
            current_passthrough.push(line.clone());
        }
        line_index += 1;
    }

    flush_passthrough(&mut entries, &mut current_passthrough);

    ParseBodyResult { entries }
}

#[derive(Debug, Clone)]
struct CompiledProseCodec {
    headline_template: CompiledTemplate,
    overflow_templates: Vec<CompiledTemplate>,
    raw_headline_template: String,
    raw_overflow_templates: Vec<String>,
}

#[derive(Debug)]
pub struct ProseCodec {
    compiled: Mutex<Result<Option<CompiledProseCodec>, String>>,
}

impl ProseCodec {
    pub fn new(template: Option<String>, overflow: Vec<String>) -> Self {
        let compiled = match template {
            Some(template) => compile_prose_codec_options(template, overflow).map(Some),
            None => Ok(None),
        };
        Self {
            compiled: Mutex::new(compiled),
        }
    }
}

impl FormatCodec for ProseCodec {
    fn name(&self) -> &str {
        "prose"
    }

    fn extensions(&self) -> &[&str] {
        &["prose"]
    }

    fn encode(&self, data: &Value, _options: Option<FormatOptions>) -> Result<String, String> {
        let compiled_guard = self
            .compiled
            .lock()
            .map_err(|_| "Poisoned prose codec state".to_owned())?;
        let compiled = compiled_guard
            .as_ref()
            .map_err(Clone::clone)?
            .as_ref()
            .ok_or_else(|| {
                "Cannot encode prose: no template provided and no file has been decoded yet. Either pass a template to prose_codec() or decode a .prose file first.".to_owned()
            })?;

        let records = data
            .as_array()
            .ok_or_else(|| "Prose codec expects an array of records to encode".to_owned())?;

        let mut lines = Vec::new();
        lines.push(format!("@prose {}", compiled.raw_headline_template));
        for template in &compiled.raw_overflow_templates {
            lines.push(format!("  {template}"));
        }
        lines.push(String::new());

        for record in records {
            let record = record
                .as_object()
                .ok_or_else(|| "Prose codec expects an array of records to encode".to_owned())?;
            lines.push(encode_headline(record, &compiled.headline_template));
            lines.extend(encode_overflow_lines(record, &compiled.overflow_templates));
        }

        Ok(lines.join("\n"))
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        let lines = raw.split('\n').map(str::to_owned).collect::<Vec<_>>();
        let scan = scan_directive(&lines)?;
        let directive = parse_directive_block(&lines, scan.directive_start);
        let file_headline_template = compile_template(&directive.headline_template)?;
        let file_overflow_templates = compile_overflow_templates(&directive.overflow_templates)?;

        {
            let mut compiled = self
                .compiled
                .lock()
                .map_err(|_| "Poisoned prose codec state".to_owned())?;
            let configured = compiled.as_mut().map_err(|error| error.clone())?;
            if configured.is_none() {
                *configured = Some(CompiledProseCodec {
                    headline_template: file_headline_template.clone(),
                    overflow_templates: file_overflow_templates.clone(),
                    raw_headline_template: directive.headline_template.clone(),
                    raw_overflow_templates: directive.overflow_templates.clone(),
                });
            }
        }

        let body = parse_body(&lines, directive.body_start, &file_headline_template);
        let mut records = Vec::new();

        for entry in body.entries {
            if let ProseEntry::Record {
                fields,
                overflow_lines,
                ..
            } = entry
            {
                let mut record = match fields {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                if !overflow_lines.is_empty() {
                    let overflow =
                        decode_overflow_lines(&overflow_lines, &file_overflow_templates, 2);
                    if let Value::Object(overflow_fields) = overflow.fields {
                        for (key, value) in overflow_fields {
                            record.insert(key, value);
                        }
                    }
                }
                records.push(Value::Object(record));
            }
        }

        Ok(Value::Array(records))
    }
}

fn compile_prose_codec_options(
    template: String,
    overflow: Vec<String>,
) -> Result<CompiledProseCodec, String> {
    let headline_template = compile_template(&template)?;
    let overflow_templates = compile_overflow_templates(&overflow)?;
    Ok(CompiledProseCodec {
        headline_template,
        overflow_templates,
        raw_headline_template: template,
        raw_overflow_templates: overflow,
    })
}

fn parse_array_elements(inner: &str) -> Vec<Value> {
    let mut elements = Vec::new();
    let mut pos = 0usize;
    let mut element_start = 0usize;
    let mut in_quotes = false;

    while pos <= inner.len() {
        if pos == inner.len() || (!in_quotes && inner[pos..].starts_with(',')) {
            let element = inner[element_start..pos].trim();
            if !element.is_empty() {
                if element.starts_with('"') && element.ends_with('"') && element.len() >= 2 {
                    let unquoted = element[1..element.len() - 1].replace(r#"\""#, "\"");
                    elements.push(deserialize_value(&unquoted));
                } else {
                    elements.push(deserialize_value(element));
                }
            }
            element_start = pos + 1;
            pos += 1;
            continue;
        }

        let ch = inner[pos..].chars().next().unwrap_or_default();
        if ch == '"' {
            let element_so_far = inner[element_start..pos].trim();
            if element_so_far.is_empty() || in_quotes {
                let escaped = pos > 0 && inner[..pos].ends_with('\\');
                if !escaped {
                    in_quotes = !in_quotes;
                }
            }
        }
        pos += ch.len_utf8();
    }

    elements
}

fn find_next_literal(segments: &[ProseSegment], current_index: usize) -> Option<&str> {
    segments
        .iter()
        .skip(current_index + 1)
        .find_map(|segment| match segment {
            ProseSegment::Literal { text } => Some(text.as_str()),
            ProseSegment::Field { .. } => None,
        })
}

fn capture_field_value(line: &str, start_pos: usize, delimiter: &str) -> Option<CapturedField> {
    if line[start_pos..].starts_with('"') {
        let quoted = scan_quoted_value(line, start_pos)?;
        if !starts_with_at(line, delimiter, quoted.end_pos) {
            return None;
        }
        return Some(CapturedField {
            value: quoted.value,
            end_pos: quoted.end_pos,
        });
    }

    let delimiter_pos = line[start_pos..]
        .find(delimiter)
        .map(|offset| start_pos + offset)?;
    Some(CapturedField {
        value: line[start_pos..delimiter_pos].to_owned(),
        end_pos: delimiter_pos,
    })
}

#[derive(Debug, Clone)]
struct CapturedField {
    value: String,
    end_pos: usize,
}

fn scan_quoted_value(line: &str, start_pos: usize) -> Option<CapturedField> {
    let mut pos = start_pos + 1;
    let mut value = String::new();

    while pos < line.len() {
        let ch = line[pos..].chars().next().unwrap_or_default();
        if ch == '\\' {
            if let Some(next_char) = line[pos + 1..].chars().next() {
                if next_char == '"' {
                    value.push('"');
                    pos += 2;
                    continue;
                }
            }
            value.push('\\');
            pos += 1;
        } else if ch == '"' {
            return Some(CapturedField {
                value,
                end_pos: pos + 1,
            });
        } else {
            value.push(ch);
            pos += ch.len_utf8();
        }
    }

    None
}

fn find_multi_line_field(record: &Map<String, Value>, fields: &[String]) -> Option<String> {
    fields
        .iter()
        .find_map(|field_name| match record.get(field_name) {
            Some(Value::String(value)) if value.contains('\n') => Some(field_name.clone()),
            _ => None,
        })
}

fn encode_multi_line_overflow(
    record: &Map<String, Value>,
    template: &CompiledTemplate,
    multi_line_field: &str,
) -> Vec<String> {
    let value = match record.get(multi_line_field) {
        Some(Value::String(value)) => value,
        _ => {
            return vec![format!(
                "{OVERFLOW_INDENT}{}",
                encode_headline(record, template)
            )]
        }
    };

    let value_lines = value.split('\n').collect::<Vec<_>>();
    let mut modified = record.clone();
    modified.insert(
        multi_line_field.to_owned(),
        Value::String(value_lines.first().copied().unwrap_or_default().to_owned()),
    );

    let mut lines = vec![format!(
        "{OVERFLOW_INDENT}{}",
        encode_headline(&modified, template)
    )];
    for continuation in value_lines.into_iter().skip(1) {
        lines.push(format!("{CONTINUATION_INDENT}{continuation}"));
    }
    lines
}

fn measure_indent(line: &str) -> usize {
    line.chars()
        .take_while(|ch| matches!(ch, ' ' | '\t'))
        .count()
}

fn append_continuation(fields: &mut Map<String, Value>, field_name: &str, continuation: String) {
    let existing = fields.get(field_name).cloned();
    let next = match existing {
        Some(Value::String(value)) => Value::String(format!("{value}\n{continuation}")),
        Some(value) => Value::String(format!("{}\n{continuation}", display_value(&value))),
        None => Value::String(continuation),
    };
    fields.insert(field_name.to_owned(), next);
}

fn display_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn is_simple_number(text: &str) -> bool {
    let mut chars = text.chars().peekable();
    if chars.peek().is_none() {
        return false;
    }
    if matches!(chars.peek(), Some('-')) {
        chars.next();
    }

    let mut digits_before = 0usize;
    while matches!(chars.peek(), Some(ch) if ch.is_ascii_digit()) {
        digits_before += 1;
        chars.next();
    }
    if digits_before == 0 {
        return false;
    }

    if matches!(chars.peek(), Some('.')) {
        chars.next();
        let mut digits_after = 0usize;
        while matches!(chars.peek(), Some(ch) if ch.is_ascii_digit()) {
            digits_after += 1;
            chars.next();
        }
        if digits_after == 0 {
            return false;
        }
    }

    chars.next().is_none()
}

fn starts_with_at(line: &str, needle: &str, pos: usize) -> bool {
    line.get(pos..)
        .is_some_and(|suffix| suffix.starts_with(needle))
}

trait NumberExt {
    fn from_string_unchecked(value: String) -> Option<Number>;
}

impl NumberExt for Number {
    fn from_string_unchecked(value: String) -> Option<Number> {
        serde_json::from_str::<Value>(&value)
            .ok()
            .and_then(|value| value.as_number().cloned())
    }
}
