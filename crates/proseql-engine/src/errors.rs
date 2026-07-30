//! Full error taxonomy for the proseQL engine.
//!
//! Every struct here mirrors one TS `Data.TaggedError` class exported from
//! `packages/core/src/errors/`.  Field names use Rust snake_case internally;
//! `#[serde(rename_all = "camelCase")]` on every struct makes the serialized
//! JSON use camelCase to match the TS field names exactly.
//!
//! Rules for maintaining this file:
//! - Each variant's payload must carry the same semantic fields as the TS class.
//! - [`EngineError::tag()`] must return the exact string of the TS `_tag` field.
//! - The `#[serde(rename = "...")]` on each EngineError variant must also match
//!   the TS `_tag` exactly, so serde round-trips produce identical JSON.
//! - `cause` fields use `Option<serde_json::Value>` (not `Option<String>`) so
//!   structured error payloads survive the boundary without string coercion.
//! - Do not add variants that have no TS counterpart — stay single-sourced.

use serde::{Deserialize, Serialize};
use serde_json::Map as JsonMap;

// ── CRUD errors ───────────────────────────────────────────────────────────────

/// Mirrors `NotFoundError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotFoundError {
    pub collection: String,
    pub id: String,
    pub message: String,
}

/// Mirrors `DuplicateKeyError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateKeyError {
    pub collection: String,
    pub field: String,
    pub value: String,
    /// Serializes as `existingId` to match the TS camelCase field.
    pub existing_id: String,
    pub message: String,
}

/// Mirrors `ForeignKeyError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyError {
    pub collection: String,
    pub field: String,
    pub value: String,
    /// Serializes as `targetCollection` to match the TS camelCase field.
    pub target_collection: String,
    pub message: String,
}

/// A single validation issue, matching the TS `ValidationError.issues` element shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub field: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<String>,
}

/// Mirrors `ValidationError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub message: String,
    pub issues: Vec<ValidationIssue>,
}

/// Mirrors `UniqueConstraintError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueConstraintError {
    pub collection: String,
    pub constraint: String,
    pub fields: Vec<String>,
    /// `values: Record<string, unknown>` in TS.
    pub values: JsonMap<String, serde_json::Value>,
    /// Serializes as `existingId` to match the TS camelCase field.
    pub existing_id: String,
    pub message: String,
}

/// Mirrors `ConcurrencyError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcurrencyError {
    pub collection: String,
    pub id: String,
    pub message: String,
}

/// Mirrors `OperationError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub operation: String,
    pub reason: String,
    pub message: String,
}

/// The discriminant for `TransactionError.operation`, matching the TS literal union
/// `"begin" | "commit" | "rollback"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransactionOperation {
    Begin,
    Commit,
    Rollback,
}

/// Mirrors `TransactionError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionError {
    pub operation: TransactionOperation,
    pub reason: String,
    pub message: String,
}

/// The discriminant for `HookError.operation`, matching the TS literal union
/// `"create" | "update" | "delete"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookOperation {
    Create,
    Update,
    Delete,
}

/// Mirrors `HookError` from `packages/core/src/errors/crud-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookError {
    pub hook: String,
    pub collection: String,
    pub operation: HookOperation,
    pub reason: String,
    pub message: String,
}

// ── Query errors ──────────────────────────────────────────────────────────────

/// Mirrors `DanglingReferenceError` from `packages/core/src/errors/query-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DanglingReferenceError {
    pub collection: String,
    pub field: String,
    /// Serializes as `targetId` to match the TS camelCase field.
    pub target_id: String,
    pub message: String,
}

/// Mirrors `CollectionNotFoundError` from `packages/core/src/errors/query-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionNotFoundError {
    pub collection: String,
    pub message: String,
}

/// Mirrors `PopulationError` from `packages/core/src/errors/query-errors.ts`.
///
/// `cause` is `Option<serde_json::Value>` — mirrors TS `cause?: unknown`.
/// Using `Value` (not `String`) preserves structured error payloads without
/// string coercion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationError {
    pub collection: String,
    pub relationship: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<serde_json::Value>,
}

// ── Storage errors ────────────────────────────────────────────────────────────

