//! Optional vCard 3.0/4.0 codec. `raw` is the only writable truth; query
//! fields are a canonical projection of calcard's parsed model.
mod schema;
use calcard::{
    vcard::{
        VCard, VCardEntry, VCardParameterName as Param, VCardParameterValue,
        VCardProperty as Property, VCardValue, VCardVersion,
    },
    Entry, Parser,
};
use proseql_formats::{FormatCodec, FormatOptions};
pub use schema::vcard_schema;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, Default)]
pub struct VCardCodec;
impl FormatCodec for VCardCodec {
    fn name(&self) -> &str {
        "vCard"
    }
    fn extensions(&self) -> &[&str] {
        &["vcf"]
    }
    fn round_trips_exactly(&self) -> bool {
        true
    }
    fn encode(&self, data: &Value, _: Option<FormatOptions>) -> Result<String, String> {
        let raw = data
            .get("raw")
            .and_then(Value::as_str)
            .ok_or("vCard record needs a string raw field")?;
        parse(raw)?;
        Ok(raw.to_owned())
    }
    fn decode(&self, raw: &str) -> Result<Value, String> {
        let card = parse(raw)?;
        Ok(project(raw, &card))
    }
}

fn parse(raw: &str) -> Result<VCard, String> {
    let mut parser = Parser::new(raw).strict();
    let card = match parser.entry() {
        Entry::VCard(card) => card,
        _ => return Err("Expected one complete vCard".into()),
    };
    if !matches!(parser.entry(), Entry::Eof) {
        return Err("Expected exactly one vCard, with no trailing content".into());
    }
    if card.properties(&Property::Version).count() != 1
        || !matches!(
            card.version(),
            Some(VCardVersion::V3_0 | VCardVersion::V4_0)
        )
    {
        return Err("Expected exactly one VERSION:3.0 or VERSION:4.0".into());
    }
    Ok(card)
}

