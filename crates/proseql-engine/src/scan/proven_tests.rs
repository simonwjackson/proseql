use super::{borrowed::BorrowedValue, decoder::SimpleDecoder};
use crate::descriptor::{SchemaNode, StructField};
use serde_json::json;

#[test]
fn proven_projection_keeps_optional_holes_duplicate_keys_and_scalar_values() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "unused".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "optional".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "value".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Num)),
            },
        ],
    };
    let decoder = SimpleDecoder::new(&schema).unwrap();
    let mask = decoder
        .projection(&["id".into(), "value".into(), "optional".into()])
        .unwrap();
    for bytes in [
        br#"{"unused":"large","id":"first","id":"last","value":-0.0}"#.as_slice(),
        br#"{"unused":"large","optional":"escaped\nstring","id":"x","value":null}"#,
    ] {
        let (full, _) = decoder.decode_positioned(bytes).unwrap().unwrap();
        let (projected, present) = decoder.decode_proven_positioned(bytes, mask).unwrap();
        assert_eq!(
            projected.to_owned(),
            full.select(Some(&json!(["id", "value", "optional"])))
        );
        assert_eq!(present & 1, 0);
        assert!(matches!(projected, BorrowedValue::Object(_)));
    }
    // This remains an error before any generation proof exists.
    assert!(decoder
        .decode_positioned(br#"{"unused":1e999,"id":"x","value":1}"#)
        .is_err());
}

#[test]
fn proven_projection_matches_full_decode_for_every_scalar_field_mask() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "optional".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "value".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "nullable".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Bool)),
            },
        ],
    };
    let decoder = SimpleDecoder::new(&schema).unwrap();
    for bytes in [
        br#"{"id":"x","value":-0.0,"nullable":null,"unknown":[1,{"nested":true}]}"#.as_slice(),
        br#"{"value":1e10,"id":"escaped\nvalue","optional":"unicode \u00e5","nullable":true}"#,
        br#"{"id":"first","optional":"","value":9007199254740993,"id":"last","nullable":false}"#,
    ] {
        let (full, _) = decoder.decode_positioned(bytes).unwrap().unwrap();
        for mask in 0..16 {
            let (actual, present) = decoder.decode_proven_positioned(bytes, mask).unwrap();
            let names = ["id", "optional", "value", "nullable"]
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1u128 << index) != 0)
                .map(|(_, name)| *name)
                .collect::<Vec<_>>();
            let expected = if names.is_empty() {
                json!({})
            } else {
                full.select(Some(&json!(names)))
            };
            assert_eq!(actual.to_owned(), expected, "mask={mask}");
            assert_eq!(present & !mask, 0);
        }
    }
}

#[test]
fn proven_projection_declines_transforms_defaults_nested_and_unknown_values() {
    for node in [
        SchemaNode::Unknown,
        SchemaNode::Struct { fields: vec![] },
        SchemaNode::Array {
            item: Box::new(SchemaNode::Str),
        },
    ] {
        let schema = SchemaNode::Struct {
            fields: vec![StructField {
                name: "value".into(),
                schema: node,
            }],
        };
        assert!(SimpleDecoder::new(&schema)
            .unwrap()
            .projection(&["value".into()])
            .is_none());
    }
}
