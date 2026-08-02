#![recursion_limit = "1024"]
#![allow(unused_imports)] // public types imported for API documentation, used via inference
//! U4 — Relationship conformance tests (RED: drives implementation).
//!
//! These tests express the full observable contract for U4's `relationships`
//! module.  They WILL NOT COMPILE until `proseql_engine::relationships` is
//! implemented — that is intentional: the file is the test-first specification
//! that turns GREEN when the module ships.
//!
//! # Planned API (targeted module: `proseql_engine::relationships`)
//!
//! ```text
//! Database::new(IndexMap<String, Collection>, Arc<CallbackRegistry>) -> Database
//! Database::collection(&str)                     -> Option<&Collection>
//! Database::create(&str, Value)                  -> Result<Value, EngineError>
//! Database::update(&str, &str, Value)            -> Result<Value, EngineError>
//! Database::delete(&str, &str)                   -> Result<Value, EngineError>
//! Database::query(&str, QueryInput, populate)    -> Result<Vec<Value>, EngineError>
//! Database::create_with_relationships(&str, Value) -> Result<Value, EngineError>
//! Database::update_with_relationships(&str, &str, Value) -> Result<Value, EngineError>
//! Database::delete_with_relationships(&str, &str, DeleteRelationshipsOptions)
//!     -> Result<DeleteWithRelResult, EngineError>
//! Database::delete_many_with_relationships(&str, &dyn Fn(&Value)->bool, DeleteRelationshipsOptions)
//!     -> Result<DeleteManyWithRelResult, EngineError>
//! ```
//!
//! # TS source references
//! - `packages/core/src/operations/relationships/populate.ts`
//! - `packages/core/src/operations/crud/create-with-relationships.ts`
//! - `packages/core/src/operations/crud/update-with-relationships.ts`
//! - `packages/core/src/operations/crud/delete-with-relationships.ts`
//! - `packages/core/tests/crud-create-with-relationships-effect.test.ts`
//! - `packages/core/tests/crud-delete-with-relationships-effect.test.ts`
//! - `packages/core/tests/crud-update-with-relationships-effect.test.ts`
//!
//! # Test sections
//!  1. FK validation on plain create
//!  2. Ref population (true / select / null FK / missing FK / dangling)
//!  3. Inverse population (true / empty / select / custom FK)
//!  4. Nested population (two levels, mixed ref+inverse)
//!  5. `create_with_relationships` — $connect, $create, $connectOrCreate (ref + inverse)
//!  6. `update_with_relationships` — $connect, $disconnect, $update, $delete, $set
//!  7. `delete_with_relationships` — preserve / restrict / cascade / set_null / cascade_soft
//!  8. `delete_many_with_relationships` — atomic restrict; cascade many

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{
        CollectionDescriptor, IdStrategy, IndexDescriptor, RelationshipDescriptor,
        RelationshipKind, SchemaNode, StructField, UniqueConstraintDescriptor, ValidationMode,
    },
    errors::EngineError,
    id_gen::SequentialGenerator,
    query::QueryInput,
    relationships::{
        CascadeOption, CascadedCollection, Database, DeleteManyWithRelResult,
        DeleteRelationshipsOptions, DeleteWithRelResult,
    },
};
use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// users: {id, name, email, companyId?, createdAt?, updatedAt?, deletedAt?}
///
/// Relationships (descriptor-level):
///   company — Ref → companies (FK: "companyId")
///   posts   — Inverse ← posts  (FK resolved: "authorId" on posts)
fn users_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "email".into(),
                schema: SchemaNode::Str,
            },
            // companyId is NullOr(Str) so set_null tests can write null
            StructField {
                name: "companyId".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "deletedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
        ],
    }
}

/// posts: {id, title, authorId?, createdAt?, updatedAt?}
///
/// Relationships:
///   author   — Ref → users    (FK: "authorId")
///   comments — Inverse ← comments (FK: "postId" on comments)
fn posts_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "title".into(),
                schema: SchemaNode::Str,
            },
            // authorId is NullOr — can be null (set_null cascade)
            StructField {
                name: "authorId".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            // deletedAt required for CascadeSoft tests
            StructField {
                name: "deletedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
        ],
    }
}

/// companies: {id, name, createdAt?, updatedAt?}
///
/// Relationships:
///   employees — Inverse ← users (FK: "companyId")
fn companies_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    }
}

/// comments: {id, content, postId, createdAt?, updatedAt?}
///
/// Relationships:
///   post — Ref → posts (FK: "postId")
fn comments_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "content".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "postId".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DESCRIPTOR BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

fn users_descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "users".into(),
        schema: users_schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![
            (
                "company".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Ref,
                    target: "companies".into(),
                    // FK field on users: "companyId"
                    foreign_key: Some("companyId".into()),
                },
            ),
            (
                "posts".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Inverse,
                    target: "posts".into(),
                    // FK is resolved from posts.author descriptor ("authorId")
                    foreign_key: None,
                },
            ),
        ],
        indexes: vec![],
        unique_fields: vec![UniqueConstraintDescriptor::Single("email".into())],
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
        validation_mode: ValidationMode::Strict,
    }
}

fn posts_descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "posts".into(),
        schema: posts_schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![
            (
                "author".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Ref,
                    target: "users".into(),
                    foreign_key: Some("authorId".into()),
                },
            ),
            (
                "comments".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Inverse,
                    target: "comments".into(),
                    // FK on comments: "postId"
                    foreign_key: None,
                },
            ),
        ],
        indexes: vec![IndexDescriptor::Single("authorId".into())],
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec!["title".into()],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: false,
        validation_mode: ValidationMode::Strict,
    }
}

fn companies_descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "companies".into(),
        schema: companies_schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![(
            "employees".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Inverse,
                target: "users".into(),
                // FK on users: "companyId"
                foreign_key: Some("companyId".into()),
            },
        )],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    }
}

fn comments_descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "comments".into(),
        schema: comments_schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![(
            "post".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Ref,
                target: "posts".into(),
                foreign_key: Some("postId".into()),
            },
        )],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE FIXTURE BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/// Build an empty Database with all four collections wired up.
///
/// Each collection gets its own `SequentialGenerator` so IDs are deterministic
/// and a `FixedClock` so timestamps are reproducible.
fn make_db() -> (Database, Arc<CallbackRegistry>) {
    let reg = Arc::new(CallbackRegistry::new());

    let users_col = Collection::new_with_clock(
        "users",
        users_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("u")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    let posts_col = Collection::new_with_clock(
        "posts",
        posts_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("p")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    let companies_col = Collection::new_with_clock(
        "companies",
        companies_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("c")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    let comments_col = Collection::new_with_clock(
        "comments",
        comments_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("cm")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );

    let mut collections = IndexMap::new();
    collections.insert("users".to_string(), users_col);
    collections.insert("posts".to_string(), posts_col);
    collections.insert("companies".to_string(), companies_col);
    collections.insert("comments".to_string(), comments_col);

    let db = Database::new(collections, Arc::clone(&reg));
    (db, reg)
}

/// Seed the standard fixture set and return the `Database`.
///
/// Fixture state:
/// - companies: comp1 (TechCorp), comp2 (DataInc)
/// - users: user1 (Alice, comp1), user2 (Bob, comp1), user3 (Charlie, comp2)
/// - posts: post1 (title="Alpha", authorId=user1),
///   post2 (title="Beta", authorId=user1), post3 (title="Gamma", authorId=user2)
/// - comments: cm1 (postId=post1), cm2 (postId=post1), cm3 (postId=post2)
fn seeded_db() -> Database {
    let (mut db, _reg) = make_db();

    // companies
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .expect("seed comp1");
    db.create("companies", json!({ "id": "comp2", "name": "DataInc" }))
        .expect("seed comp2");

    // users
    db.create(
        "users",
        json!({ "id": "user1", "name": "Alice", "email": "alice@example.com", "companyId": "comp1" }),
    )
    .expect("seed user1");
    db.create(
        "users",
        json!({ "id": "user2", "name": "Bob", "email": "bob@example.com", "companyId": "comp1" }),
    )
    .expect("seed user2");
    db.create(
        "users",
        json!({ "id": "user3", "name": "Charlie", "email": "charlie@example.com", "companyId": "comp2" }),
    )
    .expect("seed user3");

    // posts
    db.create(
        "posts",
        json!({ "id": "post1", "title": "Alpha", "authorId": "user1" }),
    )
    .expect("seed post1");
    db.create(
        "posts",
        json!({ "id": "post2", "title": "Beta", "authorId": "user1" }),
    )
    .expect("seed post2");
    db.create(
        "posts",
        json!({ "id": "post3", "title": "Gamma", "authorId": "user2" }),
    )
    .expect("seed post3");

    // comments
    db.create(
        "comments",
        json!({ "id": "cm1", "content": "First!", "postId": "post1" }),
    )
    .expect("seed cm1");
    db.create(
        "comments",
        json!({ "id": "cm2", "content": "Nice post", "postId": "post1" }),
    )
    .expect("seed cm2");
    db.create(
        "comments",
        json!({ "id": "cm3", "content": "Good read", "postId": "post2" }),
    )
    .expect("seed cm3");

    db
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — FK VALIDATION ON PLAIN CREATE
// Mirrors: packages/core/src/validators/foreign-key.ts
// TS ref:   crud-create-with-relationships-effect.test.ts — "ForeignKeyError"
// ═══════════════════════════════════════════════════════════════════════════

/// A post referencing a non-existent authorId must yield `ForeignKeyError`,
/// not a ValidationError — the FK check is a distinct semantic layer.
///
/// TS behaviour: `validateForeignKeysEffect` calls `Effect.fail(new ForeignKeyError(...))`
/// when the referenced id is absent from the target collection.
#[test]
fn fk_ref_nonexistent_target_is_foreign_key_error() {
    let mut db = seeded_db();

    let err = db
        .create(
            "posts",
            json!({ "id": "px", "title": "Orphan", "authorId": "nonexistent_user" }),
        )
        .expect_err("should fail FK check");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );

    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(fk.field, "authorId");
        assert_eq!(fk.value, "nonexistent_user");
        assert_eq!(fk.target_collection, "users");
        assert_eq!(fk.collection, "posts");
    }
}

/// A null FK value must NOT trigger a ForeignKeyError.
/// Null means "no relationship" and is explicitly allowed.
///
/// TS behaviour: `validateForeignKeysEffect` skips null values:
///   `if (value === null || value === undefined) continue;`
#[test]
fn fk_ref_null_value_is_not_validated() {
    let mut db = seeded_db();

    // authorId is NullOr(Str) so null is schema-valid; FK check must skip it
    let result = db.create(
        "posts",
        json!({ "id": "p-null", "title": "No Author", "authorId": null }),
    );

    assert!(result.is_ok(), "null FK should not fail: {result:?}");
    assert_eq!(result.unwrap()["authorId"], Value::Null);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — REF POPULATION
// Mirrors: packages/core/src/operations/relationships/populate.ts
// Key contract: ref FK field is replaced by the full target entity object.
// ═══════════════════════════════════════════════════════════════════════════

/// `populate: { author: true }` on a posts query replaces `authorId` with the
/// full user entity under the relationship name "author".
///
/// TS: `Object.assign(populated, { [key]: relatedItem })` when `value === true`.
#[test]
fn populate_ref_true_embeds_full_target_entity() {
    let db = seeded_db();

    let results = db
        .query(
            "posts",
            QueryInput::default(),
            Some(json!({ "author": true })),
        )
        .expect("query should succeed");

    let post1 = results.iter().find(|e| e["id"] == "post1").expect("post1");

    // populated field is present under the relationship name
    let author = post1.get("author").expect("author should be populated");
    assert_eq!(author["id"], "user1");
    assert_eq!(author["name"], "Alice");
    // original FK field may still be present (mirrors TS which keeps authorId in the raw obj)
}

/// Without a populate config, the raw FK field is returned unchanged.
///
/// TS: if no populateConfig, `populateRelationships` returns items unchanged.
#[test]
fn populate_ref_absent_when_not_requested() {
    let db = seeded_db();

    let results = db
        .query("posts", QueryInput::default(), None)
        .expect("query should succeed");

    let post1 = results.iter().find(|e| e["id"] == "post1").expect("post1");

    // "author" key must NOT appear — only the raw authorId FK
    assert!(
        post1.get("author").is_none(),
        "author should not be populated when populate is None"
    );
    assert_eq!(post1["authorId"], "user1");
}

/// When the FK is null, population assigns an explicit own `undefined`
/// relationship field — NOT a ForeignKeyError.
///
/// TS: `findRelatedItem` returns undefined → `Object.assign(populated, { [key]: undefined })`.
#[test]
fn populate_ref_null_fk_gives_explicit_undefined_populated_field() {
    let mut db = seeded_db();

    db.create(
        "posts",
        json!({ "id": "pnull", "title": "No Author", "authorId": null }),
    )
    .expect("create orphan post");

    let results = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "pnull" })),
                ..QueryInput::default()
            },
            Some(json!({ "author": true })),
        )
        .expect("query");

    let post = results.first().expect("one result");
    let author_field = post
        .get("author")
        .expect("Object.assign creates an own relationship field");
    assert!(
        proseql_engine::value::is_boundary_undefined(author_field),
        "expected boundary undefined, got: {author_field:?}"
    );
}

/// Population runs before the ordinary query selection stage, so selection can
/// project fields inside a populated entity.
///
/// TS: `applyPopulate(...).pipe(applySelect(...))` in the canonical stream path.
#[test]
fn populate_then_select_projects_named_fields() {
    let db = seeded_db();

    let results = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "post1" })),
                select: Some(json!({
                    "id": true,
                    "author": { "id": true, "name": true }
                })),
                ..QueryInput::default()
            },
            Some(json!({ "author": true })),
        )
        .expect("query");

    let post = results.first().expect("one result");
    let author = post.get("author").expect("author should be populated");

    assert_eq!(author["id"], "user1");
    assert_eq!(author["name"], "Alice");
    assert!(
        author.get("email").is_none(),
        "email should be projected out: {author}"
    );
    assert!(
        post.get("title").is_none(),
        "title should be projected out: {post}"
    );
}

