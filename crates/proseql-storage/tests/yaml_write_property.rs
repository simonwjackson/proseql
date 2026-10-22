//! Property: every YAML document-source save leaves a file that loads back
//! to exactly the saved collections, for full-document writes (new files)
//! and for byte-preserving splices (changed files), at indents 2 and 4 and
//! line widths 20, 80 and 120.
//!
//! Records carry generated values from the shared seeded generator: lists
//! of objects, long folded text and YAML hazards. A failure names its seed.
//! Set `PROSEQL_YAML_PROPERTY_CASES` to run more cases. All data is
//! synthetic.

#[path = "../../proseql-formats/tests/support/yaml_values.rs"]
mod yaml_values;

use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_formats::codecs::yaml_codec_with;
use proseql_formats::FormatRegistry;
use proseql_storage::document_source::{
    load_document_sources, save_document_source, SaveDocumentSourceInput,
};
use proseql_storage::host::StorageHost;
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::CollectionStorageConfig;
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, DocumentSourceConfig, NormalizedSourceConfig,
    SourceCollectionSelection, SourceConfigInput, UnknownCollectionPolicy,
};
use serde_json::{json, Value};
use yaml_values::{same, string, value, Rng};

const PATH: &str = "/data/generated.yaml";

fn config() -> NormalizedSourceConfig {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "note".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "value".to_owned(),
                schema: SchemaNode::Unknown,
            },
        ],
    };
    normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "meals".to_owned(),
            CollectionStorageConfig {
                name: "meals".to_owned(),
                schema,
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "log".to_owned(),
            root: "/data".to_owned(),
            include: Some(vec!["*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Preserve,
            outbox: PATH.to_owned(),
            optional: false,
        })],
    })
    .unwrap()
}

fn formats(indent: usize, width: usize) -> FormatRegistry {
    let mut formats = FormatRegistry::with_builtins();
    formats.register(Box::new(yaml_codec_with(indent, width)));
    formats
}

fn record(rng: &mut Rng) -> Value {
    json!({ "note": string(rng), "value": value(rng, 3) })
}

fn record_id(rng: &mut Rng) -> String {
    let ids = [
        "meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "a b", "2026.01", "x-y",
    ];
    ids[rng.below(ids.len() as u64) as usize].to_owned()
}

type Collections = IndexMap<String, IndexMap<String, Value>>;

