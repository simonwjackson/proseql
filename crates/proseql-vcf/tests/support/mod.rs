#![allow(dead_code)]
use proseql_engine::descriptor::{CollectionDescriptor, IdStrategy, ValidationMode};
use proseql_formats::FormatRegistry;
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{DatabaseSourceConfig, RecordFilesSourceConfig};
use proseql_vcf::VCardCodec;
use std::path::Path;
pub const GOOGLE: &str = include_str!("../fixtures/google-style-3.vcf");
pub const FOUR: &str = include_str!("../fixtures/example-4.vcf");
pub fn config(root: &Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(CollectionDescriptor {
            name: "contacts".into(),
            schema: proseql_vcf::vcard_schema(),
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
        })],
        sources: vec![DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
            id: "contact-files".into(),
            collection: "contacts".into(),
            root: root.to_string_lossy().into_owned(),
            format: "vcf".into(),
        })],
    }
}
pub fn options() -> NativeSourceRuntimeOptions {
    let mut formats = FormatRegistry::with_builtins();
    formats.register(Box::new(VCardCodec));
    NativeSourceRuntimeOptions {
        formats,
        watch_debounce: None,
        ..Default::default()
    }
}
pub fn open(root: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(config(root), options()).unwrap()
}
