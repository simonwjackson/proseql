//! Relationship-aware update semantics.

use serde_json::{Map, Value};

use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{EngineError, ForeignKeyError};

use super::helpers::{
    col_nf, connect_fk_error_value, ent_nf, is_relationship_op, ref_fk, related_entity_ids,
    require_obj, resolve_connect, resolve_inv_fk_crud, validate_fk,
};
use super::Database;

/// Target mutation executed before the parent update is validated.
enum TargetOp {
    SetFk {
        collection: String,
        id: String,
        fk_field: String,
        fk_value: Value,
    },
    UpdateFields {
        collection: String,
        id: String,
        updates: Value,
    },
}

impl Database {
    // ── Relationship-aware update ─────────────────────────────────────────────

    /// Update an entity with relationship operations.
    ///
    /// TS steps 5-9 (target mutations) are applied BEFORE step 10 (validate+write
    /// parent).  If step 10 succeeds at the schema level but fails FK validation,
    /// the parent entity is restored to its pre-step-10 snapshot; target side-effects
    /// from steps 5-9 persist (exact TS behaviour).
    ///
    /// **Ref operations:**
    /// - Shorthand (no `$` keys) → treated as direct `$connect`
    /// - `$connect { id }` → inject FK into pending parent updates
    /// - `$disconnect true` → inject FK=null into pending parent updates
    /// - `$update { ... }` → update the entity referenced by current FK; propagates errors
    /// - `$delete true` → NO-OP (TS type allows it; only inverse $delete acts)
    ///
    /// **Inverse operations:**
    /// - `$set [...]` → exclusive: disconnect old children (FK=null), connect new (FK=parent_id)
    /// - `$disconnect true` → FK=null on ALL current children
    /// - `$disconnect <ConnectInput>` → FK=null on targeted children (if still parent's)
    /// - `$connect <ConnectInput|Array>` → FK=parent_id on target; propagates ForeignKeyError
    /// - `$update { where, data }` → update matched child; unresolved `where` silently skipped
    /// - `$delete <ConnectInput>` → FK=null on specific child if still parent's
    pub fn update_with_relationships(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        let current: Value = {
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .get(id)
                .ok_or_else(|| ent_nf(collection, id))?
                .clone()
        };

        let rels: Vec<(String, RelationshipDescriptor)> = {
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .descriptor
                .relationships
                .clone()
        };

        let updates_obj = require_obj(updates, "update_with_relationships")?;
        let rel_set: std::collections::HashSet<&str> =
            rels.iter().map(|(n, _)| n.as_str()).collect();

        // FK changes and plain updates to be applied to the parent in step 10
        let mut base_updates: Map<String, Value> = Map::new();
        let mut pending_parent_fk: Map<String, Value> = Map::new();

        // Target mutations collected for steps 5-9 execution BEFORE parent validation.
        let mut target_ops: Vec<TargetOp> = vec![];

        for (key, value) in updates_obj {
            if !rel_set.contains(key.as_str()) {
                base_updates.insert(key, value);
                continue;
            }

            // Safety: key is in rel_set iff it's in rels
            let Some((_, desc)) = rels.iter().find(|(n, _)| n == &key) else {
                continue;
            };

            match desc.kind {
                RelationshipKind::Ref => {
                    let fk_field = ref_fk(&key, &desc.foreign_key);
                    let target_col = desc.target.clone();

                    // Shorthand: no $ keys → treat value itself as a ConnectInput
                    if !is_relationship_op(&value) {
                        match resolve_connect(&value, &target_col, &self.collections) {
                            Ok(tid) => {
                                pending_parent_fk.insert(fk_field, Value::String(tid));
                            }
                            Err(e) => {
                                return Err(EngineError::ForeignKey(ForeignKeyError {
                                    collection: collection.to_string(),
                                    field: fk_field,
                                    value: connect_fk_error_value(&value),
                                    target_collection: target_col,
                                    message: e,
                                }));
                            }
                        }
                        continue;
                    }

                    let Some(op_obj) = value.as_object() else {
                        continue;
                    };

                    if op_obj.contains_key("$disconnect") {
                        pending_parent_fk.insert(fk_field.clone(), Value::Null);
                    }
                    if let Some(cv) = op_obj.get("$connect") {
                        match resolve_connect(cv, &target_col, &self.collections) {
                            Ok(tid) => {
                                pending_parent_fk.insert(fk_field.clone(), Value::String(tid));
                            }
                            Err(e) => {
                                // error.field = FK field name, NOT the connect value
                                return Err(EngineError::ForeignKey(ForeignKeyError {
                                    collection: collection.to_string(),
                                    field: fk_field.clone(),
                                    value: connect_fk_error_value(cv),
                                    target_collection: target_col.clone(),
                                    message: e,
                                }));
                            }
                        }
                    }
                    if let Some(upd_data) = op_obj.get("$update") {
                        // Find current FK value (post disconnect/connect)
                        let current_fk = pending_parent_fk
                            .get(&fk_field)
                            .cloned()
                            .or_else(|| current.get(&fk_field).cloned());
                        if let Some(Value::String(tid)) = current_fk {
                            target_ops.push(TargetOp::UpdateFields {
                                collection: target_col,
                                id: tid,
                                updates: upd_data.clone(),
                            });
                        }
                    }
                    // $delete on ref → NO-OP (TS type accepts it; only inverse $delete acts)
                }

                RelationshipKind::Inverse => {
                    // When FK cannot be resolved, skip ALL state changes for this
                    // relationship (TS: `if (!foreignKey) continue`).
                    let fk_field = match resolve_inv_fk_crud(desc, collection, &self.collections) {
                        Some(f) => f,
                        None => continue, // no FK → skip silently, no state change
                    };
                    let target_col = desc.target.clone();

                    // $set has exclusive priority for this relationship key
                    if let Some(op_obj) = value.as_object() {
                        if let Some(set_val) = op_obj.get("$set") {
                            // $set: propagate ForeignKeyError for unresolvable items
                            let mut new_ids: Vec<String> = Vec::new();
                            for item in set_val.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                                match resolve_connect(item, &target_col, &self.collections) {
                                    Ok(tid) => new_ids.push(tid),
                                    Err(e) => {
                                        return Err(EngineError::ForeignKey(ForeignKeyError {
                                            collection: collection.to_string(),
                                            field: fk_field.clone(),
                                            value: connect_fk_error_value(item),
                                            target_collection: target_col.clone(),
                                            message: e,
                                        }));
                                    }
                                }
                            }
                            let new_id_set: std::collections::HashSet<_> =
                                new_ids.iter().cloned().collect();

                            // Collect current children
                            let current_children =
                                related_entity_ids(&self.collections, &target_col, &fk_field, id);

                            // Disconnect children NOT in the new set
                            for old_id in &current_children {
                                if !new_id_set.contains(old_id) {
                                    target_ops.push(TargetOp::SetFk {
                                        collection: target_col.clone(),
                                        id: old_id.clone(),
                                        fk_field: fk_field.clone(),
                                        fk_value: Value::Null,
                                    });
                                }
                            }
                            // Connect ALL new items (TS: always re-set even if already connected)
                            for new_id in new_ids {
                                target_ops.push(TargetOp::SetFk {
                                    collection: target_col.clone(),
                                    id: new_id,
                                    fk_field: fk_field.clone(),
                                    fk_value: Value::String(id.to_string()),
                                });
                            }
                            continue;
                        }
                    }

                    // All other inverse ops
                    let Some(op_obj) = value.as_object() else {
                        continue;
                    };

                    // $disconnect: true → null FK on ALL current children of this parent
                    // $disconnect: <ConnectInput> → targeted null FK (TS del[] semantics)
                    if let Some(disc_val) = op_obj.get("$disconnect") {
                        if disc_val == &Value::Bool(true) {
                            let current_children =
                                related_entity_ids(&self.collections, &target_col, &fk_field, id);
                            for child_id in current_children {
                                target_ops.push(TargetOp::SetFk {
                                    collection: target_col.clone(),
                                    id: child_id,
                                    fk_field: fk_field.clone(),
                                    fk_value: Value::Null,
                                });
                            }
                        } else {
                            // Targeted disconnect; silently skip unresolvable (TS: catchTag)
                            let targets: Vec<&Value> = if let Some(arr) = disc_val.as_array() {
                                arr.iter().collect()
                            } else {
                                vec![disc_val]
                            };
                            for t in targets {
                                if let Ok(tid) = resolve_connect(t, &target_col, &self.collections)
                                {
                                    target_ops.push(TargetOp::SetFk {
                                        collection: target_col.clone(),
                                        id: tid,
                                        fk_field: fk_field.clone(),
                                        fk_value: Value::Null,
                                    });
                                }
                            }
                        }
                    }

                    // $connect → propagate ForeignKeyError (TS: no catchTag)
                    if let Some(conn_val) = op_obj.get("$connect") {
                        let connects: Vec<&Value> = if let Some(arr) = conn_val.as_array() {
                            arr.iter().collect()
                        } else {
                            vec![conn_val]
                        };
                        for cv in connects {
                            match resolve_connect(cv, &target_col, &self.collections) {
                                Ok(tid) => {
                                    target_ops.push(TargetOp::SetFk {
                                        collection: target_col.clone(),
                                        id: tid,
                                        fk_field: fk_field.clone(),
                                        fk_value: Value::String(id.to_string()),
                                    });
                                }
                                Err(e) => {
                                    return Err(EngineError::ForeignKey(ForeignKeyError {
                                        collection: collection.to_string(),
                                        field: fk_field.clone(),
                                        value: connect_fk_error_value(cv),
                                        target_collection: target_col.clone(),
                                        message: e,
                                    }));
                                }
                            }
                        }
                    }

                    // $update: unresolved where silently skipped (TS: catchTag ForeignKeyError)
                    // but resolved update errors propagate
                    if let Some(upd_val) = op_obj.get("$update") {
                        let updates_list: Vec<&Value> = if let Some(arr) = upd_val.as_array() {
                            arr.iter().collect()
                        } else {
                            vec![upd_val]
                        };
                        for u in updates_list {
                            if let (Some(where_clause), Some(data)) =
                                (u.get("where"), u.get("data"))
                            {
                                if let Ok(tid) =
                                    resolve_connect(where_clause, &target_col, &self.collections)
                                {
                                    target_ops.push(TargetOp::UpdateFields {
                                        collection: target_col.clone(),
                                        id: tid,
                                        updates: data.clone(),
                                    });
                                }
                                // unresolved where → silently skip (TS: catchTag ForeignKeyError)
                            }
                        }
                    }

                    // $delete: targeted null FK (TS del[] semantics); silently skip unresolvable
                    if let Some(del_val) = op_obj.get("$delete") {
                        let deletes: Vec<&Value> = if let Some(arr) = del_val.as_array() {
                            arr.iter().collect()
                        } else {
                            vec![del_val]
                        };
                        for d in deletes {
                            if let Ok(tid) = resolve_connect(d, &target_col, &self.collections) {
                                target_ops.push(TargetOp::SetFk {
                                    collection: target_col.clone(),
                                    id: tid,
                                    fk_field: fk_field.clone(),
                                    fk_value: Value::Null,
                                });
                            }
                        }
                    }
                }
            }
        }