/// The discriminant for `StorageError.operation`, matching the TS literal union
/// `"read" | "write" | "watch" | "delete" | "list"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageOperation {
    Read,
    Write,
    Watch,
    Delete,
    List,
}

/// Mirrors `StorageError` from `packages/core/src/errors/storage-errors.ts`.
///
/// `cause` is `Option<serde_json::Value>` — mirrors TS `cause?: unknown`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageError {
    pub path: String,
    pub operation: StorageOperation,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<serde_json::Value>,
}

/// Mirrors `SerializationError` from `packages/core/src/errors/storage-errors.ts`.
///
/// `cause` is `Option<serde_json::Value>` — mirrors TS `cause?: unknown`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializationError {
    pub format: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<serde_json::Value>,
}

/// Mirrors `UnsupportedFormatError` from `packages/core/src/errors/storage-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedFormatError {
    pub format: String,
    pub message: String,
}

// ── Source errors ─────────────────────────────────────────────────────────────

/// Mirrors `SourceConfigError` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfigError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Mirrors `UnknownCollectionError` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownCollectionError {
    pub source_id: String,
    pub path: String,
    pub collection: String,
    pub message: String,
}

/// Mirrors `SourceRecordOrigin` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecordOrigin {
    pub source_id: String,
    pub path: String,
    pub collection: String,
    pub id: String,
}

/// Mirrors `DuplicateRecordError` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateRecordError {
    pub collection: String,
    pub id: String,
    pub first: SourceRecordOrigin,
    pub duplicate: SourceRecordOrigin,
    pub message: String,
}

/// Mirrors `DuplicatePhysicalFileError` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePhysicalFileError {
    pub source_id: String,
    pub path: String,
    pub message: String,
}

/// Mirrors `InvalidDocumentSourceError` from `packages/core/src/errors/source-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidDocumentSourceError {
    pub source_id: String,
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Discriminant for `DocumentGraphSourceError.kind`, matching the TS literal union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentGraphErrorKind {
    MissingRoot,
    UnsupportedExtension,
    Deserialize,
    TransformFailure,
    TransformDefect,
    NonObject,
    UnknownCollection,
    Validation,
    Migration,
}

/// Mirrors `DocumentGraphSourceError` from `packages/core/src/errors/source-errors.ts`.
///
/// `cause` is `Option<serde_json::Value>` — mirrors TS `cause?: unknown`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGraphSourceError {
    pub source_id: String,
    pub path: String,
    pub message: String,
    pub kind: DocumentGraphErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    /// Serializes as `recordId` to match the TS camelCase field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    /// Serializes as `contributingPaths` to match the TS camelCase field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributing_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<serde_json::Value>,
}

// ── Migration errors ──────────────────────────────────────────────────────────

/// Mirrors `MigrationError` from `packages/core/src/errors/migration-errors.ts`.
///
/// The `step` field matches TS semantics:
/// - `step >= 0`: the transform at that index in the migration chain failed.
/// - `step == -1`: post-migration schema validation failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationError {
    pub collection: String,
    /// Serializes as `fromVersion` to match the TS camelCase field.
    pub from_version: u32,
    /// Serializes as `toVersion` to match the TS camelCase field.
    pub to_version: u32,
    pub step: i32,
    pub reason: String,
    pub message: String,
}

// ── Plugin errors ─────────────────────────────────────────────────────────────

/// Mirrors `PluginError` from `packages/core/src/errors/plugin-errors.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginError {
    pub plugin: String,
    pub reason: String,
    pub message: String,
}

// ── Master error enum ─────────────────────────────────────────────────────────

