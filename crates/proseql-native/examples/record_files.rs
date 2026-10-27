//! Run with: cargo run --manifest-path crates/Cargo.toml -p proseql-native --example record_files
use proseql_engine::descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, ValidationMode};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, RecordFilesSourceConfig};
use serde_json::json;
use std::sync::Arc;
fn main() -> Result<(), proseql_engine::errors::EngineError> {
    let directory = tempfile::tempdir().expect("create example directory");
    let descriptor = CollectionDescriptor {
        name: "notes".into(),
        schema: SchemaNode::Unknown,
        id_strategy: IdStrategy::DerivedFromKey,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
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
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    };
    let runtime = NativeRuntime::open_sources_with_options(
        NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(descriptor)],
            sources: vec![DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
                id: "notes-files".into(),
                collection: "notes".into(),
                root: directory.path().to_string_lossy().into_owned(),
                format: "json".into(),
            })],
        },
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            on_record_files_reload: Some(Arc::new(|diff| {
                println!(
                    "{}: added={:?} changed={:?} removed={:?}",
                    diff.source_id, diff.added, diff.changed, diff.removed
                );
            })),
            ..Default::default()
        },
    )?;
    runtime.mutate(|database| {
        database.create(
            "notes",
            json!({"id":"first", "text":"Created by the runtime"}),
        )
    })?;
    // The stem supplies the ID. Physical bytes contain no synthetic `id`.
    std::fs::write(
        directory.path().join("external.json"),
        r#"{"text":"External addition"}"#,
    )
    .expect("write example external file");
    runtime.reload()?;
    assert_eq!(
        runtime.find_by_id("notes", "external")?.unwrap()["text"],
        "External addition"
    );
    runtime.close()?;
    Ok(())
}
