//! YAML stays eager. A chunk reader must not weaken the document writer's
//! ownership or byte-preservation checks.
use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_storage::document_source::{
    load_document_sources, save_document_source, SaveDocumentSourceInput,
};
use proseql_storage::host::StorageHost;
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::CollectionStorageConfig;
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, DocumentSourceConfig, SourceCollectionSelection,
    SourceConfigInput, UnknownCollectionPolicy,
};
use serde_json::json;

#[test]
fn yaml_eager_write_safety_and_untouched_bytes_are_unchanged() {
    let formats = FormatRegistry::with_builtins();
    let path = "/data/log.yaml";
    let config = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "records".into(),
            CollectionStorageConfig {
                name: "records".into(),
                schema: SchemaNode::Struct {
                    fields: vec![StructField {
                        name: "value".into(),
                        schema: SchemaNode::Num,
                    }],
                },
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "log".into(),
            root: "/data".into(),
            include: Some(vec!["*.yaml".into()]),
            exclude: vec![],
            format: Some("yaml".into()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Preserve,
            outbox: path.into(),
            optional: false,
        })],
    })
    .unwrap();
    for (raw, safe) in [
        ("# authored\r\nunknown: {keep: 'exact bytes'}\r\nrecords:\r\n  kept: {value: 1}\r\n  changed: {value: 2}\r\n# footer\r\n", true),
        ("unknown: &shared\n  changed: {value: 2}\nrecords: *shared\n", false),
        ("---\nrecords:\n  changed: {value: 2}\nunknown: {keep: true}\n", false),
    ] {
        let host = MemoryStorageHost::default();
        host.write(path, raw).unwrap();
        let loaded = load_document_sources(&host, &formats, &config, None).unwrap();
        let mut collections = loaded.collections.clone();
        collections["records"]["changed"]["value"] = json!(3);
        let saved = save_document_source(&host, &formats, SaveDocumentSourceInput {
            config: config.clone(), source_id: "log".into(), collections,
            origins: loaded.origins, documents: loaded.documents,
        }, None);
        if safe {
            saved.unwrap();
            let after = host.read(path).unwrap();
            assert!(after.starts_with("# authored\r\nunknown: {keep: 'exact bytes'}\r\nrecords:\r\n  kept: {value: 1}\r\n"), "{after}");
            assert!(after.ends_with("# footer\r\n"), "{after}");
            let reloaded = load_document_sources(&host, &formats, &config, None).unwrap();
            assert_eq!(reloaded.collections["records"]["changed"]["value"], json!(3));
        } else {
            let Err(EngineError::Operation(error)) = saved else {
                panic!("expected a typed unsafe document shape error");
            };
            assert_eq!(error.operation, "save-document-source");
            assert_eq!(error.reason, "unsupported-document-shape");
            assert_eq!(host.read(path).unwrap(), raw, "an unsafe write changed bytes");
        }
    }
}