/// A string FK whose target is missing fails the canonical query population path
/// with `DanglingReferenceError`; only null/non-string FKs are silently absent.
#[test]
fn populate_dangling_ref_is_dangling_reference_error() {
    let mut db = seeded_db();

    db.delete("users", "user1").expect("delete user1");

    let error = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "post1" })),
                ..QueryInput::default()
            },
            Some(json!({ "author": true })),
        )
        .expect_err("dangling string FK must fail population");

    match error {
        EngineError::DanglingReference(error) => {
            assert_eq!(error.collection, "users");
            assert_eq!(error.field, "authorId");
            assert_eq!(error.target_id, "user1");
            assert_eq!(
                error.message,
                "Entity in \"posts\" references missing \"users\" with authorId=\"user1\""
            );
        }
        other => panic!("expected DanglingReferenceError, got {other:?}"),
    }
}

#[test]
fn relation_local_populate_selection_is_ignored_like_typescript() {
    let db = seeded_db();
    for select in [json!(["id"]), json!({"id": true})] {
        let rows = db
            .query(
                "posts",
                QueryInput {
                    r#where: Some(json!({ "id": "post1" })),
                    ..QueryInput::default()
                },
                Some(json!({ "author": { "select": select } })),
            )
            .expect("relation-local selection query");
        assert_eq!(
            rows[0]["author"],
            json!({
                "id": "user1",
                "name": "Alice",
                "email": "alice@example.com",
                "companyId": "comp1",
                "createdAt": "2024-01-01T00:00:00.000Z",
                "updatedAt": "2024-01-01T00:00:00.000Z"
            })
        );
    }
}

#[test]
fn populate_with_empty_selection_keeps_populated_fields() {
    let db = seeded_db();
    for select in [json!([]), json!({})] {
        let rows = db
            .query(
                "posts",
                QueryInput {
                    r#where: Some(json!({ "id": "post1" })),
                    select: Some(select),
                    ..QueryInput::default()
                },
                Some(json!({ "author": true })),
            )
            .expect("empty selection means all fields");
        assert_eq!(rows[0]["author"]["id"], json!("user1"));
    }
}

#[test]
fn populate_validates_filtered_out_rows_before_query_pipeline() {
    let mut db = seeded_db();
    db.delete("users", "user1").expect("delete user1");

    let error = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "post3" })),
                ..QueryInput::default()
            },
            Some(json!({ "author": true })),
        )
        .expect_err("population must inspect dangling rows before filtering");

    assert!(matches!(error, EngineError::DanglingReference(_)));
}

#[test]
fn populated_fields_drive_where_sort_search_and_nested_dependencies() {
    let db = seeded_db();
    let populate = Some(json!({ "author": { "company": true } }));

    let filtered = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "author.company.name": "TechCorp" })),
                ..QueryInput::default()
            },
            populate.clone(),
        )
        .expect("nested populated where");
    assert_eq!(filtered.len(), 3);

    let sorted = db
        .query(
            "posts",
            QueryInput {
                sort: vec![(
                    "author.name".to_owned(),
                    proseql_engine::query::SortOrder::Desc,
                )],
                ..QueryInput::default()
            },
            populate.clone(),
        )
        .expect("populated sort");
    assert_eq!(sorted[0]["author"]["name"], json!("Bob"));

    let searched = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({
                    "$search": { "query": "Alice", "fields": ["author.name"] }
                })),
                ..QueryInput::default()
            },
            populate,
        )
        .expect("populated search");
    assert_eq!(
        searched
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["post1", "post2"]
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — INVERSE POPULATION
// Mirrors: populate.ts — `relationship.type === "inverse"` branch
// Key contract: FK lives on children; populate returns an array of children.
// ═══════════════════════════════════════════════════════════════════════════

/// `populate: { posts: true }` on a users query returns all posts whose
/// `authorId` matches the user's `id`.
///
/// TS: `findRelatedItems` finds all targets where `target[foreignKeyField] === item.id`.
#[test]
fn populate_inverse_returns_array_of_children() {
    let db = seeded_db();

    let results = db
        .query(
            "users",
            QueryInput {
                r#where: Some(json!({ "id": "user1" })),
                ..QueryInput::default()
            },
            Some(json!({ "posts": true })),
        )
        .expect("query");

    let user = results.first().expect("user1");
    let posts_field = user.get("posts").expect("posts should be populated");
    let posts_arr = posts_field.as_array().expect("posts should be an array");

    assert_eq!(posts_arr.len(), 2, "user1 has 2 posts (post1, post2)");
    let ids: Vec<&str> = posts_arr
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"post1"), "post1 should be in posts");
    assert!(ids.contains(&"post2"), "post2 should be in posts");
}

/// When no children exist, the inverse populate key must be an empty array `[]`.
///
/// TS: `findRelatedItems` returns `[]` when no targets match.
#[test]
fn populate_inverse_empty_array_when_no_children() {
    let mut db = seeded_db();

    // Create a company that has no employees
    db.create("companies", json!({ "id": "comp_empty", "name": "Acme" }))
        .expect("create company");

    let results = db
        .query(
            "companies",
            QueryInput {
                r#where: Some(json!({ "id": "comp_empty" })),
                ..QueryInput::default()
            },
            Some(json!({ "employees": true })),
        )
        .expect("query");

    let company = results.first().expect("company");
    let employees = company
        .get("employees")
        .expect("employees key should appear after populate");
    let arr = employees.as_array().expect("should be array");
    assert!(arr.is_empty(), "no employees → empty array");
}

/// When the `RelationshipDescriptor` on the *inverse* side specifies an explicit
/// `foreign_key`, that field name is used directly instead of inferring from the
/// reverse ref.
///
/// Setup: companies.employees → Inverse of users, FK explicitly "companyId".
#[test]
fn populate_inverse_explicit_foreign_key_used() {
    let db = seeded_db();

    let results = db
        .query(
            "companies",
            QueryInput {
                r#where: Some(json!({ "id": "comp1" })),
                ..QueryInput::default()
            },
            Some(json!({ "employees": true })),
        )
        .expect("query");

    let company = results.first().expect("comp1");
    let employees = company.get("employees").expect("employees populated");
    let arr = employees.as_array().expect("array");

    // user1 and user2 both have companyId="comp1"
    assert_eq!(arr.len(), 2);
    let names: Vec<&str> = arr.iter().map(|u| u["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"Alice"));
    assert!(names.contains(&"Bob"));
}

/// Ordinary query selection is applied after inverse population and projects
/// every object in the populated array.
#[test]
fn populate_inverse_then_select_projects_each_item() {
    let db = seeded_db();

    let results = db
        .query(
            "users",
            QueryInput {
                r#where: Some(json!({ "id": "user1" })),
                select: Some(json!({
                    "id": true,
                    "posts": { "id": true, "title": true }
                })),
                ..QueryInput::default()
            },
            Some(json!({ "posts": true })),
        )
        .expect("query");

    let user = results.first().expect("user1");
    let posts_arr = user["posts"].as_array().expect("posts array");

    for post in posts_arr {
        assert!(post.get("id").is_some(), "id must survive select");
        assert!(post.get("title").is_some(), "title must survive select");
        assert!(
            post.get("authorId").is_none(),
            "authorId was not selected: {post}"
        );
    }
}

#[test]
fn nested_population_selection_projects_inverse_arrays_and_omits_ids() {
    let db = seeded_db();
    let nested_employee_select = serde_json::Map::from_iter([
        ("posts".to_owned(), json!({ "title": true })),
        ("name".to_owned(), Value::Bool(true)),
    ]);
    let select = Value::Object(serde_json::Map::from_iter([
        (
            "employees".to_owned(),
            Value::Object(nested_employee_select),
        ),
        ("name".to_owned(), Value::Bool(true)),
    ]));
    let rows = db
        .query(
            "companies",
            QueryInput {
                r#where: Some(json!({ "id": "comp1" })),
                select: Some(select),
                ..QueryInput::default()
            },
            Some(json!({ "employees": { "posts": true } })),
        )
        .expect("nested population then selection");

    let company = rows.first().expect("company");
    assert_eq!(
        company.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["employees", "name"]
    );
    let employee = company["employees"].as_array().unwrap().first().unwrap();
    assert_eq!(employee.as_object().unwrap().len(), 2);
    assert!(employee.get("name").is_some());
    assert!(employee.get("posts").is_some());
    assert!(employee.get("id").is_none());
    for post in employee["posts"].as_array().unwrap() {
        assert_eq!(
            post.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["title"]
        );
        assert!(post.get("id").is_none());
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — NESTED POPULATION
// Mirrors: populate.ts — recursive `applyPopulate` calls
// ═══════════════════════════════════════════════════════════════════════════

/// Populate a post's author, and within that author populate their company.
/// Two levels of `ref` chained: posts → users → companies.
///
/// TS: `applyPopulate` is called recursively with `nestedPopulate`.
#[test]
fn populate_nested_ref_chain_two_levels() {
    let db = seeded_db();

    let results = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "post1" })),
                ..QueryInput::default()
            },
            // author: { company: true }  — nested populate
            Some(json!({ "author": { "company": true } })),
        )
        .expect("query");

    let post = results.first().expect("post1");
    let author = post.get("author").expect("author populated");
    assert_eq!(author["id"], "user1");

    let company = author
        .get("company")
        .expect("company should be nested-populated");
    assert_eq!(company["id"], "comp1");
    assert_eq!(company["name"], "TechCorp");
}

/// Populate a user's posts (inverse), and within each post populate comments
/// (inverse again): users → posts → comments — two levels of inverse.
///
/// TS: each item in the outer inverse array is recursively populated.
#[test]
fn populate_nested_inverse_then_inverse() {
    let db = seeded_db();

    let results = db
        .query(
            "users",
            QueryInput {
                r#where: Some(json!({ "id": "user1" })),
                ..QueryInput::default()
            },
            Some(json!({ "posts": { "comments": true } })),
        )
        .expect("query");

    let user = results.first().expect("user1");
    let posts_arr = user["posts"].as_array().expect("posts");

    let post1 = posts_arr
        .iter()
        .find(|p| p["id"] == "post1")
        .expect("post1");
    let comments = post1["comments"].as_array().expect("post1 comments");
    // cm1 and cm2 belong to post1
    assert_eq!(comments.len(), 2);

    let post2 = posts_arr
        .iter()
        .find(|p| p["id"] == "post2")
        .expect("post2");
    let comments2 = post2["comments"].as_array().expect("post2 comments");
    // cm3 belongs to post2
    assert_eq!(comments2.len(), 1);
    assert_eq!(comments2[0]["id"], "cm3");
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — create_with_relationships
// Mirrors: packages/core/src/operations/crud/create-with-relationships.ts
// ═══════════════════════════════════════════════════════════════════════════

/// `$connect` on a ref relationship sets the foreign key on the created entity.
///
/// TS step 6: `baseInput[foreignKey] = connect.targetId` for ref relationships.
#[test]
fn create_with_connect_ref_sets_foreign_key_on_created_entity() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create(
        "users",
        json!({ "id": "user1", "name": "Alice", "email": "a@x.com", "companyId": "comp1" }),
    )
    .unwrap();

    let new_post = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-new",
                "title": "Connected Post",
                // $connect to an existing user by id
                "author": { "$connect": { "id": "user1" } }
            }),
        )
        .expect("create_with_relationships");

    assert_eq!(new_post["id"], "p-new");
    assert_eq!(
        new_post["authorId"], "user1",
        "FK must be set from $connect"
    );
}

/// `$connect` to a non-existent id produces `ForeignKeyError`.
///
/// TS: `resolveConnectInput` calls `Effect.fail(new ForeignKeyError(...))` when
/// the target id is not in the map.
#[test]
fn create_with_connect_nonexistent_id_is_foreign_key_error() {
    let (mut db, _) = make_db();

    let err = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-err",
                "title": "Bad connect",
                "author": { "$connect": { "id": "ghost_user" } }
            }),
        )
        .expect_err("should fail");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );
    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(fk.target_collection, "users");
    }
}

/// `$create` on a ref relationship first creates the nested entity in the
/// target collection, then sets the FK on the parent.
///
/// TS step 4: create nested entities → set `baseInput[foreignKey] = id` for ref.
#[test]
fn create_with_create_nested_ref_creates_entity_and_sets_fk() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    let new_post = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-nested",
                "title": "Post with new author",
                "author": {
                    "$create": {
                        "id": "u-brand-new",
                        "name": "Brand New",
                        "email": "new@x.com",
                        "companyId": "comp1"
                    }
                }
            }),
        )
        .expect("create");

    // Nested payload ids are overwritten by a fresh generated id.
    let author_id = new_post["authorId"].as_str().expect("generated author id");
    assert_ne!(author_id, "u-brand-new");
    let user = db
        .collection("users")
        .expect("users collection")
        .get(author_id)
        .expect("nested user should exist");
    assert_eq!(user["name"], "Brand New");
}

/// `$connectOrCreate` finds the existing entity and connects to it.
///
/// TS step 5: `resolveConnectInput` succeeds → use existing id, don't create.
#[test]
fn create_with_connect_or_create_finds_existing_entity() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create(
        "users",
        json!({ "id": "user1", "name": "Alice", "email": "a@x.com", "companyId": "comp1" }),
    )
    .unwrap();

    let new_post = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-coc",
                "title": "COC post",
                "author": {
                    "$connectOrCreate": {
                        "where": { "id": "user1" },
                        "create": { "id": "user1-dup", "name": "Dup", "email": "dup@x.com", "companyId": "comp1" }
                    }
                }
            }),
        )
        .expect("create");

    // Should connect to existing user1, NOT create the duplicate
    assert_eq!(new_post["authorId"], "user1");
    // user1-dup must NOT exist
    assert!(
        db.collection("users").unwrap().get("user1-dup").is_none(),
        "duplicate should not have been created"
    );
}

