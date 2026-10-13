use std::panic::{self, AssertUnwindSafe};

use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_storage::document_source::{
    load_document_sources, save_document_source, SaveDocumentSourceInput,
};
use proseql_storage::host::StorageHost;
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, DocumentSourceConfig, NormalizedSourceConfig,
    SourceCollectionSelection, SourceConfigInput, UnknownCollectionPolicy,
};
use serde_json::json;

fn game_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "systemId".to_owned(),
                schema: SchemaNode::Str,
            },
        ],
    }
}

fn system_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![StructField {
            name: "name".to_owned(),
            schema: SchemaNode::Str,
        }],
    }
}

fn runtime_id_game_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "score".to_owned(),
                schema: SchemaNode::NumFromStr,
            },
        ],
    }
}

fn config(unknown_collections: UnknownCollectionPolicy) -> NormalizedSourceConfig {
    normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([
            (
                "games".to_owned(),
                proseql_storage::persistence::CollectionStorageConfig {
                    name: "games".to_owned(),
                    schema: game_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: None,
                    migrations: vec![],
                },
            ),
            (
                "systems".to_owned(),
                proseql_storage::persistence::CollectionStorageConfig {
                    name: "systems".to_owned(),
                    schema: system_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: Some(1),
                    migrations: vec![],
                },
            ),
        ]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap()
}

#[test]
fn normalize_document_source_applies_defaults_and_lexical_collection_order() {
    let normalized = config(UnknownCollectionPolicy::Error);
    assert_eq!(normalized.collections, vec!["games", "systems"]);
    match &normalized.sources[0] {
        proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(source) => {
            assert_eq!(source.collections, vec!["games", "systems"]);
            assert_eq!(source.outbox, "/config/generated.yaml");
        }
        _ => panic!("expected documents source"),
    }
}

#[test]
fn load_document_sources_ignores_nested_version_sidecars() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  _version: 1\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();
    host.write("/config/nested/._version.yaml", "_version: 99\n")
        .unwrap();

    let loaded = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["games"]["smw"]["id"], "smw");
    assert_eq!(loaded.documents.len(), 1);
    assert_eq!(loaded.documents[0].path, "/config/base.yaml");
}

#[test]
fn load_document_sources_merges_files_and_records_origins_and_documents() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  _version: 1\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();
    host.write(
        "/config/nested/more.yaml",
        "games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\nsystems:\n  _version: 1\n  genesis:\n    name: Genesis\n",
    )
    .unwrap();

    let loaded = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["games"]["smw"]["id"], "smw");
    assert_eq!(loaded.collections["systems"]["snes"]["id"], "snes");
    assert_eq!(loaded.origins["games\u{0}smw"].path, "/config/base.yaml");
    assert_eq!(loaded.documents.len(), 2);
}

#[test]
fn load_document_sources_keys_and_detects_duplicates_by_runtime_id_after_schema_decode() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "games".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "games".to_owned(),
                schema: runtime_id_game_schema(),
                id_strategy: IdStrategy::Provided,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  alias-key:\n    id: smw\n    name: Super Mario World\n    score: \"7\"\n",
    )
    .unwrap();

    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    assert!(loaded.collections["games"].contains_key("smw"));
    assert_eq!(loaded.collections["games"]["smw"]["score"], json!(7));
    assert_eq!(loaded.origins["games\u{0}smw"].path, "/config/base.yaml");

    host.write(
        "/config/duplicate.yaml",
        "games:\n  another-key:\n    id: smw\n    name: Duplicate\n    score: \"9\"\n",
    )
    .unwrap();
    let err = load_document_sources(&host, &formats, &normalized, None).unwrap_err();
    match err {
        EngineError::DuplicateRecord(error) => {
            assert_eq!(error.id, "smw");
            assert_eq!(error.first.path, "/config/base.yaml");
            assert_eq!(error.duplicate.path, "/config/duplicate.yaml");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn load_document_sources_rejects_duplicate_logical_records() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/a.yaml",
        "games:\n  smw:\n    name: One\n    systemId: snes\n",
    )
    .unwrap();
    host.write(
        "/config/b.yaml",
        "games:\n  smw:\n    name: Two\n    systemId: snes\n",
    )
    .unwrap();

    let err = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DuplicateRecord(error) => {
            assert_eq!(error.collection, "games");
            assert_eq!(error.id, "smw");
            assert_eq!(error.first.path, "/config/a.yaml");
            assert_eq!(error.duplicate.path, "/config/b.yaml");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn unknown_collections_error_by_default_and_preserve_when_configured() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: SMW\n    systemId: snes\nnotes:\n  owner: ops\n",
    )
    .unwrap();

    assert!(matches!(
        load_document_sources(
            &host,
            &formats,
            &config(UnknownCollectionPolicy::Error),
            None
        ),
        Err(EngineError::UnknownCollection(_))
    ));

    let loaded = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Preserve),
        None,
    )
    .unwrap();
    assert_eq!(loaded.documents[0].data["notes"]["owner"], "ops");
}

