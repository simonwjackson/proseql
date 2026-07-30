//! Config descriptor model for the proseQL engine.
//!
//! A `DatabaseDescriptor` is the Rust-side representation of a proseQL database
//! configuration. It covers exactly the Effect Schema subset that consumers
//! actually use (audited against `packages/core/tests/` and `examples/`):
//!
//!   `Struct`, `String`, `Number`, `Boolean`, `Array`, `optional`,
//!   `optionalWith { default }`, `NullOr`, `NumberFromString`, `Record`,
//!   `mutable`, `Unknown`
//!
//! Unsupported combinators are represented as [`SchemaNode::Unsupported`] so
//! the engine fails loudly at descriptor-build time with a clear message.
//!
//! # Relationship to TS `CollectionConfig`
//!
//! The TS `CollectionConfig` (see `packages/core/src/types/database-config-types.ts`)
//! includes inline persistence fields — `file`, `directory`, `format`, and `path` —
//! that describe WHERE a collection's data lives.  **These fields are NOT part of
//! [`CollectionDescriptor`].**  The boundary compiler (U8, `packages/engine/src/`)
//! normalises them into [`SourceDescriptor`] entries before building the descriptor.
//! Native Rust consumers (korrid) configure storage via the storage-host trait and
//! `SourceDescriptor`s directly.  This keeps the engine descriptor storage-agnostic.
//!
//! Relationship: the TS `types/database-config-types.ts` is the semantic spec.
//! The Rust field names are the snake_case equivalents of the TS camelCase fields.

use serde::{Deserialize, Serialize};

// ── Schema node ───────────────────────────────────────────────────────────────

/// One field inside a [`SchemaNode::Struct`].
#[derive(Debug, Clone, PartialEq)]
pub struct StructField {
    pub name: String,
    pub schema: SchemaNode,
}

