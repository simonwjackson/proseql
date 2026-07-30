use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::{DocumentGraphErrorKind, EngineError};
use proseql_formats::FormatRegistry;
use proseql_storage::document_graph::{
    load_document_graph_sources, DocumentGraphTransformContext, DocumentGraphTransformHost,
};
use proseql_storage::host::StorageHost;
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::{CollectionStorageConfig, MigrationHost, MigrationStep};
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, DocumentGraphFragmentErrorPolicy,
    DocumentGraphRootConfig, DocumentGraphSourceConfig, SourceCollectionSelection,
    SourceConfigInput,
};
use serde_json::{json, Map, Value};

fn food_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "macros".to_owned(),
                schema: SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "cal".to_owned(),
                            schema: SchemaNode::Num,
                        },
                        StructField {
                            name: "fat".to_owned(),
                            schema: SchemaNode::Optional(Box::new(SchemaNode::Num)),
                        },
                    ],
                },
            },
        ],
    }
}

fn drink_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![StructField {
            name: "name".to_owned(),
            schema: SchemaNode::Str,
        }],
    }
}

fn base_graph(
    transform_callback_id: Option<&str>,
    policy: DocumentGraphFragmentErrorPolicy,
) -> proseql_storage::source_config::NormalizedSourceConfig {
    normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([
            (
                "foods".to_owned(),
                CollectionStorageConfig {
                    name: "foods".to_owned(),
                    schema: food_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: None,
                    migrations: vec![],
                },
            ),
            (
                "drinks".to_owned(),
                CollectionStorageConfig {
                    name: "drinks".to_owned(),
                    schema: drink_schema(),
                    id_strategy: IdStrategy::DerivedFromKey,
                    version: None,
                    migrations: vec![],
                },
            ),
        ]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::All),
                    },
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/b".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::All),
                    },
                ],
                collections: Some(SourceCollectionSelection::Named(vec![
                    "foods".to_owned(),
                    "drinks".to_owned(),
                ])),
                include: Some(vec!["**/*.{yaml,json,toml}".to_owned()]),
                exclude: vec![],
                transform_callback_id: transform_callback_id.map(str::to_owned),
                on_fragment_error: policy,
            },
        )],
    })
    .unwrap()
}

type MigrationCallback =
    Arc<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError> + Send + Sync>;
type TransformCallback =
    Arc<dyn Fn(&Value, &DocumentGraphTransformContext) -> Result<Value, Value> + Send + Sync>;

#[derive(Default)]
struct TestMigrationHost {
    callbacks: IndexMap<String, MigrationCallback>,
}

impl TestMigrationHost {
    fn with_callback<F>(mut self, id: &str, callback: F) -> Self
    where
        F: Fn(&Map<String, Value>) -> Result<Map<String, Value>, EngineError>
            + Send
            + Sync
            + 'static,
    {
        self.callbacks.insert(id.to_owned(), Arc::new(callback));
        self
    }
}

impl MigrationHost for TestMigrationHost {
    fn run_migration(
        &self,
        callback_id: &str,
        data: &Map<String, Value>,
    ) -> Result<Map<String, Value>, EngineError> {
        self.callbacks.get(callback_id).expect("missing callback")(data)
    }
}

#[derive(Default)]
struct TestTransformHost {
    callbacks: IndexMap<String, TransformCallback>,
}

impl TestTransformHost {
    fn with_callback<F>(mut self, id: &str, callback: F) -> Self
    where
        F: Fn(&Value, &DocumentGraphTransformContext) -> Result<Value, Value>
            + Send
            + Sync
            + 'static,
    {
        self.callbacks.insert(id.to_owned(), Arc::new(callback));
        self
    }
}

impl DocumentGraphTransformHost for TestTransformHost {
    fn run_transform(
        &self,
        callback_id: &str,
        document: &Value,
        context: &DocumentGraphTransformContext,
    ) -> Result<Value, Value> {
        self.callbacks.get(callback_id).expect("missing callback")(document, context)
    }
}

#[test]
fn graph_loader_ignores_nested_version_sidecars() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write("/a/nested/._version.yaml", "_version: 99\n")
        .unwrap();
    host.write("/b/over.yaml", "foods:\n  apple:\n    macros: { fat: 2 }\n")
        .unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["foods"]["apple"]["name"], "Apple");
    assert_eq!(
        loaded.collections["foods"]["apple"]["macros"],
        json!({"cal": 10, "fat": 2})
    );
    assert!(loaded.diagnostics.is_empty());
}

