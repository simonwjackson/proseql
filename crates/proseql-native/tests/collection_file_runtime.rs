//! A collection-file source stores one collection in one file. Prose files
//! use their own template and reject lines that are not records.
use std::fs;
use std::path::Path;

use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_formats::prose::{ProseCodecOptions, UnmatchedLines};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, DocumentSourceConfig,
    SourceCollectionSelection, UnknownCollectionPolicy,
};
use serde_json::{json, Value};

const TURN_TEMPLATE: &str = "[{id}] {meeting} {t} {speaker}: {text}";

fn descriptor(name: &str, fields: &[&str]) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
        schema: SchemaNode::Struct {
            fields: fields
                .iter()
                .map(|field| StructField {
                    name: (*field).into(),
                    schema: SchemaNode::Str,
                })
                .collect(),
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec![],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: false,
        validation_mode: ValidationMode::Strict,
    }
}

fn turns_source(root: &Path, template: Option<&str>) -> DatabaseSourceConfig {
    DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
        id: "turns".into(),
        collection: "turns".into(),
        path: root.join("turns.prose").to_string_lossy().into_owned(),
        format: None,
        prose: template.map(|template| ProseCodecOptions {
            template: Some(template.into()),
            overflow: vec![],
            unmatched_lines: UnmatchedLines::Error,
        }),
    })
}

fn config(root: &Path, template: Option<&str>) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![
            NativeCollectionConfig::new(descriptor(
                "turns",
                &["id", "meeting", "t", "speaker", "text"],
            )),
            NativeCollectionConfig::new(descriptor("items", &["id", "status", "text"])),
        ],
        sources: vec![
            turns_source(root, template),
            DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "items".into(),
                root: root.join("items").to_string_lossy().into_owned(),
                include: None,
                exclude: vec![],
                format: Some("yaml".into()),
                collections: Some(SourceCollectionSelection::Named(vec!["items".into()])),
                unknown_collections: UnknownCollectionPolicy::Error,
                outbox: "items.yaml".into(),
                optional: true,
            }),
        ],
    }
}

fn open(root: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(
        config(root, Some(TURN_TEMPLATE)),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
    .unwrap()
}

fn real_turns() -> Vec<Value> {
    vec![
        json!({"id": "0208", "meeting": "2026-10-01-call", "t": "8:39", "speaker": "SV", "text": "What was the total for the quarter?"}),
        json!({"id": "0209", "meeting": "2026-10-01-call", "t": "8:41", "speaker": "D", "text": "35143"}),
        json!({"id": "0210", "meeting": "2026-10-01-call", "t": "8:44", "speaker": "L", "text": "Okay: \"35143\" - that matches."}),
    ]
}

fn create_turns(runtime: &NativeRuntime) {
    runtime
        .mutate(|db| {
            for turn in real_turns() {
                db.create("turns", turn)?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_new_prose_collection_file_gets_its_template_header_and_reopens_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    create_turns(&runtime);
    runtime.close().unwrap();

    let file = fs::read_to_string(dir.path().join("turns.prose")).unwrap();
    assert_eq!(
        file.lines().next(),
        Some("@prose [{id}] {meeting} {t} {speaker}: {text}")
    );
    assert!(
        file.contains("[0209] 2026-10-01-call 8:41 D: \"35143\""),
        "{file}"
    );

    let reopened = open(dir.path());
    for turn in real_turns() {
        let id = turn["id"].as_str().unwrap();
        assert_eq!(reopened.find_by_id("turns", id).unwrap(), Some(turn));
    }
}

#[test]
fn updating_one_record_rewrites_one_line() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    create_turns(&runtime);
    let before = fs::read_to_string(dir.path().join("turns.prose")).unwrap();

    runtime
        .mutate(|db| db.update("turns", "0208", json!({"text": "What was Q3?"})))
        .unwrap();

    let after = fs::read_to_string(dir.path().join("turns.prose")).unwrap();
    let changed: Vec<_> = before
        .lines()
        .zip(after.lines())
        .filter(|(left, right)| left != right)
        .collect();
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert_eq!(changed[0].1, "[0208] 2026-10-01-call 8:39 SV: What was Q3?");
}

#[test]
fn a_write_to_another_collection_leaves_the_prose_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    create_turns(&runtime);
    let turns_path = dir.path().join("turns.prose");
    let before = fs::metadata(&turns_path).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));

    runtime
        .mutate(|db| {
            db.create(
                "items",
                json!({"id": "c1", "status": "open", "text": "Send Daniela the SP list"}),
            )
        })
        .unwrap();

    assert_eq!(
        fs::metadata(&turns_path).unwrap().modified().unwrap(),
        before
    );
    assert!(dir.path().join("items/items.yaml").exists());
}

#[test]
fn a_hand_edit_that_breaks_the_template_stops_the_open_and_names_the_line() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = open(dir.path());
    create_turns(&runtime);
    runtime.close().unwrap();
    let path = dir.path().join("turns.prose");
    let edited = fs::read_to_string(&path)
        .unwrap()
        .replace("8:39 SV: What", "8:39 SV - What");
    fs::write(&path, edited).unwrap();

    let error = NativeRuntime::open_sources_with_options(
        config(dir.path(), Some(TURN_TEMPLATE)),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
    .err()
    .expect("open must fail");
    assert!(error.to_string().contains("line 3"), "{error}");
}

#[test]
fn a_prose_collection_file_without_a_template_is_a_config_error() {
    let dir = tempfile::tempdir().unwrap();
    let error = NativeRuntime::open_sources_with_options(
        config(dir.path(), None),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..NativeSourceRuntimeOptions::default()
        },
    )
    .err()
    .expect("open must fail");
    assert!(error.to_string().contains("template"), "{error}");
}
