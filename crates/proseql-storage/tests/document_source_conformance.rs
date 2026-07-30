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
