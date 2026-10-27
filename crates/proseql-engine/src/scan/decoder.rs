//! Prepared top-level schema layout. One object allocation replaces repeated
//! per-row name searches, duplicate-key searches, retain and sorting passes.
use std::{borrow::Cow, fmt};

use super::borrowed::BorrowedValue;
use crate::descriptor::{SchemaNode, StructField};
use serde::{
    de::{DeserializeSeed, MapAccess, Visitor},
    Deserializer,
};

pub struct SimpleDecoder<'a> {
    fields: &'a [StructField],
    names: Vec<(&'a str, usize)>,
    // Empty names share bucket zero with NUL-prefixed names.
    buckets: [usize; 257],
}
fn supported(schema: &SchemaNode) -> bool {
    match schema {
        SchemaNode::Str | SchemaNode::Num | SchemaNode::Bool | SchemaNode::Unknown => true,
        SchemaNode::Optional(inner)
        | SchemaNode::NullOr(inner)
        | SchemaNode::OptionalWithDefault { inner, .. } => supported(inner),
        SchemaNode::Struct { fields } => fields.iter().all(|field| supported(&field.schema)),
        SchemaNode::Array { item } => supported(item),
        _ => false,
    }
}
impl<'a> SimpleDecoder<'a> {
    pub fn new(schema: &'a SchemaNode) -> Option<Self> {
        let SchemaNode::Struct { fields } = schema else {
            return None;
        };
        // Unsupported transforms/checks keep the generic borrowed parse, so
        // canonical payload decoding does not disable positional key building.
        if fields.len() > 128 || !fields.iter().all(|field| supported(&field.schema)) {
            return None;
        }
        let mut names: Vec<_> = fields
            .iter()
            .enumerate()
            .map(|(index, field)| (field.name.as_str(), index))
            .collect();
        names.sort_unstable_by_key(|(name, _)| *name);
        // Malformed descriptors are left to the ordinary decoder.
        if names.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return None;
        }
        let mut buckets = [0; 257];
        for (name, _) in &names {
            buckets[usize::from(name.as_bytes().first().copied().unwrap_or(0)) + 1] += 1;
        }
        for index in 1..buckets.len() {
            buckets[index] += buckets[index - 1];
        }
        Some(Self {
            fields,
            names,
            buckets,
        })
    }
    pub fn decode<'de>(
        &'de self,
        bytes: &'de [u8],
    ) -> Result<Option<BorrowedValue<'de>>, serde_json::Error> {
        self.decode_positioned(bytes)
            .map(|row| row.map(|(value, _)| value))
    }
    /// Returns the compact row and its schema-field presence mask together.
    pub fn decode_positioned<'de>(
        &'de self,
        bytes: &'de [u8],
    ) -> Result<Option<(BorrowedValue<'de>, u128)>, serde_json::Error> {
        let mut decoder = serde_json::Deserializer::from_slice(bytes);
        let mut value = RowSeed::<false> {
            decoder: self,
            needed: 0,
        }
        .deserialize(&mut decoder)?;
        decoder.end()?;
        let BorrowedValue::Object(values) = &mut value.0 else {
            return Ok(None);
        };
        for (index, field) in self.fields.iter().enumerate() {
            if value.1 & (1u128 << index) == 0 {
                if !matches!(
                    field.schema,
                    SchemaNode::Optional(_) | SchemaNode::OptionalWithDefault { .. }
                ) {
                    return Ok(None);
                }
            } else if !values[index].1.decode_simple(&field.schema) {
                return Ok(None);
            }
        }
        let mut index = 0;
        values.retain(|_| {
            let keep = value.1 & (1u128 << index) != 0;
            index += 1;
            keep
        });
        Ok(Some(value))
    }

    /// Only scalar, non-transforming layouts can omit unused values. Nested
    /// structs require schema stripping even when their generation is valid.
    pub fn projection(&self, fields: &[String]) -> Option<u128> {
        fn scalar(schema: &SchemaNode) -> bool {
            match schema {
                SchemaNode::Str | SchemaNode::Num | SchemaNode::Bool => true,
                SchemaNode::Optional(inner) | SchemaNode::NullOr(inner) => scalar(inner),
                _ => false,
            }
        }
        if !self.fields.iter().all(|field| scalar(&field.schema)) {
            return None;
        }
        Some(
            self.fields
                .iter()
                .enumerate()
                .fold(0, |mask, (index, field)| {
                    mask | if fields.iter().any(|name| name == &field.name) {
                        1u128 << index
                    } else {
                        0
                    }
                }),
        )
    }

    /// The caller must prove that these exact bytes already passed this schema
    /// and must check the file generation again before returning an answer.
    /// JSON framing is still decoded; unused values need no value allocation.
    /// A file proof can include an ignored torn tail: final unterminated lines
    /// must use ordinary validation/torn-line handling instead of this method.
    pub fn decode_proven_positioned<'de>(
        &'de self,
        bytes: &'de [u8],
        needed: u128,
    ) -> Result<(BorrowedValue<'de>, u128), serde_json::Error> {
        if let Some(value) = super::proven::decode(bytes, self.fields, needed, |name| {
            let bucket = usize::from(name.as_bytes().first().copied().unwrap_or(0));
            self.names[self.buckets[bucket]..self.buckets[bucket + 1]]
                .iter()
                .find(|(candidate, _)| *candidate == name)
                .map(|(_, index)| *index)
        }) {
            return Ok(value);
        }
        let mut decoder = serde_json::Deserializer::from_slice(bytes);
        let mut value = RowSeed::<true> {
            decoder: self,
            needed,
        }
        .deserialize(&mut decoder)?;
        decoder.end()?;
        if let BorrowedValue::Object(values) = &mut value.0 {
            let mut index = 0;
            values.retain(|_| {
                let keep = value.1 & (1u128 << index) != 0;
                index += 1;
                keep
            });
        }
        Ok(value)
    }
}
struct RowSeed<'a, const PROVEN: bool> {
    decoder: &'a SimpleDecoder<'a>,
    needed: u128,
}
impl<'de, const PROVEN: bool> DeserializeSeed<'de> for RowSeed<'de, PROVEN> {
    type Value = (BorrowedValue<'de>, u128);
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> Result<Self::Value, D::Error> {
        decoder.deserialize_any(self)
    }
}
impl<'de, const PROVEN: bool> Visitor<'de> for RowSeed<'de, PROVEN> {
    type Value = (BorrowedValue<'de>, u128);
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a row object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values: Vec<_> = self
            .decoder
            .fields
            .iter()
            .map(|field| (Cow::Borrowed(field.name.as_str()), BorrowedValue::Null))
            .collect();
        let mut seen = 0;
        while let Some(key) = map.next_key::<BorrowedValue<'de>>()? {
            // Keep the unproven parse identical to the canonical decoder.
            // Const specialization removes proof/mask work from that path.
            let value = if PROVEN {
                None
            } else {
                Some(map.next_value::<BorrowedValue<'de>>()?)
            };
            let index = key.as_str().and_then(|name| {
                let bucket = usize::from(name.as_bytes().first().copied().unwrap_or(0));
                self.decoder.names[self.decoder.buckets[bucket]..self.decoder.buckets[bucket + 1]]
                    .iter()
                    .find(|(candidate, _)| *candidate == name)
                    .map(|(_, index)| *index)
            });
            if let Some(index) =
                index.filter(|index| !PROVEN || self.needed & (1u128 << index) != 0)
            {
                values[index].1 = match value {
                    Some(value) => value,
                    None => map.next_value::<BorrowedValue<'de>>()?,
                };
                seen |= 1u128 << index;
            } else if PROVEN {
                map.next_value::<serde::de::IgnoredAny>()?;
            }
        }
        Ok((BorrowedValue::Object(values), seen))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn prepared_name_buckets_cover_empty_nul_unicode_and_shared_prefixes() {
        let names = ["", "\0", "at", "atUtc", "å", "value", "v"];
        let schema = SchemaNode::Struct {
            fields: names
                .iter()
                .map(|name| StructField {
                    name: (*name).into(),
                    schema: SchemaNode::Str,
                })
                .collect(),
        };
        let value = serde_json::Value::Object(
            names
                .iter()
                .map(|name| ((*name).into(), json!(name)))
                .collect(),
        );
        let text = serde_json::to_vec(&value).unwrap();
        let decoder = SimpleDecoder::new(&schema).unwrap();
        assert_eq!(decoder.decode(&text).unwrap().unwrap().to_owned(), value);
    }

    #[test]
    fn prepared_layout_matches_generic_decode_including_duplicate_and_unknown_fields() {
        let schema = SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "b".into(),
                    schema: SchemaNode::Num,
                },
                StructField {
                    name: "a".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "optional".into(),
                    schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                },
            ],
        };
        let decoder = SimpleDecoder::new(&schema).unwrap();
        for bytes in [
            br#"{"a":"x","b":2,"unknown":[true]}"#.as_slice(),
            br#"{"b":false,"a":"first","b":3,"a":"last"}"#,
            br#"{"a":"x","b":2,"optional":null}"#,
            br#"{"b":2}"#,
        ] {
            let mut generic: BorrowedValue<'_> = serde_json::from_slice(bytes).unwrap();
            let valid = generic.decode_simple(&schema);
            let prepared = decoder.decode(bytes).unwrap();
            assert_eq!(prepared.is_some(), valid);
            if let Some(prepared) = prepared {
                assert_eq!(prepared.to_owned(), generic.to_owned());
            }
        }
        assert_eq!(
            decoder
                .decode(br#"{"a":"x","b":2}"#)
                .unwrap()
                .unwrap()
                .to_owned(),
            json!({"b":2,"a":"x"})
        );
        assert!(decoder.decode(br#"{"a":"x","b":2,"extra":1e999}"#).is_err());
    }
}