/// Descriptor for an Effect Schema combinator.
///
/// Covers the subset audited from all examples/ and packages/core/tests/:
///
/// | Variant              | TS combinator                                         |
/// |----------------------|-------------------------------------------------------|
/// | `Str`                | `Schema.String`                                       |
/// | `Num`                | `Schema.Number`                                       |
/// | `Bool`               | `Schema.Boolean`                                      |
/// | `NumFromStr`         | `Schema.NumberFromString`                             |
/// | `Unknown`            | `Schema.Unknown`                                      |
/// | `Struct`             | `Schema.Struct({ ... })`                              |
/// | `Array`              | `Schema.Array(T)`                                     |
/// | `Optional`           | `Schema.optional(T)` — field may be absent/undefined  |
/// | `OptionalWithDefault`| `Schema.optional(T, { default: () => V })` — field may be absent; engine invokes `default_callback_id` when absent |
/// | `NullOr`             | `Schema.NullOr(T)` — value is `T` or JSON `null`      |
/// | `Record`             | `Schema.Record(K, V)`                                 |
/// | `Unsupported`        | any combinator outside the above set                  |
///
/// ## Optional vs NullOr — Effect semantics
///
/// Effect's `optional(T)` expands to `T | undefined` (see `Schema.ts` line ~2542):
/// ```ts
/// export const optional = <S extends Schema.All>(self: S): optional<S> => {
///   const ast = ... : UndefinedOr(self).ast
///   ...
/// }
/// ```
/// JSON has no `undefined`; absent fields represent `undefined`.  A field
/// explicitly set to JSON `null` is **NOT** the same as absent — the engine
/// rejects `null` for `Optional(T)` unless `T` is itself `NullOr(...)`.
/// Use `Optional(NullOr(T))` when a field may be absent, null, or T.
///
/// ## OptionalWithDefault callback seam
///
/// `Schema.optional(T, { default: () => V })` (a.k.a. `Schema.optionalWith`)
/// registers a default-producing function.  The descriptor captures this as a
/// named callback id (`default_callback_id`) rather than a serialized value,
/// because defaults are often closures that reference runtime state.
///
/// At U1 the engine models the seam without invoking it — that is U2's job.
/// The boundary compiler (U8) fills in the id by registering the JS function
/// in the callback table and assigning a stable name.  Native Rust consumers
/// (korrid) provide a `Box<dyn Fn() -> Value>` closure registered under the
/// same id.
///
/// ## `mutable`
///
/// `Schema.mutable(T)` is a TS compile-time attribute with no runtime effect,
/// so it is not a distinct variant here — the underlying schema node is used
/// directly.
///
/// ## Serialization
///
/// `Serialize`/`Deserialize` are implemented manually to avoid the combinatorial
/// type-inference explosion that `#[serde(tag)]` triggers on recursive enum types.
/// The wire format uses a `{"kind": "...", ...}` flat object.
#[derive(Debug, Clone, PartialEq)]
pub enum SchemaNode {
    /// `Schema.String` — string-typed field.
    Str,
    /// `Schema.Number` — number-typed field (JS f64 semantics).
    Num,
    /// `Schema.Boolean` — boolean-typed field.
    Bool,
    /// `Schema.NumberFromString` — encodes as a string, decodes as a number.
    NumFromStr,
    /// `Schema.Unknown` — accepts any value without validation.
    Unknown,
    /// `Schema.Struct({ field: SchemaNode, … })`.
    Struct { fields: Vec<StructField> },
    /// `Schema.Array(T)` — homogeneous array.
    Array { item: Box<SchemaNode> },
    /// `Schema.optional(T)` — the field may be absent or `undefined`.
    ///
    /// When present inside a `Struct`, the enclosing field may be missing from
    /// the object entirely.  JSON `null` is **not** equivalent to absent for
    /// this variant — the engine rejects null unless the inner schema
    /// explicitly includes it via [`SchemaNode::NullOr`].
    Optional(Box<SchemaNode>),
    /// `Schema.optional(T, { default: () => V })` / `Schema.optionalWith(T, { default })`.
    ///
    /// Like [`SchemaNode::Optional`] for presence rules (the field may be absent),
    /// but when absent the engine invokes the named callback to produce the default
    /// value.  At U1 the seam is modelled; callback invocation is implemented in U2.
    ///
    /// `default_callback_id` is a stable string identifier registered in the
    /// callback table by the boundary compiler (U8) for JS callbacks, or by the
    /// native consumer (korrid) for Rust closures.
    OptionalWithDefault {
        inner: Box<SchemaNode>,
        default_callback_id: String,
    },
    /// `Schema.NullOr(T)` — value is `T` or JSON `null`.
    NullOr(Box<SchemaNode>),
    /// `Schema.Record(K, V)` — a map from keys to homogeneously-typed values.
    Record {
        key: Box<SchemaNode>,
        value: Box<SchemaNode>,
    },
    /// A combinator outside the audited subset.
    ///
    /// The engine fails loudly at descriptor-validation time when it encounters
    /// this variant.  `reason` carries a human-readable description of which
    /// combinator was used so the caller knows what to replace.
    Unsupported { reason: String },
}

// Manual serde impls for SchemaNode (and the dependent StructField) to avoid
// the compile-time type-inference explosion that recursive #[serde(tag)] derive
// triggers in rustc/serde-derive.

impl Serialize for StructField {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("name", &self.name)?;
        m.serialize_entry("schema", &self.schema)?;
        m.end()
    }
}

impl<'de> Deserialize<'de> for StructField {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        let obj = v
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("StructField must be an object"))?;
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::custom("StructField missing 'name'"))?
            .to_string();
        let schema_val = obj
            .get("schema")
            .ok_or_else(|| serde::de::Error::custom("StructField missing 'schema'"))?;
        let schema = SchemaNode::from_json(schema_val).map_err(serde::de::Error::custom)?;
        Ok(StructField { name, schema })
    }
}

impl Serialize for SchemaNode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

impl<'de> Deserialize<'de> for SchemaNode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        SchemaNode::from_json(&v).map_err(serde::de::Error::custom)
    }
}

