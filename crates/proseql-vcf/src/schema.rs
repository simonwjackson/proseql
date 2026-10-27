use proseql_engine::descriptor::{SchemaNode, StructField};
fn object(fields: Vec<(&str, SchemaNode)>) -> SchemaNode {
    SchemaNode::Struct {
        fields: fields
            .into_iter()
            .map(|(name, schema)| StructField {
                name: name.into(),
                schema,
            })
            .collect(),
    }
}
fn optional(schema: SchemaNode) -> SchemaNode {
    SchemaNode::Optional(Box::new(schema))
}
fn array(schema: SchemaNode) -> SchemaNode {
    SchemaNode::Array {
        item: Box::new(schema),
    }
}
/// Canonical projection schema, without the synthetic stem ID. Use with
/// DerivedFromKey. Struct decoding drops automatic engine timestamps, which
/// are not derived from `raw` and cannot pass an exact codec write check.
pub fn vcard_schema() -> SchemaNode {
    use SchemaNode::{Num, Str};
    let types = array(Str);
    let endpoint = object(vec![
        ("value", Str),
        ("types", types.clone()),
        ("pref", optional(Num)),
    ]);
    object(vec![
        ("raw", Str),
        ("version", Str),
        ("uid", optional(Str)),
        ("fn", optional(Str)),
        (
            "n",
            optional(object(vec![
                ("family", Str),
                ("given", Str),
                ("additional", Str),
                ("prefix", Str),
                ("suffix", Str),
            ])),
        ),
        ("nickname", array(Str)),
        ("emails", array(endpoint.clone())),
        ("tels", array(endpoint)),
        (
            "adrs",
            array(object(vec![
                ("types", types.clone()),
                ("label", optional(Str)),
                ("poBox", Str),
                ("extended", Str),
                ("street", Str),
                ("locality", Str),
                ("region", Str),
                ("postcode", Str),
                ("country", Str),
                ("geo", optional(Str)),
            ])),
        ),
        (
            "related",
            array(object(vec![("value", Str), ("types", types)])),
        ),
        ("categories", array(Str)),
        ("rev", optional(Str)),
        ("email_values", array(Str)),
        ("localities", array(Str)),
    ])
}