#[test]
fn load_document_sources_rejects_physical_derived_id_fields() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    id: smw\n    name: SMW\n    systemId: snes\n",
    )
    .unwrap();
    let err = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::Validation(_)));
}

#[test]
fn save_document_source_routes_runtime_ids_back_to_their_origin_and_preserves_schema_transforms() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "games".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "games".to_owned(),
                schema: runtime_id_game_schema(),
                id_strategy: IdStrategy::Provided,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Preserve,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  alias-key:\n    id: smw\n    name: Super Mario World\n    score: \"7\"\nnotes:\n  owner: ops\n",
    )
    .unwrap();

    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    let mut collections = loaded.collections.clone();
    collections["games"].insert(
        "smw".to_owned(),
        json!({"id": "smw", "name": "SMW", "score": 11}),
    );

    let saved = save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config: normalized,
            source_id: "library".to_owned(),
            collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap();

    let raw = host.read("/config/base.yaml").unwrap();
    assert!(raw.contains("smw:"), "{raw}");
    assert!(!raw.contains("alias-key:"), "{raw}");
    assert!(raw.contains("score: \"11\""), "{raw}");
    assert!(raw.contains("notes:"), "{raw}");
    assert_eq!(saved.origins["games\u{0}smw"].path, "/config/base.yaml");
}

#[test]
fn save_document_source_preserves_unknown_sections_updates_origin_and_uses_outbox_for_new_records()
{
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nnotes:\n  owner: ops\n",
    )
    .unwrap();
    let cfg = config(UnknownCollectionPolicy::Preserve);
    let loaded = load_document_sources(&host, &formats, &cfg, None).unwrap();
    let mut collections = loaded.collections.clone();
    collections["games"].insert(
        "smw".to_owned(),
        json!({"id":"smw","name":"SMW","systemId":"snes"}),
    );
    collections["games"].insert(
        "sonic".to_owned(),
        json!({"id":"sonic","name":"Sonic","systemId":"genesis"}),
    );

    let saved = save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config: cfg.clone(),
            source_id: "library".to_owned(),
            collections,
            origins: loaded.origins.clone(),
            documents: loaded.documents.clone(),
        },
        None,
    )
    .unwrap();

    assert!(host
        .read("/config/base.yaml")
        .unwrap()
        .contains("name: SMW"));
    assert!(host.read("/config/base.yaml").unwrap().contains("notes:"));
    assert!(host
        .read("/config/generated.yaml")
        .unwrap()
        .contains("sonic:"));
    assert_eq!(saved.origins["games\u{0}smw"].path, "/config/base.yaml");
    assert_eq!(
        saved.origins["games\u{0}sonic"].path,
        "/config/generated.yaml"
    );
}