impl SchemaNode {
    /// Convert to a flat `serde_json::Value` with `{"kind": "...", ...}` shape.
    pub fn to_json(&self) -> serde_json::Value {
        #[allow(unused_imports)]
        use serde_json::{json, Value};
        match self {
            SchemaNode::Str => json!({"kind": "str"}),
            SchemaNode::Num => json!({"kind": "num"}),
            SchemaNode::Bool => json!({"kind": "bool"}),
            SchemaNode::NumFromStr => json!({"kind": "numFromStr"}),
            SchemaNode::Unknown => json!({"kind": "unknown"}),
            SchemaNode::Struct { fields } => {
                let fields_json: Vec<Value> = fields
                    .iter()
                    .map(|f| json!({"name": f.name, "schema": f.schema.to_json()}))
                    .collect();
                json!({"kind": "struct", "fields": fields_json})
            }
            SchemaNode::Array { item } => {
                json!({"kind": "array", "item": item.to_json()})
            }
            SchemaNode::Optional(inner) => {
                json!({"kind": "optional", "inner": inner.to_json()})
            }
            SchemaNode::OptionalWithDefault {
                inner,
                default_callback_id,
            } => {
                json!({
                    "kind": "optionalWithDefault",
                    "inner": inner.to_json(),
                    "defaultCallbackId": default_callback_id
                })
            }
            SchemaNode::NullOr(inner) => {
                json!({"kind": "nullOr", "inner": inner.to_json()})
            }
            SchemaNode::Record { key, value } => {
                json!({"kind": "record", "key": key.to_json(), "value": value.to_json()})
            }
            SchemaNode::Unsupported { reason } => {
                json!({"kind": "unsupported", "reason": reason})
            }
        }
    }

    /// Reconstruct from a `{"kind": "...", ...}` `serde_json::Value`.
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        let obj = v
            .as_object()
            .ok_or_else(|| format!("SchemaNode must be an object, got: {v}"))?;
        let kind = obj
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or_else(|| "SchemaNode missing 'kind' field".to_string())?;
        match kind {
            "str" => Ok(SchemaNode::Str),
            "num" => Ok(SchemaNode::Num),
            "bool" => Ok(SchemaNode::Bool),
            "numFromStr" => Ok(SchemaNode::NumFromStr),
            "unknown" => Ok(SchemaNode::Unknown),
            "struct" => {
                let fields_val = obj
                    .get("fields")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "struct SchemaNode missing 'fields' array".to_string())?;
                let fields = fields_val
                    .iter()
                    .map(|f| {
                        let fobj = f
                            .as_object()
                            .ok_or_else(|| format!("StructField must be object, got: {f}"))?;
                        let name = fobj
                            .get("name")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| "StructField missing 'name'".to_string())?;
                        let schema_val = fobj
                            .get("schema")
                            .ok_or_else(|| "StructField missing 'schema'".to_string())?;
                        let schema = SchemaNode::from_json(schema_val)?;
                        Ok(StructField {
                            name: name.to_string(),
                            schema,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(SchemaNode::Struct { fields })
            }
            "array" => {
                let item_val = obj
                    .get("item")
                    .ok_or_else(|| "array SchemaNode missing 'item'".to_string())?;
                Ok(SchemaNode::Array {
                    item: Box::new(SchemaNode::from_json(item_val)?),
                })
            }
            "optional" => {
                let inner_val = obj
                    .get("inner")
                    .ok_or_else(|| "optional SchemaNode missing 'inner'".to_string())?;
                Ok(SchemaNode::Optional(Box::new(SchemaNode::from_json(
                    inner_val,
                )?)))
            }
            "optionalWithDefault" => {
                let inner_val = obj
                    .get("inner")
                    .ok_or_else(|| "optionalWithDefault SchemaNode missing 'inner'".to_string())?;
                let default_callback_id = obj
                    .get("defaultCallbackId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "optionalWithDefault SchemaNode missing 'defaultCallbackId'".to_string()
                    })?
                    .to_string();
                Ok(SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::from_json(inner_val)?),
                    default_callback_id,
                })
            }
            "nullOr" => {
                let inner_val = obj
                    .get("inner")
                    .ok_or_else(|| "nullOr SchemaNode missing 'inner'".to_string())?;
                Ok(SchemaNode::NullOr(Box::new(SchemaNode::from_json(
                    inner_val,
                )?)))
            }
            "record" => {
                let key_val = obj
                    .get("key")
                    .ok_or_else(|| "record SchemaNode missing 'key'".to_string())?;
                let value_val = obj
                    .get("value")
                    .ok_or_else(|| "record SchemaNode missing 'value'".to_string())?;
                Ok(SchemaNode::Record {
                    key: Box::new(SchemaNode::from_json(key_val)?),
                    value: Box::new(SchemaNode::from_json(value_val)?),
                })
            }
            "unsupported" => {
                let reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "unsupported SchemaNode missing 'reason'".to_string())?;
                Ok(SchemaNode::Unsupported {
                    reason: reason.to_string(),
                })
            }
            other => Err(format!("Unknown SchemaNode kind: {other:?}")),
        }
    }
}

