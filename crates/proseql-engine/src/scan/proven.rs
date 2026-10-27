//! Scalar recognition for already-validated text. This is not a validator:
//! escapes, containers and other complex spellings use serde's decoder. A
//! changed generation must never publish a result from this path.
use super::borrowed::BorrowedValue;
use crate::descriptor::StructField;
use std::borrow::Cow;

fn whitespace(bytes: &[u8], position: &mut usize) {
    while bytes.get(*position).is_some_and(u8::is_ascii_whitespace) {
        *position += 1;
    }
}
fn string<'a>(bytes: &'a [u8], position: &mut usize) -> Option<&'a [u8]> {
    if bytes.get(*position) != Some(&b'"') {
        return None;
    }
    *position += 1;
    let start = *position;
    let length = bytes
        .get(start..)?
        .iter()
        .position(|byte| matches!(byte, b'"' | b'\\'))?;
    *position += length;
    if bytes.get(*position) != Some(&b'"') {
        return None;
    }
    *position += 1;
    bytes.get(start..start + length)
}

pub(super) fn decode<'a>(
    bytes: &'a [u8],
    fields: &'a [StructField],
    needed: u128,
    field_index: impl Fn(&str) -> Option<usize>,
) -> Option<(BorrowedValue<'a>, u128)> {
    let mut position = 0;
    whitespace(bytes, &mut position);
    if bytes.get(position) != Some(&b'{') {
        return None;
    }
    position += 1;
    let mut values = Vec::with_capacity((needed.count_ones() as usize).min(fields.len()));
    for (index, field) in fields.iter().enumerate() {
        if needed & (1u128 << index) != 0 {
            values.push((Cow::Borrowed(field.name.as_str()), BorrowedValue::Null));
        }
    }
    let mut present = 0;
    loop {
        whitespace(bytes, &mut position);
        if bytes.get(position) == Some(&b'}') {
            position += 1;
            break;
        }
        let key = std::str::from_utf8(string(bytes, &mut position)?).ok()?;
        whitespace(bytes, &mut position);
        if bytes.get(position) != Some(&b':') {
            return None;
        }
        position += 1;
        whitespace(bytes, &mut position);
        let index = field_index(key).filter(|index| needed & (1u128 << index) != 0);
        let value = if bytes.get(position) == Some(&b'"') {
            let value = string(bytes, &mut position)?;
            match index {
                Some(_) => Some(BorrowedValue::String(Cow::Borrowed(
                    std::str::from_utf8(value).ok()?,
                ))),
                None => None,
            }
        } else {
            let start = position;
            let first = *bytes.get(start)?;
            if !matches!(first, b'-' | b'0'..=b'9' | b't' | b'f' | b'n') {
                return None;
            }
            while bytes
                .get(position)
                .is_some_and(|byte| !matches!(byte, b',' | b'}') && !byte.is_ascii_whitespace())
            {
                position += 1;
            }
            match index {
                Some(_) => Some(
                    serde_json::from_slice::<BorrowedValue<'_>>(bytes.get(start..position)?)
                        .ok()?,
                ),
                None => None,
            }
        };
        if let (Some(index), Some(value)) = (index, value) {
            let compact = (needed & ((1u128 << index) - 1)).count_ones() as usize;
            values.get_mut(compact)?.1 = value;
            present |= 1u128 << index;
        }
        whitespace(bytes, &mut position);
        match bytes.get(position) {
            Some(b',') => position += 1,
            Some(b'}') => {
                position += 1;
                break;
            }
            _ => return None,
        }
    }
    whitespace(bytes, &mut position);
    if position != bytes.len() {
        return None;
    }
    let mut remaining = needed;
    values.retain(|_| {
        let bit = 1u128 << remaining.trailing_zeros();
        remaining &= !bit;
        present & bit != 0
    });
    Some((BorrowedValue::Object(values), present))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::SchemaNode;
    #[test]
    fn scalar_recognition_matches_serde_and_declines_complex_spellings() {
        let fields = ["skip", "id", "optional", "value"].map(|name| StructField {
            name: name.into(),
            schema: SchemaNode::Unknown,
        });
        let mask = 0b1110;
        for text in [
            r#"{"skip":"ignored","id":"first","id":"last","value":-0.0}"#,
            r#" { "skip": false, "id":"å", "optional":null,"value":1e10 } "#,
            r#"{"id":"x","value":18446744073709551615}"#,
        ] {
            let (actual, present) = decode(text.as_bytes(), &fields, mask, |name| {
                fields.iter().position(|field| field.name == name)
            })
            .unwrap();
            let expected: BorrowedValue<'_> = serde_json::from_str(text).unwrap();
            assert_eq!(
                actual.to_owned(),
                expected.select(Some(&serde_json::json!(["id", "optional", "value"])))
            );
            assert_eq!(present & 1, 0);
        }
        for text in [
            r#"{"id":"escaped\n"}"#,
            r#"{"id":"x","skip":[1]}"#,
            r#"{"id":"x""#,
        ] {
            assert!(decode(text.as_bytes(), &fields, mask, |name| fields
                .iter()
                .position(|field| field.name == name))
            .is_none());
        }
    }
}
