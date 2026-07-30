use std::collections::{HashMap, HashSet};
use std::path::Path;

use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::descriptor::{IdStrategy, MigrationDescriptor, SchemaNode};
use proseql_engine::errors::{
    EngineError, MigrationError, OperationError, SerializationError, StorageError,
    StorageOperation, ValidationError, ValidationIssue,
};
use proseql_engine::migrations::{
    dry_run_report as engine_dry_run_report, post_migration_validation_error,
    validate_migration_registry as engine_validate_migration_registry,
};
pub use proseql_engine::migrations::{DryRunMigration, DryRunStatus};
use proseql_engine::validator::{decode_value, js_eq};
use proseql_formats::codecs::jsonl_decode_lines;
use proseql_formats::{FormatOptions, FormatRegistry, FormatRegistryError};
use serde_json::{Map, Value};

use crate::host::StorageHost;
use crate::path::{get_file_extension, normalize_path};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ValidationMode {
    #[default]
    Strict,
    Lenient,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationStep {
    pub from: u32,
    pub to: u32,
    pub description: Option<String>,
    pub callback_id: String,
}

pub trait MigrationHost: Send + Sync {
    fn run_migration(
        &self,
        callback_id: &str,
        data: &Map<String, Value>,
    ) -> Result<Map<String, Value>, EngineError>;
}

fn to_engine_migration_descriptors(migrations: &[MigrationStep]) -> Vec<MigrationDescriptor> {
    migrations
        .iter()
        .map(|step| MigrationDescriptor {
            from: step.from,
            to: step.to,
            description: step.description.clone(),
            callback_id: step.callback_id.clone(),
        })
        .collect()
}

pub(crate) fn validate_migration_registry(
    collection: &str,
    target_version: u32,
    migrations: &[MigrationStep],
) -> Result<(), EngineError> {
    let descriptors = to_engine_migration_descriptors(migrations);
    engine_validate_migration_registry(collection, target_version, &descriptors)
}

fn dry_run_collection(
    file_path: &str,
    file_exists: bool,
    file_version: u32,
    collection: &LoadCollectionConfig,
) -> Result<DryRunCollectionResult, EngineError> {
    let target_version = collection.version.unwrap_or(0);
    validate_migration_registry(&collection.name, target_version, &collection.migrations)?;
    let report = engine_dry_run_report(
        file_exists,
        file_version,
        target_version,
        &to_engine_migration_descriptors(&collection.migrations),
    );
    Ok(DryRunCollectionResult {
        name: collection.name.clone(),
        file_path: file_path.to_owned(),
        current_version: report.current_version,
        target_version: report.target_version,
        migrations_to_apply: report.migrations_to_apply,
        status: report.status,
    })
}

pub struct CallbackRegistryMigrationHost<'a> {
    registry: &'a CallbackRegistry,
}

impl<'a> CallbackRegistryMigrationHost<'a> {
    pub fn new(registry: &'a CallbackRegistry) -> Self {
        Self { registry }
    }
}

