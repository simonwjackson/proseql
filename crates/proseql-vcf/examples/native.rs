//! Synthetic contacts only. Run `cargo run -p proseql-vcf --example native`.
use proseql_engine::descriptor::{CollectionDescriptor, IdStrategy, ValidationMode};
use proseql_formats::{FormatCodec, FormatRegistry};
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, RecordFilesSourceConfig};
use proseql_vcf::{vcard_schema, VCardCodec};
use serde_json::json;
use std::sync::Arc;
fn main() -> Result<(), proseql_engine::errors::EngineError> {
    let directory = tempfile::tempdir().expect("example directory");
    let descriptor = CollectionDescriptor {
        name: "contacts".into(),
        schema: vcard_schema(),
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
    let mut formats = FormatRegistry::with_builtins();
    formats.register(Box::new(VCardCodec));
    let runtime = NativeRuntime::open_sources_with_options(
        NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(descriptor)],
            sources: vec![DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
                id: "contact-files".into(),
                collection: "contacts".into(),
                root: directory.path().to_string_lossy().into_owned(),
                format: "vcf".into(),
            })],
        },
        NativeSourceRuntimeOptions {
            formats,
            watch_debounce: None,
            on_record_files_reload: Some(Arc::new(|diff| {
                println!(
                    "{} added={:?} changed={:?} removed={:?}",
                    diff.source_id, diff.added, diff.changed, diff.removed
                )
            })),
            ..Default::default()
        },
    )?;
    let raw = include_str!("../tests/fixtures/google-style-3.vcf");
    let mut record = VCardCodec.decode(raw).expect("valid synthetic vCard");
    record["id"] = json!("chosen-href");
    runtime.mutate(|db| db.create("contacts", record))?;
    assert_eq!(
        std::fs::read(directory.path().join("chosen-href.vcf")).expect("created card"),
        raw.as_bytes()
    );
    std::fs::write(
        directory.path().join("external.vcf"),
        include_str!("../tests/fixtures/example-4.vcf"),
    )
    .expect("external synthetic edit");
    runtime.reload()?;
    let matches = runtime.query(
        "contacts",
        proseql_engine::query::pipeline::query_input(
            Some(json!({"email_values":{"$contains":"example@example.invalid"}})),
            vec![],
            None,
            None,
            None,
        ),
        None,
    )?;
    assert_eq!(matches[0]["id"], "chosen-href");
    runtime.flush()?;
    runtime.close()?;
    Ok(())
}
