//! Relationship-aware create semantics.

use serde_json::{Map, Value};

use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{EngineError, ForeignKeyError, ValidationError, ValidationIssue};
use crate::query::matches_where;
use crate::reactive::ChangeOperation;

use super::helpers::{
    col_nf, connect_fk_error_value, op_err, ref_fk, require_obj, resolve_connect,
    resolve_inv_fk_crud, validate_fk,
};
use super::Database;

impl Database {
    // ── Relationship-aware create ─────────────────────────────────────────────

    /// Create an entity with relationship operations in TS order:
    ///
    ///  1. Reserve parent id (BEFORE any nested side-effects)
    ///  2. Process Ref `$create` / `$connectOrCreate` → create nested, inject FK
    ///  3. Process Inverse `$create` / `$createMany` → create children with FK=parent_id
    ///  4. Process Inverse `$connectOrCreate`:
    ///       - existing → add to deferred connect list
    ///       - missing  → create child with FK=parent_id (BEFORE parent)
    ///  5. Process Ref `$connect` → resolve ID, inject FK; propagate ForeignKeyError
    ///  6. FK-validate assembled base_data
    ///  7. Create parent (reserved id is in base_data)
    ///  8. Apply deferred inverse connects → patch_raw FK=parent_id
    ///
    /// Nested creates (steps 2-4) happen BEFORE parent validation and survive
    /// parent failure, exactly as in the TS implementation.
    pub fn create_with_relationships(
        &mut self,
        collection: &str,
        data: Value,
    ) -> Result<Value, EngineError> {
        let rels: Vec<(String, RelationshipDescriptor)> = {
            let col = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?;
            col.descriptor.relationships.clone()
        };

        let data_obj = require_obj(data, "create_with_relationships")?;
        let rel_set: std::collections::HashSet<&str> =
            rels.iter().map(|(n, _)| n.as_str()).collect();

        let mut base_data: Map<String, Value> = Map::new();
        // (fk_field, target_col, op_value) for ref relationships
        let mut ref_create_ops: Vec<(String, String, Value)> = vec![];
        let mut ref_connect_ops: Vec<(String, String, Value)> = vec![];
        // (Option<fk_field>, target_col, items): None fk_field → create child WITHOUT FK injection
        let mut inv_create_ops: Vec<(Option<String>, String, Vec<Value>)> = vec![];
        // (Option<fk_field>, target_col, where_clause, create_data): None → create without FK
        let mut inv_coc_ops: Vec<(Option<String>, String, Value, Value)> = vec![];
        // (fk_field, target_col, connect_input) for inverse connects.
        // Inputs are resolved before the parent is written, then patched afterward.
        let mut inv_connect_ops: Vec<(String, String, Value)> = vec![];
        let mut partial_side_effects = false;

        for (key, value) in data_obj {
            if rel_set.contains(key.as_str()) {
                // Safety: key is in rel_set iff it's in rels
                let Some((_, desc)) = rels.iter().find(|(n, _)| n == &key) else {
                    continue;
                };
                match desc.kind {
                    RelationshipKind::Ref => {
                        let fk = ref_fk(&key, &desc.foreign_key);
                        let Some(op_obj) = value.as_object() else {
                            continue;
                        };
                        let is_operation = op_obj.keys().any(|name| name.starts_with('$'));
                        if !is_operation {
                            // Shorthand ConnectInput: `{ author: { id: "u1" } }` or
                            // `{ author: { email: "a@example.com" } }`.
                            ref_connect_ops.push((fk, desc.target.clone(), value));
                        } else {
                            if op_obj.contains_key("$create")
                                || op_obj.contains_key("$connectOrCreate")
                            {
                                ref_create_ops.push((
                                    fk.clone(),
                                    desc.target.clone(),
                                    value.clone(),
                                ));
                            }
                            if let Some(connect) = op_obj.get("$connect") {
                                ref_connect_ops.push((fk, desc.target.clone(), connect.clone()));
                            }
                        }
                    }
                    RelationshipKind::Inverse => {
                        // Resolve the FK field that children carry on the target collection.
                        // If resolution fails (None), do NOT fabricate a singularized FK.
                        // TS: `findForeignKey` returns null when no FK can be determined;
                        // the CRUD helpers then skip or omit FK injection entirely.
                        let maybe_fk = resolve_inv_fk_crud(desc, collection, &self.collections);
                        let Some(op_obj) = value.as_object() else {
                            continue;
                        };

                        for items_val in [op_obj.get("$create"), op_obj.get("$createMany")]
                            .into_iter()
                            .flatten()
                        {
                            let items: Vec<Value> = if let Some(arr) = items_val.as_array() {
                                arr.clone()
                            } else {
                                vec![items_val.clone()]
                            };
                            inv_create_ops.push((maybe_fk.clone(), desc.target.clone(), items));
                        }
                        if let Some(coc_val) = op_obj.get("$connectOrCreate") {
                            let coc_list: Vec<&Value> = if let Some(arr) = coc_val.as_array() {
                                arr.iter().collect()
                            } else {
                                vec![coc_val]
                            };
                            for coc in coc_list {
                                let Some(where_clause) = coc.get("where") else {
                                    continue;
                                };
                                let Some(create_data) = coc.get("create") else {
                                    continue;
                                };
                                inv_coc_ops.push((
                                    maybe_fk.clone(),
                                    desc.target.clone(),
                                    where_clause.clone(),
                                    create_data.clone(),
                                ));
                            }
                        }
                        if let (Some(fk), Some(connect)) = (maybe_fk, op_obj.get("$connect")) {
                            inv_connect_ops.push((fk, desc.target.clone(), connect.clone()));
                        }
                        // None FK → silently skip connect (TS no-op).
                    }
                }
            } else {
                base_data.insert(key, value);
            }
        }

        // ── Step 1: Reserve parent ID ──────────────────────────────────────────
        let parent_id: String = if let Some(Value::String(id)) = base_data.get("id") {
            id.clone()
        } else {
            self.collections
                .get_mut(collection)
                .ok_or_else(|| col_nf(collection))?
                .reserve_id()
        };
        // Inject reserved id so create() uses this exact id
        base_data.insert("id".to_string(), Value::String(parent_id.clone()));

        // ── Step 2: Ref $create / $connectOrCreate ─────────────────────────────
        for (fk_field, target_col, op) in &ref_create_ops {
            let Some(op_obj) = op.as_object() else {
                continue;
            };
            if let Some(create_data) = op_obj.get("$create") {
                let nested = match create_nested(self, target_col, create_data.clone()) {
                    Ok(nested) => nested,
                    Err(error) => {
                        if partial_side_effects {
                            self.sync_reactive_snapshots();
                        }
                        return Err(error);
                    }
                };
                partial_side_effects = true;
                let nid = nested["id"]
                    .as_str()
                    .ok_or_else(|| {
                        op_err("create_with_relationships", "$create entity missing id")
                    })?
                    .to_string();
                base_data.insert(fk_field.clone(), Value::String(nid));
            } else if let Some(coc) = op_obj.get("$connectOrCreate") {
                let where_clause = coc.get("where").ok_or_else(|| {
                    op_err(
                        "create_with_relationships",
                        "$connectOrCreate.where required",
                    )
                })?;
                let create_data = coc.get("create").ok_or_else(|| {
                    op_err(
                        "create_with_relationships",
                        "$connectOrCreate.create required",
                    )
                })?;
                let found_id: Option<String> =
                    self.collections.get(target_col.as_str()).and_then(|tc| {
                        tc.list()
                            .into_iter()
                            .find(|e| matches_where(e, where_clause))
                            .and_then(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
                    });
                let connected_id = if let Some(id) = found_id {
                    id
                } else {
                    let nested = match create_nested(self, target_col, create_data.clone()) {
                        Ok(nested) => nested,
                        Err(error) => {
                            if partial_side_effects {
                                self.sync_reactive_snapshots();
                            }
                            return Err(error);
                        }
                    };
                    partial_side_effects = true;
                    nested["id"]
                        .as_str()
                        .ok_or_else(|| {
                            op_err(
                                "create_with_relationships",
                                "$connectOrCreate created entity missing id",
                            )
                        })?
                        .to_string()
                };
                base_data.insert(fk_field.clone(), Value::String(connected_id));
            }
        }

        // ── Step 3: Inverse $create / $createMany (BEFORE parent) ─────────────
        // When FK is None (unresolvable), still create child entities but do NOT
        // inject a fabricated FK (TS: create proceeds; no foreign key set).
        for (maybe_fk, target_col, items) in inv_create_ops {
            for mut item in items {
                if let (Some(fk_field), Some(obj)) = (&maybe_fk, item.as_object_mut()) {
                    obj.insert(fk_field.clone(), Value::String(parent_id.clone()));
                }
                match create_nested(self, &target_col, item) {
                    Ok(_) => partial_side_effects = true,
                    Err(error) => {
                        if partial_side_effects {
                            self.sync_reactive_snapshots();
                        }
                        return Err(error);
                    }
                }
            }
        }

        // ── Step 4: Inverse $connectOrCreate (BEFORE parent) ──────────────────
        // Existing inverse matches are left unchanged by the TS implementation.
        // Missing matches create a child with FK=parent_id when the FK is known.
        for (maybe_fk, target_col, where_clause, create_data) in inv_coc_ops {
            let found_id: Option<String> =
                self.collections.get(target_col.as_str()).and_then(|tc| {
                    tc.list()
                        .into_iter()
                        .find(|e| matches_where(e, &where_clause))
                        .and_then(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
                });

            if found_id.is_none() {
                let mut child_data = require_obj(create_data, "inverse $connectOrCreate create")?;
                if let Some(fk_field) = &maybe_fk {
                    child_data.insert(fk_field.clone(), Value::String(parent_id.clone()));
                }
                match create_nested(self, &target_col, Value::Object(child_data)) {
                    Ok(_) => partial_side_effects = true,
                    Err(error) => {
                        if partial_side_effects {
                            self.sync_reactive_snapshots();
                        }
                        return Err(error);
                    }
                }
            }
        }
        // ── Step 5a: Ref connects → resolve + inject FK ───────────────────────
        for (fk_field, target_col, connect) in &ref_connect_ops {
            match resolve_connect(connect, target_col, &self.collections) {
                Ok(tid) => {
                    base_data.insert(fk_field.clone(), Value::String(tid));
                }
                Err(e) => {
                    if partial_side_effects {
                        self.sync_reactive_snapshots();
                    }
                    return Err(EngineError::ForeignKey(Box::new(ForeignKeyError {
                        collection: collection.to_string(),
                        field: fk_field.clone(),
                        value: connect_fk_error_value(connect),
                        target_collection: target_col.clone(),
                        message: format!(
                            "$connect: could not resolve target in '{}': {}",
                            target_col, e
                        ),
                    })));
                }
            }
        }

        // ── Step 5b: Resolve ALL inverse connects before writing parent ───────
        let mut resolved_inv_connects: Vec<(String, String, String)> = vec![];
        for (fk_field, target_col, connect_value) in &inv_connect_ops {
            let connects: Vec<&Value> = if let Some(array) = connect_value.as_array() {
                array.iter().collect()
            } else {
                vec![connect_value]
            };
            for connect in connects {
                match resolve_connect(connect, target_col, &self.collections) {
                    Ok(target_id) => resolved_inv_connects.push((
                        fk_field.clone(),
                        target_col.clone(),
                        target_id,
                    )),
                    Err(reason) => {
                        if partial_side_effects {
                            self.sync_reactive_snapshots();
                        }
                        return Err(EngineError::ForeignKey(Box::new(ForeignKeyError {
                            collection: collection.to_string(),
                            field: fk_field.clone(),
                            value: connect_fk_error_value(connect),
                            target_collection: target_col.clone(),
                            message: format!(
                                "inverse $connect: could not resolve target in '{}': {}",
                                target_col, reason
                            ),
                        })));
                    }
                }
            }
        }

        // ── Step 6: Schema/default decode, then duplicate, then FK ─────────────
        let create_result = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .create(Value::Object(base_data));
        let parent = match create_result {
            Ok(parent) => parent,
            Err(EngineError::DuplicateKey(error)) => {
                if partial_side_effects {
                    self.sync_reactive_snapshots();
                }
                return Err(EngineError::Validation(ValidationError {
                    message: format!(
                        "Entity with ID '{}' already exists in '{}'",
                        error.value, collection
                    ),
                    issues: vec![ValidationIssue {
                        field: "id".to_string(),
                        message: format!("Entity with ID {} already exists", error.value),
                        value: Some(Value::String(error.value)),
                        expected: None,
                        received: None,
                    }],
                }));
            }
            Err(error) => {
                if partial_side_effects {
                    self.sync_reactive_snapshots();
                }
                return Err(error);
            }
        };

        // FK validation must inspect the decoded entity so default-produced FKs
        // participate. Roll back only the parent on failure; nested effects remain.
        if let Err(error) = validate_fk(collection, &rels, &parent, &self.collections) {
            if let Some(parent_collection) = self.collections.get_mut(collection) {
                parent_collection.delete_raw(&parent_id);
            }
            if partial_side_effects {
                self.sync_reactive_snapshots();
            }
            return Err(error);
        }

        // ── Step 8: Patch pre-resolved inverse connects ───────────────────────
        for (fk_field, target_col, target_id) in resolved_inv_connects {
            let now = self
                .collections
                .get(target_col.as_str())
                .map(|collection| collection.now_iso())
                .unwrap_or_default();
            let mut patch = Map::new();
            patch.insert(fk_field, Value::String(parent_id.clone()));
            patch.insert("updatedAt".to_string(), Value::String(now));
            if let Some(target_collection) = self.collections.get_mut(target_col.as_str()) {
                target_collection.patch_raw(&target_id, patch);
            }
        }

        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Create);
        Ok(parent)
    }
}

/// Nested relationship creates always allocate a fresh id in the TS engine,
/// overwriting any id supplied in the nested payload.
fn create_nested(
    database: &mut Database,
    target_collection: &str,
    input: Value,
) -> Result<Value, EngineError> {
    let mut data = input.as_object().cloned().unwrap_or_default();
    let id = database
        .collections
        .get_mut(target_collection)
        .ok_or_else(|| col_nf(target_collection))?
        .reserve_id();
    data.insert("id".to_string(), Value::String(id));
    database
        .collections
        .get_mut(target_collection)
        .ok_or_else(|| col_nf(target_collection))?
        .create(Value::Object(data))
}