#[test]
fn save_document_source_delete_removes_only_origin_record_and_preserves_siblings() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n  sonic:\n    name: Sonic\n    systemId: genesis\nnotes:\n  owner: ops\n",
    )
    .unwrap();
    let cfg = config(UnknownCollectionPolicy::Preserve);
    let loaded = load_document_sources(&host, &formats, &cfg, None).unwrap();
    let mut collections = loaded.collections.clone();
    collections["games"].shift_remove("smw");

    save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config: cfg,
            source_id: "library".to_owned(),
            collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap();

    let raw = host.read("/config/base.yaml").unwrap();
    assert!(!raw.contains("smw:"));
    assert!(raw.contains("sonic:"));
    assert!(raw.contains("notes:"));
}

#[test]
fn load_document_sources_allows_same_physical_file_across_distinct_sources() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([
            (
                "games".to_owned(),
                proseql_storage::persistence::CollectionStorageConfig {
                    name: "games".to_owned(),
                    schema: game_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: None,
                    migrations: vec![],
                },
            ),
            (
                "systems".to_owned(),
                proseql_storage::persistence::CollectionStorageConfig {
                    name: "systems".to_owned(),
                    schema: system_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: None,
                    migrations: vec![],
                },
            ),
        ]),
        sources: vec![
            DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "games-source".to_owned(),
                root: "/config".to_owned(),
                include: Some(vec!["**/*.yaml".to_owned()]),
                exclude: vec![],
                format: Some("yaml".to_owned()),
                collections: Some(SourceCollectionSelection::Named(vec!["games".to_owned()])),
                unknown_collections: UnknownCollectionPolicy::Preserve,
                outbox: "/config/games.yaml".to_owned(),
                optional: false,
            }),
            DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "systems-source".to_owned(),
                root: "/config".to_owned(),
                include: Some(vec!["**/*.yaml".to_owned()]),
                exclude: vec![],
                format: Some("yaml".to_owned()),
                collections: Some(SourceCollectionSelection::Named(vec!["systems".to_owned()])),
                unknown_collections: UnknownCollectionPolicy::Preserve,
                outbox: "/config/systems.yaml".to_owned(),
                optional: false,
            }),
        ],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();

    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    assert_eq!(loaded.collections["games"]["smw"]["id"], "smw");
    assert_eq!(loaded.collections["systems"]["snes"]["id"], "snes");
    assert_eq!(loaded.documents.len(), 2);
}

#[test]
fn load_document_sources_treats_empty_and_null_documents_as_empty_objects() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/config/empty.yaml", "   \n").unwrap();
    host.write("/config/null.yaml", "null\n").unwrap();

    let loaded = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Preserve),
        None,
    )
    .unwrap();

    let mut document_paths = loaded
        .documents
        .iter()
        .map(|document| (document.path.clone(), document.data.clone()))
        .collect::<Vec<_>>();
    document_paths.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(document_paths.len(), 2);
    assert!(document_paths.iter().all(|(_, data)| data.is_empty()));
}

