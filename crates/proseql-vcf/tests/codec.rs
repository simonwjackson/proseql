use proseql_formats::{FormatCodec, FormatRegistry};
use proseql_vcf::VCardCodec;
use serde_json::json;
const GOOGLE: &str = include_str!("fixtures/google-style-3.vcf");
const FOUR: &str = include_str!("fixtures/example-4.vcf");
#[test]
fn synthetic_google_style_and_v4_keep_raw_and_expose_query_fields() {
    let card = VCardCodec.decode(GOOGLE).unwrap();
    assert_eq!(card["raw"], GOOGLE);
    assert_eq!(card["version"], "3.0");
    assert_eq!(card["fn"], "Example Person");
    assert_eq!(card["uid"], "urn:uuid:00000000-0000-0000-0000-000000000003");
    assert_eq!(
        card["n"],
        json!({"family":"Person","given":"Example","additional":"Middle","prefix":"Dr.","suffix":"III"})
    );
    assert_eq!(card["nickname"], json!(["Example", "Sample, Friend"]));
    assert_eq!(
        card["emails"][0],
        json!({"value":"example@example.invalid","types":["internet","home","pref"],"pref":1})
    );
    assert_eq!(card["tels"][0]["value"], "+1-202-555-0100");
    assert_eq!(
        card["adrs"][0],
        json!({"types":["home"],"label":"_$!<Home>!$_","poBox":"PO 7","extended":"Apartment 2","street":"10 Example Street","locality":"Sampletown","region":"CA","postcode":"12345","country":"US","geo":"37.123;-122.456"})
    );
    assert_eq!(card["related"][0]["value"], "Example Relative");
    assert_eq!(card["categories"], json!(["Family", "Sample, Group"]));
    assert_eq!(card["rev"], "2026-10-27T12:00:00+00:00");
    assert_eq!(
        VCardCodec.encode(&card, None).unwrap().as_bytes(),
        GOOGLE.as_bytes()
    );
    let card = VCardCodec.decode(FOUR).unwrap();
    assert_eq!(card["version"], "4.0");
    assert_eq!(card["n"]["given"], "Second,Other");
    assert_eq!(card["emails"][0]["pref"], 2);
    assert_eq!(card["adrs"][0]["geo"], "geo:40.1,-70.2");
    assert_eq!(card["adrs"][0]["label"], "20 Example Street\nOthercity");
    assert_eq!(
        card["related"][0],
        json!({"value":"Example Parent","types":["parent"]})
    );
    assert_eq!(VCardCodec.encode(&card, None).unwrap(), FOUR);
}
#[test]
fn registry_refuses_derived_only_changes_while_direct_encode_ignores_them() {
    let mut registry = FormatRegistry::with_builtins();
    registry.register(Box::new(VCardCodec));
    assert!(VCardCodec.round_trips_exactly());
    let mut card = registry.deserialize(GOOGLE, "vcf").unwrap();
    assert_eq!(registry.serialize(&card, "vcf", None).unwrap(), GOOGLE);
    card["fn"] = json!("not the raw name");
    assert_eq!(VCardCodec.encode(&card, None).unwrap(), GOOGLE);
    assert!(
        format!("{:?}", registry.serialize(&card, "vcf", None).unwrap_err())
            .contains("round-trip-mismatch")
    );
}
#[test]
fn missing_or_invalid_raw_and_multiple_cards_fail() {
    let inputs = [
        "",
        "not a card",
        "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Unclosed\r\n",
        "BEGIN:VCARD\nVERSION:2.1\nEND:VCARD\n",
        "BEGIN:VCARD\nFN:No version\nEND:VCARD\n",
        "BEGIN:VCARD\nVERSION:4.0\nBAD LINE\nEND:VCARD\n",
        "BEGIN:VCARD\nVERSION:3.0\nVERSION:4.0\nEND:VCARD\n",
    ];
    for raw in inputs {
        assert!(VCardCodec.decode(raw).is_err(), "accepted {raw:?}");
        assert!(VCardCodec.encode(&json!({"raw":raw}), None).is_err());
    }
    assert!(VCardCodec.decode(&format!("{GOOGLE}{FOUR}")).is_err());
    assert!(VCardCodec.decode(&format!("{GOOGLE}garbage\r\n")).is_err());
    for card in [json!({}), json!({"raw":null}), json!({"raw":4})] {
        assert!(VCardCodec.encode(&card, None).is_err());
    }
}
#[test]
fn missing_properties_have_one_documented_canonical_shape() {
    let raw = "BEGIN:VCARD\nVERSION:4.0\nEND:VCARD\n";
    assert_eq!(
        VCardCodec.decode(raw).unwrap(),
        json!({"raw":raw,"version":"4.0","nickname":[],"emails":[],"email_values":[],"localities":[],"tels":[],"adrs":[],"related":[],"categories":[]})
    );
    assert!(FormatRegistry::with_builtins()
        .deserialize(raw, "vcf")
        .is_err());
}