/// `$connectOrCreate` creates the entity when it is not found.
///
/// TS step 5: `resolveConnectInput` fails (ForeignKeyError caught) → create new.
#[test]
fn create_with_connect_or_create_creates_when_missing() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    let new_post = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-coc2",
                "title": "COC create post",
                "author": {
                    "$connectOrCreate": {
                        "where": { "id": "user-absent" },
                        "create": {
                            "id": "user-absent",
                            "name": "New User",
                            "email": "newuser@x.com",
                            "companyId": "comp1"
                        }
                    }
                }
            }),
        )
        .expect("create");

    let author_id = new_post["authorId"].as_str().expect("generated author id");
    assert_ne!(author_id, "user-absent");
    let created_user = db
        .collection("users")
        .unwrap()
        .get(author_id)
        .expect("created user must exist");
    assert_eq!(created_user["name"], "New User");
}

/// `$create` on an *inverse* relationship creates child entities in the target
/// collection with the FK set to point back at the newly created parent.
///
/// TS step 4: for inverse — `entityData[foreignKey] = parentId`.
#[test]
fn create_with_create_inverse_sets_fk_on_new_children() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create(
        "users",
        json!({ "id": "user1", "name": "Alice", "email": "a@x.com", "companyId": "comp1" }),
    )
    .unwrap();

    let new_user = db
        .create_with_relationships(
            "users",
            json!({
                "id": "user-parent",
                "name": "Parent",
                "email": "parent@x.com",
                "companyId": "comp1",
                // inverse: create two new posts as children
                "posts": {
                    "$create": [
                        { "id": "child-p1", "title": "Child Post 1" },
                        { "id": "child-p2", "title": "Child Post 2" }
                    ]
                }
            }),
        )
        .expect("create user with inverse $create");

    assert_eq!(new_user["id"], "user-parent");

    // Nested payload ids are overwritten; both generated children point back.
    let children: Vec<&Value> = db
        .collection("posts")
        .unwrap()
        .list()
        .into_iter()
        .filter(|post| post["authorId"] == "user-parent")
        .collect();
    assert_eq!(children.len(), 2);
    assert!(children
        .iter()
        .all(|post| post["id"] != "child-p1" && post["id"] != "child-p2"));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — update_with_relationships
// Mirrors: packages/core/src/operations/crud/update-with-relationships.ts
// ═══════════════════════════════════════════════════════════════════════════

/// `$connect` on a ref relationship updates the FK on the existing entity.
///
/// TS step 6: `for (const connect of resolvedConnects)` → ref FK overwrite.
#[test]
fn update_with_connect_ref_changes_foreign_key() {
    let mut db = seeded_db();

    // post1 currently has authorId="user1"; re-connect to user2
    let updated = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$connect": { "id": "user2" } } }),
        )
        .expect("update");

    assert_eq!(
        updated["authorId"], "user2",
        "FK must switch to user2 after $connect"
    );
}

/// `$disconnect` on a ref relationship sets the FK field to null.
///
/// TS step 5: disconnect for ref → `baseInput[foreignKey] = null`.
#[test]
fn update_with_disconnect_ref_nulls_foreign_key() {
    let mut db = seeded_db();

    let updated = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$disconnect": true } }),
        )
        .expect("update");

    assert!(
        matches!(updated.get("authorId"), Some(Value::Null) | None),
        "authorId must be null/absent after $disconnect: {updated:?}"
    );
}

/// `$update` on a ref relationship updates fields on the *target* entity,
/// not the holder.
///
/// TS step 7: `update.push({ field, data: ops.$update, ... })` → apply to target.
#[test]
fn update_with_update_ref_updates_fields_on_target() {
    let mut db = seeded_db();

    db.update_with_relationships(
        "posts",
        "post1",
        json!({ "author": { "$update": { "name": "Alice Updated" } } }),
    )
    .expect("update");

    let user1 = db.collection("users").unwrap().get("user1").expect("user1");
    assert_eq!(user1["name"], "Alice Updated");
    // post1's authorId unchanged
    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(post1["authorId"], "user1");
}

/// `$delete` on a ref relationship is accepted by the TS type but is a runtime
/// no-op: delete processing only acts on inverse relationships.
#[test]
fn update_with_delete_ref_is_noop() {
    let mut db = seeded_db();

    let updated = db
        .update_with_relationships("posts", "post1", json!({ "author": { "$delete": true } }))
        .expect("update");

    assert!(db.collection("users").unwrap().get("user1").is_some());
    assert_eq!(updated["authorId"], "user1");
}

/// `$connect` on an *inverse* relationship sets the FK on the target entity,
/// pointing it to the current entity.
///
/// TS step 9: inverse connect → update `targetEntity[foreignKey] = parentId`.
#[test]
fn update_with_connect_inverse_sets_fk_on_target() {
    let mut db = seeded_db();

    // post3 currently belongs to user2; re-connect it to user1
    db.update_with_relationships(
        "users",
        "user1",
        json!({ "posts": { "$connect": { "id": "post3" } } }),
    )
    .expect("update");

    let post3 = db.collection("posts").unwrap().get("post3").unwrap();
    assert_eq!(
        post3["authorId"], "user1",
        "post3.authorId must switch to user1 after inverse $connect"
    );
}

/// `$set` on an inverse relationship replaces ALL existing children:
/// currently connected children not in the new set have their FK set to null
/// (or are disconnected), and the new set members have their FK pointed here.
///
/// TS: `set.push({ field, targetIds, ... })` → replace-all semantics.
#[test]
fn update_with_set_inverse_replaces_all_children() {
    let mut db = seeded_db();

    // user1 currently owns post1 and post2.
    // $set to only post2 and post3 → post1 should be disconnected, post3 connected.
    db.update_with_relationships(
        "users",
        "user1",
        json!({
            "posts": {
                "$set": [
                    { "id": "post2" },
                    { "id": "post3" }
                ]
            }
        }),
    )
    .expect("update");

    // post2 and post3 should now point to user1
    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert_eq!(post2["authorId"], "user1");

    let post3 = db.collection("posts").unwrap().get("post3").unwrap();
    assert_eq!(post3["authorId"], "user1");

    // post1 was removed from the set — its authorId must be null/absent
    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert!(
        matches!(post1.get("authorId"), Some(Value::Null) | None),
        "post1.authorId should be null after $set removes it: {post1:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — delete_with_relationships
// Mirrors: packages/core/src/operations/crud/delete-with-relationships.ts
// ═══════════════════════════════════════════════════════════════════════════

/// Default `preserve` option: deleting a user does NOT touch related posts.
///
/// TS: `case "preserve": break` — no-op for related entities.
#[test]
fn delete_preserve_does_not_touch_related_entities() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: std::collections::HashMap::new(), // empty = all preserve
    };

    let result = db
        .delete_with_relationships("users", "user1", opts)
        .expect("delete");

    assert_eq!(result.deleted["id"], "user1");
    assert!(
        result.cascaded.is_none() || result.cascaded.as_ref().unwrap().is_empty(),
        "no cascade should occur for preserve"
    );

    // Posts still exist, authorId unchanged
    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(
        post1["authorId"], "user1",
        "FK should be untouched after preserve delete"
    );
}

/// `restrict` prevents deletion when related entities exist.
///
/// TS: `restrictViolations.push(...)` → `Effect.fail(new ValidationError(...))`.
/// Rust: `EngineError::Validation` with issues containing "Cannot delete".
#[test]
fn delete_restrict_fails_with_validation_error_when_related_exist() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    let err = db
        .delete_with_relationships("users", "user1", opts)
        .expect_err("should fail");

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError, got: {err:?}"
    );
    if let EngineError::Validation(v) = err {
        let combined = v
            .issues
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            combined.contains("Cannot delete") || combined.contains("restrict"),
            "message should describe restrict violation: {combined}"
        );
        // State must not have been mutated
        assert!(
            db.collection("users").unwrap().get("user1").is_some(),
            "user1 must still exist after restrict failure"
        );
    }
}

/// `restrict` succeeds (and deletes the entity) when no related entities exist.
///
/// TS: `relatedEntities.length === 0` → no violation added → delete proceeds.
#[test]
fn delete_restrict_succeeds_when_no_related_entities() {
    let mut db = seeded_db();

    // user3 has no posts (post1/2 are user1's, post3 is user2's)
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("users", "user3", opts)
        .expect("restrict should allow delete when no children");

    assert_eq!(result.deleted["id"], "user3");
    assert!(db.collection("users").unwrap().get("user3").is_none());
}

/// `cascade` hard-deletes related entities and reports them in `cascaded`.
///
/// TS: `cascadeDeleteEntities(relatedEntities, targetRef, soft=false)`.
#[test]
fn delete_cascade_hard_removes_related_entities() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("users", "user1", opts)
        .expect("cascade delete");

    // user1's 2 posts (post1, post2) must be gone
    assert!(
        db.collection("posts").unwrap().get("post1").is_none(),
        "post1 gone"
    );
    assert!(
        db.collection("posts").unwrap().get("post2").is_none(),
        "post2 gone"
    );
    // user2's post3 must remain
    assert!(
        db.collection("posts").unwrap().get("post3").is_some(),
        "post3 unaffected"
    );
    let posts = db.collection("posts").unwrap();
    assert_eq!(
        posts.narrow_candidates(&json!({"authorId":"user1"})),
        Some(Vec::new()),
        "raw cascade deletion must remove equality postings"
    );
    assert_eq!(
        posts.narrow_candidates(&json!({"authorId":"user2"})),
        Some(vec!["post3".to_string()])
    );
    assert_eq!(
        posts.narrow_candidates(&json!({"$search":{"query":"alpha","fields":["title"]}})),
        Some(Vec::new()),
        "raw cascade deletion must remove search postings"
    );

    // cascaded metadata
    let cascaded = result.cascaded.expect("cascaded should be Some");
    let posts_cascade = cascaded.get("posts").expect("posts entry");
    assert_eq!(posts_cascade.count, 2);
    assert!(posts_cascade.ids.contains(&"post1".to_string()));
    assert!(posts_cascade.ids.contains(&"post2".to_string()));
}

/// `set_null` sets the FK field on related entities to null instead of deleting.
///
/// TS: `setForeignKeysToNull(relatedEntities, foreignKey, targetRef)`.
#[test]
fn delete_set_null_nullifies_fk_on_related_entities() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::SetNull)]
            .into_iter()
            .collect(),
    };

    db.delete_with_relationships("users", "user1", opts)
        .expect("set_null delete");

    // user1 is gone
    assert!(db.collection("users").unwrap().get("user1").is_none());

    // post1 and post2 must still exist, but authorId must be null
    let post1 = db
        .collection("posts")
        .unwrap()
        .get("post1")
        .expect("post1 still exists");
    assert_eq!(
        post1["authorId"],
        Value::Null,
        "authorId must be null after set_null"
    );
    let post2 = db
        .collection("posts")
        .unwrap()
        .get("post2")
        .expect("post2 still exists");
    assert_eq!(post2["authorId"], Value::Null);
    let posts = db.collection("posts").unwrap();
    assert_eq!(
        posts.narrow_candidates(&json!({"authorId":"user1"})),
        Some(Vec::new())
    );
    assert_eq!(
        posts.narrow_candidates(&json!({"authorId":null})),
        Some(vec!["post1".to_string(), "post2".to_string()])
    );
}

/// `cascade_soft` marks related entities with `deletedAt` instead of hard-deleting.
///
/// TS: `cascadeDeleteEntities(relatedEntities, targetRef, soft=true)`.
#[test]
fn delete_cascade_soft_marks_deleted_at_on_related_entities() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::CascadeSoft)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("users", "user1", opts)
        .expect("cascade_soft delete");

    // Posts still exist in the collection (soft-deleted)
    let post1 = db
        .collection("posts")
        .unwrap()
        .get("post1")
        .expect("post1 still in collection");
    assert!(
        post1
            .get("deletedAt")
            .map(|v: &Value| !v.is_null())
            .unwrap_or(false),
        "post1.deletedAt must be set: {post1:?}"
    );

    let cascaded = result.cascaded.expect("cascaded Some");
    let posts_cascade = cascaded.get("posts").expect("posts");
    assert_eq!(posts_cascade.count, 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — delete_many_with_relationships
// Mirrors: deleteManyWithRelationships in delete-with-relationships.ts
// ═══════════════════════════════════════════════════════════════════════════

/// When `restrict` is used and *any* of the matched entities has children,
/// the entire operation fails atomically — no entities are deleted.
///
/// TS: step 3 checks ALL restrict violations before ANY delete.
#[test]
fn delete_many_restrict_atomic_fails_if_any_entity_has_children() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    // user1 has 2 posts, user2 has 1 post, user3 has 0 posts.
    // Matching all comp1 employees (user1, user2) → both have children → restrict fails.
    let err = db
        .delete_many_with_relationships("users", &|entity| entity["companyId"] == "comp1", opts)
        .expect_err("should fail");

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError: {err:?}"
    );

    // Atomically: ALL users must still be present
    assert!(
        db.collection("users").unwrap().get("user1").is_some(),
        "user1 must remain"
    );
    assert!(
        db.collection("users").unwrap().get("user2").is_some(),
        "user2 must remain"
    );
}