#[test]
fn load_document_sources_rejects_non_object_collection_sections() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/config/base.yaml", "games: []\n").unwrap();

    let err = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap_err();
    match err {
        EngineError::InvalidDocumentSource(error) => {
            assert_eq!(error.collection.as_deref(), Some("games"))
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn load_document_sources_require_migration_host_when_migrations_apply() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "systems".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "systems".to_owned(),
                schema: system_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(2),
                migrations: vec![
                    proseql_storage::persistence::MigrationStep {
                        from: 0,
                        to: 1,
                        description: None,
                        callback_id: "systems-v1".to_owned(),
                    },
                    proseql_storage::persistence::MigrationStep {
                        from: 1,
                        to: 2,
                        description: None,
                        callback_id: "systems-v2".to_owned(),
                    },
                ],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::Named(vec!["systems".to_owned()])),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "systems:\n  _version: 1\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();

    let err = load_document_sources(&host, &formats, &normalized, None).unwrap_err();
    match err {
        EngineError::Migration(error) => {
            assert_eq!(error.reason, "missing-host")
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn stale_document_source_version_with_empty_registry_fails_empty_registry_instead_of_bypassing() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "systems:\n  _version: 0\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();

    let err = load_document_sources(
        &host,
        &formats,
        &config(UnknownCollectionPolicy::Error),
        None,
    )
    .unwrap_err();
    match err {
        EngineError::Migration(error) => {
            assert_eq!(error.collection, "systems");
            assert_eq!(error.reason, "empty-registry");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn save_document_source_rejects_unknown_source_or_read_only_source() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let cfg = config(UnknownCollectionPolicy::Error);
    let err = save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config: cfg,
            source_id: "missing".to_owned(),
            collections: IndexMap::new(),
            origins: IndexMap::new(),
            documents: vec![],
        },
        None,
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::InvalidDocumentSource(_)));
}

#[test]
fn save_document_source_preflights_all_serialization_before_any_write() {
    #[derive(Debug, Clone, Copy)]
    struct FailingCodec;

    impl proseql_formats::FormatCodec for FailingCodec {
        fn name(&self) -> &str {
            "testfmt"
        }

        fn extensions(&self) -> &[&str] {
            &["testfmt"]
        }

        fn encode(
            &self,
            data: &serde_json::Value,
            _options: Option<proseql_formats::FormatOptions>,
        ) -> Result<String, String> {
            if data
                .get("items")
                .and_then(|items| items.get("broken"))
                .is_some()
            {
                Err("broken document cannot serialize".to_owned())
            } else {
                serde_json::to_string(data).map_err(|error| error.to_string())
            }
        }

        fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
            serde_json::from_str(raw).map_err(|error| error.to_string())
        }
    }

    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "items".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "items".to_owned(),
                schema: SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "id".to_owned(),
                            schema: SchemaNode::Str,
                        },
                        StructField {
                            name: "value".to_owned(),
                            schema: SchemaNode::Unknown,
                        },
                    ],
                },
                id_strategy: IdStrategy::Provided,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.testfmt".to_owned()]),
            exclude: vec![],
            format: Some("testfmt".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Preserve,
            outbox: "/config/generated.testfmt".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::new(vec![Box::new(FailingCodec)]);
    let original = "{\"items\":{\"existing\":{\"id\":\"existing\",\"value\":1}}}";
    host.write("/config/base.testfmt", original).unwrap();

    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    let mut collections = loaded.collections.clone();
    collections["items"].insert("existing".to_owned(), json!({"id": "existing", "value": 2}));
    collections["items"].insert(
        "broken".to_owned(),
        json!({"id": "broken", "value": [1, "two"]}),
    );

    let err = save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config: normalized,
            source_id: "library".to_owned(),
            collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::Serialization(_)));
    assert_eq!(host.read("/config/base.testfmt").unwrap(), original);
    assert!(!host.exists("/config/generated.testfmt").unwrap());
}

#[test]
fn document_source_version_ahead_uses_invalid_document_source_error_shape() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "systems".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "systems".to_owned(),
                schema: system_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(1),
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "systems:\n  _version: 2\n  snes:\n    name: Super Nintendo\n",
    )
    .unwrap();

    let err = load_document_sources(&host, &formats, &normalized, None).unwrap_err();
    match err {
        EngineError::InvalidDocumentSource(error) => {
            assert_eq!(error.source_id, "library");
            assert_eq!(error.path, "/config/base.yaml");
            assert_eq!(error.collection.as_deref(), Some("systems"));
            assert!(error.message.contains("ahead of config version 1"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn document_source_extglob_include_matches_yaml_and_yml_files() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "games".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "games".to_owned(),
                schema: game_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.@(yaml|yml)".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n",
    )
    .unwrap();
    host.write(
        "/config/other.yaml",
        "games:\n  sonic:\n    name: Sonic\n    systemId: genesis\n",
    )
    .unwrap();

    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    assert!(loaded.collections["games"].contains_key("smw"));
    assert!(loaded.collections["games"].contains_key("sonic"));
}

#[test]
fn malformed_normalized_config_missing_collection_config_returns_source_config_error_not_panic() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/config/base.yaml",
        "games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n",
    )
    .unwrap();

    let mut malformed = config(UnknownCollectionPolicy::Error);
    malformed.collection_configs.shift_remove("games");

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        load_document_sources(&host, &formats, &malformed, None)
    }));
    let err = result.expect("should not panic").unwrap_err();
    assert!(matches!(err, EngineError::SourceConfig(_)), "{err:?}");
}

