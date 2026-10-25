//! Decode one field path without allocating unrelated JSON values. The entire
//! line is still parsed, and repeated object keys keep serde_json's last value.
use std::fmt;

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::Value;

use super::borrowed::BorrowedValue;

pub fn decode_field(bytes: &[u8], path: &str) -> Result<Option<Value>, serde_json::Error> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = Field(path).deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

struct Field<'a>(&'a str);
impl<'de> DeserializeSeed<'de> for Field<'_> {
    type Value = Option<Value>;
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> Result<Self::Value, D::Error> {
        decoder.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Field<'_> {
    type Value = Option<Value>;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let (head, tail) = self
            .0
            .split_once('.')
            .map_or((self.0, None), |(a, b)| (a, Some(b)));
        let mut found = None;
        while let Some(key) = map.next_key::<BorrowedValue<'de>>()? {
            if key.as_str() == Some(head) {
                found = match tail {
                    Some(tail) => map.next_value_seed(Field(tail))?,
                    None => Some(map.next_value::<Value>()?),
                };
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(found)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_field_matches_canonical_nested_lookup() {
        for value in [
            json!({"a":{"b":3},"payload":[1,{"q":[true,null]}]}),
            json!([1, 2]),
            json!({"a":false}),
            json!(null),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            for field in ["a", "a.b", "payload", "missing", ""] {
                assert_eq!(
                    decode_field(&bytes, field).unwrap(),
                    crate::query::filter::get_nested_value(&value, field).cloned()
                );
            }
        }
        assert_eq!(
            decode_field(br#"{"a":{"b":1},"a":{"b":2,"b":3}}"#, "a.b").unwrap(),
            Some(json!(3))
        );
        assert_eq!(
            decode_field(br#"{"a":{"b":1},"a":{"c":2}}"#, "a.b").unwrap(),
            None
        );
        assert!(decode_field(br#"{"a":1,"payload":[oops]}"#, "a").is_err());
    }
}
