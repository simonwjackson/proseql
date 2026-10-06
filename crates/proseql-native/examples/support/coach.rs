//! Consumer configuration matching Coach's legacy source layout. The schema
//! fixture contains only schema declarations, never personal records.
use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::descriptor::CollectionDescriptor;
use proseql_formats::{codecs, FormatRegistry};
use proseql_native::{
    NativeCollectionConfig, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::document_graph::{DocumentGraphTransformContext, DocumentGraphTransformHost};
use proseql_storage::source_config::{
    DatabaseSourceConfig, DocumentGraphFragmentErrorPolicy, DocumentGraphRootConfig,
    DocumentGraphSourceConfig, DocumentSourceConfig, SourceCollectionSelection,
    UnknownCollectionPolicy,
};
use serde_json::Value;

type LineWarning = Arc<dyn Fn(&str, usize) + Send + Sync>;

pub fn config(root: &str, schema: &Value) -> Result<NativeSourceRuntimeConfig, serde_json::Error> {
    let descriptors: Vec<CollectionDescriptor> =
        serde_json::from_value(schema["collections"].clone())?;
    let oura: IndexMap<String, String> = serde_json::from_value(schema["ouraFiles"].clone())?;
    let mut providers: Vec<String> = vec!["recoveryLog".into(), "withingsWeightLog".into()];
    providers.extend(oura.keys().cloned());
    let owned = descriptors
        .iter()
        .filter(|descriptor| !providers.contains(&descriptor.name))
        .map(|descriptor| descriptor.name.clone())
        .collect();
    let root_config = |id: &str, file: &str, collection: &str| DocumentGraphRootConfig {
        id: Some(id.into()),
        root: root.into(),
        optional: true,
        include: Some(vec![file.into()]),
        exclude: vec![],
        collections: Some(SourceCollectionSelection::Named(vec![collection.into()])),
    };
    let mut exclude = vec!["recovery.yaml".into(), "withings.yaml".into()];
    exclude.extend(oura.values().cloned());
    let mut sources = vec![DatabaseSourceConfig::Documents(DocumentSourceConfig {
        id: "coach".into(),
        root: root.into(),
        include: Some(vec!["**/*.yaml".into()]),
        exclude,
        format: Some("yaml".into()),
        collections: Some(SourceCollectionSelection::Named(owned)),
        unknown_collections: UnknownCollectionPolicy::Preserve,
        outbox: "generated.yaml".into(),
        optional: false,
    })];
    for (id, file, collection) in [
        ("recovery", "recovery.yaml", "recoveryLog"),
        ("withings", "withings.yaml", "withingsWeightLog"),
    ] {
        let mut yaml_root = root_config(id, file, collection);
        // The legacy YAML roots inherit collection selection and generated IDs.
        yaml_root.id = None;
        yaml_root.collections = None;
        sources.push(DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: id.into(),
                roots: vec![yaml_root],
                collections: Some(SourceCollectionSelection::Named(vec![collection.into()])),
                include: None,
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        ));
    }
    sources.push(DatabaseSourceConfig::DocumentGraph(
        DocumentGraphSourceConfig {
            id: "oura".into(),
            roots: oura
                .iter()
                .map(|(collection, file)| root_config(collection, file, collection))
                .collect(),
            collections: Some(SourceCollectionSelection::Named(
                oura.keys().cloned().collect(),
            )),
            include: None,
            exclude: vec![],
            transform_callback_id: Some("coach-oura-rows".into()),
            on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
        },
    ));
    Ok(NativeSourceRuntimeConfig {
        collections: descriptors
            .into_iter()
            .map(NativeCollectionConfig::new)
            .collect(),
        sources,
    })
}

pub fn options(warning: LineWarning) -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        formats: FormatRegistry::new(vec![
            Box::new(codecs::yaml_codec()),
            Box::new(codecs::lenient_jsonl_codec()),
        ]),
        transforms: Some(Arc::new(OuraRows(warning))),
        ..Default::default()
    }
}

struct OuraRows(LineWarning);
impl DocumentGraphTransformHost for OuraRows {
    fn run_transform(
        &self,
        callback_id: &str,
        document: &Value,
        context: &DocumentGraphTransformContext,
    ) -> Result<Value, Value> {
        if callback_id != "coach-oura-rows" {
            return Err(Value::String("Unknown transform".into()));
        }
        let mut records = serde_json::Map::new();
        if let Some(rows) = document.as_array() {
            for row in rows {
                if row.get("__jsonlParseError").and_then(Value::as_bool) == Some(true) {
                    (self.0)(
                        &context.path,
                        row["line"].as_u64().unwrap_or_default() as usize,
                    );
                    continue;
                }
                let Some(object) = row.as_object() else {
                    continue;
                };
                let Some(id) = object.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let mut payload = object.clone();
                payload.shift_remove("id");
                records.insert(id.into(), payload.into());
            }
        }
        Ok(serde_json::json!({context.root_id.clone(): records}))
    }
}