#[test]
fn malformed_document_section_returns_invalid_document_source_not_panic() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let config = config(UnknownCollectionPolicy::Error);
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        save_document_source(
            &host,
            &formats,
            SaveDocumentSourceInput {
                config: config.clone(),
                source_id: "library".to_owned(),
                collections: IndexMap::from([(
                    "games".to_owned(),
                    IndexMap::from([(
                        "smw".to_owned(),
                        json!({"id": "smw", "name": "Super Mario World", "systemId": "snes"}),
                    )]),
                )]),
                origins: IndexMap::from([(
                    "games\u{0}smw".to_owned(),
                    proseql_engine::errors::SourceRecordOrigin {
                        source_id: "library".to_owned(),
                        path: "/config/base.yaml".to_owned(),
                        collection: "games".to_owned(),
                        id: "smw".to_owned(),
                    },
                )]),
                documents: vec![proseql_storage::document_source::LoadedDocument {
                    raw: None,
                    source_id: "library".to_owned(),
                    path: "/config/base.yaml".to_owned(),
                    data: serde_json::Map::from_iter([(
                        "games".to_owned(),
                        json!([{"id": "bad"}]),
                    )]),
                }],
            },
            None,
        )
    }));
    let err = result.expect("should not panic").unwrap_err();
    assert!(
        matches!(err, EngineError::InvalidDocumentSource(_)),
        "{err:?}"
    );
}

#[test]
fn unsupported_extglob_constructs_fail_source_config_normalization() {
    let err = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "games".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "games".to_owned(),
                schema: game_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/config".to_owned(),
            include: Some(vec!["**/*.!(yaml|yml)".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/config/generated.yaml".to_owned(),
            optional: false,
        })],
    })
    .unwrap_err();
    match err {
        EngineError::SourceConfig(error) => {
            let message = &error.message;
            assert!(message.contains("unsupported picomatch"), "{message}");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn optional_missing_root_is_allowed() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "games".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "games".to_owned(),
                schema: game_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
            id: "library".to_owned(),
            root: "/missing".to_owned(),
            include: Some(vec!["**/*.yaml".to_owned()]),
            exclude: vec![],
            format: Some("yaml".to_owned()),
            collections: Some(SourceCollectionSelection::All),
            unknown_collections: UnknownCollectionPolicy::Error,
            outbox: "/missing/generated.yaml".to_owned(),
            optional: true,
        })],
    })
    .unwrap();
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let loaded = load_document_sources(&host, &formats, &normalized, None).unwrap();
    assert!(loaded.collections["games"].is_empty());
}