impl MigrationHost for CallbackRegistryMigrationHost<'_> {
    fn run_migration(
        &self,
        callback_id: &str,
        data: &Map<String, Value>,
    ) -> Result<Map<String, Value>, EngineError> {
        self.registry
            .invoke_migration(callback_id, data)
            .unwrap_or_else(|| {
                Err(EngineError::Operation(OperationError {
                    operation: "migration".to_owned(),
                    reason: "missing-callback".to_owned(),
                    message: format!(
                        "Migration callback '{}' is not registered in CallbackRegistry",
                        callback_id
                    ),
                }))
            })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionStorageConfig {
    pub name: String,
    pub schema: SchemaNode,
    pub id_strategy: IdStrategy,
    pub version: Option<u32>,
    pub migrations: Vec<MigrationStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunCollectionResult {
    pub name: String,
    pub file_path: String,
    pub current_version: u32,
    pub target_version: u32,
    pub migrations_to_apply: Vec<DryRunMigration>,
    pub status: DryRunStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunResult {
    pub collections: Vec<DryRunCollectionResult>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DryRunInput {
    SingleFile {
        file_path: String,
        collection: LoadCollectionConfig,
    },
    Directory {
        dir_path: String,
        extension: String,
        collection: LoadCollectionConfig,
    },
    MultiCollectionFile {
        file_path: String,
        collections: Vec<LoadCollectionConfig>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadCollectionConfig {
    pub name: String,
    pub schema: SchemaNode,
    pub id_strategy: IdStrategy,
    pub version: Option<u32>,
    pub migrations: Vec<MigrationStep>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SaveCollectionConfig {
    pub name: String,
    pub schema: SchemaNode,
    pub id_strategy: IdStrategy,
    pub version: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadDataOptions {
    pub version: Option<u32>,
    pub migrations: Vec<MigrationStep>,
    pub collection_name: Option<String>,
    pub format: Option<String>,
    pub path: Option<String>,
    pub validation: ValidationMode,
    pub id_strategy: Option<IdStrategy>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SaveDataOptions {
    pub version: Option<u32>,
    pub format: Option<String>,
    pub path: Option<String>,
    pub id_strategy: Option<IdStrategy>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppendDataOptions {
    pub format: Option<String>,
    pub id_strategy: Option<IdStrategy>,
}

pub(crate) fn resolve_extension(
    file_path: &str,
    format: Option<&str>,
) -> Result<String, EngineError> {
    if let Some(format) = format {
        return Ok(format.to_owned());
    }
    let ext = get_file_extension(file_path);
    if ext.is_empty() {
        return Err(EngineError::Storage(Box::new(StorageError {
            path: file_path.to_owned(),
            operation: StorageOperation::Read,
            message: format!("Cannot determine file format: no extension in '{file_path}'"),
            cause: None,
        })));
    }
    Ok(ext)
}

pub(crate) fn format_error(error: FormatRegistryError) -> EngineError {
    match error {
        FormatRegistryError::Serialization(error) => EngineError::Serialization(Box::new(error)),
        FormatRegistryError::UnsupportedFormat(error) => {
            EngineError::UnsupportedFormat(Box::new(error))
        }
    }
}

fn get_at_path<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = obj;
    for segment in path.split('.') {
        let Value::Object(map) = current else {
            return None;
        };
        current = map.get(segment)?;
    }
    Some(current)
}

fn set_at_path(obj: &mut Map<String, Value>, path: &str, value: Value) -> Result<(), EngineError> {
    let segments = path
        .split('.')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return Err(EngineError::Storage(Box::new(StorageError {
            path: path.to_owned(),
            operation: StorageOperation::Write,
            message: format!("Cannot write nested data: invalid empty path '{path}'"),
            cause: None,
        })));
    }

    let mut current = obj;
    for segment in &segments[..segments.len() - 1] {
        let entry = current
            .entry((*segment).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let Some(next) = entry.as_object_mut() else {
            return Err(EngineError::Storage(Box::new(StorageError {
                path: path.to_owned(),
                operation: StorageOperation::Write,
                message: format!("Cannot write nested data at path '{path}'"),
                cause: None,
            })));
        };
        current = next;
    }
    current.insert(segments[segments.len() - 1].to_owned(), value);
    Ok(())
}

fn is_derived(id_strategy: &IdStrategy) -> bool {
    matches!(id_strategy, IdStrategy::DerivedFromKey)
}

fn directory_version_metadata_path(dir_path: &str, extension: &str) -> String {
    format!(
        "{}/._version.{}",
        normalize_path(dir_path).trim_end_matches('/'),
        extension
    )
}

pub(crate) fn is_version_sidecar_path(path: &str, extension: &str) -> bool {
    get_file_extension(path) == extension.to_ascii_lowercase()
        && Path::new(path).file_stem().and_then(|name| name.to_str()) == Some("._version")
}

fn read_directory_version_metadata(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    dir_path: &str,
    extension: &str,
) -> Result<Option<u32>, EngineError> {
    let metadata_path = directory_version_metadata_path(dir_path, extension);
    if !host.exists(&metadata_path)? {
        return Ok(None);
    }
    let parsed = formats
        .deserialize(&host.read(&metadata_path)?, extension)
        .map_err(format_error)?;
    let version = parsed
        .as_object()
        .and_then(|map| map.get("_version"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    Ok(Some(version))
}

fn write_directory_version_metadata(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    dir_path: &str,
    extension: &str,
    version: u32,
) -> Result<(), EngineError> {
    let metadata_path = directory_version_metadata_path(dir_path, extension);
    let raw = formats
        .serialize(
            &Value::Object(Map::from_iter([(
                "_version".to_owned(),
                Value::Number(version.into()),
            )])),
            extension,
            Some(FormatOptions::default()),
        )
        .map_err(format_error)?;
    host.ensure_dir(&metadata_path)?;
    host.write(&metadata_path, &raw)
}

pub(crate) fn assert_no_physical_derived_id(
    key: &str,
    value: &Value,
    id_strategy: &IdStrategy,
    path: &str,
) -> Result<(), EngineError> {
    if !is_derived(id_strategy) {
        return Ok(());
    }
    let Value::Object(map) = value else {
        return Ok(());
    };
    if let Some(physical_id) = map.get("id") {
        return Err(EngineError::Validation(ValidationError {
            message: format!("Derived id field 'id' must not be present in persisted payload '{key}' at '{path}'"),
            issues: vec![ValidationIssue {
                field: format!("{path}.{key}.id"),
                message: "Derived id fields are read from the storage key and must not be duplicated in the payload".to_owned(),
                value: Some(physical_id.clone()),
                expected: None,
                received: None,
            }],
        }));
    }
    Ok(())
}

pub(crate) fn strip_derived_id_field(value: &Value, id_strategy: &IdStrategy) -> Value {
    if !is_derived(id_strategy) {
        return value.clone();
    }
    match value {
        Value::Object(map) => {
            let mut cloned = map.clone();
            cloned.remove("id");
            Value::Object(cloned)
        }
        _ => value.clone(),
    }
}

pub(crate) fn require_hydratable_payload(
    key: &str,
    value: &Value,
    id_strategy: &IdStrategy,
    path: &str,
) -> Result<(), EngineError> {
    if !is_derived(id_strategy) || value.is_object() {
        return Ok(());
    }
    Err(EngineError::Validation(ValidationError {
        message: format!("Derived id payload '{key}' at '{path}' must decode to an object"),
        issues: vec![ValidationIssue {
            field: format!("{path}.{key}"),
            message: "Derived id payloads must be object records".to_owned(),
            value: Some(value.clone()),
            expected: None,
            received: None,
        }],
    }))
}

pub(crate) fn hydrate_derived_id(key: &str, value: Value, id_strategy: &IdStrategy) -> Value {
    if !is_derived(id_strategy) {
        return value;
    }
    match value {
        Value::Object(mut map) => {
            map.insert("id".to_owned(), Value::String(key.to_owned()));
            Value::Object(map)
        }
        other => Value::Object(Map::from_iter([
            (String::from("id"), Value::String(key.to_owned())),
            (String::from("value"), other),
        ])),
    }
}

pub(crate) fn encode_value(
    schema: &SchemaNode,
    value: &Value,
    path: &str,
) -> Result<Value, EngineError> {
    match schema {
        SchemaNode::Str => match value {
            Value::String(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "string", value)),
        },
        SchemaNode::Num => match value {
            Value::Number(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "number", value)),
        },
        SchemaNode::Bool => match value {
            Value::Bool(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "boolean", value)),
        },
        SchemaNode::NumFromStr => match value {
            Value::Number(number) => Ok(Value::String(number.to_string())),
            _ => Err(type_mismatch(path, "number", value)),
        },
        SchemaNode::Unknown => Ok(value.clone()),
        SchemaNode::Literal { value: expected } => {
            if js_eq(value, expected) {
                Ok(value.clone())
            } else {
                Err(type_mismatch(path, "literal", value))
            }
        }
        SchemaNode::LiteralUnion { values } => {
            if values.iter().any(|expected| js_eq(value, expected)) {
                Ok(value.clone())
            } else {
                Err(type_mismatch(path, "literal union", value))
            }
        }
        SchemaNode::Optional(inner) => encode_value(inner, value, path),
        SchemaNode::OptionalWithDefault { inner, .. } => encode_value(inner, value, path),
        SchemaNode::NullOr(inner) => {
            if value.is_null() {
                Ok(Value::Null)
            } else {
                encode_value(inner, value, path)
            }
        }
        SchemaNode::Array { item } => match value {
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item_value)| {
                        encode_value(item, item_value, &format!("{path}[{index}]"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            _ => Err(type_mismatch(path, "array", value)),
        },
        SchemaNode::Record {
            value: value_schema,
            ..
        } => match value {
            Value::Object(map) => Ok(Value::Object(
                map.iter()
                    .map(|(key, item_value)| {
                        encode_value(value_schema, item_value, &format!("{path}.{key}"))
                            .map(|encoded| (key.clone(), encoded))
                    })
                    .collect::<Result<Map<_, _>, _>>()?,
            )),
            _ => Err(type_mismatch(path, "object", value)),
        },
        SchemaNode::Struct { fields } => match value {
            Value::Object(map) => {
                let mut out = Map::new();
                for field in fields {
                    match &field.schema {
                        SchemaNode::Optional(inner) => {
                            if let Some(field_value) = map.get(&field.name) {
                                out.insert(
                                    field.name.clone(),
                                    encode_value(
                                        inner,
                                        field_value,
                                        &format!("{path}.{}", field.name),
                                    )?,
                                );
                            }
                        }
                        SchemaNode::OptionalWithDefault { inner, .. } => {
                            if let Some(field_value) = map.get(&field.name) {
                                out.insert(
                                    field.name.clone(),
                                    encode_value(
                                        inner,
                                        field_value,
                                        &format!("{path}.{}", field.name),
                                    )?,
                                );
                            }
                        }
                        other => {
                            let field_value = map.get(&field.name).ok_or_else(|| {
                                EngineError::Validation(ValidationError {
                                    message: format!(
                                        "Missing required field '{path}.{}'",
                                        field.name
                                    ),
                                    issues: vec![ValidationIssue {
                                        field: format!("{path}.{}", field.name),
                                        message: "Required field missing".to_owned(),
                                        value: None,
                                        expected: None,
                                        received: None,
                                    }],
                                })
                            })?;
                            out.insert(
                                field.name.clone(),
                                encode_value(
                                    other,
                                    field_value,
                                    &format!("{path}.{}", field.name),
                                )?,
                            );
                        }
                    }
                }
                Ok(Value::Object(out))
            }
            _ => Err(type_mismatch(path, "object", value)),
        },
        SchemaNode::Unsupported { reason } => Err(EngineError::Validation(ValidationError {
            message: format!("Unsupported schema combinator: {reason}"),
            issues: vec![ValidationIssue {
                field: path.to_owned(),
                message: format!("Unsupported schema combinator: {reason}"),
                value: None,
                expected: None,
                received: None,
            }],
        })),
    }
}

fn type_mismatch(path: &str, expected: &str, value: &Value) -> EngineError {
    EngineError::Validation(ValidationError {
        message: format!("Expected {expected} at '{path}'"),
        issues: vec![ValidationIssue {
            field: path.to_owned(),
            message: format!("Expected {expected}"),
            value: Some(value.clone()),
            expected: Some(expected.to_owned()),
            received: Some(type_name(value).to_owned()),
        }],
    })
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn run_migrations(
    data: Map<String, Value>,
    file_version: u32,
    target_version: u32,
    migrations: &[MigrationStep],
    collection_name: &str,
    migration_host: Option<&dyn MigrationHost>,
) -> Result<Map<String, Value>, EngineError> {
    if file_version >= target_version {
        return Ok(data);
    }

    validate_migration_registry(collection_name, target_version, migrations)?;

    let mut applicable = migrations
        .iter()
        .filter(|step| step.from >= file_version && step.to <= target_version)
        .cloned()
        .collect::<Vec<_>>();
    applicable.sort_by_key(|step| step.from);
    if applicable.is_empty() {
        return Ok(data);
    }
    let Some(host) = migration_host else {
        let step = &applicable[0];
        return Err(EngineError::Migration(Box::new(MigrationError {
            collection: collection_name.to_owned(),
            from_version: step.from,
            to_version: step.to,
            step: -1,
            reason: "missing-host".to_owned(),
            message: format!(
                "Migration {}→{} requires a migration host for callback '{}'",
                step.from, step.to, step.callback_id
            ),
        })));
    };
    let mut current = data;
    for (index, step) in applicable.iter().enumerate() {
        current = host
            .run_migration(&step.callback_id, &current)
            .map_err(|error| match error {
                EngineError::Migration(_) => error,
                _ => EngineError::Migration(Box::new(MigrationError {
                    collection: collection_name.to_owned(),
                    from_version: step.from,
                    to_version: step.to,
                    step: index as i32,
                    reason: "transform-failed".to_owned(),
                    message: format!("Migration {}→{} failed: {error}", step.from, step.to),
                })),
            })?;
    }
    Ok(current)
}

pub(crate) fn decode_entity_map(
    file_path: &str,
    schema: &SchemaNode,
    id_strategy: &IdStrategy,
    entity_map: Map<String, Value>,
    validation: ValidationMode,
) -> Result<IndexMap<String, Value>, EngineError> {
    let mut entries = IndexMap::new();
    for (id, value) in entity_map {
        let attempt = || -> Result<Value, EngineError> {
            assert_no_physical_derived_id(&id, &value, id_strategy, file_path)?;
            let decoded = decode_value(schema, &value)?;
            require_hydratable_payload(&id, &decoded, id_strategy, file_path)?;
            Ok(hydrate_derived_id(&id, decoded, id_strategy))
        };
        match attempt() {
            Ok(decoded) => {
                let runtime_id = decoded
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned();
                entries.insert(runtime_id, decoded);
            }
            Err(error) if validation == ValidationMode::Lenient => {}
            Err(error) => return Err(error),
        }
    }
    Ok(entries)
}

pub fn load_data(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    file_path: &str,
    schema: &SchemaNode,
    options: LoadDataOptions,
    migration_host: Option<&dyn MigrationHost>,
) -> Result<IndexMap<String, Value>, EngineError> {
    let ext = resolve_extension(file_path, options.format.as_deref())?;
    if !host.exists(file_path)? {
        return Ok(IndexMap::new());
    }
    let raw = host.read(file_path)?;
    let is_jsonl = matches!(ext.as_str(), "jsonl" | "ndjson");
    let mut entity_map = Map::new();
    let mut file_version = 0_u32;

    if is_jsonl && options.validation == ValidationMode::Lenient {
        for line in jsonl_decode_lines(&raw) {
            if line.parse_error.is_some() {
                continue;
            }
            let Some(Value::Object(record)) = line.parsed else {
                continue;
            };
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| line.line_number.to_string());
            entity_map.insert(id, Value::Object(record));
        }
    } else {
        let parsed = formats.deserialize(&raw, &ext).map_err(format_error)?;
        let enclosing_version = if options.path.is_some() {
            parsed
                .as_object()
                .and_then(|map| map.get("_version"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32
        } else {
            0
        };
        let resolved = if let Some(path) = &options.path {
            match get_at_path(&parsed, path) {
                Some(value) => value.clone(),
                None => return Ok(IndexMap::new()),
            }
        } else {
            parsed
        };
        let is_array_format = is_jsonl
            || ext == "prose"
            || (options.path.is_some() && matches!(resolved, Value::Array(_)));
        match resolved {
            Value::Array(items) if is_array_format => {
                if options.path.is_some() {
                    file_version = enclosing_version;
                }
                for (index, item) in items.into_iter().enumerate() {
                    if let Value::Object(record) = item {
                        let id = record
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| index.to_string());
                        entity_map.insert(id, Value::Object(record));
                    }
                }
            }
            Value::Object(mut map) => {
                file_version = if options.path.is_some() {
                    enclosing_version
                } else {
                    map.get("_version").and_then(Value::as_u64).unwrap_or(0) as u32
                };
                map.shift_remove("_version");
                entity_map = map;
            }
            other => {
                return Err(EngineError::Serialization(Box::new(SerializationError {
                    format: ext,
                    message: format!(
                        "Invalid data format in '{file_path}'{}: expected object or array, got {}",
                        options
                            .path
                            .as_ref()
                            .map(|path| format!(" at path '{path}'"))
                            .unwrap_or_default(),
                        type_name(&other)
                    ),
                    cause: None,
                })))
            }
        }
    }

    let mut migrated_target_version = None;
    let collection_name = options
        .collection_name
        .clone()
        .unwrap_or_else(|| "unknown".to_owned());
    if let Some(target_version) = options.version {
        if file_version > target_version {
            return Err(EngineError::Migration(Box::new(MigrationError {
                collection: collection_name.clone(),
                from_version: target_version,
                to_version: file_version,
                step: -1,
                reason: "version-ahead".to_owned(),
                message: format!(
                    "File version {file_version} is ahead of config version {target_version}. Cannot load data from a future version."
                ),
            })));
        }
        if file_version < target_version {
            validate_migration_registry(&collection_name, target_version, &options.migrations)?;
            if !options.migrations.is_empty() {
                entity_map = run_migrations(
                    entity_map,
                    file_version,
                    target_version,
                    &options.migrations,
                    &collection_name,
                    migration_host,
                )?;
                migrated_target_version = Some(target_version);
            }
        }
    }

    let id_strategy = options.id_strategy.unwrap_or(IdStrategy::Provided);
    let decoded = decode_entity_map(
        file_path,
        schema,
        &id_strategy,
        entity_map,
        options.validation,
    )
    .map_err(|error| {
        if let Some(target_version) = migrated_target_version {
            post_migration_validation_error(
                &collection_name,
                file_version,
                target_version,
                error.to_string(),
            )
        } else {
            error
        }
    })?;

    if let Some(target_version) = migrated_target_version {
        save_data(
            host,
            formats,
            file_path,
            schema,
            &decoded,
            SaveDataOptions {
                version: Some(target_version),
                format: options.format,
                path: options.path,
                id_strategy: Some(id_strategy),
            },
        )?;
    }

    Ok(decoded)
}

pub fn append_data(
    host: &dyn StorageHost,
    _formats: &FormatRegistry,
    file_path: &str,
    schema: &SchemaNode,
    data: &IndexMap<String, Value>,
    options: AppendDataOptions,
) -> Result<(), EngineError> {
    let ext = resolve_extension(file_path, options.format.as_deref())?;
    if !matches!(ext.as_str(), "jsonl" | "ndjson") {
        return Err(EngineError::Validation(ValidationError {
            message: format!(
                "Append-only writes require JSONL/NDJSON; format '{}' is not supported for '{}'",
                ext, file_path
            ),
            issues: vec![ValidationIssue {
                field: "format".to_owned(),
                message: "Append-only writes require JSONL/NDJSON formats".to_owned(),
                value: Some(Value::String(ext)),
                expected: None,
                received: None,
            }],
        }));
    }
    let id_strategy = options.id_strategy.unwrap_or(IdStrategy::Provided);
    if is_derived(&id_strategy) {
        return Err(EngineError::Validation(ValidationError {
            message: format!(
                "Derived ids require object-keyed persistence; format '{}' is not supported for '{}'",
                ext, file_path
            ),
            issues: vec![ValidationIssue {
                field: "id".to_owned(),
                message: "Derived ids are only supported for object-keyed persistence formats"
                    .to_owned(),
                value: None,
                expected: None,
                received: None,
            }],
        }));
    }

    let batch = data
        .iter()
        .map(|(id, value)| {
            let encoded = encode_value(schema, value, id)?;
            let line = serde_json::to_string(&encoded).map_err(|error| {
                EngineError::Serialization(Box::new(SerializationError {
                    format: ext.clone(),
                    message: format!(
                        "Invalid data format in '{}': failed to encode append-only line: {error}",
                        file_path
                    ),
                    cause: None,
                }))
            })?;
            Ok(format!("{line}\n"))
        })
        .collect::<Result<Vec<_>, EngineError>>()?
        .join("");

    host.ensure_dir(file_path)?;
    host.append(file_path, &batch)
}

pub fn save_data(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    file_path: &str,
    schema: &SchemaNode,
    data: &IndexMap<String, Value>,
    options: SaveDataOptions,
) -> Result<(), EngineError> {
    let ext = resolve_extension(file_path, options.format.as_deref())?;
    let id_strategy = options.id_strategy.unwrap_or(IdStrategy::Provided);
    let is_array_format = matches!(ext.as_str(), "jsonl" | "ndjson" | "prose");

    let output = if is_array_format && options.path.is_none() {
        if is_derived(&id_strategy) {
            return Err(EngineError::Validation(ValidationError {
                message: format!(
                    "Derived ids require object-keyed persistence; format '{ext}' is not supported for '{file_path}'"
                ),
                issues: vec![ValidationIssue {
                    field: "id".to_owned(),
                    message: "Derived ids are only supported for object-keyed persistence formats"
                        .to_owned(),
                    value: None,
                    expected: None,
                    received: None,
                }],
            }));
        }
        Value::Array(
            data.iter()
                .map(|(id, value)| encode_value(schema, value, id))
                .collect::<Result<Vec<_>, _>>()?,
        )
    } else {
        let mut entity_map = Map::new();
        for (id, value) in data {
            let stripped = strip_derived_id_field(value, &id_strategy);
            entity_map.insert(id.clone(), encode_value(schema, &stripped, id)?);
        }

        let collection_data = if options.path.is_some() {
            Value::Array(entity_map.into_values().collect())
        } else {
            let mut out = Map::new();
            if let Some(version) = options.version {
                out.insert("_version".to_owned(), Value::Number(version.into()));
            }
            for (key, value) in entity_map {
                out.insert(key, value);
            }
            Value::Object(out)
        };

        if let Some(path) = &options.path {
            let mut root = if host.exists(file_path)? {
                match formats
                    .deserialize(&host.read(file_path)?, &ext)
                    .map_err(format_error)?
                {
                    Value::Object(map) => map,
                    _ => Map::new(),
                }
            } else {
                Map::new()
            };
            set_at_path(&mut root, path, collection_data)?;
            if let Some(version) = options.version {
                root.insert("_version".to_owned(), Value::Number(version.into()));
            }
            Value::Object(root)
        } else {
            collection_data
        }
    };

    let content = formats
        .serialize(&output, &ext, Some(FormatOptions::default()))
        .map_err(format_error)?;
    host.ensure_dir(file_path)?;
    host.write(file_path, &content)
}

pub fn load_collections_from_file(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    file_path: &str,
    collections: &[LoadCollectionConfig],
    migration_host: Option<&dyn MigrationHost>,
) -> Result<IndexMap<String, IndexMap<String, Value>>, EngineError> {
    let ext = resolve_extension(file_path, None)?;
    if !host.exists(file_path)? {
        return Ok(collections
            .iter()
            .map(|collection| (collection.name.clone(), IndexMap::new()))
            .collect());
    }
    let raw = host.read(file_path)?;
    let parsed = formats.deserialize(&raw, &ext).map_err(format_error)?;
    let root = match parsed {
        Value::Object(map) => map,
        other => {
            return Err(EngineError::Serialization(Box::new(SerializationError {
                format: ext,
                message: format!(
                    "Invalid data format in '{file_path}': expected object, got {}",
                    type_name(&other)
                ),
                cause: None,
            })))
        }
    };

    let mut result = IndexMap::new();
    let mut root_for_writeback = root.clone();
    let mut should_write_back = false;
    for collection in collections {
        let section = root
            .get(&collection.name)
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let temp_path = format!("{file_path}#{}", collection.name);
        let mut entity_map = Map::new();
        let mut file_version = 0_u32;
        if let Value::Object(mut map) = section {
            file_version = map.get("_version").and_then(Value::as_u64).unwrap_or(0) as u32;
            map.shift_remove("_version");
            entity_map = map;
        }
        let mut migrated_target_version = None;
        if let Some(target_version) = collection.version {
            if file_version > target_version {
                return Err(EngineError::Migration(Box::new(MigrationError {
                    collection: collection.name.clone(),
                    from_version: target_version,
                    to_version: file_version,
                    step: -1,
                    reason: "version-ahead".to_owned(),
                    message: format!(
                        "File version {file_version} is ahead of config version {target_version}. Cannot load data from a future version."
                    ),
                })));
            }
            if file_version < target_version {
                validate_migration_registry(
                    &collection.name,
                    target_version,
                    &collection.migrations,
                )?;
                if !collection.migrations.is_empty() {
                    entity_map = run_migrations(
                        entity_map,
                        file_version,
                        target_version,
                        &collection.migrations,
                        &collection.name,
                        migration_host,
                    )?;
                    migrated_target_version = Some(target_version);
                }
            }
        }
        let decoded = decode_entity_map(
            &temp_path,
            &collection.schema,
            &collection.id_strategy,
            entity_map,
            ValidationMode::Strict,
        )
        .map_err(|error| {
            if let Some(target_version) = migrated_target_version {
                post_migration_validation_error(
                    &collection.name,
                    file_version,
                    target_version,
                    error.to_string(),
                )
            } else {
                error
            }
        })?;
        if let Some(target_version) = migrated_target_version {
            let records = decoded
                .iter()
                .map(|(id, value)| {
                    encode_value(
                        &collection.schema,
                        &strip_derived_id_field(value, &collection.id_strategy),
                        id,
                    )
                    .map(|encoded| (id.clone(), encoded))
                })
                .collect::<Result<Map<_, _>, _>>()?;
            let mut section_out = Map::new();
            section_out.insert("_version".to_owned(), Value::Number(target_version.into()));
            for (id, value) in records {
                section_out.insert(id, value);
            }
            root_for_writeback.insert(collection.name.clone(), Value::Object(section_out));
            should_write_back = true;
        }
        result.insert(collection.name.clone(), decoded);
    }
    if should_write_back {
        let content = formats
            .serialize(
                &Value::Object(root_for_writeback),
                &ext,
                Some(FormatOptions::default()),
            )
            .map_err(format_error)?;
        host.ensure_dir(file_path)?;
        host.write(file_path, &content)?;
    }
    Ok(result)
}

pub fn save_collections_to_file(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    file_path: &str,
    collections: &[SaveCollectionConfig],
    data: &IndexMap<String, IndexMap<String, Value>>,
) -> Result<(), EngineError> {
    let ext = resolve_extension(file_path, None)?;
    let mut root = Map::new();
    for collection in collections {
        let records = data.get(&collection.name).cloned().unwrap_or_default();
        let mut section = Map::new();
        if let Some(version) = collection.version {
            section.insert("_version".to_owned(), Value::Number(version.into()));
        }
        for (id, value) in records {
            section.insert(
                id.clone(),
                encode_value(
                    &collection.schema,
                    &strip_derived_id_field(&value, &collection.id_strategy),
                    &id,
                )?,
            );
        }
        root.insert(collection.name.clone(), Value::Object(section));
    }
    let content = formats
        .serialize(&Value::Object(root), &ext, Some(FormatOptions::default()))
        .map_err(format_error)?;
    host.ensure_dir(file_path)?;
    host.write(file_path, &content)
}

pub fn save_collection_to_directory(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    dir_path: &str,
    extension: &str,
    collection: &SaveCollectionConfig,
    data: &IndexMap<String, Value>,
) -> Result<(), EngineError> {
    for (id, value) in data {
        let path = format!(
            "{}/{id}.{extension}",
            normalize_path(dir_path).trim_end_matches('/')
        );
        let encoded = encode_value(
            &collection.schema,
            &strip_derived_id_field(value, &collection.id_strategy),
            id,
        )?;
        let raw = formats
            .serialize(&encoded, extension, Some(FormatOptions::default()))
            .map_err(format_error)?;
        host.ensure_dir(&path)?;
        host.write(&path, &raw)?;
    }
    if let Some(version) = collection.version {
        write_directory_version_metadata(host, formats, dir_path, extension, version)?;
    }
    Ok(())
}

pub fn load_collection_from_directory(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    dir_path: &str,
    extension: &str,
    collection: &LoadCollectionConfig,
    migration_host: Option<&dyn MigrationHost>,
) -> Result<IndexMap<String, Value>, EngineError> {
    let mut output = IndexMap::new();
    let metadata_path = directory_version_metadata_path(dir_path, extension);
    let file_version =
        read_directory_version_metadata(host, formats, dir_path, extension)?.unwrap_or(0);
    let mut migrated_target_version = None;

    if let Some(target_version) = collection.version {
        if file_version > target_version {
            return Err(EngineError::Migration(Box::new(MigrationError {
                collection: collection.name.clone(),
                from_version: target_version,
                to_version: file_version,
                step: -1,
                reason: "version-ahead".to_owned(),
                message: format!(
                    "File version {file_version} is ahead of config version {target_version}. Cannot load data from a future version."
                ),
            })));
        }
        if file_version < target_version {
            validate_migration_registry(&collection.name, target_version, &collection.migrations)?;
            if !collection.migrations.is_empty() {
                migrated_target_version = Some(target_version);
            }
        }
    }

    #[derive(Debug)]
    struct PendingWrite {
        source_path: String,
        target_path: String,
        raw: String,
    }

    let record_paths = host
        .list_recursive(dir_path)?
        .into_iter()
        .filter(|path| {
            path != &metadata_path
                && get_file_extension(path) == extension
                && !is_version_sidecar_path(path, extension)
        })
        .collect::<Vec<_>>();
    let existing_paths = record_paths.iter().cloned().collect::<HashSet<_>>();
    let normalized_dir = normalize_path(dir_path);
    let dir_prefix = normalized_dir.trim_end_matches('/');
    let mut pending_writes = Vec::new();
    let mut pending_removes = HashSet::new();

    for path in record_paths {
        let raw = host.read(&path)?;
        let parsed = formats.deserialize(&raw, extension).map_err(format_error)?;
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned();
        let mut entity_map = Map::from_iter([(stem.clone(), parsed)]);
        if let Some(target_version) = migrated_target_version {
            entity_map = run_migrations(
                entity_map,
                file_version,
                target_version,
                &collection.migrations,
                &collection.name,
                migration_host,
            )?;
        }
        let decoded = decode_entity_map(
            &path,
            &collection.schema,
            &collection.id_strategy,
            entity_map,
            ValidationMode::Strict,
        )
        .map_err(|error| {
            if let Some(target_version) = migrated_target_version {
                post_migration_validation_error(
                    &collection.name,
                    file_version,
                    target_version,
                    error.to_string(),
                )
            } else {
                error
            }
        })?;

        if migrated_target_version.is_some() {
            if !decoded.contains_key(&stem) {
                pending_removes.insert(path.clone());
            }
            for (encoded_id, value) in &decoded {
                let encoded = encode_value(
                    &collection.schema,
                    &strip_derived_id_field(value, &collection.id_strategy),
                    encoded_id,
                )?;
                let raw = formats
                    .serialize(&encoded, extension, Some(FormatOptions::default()))
                    .map_err(format_error)?;
                let target_path = format!("{dir_prefix}/{encoded_id}.{extension}");
                pending_writes.push(PendingWrite {
                    source_path: path.clone(),
                    target_path,
                    raw,
                });
            }
        }

        for (id, value) in decoded {
            output.insert(id, value);
        }
    }

    if let Some(target_version) = migrated_target_version {
        let mut seen_targets: HashMap<String, String> = HashMap::new();
        for write in &pending_writes {
            if write.target_path == metadata_path
                || is_version_sidecar_path(&write.target_path, extension)
            {
                return Err(EngineError::Storage(Box::new(StorageError {
                    path: write.target_path.clone(),
                    operation: StorageOperation::Write,
                    message: format!(
                        "Directory migration output collision: '{}' is reserved for version metadata",
                        write.target_path
                    ),
                    cause: None,
                })));
            }
            if let Some(first_source) =
                seen_targets.insert(write.target_path.clone(), write.source_path.clone())
            {
                return Err(EngineError::Storage(Box::new(StorageError {
                    path: write.target_path.clone(),
                    operation: StorageOperation::Write,
                    message: format!(
                        "Directory migration output collision at '{}': both '{}' and '{}' produce this path",
                        write.target_path, first_source, write.source_path
                    ),
                    cause: None,
                })));
            }
        }

        for write in &pending_writes {
            if existing_paths.contains(&write.target_path)
                && !pending_removes.contains(&write.target_path)
                && write.source_path != write.target_path
            {
                return Err(EngineError::Storage(Box::new(StorageError {
                    path: write.target_path.clone(),
                    operation: StorageOperation::Write,
                    message: format!(
                        "Directory migration output collision at '{}': an existing record would survive alongside migrated output from '{}'",
                        write.target_path, write.source_path
                    ),
                    cause: None,
                })));
            }
        }

        for path in &pending_removes {
            host.remove(path)?;
        }
        for write in pending_writes {
            host.ensure_dir(&write.target_path)?;
            host.write(&write.target_path, &write.raw)?;
        }
        write_directory_version_metadata(host, formats, dir_path, extension, target_version)?;
    }
    Ok(output)
}

pub fn dry_run_migrations(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    inputs: &[DryRunInput],
) -> Result<DryRunResult, EngineError> {
    let mut collections = Vec::new();

    for input in inputs {
        match input {
            DryRunInput::SingleFile {
                file_path,
                collection,
            } => {
                let file_exists = host.exists(file_path)?;
                let file_version = if file_exists {
                    let ext = resolve_extension(file_path, None)?;
                    let parsed = formats
                        .deserialize(&host.read(file_path)?, &ext)
                        .map_err(format_error)?;
                    match parsed {
                        Value::Object(map) => {
                            map.get("_version").and_then(Value::as_u64).unwrap_or(0) as u32
                        }
                        _ => 0,
                    }
                } else {
                    0
                };
                collections.push(dry_run_collection(
                    file_path,
                    file_exists,
                    file_version,
                    collection,
                )?);
            }
            DryRunInput::Directory {
                dir_path,
                extension,
                collection,
            } => {
                let metadata_path = directory_version_metadata_path(dir_path, extension);
                let file_version =
                    read_directory_version_metadata(host, formats, dir_path, extension)?
                        .unwrap_or(0);
                let paths = host
                    .list_recursive(dir_path)?
                    .into_iter()
                    .filter(|path| {
                        path != &metadata_path
                            && get_file_extension(path) == extension.as_str()
                            && !is_version_sidecar_path(path, extension)
                    })
                    .collect::<Vec<_>>();
                if paths.is_empty() {
                    collections.push(dry_run_collection(
                        &format!("{}/<{}>", normalize_path(dir_path), extension),
                        false,
                        file_version,
                        collection,
                    )?);
                } else {
                    for path in paths {
                        collections.push(dry_run_collection(
                            &path,
                            true,
                            file_version,
                            collection,
                        )?);
                    }
                }
            }
            DryRunInput::MultiCollectionFile {
                file_path,
                collections: input_collections,
            } => {
                let ext = resolve_extension(file_path, None)?;
                let file_exists = host.exists(file_path)?;
                let root = if file_exists {
                    match formats
                        .deserialize(&host.read(file_path)?, &ext)
                        .map_err(format_error)?
                    {
                        Value::Object(map) => map,
                        _ => Map::new(),
                    }
                } else {
                    Map::new()
                };
                for collection in input_collections {
                    let file_version = root
                        .get(&collection.name)
                        .and_then(Value::as_object)
                        .and_then(|map| map.get("_version"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    collections.push(dry_run_collection(
                        file_path,
                        file_exists,
                        file_version,
                        collection,
                    )?);
                }
            }
        }
    }

    Ok(DryRunResult { collections })
}