fn save(
    host: &MemoryStorageHost,
    formats: &FormatRegistry,
    collections: Collections,
    context: &str,
) {
    let loaded = load_document_sources(host, formats, &config(), None).unwrap();
    save_document_source(
        host,
        formats,
        SaveDocumentSourceInput {
            config: config(),
            source_id: "log".into(),
            collections: collections.clone(),
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap_or_else(|error| {
        panic!(
            "{context}: save failed: {error}\nfile before:\n{}\nsaving: {}",
            host.read(PATH).unwrap_or_default(),
            serde_json::to_string(&collections["meals"]).unwrap()
        )
    });
}

fn assert_reloads(
    host: &MemoryStorageHost,
    formats: &FormatRegistry,
    expected: &Collections,
    context: &str,
) {
    let text = host.read(PATH).unwrap();
    let loaded = load_document_sources(host, formats, &config(), None)
        .unwrap_or_else(|error| panic!("{context}: does not load: {error}\n{text}"));
    let actual = &loaded.collections["meals"];
    let wanted = &expected["meals"];
    assert_eq!(actual.len(), wanted.len(), "{context}\n{text}");
    for (id, record) in wanted {
        let found = actual
            .get(id)
            .unwrap_or_else(|| panic!("{context}: missing '{id}'\n{text}"));
        // The loader adds the derived `id`; compare the stored fields.
        let mut found = found.clone();
        found.as_object_mut().unwrap().remove("id");
        assert!(
            same(&found, record),
            "{context}: '{id}' changed\n{text}\nwanted: {record}\nfound:  {found}"
        );
    }
}

fn cases() -> u64 {
    std::env::var("PROSEQL_YAML_PROPERTY_CASES")
        .ok()
        .and_then(|value| value.parse().ok())
        .map_or(120, |cases: u64| cases / 10)
}

#[test]
fn full_writes_and_splices_load_back_to_the_saved_collections() {
    for seed in 0..cases() {
        for indent in [2, 4] {
            for width in [20, 80, 120] {
                let mut rng = Rng::new(seed);
                let host = MemoryStorageHost::default();
                host.write("/data/README", "synthetic\n").unwrap();
                let formats = formats(indent, width);
                let context = |round: usize| {
                    format!("seed {seed} indent {indent} width {width} round {round}")
                };

                // Round 0 writes a new file: complete serialization.
                let mut meals = IndexMap::new();
                for _ in 0..1 + rng.below(4) {
                    meals.insert(record_id(&mut rng), record(&mut rng));
                }
                let mut collections: Collections = IndexMap::from([("meals".to_owned(), meals)]);
                save(&host, &formats, collections.clone(), &context(0));
                assert_reloads(&host, &formats, &collections, &context(0));

                // Later rounds change the existing file: splices.
                for round in 1..4 {
                    let meals = collections.get_mut("meals").unwrap();
                    for _ in 0..1 + rng.below(3) {
                        let id = record_id(&mut rng);
                        match rng.below(4) {
                            0 => {
                                meals.shift_remove(&id);
                            }
                            1 if meals.contains_key(&id) => {
                                meals[&id]["note"] = Value::String(string(&mut rng));
                            }
                            _ => {
                                meals.insert(id, record(&mut rng));
                            }
                        }
                    }
                    save(&host, &formats, collections.clone(), &context(round));
                    assert_reloads(&host, &formats, &collections, &context(round));
                }
            }
        }
    }
}

#[test]
fn a_splice_keeps_unchanged_records_and_rewrites_a_wrapped_first_item_key() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let long =
        "aaaa bbbbb cccccccc ddddddddd eeeee fffffffffff gggg hhhh iiiiii jjjjj kkk lll mmmm";
    // A hand-written record keeps its bytes when a neighbour changes.
    let original = "meals:\n  meal-1:\n    note:   kept as written\n    value: {a: 1}\n  meal-2:\n    note: old\n    value: 1\n";
    host.write(PATH, original).unwrap();
    let mut collections: Collections = IndexMap::from([(
        "meals".to_owned(),
        load_document_sources(&host, &formats, &config(), None)
            .unwrap()
            .collections["meals"]
            .iter()
            .map(|(id, record)| {
                let mut record = record.clone();
                record.as_object_mut().unwrap().remove("id");
                (id.clone(), record)
            })
            .collect(),
    )]);
    collections["meals"]["meal-2"] =
        json!({"note": "new", "value": [{"food": long, "quantity": 1.0}]});
    save(&host, &formats, collections.clone(), "splice");
    let text = host.read(PATH).unwrap();
    assert!(
        text.starts_with("meals:\n  meal-1:\n    note:   kept as written\n    value: {a: 1}\n"),
        "{text}"
    );
    assert!(text.contains("      - food: aaaa"), "{text}");
    assert_reloads(&host, &formats, &collections, "splice");
}

#[test]
fn a_block_scalar_ending_in_a_comment_like_line_is_part_of_its_record() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let original = "meals:\n  meal-1:\n    note: n\n    value: |-\n      first\n\n      # heading\n  # a real comment between records\n\n  meal-2:\n    note: m\n    value: 1\n";
    host.write(PATH, original).unwrap();
    let mut collections: Collections = IndexMap::from([(
        "meals".to_owned(),
        IndexMap::from([
            (
                "meal-1".to_owned(),
                json!({"note": "changed", "value": "first\n\n# heading"}),
            ),
            ("meal-2".to_owned(), json!({"note": "m", "value": 1})),
        ]),
    )]);
    save(&host, &formats, collections.clone(), "first record");
    assert_reloads(&host, &formats, &collections, "first record");
    let text = host.read(PATH).unwrap();
    assert!(
        text.ends_with(
            "  # a real comment between records\n\n  meal-2:\n    note: m\n    value: 1\n"
        ),
        "{text}"
    );
    collections["meals"].shift_remove("meal-2");
    save(&host, &formats, collections.clone(), "delete second");
    assert_reloads(&host, &formats, &collections, "delete second");
}