/// Unified error type for all engine operations.
///
/// # Wire format
///
/// Serializes to JSON with `_tag` matching the TS `Data.TaggedError` tag string
/// and camelCase payload fields.  Example:
///
/// ```json
/// {"_tag": "NotFoundError", "collection": "users", "id": "u1", "message": "..."}
/// ```
///
/// The adapter layer maps each variant to the corresponding TS TaggedError class
/// using the [`EngineError::tag()`] method.  Every tag must match the TS `_tag`
/// string exactly so `Effect.catchTag` works at the consumer side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum EngineError {
    // CRUD
    #[serde(rename = "NotFoundError")]
    NotFound(NotFoundError),
    #[serde(rename = "DuplicateKeyError")]
    DuplicateKey(DuplicateKeyError),
    #[serde(rename = "ForeignKeyError")]
    ForeignKey(ForeignKeyError),
    #[serde(rename = "ValidationError")]
    Validation(ValidationError),
    #[serde(rename = "UniqueConstraintError")]
    UniqueConstraint(Box<UniqueConstraintError>),
    #[serde(rename = "ConcurrencyError")]
    Concurrency(ConcurrencyError),
    #[serde(rename = "OperationError")]
    Operation(OperationError),
    #[serde(rename = "TransactionError")]
    Transaction(TransactionError),
    #[serde(rename = "HookError")]
    Hook(HookError),
    // Query
    #[serde(rename = "DanglingReferenceError")]
    DanglingReference(DanglingReferenceError),
    #[serde(rename = "CollectionNotFoundError")]
    CollectionNotFound(CollectionNotFoundError),
    #[serde(rename = "PopulationError")]
    Population(PopulationError),
    // Storage
    #[serde(rename = "StorageError")]
    Storage(StorageError),
    #[serde(rename = "SerializationError")]
    Serialization(SerializationError),
    #[serde(rename = "UnsupportedFormatError")]
    UnsupportedFormat(UnsupportedFormatError),
    // Source
    #[serde(rename = "SourceConfigError")]
    SourceConfig(SourceConfigError),
    #[serde(rename = "UnknownCollectionError")]
    UnknownCollection(UnknownCollectionError),
    #[serde(rename = "DuplicateRecordError")]
    DuplicateRecord(Box<DuplicateRecordError>),
    #[serde(rename = "DuplicatePhysicalFileError")]
    DuplicatePhysicalFile(DuplicatePhysicalFileError),
    #[serde(rename = "InvalidDocumentSourceError")]
    InvalidDocumentSource(InvalidDocumentSourceError),
    #[serde(rename = "DocumentGraphSourceError")]
    DocumentGraphSource(Box<DocumentGraphSourceError>),
    // Migration
    #[serde(rename = "MigrationError")]
    Migration(MigrationError),
    // Plugin
    #[serde(rename = "PluginError")]
    Plugin(PluginError),
}

impl EngineError {
    /// Returns the TS `_tag` string for this error variant.
    ///
    /// The adapter layer uses this to reconstruct the correct TaggedError class,
    /// enabling consumers to use `Effect.catchTag("NotFoundError", ...)`.
    ///
    /// The returned string must match both:
    /// 1. The TS `_tag` literal in `packages/core/src/errors/`.
    /// 2. The `#[serde(rename = "...")]` on the corresponding variant above,
    ///    so `tag()` and serde serialization stay in sync.
    pub fn tag(&self) -> &'static str {
        match self {
            EngineError::NotFound(_) => "NotFoundError",
            EngineError::DuplicateKey(_) => "DuplicateKeyError",
            EngineError::ForeignKey(_) => "ForeignKeyError",
            EngineError::Validation(_) => "ValidationError",
            EngineError::UniqueConstraint(_) => "UniqueConstraintError",
            EngineError::Concurrency(_) => "ConcurrencyError",
            EngineError::Operation(_) => "OperationError",
            EngineError::Transaction(_) => "TransactionError",
            EngineError::Hook(_) => "HookError",
            EngineError::DanglingReference(_) => "DanglingReferenceError",
            EngineError::CollectionNotFound(_) => "CollectionNotFoundError",
            EngineError::Population(_) => "PopulationError",
            EngineError::Storage(_) => "StorageError",
            EngineError::Serialization(_) => "SerializationError",
            EngineError::UnsupportedFormat(_) => "UnsupportedFormatError",
            EngineError::SourceConfig(_) => "SourceConfigError",
            EngineError::UnknownCollection(_) => "UnknownCollectionError",
            EngineError::DuplicateRecord(_) => "DuplicateRecordError",
            EngineError::DuplicatePhysicalFile(_) => "DuplicatePhysicalFileError",
            EngineError::InvalidDocumentSource(_) => "InvalidDocumentSourceError",
            EngineError::DocumentGraphSource(_) => "DocumentGraphSourceError",
            EngineError::Migration(_) => "MigrationError",
            EngineError::Plugin(_) => "PluginError",
        }
    }
}