/// `cascade` for delete_many removes all related entities across all matched
/// entities and returns the aggregate cascaded counts.
///
/// TS: step 4 iterates every matching entity and accumulates cascade results.
#[test]
fn delete_many_cascade_removes_all_related_across_matched_entities() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    // Delete user1 and user2 (both from comp1); together they own post1, post2, post3
    let result = db
        .delete_many_with_relationships("users", &|entity| entity["companyId"] == "comp1", opts)
        .expect("cascade delete_many");

    assert_eq!(result.count, 2, "two users deleted");
    assert!(db.collection("users").unwrap().get("user1").is_none());
    assert!(db.collection("users").unwrap().get("user2").is_none());
    // user3 (comp2) is unaffected
    assert!(db.collection("users").unwrap().get("user3").is_some());

    // All three posts gone
    assert!(db.collection("posts").unwrap().get("post1").is_none());
    assert!(db.collection("posts").unwrap().get("post2").is_none());
    assert!(db.collection("posts").unwrap().get("post3").is_none());

    let cascaded = result.cascaded.expect("cascaded Some");
    let posts_cascade = cascaded.get("posts").expect("posts");
    assert_eq!(
        posts_cascade.count, 3,
        "all 3 posts cascaded: {posts_cascade:?}"
    );
}

/// `delete_many` with a `limit` still applies the restrict check only to the
/// entities selected by the limit, not to all matches.
///
/// TS: `matchingEntities = matchingEntities.slice(0, options.limit)` before
/// restrict checks — only the limited set is examined.
#[test]
fn delete_many_with_limit_restrict_checks_only_limited_set() {
    let mut db = seeded_db();

    // user3 has no posts. If limit = 1 and predicate matches in order user1, user2, user3,
    // then limiting to 1 might pick user1 (has posts) → restrict fails.
    // But if we order so user3 is first... insertion order is user1, user2, user3.
    // So limit=1 → user1 → has posts → restrict fails even with limit.
    // We test this: limit=1 with restrict on user1 must still fail.
    let opts_limited = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    // A custom struct in the API or a separate limit param — design depends on U4.
    // Here we test the engine-level semantic: restrict checks apply to the limited slice.
    // We use all users but expect restrict to fire on user1 first.
    let err = db
        .delete_many_with_relationships(
            "users",
            &|entity| entity["companyId"] == "comp1",
            opts_limited,
        )
        .expect_err("restrict must fire on user1's posts");

    assert!(matches!(err, EngineError::Validation(_)));
    // No entities deleted
    assert!(db.collection("users").unwrap().get("user1").is_some());
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — PARITY GAPS (RED tests; each pinpoints one missing behavior)
// ═══════════════════════════════════════════════════════════════════════════

// ── 9a: restrict issues field must be exactly "relationships" ───────────────

/// TS ValidationError for restrict uses `field: "relationships"` on every issue
/// (not the relationship name).  Mirrors `delete-with-relationships.ts` line 358.
#[test]
fn delete_restrict_issues_field_is_exactly_relationships() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    let err = db
        .delete_with_relationships("users", "user1", opts)
        .expect_err("restrict must fail");

    if let EngineError::Validation(v) = err {
        for issue in &v.issues {
            assert_eq!(
                issue.field, "relationships",
                "issue.field must be 'relationships', got '{}'",
                issue.field
            );
        }
    } else {
        panic!("expected ValidationError");
    }
}

// ── 9b: cascade results keyed by TARGET COLLECTION (not relationship name) ──

/// The TS accumulates cascade results under `cascadeResults[targetCollection]`
/// (line 261-265 of delete-with-relationships.ts), NOT the relationship name.
/// This matters when the rel name ≠ target collection (e.g. "employees" → "users").
#[test]
fn delete_cascade_result_keyed_by_target_collection_not_relationship_name() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("employees".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("companies", "comp1", opts)
        .expect("cascade");

    let cascaded = result.cascaded.expect("cascaded Some");
    // Key must be target collection "users", NOT relationship name "employees"
    assert!(
        cascaded.contains_key("users"),
        "cascade result must be keyed by target 'users', not rel name 'employees'. Keys: {:?}",
        cascaded.keys().collect::<Vec<_>>()
    );
    let users_entry = cascaded.get("users").unwrap();
    assert!(
        users_entry.count >= 2,
        "user1 and user2 from comp1 should be cascaded"
    );
}

// ── 9c: Cascade + opts.soft → soft-deletes children ────────────────────────

/// TS `cascadeDeleteEntities(relatedEntities, targetRef, options?.soft || false)`:
/// when `opts.soft=true`, even the `Cascade` option soft-deletes children.
/// (delete-with-relationships.ts line 259: `options?.soft || false`)
#[test]
fn delete_cascade_with_opts_soft_soft_deletes_children_not_hard() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: true,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    db.delete_with_relationships("users", "user1", opts)
        .expect("delete with soft cascade");

    // Children should STILL EXIST with deletedAt set (soft-deleted, not hard-deleted)
    let post1 = db
        .collection("posts")
        .unwrap()
        .get("post1")
        .expect("post1 must still exist — soft deleted, not removed");
    assert!(
        post1
            .get("deletedAt")
            .map(|v| !v.is_null())
            .unwrap_or(false),
        "post1.deletedAt must be set when Cascade + opts.soft=true: {post1:?}"
    );
}

// ── 9d: CascadeSoft must work even when target schema lacks deletedAt ────────

/// TS `cascadeDeleteEntities` patches `deletedAt`/`updatedAt` DIRECTLY without
/// schema validation, so it works even if the target schema has no deletedAt field.
/// Mirrors the `Ref.update` direct-patch approach (not going through schema validation).
#[test]
fn cascade_soft_direct_patch_works_when_target_schema_lacks_deleted_at() {
    let mut db = seeded_db();
    // comments schema has no deletedAt field → delete_with_options(id, true) would fail
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("comments".to_string(), CascadeOption::CascadeSoft)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("posts", "post1", opts)
        .expect("cascade_soft should work even without schema deletedAt");

    // cm1 and cm2 must still exist in the comments collection (soft-deleted)
    let cm1 = db
        .collection("comments")
        .unwrap()
        .get("cm1")
        .expect("cm1 must still exist after cascade_soft");
    // deleted_at must be set (patched directly even though schema doesn't declare it)
    assert!(
        cm1.get("deletedAt").is_some() && cm1["deletedAt"] != Value::Null,
        "cm1.deletedAt must be patched: {cm1:?}"
    );

    let cascaded = result.cascaded.expect("cascaded Some");
    let comments_entry = cascaded.get("comments").expect("comments cascade entry");
    assert_eq!(comments_entry.count, 2);
}

// ── 9e: limit field in DeleteRelationshipsOptions ───────────────────────────

/// TS applies `options.limit` BEFORE restrict checks so only the limited
/// slice is examined (deleteManyWithRelationships step 2, line 459).
#[test]
fn delete_many_limit_option_caps_matched_entities() {
    let mut db = seeded_db();
    // comp1 has user1 (2 posts) and user2 (1 post); limit=1 → only user1 selected
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: Some(1),
        include: [("posts".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_many_with_relationships("users", &|e| e["companyId"] == "comp1", opts)
        .expect("should succeed with limit=1 and cascade");

    assert_eq!(result.count, 1, "only 1 user (user1) should be deleted");
    assert!(db.collection("users").unwrap().get("user1").is_none());
    assert!(
        db.collection("users").unwrap().get("user2").is_some(),
        "user2 not in limited slice"
    );
}

// ── 9f: ref $connect shorthand (no $ prefix) ────────────────────────────────

/// TS: `!isRelationshipOperation(value)` → treat value itself as a ConnectInput.
/// So `{ author: { id: "user2" } }` is treated as `{ author: { $connect: { id: "user2" } } }`.
#[test]
fn update_ref_connect_shorthand_without_dollar_connect_wrapper() {
    let mut db = seeded_db();

    let updated = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "id": "user2" } }), // shorthand — no "$connect"
        )
        .expect("shorthand connect should work");

    assert_eq!(
        updated["authorId"], "user2",
        "shorthand connect must set FK"
    );
}

// ── 9g: generic $connect resolver (arbitrary field match) ───────────────────

/// TS `resolveConnectInput` first tries `id` field; if absent, matches ALL fields.
/// Strict equality (`===`) matches for all field values.
#[test]
fn update_ref_connect_by_arbitrary_field_match() {
    let mut db = seeded_db();

    let updated = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$connect": { "name": "Bob" } } }), // match by name
        )
        .expect("field-match connect should work");

    assert_eq!(
        updated["authorId"], "user2",
        "should find user2 whose name=Bob"
    );
}

// ── 9h: inverse $disconnect targeted (single/array) ─────────────────────────

/// TS: `$disconnect: <ConnectInput>` on inverse → goes to del[] → null FK on that
/// specific child IF it still belongs to the parent.
/// (processManyRelationshipUpdate lines 293-313)
#[test]
fn update_inverse_disconnect_targeted_leaves_other_children() {
    let mut db = seeded_db();

    db.update_with_relationships(
        "users",
        "user1",
        json!({ "posts": { "$disconnect": { "id": "post1" } } }), // targeted
    )
    .expect("targeted disconnect");

    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert!(
        matches!(post1.get("authorId"), Some(Value::Null) | None),
        "post1 FK should be null after targeted disconnect: {post1:?}"
    );

    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert_eq!(
        post2["authorId"], "user1",
        "post2 must remain connected to user1"
    );
}

// ── 9i: inverse $connect array ───────────────────────────────────────────────

/// TS: `$connect` array form connects multiple children at once.
/// (processManyRelationshipUpdate lines 315-326)
#[test]
fn update_inverse_connect_array_connects_multiple_children() {
    let mut db = seeded_db();

    db.update_with_relationships(
        "users",
        "user3",
        json!({ "posts": { "$connect": [{ "id": "post1" }, { "id": "post3" }] } }),
    )
    .expect("array connect");

    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(post1["authorId"], "user3");

    let post3 = db.collection("posts").unwrap().get("post3").unwrap();
    assert_eq!(post3["authorId"], "user3");
}

// ── 9j: inverse $update single {where, data} ─────────────────────────────────

/// TS: `$update: { where, data }` or `[{ where, data }]` updates the target entity
/// whose fields match `where`. Unresolved `where` is silently skipped.
/// (processManyRelationshipUpdate lines 329-343)
#[test]
fn update_inverse_update_op_updates_matched_child() {
    let mut db = seeded_db();

    db.update_with_relationships(
        "users",
        "user1",
        json!({
            "posts": {
                "$update": { "where": { "id": "post1" }, "data": { "title": "Revised" } }
            }
        }),
    )
    .expect("inverse $update");

    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(post1["title"], "Revised");

    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert_eq!(post2["title"], "Beta", "post2 must be unchanged");
}

// ── 9k: inverse $delete targeted → null FK (entity stays in collection) ──────

/// TS step 8: `$delete` on inverse = targeted disconnect (null FK on the specific
/// child if it still belongs to the parent). NOT a hard delete.
/// (update-with-relationships.ts lines 715-742)
#[test]
fn update_inverse_delete_op_nulls_fk_entity_stays_in_collection() {
    let mut db = seeded_db();

    db.update_with_relationships(
        "users",
        "user1",
        json!({ "posts": { "$delete": { "id": "post1" } } }),
    )
    .expect("inverse $delete");

    // post1 must STILL EXIST in collection
    let post1 = db
        .collection("posts")
        .unwrap()
        .get("post1")
        .expect("post1 must still be in collection");

    assert!(
        matches!(post1.get("authorId"), Some(Value::Null) | None),
        "post1.authorId must be null/absent: {post1:?}"
    );

    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert_eq!(post2["authorId"], "user1", "post2 unaffected");
}

// ── 9l: inverse $set updates ALL selected targets (even already-connected) ───

/// TS $set step 9 line 773: `else if (targetIdsSet.has(entityId))` always sets FK,
/// even if the entity was already pointing to the parent.
#[test]
fn update_inverse_set_updates_already_connected_targets() {
    let mut db = seeded_db();

    // post2 is ALREADY connected to user1; include it in $set anyway
    db.update_with_relationships(
        "users",
        "user1",
        json!({ "posts": { "$set": [{ "id": "post2" }] } }), // only post2
    )
    .expect("$set with already-connected target");

    // post2 must still be connected (re-set)
    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert_eq!(post2["authorId"], "user1");

    // post1 must be disconnected (not in new set)
    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert!(
        matches!(post1.get("authorId"), Some(Value::Null) | None),
        "post1 not in new set → should be disconnected"
    );
}

// ── 9m: target side-effects survive parent validation failure ────────────────

/// TS steps 4-9 execute BEFORE step 10 (validate + write parent). If the parent
/// schema validation fails, the nested creates from step 4 are already committed.
#[test]
fn create_with_relationships_nested_side_effects_survive_parent_schema_failure() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    // Create a post with $create on author (nested ref create).
    // The post itself is INVALID (missing required 'title' field).
    let err = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "p-bad",
                // title deliberately MISSING — schema validation will fail
                "author": {
                    "$create": {
                        "id": "survivor-user",
                        "name": "Survivor",
                        "email": "s@x.com",
                        "companyId": "comp1"
                    }
                }
            }),
        )
        .expect_err("parent missing title → should fail schema validation");

    assert!(
        matches!(err, EngineError::Validation(_) | EngineError::ForeignKey(_)),
        "expected schema/fk error from parent, got: {err:?}"
    );

    // IMPORTANT: a freshly-id'd nested user remains even though parent failed.
    assert!(
        db.collection("users")
            .unwrap()
            .list()
            .into_iter()
            .any(|user| user["email"] == "s@x.com" && user["id"] != "survivor-user"),
        "nested $create user must persist even when parent creation fails"
    );
}

// ── 9n: inverse FK population fallback singularizes SOURCE collection ─────────