fn text(value: &VCardValue) -> Option<String> {
    match value {
        VCardValue::Component(parts) => Some(parts.join(",")),
        _ => value.as_text().map(str::to_owned),
    }
}
fn first_text(entry: &VCardEntry) -> Option<String> {
    entry.values.first().and_then(text)
}
fn types(entry: &VCardEntry) -> Vec<String> {
    entry
        .parameters(&Param::Type)
        .filter_map(VCardParameterValue::as_text)
        .map(str::to_ascii_lowercase)
        .collect()
}
fn parameter(entry: &VCardEntry, name: Param) -> Option<String> {
    entry
        .parameters(&name)
        .find_map(VCardParameterValue::as_text)
        .map(parameter_text)
}
// calcard 0.3.13 unquotes parameter text but leaves RFC 6868 caret escapes.
fn parameter_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '^' {
            match chars.peek() {
                Some('n' | 'N') => {
                    chars.next();
                    output.push('\n');
                    continue;
                }
                Some('\'') => {
                    chars.next();
                    output.push('"');
                    continue;
                }
                Some('^') => {
                    chars.next();
                    output.push('^');
                    continue;
                }
                _ => {}
            }
        }
        output.push(ch);
    }
    output
}
fn preference(entry: &VCardEntry) -> Option<u8> {
    entry
        .parameters(&Param::Pref)
        .find_map(|value| match value {
            VCardParameterValue::Integer(value) => u8::try_from(*value)
                .ok()
                .filter(|value| (1..=100).contains(value)),
            _ => None,
        })
        .or_else(|| {
            types(entry)
                .iter()
                .any(|value| value == "pref")
                .then_some(1)
        })
}
fn structured(entry: &VCardEntry, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .enumerate()
        .map(|(index, field)| {
            (
                (*field).into(),
                Value::String(entry.values.get(index).and_then(text).unwrap_or_default()),
            )
        })
        .collect()
}
fn list(card: &VCard, property: Property) -> Vec<String> {
    card.properties(&property)
        .flat_map(|entry| entry.values.iter())
        .flat_map(|value| match value {
            VCardValue::Component(parts) => parts.clone(),
            _ => text(value).into_iter().collect(),
        })
        .collect()
}
fn value_with_types(entry: &VCardEntry, include_pref: bool) -> Option<Value> {
    let mut result = Map::new();
    result.insert("value".into(), first_text(entry)?.into());
    result.insert("types".into(), json!(types(entry)));
    if include_pref {
        if let Some(pref) = preference(entry) {
            result.insert("pref".into(), pref.into());
        }
    }
    Some(Value::Object(result))
}
fn other(entry: &VCardEntry, name: &str) -> bool {
    matches!(&entry.name, Property::Other(value) if value.eq_ignore_ascii_case(name))
}
fn group_value(
    card: &VCard,
    entry: &VCardEntry,
    property: impl Fn(&VCardEntry) -> bool,
) -> Option<String> {
    // An ungrouped GEO is safe only for a single ungrouped address. Labels
    // without a group are likewise ambiguous when several addresses exist.
    if entry.group.is_none()
        && card
            .properties(&Property::Adr)
            .filter(|adr| adr.group.is_none())
            .count()
            != 1
    {
        return None;
    }
    card.entries
        .iter()
        .find(|candidate| candidate.group == entry.group && property(candidate))
        .and_then(first_text)
}
fn address(card: &VCard, entry: &VCardEntry) -> Value {
    let mut result = structured(
        entry,
        &[
            "poBox", "extended", "street", "locality", "region", "postcode", "country",
        ],
    );
    result.insert("types".into(), json!(types(entry)));
    let label = parameter(entry, Param::Label).or_else(|| {
        group_value(card, entry, |candidate| {
            other(candidate, "LABEL") || other(candidate, "X-ABLABEL")
        })
    });
    let geo = parameter(entry, Param::Geo)
        .or_else(|| group_value(card, entry, |candidate| candidate.name == Property::Geo));
    if let Some(label) = label {
        result.insert("label".into(), label.into());
    }
    if let Some(geo) = geo {
        result.insert("geo".into(), geo.into());
    }
    Value::Object(result)
}
fn revision(entry: &VCardEntry) -> Option<String> {
    let value = entry.values.first()?;
    if let Some(text) = text(value) {
        return Some(text);
    }
    let date = value.as_partial_date_time()?.to_date_time()?;
    let mut formatted = date.date_time.format("%Y-%m-%dT%H:%M:%S").to_string();
    if let Some(offset) = date.offset {
        formatted.push_str(&offset.to_string());
    }
    Some(formatted)
}
fn project(raw: &str, card: &VCard) -> Value {
    let mut result = Map::new();
    result.insert("raw".into(), raw.into());
    result.insert(
        "version".into(),
        if card.version() == Some(VCardVersion::V3_0) {
            "3.0"
        } else {
            "4.0"
        }
        .into(),
    );
    for (key, property) in [("uid", Property::Uid), ("fn", Property::Fn)] {
        if let Some(value) = card.property(&property).and_then(first_text) {
            result.insert(key.into(), value.into());
        }
    }
    if let Some(entry) = card.property(&Property::N) {
        result.insert(
            "n".into(),
            Value::Object(structured(
                entry,
                &["family", "given", "additional", "prefix", "suffix"],
            )),
        );
    }
    result.insert("nickname".into(), json!(list(card, Property::Nickname)));
    result.insert("categories".into(), json!(list(card, Property::Categories)));
    for (key, property) in [("emails", Property::Email), ("tels", Property::Tel)] {
        result.insert(
            key.into(),
            Value::Array(
                card.properties(&property)
                    .filter_map(|entry| value_with_types(entry, true))
                    .collect(),
            ),
        );
    }
    result.insert(
        "adrs".into(),
        Value::Array(
            card.properties(&Property::Adr)
                .map(|entry| address(card, entry))
                .collect(),
        ),
    );
    // Existing proseQL filters support scalar-array membership, not an
    // existential filter over nested object arrays. Keep those queries public
    // without adding contacts-specific operators to the engine.
    result.insert("email_values".into(), json!(list(card, Property::Email)));
    result.insert(
        "localities".into(),
        Value::Array(
            card.properties(&Property::Adr)
                .filter_map(|entry| entry.values.get(3).and_then(text))
                .filter(|value| !value.is_empty())
                .map(Value::String)
                .collect(),
        ),
    );
    result.insert(
        "related".into(),
        Value::Array(
            card.entries
                .iter()
                .filter(|entry| entry.name == Property::Related || other(entry, "X-ABRELATEDNAMES"))
                .filter_map(|entry| value_with_types(entry, false))
                .collect(),
        ),
    );
    if let Some(value) = card.property(&Property::Rev).and_then(revision) {
        result.insert("rev".into(), value.into());
    }
    Value::Object(result)
}
