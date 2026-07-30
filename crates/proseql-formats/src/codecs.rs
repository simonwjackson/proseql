use std::fmt;

use jsonc_parser::{parse_to_serde_value, ParseOptions};
use proseql_engine::value::Value;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Serialize;
use serde_json::{Map, Number};

use crate::prose::ProseCodec;
use crate::{FormatCodec, FormatOptions};

#[derive(Debug, Clone)]
pub struct JsonCodec {
    indent: usize,
}

pub fn json_codec() -> JsonCodec {
    JsonCodec { indent: 2 }
}

impl FormatCodec for JsonCodec {
    fn name(&self) -> &str {
        "json"
    }

    fn extensions(&self) -> &[&str] {
        &["json"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        encode_json_like(
            data,
            options
                .and_then(|value| value.indent)
                .unwrap_or(self.indent),
        )
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        serde_json::from_str(raw).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct YamlCodec {
    indent: usize,
}

pub fn yaml_codec() -> YamlCodec {
    YamlCodec { indent: 2 }
}

impl FormatCodec for YamlCodec {
    fn name(&self) -> &str {
        "yaml"
    }

    fn extensions(&self) -> &[&str] {
        &["yaml", "yml"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        let indent = options
            .and_then(|value| value.indent)
            .unwrap_or(self.indent);
        Ok(encode_yaml_document(data, indent, 80))
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        serde_yaml::from_str(raw).map_err(|error| error.to_string())
    }
}

/// TOML remains object-rooted like the active smol-toml codec.
///
/// On decode, TOML date/time/datetime scalars are converted to their textual TOML/ISO forms
/// because the Rust boundary `Value` model has no distinct `Date` runtime type.
#[derive(Debug, Clone, Copy)]
pub struct TomlCodec;

pub fn toml_codec() -> TomlCodec {
    TomlCodec
}

impl FormatCodec for TomlCodec {
    fn name(&self) -> &str {
        "toml"
    }

    fn extensions(&self) -> &[&str] {
        &["toml"]
    }

    fn encode(&self, data: &Value, _options: Option<FormatOptions>) -> Result<String, String> {
        let Some(stripped) = strip_nulls(data) else {
            return Err(
                "TOML cannot encode a root null because smol-toml only stringifies object roots."
                    .to_owned(),
            );
        };
        match &stripped {
            Value::Object(map) if map.is_empty() => Ok("\n".to_owned()),
            Value::Object(_) => toml::to_string(&stripped)
                .map(|encoded| normalize_toml_inline_arrays(&encoded))
                .map_err(|error| error.to_string()),
            _ => {
                Err("TOML can only encode object roots, matching smol-toml stringify().".to_owned())
            }
        }
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        if raw.trim().is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        let decoded: toml::Value = toml::from_str(raw).map_err(|error| error.to_string())?;
        toml_to_value(decoded)
    }
}

#[derive(Debug, Clone)]
pub struct Json5Codec {
    indent: usize,
}

pub fn json5_codec() -> Json5Codec {
    Json5Codec { indent: 2 }
}

impl FormatCodec for Json5Codec {
    fn name(&self) -> &str {
        "json5"
    }

    fn extensions(&self) -> &[&str] {
        &["json5"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        Ok(encode_json5_value(
            data,
            options
                .and_then(|value| value.indent)
                .unwrap_or(self.indent),
            0,
        ))
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        decode_json5_value(raw)
    }
}

#[derive(Debug, Clone)]
pub struct JsoncCodec {
    indent: usize,
}

pub fn jsonc_codec() -> JsoncCodec {
    JsoncCodec { indent: 2 }
}

impl FormatCodec for JsoncCodec {
    fn name(&self) -> &str {
        "jsonc"
    }

    fn extensions(&self) -> &[&str] {
        &["jsonc"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        encode_json_like(
            data,
            options
                .and_then(|value| value.indent)
                .unwrap_or(self.indent),
        )
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        let options = ParseOptions {
            allow_comments: true,
            allow_loose_object_property_names: false,
            allow_trailing_commas: true,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
        };
        parse_to_serde_value::<Value>(raw, &options).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct JsonlCodec;

pub fn jsonl_codec() -> JsonlCodec {
    JsonlCodec
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub line_number: usize,
    pub raw_line: String,
    pub parsed: Option<Value>,
    pub parse_error: Option<String>,
}

pub fn jsonl_decode_lines(raw: &str) -> Vec<ParsedLine> {
    raw.split('\n')
        .enumerate()
        .filter_map(|(index, line)| {
            if line.trim().is_empty() {
                return None;
            }
            let line_number = index + 1;
            match serde_json::from_str::<Value>(line) {
                Ok(parsed) => Some(ParsedLine {
                    line_number,
                    raw_line: line.to_owned(),
                    parsed: Some(parsed),
                    parse_error: None,
                }),
                Err(error) => Some(ParsedLine {
                    line_number,
                    raw_line: line.to_owned(),
                    parsed: None,
                    parse_error: Some(error.to_string()),
                }),
            }
        })
        .collect()
}

impl FormatCodec for JsonlCodec {
    fn name(&self) -> &str {
        "jsonl"
    }

    fn extensions(&self) -> &[&str] {
        &["jsonl", "ndjson"]
    }

    fn encode(&self, data: &Value, _options: Option<FormatOptions>) -> Result<String, String> {
        match data {
            Value::Array(items) => items
                .iter()
                .map(|item| serde_json::to_string(item).map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()
                .map(|lines| lines.join("\n")),
            _ => serde_json::to_string(data).map_err(|error| error.to_string()),
        }
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        let parsed = jsonl_decode_lines(raw);
        if let Some(line) = parsed.iter().find(|line| line.parse_error.is_some()) {
            return Err(format!(
                "JSONL parse error on line {}: {}",
                line.line_number,
                line.parse_error.as_deref().unwrap_or("Unknown error")
            ));
        }
        Ok(Value::Array(
            parsed.into_iter().filter_map(|line| line.parsed).collect(),
        ))
    }
}

#[derive(Debug, Clone)]
pub struct HjsonCodec {
    indent: usize,
}

pub fn hjson_codec() -> HjsonCodec {
    HjsonCodec { indent: 2 }
}

impl FormatCodec for HjsonCodec {
    fn name(&self) -> &str {
        "hjson"
    }

    fn extensions(&self) -> &[&str] {
        &["hjson"]
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        let indent = options
            .and_then(|value| value.indent)
            .unwrap_or(self.indent);
        let encoded = serde_hjson::to_string(data).map_err(|error| error.to_string())?;
        Ok(normalize_hjson_output(&reindent_yaml(&encoded, indent)))
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        let value: serde_hjson::Value =
            serde_hjson::from_str(raw).map_err(|error| error.to_string())?;
        serde_json::to_value(value).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToonCodec;

pub fn toon_codec() -> ToonCodec {
    ToonCodec
}

impl FormatCodec for ToonCodec {
    fn name(&self) -> &str {
        "toon"
    }

    fn extensions(&self) -> &[&str] {
        &["toon"]
    }

    fn encode(&self, data: &Value, _options: Option<FormatOptions>) -> Result<String, String> {
        toon_format::encode_default(data).map_err(|error| error.to_string())
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        toon_format::decode_default(raw).map_err(|error| error.to_string())
    }
}

pub fn prose_codec(template: Option<String>, overflow: Vec<String>) -> ProseCodec {
    ProseCodec::new(template, overflow)
}

fn encode_json_like(data: &Value, indent: usize) -> Result<String, String> {
    if indent == 0 {
        return serde_json::to_string(data).map_err(|error| error.to_string());
    }

    let mut bytes = Vec::new();
    let indent_bytes = vec![b' '; indent];
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent_bytes.as_slice());
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    data.serialize(&mut serializer)
        .map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn decode_json5_value(raw: &str) -> Result<Value, String> {
    let mut deserializer = json5::Deserializer::from_str(raw);
    StrictJson5Value::deserialize(&mut deserializer)
        .map(|value| value.0)
        .map_err(|error: json5::Error| error.to_string())
}

struct StrictJson5Value(Value);

impl<'de> Deserialize<'de> for StrictJson5Value {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer
            .deserialize_any(StrictJson5ValueVisitor)
            .map(Self)
    }
}

struct StrictJson5ValueVisitor;

impl<'de> Visitor<'de> for StrictJson5ValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON5 value representable by serde_json::Value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| {
                E::custom(
                    "JSON5 non-finite numbers (NaN or Infinity) are unsupported by the proseql Value model",
                )
            })
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut items = Vec::new();
        while let Some(value) = seq.next_element::<StrictJson5Value>()? {
            items.push(value.0);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut object = Map::new();
        while let Some((key, value)) = map.next_entry::<String, StrictJson5Value>()? {
            object.insert(key, value.0);
        }
        Ok(Value::Object(object))
    }
}

fn toml_to_value(value: toml::Value) -> Result<Value, String> {
    match value {
        toml::Value::String(value) => Ok(Value::String(value)),
        toml::Value::Integer(value) => Ok(Value::Number(Number::from(value))),
        toml::Value::Float(value) => Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| format!("TOML float {value} is not representable in serde_json::Value")),
        toml::Value::Boolean(value) => Ok(Value::Bool(value)),
        toml::Value::Datetime(value) => Ok(Value::String(value.to_string())),
        toml::Value::Array(items) => items
            .into_iter()
            .map(toml_to_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        toml::Value::Table(map) => map
            .into_iter()
            .map(|(key, value)| toml_to_value(value).map(|value| (key, value)))
            .collect::<Result<Map<String, Value>, _>>()
            .map(Value::Object),
    }
}

fn encode_json5_value(value: &Value, indent: usize, depth: usize) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => quote_json5_string(value),
        Value::Array(items) => {
            if items.is_empty() {
                return "[]".to_owned();
            }
            let encoded: Vec<String> = items
                .iter()
                .map(|item| encode_json5_value(item, indent, depth + 1))
                .collect();
            if indent == 0 {
                format!("[{}]", encoded.join(","))
            } else {
                let child_pad = " ".repeat((depth + 1) * indent);
                let pad = " ".repeat(depth * indent);
                format!(
                    "[\n{}{},\n{}]",
                    child_pad,
                    encoded.join(&format!(",\n{child_pad}")),
                    pad
                )
            }
        }
        Value::Object(map) => {
            if map.is_empty() {
                return "{}".to_owned();
            }
            let encoded: Vec<String> = map
                .iter()
                .map(|(key, value)| {
                    let key = if is_json5_identifier(key) {
                        key.clone()
                    } else {
                        quote_json5_string(key)
                    };
                    let separator = if indent == 0 { ":" } else { ": " };
                    format!(
                        "{key}{separator}{}",
                        encode_json5_value(value, indent, depth + 1)
                    )
                })
                .collect();
            if indent == 0 {
                format!("{{{}}}", encoded.join(","))
            } else {
                let child_pad = " ".repeat((depth + 1) * indent);
                let pad = " ".repeat(depth * indent);
                format!(
                    "{{\n{}{},\n{}}}",
                    child_pad,
                    encoded.join(&format!(",\n{child_pad}")),
                    pad
                )
            }
        }
    }
}

fn quote_json5_string(value: &str) -> String {
    let quote = if value.contains('\'') && !value.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut output = String::new();
    output.push(quote);
    for ch in value.chars() {
        match ch {
            '\\' => output.push_str("\\\\"),
            '\'' if quote == '\'' => output.push_str("\\'"),
            '"' if quote == '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch.is_control() => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output.push(quote);
    output
}

fn is_json5_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first == '$' || unicode_ident::is_xid_start(first))
        && chars.all(|ch| ch == '_' || ch == '$' || unicode_ident::is_xid_continue(ch))
}

enum YamlInlineScalar {
    Plain(String),
    Raw(String),
}

fn encode_yaml_document(value: &Value, indent: usize, line_width: usize) -> String {
    let lines = encode_yaml_lines(value, indent, line_width, 0);
    let mut output = lines.join("\n");
    output.push('\n');
    output
}

fn encode_yaml_lines(
    value: &Value,
    indent: usize,
    line_width: usize,
    current_indent: usize,
) -> Vec<String> {
    match value {
        Value::Object(map) => encode_yaml_object_lines(map, indent, line_width, current_indent),
        Value::Array(items) => encode_yaml_array_lines(items, indent, line_width, current_indent),
        other => encode_yaml_prefixed_scalar_lines(
            " ".repeat(current_indent),
            scalar_prefix(current_indent),
            other,
            indent,
            line_width,
        ),
    }
}

fn scalar_prefix(current_indent: usize) -> String {
    " ".repeat(current_indent)
}

fn encode_yaml_object_lines(
    map: &Map<String, Value>,
    indent: usize,
    line_width: usize,
    current_indent: usize,
) -> Vec<String> {
    if map.is_empty() {
        return vec![format!("{}{{}}", " ".repeat(current_indent))];
    }

    let mut lines = Vec::new();
    for (key, value) in map {
        let key_repr = encode_yaml_key(key);
        let prefix = format!("{}{}: ", " ".repeat(current_indent), key_repr);
        match value {
            Value::Object(child) if !child.is_empty() => {
                lines.push(format!("{}{}:", " ".repeat(current_indent), key_repr));
                lines.extend(encode_yaml_object_lines(
                    child,
                    indent,
                    line_width,
                    current_indent + indent,
                ));
            }
            Value::Array(items) if !items.is_empty() => {
                lines.push(format!("{}{}:", " ".repeat(current_indent), key_repr));
                lines.extend(encode_yaml_array_lines(
                    items,
                    indent,
                    line_width,
                    current_indent + indent,
                ));
            }
            _ => lines.extend(encode_yaml_prefixed_scalar_lines(
                " ".repeat(current_indent + indent),
                prefix,
                value,
                indent,
                line_width,
            )),
        }
    }
    lines
}

fn encode_yaml_array_lines(
    items: &[Value],
    indent: usize,
    line_width: usize,
    current_indent: usize,
) -> Vec<String> {
    if items.is_empty() {
        return vec![format!("{}[]", " ".repeat(current_indent))];
    }

    let mut lines = Vec::new();
    for item in items {
        match item {
            Value::Object(map) if !map.is_empty() => {
                let mut iter = map.iter();
                let (first_key, first_value) = iter.next().expect("non-empty map");
                let first_key_repr = encode_yaml_key(first_key);
                let first_prefix = format!("{}- {}: ", " ".repeat(current_indent), first_key_repr);
                match first_value {
                    Value::Object(child) if !child.is_empty() => {
                        lines.push(format!(
                            "{}- {}:",
                            " ".repeat(current_indent),
                            first_key_repr
                        ));
                        lines.extend(encode_yaml_object_lines(
                            child,
                            indent,
                            line_width,
                            current_indent + indent * 2,
                        ));
                    }
                    Value::Array(child) if !child.is_empty() => {
                        lines.push(format!(
                            "{}- {}:",
                            " ".repeat(current_indent),
                            first_key_repr
                        ));
                        lines.extend(encode_yaml_array_lines(
                            child,
                            indent,
                            line_width,
                            current_indent + indent * 2,
                        ));
                    }
                    _ => lines.extend(encode_yaml_prefixed_scalar_lines(
                        " ".repeat(current_indent + indent * 2),
                        first_prefix,
                        first_value,
                        indent,
                        line_width,
                    )),
                }
                for (key, value) in iter {
                    let key_repr = encode_yaml_key(key);
                    let prefix = format!("{}{}: ", " ".repeat(current_indent + indent), key_repr);
                    match value {
                        Value::Object(child) if !child.is_empty() => {
                            lines.push(format!(
                                "{}{}:",
                                " ".repeat(current_indent + indent),
                                key_repr
                            ));
                            lines.extend(encode_yaml_object_lines(
                                child,
                                indent,
                                line_width,
                                current_indent + indent * 2,
                            ));
                        }
                        Value::Array(child) if !child.is_empty() => {
                            lines.push(format!(
                                "{}{}:",
                                " ".repeat(current_indent + indent),
                                key_repr
                            ));
                            lines.extend(encode_yaml_array_lines(
                                child,
                                indent,
                                line_width,
                                current_indent + indent * 2,
                            ));
                        }
                        _ => lines.extend(encode_yaml_prefixed_scalar_lines(
                            " ".repeat(current_indent + indent * 2),
                            prefix,
                            value,
                            indent,
                            line_width,
                        )),
                    }
                }
            }
            Value::Array(child) if !child.is_empty() => {
                lines.push(format!("{}-", " ".repeat(current_indent)));
                lines.extend(encode_yaml_array_lines(
                    child,
                    indent,
                    line_width,
                    current_indent + indent,
                ));
            }
            _ => lines.extend(encode_yaml_prefixed_scalar_lines(
                " ".repeat(current_indent + indent),
                format!("{}- ", " ".repeat(current_indent)),
                item,
                indent,
                line_width,
            )),
        }
    }
    lines
}

fn encode_yaml_prefixed_scalar_lines(
    continuation_indent: String,
    prefix: String,
    value: &Value,
    indent: usize,
    line_width: usize,
) -> Vec<String> {
    match value {
        Value::String(text) if text.contains('\n') => {
            if text
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
            {
                return vec![format!("{}\"{}\"", prefix, escape_yaml_double_quoted(text))];
            }
            let mut lines = vec![format!("{}|-", prefix)];
            lines.extend(
                text.split('\n')
                    .map(|line| format!("{}{}", continuation_indent, line)),
            );
            lines
        }
        _ => match encode_yaml_inline_scalar(value) {
            Some(YamlInlineScalar::Plain(text)) => {
                wrap_yaml_plain_scalar_with_width(&prefix, &text, line_width)
                    .split('\n')
                    .map(str::to_owned)
                    .collect()
            }
            Some(YamlInlineScalar::Raw(text)) => vec![format!("{prefix}{text}")],
            None => match value {
                Value::Object(map) if map.is_empty() => vec![format!("{prefix}{{}}")],
                Value::Array(items) if items.is_empty() => vec![format!("{prefix}[]")],
                Value::Object(map) => {
                    let mut lines = vec![prefix.trim_end().to_owned()];
                    lines.extend(encode_yaml_object_lines(
                        map,
                        indent,
                        line_width,
                        continuation_indent.len(),
                    ));
                    lines
                }
                Value::Array(items) => {
                    let mut lines = vec![prefix.trim_end().to_owned()];
                    lines.extend(encode_yaml_array_lines(
                        items,
                        indent,
                        line_width,
                        continuation_indent.len(),
                    ));
                    lines
                }
                _ => unreachable!(),
            },
        },
    }
}

fn encode_yaml_inline_scalar(value: &Value) -> Option<YamlInlineScalar> {
    match value {
        Value::Null => Some(YamlInlineScalar::Raw("null".to_owned())),
        Value::Bool(value) => Some(YamlInlineScalar::Raw(value.to_string())),
        Value::Number(value) => Some(YamlInlineScalar::Raw(value.to_string())),
        Value::String(value) => {
            if value.contains('\n') {
                None
            } else if should_use_plain_yaml_scalar(value) {
                Some(YamlInlineScalar::Plain(value.clone()))
            } else {
                Some(YamlInlineScalar::Raw(format!(
                    "\"{}\"",
                    escape_yaml_double_quoted(value)
                )))
            }
        }
        Value::Array(items) if items.is_empty() => Some(YamlInlineScalar::Raw("[]".to_owned())),
        Value::Object(map) if map.is_empty() => Some(YamlInlineScalar::Raw("{}".to_owned())),
        _ => None,
    }
}

fn encode_yaml_key(value: &str) -> String {
    if should_use_plain_yaml_key(value) {
        value.to_owned()
    } else {
        format!("\"{}\"", escape_yaml_double_quoted(value))
    }
}

fn wrap_yaml_plain_scalar_with_width(prefix: &str, value: &str, line_width: usize) -> String {
    if prefix.len() + value.len() <= line_width || !value.contains(' ') {
        return format!("{prefix}{value}");
    }

    let continuation_prefix = " ".repeat(prefix.chars().take_while(|ch| *ch == ' ').count() + 2);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width = line_width.saturating_sub(prefix.len());

    for word in value.split(' ') {
        let pending_len = if current.is_empty() {
            word.len()
        } else {
            current.len() + 1 + word.len()
        };
        if !current.is_empty() && pending_len > current_width {
            lines.push(current);
            current = word.to_owned();
            current_width = line_width.saturating_sub(continuation_prefix.len());
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.len() <= 1 {
        return format!("{prefix}{value}");
    }

    let mut output = String::new();
    output.push_str(prefix);
    output.push_str(&lines[0]);
    for line in lines.iter().skip(1) {
        output.push('\n');
        output.push_str(&continuation_prefix);
        output.push_str(line);
    }
    output
}

fn normalize_hjson_output(input: &str) -> String {
    input
        .lines()
        .map(normalize_hjson_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_hjson_line(line: &str) -> String {
    let Some((prefix, content)) = split_inline_quoted_scalar(line, '"') else {
        return line.to_owned();
    };
    let value = decode_simple_escaped_scalar(content);
    if value.contains('\t') {
        return format!("{prefix}'''{value}'''");
    }
    if value.chars().any(|ch| ch.is_control()) {
        return format!("{prefix}\"{}\"", escape_hjson_double_quoted(&value));
    }
    line.to_owned()
}

fn split_inline_quoted_scalar(line: &str, quote: char) -> Option<(&str, &str)> {
    let marker = if quote == '"' { ": \"" } else { ": '" };
    let start = line.find(marker).map(|index| index + 2).or_else(|| {
        let array_marker = if quote == '"' { "- \"" } else { "- '" };
        line.find(array_marker).map(|index| index + 2)
    })?;
    if !line.ends_with(quote) || start >= line.len() - 1 {
        return None;
    }
    Some((&line[..start], &line[start + 1..line.len() - 1]))
}

fn decode_simple_escaped_scalar(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        match chars.next() {
            Some('a') => output.push('\u{0007}'),
            Some('b') => output.push('\u{0008}'),
            Some('e') => output.push('\u{001b}'),
            Some('f') => output.push('\u{000c}'),
            Some('n') => output.push('\n'),
            Some('r') => output.push('\r'),
            Some('t') => output.push('\t'),
            Some('"') => output.push('"'),
            Some('\\') => output.push('\\'),
            Some(other) => {
                output.push('\\');
                output.push(other);
            }
            None => output.push('\\'),
        }
    }
    output
}

fn should_use_plain_yaml_key(value: &str) -> bool {
    should_use_plain_yaml_scalar(value) && !value.contains(':')
}

fn should_use_plain_yaml_scalar(value: &str) -> bool {
    if value.is_empty()
        || value.contains('\n')
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value.contains(": ")
        || value.chars().any(|ch| ch.is_control() && ch != '\t')
        || starts_with_yaml_indicator_hazard(value)
        || contains_yaml_comment_hazard(value)
    {
        return false;
    }

    let lower = value.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "null" | "~") {
        return false;
    }

    value.parse::<i64>().is_err() && value.parse::<f64>().is_err()
}

fn starts_with_yaml_indicator_hazard(value: &str) -> bool {
    value.starts_with('#')
        || value.starts_with('!')
        || value.starts_with('&')
        || value.starts_with('*')
        || value.starts_with('{')
        || value.starts_with('}')
        || value.starts_with('[')
        || value.starts_with(']')
        || value.starts_with(',')
        || value.starts_with('|')
        || value.starts_with('>')
        || value.starts_with('@')
        || value.starts_with('`')
        || value.starts_with('"')
        || value.starts_with('\'')
        || value.starts_with("- ")
        || value.starts_with("? ")
        || value.starts_with(": ")
        || value.starts_with('%')
}

fn contains_yaml_comment_hazard(value: &str) -> bool {
    value
        .as_bytes()
        .windows(2)
        .any(|window| window[0].is_ascii_whitespace() && window[1] == b'#')
}

fn escape_yaml_double_quoted(value: &str) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\u{0007}' => output.push_str("\\a"),
            '\u{001b}' => output.push_str("\\e"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch.is_control() => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output
}

fn escape_hjson_double_quoted(value: &str) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            ch if ch.is_control() => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output
}

fn normalize_toml_inline_arrays(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut stack = Vec::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut start_of_line = true;
    let mut escaped = false;

    for ch in input.chars() {
        if in_double {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_double = false;
            }
            start_of_line = ch == '\n';
            continue;
        }
        if in_single {
            output.push(ch);
            if ch == '\'' {
                in_single = false;
            }
            start_of_line = ch == '\n';
            continue;
        }

        match ch {
            '"' => {
                in_double = true;
                output.push(ch);
            }
            '\'' => {
                in_single = true;
                output.push(ch);
            }
            '[' => {
                let is_table = start_of_line;
                stack.push(is_table);
                output.push('[');
                if !is_table {
                    output.push(' ');
                }
                start_of_line = false;
            }
            ']' => {
                let is_table = stack.pop().unwrap_or(false);
                if !is_table && !output.ends_with("[ ") && !output.ends_with(' ') {
                    output.push(' ');
                }
                output.push(']');
                start_of_line = false;
            }
            '\n' => {
                output.push(ch);
                start_of_line = true;
            }
            ch => {
                if start_of_line && ch != ' ' && ch != '\t' {
                    start_of_line = false;
                }
                output.push(ch);
            }
        }
    }

    output
}

fn reindent_yaml(input: &str, indent: usize) -> String {
    if indent == 2 {
        return input.to_owned();
    }

    input
        .lines()
        .map(|line| {
            let spaces = line.chars().take_while(|ch| *ch == ' ').count();
            if spaces == 0 || spaces % 2 != 0 {
                return line.to_owned();
            }
            format!("{}{}", " ".repeat((spaces / 2) * indent), &line[spaces..])
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if input.ends_with('\n') { "\n" } else { "" }
}

fn strip_nulls(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(items) => Some(Value::Array(items.iter().filter_map(strip_nulls).collect())),
        Value::Object(map) => Some(Value::Object(
            map.iter()
                .filter_map(|(key, value)| strip_nulls(value).map(|value| (key.clone(), value)))
                .collect(),
        )),
        _ => Some(value.clone()),
    }
}