/// TS `resolveInverseForeignKey` fallback: singularize the SOURCE (not target)
/// collection name with `ies→y` then trailing `s` removal.
/// "companies" → "company" → "companyId"
/// This test uses a descriptor where no explicit FK and no reverse-ref exists,
/// forcing the fallback path. We build a minimal fixture for it.
#[test]
fn population_inv_fk_fallback_singularizes_source_collection_ies_to_y() {
    use proseql_engine::descriptor::{CollectionDescriptor, ValidationMode};

    // Build a minimal 2-collection DB: "companies" → Inverse → "staff"
    // No explicit FK on the inverse side, no reverse ref on "staff" → pure singularize fallback.
    // Singularize "companies" → "company" → FK field = "companyId"
    let reg = Arc::new(CallbackRegistry::new());

    let companies_col = Collection::new_with_clock(
        "companies",
        CollectionDescriptor {
            name: "companies".into(),
            schema: SchemaNode::Struct {
                fields: vec![
                    StructField {
                        name: "id".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "name".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "createdAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                    StructField {
                        name: "updatedAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                ],
            },
            id_strategy: IdStrategy::Provided,
            relationships: vec![(
                "staff".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Inverse,
                    target: "staff".into(),
                    foreign_key: None, // no explicit FK → force fallback
                },
            )],
            indexes: vec![],
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
            validation_mode: ValidationMode::Strict,
        },
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("c")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );

    // "staff" collection: no relationships back to companies (no reverse ref)
    let staff_col = Collection::new_with_clock(
        "staff",
        CollectionDescriptor {
            name: "staff".into(),
            schema: SchemaNode::Struct {
                fields: vec![
                    StructField {
                        name: "id".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "name".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "companyId".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    }, // FK field derived by singularize
                    StructField {
                        name: "createdAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                    StructField {
                        name: "updatedAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                ],
            },
            id_strategy: IdStrategy::Provided,
            relationships: vec![],
            indexes: vec![],
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
            validation_mode: ValidationMode::Strict,
        },
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("s")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );

    let mut cols = IndexMap::new();
    cols.insert("companies".to_string(), companies_col);
    cols.insert("staff".to_string(), staff_col);
    let mut db = Database::new(cols, Arc::clone(&reg));

    db.create("companies", json!({ "id": "c1", "name": "Acme" }))
        .unwrap();
    db.create(
        "staff",
        json!({ "id": "s1", "name": "Alice", "companyId": "c1" }),
    )
    .unwrap();
    db.create(
        "staff",
        json!({ "id": "s2", "name": "Bob", "companyId": "c1" }),
    )
    .unwrap();

    let results = db
        .query(
            "companies",
            QueryInput {
                r#where: Some(json!({ "id": "c1" })),
                ..QueryInput::default()
            },
            Some(json!({ "staff": true })),
        )
        .expect("query");

    let company = results.first().expect("c1");
    let staff_arr = company["staff"].as_array().expect("staff array");
    assert_eq!(
        staff_arr.len(),
        2,
        "singularize fallback 'companies'→'company'→'companyId' must find 2 staff"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — U4 RED→GREEN parity tests
// Each test below pinpoints one gap identified in the RED→GREEN pass.
// ═══════════════════════════════════════════════════════════════════════════

// ── C: inverse $disconnect:true nulls ALL children FKs ───────────────────

/// Inverse `$disconnect: true` on update_with_relationships nulls the FK on
/// EVERY current child (not just targeted ones).
///
/// TS: `$disconnect === true` → `disconnect.push({ field, targetCollection })`.
/// The subsequent execution sets FK=null on all entities where FK == parent.id.
#[test]
fn update_inverse_disconnect_all_true_nulls_all_children() {
    let mut db = seeded_db();

    // user1 currently owns post1 and post2
    db.update_with_relationships(
        "users",
        "user1",
        json!({ "posts": { "$disconnect": true } }),
    )
    .expect("disconnect all");

    let post1 = db.collection("posts").unwrap().get("post1").unwrap();
    assert!(
        matches!(post1.get("authorId"), Some(Value::Null) | None),
        "post1.authorId must be null after $disconnect:true: {post1:?}"
    );

    let post2 = db.collection("posts").unwrap().get("post2").unwrap();
    assert!(
        matches!(post2.get("authorId"), Some(Value::Null) | None),
        "post2.authorId must be null after $disconnect:true: {post2:?}"
    );

    // user2's post3 must be untouched
    let post3 = db.collection("posts").unwrap().get("post3").unwrap();
    assert_eq!(
        post3["authorId"], "user2",
        "post3 owned by user2 must be untouched"
    );
}

// ── C: plain Database::delete with nonexistent id is NotFoundError ────────

/// `Database::delete` with an id that does not exist returns `NotFoundError`.
#[test]
fn plain_delete_nonexistent_entity_is_not_found_error() {
    let mut db = seeded_db();

    let err = db
        .delete("users", "ghost-user")
        .expect_err("deleting nonexistent entity must fail");

    assert!(
        matches!(err, EngineError::NotFound(_)),
        "expected NotFoundError, got: {err:?}"
    );

    if let EngineError::NotFound(nf) = err {
        assert_eq!(nf.collection, "users");
        assert_eq!(nf.id, "ghost-user");
    }
}

// ── C: opts.soft=true soft-deletes the OWNER entity ──────────────────────

/// When `DeleteRelationshipsOptions.soft = true`, the owner entity itself
/// receives a `deletedAt` timestamp instead of being hard-removed.
///
/// TS: `if (options?.soft && hasSoftDelete(entity)) { ... deletedAt / updatedAt }`.
#[test]
fn delete_with_opts_soft_true_soft_deletes_owner() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: true,
        limit: None,
        include: std::collections::HashMap::new(),
    };

    let result = db
        .delete_with_relationships("users", "user3", opts)
        .expect("soft delete should succeed");

    // Owner must still exist in the collection (soft-deleted, not removed)
    let owner = db
        .collection("users")
        .unwrap()
        .get("user3")
        .expect("user3 must still exist after soft delete");

    assert!(
        owner
            .get("deletedAt")
            .map(|v| !v.is_null())
            .unwrap_or(false),
        "user3.deletedAt must be set after soft delete: {owner:?}"
    );

    // The returned deleted value must carry deletedAt
    assert!(
        result
            .deleted
            .get("deletedAt")
            .map(|v| !v.is_null())
            .unwrap_or(false),
        "returned deleted value must carry deletedAt: {:?}",
        result.deleted
    );
}

// ── C: delete_many limit:Some(1) restricts the checked set ───────────────

/// With `opts.limit = Some(1)` and `Restrict`, ONLY the first matched entity
/// is restrict-checked. If that entity has no children, the delete succeeds
/// (even if later entities do have children).
///
/// TS: `matchingEntities = matchingEntities.slice(0, options.limit)`.
#[test]
fn delete_many_restrict_limit_1_only_checks_first_entity() {
    let mut db = seeded_db();

    // user3 has no posts. Add user4 who also has no posts but is comp2.
    db.create(
        "users",
        json!({
            "id": "user4",
            "name": "Dave",
            "email": "dave@x.com",
            "companyId": "comp2"
        }),
    )
    .unwrap();

    // Predicate: comp2 users (user3, user4 — insertion order).
    // limit=1 → only user3 is restrict-checked → user3 has no posts → succeeds.
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: Some(1),
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_many_with_relationships("users", &|e| e["companyId"] == "comp2", opts)
        .expect("restrict with limit=1 should succeed when limited entity has no children");

    assert_eq!(result.count, 1, "exactly 1 user deleted");
    assert!(db.collection("users").unwrap().get("user3").is_none());
    // user4 not in limited slice → still present
    assert!(db.collection("users").unwrap().get("user4").is_some());
}

// ── C: inverse $connect in create_with_relationships ─────────────────────

/// Inverse `$connect` in `create_with_relationships` sets the FK on an
/// EXISTING entity in the target collection after the parent is created.
///
/// TS: step 9 — `connect` ops on inverse set `targetEntity[FK] = parentId`.
#[test]
fn create_inverse_connect_patches_fk_on_child() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    // Pre-create a post with null authorId (use the post collection directly
    // without FK validation since authorId=null is valid)
    db.create(
        "posts",
        json!({ "id": "p-existing", "title": "Unowned", "authorId": null }),
    )
    .expect("creating post with null FK is valid");

    // Now create a user with inverse $connect pointing to the existing post
    let user = db
        .create_with_relationships(
            "users",
            json!({
                "id": "new-user",
                "name": "New",
                "email": "new@x.com",
                "companyId": "comp1",
                "posts": { "$connect": [{ "id": "p-existing" }] }
            }),
        )
        .expect("create with inverse $connect");

    assert_eq!(user["id"], "new-user");

    // The existing post must now point to new-user
    let post = db.collection("posts").unwrap().get("p-existing").unwrap();
    assert_eq!(
        post["authorId"], "new-user",
        "post.authorId must be updated to parent id: {post:?}"
    );
}

// ── C: inverse $connectOrCreate in create_with_relationships ─────────────

/// The active TS implementation leaves an existing inverse
/// `$connectOrCreate` match unchanged and only avoids creating a duplicate.
#[test]
fn create_inverse_coc_existing_is_not_connected() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    // Pre-create a post
    db.create(
        "posts",
        json!({ "id": "p-pre", "title": "Pre-existing", "authorId": null }),
    )
    .expect("pre-create post");

    let user = db
        .create_with_relationships(
            "users",
            json!({
                "id": "u-coc",
                "name": "COC User",
                "email": "coc@x.com",
                "companyId": "comp1",
                "posts": {
                    "$connectOrCreate": {
                        "where": { "id": "p-pre" },
                        "create": { "id": "p-new-should-not-create", "title": "Should not create" }
                    }
                }
            }),
        )
        .expect("create with inverse $connectOrCreate existing");

    assert_eq!(user["id"], "u-coc");

    // Existing inverse matches are not connected by the TS implementation.
    let post = db.collection("posts").unwrap().get("p-pre").unwrap();
    assert_eq!(post["authorId"], Value::Null);

    // No new post must have been created
    assert!(
        db.collection("posts")
            .unwrap()
            .get("p-new-should-not-create")
            .is_none(),
        "no new post should be created when existing is found"
    );
}

/// When inverse $connectOrCreate does NOT find an existing child, it creates
/// the child with FK = parent_id BEFORE the parent is created.
#[test]
fn create_inverse_coc_missing_creates_child_with_fk() {
    let (mut db, _) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    let user = db
        .create_with_relationships(
            "users",
            json!({
                "id": "u-coc2",
                "name": "COC User 2",
                "email": "coc2@x.com",
                "companyId": "comp1",
                "posts": {
                    "$connectOrCreate": {
                        "where": { "id": "p-brand-new" },
                        "create": { "id": "p-brand-new", "title": "Brand New Post" }
                    }
                }
            }),
        )
        .expect("create with inverse $connectOrCreate missing");

    assert_eq!(user["id"], "u-coc2");

    // A fresh id replaces the supplied id; the new child points to the parent.
    let post = db
        .collection("posts")
        .unwrap()
        .list()
        .into_iter()
        .find(|post| post["title"] == "Brand New Post")
        .expect("new post");
    assert_ne!(post["id"], "p-brand-new");
    assert_eq!(post["authorId"], "u-coc2");
}

// ── C: update with direct FK value propagates ForeignKeyError ────────────

/// `Database::update` with a direct FK field set to a nonexistent target
/// must return `ForeignKeyError` (not succeed silently).
///
/// This mirrors TS `validateForeignKeysEffect` which is also called on update.
#[test]
fn update_with_invalid_fk_value_fails_foreign_key_error() {
    let mut db = seeded_db();

    let err = db
        .update("posts", "post1", json!({ "authorId": "no-such-user" }))
        .expect_err("updating FK to nonexistent target must fail");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );

    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(fk.field, "authorId");
        assert_eq!(fk.target_collection, "users");
    }

    // State must not have been mutated
    let post = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(
        post["authorId"], "user1",
        "post1.authorId must remain user1 after FK failure"
    );
}

// ── C: inverse $connect with nonexistent id propagates ForeignKeyError ───

/// `update_with_relationships` with inverse `$connect: { id: "ghost" }` must
/// propagate `ForeignKeyError` — NOT silently skip.
///
/// TS: `yield* resolveConnectInput(...)` (no catchTag) → error propagates.
#[test]
fn update_inverse_connect_nonexistent_propagates_fk_error() {
    let mut db = seeded_db();

    let err = db
        .update_with_relationships(
            "users",
            "user1",
            json!({ "posts": { "$connect": { "id": "ghost-post" } } }),
        )
        .expect_err("$connect to nonexistent must fail");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );
}

// ── C: inverse $set with nonexistent id propagates ForeignKeyError ────────

/// `update_with_relationships` with `$set: [{ id: "ghost" }]` must propagate
/// `ForeignKeyError` for the unresolvable item.
///
/// TS: `const targetId = yield* resolveConnectInput(...)` → error propagates.
#[test]
fn update_inverse_set_nonexistent_propagates_fk_error() {
    let mut db = seeded_db();

    let err = db
        .update_with_relationships(
            "users",
            "user1",
            json!({ "posts": { "$set": [{ "id": "ghost-post" }] } }),
        )
        .expect_err("$set with nonexistent must fail");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );
}

// ── C: ref $connect error.field is the FK FIELD NAME ─────────────────────

/// When a ref `$connect` fails, `ForeignKeyError.field` must be the FK field
/// (e.g. "authorId"), NOT the connect value or target id.
#[test]
fn update_ref_connect_error_field_is_fk_field_name() {
    let mut db = seeded_db();

    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$connect": { "id": "ghost-user" } } }),
        )
        .expect_err("$connect to nonexistent must fail");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError, got: {err:?}"
    );

    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(
            fk.field, "authorId",
            "ForeignKeyError.field must be the FK field name 'authorId', not the connect value. Got: '{}'",
            fk.field
        );
    }
}

// ── C: target nested $update validation error propagates ─────────────────

