//! Relationship-aware update semantics.

use serde_json::{Map, Value};

use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{EngineError, ForeignKeyError};
use crate::reactive::ChangeOperation;

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

        let mut base_updates: Map<String, Value> = Map::new();
        let mut pending_parent_fk: Map<String, Value> = Map::new();
        let mut target_ops: Vec<TargetOp> = vec![];
        let mut partial_side_effects = false;

        for (key, value) in updates_obj {
            if !rel_set.contains(key.as_str()) {
                base_updates.insert(key, value);
                continue;
            }

            let Some((_, desc)) = rels.iter().find(|(n, _)| n == &key) else {
                continue;
            };

            match desc.kind {
                RelationshipKind::Ref => {
                    let fk_field = ref_fk(&key, &desc.foreign_key);
                    let target_col = desc.target.clone();

                    if !is_relationship_op(&value) {
                        match resolve_connect(&value, &target_col, &self.collections) {
                            Ok(tid) => {
                                pending_parent_fk.insert(fk_field, Value::String(tid));
                            }
                            Err(e) => {
                                return Err(EngineError::ForeignKey(Box::new(ForeignKeyError {
                                    collection: collection.to_string(),
                                    field: fk_field,
                                    value: connect_fk_error_value(&value),
                                    target_collection: target_col,
                                    message: e,
                                })));
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
                                return Err(EngineError::ForeignKey(Box::new(ForeignKeyError {
                                    collection: collection.to_string(),
                                    field: fk_field.clone(),
                                    value: connect_fk_error_value(cv),
                                    target_collection: target_col.clone(),
                                    message: e,
                                })));
                            }
                        }
                    }
                    if let Some(upd_data) = op_obj.get("$update") {
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
                }
                RelationshipKind::Inverse => {
                    let fk_field = match resolve_inv_fk_crud(desc, collection, &self.collections) {
                        Some(f) => f,
                        None => continue,
                    };
                    let target_col = desc.target.clone();

                    if let Some(op_obj) = value.as_object() {
                        if let Some(set_val) = op_obj.get("$set") {
                            let mut new_ids: Vec<String> = Vec::new();
                            for item in set_val.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                                match resolve_connect(item, &target_col, &self.collections) {
                                    Ok(tid) => new_ids.push(tid),
                                    Err(e) => {
                                        return Err(EngineError::ForeignKey(Box::new(
                                            ForeignKeyError {
                                                collection: collection.to_string(),
                                                field: fk_field.clone(),
                                                value: connect_fk_error_value(item),
                                                target_collection: target_col.clone(),
                                                message: e,
                                            },
                                        )));
                                    }
                                }
                            }
                            let new_id_set: std::collections::HashSet<_> =
                                new_ids.iter().cloned().collect();
                            let current_children =
                                related_entity_ids(&self.collections, &target_col, &fk_field, id);
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

                    let Some(op_obj) = value.as_object() else {
                        continue;
                    };

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
                            let targets: Vec<&Value> = if let Some(arr) = disc_val.as_array() {
                                arr.iter().collect()
                            } else {
                                vec![disc_val]
                            };
                            for target in targets {
                                if let Ok(tid) =
                                    resolve_connect(target, &target_col, &self.collections)
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
                                    return Err(EngineError::ForeignKey(Box::new(
                                        ForeignKeyError {
                                            collection: collection.to_string(),
                                            field: fk_field.clone(),
                                            value: connect_fk_error_value(cv),
                                            target_collection: target_col.clone(),
                                            message: e,
                                        },
                                    )));
                                }
                            }
                        }
                    }

                    if let Some(upd_val) = op_obj.get("$update") {
                        let updates_list: Vec<&Value> = if let Some(arr) = upd_val.as_array() {
                            arr.iter().collect()
                        } else {
                            vec![upd_val]
                        };
                        for update in updates_list {
                            if let (Some(where_clause), Some(data)) =
                                (update.get("where"), update.get("data"))
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
                            }
                        }
                    }

                    if let Some(del_val) = op_obj.get("$delete") {
                        let deletes: Vec<&Value> = if let Some(arr) = del_val.as_array() {
                            arr.iter().collect()
                        } else {
                            vec![del_val]
                        };
                        for delete in deletes {
                            if let Ok(tid) = resolve_connect(delete, &target_col, &self.collections)
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
            }
        }

        for op in target_ops {
            match op {
                TargetOp::SetFk {
                    collection: tc,
                    id: tid,
                    fk_field,
                    fk_value,
                } => {
                    let col = match self.collections.get_mut(tc.as_str()) {
                        Some(col) => col,
                        None => {
                            if partial_side_effects {
                                self.sync_reactive_snapshots();
                            }
                            return Err(col_nf(&tc));
                        }
                    };
                    let apply = if fk_value == Value::Null {
                        col.get(&tid)
                            .and_then(|entity| entity.get(&fk_field))
                            .map(|value| value == &Value::String(id.to_string()))
                            .unwrap_or(false)
                    } else {
                        true
                    };
                    if apply {
                        let now = col.now_iso();
                        let mut patch = Map::new();
                        patch.insert(fk_field, fk_value);
                        patch.insert("updatedAt".to_string(), Value::String(now));
                        if col.patch_raw(&tid, patch) {
                            partial_side_effects = true;
                        }
                    }
                }
                TargetOp::UpdateFields {
                    collection: tc,
                    id: tid,
                    updates,
                } => {
                    let col = match self.collections.get_mut(tc.as_str()) {
                        Some(col) => col,
                        None => {
                            if partial_side_effects {
                                self.sync_reactive_snapshots();
                            }
                            return Err(col_nf(&tc));
                        }
                    };
                    let updates_map = updates.as_object().cloned().unwrap_or_default();
                    match col.update_relationship_shallow(&tid, &updates_map) {
                        Ok(_) => {
                            partial_side_effects = true;
                        }
                        Err(EngineError::NotFound(_)) => {}
                        Err(error) => {
                            if partial_side_effects {
                                self.sync_reactive_snapshots();
                            }
                            return Err(error);
                        }
                    }
                }
            }
        }

        let snapshot = self
            .collections
            .get(collection)
            .and_then(|c| c.snapshot_entity(id));
        let mut merged = pending_parent_fk;
        for (key, value) in base_updates {
            merged.insert(key, value);
        }
        let parent = match self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .update_relationship_shallow(id, &merged)
        {
            Ok(parent) => parent,
            Err(error) => {
                if partial_side_effects {
                    self.sync_reactive_snapshots();
                }
                return Err(error);
            }
        };

        let rels = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        if let Err(error) = validate_fk(collection, &rels, &parent, &self.collections) {
            if let Some(col) = self.collections.get_mut(collection) {
                col.restore_entity_snapshot(id, snapshot);
            }
            if partial_side_effects {
                self.sync_reactive_snapshots();
            }
            return Err(error);
        }

        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Update);
        Ok(parent)
    }
}