#[test]
fn graph_loader_orders_roots_and_lexical_files_then_deep_merges() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/01-base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write(
        "/a/02-over.yaml",
        "foods:\n  apple:\n    macros: { cal: 12 }\n",
    )
    .unwrap();
    host.write(
        "/b/03-over.yaml",
        "foods:\n  apple:\n    macros: { fat: 1 }\n",
    )
    .unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["foods"]["apple"]["id"], "apple");
    assert_eq!(loaded.collections["foods"]["apple"]["name"], "Apple");
    assert_eq!(
        loaded.collections["foods"]["apple"]["macros"]["cal"],
        json!(12)
    );
    assert_eq!(
        loaded.collections["foods"]["apple"]["macros"]["fat"],
        json!(1)
    );
    assert_eq!(
        loaded.contributing_paths["foods\u{0}apple"],
        vec!["/a/01-base.yaml", "/a/02-over.yaml", "/b/03-over.yaml"]
    );
}

#[test]
fn graph_loader_overlay_preserves_first_record_insertion_order() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n  banana:\n    name: Banana\n    macros: { cal: 20 }\n",
    )
    .unwrap();
    host.write(
        "/b/overlay.yaml",
        "foods:\n  apple:\n    macros: { fat: 1 }\n",
    )
    .unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();

    assert_eq!(
        loaded.collections["foods"]
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["apple".to_owned(), "banana".to_owned()]
    );
}

#[test]
fn graph_config_source_level_include_exclude_fallback_and_merge() {
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: food_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: None,
                    },
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/b".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*.json".to_owned()]),
                        exclude: vec!["**/draft/**".to_owned()],
                        collections: None,
                    },
                ],
                collections: Some(SourceCollectionSelection::All),
                include: Some(vec!["**/*.yaml".to_owned()]),
                exclude: vec!["**/ignore/**".to_owned()],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap();

    let proseql_storage::source_config::NormalizedDatabaseSourceConfig::DocumentGraph(source) =
        &normalized.sources[0]
    else {
        panic!("expected document graph source");
    };
    assert_eq!(source.roots[0].include, vec!["**/*.yaml"]);
    assert_eq!(source.roots[0].exclude, vec!["**/ignore/**"]);
    assert_eq!(source.roots[1].include, vec!["**/*.json"]);
    assert_eq!(source.roots[1].exclude, vec!["**/ignore/**", "**/draft/**"]);
}

#[test]
fn graph_config_rejects_invalid_glob_without_panicking() {
    let err = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: food_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![DocumentGraphRootConfig {
                    id: None,
                    root: "/a".to_owned(),
                    optional: false,
                    include: None,
                    exclude: vec![],
                    collections: None,
                }],
                collections: Some(SourceCollectionSelection::All),
                include: Some(vec!["[".to_owned()]),
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap_err();

    match err {
        EngineError::SourceConfig(error) => {
            let message = &error.message;
            assert!(message.contains("invalid include pattern"), "{message}");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn graph_loader_supports_mixed_extensions() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/y.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write(
        "/a/j.json",
        r#"{"foods":{"banana":{"name":"Banana","macros":{"cal":90}}}}"#,
    )
    .unwrap();
    host.write(
        "/b/t.toml",
        "[foods.cherry.macros]\ncal = 5\n[foods.cherry]\nname = \"Cherry\"\n",
    )
    .unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();
    let mut keys = loaded.collections["foods"]
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["apple", "banana", "cherry"]);
}

#[test]
fn graph_loader_validates_after_merge_not_per_fragment() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write("/b/over.yaml", "foods:\n  apple:\n    macros: { fat: 2 }\n")
        .unwrap();
    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        loaded.collections["foods"]["apple"]["macros"],
        json!({"cal":10,"fat":2})
    );
}

#[test]
fn graph_loader_returns_provenance_and_read_only_ownership_metadata() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write("/b/empty.yaml", "").unwrap();
    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap();
    assert_eq!(loaded.owned_collections["foods"], "graph");
    assert_eq!(
        loaded.provenance["foods\u{0}apple"]
            .effective_contributor
            .path,
        "/a/base.yaml"
    );
}