/// When `$update` on a ref relationship provides data that fails schema
/// validation on the target entity, the error must propagate upward.
///
/// TS: `yield* update(...)` — effect propagates.
/// Rust: `col.update(&tid, updates)?` — error propagates.
#[test]
fn update_nested_ref_update_validation_error_propagates() {
    let mut db = seeded_db();

    // Set name to a number — violates users schema (name: String required)
    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$update": { "name": 12345 } } }),
        )
        .expect_err("invalid $update data must fail with validation error");

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError from nested $update, got: {err:?}"
    );

    // Target (user1) must be unchanged
    let user1 = db.collection("users").unwrap().get("user1").unwrap();
    assert_eq!(
        user1["name"], "Alice",
        "user1.name must be unchanged after failed $update"
    );
}

// ── D: mixed cascade-before-restrict in single delete ────────────────────

/// TS `processRelationshipCascades` applies cascade/set_null IMMEDIATELY within
/// the loop while collecting restrict violations.  If cascade(A) runs before
/// restrict(B) fires, A's side effects persist even when the delete finally
/// fails due to B's restrict violation.
///
/// Descriptor: posts(Cascade) → comments(Restrict)
///   — cascading posts fires first, then restrict on comments fails.
#[test]
fn delete_single_cascade_before_restrict_cascade_side_effects_persist() {
    // Build a custom DB: posts collection has TWO inverse rels in descriptor order:
    //   1. "author" side effect (Cascade) → we need inverse rel on posts targeting something
    //   Actually, let's use a simpler fixture:
    //   - "posts" owns "comments" (inverse, we'll cascade this)
    //   - "posts" also has a "likes" child collection (inverse, we'll restrict this)
    //   Descriptor order: comments(Cascade), likes(Restrict)
    //   → cascade comments immediately, then restrict likes fails
    //   → ValidationError returned, but comments are already deleted

    use proseql_engine::descriptor::{CollectionDescriptor, ValidationMode};

    let reg = Arc::new(CallbackRegistry::new());

    // posts schema: {id, title, authorId?, createdAt?, updatedAt?}
    let posts_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "title".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "authorId".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    // comments schema: {id, content, postId, createdAt?, updatedAt?}
    let comments_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "content".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "postId".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    // likes schema: {id, postId, createdAt?, updatedAt?}
    let likes_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "postId".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };

    // posts descriptor: comments(Cascade first), likes(Restrict second)
    let posts_desc = CollectionDescriptor {
        name: "posts".into(),
        schema: posts_schema,
        id_strategy: IdStrategy::Provided,
        relationships: vec![
            (
                "comments".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Inverse,
                    target: "comments".into(),
                    foreign_key: Some("postId".into()),
                },
            ),
            (
                "likes".into(),
                RelationshipDescriptor {
                    kind: RelationshipKind::Inverse,
                    target: "likes".into(),
                    foreign_key: Some("postId".into()),
                },
            ),
        ],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let comments_desc = CollectionDescriptor {
        name: "comments".into(),
        schema: comments_schema,
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let likes_desc = CollectionDescriptor {
        name: "likes".into(),
        schema: likes_schema,
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let mut cols = IndexMap::new();
    cols.insert(
        "posts".to_string(),
        Collection::new_with_clock(
            "posts",
            posts_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("p")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    cols.insert(
        "comments".to_string(),
        Collection::new_with_clock(
            "comments",
            comments_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("cm")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    cols.insert(
        "likes".to_string(),
        Collection::new_with_clock(
            "likes",
            likes_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("l")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    let mut db = Database::new(cols, Arc::clone(&reg));

    // Seed: one post with a comment AND a like
    db.create("posts", json!({ "id": "post1", "title": "Alpha" }))
        .unwrap();
    db.create(
        "comments",
        json!({ "id": "cm1", "content": "Hi", "postId": "post1" }),
    )
    .unwrap();
    db.create("likes", json!({ "id": "l1", "postId": "post1" }))
        .unwrap();

    // Delete post1 with comments=Cascade, likes=Restrict
    // Expected (TS sequential): cascade comments → cm1 deleted; then restrict likes → fails
    // But cm1 IS ALREADY DELETED
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [
            ("comments".to_string(), CascadeOption::Cascade),
            ("likes".to_string(), CascadeOption::Restrict),
        ]
        .into_iter()
        .collect(),
    };

    let err = db
        .delete_with_relationships("posts", "post1", opts)
        .expect_err("restrict on likes must fail");

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError from restrict, got: {err:?}"
    );

    // post1 must still exist (delete of owner was blocked by restrict)
    assert!(
        db.collection("posts").unwrap().get("post1").is_some(),
        "post1 must not have been deleted"
    );

    // cm1 must be GONE — cascade ran before restrict failed
    assert!(
        db.collection("comments").unwrap().get("cm1").is_none(),
        "cm1 should have been cascade-deleted before restrict failed"
    );

    // l1 must still exist (restrict prevented its cascade)
    assert!(
        db.collection("likes").unwrap().get("l1").is_some(),
        "l1 must remain — restrict blocked delete of likes"
    );
}

// ── E: Database::query_cursor combines cursor + populate + select ─────────

/// `Database::query_cursor` runs cursor pagination, then populate, then
/// selection — returning a `CursorPageResult` with page_info.
#[test]
fn query_cursor_returns_page_result_with_population() {
    use proseql_engine::query::{CursorConfig, CursorPageResult};

    let db = seeded_db();

    let input = QueryInput {
        r#where: None,
        select: Some(json!({ "id": true, "author": { "id": true } })),
        ..QueryInput::default()
    };
    let cursor_cfg = CursorConfig {
        key: "id".to_string(),
        limit: 2,
        after: None,
        before: None,
    };

    let result: CursorPageResult = db
        .query_cursor(
            "posts",
            &input,
            &cursor_cfg,
            Some(json!({ "author": true })),
        )
        .expect("query_cursor should succeed");

    assert_eq!(result.items.len(), 2, "first 2 posts");
    // page_info must be present
    assert!(result.page_info.has_next_page, "there is a 3rd post");

    // Population: each item should have 'author' with only id (via select)
    let first = &result.items[0];
    let author = first.get("author").expect("author populated");
    assert!(author.get("id").is_some(), "author.id selected");
    assert!(author.get("name").is_none(), "author.name not selected");
    // 'title' not in select → absent
    assert!(first.get("title").is_none(), "title not selected");
}

// ═══════════════════════════════════════════════════════════════════════════
// RESIDUAL FIX TESTS (RED → GREEN)
// ═══════════════════════════════════════════════════════════════════════════

// ── Item 1: FK validation uses String(value) for ALL non-null FK values ────

/// `posts.authorId` is declared as `NullOr(Str)` in the schema.  When a
/// numeric `42` is passed, schema validation runs FIRST (before FK check)
/// and rejects it because `NullOr(Str)` expects `null` or a string —
/// `42` is neither.
///
/// TS order: schema decode → FK validation.  Schema error takes priority.
#[test]
fn fk_numeric_fk_fails_when_no_entity_with_coerced_id() {
    let mut db = seeded_db();
    // posts.authorId is NullOr(Str); 42 is a number → schema rejects before FK check.
    let err = db
        .create(
            "posts",
            json!({ "id": "px", "title": "Test", "authorId": 42 }),
        )
        .expect_err("numeric value for NullOr(Str) field must fail schema validation");
    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError (schema rejects 42 for NullOr(Str)), got: {err:?}"
    );
}

/// `posts.authorId` is `NullOr(Str)` — `true` (bool) fails schema, same as numeric.
#[test]
fn fk_bool_fk_fails_when_no_entity_with_coerced_id() {
    let mut db = seeded_db();
    let err = db
        .create(
            "posts",
            json!({ "id": "px", "title": "T", "authorId": true }),
        )
        .expect_err("bool value for NullOr(Str) field must fail schema validation");
    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError (schema rejects true for NullOr(Str)), got: {err:?}"
    );
}

// ── Item 2: Inverse FK patches must include updatedAt from target clock ────

// ── Item 3: UpdateFields — missing entity silently skipped ─────────────────

/// When a ref `$update` targets an entity that has been deleted (dangling FK),
/// the update must silently skip rather than propagating `NotFoundError`.
/// TS: `if (!targetEntity) continue` (execute-phase entity check).
/// Currently `col.update(&tid, ...)` returns NotFoundError → propagates. RED.
#[test]
fn ref_update_missing_target_entity_still_validates_parent_fk_at_step_ten() {
    let (mut db, _reg) = make_db();
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create(
        "users",
        json!({ "id": "u1", "name": "Alice", "email": "a@a.com", "companyId": "comp1" }),
    )
    .unwrap();
    db.create(
        "posts",
        json!({ "id": "p1", "title": "T", "authorId": "u1" }),
    )
    .unwrap();

    // Delete the user that post1 references (dangling FK on post1)
    db.delete("users", "u1").unwrap();

    // Now try to $update the (gone) author from post1
    let result = db.update_with_relationships(
        "posts",
        "p1",
        json!({ "author": { "$update": { "name": "Ghost" } } }),
    );

    assert!(
        matches!(result, Err(EngineError::ForeignKey(_))),
        "step 10 must still validate the parent FK after a skipped ref $update, got: {:?}",
        result
    );
}

// ── Item 4: Hard cascade bypasses append-only guard ────────────────────────

/// Cascading a hard-delete onto an append-only target collection must succeed:
/// the cascade path uses a trusted raw-remove that bypasses the append-only guard.
/// TS: cascade uses `map.delete(id)` directly on the Ref, bypassing all guards.
/// Currently `let _ = col.delete(child_id)` ignores the error (append-only block)
/// so the child STAYS in the collection even though the cascade appears to succeed.
/// After fix, the child must actually be removed. RED.
#[test]
fn cascade_hard_delete_bypasses_append_only_on_target() {
    use proseql_engine::descriptor::ValidationMode;

    let reg = Arc::new(CallbackRegistry::new());

    // posts collection: not append-only (the one being deleted)
    let posts_desc = posts_descriptor();

    // Make comments append-only so col.delete() would normally fail
    let mut comments_desc = comments_descriptor();
    comments_desc.append_only = true;

    let mut cols = IndexMap::new();
    let clock = || Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    cols.insert(
        "users".to_string(),
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("u")),
            clock(),
        ),
    );
    cols.insert(
        "posts".to_string(),
        Collection::new_with_clock(
            "posts",
            posts_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("p")),
            clock(),
        ),
    );
    cols.insert(
        "companies".to_string(),
        Collection::new_with_clock(
            "companies",
            companies_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("c")),
            clock(),
        ),
    );
    cols.insert(
        "comments".to_string(),
        Collection::new_with_clock(
            "comments",
            comments_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("cm")),
            clock(),
        ),
    );

    let mut db = Database::new(cols, Arc::clone(&reg));
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create(
        "users",
        json!({ "id": "u1", "name": "Alice", "email": "a@a.com", "companyId": "comp1" }),
    )
    .unwrap();
    db.create(
        "posts",
        json!({ "id": "post1", "title": "Alpha", "authorId": "u1" }),
    )
    .unwrap();
    db.create(
        "comments",
        json!({ "id": "cm1", "content": "Hi", "postId": "post1" }),
    )
    .unwrap();

    // Delete post1 with Cascade on comments (which is append-only)
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("comments".to_string(), CascadeOption::Cascade)]
            .into_iter()
            .collect(),
    };

    let result = db
        .delete_with_relationships("posts", "post1", opts)
        .expect("cascade on append-only target must succeed");

    // cm1 must actually be REMOVED (not silently failed)
    assert!(
        db.collection("comments").unwrap().get("cm1").is_none(),
        "cm1 must be removed by hard cascade even though comments is append-only"
    );

    // Cascade result must reflect 1 deleted child
    let cascaded = result.cascaded.expect("cascaded Some");
    let entry = cascaded.get("comments").expect("comments cascade entry");
    assert_eq!(
        entry.count, 1,
        "count must reflect actually removed entities"
    );
}

// ── Item 5: Owner soft-delete without deletedAt schema ────────────────────

/// TS `deleteWithRelationships` uses `hasSoftDelete = typeof entity === "object"`,
/// which is ALWAYS true for any entity object — it does NOT check for a
/// `deletedAt` schema field.  The engine must match: soft-delete the owner via
/// direct patch regardless of whether the schema declares `deletedAt`.
/// Currently `Collection::delete_with_options(id, true)` fails without schema.
/// RED.
#[test]
fn delete_owner_soft_without_deleted_at_schema_succeeds() {
    use proseql_engine::descriptor::ValidationMode;

    let reg = Arc::new(CallbackRegistry::new());

    // companies schema has no deletedAt field
    let comp_desc = companies_descriptor();
    let clock = || Box::new(FixedClock::new("2024-02-01T00:00:00.000Z"));

    let mut cols = IndexMap::new();
    cols.insert(
        "companies".to_string(),
        Collection::new_with_clock(
            "companies",
            comp_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("c")),
            clock(),
        ),
    );
    cols.insert(
        "users".to_string(),
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("u")),
            clock(),
        ),
    );
    cols.insert(
        "posts".to_string(),
        Collection::new_with_clock(
            "posts",
            posts_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("p")),
            clock(),
        ),
    );
    cols.insert(
        "comments".to_string(),
        Collection::new_with_clock(
            "comments",
            comments_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("cm")),
            clock(),
        ),
    );

    let mut db = Database::new(cols, Arc::clone(&reg));
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();

    // Soft-delete comp1 — companies schema has no deletedAt
    let opts = DeleteRelationshipsOptions {
        soft: true,
        limit: None,
        include: HashMap::new(),
    };

    let result = db
        .delete_with_relationships("companies", "comp1", opts)
        .expect("soft-delete owner must work even without deletedAt in schema");

    // Returned deleted entity must have deletedAt patched
    assert!(
        result
            .deleted
            .get("deletedAt")
            .and_then(|v| v.as_str())
            .is_some(),
        "deleted entity must have deletedAt set: {:?}",
        result.deleted
    );
    // Entity stays in the collection (soft-deleted, not hard-deleted)
    let comp = db
        .collection("companies")
        .unwrap()
        .get("comp1")
        .expect("comp1 must stay in collection after soft-delete");
    assert_eq!(
        comp["deletedAt"], "2024-02-01T00:00:00.000Z",
        "comp1.deletedAt must be patched: {comp:?}"
    );
}