// ── Id strategy ───────────────────────────────────────────────────────────────

/// How the engine derives the `id` field for entities in a collection.
///
/// Mirrors `DerivedIdConfig` and the `idGenerator` field from
/// `packages/core/src/types/database-config-types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IdStrategy {
    /// `id` is supplied by the caller or auto-generated (UUIDv4) if absent.
    /// This is the default when no explicit id config is present.
    Provided,
    /// `{ kind: "derivedFromKey", field: "id" }` — the entity's `id` is the
    /// storage key; the persisted payload omits the `id` field.
    DerivedFromKey,
    /// `idGenerator: "<name>"` — a named plugin generator produces the id.
    NamedGenerator { name: String },
}

// ── Relationship ──────────────────────────────────────────────────────────────

/// Kind of relationship, matching the TS `type: "ref" | "inverse"` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationshipKind {
    /// `type: "ref"` — foreign key lives on this collection.
    Ref,
    /// `type: "inverse"` — foreign key lives on the target collection.
    Inverse,
}

/// Descriptor for one relationship definition on a collection.
///
/// Mirrors the per-relationship shape in `CollectionConfig.relationships`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelationshipDescriptor {
    pub kind: RelationshipKind,
    /// The name of the target collection (string, resolved by the engine).
    pub target: String,
    /// Optional foreign-key field override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign_key: Option<String>,
}

// ── Computed field descriptor ────────────────────────────────────────────────

/// Descriptor for one computed field.
///
/// Mirrors one entry in `CollectionConfig.computed: ComputedFieldsConfig<T>`,
/// where the key is the field name and the value is the derivation function.
///
/// The engine strips `name` from persisted data before validation; the host
/// provides the implementation under `callback_id` in the `CallbackRegistry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputedFieldDescriptor {
    /// The field name that appears in query results but is never persisted.
    pub name: String,
    /// Stable id of the host callback that derives the value.
    pub callback_id: String,
}

// ── Index & unique constraints ────────────────────────────────────────────────

/// Descriptor for one index entry.  Mirrors the `indexes` array items in `CollectionConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum IndexDescriptor {
    Single(String),
    Compound(Vec<String>),
}

/// Descriptor for one unique-constraint entry.  Mirrors `uniqueFields` items.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UniqueConstraintDescriptor {
    Single(String),
    Compound(Vec<String>),
}

// ── Validation mode ───────────────────────────────────────────────────────────

/// Mirrors `CollectionConfig.validation: "strict" | "lenient"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ValidationMode {
    /// Abort on the first entity that fails schema validation (default).
    #[default]
    Strict,
    /// Skip invalid entities with warnings; load remaining valid data.
    Lenient,
}

// ── Migration descriptor ──────────────────────────────────────────────────────

/// Descriptor for one migration step.
///
/// The `callback_id` names a host callback registered in the descriptor: a Rust
/// closure natively, or a JS function over the WASM boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MigrationDescriptor {
    pub from: u32,
    pub to: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Host callback id for the transform function.
    pub callback_id: String,
}

// ── Source descriptors ────────────────────────────────────────────────────────

/// Mirrors `UnknownCollectionPolicy` from `packages/core/src/storage/source-config.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnknownCollectionPolicy {
    Error,
    Preserve,
}

/// Mirrors `DocumentGraphFragmentErrorPolicy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FragmentErrorPolicy {
    Error,
    SkipFragment,
    SkipRoot,
}