#[test]
fn graph_loader_ignores_null_fragments() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/null.json", "null").unwrap();
    host.write(
        "/a/good.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: Some(vec!["**/*.{yaml,json}".to_owned()]),
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["foods"]["apple"]["id"], "apple");
    assert!(loaded.diagnostics.is_empty());
}

#[test]
fn graph_loader_non_object_collection_sections_follow_fragment_policy() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/good.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write("/a/bad.yaml", "foods: []\n").unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: Some(vec!["**/*.yaml".to_owned()]),
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::SkipFragment,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(loaded.collections["foods"]["apple"]["id"], "apple");
    assert!(loaded.diagnostics.iter().any(|diagnostic| {
        diagnostic.action
            == proseql_storage::document_graph::DocumentGraphDiagnosticAction::SkippedFragment
            && diagnostic.error.as_ref().map(|error| error.kind.clone())
                == Some(DocumentGraphErrorKind::NonObject)
            && diagnostic.collection.as_deref() == Some("foods")
    }));
}

#[test]
fn graph_loader_rejects_unknown_collections_and_non_objects() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/x.yaml", "unknown:\n  item: {}\n").unwrap();
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::UnknownCollection)
        }
        other => panic!("unexpected error: {other:?}"),
    }

    let host = MemoryStorageHost::default();
    host.write("/a/x.json", "[1,2,3]").unwrap();
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::NonObject)
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn graph_loader_returns_document_graph_unsupported_extension_error_in_error_mode() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/x.ini", "foods=bad").unwrap();

    let err = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: Some(vec!["**/*".to_owned()]),
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::UnsupportedExtension);
            assert_eq!(error.path, "/a/x.ini");
        }
        other => panic!("unexpected error: {other:?}"),
    };
}

#[test]
fn graph_loader_returns_original_serialization_error_in_error_mode() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/x.yaml", "foods: [\n").unwrap();

    let err = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: None,
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: Some(vec!["**/*.yaml".to_owned()]),
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap_err();
    assert!(matches!(err, EngineError::Serialization(_)));
}

#[test]
fn graph_loader_rejects_unsupported_extensions_or_skips_by_policy() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/x.ini", "foods=bad").unwrap();

    let err = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: None,
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::UnsupportedExtension);
        }
        other => panic!("unexpected error: {other:?}"),
    }

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    }],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: None,
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::SkipFragment,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        loaded.diagnostics[0].action,
        proseql_storage::document_graph::DocumentGraphDiagnosticAction::SkippedFragment
    );
    assert_eq!(
        loaded.diagnostics[0]
            .error
            .as_ref()
            .map(|error| error.kind.clone()),
        Some(DocumentGraphErrorKind::UnsupportedExtension)
    );
}

#[test]
fn graph_loader_skip_root_drops_prior_valid_fragments_from_that_root() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write(
        "/b/banana.yaml",
        "foods:\n  banana:\n    name: Banana\n    macros: { cal: 90 }\n",
    )
    .unwrap();
    host.write("/b/bad.ini", "foods=bad").unwrap();

    let loaded = load_document_graph_sources(
        &host,
        &formats,
        &normalize_source_config(SourceConfigInput {
            collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
                .collection_configs
                .clone(),
            sources: vec![DatabaseSourceConfig::DocumentGraph(
                DocumentGraphSourceConfig {
                    id: "graph".to_owned(),
                    roots: vec![
                        DocumentGraphRootConfig {
                            id: None,
                            root: "/a".to_owned(),
                            optional: false,
                            include: Some(vec!["**/*".to_owned()]),
                            exclude: vec![],
                            collections: Some(SourceCollectionSelection::Named(vec![
                                "foods".to_owned()
                            ])),
                        },
                        DocumentGraphRootConfig {
                            id: None,
                            root: "/b".to_owned(),
                            optional: false,
                            include: Some(vec!["**/*".to_owned()]),
                            exclude: vec![],
                            collections: Some(SourceCollectionSelection::Named(vec![
                                "foods".to_owned()
                            ])),
                        },
                    ],
                    collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                    include: None,
                    exclude: vec![],
                    transform_callback_id: None,
                    on_fragment_error: DocumentGraphFragmentErrorPolicy::SkipRoot,
                },
            )],
        })
        .unwrap(),
        None,
        None,
    )
    .unwrap();
    assert!(loaded.collections["foods"].contains_key("apple"));
    assert!(!loaded.collections["foods"].contains_key("banana"));
}