/// Same soft-delete bypass for `delete_many_with_relationships`.
#[test]
fn delete_many_owner_soft_without_deleted_at_schema_succeeds() {
    let reg = Arc::new(CallbackRegistry::new());
    let clock = || Box::new(FixedClock::new("2024-02-01T00:00:00.000Z"));

    let mut cols = IndexMap::new();
    cols.insert(
        "companies".to_string(),
        Collection::new_with_clock(
            "companies",
            companies_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("c")),
            clock(),
        ),
    );
    cols.insert(
        "users".to_string(),
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("u")),
            clock(),
        ),
    );
    cols.insert(
        "posts".to_string(),
        Collection::new_with_clock(
            "posts",
            posts_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("p")),
            clock(),
        ),
    );
    cols.insert(
        "comments".to_string(),
        Collection::new_with_clock(
            "comments",
            comments_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("cm")),
            clock(),
        ),
    );

    let mut db = Database::new(cols, Arc::clone(&reg));
    db.create("companies", json!({ "id": "comp1", "name": "TechCorp" }))
        .unwrap();
    db.create("companies", json!({ "id": "comp2", "name": "DataInc" }))
        .unwrap();

    let opts = DeleteRelationshipsOptions {
        soft: true,
        limit: None,
        include: HashMap::new(),
    };

    let result = db
        .delete_many_with_relationships("companies", &|_| true, opts)
        .expect("soft delete_many must work without deletedAt schema");

    assert_eq!(result.count, 2);
    // Both companies must still exist (soft-deleted, not removed)
    let comp1 = db
        .collection("companies")
        .unwrap()
        .get("comp1")
        .expect("comp1 must remain after soft delete_many");
    assert!(
        comp1["deletedAt"].as_str().is_some(),
        "comp1.deletedAt must be patched: {comp1:?}"
    );
}

// ── Item 6: Restrict ValidationError.message is joined violation messages ──

/// TS `deleteWithRelationships` builds the `ValidationError.message` by joining
/// all violation messages: `restrictViolations.map(v => v.message).join("; ")`.
/// Currently the engine uses a fixed generic string.  RED.
#[test]
fn restrict_validation_error_message_is_joined_violation_messages() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    let err = db
        .delete_with_relationships("users", "user1", opts)
        .expect_err("restrict must fail");

    if let EngineError::Validation(v) = err {
        // message == joined issue messages
        let joined = v
            .issues
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        assert_eq!(
            v.message, joined,
            "ValidationError.message must equal joined issue messages.\n  got: {:?}\n  want: {:?}",
            v.message, joined
        );
    } else {
        panic!("expected ValidationError");
    }
}

/// Same contract for `delete_many_with_relationships`.  RED.
#[test]
fn delete_many_restrict_message_is_joined_violation_messages() {
    let mut db = seeded_db();
    let opts = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::Restrict)]
            .into_iter()
            .collect(),
    };

    // user1 (2 posts) and user2 (1 post) both have children → 2 violations
    let err = db
        .delete_many_with_relationships("users", &|e| e["companyId"] == "comp1", opts)
        .expect_err("restrict must fail");

    if let EngineError::Validation(v) = err {
        let joined = v
            .issues
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        assert_eq!(
            v.message, joined,
            "delete_many ValidationError.message must equal joined issue messages.\n  got: {:?}\n  want: {:?}",
            v.message, joined
        );
    } else {
        panic!("expected ValidationError");
    }
}

// ── Item 7: CursorPageResult / CursorPageInfo Serialize → camelCase JSON ──

/// `CursorPageResult` and `CursorPageInfo` must serialize to camelCase JSON so
/// the U8 boundary can send them over the WASM wire.
/// Currently the types do not derive Serialize.  RED (compile-time unless added
/// incrementally; this test will fail at runtime once derived without rename).
#[test]
fn cursor_page_result_serializes_to_camel_case_json() {
    use proseql_engine::query::{CursorConfig, CursorPageInfo, CursorPageResult};

    let result = CursorPageResult {
        items: vec![json!({"id": "1"})],
        page_info: CursorPageInfo {
            start_cursor: Some("abc".into()),
            end_cursor: Some("xyz".into()),
            has_next_page: true,
            has_previous_page: false,
        },
    };

    let v: Value = serde_json::to_value(&result).expect("CursorPageResult must be Serialize");

    assert!(v.get("items").is_some(), "items key must be present");
    let pi = v
        .get("pageInfo")
        .expect("pageInfo must be camelCase (not page_info)");
    assert!(
        pi.get("startCursor").is_some(),
        "startCursor must be camelCase: {pi:?}"
    );
    assert!(
        pi.get("endCursor").is_some(),
        "endCursor must be camelCase: {pi:?}"
    );
    assert!(
        pi.get("hasNextPage").is_some(),
        "hasNextPage must be camelCase: {pi:?}"
    );
    assert!(
        pi.get("hasPreviousPage").is_some(),
        "hasPreviousPage must be camelCase: {pi:?}"
    );
    // Original snake_case keys must NOT be present
    assert!(
        pi.get("start_cursor").is_none(),
        "snake_case must not appear"
    );
    assert!(
        pi.get("has_next_page").is_none(),
        "snake_case must not appear"
    );
}

/// Round-trip: deserialize → re-serialize → same shape.
#[test]
fn cursor_page_result_round_trips_through_serde() {
    use proseql_engine::query::{CursorConfig, CursorPageInfo, CursorPageResult};

    let original = CursorPageResult {
        items: vec![json!({"id": "1"}), json!({"id": "2"})],
        page_info: CursorPageInfo {
            start_cursor: Some("s1".into()),
            end_cursor: Some("s2".into()),
            has_next_page: false,
            has_previous_page: true,
        },
    };

    let json_str = serde_json::to_string(&original).expect("serialize");
    let decoded: CursorPageResult = serde_json::from_str(&json_str).expect("deserialize");

    assert_eq!(decoded.items, original.items);
    assert_eq!(
        decoded.page_info.start_cursor,
        original.page_info.start_cursor
    );
    assert_eq!(
        decoded.page_info.has_next_page,
        original.page_info.has_next_page
    );
}

// ── Item 8: No fabricated singularized FK for CRUD inverse ops ─────────────

/// When an Inverse relationship has neither an explicit `foreign_key` nor a
/// reverse-Ref back to the parent collection, `resolve_inv_fk_crud` returns
/// `None`. In that case:
///
/// - `create_with_relationships` must still create the child entities but MUST
///   NOT inject a fabricated FK field.
/// - The fabricated `{parentName}Id` the old code produced is wrong.
#[test]
fn inverse_create_no_fk_resolution_creates_child_without_injecting_fk() {
    use proseql_engine::descriptor::ValidationMode;

    let reg = Arc::new(CallbackRegistry::new());
    let clock = || Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    // "groups" → inverse "widgets" (explicit FK None, no back-ref on widgets)
    let groups_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    // !! Include groupId? so fabricated FK is NOT stripped by schema — making the test RED.
    // Without this field, schema would strip the fabricated "groupId" automatically.
    let widgets_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "label".into(),
                schema: SchemaNode::Str,
            },
            // groupId is declared so schema KEEPS it if injected (exposes the bug)
            StructField {
                name: "groupId".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };

    let mk_desc = |name: &str, schema, rels| CollectionDescriptor {
        name: name.into(),
        schema,
        id_strategy: IdStrategy::Provided,
        relationships: rels,
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let groups_desc = mk_desc(
        "groups",
        groups_schema,
        vec![(
            "widgets".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Inverse,
                target: "widgets".into(),
                foreign_key: None, // no explicit FK, no back-Ref on widgets
            },
        )],
    );
    let widgets_desc = mk_desc("widgets", widgets_schema, vec![]); // NO back-Ref to groups

    let mut cols = IndexMap::new();
    cols.insert(
        "groups".into(),
        Collection::new_with_clock(
            "groups",
            groups_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("g")),
            clock(),
        ),
    );
    cols.insert(
        "widgets".into(),
        Collection::new_with_clock(
            "widgets",
            widgets_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("w")),
            clock(),
        ),
    );

    let mut db = Database::new(cols, Arc::clone(&reg));

    // Create a group with a nested widget — no FK can be resolved
    db.create_with_relationships(
        "groups",
        json!({
            "id": "g1",
            "name": "TestGroup",
            "widgets": { "$create": { "id": "w1", "label": "Widget1" } }
        }),
    )
    .expect("create with no-FK inverse must succeed (child created without FK)");

    // The supplied id is overwritten, but the widget must exist.
    let w1 = db
        .collection("widgets")
        .unwrap()
        .list()
        .into_iter()
        .find(|widget| widget["label"] == "Widget1")
        .expect("widget must be created");
    assert_ne!(w1["id"], "w1");
    // w1 must NOT have the fabricated "groupId" field injected.
    // (The schema DOES allow groupId? so if fabricated it would be kept.)
    assert!(
        w1.get("groupId").is_none(),
        "fabricated 'groupId' must NOT be injected when FK cannot be resolved: {w1:?}"
    );
    // g1 must exist
    assert!(db.collection("groups").unwrap().get("g1").is_some());
}

/// When an inverse relationship's FK cannot be resolved (`None`), the update
/// `$connect` operation must be silently skipped (not inject fabricated FK).
/// Currently the engine fabricates `{parentName}Id` → injects a wrong field. RED.
#[test]
fn inverse_update_connect_no_fk_resolution_skips_state_change() {
    use proseql_engine::descriptor::ValidationMode;

    let reg = Arc::new(CallbackRegistry::new());
    let clock = || Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    let mk_desc = |name: &str, schema, rels| CollectionDescriptor {
        name: name.into(),
        schema,
        id_strategy: IdStrategy::Provided,
        relationships: rels,
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let groups_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let widgets_schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "label".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };

    let groups_desc = mk_desc(
        "groups",
        groups_schema,
        vec![(
            "widgets".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Inverse,
                target: "widgets".into(),
                foreign_key: None,
            },
        )],
    );
    let widgets_desc = mk_desc("widgets", widgets_schema, vec![]); // no back-Ref

    let mut cols = IndexMap::new();
    cols.insert(
        "groups".into(),
        Collection::new_with_clock(
            "groups",
            groups_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("g")),
            clock(),
        ),
    );
    cols.insert(
        "widgets".into(),
        Collection::new_with_clock(
            "widgets",
            widgets_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("w")),
            clock(),
        ),
    );

    let mut db = Database::new(cols, Arc::clone(&reg));
    db.create("groups", json!({ "id": "g1", "name": "TestGroup" }))
        .unwrap();
    db.create("widgets", json!({ "id": "w1", "label": "Widget1" }))
        .unwrap();

    // $connect w1 to g1 via inverse — but no FK can be resolved → should be skipped
    let result = db.update_with_relationships(
        "groups",
        "g1",
        json!({ "widgets": { "$connect": { "id": "w1" } } }),
    );

    assert!(
        result.is_ok(),
        "no-FK inverse $connect must succeed (skip gracefully): {:?}",
        result
    );

    // w1 must NOT have any fabricated FK field injected
    let w1 = db.collection("widgets").unwrap().get("w1").unwrap();
    assert!(
        w1.get("groupsId").is_none(),
        "fabricated 'groupsId' must NOT be injected: {w1:?}"
    );
    assert!(
        w1.get("groupId").is_none(),
        "fabricated 'groupId' must NOT be injected: {w1:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// POST-COMMIT U4 RESIDUALS (items 1–6)
// ═══════════════════════════════════════════════════════════════════════════

// ── Item 1: Unknown/Num schema FK → JS String(value) coercion + FK error ──

/// When the FK field's schema is `Unknown` (accepts any value), a numeric `42`
/// passes schema validation.  FK check then coerces `42 → "42"` via
/// `JS String(value)` and looks up the target.  No entity has id="42" →
/// `ForeignKeyError`.
///
/// This proves the JS-coercion path operates on the DECODED entity after schema
/// succeeds, and is distinct from the `NullOr(Str)` case (which fails schema).
#[test]
fn fk_unknown_schema_numeric_fk_is_coerced_and_fails_foreign_key_error() {
    use proseql_engine::descriptor::ValidationMode;

    let reg = Arc::new(CallbackRegistry::new());
    let clock = || Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    // Schema with authorId: Unknown (accepts 42)
    let posts_schema_unknown = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "title".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "authorId".into(),
                // Unknown accepts any value, including numeric 42
                schema: SchemaNode::Optional(Box::new(SchemaNode::Unknown)),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };

    let posts_desc = CollectionDescriptor {
        name: "posts".into(),
        schema: posts_schema_unknown,
        id_strategy: IdStrategy::Provided,
        relationships: vec![(
            "author".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Ref,
                target: "users".into(),
                foreign_key: Some("authorId".into()),
            },
        )],
        indexes: vec![],
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
        validation_mode: ValidationMode::Strict,
    };

    let mut cols = IndexMap::new();
    cols.insert(
        "posts".into(),
        Collection::new_with_clock(
            "posts",
            posts_desc,
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("p")),
            clock(),
        ),
    );
    cols.insert(
        "users".into(),
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("u")),
            clock(),
        ),
    );
    cols.insert(
        "companies".into(),
        Collection::new_with_clock(
            "companies",
            companies_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("c")),
            clock(),
        ),
    );
    cols.insert(
        "comments".into(),
        Collection::new_with_clock(
            "comments",
            comments_descriptor(),
            Arc::clone(&reg),
            Box::new(SequentialGenerator::new("cm")),
            clock(),
        ),
    );
    let mut db = Database::new(cols, Arc::clone(&reg));

    // No users exist → FK lookup for "42" (coerced from 42) fails
    let err = db
        .create("posts", json!({ "id": "px", "title": "T", "authorId": 42 }))
        .expect_err("Unknown-schema FK: 42 passes schema but must fail FK lookup");

    assert!(
        matches!(err, EngineError::ForeignKey(_)),
        "expected ForeignKeyError after JS-coercion lookup (42 → '42'), got: {err:?}"
    );
    if let EngineError::ForeignKey(ref fk) = err {
        assert_eq!(
            fk.value, "42",
            "ForeignKeyError.value must be JS String(42)='42', got: {}",
            fk.value
        );
    }
    // Entity must NOT have been persisted (delete_raw removes it on FK failure)
    assert!(
        db.collection("posts").unwrap().get("px").is_none(),
        "entity must not remain in collection after FK failure"
    );
}