fn edit_yaml_document(
    raw: &str,
    edit: impl FnOnce(&mut IndexMap<String, IndexMap<String, serde_json::Value>>),
) -> (String, serde_json::Value) {
    let formats = &FormatRegistry::with_builtins();
    let host = MemoryStorageHost::default();
    let config = config(UnknownCollectionPolicy::Preserve);
    host.write("/config/generated.yaml", raw).unwrap();
    let loaded = load_document_sources(&host, formats, &config, None).unwrap();
    let mut collections = loaded.collections.clone();
    edit(&mut collections);
    let plan = proseql_storage::document_source::plan_document_source(
        formats,
        SaveDocumentSourceInput {
            config,
            source_id: "library".into(),
            collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        Some(&loaded.collections),
    )
    .unwrap();
    assert_eq!(plan.writes.len(), 1);
    let content = plan.writes[0].content.clone();
    assert_eq!(
        plan.saved.documents[0].raw.as_deref(),
        Some(content.as_str())
    );
    let expected = serde_json::Value::Object(plan.saved.documents[0].data.clone());
    assert_eq!(formats.deserialize(&content, "yaml").unwrap(), expected);
    (content, expected)
}

#[test]
fn yaml_splicing_appends_new_collections_without_reordering_or_changing_an_unterminated_block() {
    let raw = "# authored\nunknown:\n  quoted: 'Leave \"this\" alone.'";
    let (saved, _) = edit_yaml_document(raw, |collections| {
        collections["games"].insert(
            "new".into(),
            json!({"id":"new", "name":"New", "systemId":"snes"}),
        );
    });
    assert!(saved.starts_with(&format!("{raw}\ngames:\n")));
}

#[test]
fn yaml_splicing_preserves_crlf_trivia_quoted_keys_and_nonstandard_record_indentation() {
    let prefix = "# header\r\nunknown:\r\n  notes: 'Leave \"this\" alone.'\r\n\r\n";
    let untouched = "    'untouched id':\r\n        name: 'Leave \"this\" alone.'\r\n        systemId: snes\r\n\r\n";
    let suffix = "\r\n# footer\r\nother: {keep: true}\r\n";
    let raw = format!("{prefix}games:\r\n{untouched}    changed:\r\n        name: Old\r\n        systemId: snes\r\n{suffix}");
    let (saved, _) = edit_yaml_document(&raw, |collections| {
        collections["games"]["changed"]["name"] = json!("New");
    });
    assert!(saved.starts_with(prefix));
    assert!(saved.contains(untouched));
    assert!(saved.ends_with(suffix));
}

#[test]
fn yaml_splicing_deletes_the_last_record_without_turning_the_collection_into_null() {
    let prefix = "unknown:\n  notes: 'Leave \"this\" alone.'\n\n";
    let suffix = "\n# footer\nother: {keep: true}\n";
    let raw = format!("{prefix}games:\n  old: {{name: Old, systemId: snes}}\n{suffix}");
    let (saved, expected) = edit_yaml_document(&raw, |collections| {
        collections["games"].clear();
    });
    assert!(saved.starts_with(prefix));
    assert!(saved.ends_with(suffix));
    assert_eq!(expected["games"], json!({}));
    assert!(saved.contains("games: {}\n"));
}

#[test]
fn yaml_splicing_fails_closed_for_root_flow_maps_document_markers_and_complex_keys() {
    let formats = FormatRegistry::with_builtins();
    for raw in [
        "{games: {old: {name: Old, systemId: snes}}, unknown: {notes: 'Leave \"this\" alone.'}}\n",
        "---\ngames:\n  old: {name: Old, systemId: snes}\nunknown: {notes: 'Leave \"this\" alone.'}\n",
        "games:\n  old: {name: Old, systemId: snes}\n? unknown\n: {notes: 'Leave \"this\" alone.'}\n",
        "  games:\n    old: {name: Old, systemId: snes}\n  unknown: {keep: true}\n",
    ] {
        assert_yaml_save_fails_closed(raw, &formats, |collections| {
            collections["games"]["old"]["name"] = json!("New");
        }, "cannot segment");
    }
}

#[test]
fn yaml_splicing_fails_closed_for_cross_collection_aliases() {
    let raw = "unknown: &shared\n  old: {name: Old, systemId: snes}\ngames: *shared\n";
    assert_yaml_save_fails_closed(
        raw,
        &FormatRegistry::with_builtins(),
        |collections| {
            collections["games"]["old"]["name"] = json!("New");
        },
        "cannot segment",
    );
}

#[test]
fn yaml_splicing_reserializes_cross_record_aliases_only_inside_the_changed_collection() {
    let prefix = "unknown:\n  notes: 'Leave \"this\" alone.'\n\n";
    let raw = format!(
        "{prefix}games:\n  old: &shared {{name: Old, systemId: snes}}\n  untouched: *shared\n"
    );
    let (saved, expected) = edit_yaml_document(&raw, |collections| {
        collections["games"]["old"]["name"] = json!("New");
    });
    assert!(saved.starts_with(prefix));
    assert_eq!(expected["games"]["untouched"]["name"], "Old");
}

struct DocumentOnlyYaml {
    malformed_entries: bool,
}
impl proseql_formats::FormatCodec for DocumentOnlyYaml {
    fn name(&self) -> &str {
        "document-only-yaml"
    }
    fn extensions(&self) -> &[&str] {
        &["yaml"]
    }
    fn encode(
        &self,
        data: &serde_json::Value,
        options: Option<proseql_formats::FormatOptions>,
    ) -> Result<String, String> {
        // A codec may require whole-document context. Entry-sized encoding can
        // succeed yet produce a different value. The final check must catch it.
        let mut data = data.clone();
        if data.get("old").is_some() {
            if self.malformed_entries {
                return Ok("old: [\n".into());
            }
            data["old"]["name"] = json!("Wrong without document context");
        }
        proseql_formats::codecs::yaml_codec().encode(&data, options)
    }
    fn decode(&self, raw: &str) -> Result<serde_json::Value, String> {
        proseql_formats::codecs::yaml_codec().decode(raw)
    }
}

#[test]
fn yaml_splicing_rejects_a_candidate_that_does_not_match_the_projected_document() {
    let formats = FormatRegistry::new(vec![Box::new(DocumentOnlyYaml {
        malformed_entries: false,
    })]);
    let raw = "games:\n  old:\n    name: Old\n    systemId: snes\n\nunknown: {notes: 'Leave \"this\" alone.'}\n";
    assert_yaml_save_fails_closed(
        raw,
        &formats,
        |collections| {
            collections["games"]["old"]["name"] = json!("New");
        },
        "does not match",
    );
}

fn assert_yaml_save_fails_closed(
    raw: &str,
    formats: &FormatRegistry,
    edit: impl FnOnce(&mut IndexMap<String, IndexMap<String, serde_json::Value>>),
    detail: &str,
) {
    let host = MemoryStorageHost::default();
    let config = config(UnknownCollectionPolicy::Preserve);
    let path = "/config/generated.yaml";
    host.write(path, raw).unwrap();
    let loaded = load_document_sources(&host, formats, &config, None).unwrap();
    let mut collections = loaded.collections;
    edit(&mut collections);
    let error = save_document_source(
        &host,
        formats,
        SaveDocumentSourceInput {
            config,
            source_id: "library".into(),
            collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap_err();
    let EngineError::Operation(error) = error else {
        panic!("Expected typed shape error");
    };
    assert_eq!(error.operation, "save-document-source");
    assert_eq!(error.reason, "unsupported-document-shape");
    assert!(error.message.contains(path));
    assert!(error.message.contains(detail), "{}", error.message);
    assert_eq!(host.read(path).unwrap(), raw);
}

#[test]
fn yaml_splicing_fails_closed_if_the_spliced_document_cannot_parse() {
    let formats = FormatRegistry::new(vec![Box::new(DocumentOnlyYaml {
        malformed_entries: true,
    })]);
    let raw = "games:\n  old:\n    name: Old\n    systemId: snes\n\nunknown: {notes: 'Leave \"this\" alone.'}\n";
    assert_yaml_save_fails_closed(
        raw,
        &formats,
        |collections| {
            collections["games"]["old"]["name"] = json!("New");
        },
        "does not parse",
    );
}

#[test]
fn yaml_splicing_keeps_comments_blank_lines_flow_collections_and_unterminated_neighbours() {
    let prefix =
        "# header\nreadiness:\n  notes: 'Leave \"this\" alone.'\n\n# between collections\n\n";
    let suffix =
        "\n# empty hand-edited collection\ngains: {}\n\n# final collection\nrecomp: {keep: true}";
    let raw = format!("{prefix}games:\n  old: {{name: Old, systemId: snes}}\n{suffix}");
    let (saved, _) = edit_yaml_document(&raw, |collections| {
        collections["games"]["old"]["name"] = json!("New");
    });
    assert!(saved.starts_with(prefix));
    assert!(saved.ends_with(suffix));
    assert!(!saved.ends_with('\n'));
}

#[test]
fn yaml_splicing_can_change_a_flow_collection_without_rewriting_its_neighbours() {
    let prefix = "readiness: {keep: true}\n\n# between collections\n";
    let suffix = "\n# next collection\ngains: {}\n";
    let raw = format!("{prefix}games: {{}}\n{suffix}");
    let (saved, expected) = edit_yaml_document(&raw, |collections| {
        collections["games"].insert(
            "new".into(),
            json!({"id":"new", "name":"New", "systemId":"snes"}),
        );
    });
    assert!(saved.starts_with(prefix));
    assert!(saved.ends_with(suffix));
    assert_eq!(expected["games"]["new"]["name"], "New");
}

#[test]
fn yaml_splicing_fails_closed_if_the_codec_loses_a_changed_strings_trailing_newlines() {
    let raw = "games:\n  old: {name: Old, systemId: snes}\n\nunknown: {keep: true}\n";
    assert_yaml_save_fails_closed(
        raw,
        &FormatRegistry::with_builtins(),
        |collections| {
            collections["games"]["old"]["name"] = json!("New\n\n");
        },
        "does not match",
    );
}

#[test]
fn existing_documents_without_a_supported_editor_or_original_text_fail_closed() {
    for (format, raw, retain_snapshot, detail) in [
        ("json", "{\"games\":{\"old\":{\"name\":\"Old\",\"systemId\":\"snes\"}},\"unknown\":{\"keep\":true}}", true, "only supported for YAML"),
        ("yaml", "games:\n  old: {name: Old, systemId: snes}\nunknown: {keep: true}\n", false, "snapshot is missing"),
    ] {
        let host = MemoryStorageHost::default();
        let formats = FormatRegistry::with_builtins();
        let mut config = config(UnknownCollectionPolicy::Preserve);
        if let proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(source) = &mut config.sources[0] {
            source.format = format.into();
        }
        let path = "/config/generated.yaml";
        host.write(path, raw).unwrap();
        let mut loaded = load_document_sources(&host, &formats, &config, None).unwrap();
        loaded.collections["games"]["old"]["name"] = json!("New");
        if !retain_snapshot { loaded.documents[0].raw = None; }
        let error = save_document_source(&host, &formats, SaveDocumentSourceInput {
            config, source_id:"library".into(), collections:loaded.collections,
            origins:loaded.origins, documents:loaded.documents,
        }, None).unwrap_err();
        let EngineError::Operation(error) = error else { panic!("Expected typed shape error"); };
        assert_eq!(error.reason, "unsupported-document-shape");
        assert!(error.message.contains(path));
        assert!(error.message.contains(detail));
        assert_eq!(host.read(path).unwrap(), raw);
    }
}

#[test]
fn a_new_document_is_not_written_when_complete_serialization_fails_the_state_check() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let config = config(UnknownCollectionPolicy::Preserve);
    host.write("/config/untouched.yaml", "unknown: {keep: true}\n")
        .unwrap();
    let mut loaded = load_document_sources(&host, &formats, &config, None).unwrap();
    loaded.collections["games"].insert(
        "new".into(),
        json!({"id":"new", "name":"New\n\n", "systemId":"snes"}),
    );
    let error = save_document_source(
        &host,
        &formats,
        SaveDocumentSourceInput {
            config,
            source_id: "library".into(),
            collections: loaded.collections,
            origins: loaded.origins,
            documents: loaded.documents,
        },
        None,
    )
    .unwrap_err();
    let EngineError::Operation(error) = error else {
        panic!("Expected typed shape error");
    };
    assert_eq!(error.reason, "unsupported-document-shape");
    assert!(error.message.contains("/config/generated.yaml"));
    assert!(error.message.contains("does not match"));
    assert!(!host.exists("/config/generated.yaml").unwrap());
    assert_eq!(
        host.read("/config/untouched.yaml").unwrap(),
        "unknown: {keep: true}\n"
    );
}