        // ── Execute target ops BEFORE parent validation (steps 5-9) ───────────
        for op in target_ops {
            match op {
                TargetOp::SetFk {
                    collection: tc,
                    id: tid,
                    fk_field,
                    fk_value,
                } => {
                    // Missing target collection is a misconfigured descriptor → typed error
                    let col = self
                        .collections
                        .get_mut(tc.as_str())
                        .ok_or_else(|| col_nf(&tc))?;

                    // For null FK ops (targeted disconnect / $delete): only apply if
                    // the entity currently belongs to this parent.
                    let apply = if fk_value == Value::Null {
                        col.get(&tid)
                            .and_then(|e| e.get(&fk_field))
                            .map(|v| v == &Value::String(id.to_string()))
                            .unwrap_or(false)
                    } else {
                        true
                    };
                    if apply {
                        // Trusted patch (mirrors TS `Ref.update` direct map mutation).
                        // Include `updatedAt` from the target collection's clock
                        // (TS: `{ ...existing, [foreignKey]: parentId, updatedAt: now }`).
                        let now = col.now_iso();
                        let mut patch = Map::new();
                        patch.insert(fk_field, fk_value);
                        patch.insert("updatedAt".to_string(), Value::String(now));
                        col.patch_raw(&tid, patch);
                    }
                }
                TargetOp::UpdateFields {
                    collection: tc,
                    id: tid,
                    updates,
                } => {
                    // Missing target collection → typed error
                    let col = self
                        .collections
                        .get_mut(tc.as_str())
                        .ok_or_else(|| col_nf(&tc))?;
                    // Use shallow merge (TS: `Object.assign(existing, data)`) — not deep
                    // operator merge.  Operators in `data` are literal values, stripped by
                    // schema validation.
                    // Missing target entity → silently skip (TS: `if (!targetEntity) continue`).
                    // Other errors (Validation, etc.) propagate.
                    let updates_map = match updates.as_object() {
                        Some(m) => m.clone(),
                        None => Map::new(),
                    };
                    match col.update_relationship_shallow(&tid, &updates_map) {
                        Ok(_) => {}
                        Err(EngineError::NotFound(_)) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
        }

        // ── Step 10: merge FK changes + base updates, validate, write parent ───
        //
        // TS: `Object.assign(updatedEntity, baseUpdate); updatedEntity.updatedAt = now;`
        // Operators in base_updates are treated as literal values (NOT executed).
        let parent = if base_updates.is_empty() && pending_parent_fk.is_empty() {
            // No parent field changes — just return (possibly side-effected) parent
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .get(id)
                .ok_or_else(|| ent_nf(collection, id))?
                .clone()
        } else {
            // Take snapshot BEFORE applying parent changes (for FK rollback)
            let snapshot = self
                .collections
                .get(collection)
                .and_then(|c| c.snapshot_entity(id));

            // Merge pending FK patches with base updates (shallow, no operators)
            let mut merged = pending_parent_fk;
            for (k, v) in base_updates {
                merged.insert(k, v);
            }
            // Use shallow merge for step 10 (mirrors TS Object.assign + schema decode)
            let result = self
                .collections
                .get_mut(collection)
                .ok_or_else(|| col_nf(collection))?
                .update_relationship_shallow(id, &merged)?;

            // Validate ALL Ref FKs on the resulting parent entity
            let rels = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .descriptor
                .relationships
                .clone();
            if let Err(fk_err) = validate_fk(collection, &rels, &result, &self.collections) {
                // Restore parent to pre-step-10 snapshot; target side-effects persist
                if let Some(col) = self.collections.get_mut(collection) {
                    col.restore_entity_snapshot(id, snapshot);
                }
                return Err(fk_err);
            }

            result
        };

        Ok(parent)
    }
}