#[test]
fn graph_loader_requires_transform_host_when_transform_is_configured() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/x.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();

    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(Some("shape"), DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::TransformFailure);
            assert!(
                error.message.contains("transform host"),
                "{}",
                error.message
            );
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn graph_loader_requires_migration_host_when_migrations_apply() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/old.yaml",
        "foods:\n  _version: 1\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: food_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(2),
                migrations: vec![
                    MigrationStep {
                        from: 0,
                        to: 1,
                        description: None,
                        callback_id: "foods-v1".to_owned(),
                    },
                    MigrationStep {
                        from: 1,
                        to: 2,
                        description: None,
                        callback_id: "foods-v2".to_owned(),
                    },
                ],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![DocumentGraphRootConfig {
                    id: None,
                    root: "/a".to_owned(),
                    optional: false,
                    include: None,
                    exclude: vec![],
                    collections: None,
                }],
                collections: Some(SourceCollectionSelection::All),
                include: Some(vec!["**/*.yaml".to_owned()]),
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap();

    let err = load_document_graph_sources(&host, &formats, &normalized, None, None).unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::Migration);
            assert!(error
                .cause
                .as_ref()
                .and_then(Value::as_str)
                .map(|cause| cause.contains("missing-host"))
                .unwrap_or(false));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn stale_document_graph_version_with_empty_registry_fails_empty_registry_instead_of_bypassing() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/old.yaml",
        "foods:\n  _version: 0\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: food_schema(),
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(1),
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![DocumentGraphRootConfig {
                    id: None,
                    root: "/a".to_owned(),
                    optional: false,
                    include: None,
                    exclude: vec![],
                    collections: None,
                }],
                collections: Some(SourceCollectionSelection::All),
                include: Some(vec!["**/*.yaml".to_owned()]),
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap();

    let err = load_document_graph_sources(&host, &formats, &normalized, None, None).unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::Migration);
            assert!(error
                .cause
                .as_ref()
                .and_then(Value::as_str)
                .map(|cause| cause.contains("empty-registry"))
                .unwrap_or(false));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn graph_loader_transform_callback_supports_reject_and_defect_paths() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/x.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();

    let reject_host = TestTransformHost::default()
        .with_callback("reject", |_document, _context| {
            Err(Value::String("nope".to_owned()))
        });
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(Some("reject"), DocumentGraphFragmentErrorPolicy::Error),
        None,
        Some(&reject_host),
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::TransformFailure)
        }
        other => panic!("unexpected error: {other:?}"),
    }

    struct PanicTransformHost;
    impl DocumentGraphTransformHost for PanicTransformHost {
        fn run_transform(
            &self,
            _callback_id: &str,
            _document: &Value,
            _context: &DocumentGraphTransformContext,
        ) -> Result<Value, Value> {
            panic!("boom")
        }
    }
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(Some("panic"), DocumentGraphFragmentErrorPolicy::Error),
        None,
        Some(&PanicTransformHost),
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::TransformDefect)
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn graph_loader_ignores_root_disallowed_collections_with_diagnostic() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write("/a/base.yaml", "drinks:\n  water:\n    name: Water\n")
        .unwrap();
    host.write("/b/card.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\ndrinks:\n  soda:\n    name: Soda\n").unwrap();
    let normalized = normalize_source_config(SourceConfigInput {
        collections: base_graph(None, DocumentGraphFragmentErrorPolicy::Error)
            .collection_configs
            .clone(),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*.yaml".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "drinks".to_owned()
                        ])),
                    },
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/b".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*.yaml".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    },
                ],
                collections: Some(SourceCollectionSelection::Named(vec![
                    "foods".to_owned(),
                    "drinks".to_owned(),
                ])),
                include: None,
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap();

    let loaded = load_document_graph_sources(&host, &formats, &normalized, None, None).unwrap();
    assert!(loaded.collections["drinks"].contains_key("water"));
    assert!(!loaded.collections["drinks"].contains_key("soda"));
    assert!(loaded.diagnostics.iter().any(|d| d.action
        == proseql_storage::document_graph::DocumentGraphDiagnosticAction::IgnoredCollection));
}