/// Descriptor for a `documents` source (multi-file merge).
///
/// Mirrors `NormalizedDocumentSourceConfig` from
/// `packages/core/src/storage/source-config.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentSourceDescriptor {
    pub id: String,
    pub root: String,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub format: String,
    /// Explicit collection names this source backs ("all" is expanded by the normalizer).
    pub collections: Vec<String>,
    pub unknown_collections: UnknownCollectionPolicy,
    pub outbox: String,
    pub optional: bool,
}

/// Descriptor for one root inside a `documentGraph` source.
///
/// Mirrors `NormalizedDocumentGraphRootConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentGraphRootDescriptor {
    pub id: String,
    pub root: String,
    pub optional: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub collections: Vec<String>,
}

/// Descriptor for a `documentGraph` source.
///
/// Mirrors `NormalizedDocumentGraphSourceConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentGraphSourceDescriptor {
    pub id: String,
    pub roots: Vec<DocumentGraphRootDescriptor>,
    pub collections: Vec<String>,
    pub on_fragment_error: FragmentErrorPolicy,
    /// Optional host callback id for the transform function.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform_callback_id: Option<String>,
}

/// Unified source descriptor.  New source kinds are added here as the engine
/// gains support for them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceDescriptor {
    Documents(DocumentSourceDescriptor),
    DocumentGraph(DocumentGraphSourceDescriptor),
}

// ── Collection descriptor ─────────────────────────────────────────────────────

/// Full descriptor for one collection.
///
/// Mirrors `CollectionConfig` from
/// `packages/core/src/types/database-config-types.ts` with all fields that have
/// runtime behaviour.  Compile-time-only fields (generic type parameters, etc.)
/// are omitted — they live in the preserved TS type layer.
///
/// # Legacy persistence fields not present here
///
/// The TS `CollectionConfig` has `file`, `directory`, `format`, and `path`
/// fields for inline per-collection persistence configuration.  These are NOT
/// part of `CollectionDescriptor`.  The boundary compiler (U8) normalises them
/// into [`SourceDescriptor`] entries during descriptor construction.  Native
/// Rust consumers (korrid) configure storage via the storage-host trait and
/// top-level `SourceDescriptor`s rather than per-collection inline paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionDescriptor {
    pub name: String,
    pub schema: SchemaNode,
    pub id_strategy: IdStrategy,
    /// Map of relationship name → descriptor.
    pub relationships: Vec<(String, RelationshipDescriptor)>,
    pub indexes: Vec<IndexDescriptor>,
    pub unique_fields: Vec<UniqueConstraintDescriptor>,
    // Hook callback ids (empty vec = no hooks for that lifecycle point)
    pub before_create_hooks: Vec<String>,
    pub after_create_hooks: Vec<String>,
    pub before_update_hooks: Vec<String>,
    pub after_update_hooks: Vec<String>,
    pub before_delete_hooks: Vec<String>,
    pub after_delete_hooks: Vec<String>,
    pub on_change_hooks: Vec<String>,
    /// Computed field definitions: (field name, callback id) pairs.
    ///
    /// Each entry maps a field name that is stripped from create/update inputs
    /// to a callback id that the host registers (for on-demand value derivation
    /// in U3's query pipeline).  The engine strips the field names listed here
    /// from persisted data; the query layer calls the callbacks to derive values
    /// at read time.
    ///
    /// Mirrors `CollectionConfig.computed: ComputedFieldsConfig<T>` from
    /// `packages/core/src/types/computed-types.ts`.
    pub computed_fields: Vec<ComputedFieldDescriptor>,
    /// Fields included in the full-text search index.
    pub search_index: Vec<String>,
    /// Optional named id generator (references a plugin registration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_generator: Option<String>,
    /// Schema version for migration participation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// Ordered chain of migration steps.
    pub migrations: Vec<MigrationDescriptor>,
    pub append_only: bool,
    pub validation_mode: ValidationMode,
}

// ── Database descriptor ───────────────────────────────────────────────────────

/// Top-level descriptor for an entire proseQL database configuration.
///
/// Produced by the JS binding's Schema→descriptor compiler (U8) or constructed
/// directly by native Rust consumers (korrid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatabaseDescriptor {
    pub collections: Vec<CollectionDescriptor>,
    pub sources: Vec<SourceDescriptor>,
}