// ── Item 2: update_with_relationships step 10 uses shallow merge (no ops) ──

/// When `update_with_relationships` receives a base update containing
/// operator syntax like `{ "title": { "$append": " suffix" } }`, the TS
/// `Object.assign` step (step 10) sets `entity.title = { "$append": " suffix" }`
/// literally — not executing the operator.  Schema then sees an Object where
/// `Str` is expected and returns `ValidationError`.
///
/// With the old deep-merge (`col.update`), the `$append` operator WOULD be
/// executed, yielding `title = "Alpha suffix"` (success instead of error).
#[test]
fn update_with_relationships_base_update_uses_shallow_not_deep_merge() {
    let mut db = seeded_db();

    // { "title": { "$append": " suffix" } } — operator syntax in base update
    // Shallow (TS): title = { "$append": " suffix" } → schema rejects Object for Str
    // Deep (old):   title = "Alpha suffix" → schema accepts → success
    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "title": { "$append": " suffix" } }),
        )
        .expect_err(
            "operator-syntax value in base update must fail schema validation (shallow merge)",
        );

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError (shallow: title becomes Object), got: {err:?}"
    );

    // State must be unchanged
    let post = db.collection("posts").unwrap().get("post1").unwrap();
    assert_eq!(
        post["title"], "Alpha",
        "post1.title must be unchanged after schema failure: {post:?}"
    );
}

/// When `update_with_relationships` receives a nested `$update` for a ref
/// relationship, the target entity's update also uses `Object.assign` (shallow
/// merge), not `deepMergeUpdates`.
///
/// `{ "author": { "$update": { "name": { "$append": "!" } } } }`
/// - Shallow: user1.name = `{ "$append": "!" }` → schema rejects Object for Str → error
/// - Deep (old): `$append` on "Alice" → "Alice!" → schema accepts → success
#[test]
fn update_nested_ref_update_uses_shallow_not_deep_merge() {
    let mut db = seeded_db();

    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$update": { "name": { "$append": "!" } } } }),
        )
        .expect_err(
            "operator-syntax value in $update data must fail schema (shallow merge on target)",
        );

    assert!(
        matches!(err, EngineError::Validation(_)),
        "expected ValidationError from shallow-merge $update on user1, got: {err:?}"
    );

    // user1 must be unchanged
    let user1 = db.collection("users").unwrap().get("user1").unwrap();
    assert_eq!(
        user1["name"], "Alice",
        "user1.name must be unchanged after shallow $update schema failure: {user1:?}"
    );
}

// ── Item 5: ForeignKeyError.value shape ─────────────────────────────────────

/// When a ref `$connect { id: "ghost" }` fails because the entity does not
/// exist, `ForeignKeyError.value` must be the BARE id string `"ghost"` — not
/// the JSON representation `{"id":"ghost"}`.
#[test]
fn fk_connect_error_value_is_bare_id_for_id_based_connect() {
    let mut db = seeded_db();

    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$connect": { "id": "ghost-user" } } }),
        )
        .expect_err("$connect nonexistent id must fail");

    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(
            fk.value, "ghost-user",
            "ForeignKeyError.value must be bare id 'ghost-user', not JSON. Got: '{}'",
            fk.value
        );
    } else {
        panic!("expected ForeignKeyError");
    }
}

/// When a ref `$connect` uses an arbitrary field match (no `id` key) and no
/// entity matches, `ForeignKeyError.value` must be the compact JSON string
/// representation of the connect input, mirroring `JSON.stringify`.
#[test]
fn fk_connect_error_value_is_compact_json_for_arbitrary_field_connect() {
    let mut db = seeded_db();

    // No user has name="Ghost"
    let err = db
        .update_with_relationships(
            "posts",
            "post1",
            json!({ "author": { "$connect": { "name": "Ghost" } } }),
        )
        .expect_err("$connect with no id and no matching entity must fail");

    if let EngineError::ForeignKey(fk) = err {
        assert_eq!(
            fk.value, r#"{"name":"Ghost"}"#,
            "ForeignKeyError.value must be compact JSON for arbitrary-field connect. Got: '{}'",
            fk.value
        );
    } else {
        panic!("expected ForeignKeyError");
    }
}

// ── Item 6: Missing target collection → CollectionNotFound ──────────────────

/// When the ref FK is a non-null string but the target COLLECTION is absent
/// from the database (descriptor references a collection that was never added),
/// `populate` must return `CollectionNotFound` — not `DanglingReferenceError`
/// and not a silent skip.
///
/// This is a descriptor misconfiguration, not a dangling entity reference.
#[test]
fn populate_ref_missing_target_collection_is_collection_not_found() {
    // Build a database with ONLY "posts" — no "users" collection.
    // Then create a post with authorId="u1" directly via Collection::create
    // (bypassing Database::create's FK check) and try to populate "author".
    let reg = Arc::new(CallbackRegistry::new());
    let clock = Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    let mut posts_col = Collection::new_with_clock(
        "posts",
        posts_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("p")),
        clock,
    );
    // Direct Collection::create bypasses FK validation — creates post with
    // authorId pointing to a "users" collection that will not exist in the DB.
    posts_col
        .create(json!({ "id": "post1", "title": "T", "authorId": "u1" }))
        .expect("Collection::create succeeds without FK check");

    let mut cols = IndexMap::new();
    cols.insert("posts".into(), posts_col);
    // Deliberately omit "users" collection
    let db = Database::new(cols, Arc::clone(&reg));

    let err = db
        .query(
            "posts",
            QueryInput {
                r#where: Some(json!({ "id": "post1" })),
                ..QueryInput::default()
            },
            Some(json!({ "author": true })),
        )
        .expect_err("missing target collection must return CollectionNotFound");

    assert!(
        matches!(err, EngineError::CollectionNotFound(_)),
        "expected CollectionNotFound when 'users' collection is absent, got: {err:?}"
    );
}

/// Same contract for inverse populate: when the target collection for an
/// inverse relationship is absent, `CollectionNotFound` is returned rather
/// than silently returning an empty array.
#[test]
fn populate_inverse_missing_target_collection_is_collection_not_found() {
    // Build a database with ONLY "users" — no "posts" collection.
    // The users descriptor has an inverse "posts" rel pointing to "posts".
    let reg = Arc::new(CallbackRegistry::new());
    let clock = Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"));

    let mut users_col = Collection::new_with_clock(
        "users",
        users_descriptor(),
        Arc::clone(&reg),
        Box::new(SequentialGenerator::new("u")),
        clock,
    );
    users_col
        .create(json!({
            "id": "user1", "name": "Alice", "email": "a@a.com",
            "companyId": null
        }))
        .expect("Collection::create succeeds");

    let mut cols = IndexMap::new();
    cols.insert("users".into(), users_col);
    // Deliberately omit "posts" (and all other) collections
    let db = Database::new(cols, Arc::clone(&reg));

    let err = db
        .query(
            "users",
            QueryInput::default(),
            Some(json!({ "posts": true })),
        )
        .expect_err("missing target collection must return CollectionNotFound");

    assert!(
        matches!(err, EngineError::CollectionNotFound(_)),
        "expected CollectionNotFound when 'posts' collection is absent, got: {err:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// FINAL U4 CREATE/OWNER DELETE ORDERING
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn create_ref_shorthand_resolves_id_and_arbitrary_fields() {
    let mut db = seeded_db();

    let by_id = db
        .create_with_relationships(
            "posts",
            json!({ "id": "post4", "title": "By id", "author": { "id": "user2" } }),
        )
        .expect("id shorthand connect");
    assert_eq!(by_id["authorId"], "user2");

    let by_email = db
        .create_with_relationships(
            "posts",
            json!({
                "id": "post5",
                "title": "By arbitrary field",
                "author": { "email": "alice@example.com" }
            }),
        )
        .expect("arbitrary-field shorthand connect");
    assert_eq!(by_email["authorId"], "user1");
    assert!(by_email.get("author").is_none());
}

#[test]
fn create_inverse_connect_failure_precedes_parent_write_but_keeps_nested_create() {
    let mut db = seeded_db();

    let error = db
        .create_with_relationships(
            "users",
            json!({
                "id": "user4",
                "name": "Dana",
                "email": "dana@example.com",
                "companyId": "comp1",
                "posts": {
                    "$create": { "id": "post4", "title": "Nested" },
                    "$connect": { "id": "missing-post" }
                }
            }),
        )
        .expect_err("missing inverse connect must fail before parent write");

    assert!(matches!(error, EngineError::ForeignKey(_)));
    assert!(db.collection("users").unwrap().get("user4").is_none());
    let nested = db
        .collection("posts")
        .unwrap()
        .list()
        .into_iter()
        .find(|post| post["title"] == "Nested")
        .expect("nested side effect remains");
    assert_ne!(nested["id"], "post4");
    assert_eq!(nested["authorId"], "user4");
}

#[test]
fn relationship_create_schema_error_precedes_duplicate_and_foreign_key_errors() {
    let mut db = seeded_db();

    let error = db
        .create_with_relationships(
            "posts",
            json!({ "id": "post1", "title": 42, "authorId": "missing-user" }),
        )
        .expect_err("schema must be evaluated first");

    assert!(matches!(error, EngineError::Validation(_)), "got {error:?}");
    if let EngineError::Validation(error) = error {
        assert!(error.issues.iter().any(|issue| issue.field == "title"));
    }
}

#[test]
fn relationship_create_duplicate_precedes_foreign_key_error_and_has_ts_shape() {
    let mut db = seeded_db();

    let error = db
        .create_with_relationships(
            "posts",
            json!({ "id": "post1", "title": "Duplicate", "authorId": "missing-user" }),
        )
        .expect_err("duplicate must be checked before FK validation");

    match error {
        EngineError::Validation(error) => {
            assert_eq!(
                error.message,
                "Entity with ID 'post1' already exists in 'posts'"
            );
            assert_eq!(error.issues.len(), 1);
            assert_eq!(error.issues[0].field, "id");
            assert_eq!(
                error.issues[0].message,
                "Entity with ID post1 already exists"
            );
            assert_eq!(error.issues[0].value, Some(json!("post1")));
        }
        other => panic!("expected relationship ValidationError, got {other:?}"),
    }
}

#[test]
fn relationship_create_validates_default_produced_foreign_key_and_rolls_back_parent_only() {
    let mut registry = CallbackRegistry::new();
    registry.register_default("missing-author", Box::new(|| json!("missing-user")));
    let registry = Arc::new(registry);

    let mut posts = posts_descriptor();
    if let SchemaNode::Struct { fields } = &mut posts.schema {
        let author_id = fields
            .iter_mut()
            .find(|field| field.name == "authorId")
            .expect("authorId schema");
        author_id.schema = SchemaNode::OptionalWithDefault {
            inner: Box::new(SchemaNode::Str),
            default_callback_id: "missing-author".into(),
        };
    }

    let mut collections = IndexMap::new();
    collections.insert(
        "users".into(),
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("u")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    collections.insert(
        "posts".into(),
        Collection::new_with_clock(
            "posts",
            posts,
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("p")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    let mut db = Database::new(collections, registry);

    let error = db
        .create_with_relationships("posts", json!({ "id": "post-default", "title": "Default" }))
        .expect_err("default-produced missing FK must fail");

    match error {
        EngineError::ForeignKey(error) => assert_eq!(error.value, "missing-user"),
        other => panic!("expected ForeignKeyError, got {other:?}"),
    }
    assert!(db
        .collection("posts")
        .unwrap()
        .get("post-default")
        .is_none());
}

fn append_only_users_db() -> Database {
    let registry = Arc::new(CallbackRegistry::new());
    let mut users = users_descriptor();
    users.append_only = true;

    let mut collections = IndexMap::new();
    collections.insert(
        "users".into(),
        Collection::new_with_clock(
            "users",
            users,
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("u")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    collections.insert(
        "posts".into(),
        Collection::new_with_clock(
            "posts",
            posts_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("p")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
    );
    let mut db = Database::new(collections, registry);
    db.create(
        "users",
        json!({ "id": "user1", "name": "Alice", "email": "alice@example.com", "companyId": null }),
    )
    .expect("seed append-only owner");
    db
}

#[test]
fn relationship_single_hard_delete_bypasses_append_only_on_owner() {
    let mut db = append_only_users_db();
    let result = db
        .delete_with_relationships("users", "user1", DeleteRelationshipsOptions::default())
        .expect("relationship delete bypasses append-only owner guard");
    assert_eq!(result.deleted["id"], "user1");
    assert!(db.collection("users").unwrap().get("user1").is_none());
}

#[test]
fn relationship_many_hard_delete_bypasses_append_only_on_owner() {
    let mut db = append_only_users_db();
    let result = db
        .delete_many_with_relationships(
            "users",
            &|entity| entity["id"] == "user1",
            DeleteRelationshipsOptions::default(),
        )
        .expect("relationship delete-many bypasses append-only owner guard");
    assert_eq!(result.count, 1);
    assert_eq!(result.deleted[0]["id"], "user1");
    assert!(db.collection("users").unwrap().get("user1").is_none());
}