#[test]
fn graph_loader_applies_per_fragment_migrations_before_merge() {
    let formats = FormatRegistry::with_builtins();
    let host = MemoryStorageHost::default();
    host.write(
        "/a/old.yaml",
        "foods:\n  _version: 1\n  apple:\n    title: Apple\n",
    )
    .unwrap();
    host.write(
        "/b/new.yaml",
        "foods:\n  _version: 2\n  banana:\n    name: Banana\n    macros: { cal: 90 }\n",
    )
    .unwrap();
    let normalized = normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "name".to_owned(),
                            schema: SchemaNode::Str,
                        },
                        StructField {
                            name: "macros".to_owned(),
                            schema: SchemaNode::Optional(Box::new(SchemaNode::Struct {
                                fields: vec![StructField {
                                    name: "cal".to_owned(),
                                    schema: SchemaNode::Num,
                                }],
                            })),
                        },
                    ],
                },
                id_strategy: IdStrategy::DerivedFromKey,
                version: Some(2),
                migrations: vec![
                    MigrationStep {
                        from: 0,
                        to: 1,
                        description: None,
                        callback_id: "foods-0-1".to_owned(),
                    },
                    MigrationStep {
                        from: 1,
                        to: 2,
                        description: None,
                        callback_id: "foods-1-2".to_owned(),
                    },
                ],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/a".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*.yaml".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    },
                    DocumentGraphRootConfig {
                        id: None,
                        root: "/b".to_owned(),
                        optional: false,
                        include: Some(vec!["**/*.yaml".to_owned()]),
                        exclude: vec![],
                        collections: Some(SourceCollectionSelection::Named(vec![
                            "foods".to_owned()
                        ])),
                    },
                ],
                collections: Some(SourceCollectionSelection::Named(vec!["foods".to_owned()])),
                include: None,
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap();
    let migration_host = TestMigrationHost::default()
        .with_callback("foods-0-1", |data| Ok(data.clone()))
        .with_callback("foods-1-2", |data| {
            let mut out = Map::new();
            for (id, value) in data {
                let value = value.as_object().unwrap();
                out.insert(
                    id.clone(),
                    json!({"name": value.get("title").unwrap(), "macros": {"cal": 10}}),
                );
            }
            Ok(out)
        });

    let loaded =
        load_document_graph_sources(&host, &formats, &normalized, Some(&migration_host), None)
            .unwrap();
    assert_eq!(loaded.collections["foods"]["apple"]["name"], "Apple");
    assert_eq!(loaded.collections["foods"]["banana"]["name"], "Banana");
}

#[test]
fn graph_loader_reports_validation_context_with_contributing_paths() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/x.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: nope }\n",
    )
    .unwrap();
    host.write("/b/empty.yaml", "").unwrap();
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::Validation);
            assert_eq!(error.collection.as_deref(), Some("foods"));
            assert_eq!(error.record_id.as_deref(), Some("apple"));
            assert!(error
                .contributing_paths
                .as_ref()
                .unwrap()
                .contains(&"/a/x.yaml".to_owned()));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn malformed_normalized_graph_config_returns_source_config_error_not_panic() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    host.write(
        "/a/base.yaml",
        "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
    )
    .unwrap();
    host.write(
        "/b/base.yaml",
        "foods:\n  banana:\n    name: Banana\n    macros: { cal: 20 }\n",
    )
    .unwrap();

    let mut malformed = base_graph(None, DocumentGraphFragmentErrorPolicy::Error);
    malformed.collection_configs.shift_remove("foods");

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        load_document_graph_sources(&host, &formats, &malformed, None, None)
    }));
    let err = result.expect("should not panic").unwrap_err();
    assert!(matches!(err, EngineError::SourceConfig(_)), "{err:?}");
}

#[test]
fn graph_loader_requires_non_optional_roots_to_exist() {
    let host = MemoryStorageHost::default();
    let formats = FormatRegistry::with_builtins();
    let err = load_document_graph_sources(
        &host,
        &formats,
        &base_graph(None, DocumentGraphFragmentErrorPolicy::Error),
        None,
        None,
    )
    .unwrap_err();
    match err {
        EngineError::DocumentGraphSource(error) => {
            assert_eq!(error.kind, DocumentGraphErrorKind::MissingRoot)
        }
        other => panic!("unexpected error: {other:?}"),
    }
}
