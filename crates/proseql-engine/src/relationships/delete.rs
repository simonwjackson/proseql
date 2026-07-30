//! Relationship-aware delete and cascade semantics.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::collection::Collection;
use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{EngineError, ValidationError, ValidationIssue};
use crate::reactive::ChangeOperation;

use super::helpers::{col_nf, ent_nf, related_entity_ids, resolve_inv_fk_crud};
use super::{
    CascadeOption, CascadedCollection, Database, DeleteManyWithRelResult,
    DeleteRelationshipsOptions, DeleteWithRelResult,
};

impl Database {
    // ── Relationship-aware delete ─────────────────────────────────────────────

    /// Delete an entity with relationship cascade options.
    ///
    /// # Sequential processing (TS artifact)
    ///
    /// Relationships are processed in descriptor order.  For each relationship:
    /// - `Cascade` / `CascadeSoft` / `SetNull` → applied IMMEDIATELY in the loop
    /// - `Restrict` → violation collected, NOT applied yet
    ///
    /// AFTER the loop: if any restrict violations exist, return `ValidationError`.
    /// This means cascade side-effects on earlier entries persist even when a later
    /// restrict fires — exactly as in `processRelationshipCascades` in TS.
    ///
    /// For fully-atomic restrict behaviour, use `delete_many_with_relationships`
    /// with a single-element predicate.
    pub fn delete_with_relationships(
        &mut self,
        collection: &str,
        id: &str,
        opts: DeleteRelationshipsOptions,
    ) -> Result<DeleteWithRelResult, EngineError> {
        // Validate existence up-front
        if self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .get(id)
            .is_none()
        {
            return Err(ent_nf(collection, id));
        }

        let rels: Vec<(String, RelationshipDescriptor)> = {
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .descriptor
                .relationships
                .clone()
        };

        // TS sequential: cascade/set_null applied IMMEDIATELY; restrict collected.
        let mut violations: Vec<ValidationIssue> = vec![];
        let mut cascaded_map: HashMap<String, CascadedCollection> = HashMap::new();

        for (rel_name, rel_desc) in &rels {
            if rel_desc.kind != RelationshipKind::Inverse {
                continue;
            }

            let cascade_opt = opts
                .include
                .get(rel_name.as_str())
                .cloned()
                .unwrap_or(CascadeOption::Preserve);

            if cascade_opt == CascadeOption::Preserve {
                continue;
            }

            let fk_field = match resolve_inv_fk_crud(rel_desc, collection, &self.collections) {
                Some(f) => f,
                None => continue,
            };

            let child_ids = related_entity_ids(&self.collections, &rel_desc.target, &fk_field, id);

            if child_ids.is_empty() {
                continue;
            }

            match cascade_opt {
                CascadeOption::Preserve => {}
                CascadeOption::Restrict => {
                    // Collect violation but do NOT fail yet (keep processing other rels)
                    violations.push(ValidationIssue {
                        field: "relationships".to_string(),
                        message: format!(
                            "Cannot delete '{}': has {} related entities",
                            id,
                            child_ids.len()
                        ),
                        value: None,
                        expected: None,
                        received: None,
                    });
                }
                CascadeOption::Cascade => {
                    // Apply cascade IMMEDIATELY (TS sequential artifact)
                    let is_soft = opts.soft;
                    let now = self
                        .collections
                        .get(&rel_desc.target)
                        .map(|c| c.now_iso())
                        .unwrap_or_default();
                    let entry = cascaded_map
                        .entry(rel_desc.target.clone())
                        .or_insert_with(|| CascadedCollection {
                            count: 0,
                            ids: vec![],
                        });
                    for child_id in &child_ids {
                        if is_soft {
                            let mut patch = Map::new();
                            patch.insert("deletedAt".to_string(), Value::String(now.clone()));
                            patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                            if let Some(col) = self.collections.get_mut(rel_desc.target.as_str()) {
                                col.patch_raw(child_id, patch);
                            }
                            // Soft-delete always succeeds (patch is always applied)
                            entry.count += 1;
                            entry.ids.push(child_id.clone());
                        } else if let Some(col) = self.collections.get_mut(rel_desc.target.as_str())
                        {
                            // Use delete_raw to bypass append-only guard
                            // (mirrors TS `map.delete(id)` direct approach).
                            // Only count/record if the entity was actually removed.
                            if col.delete_raw(child_id).is_some() {
                                entry.count += 1;
                                entry.ids.push(child_id.clone());
                            }
                        }
                    }
                }
                CascadeOption::SetNull => {
                    // Apply set_null IMMEDIATELY
                    let now = self
                        .collections
                        .get(&rel_desc.target)
                        .map(|c| c.now_iso())
                        .unwrap_or_default();
                    for child_id in &child_ids {
                        let mut patch = Map::new();
                        patch.insert(fk_field.clone(), Value::Null);
                        patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                        if let Some(col) = self.collections.get_mut(rel_desc.target.as_str()) {
                            col.patch_raw(child_id, patch);
                        }
                    }
                }
                CascadeOption::CascadeSoft => {
                    // Apply cascade_soft IMMEDIATELY (always soft regardless of opts.soft)
                    let now = self
                        .collections
                        .get(&rel_desc.target)
                        .map(|c| c.now_iso())
                        .unwrap_or_default();
                    let entry = cascaded_map
                        .entry(rel_desc.target.clone())
                        .or_insert_with(|| CascadedCollection {
                            count: 0,
                            ids: vec![],
                        });
                    for child_id in &child_ids {
                        let mut patch = Map::new();
                        patch.insert("deletedAt".to_string(), Value::String(now.clone()));
                        patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                        if let Some(col) = self.collections.get_mut(rel_desc.target.as_str()) {
                            col.patch_raw(child_id, patch);
                        }
                        entry.count += 1;
                        entry.ids.push(child_id.clone());
                    }
                }
            }
        }

        // After loop: fail if any restrict violations were collected.
        // Message is the joined violation messages (mirrors TS join("; ")).
        if !violations.is_empty() {
            let message = violations
                .iter()
                .map(|i| i.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            self.sync_reactive_snapshots();
            return Err(EngineError::Validation(ValidationError {
                message,
                issues: violations,
            }));
        }

        // Delete / soft-delete the owner entity.
        //
        // TS `hasSoftDelete = typeof entity === "object"` is ALWAYS true for
        // any entity object, so soft-delete is applied regardless of schema.
        // We use patch_raw (which bypasses the schema-level `supports_soft_delete`
        // guard) and then remove from state when hard-deleting.
        let deleted = if opts.soft {
            // Soft-delete: patch deletedAt/updatedAt directly, keep entity in state
            let now = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .now_iso();
            let mut patch = Map::new();
            patch.insert("deletedAt".to_string(), Value::String(now.clone()));
            patch.insert("updatedAt".to_string(), Value::String(now));
            self.collections
                .get_mut(collection)
                .ok_or_else(|| col_nf(collection))?
                .patch_raw(id, patch);
            self.collections
                .get(collection)
                .and_then(|c| c.get(id).cloned())
                .ok_or_else(|| ent_nf(collection, id))?
        } else {
            // TS removes directly from the state map, bypassing append-only guards.
            self.collections
                .get_mut(collection)
                .ok_or_else(|| col_nf(collection))?
                .delete_raw(id)
                .ok_or_else(|| ent_nf(collection, id))?
        };

        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Delete);
        Ok(DeleteWithRelResult {
            deleted,
            cascaded: if cascaded_map.is_empty() {
                None
            } else {
                Some(cascaded_map)
            },
        })
    }

    /// Delete multiple entities matching `predicate` with relationship cascade.
    ///
    /// **Fully atomic restrict**: ALL restrict violations across ALL matched entities
    /// are evaluated before ANY mutation (different from single delete which is sequential).
    ///
    /// `opts.limit` (> 0) is applied BEFORE restrict checks (mirrors TS step 2).
    pub fn delete_many_with_relationships(
        &mut self,
        collection: &str,
        predicate: &dyn Fn(&Value) -> bool,
        opts: DeleteRelationshipsOptions,
    ) -> Result<DeleteManyWithRelResult, EngineError> {
        let mut matching: Vec<(String, Value)> = {
            let col = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?;
            col.list()
                .into_iter()
                .filter(|e| predicate(e))
                .map(|e| {
                    let eid = e
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    (eid, e.clone())
                })
                .collect()
        };

        // TS step 2: apply limit BEFORE restrict / cascade checks
        if let Some(lim) = opts.limit {
            if lim > 0 {
                matching.truncate(lim);
            }
        }

        if matching.is_empty() {
            return Ok(DeleteManyWithRelResult::default());
        }

        let rels: Vec<(String, RelationshipDescriptor)> = {
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .descriptor
                .relationships
                .clone()
        };

        // Build cascade plans for all matched entities (read-only phase).
        let plans: Vec<EntityCascadePlan> = matching
            .iter()
            .map(|(entity_id, _)| EntityCascadePlan {
                entity_id: entity_id.clone(),
                entries: build_cascade_plan(
                    entity_id,
                    collection,
                    &rels,
                    &opts.include,
                    &self.collections,
                ),
            })
            .collect();

        // Atomicity: check ALL restrict violations before ANY mutation.
        let mut violations: Vec<ValidationIssue> = vec![];
        for plan in &plans {
            for entry in &plan.entries {
                if entry.option == CascadeOption::Restrict && !entry.child_ids.is_empty() {
                    violations.push(ValidationIssue {
                        field: "relationships".to_string(),
                        message: format!(
                            "Cannot delete '{}': has {} related entities",
                            plan.entity_id,
                            entry.child_ids.len()
                        ),
                        value: None,
                        expected: None,
                        received: None,
                    });
                }
            }
        }
        if !violations.is_empty() {
            let message = violations
                .iter()
                .map(|i| i.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(EngineError::Validation(ValidationError {
                message,
                issues: violations,
            }));
        }

        let mut aggregated: HashMap<String, CascadedCollection> = HashMap::new();
        let mut deleted_entities: Vec<Value> = vec![];

        for plan in plans {
            let entity_id = plan.entity_id;
            for cascade in plan.entries {
                let target_col = cascade.target_collection;
                let child_ids = cascade.child_ids;
                let fk_field = cascade.foreign_key;
                match cascade.option {
                    CascadeOption::Preserve | CascadeOption::Restrict => {}
                    CascadeOption::Cascade => {
                        let is_soft = opts.soft;
                        let now = self
                            .collections
                            .get(&target_col)
                            .map(|c| c.now_iso())
                            .unwrap_or_default();
                        let entry = aggregated.entry(target_col.clone()).or_insert_with(|| {
                            CascadedCollection {
                                count: 0,
                                ids: vec![],
                            }
                        });
                        for child_id in &child_ids {
                            if is_soft {
                                let mut patch = Map::new();
                                patch.insert("deletedAt".to_string(), Value::String(now.clone()));
                                patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                                if let Some(col) = self.collections.get_mut(target_col.as_str()) {
                                    col.patch_raw(child_id, patch);
                                }
                                entry.count += 1;
                                entry.ids.push(child_id.clone());
                            } else if let Some(col) = self.collections.get_mut(target_col.as_str())
                            {
                                // Use delete_raw to bypass append-only guard.
                                // Only count/record if actually removed.
                                if col.delete_raw(child_id).is_some() {
                                    entry.count += 1;
                                    entry.ids.push(child_id.clone());
                                }
                            }
                        }
                    }
                    CascadeOption::SetNull => {
                        let now = self
                            .collections
                            .get(&target_col)
                            .map(|c| c.now_iso())
                            .unwrap_or_default();
                        for child_id in &child_ids {
                            let mut patch = Map::new();
                            patch.insert(fk_field.clone(), Value::Null);
                            patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                            if let Some(col) = self.collections.get_mut(target_col.as_str()) {
                                col.patch_raw(child_id, patch);
                            }
                        }
                    }
                    CascadeOption::CascadeSoft => {
                        let now = self
                            .collections
                            .get(&target_col)
                            .map(|c| c.now_iso())
                            .unwrap_or_default();
                        let entry = aggregated.entry(target_col.clone()).or_insert_with(|| {
                            CascadedCollection {
                                count: 0,
                                ids: vec![],
                            }
                        });
                        for child_id in &child_ids {
                            let mut patch = Map::new();
                            patch.insert("deletedAt".to_string(), Value::String(now.clone()));
                            patch.insert("updatedAt".to_string(), Value::String(now.clone()));
                            if let Some(col) = self.collections.get_mut(target_col.as_str()) {
                                col.patch_raw(child_id, patch);
                            }
                            entry.count += 1;
                            entry.ids.push(child_id.clone());
                        }
                    }
                }
            }

            // Soft/hard delete owner (schema-agnostic, mirrors TS hasSoftDelete)
            let deleted = if opts.soft {
                let now = self
                    .collections
                    .get(collection)
                    .ok_or_else(|| col_nf(collection))?
                    .now_iso();
                let mut patch = Map::new();
                patch.insert("deletedAt".to_string(), Value::String(now.clone()));
                patch.insert("updatedAt".to_string(), Value::String(now));
                self.collections
                    .get_mut(collection)
                    .ok_or_else(|| col_nf(collection))?
                    .patch_raw(&entity_id, patch);
                self.collections
                    .get(collection)
                    .and_then(|c| c.get(&entity_id).cloned())
                    .ok_or_else(|| ent_nf(collection, &entity_id))?
            } else {
                self.collections
                    .get_mut(collection)
                    .ok_or_else(|| col_nf(collection))?
                    .delete_raw(&entity_id)
                    .ok_or_else(|| ent_nf(collection, &entity_id))?
            };
            deleted_entities.push(deleted);
        }

        self.sync_reactive_snapshots();
        if !deleted_entities.is_empty() {
            self.emit_owner_change_event(collection, ChangeOperation::Delete);
        }
        Ok(DeleteManyWithRelResult {
            count: deleted_entities.len(),
            deleted: deleted_entities,
            cascaded: if aggregated.is_empty() {
                None
            } else {
                Some(aggregated)
            },
        })
    }
}

// ── Cascade plan ──────────────────────────────────────────────────────────────

/// Cascade work for one inverse relationship in `delete_many`.
struct CascadePlanEntry {
    target_collection: String,
    child_ids: Vec<String>,
    foreign_key: String,
    option: CascadeOption,
}

/// Cascade work for one owner entity in `delete_many`.
struct EntityCascadePlan {
    entity_id: String,
    entries: Vec<CascadePlanEntry>,
}

/// Build the cascade plan for a single entity delete (used by delete_many only).
///
/// Only Inverse relationships participate in cascade (Ref FK disappears with entity).
/// Results are keyed by **target collection** (not relationship name).
fn build_cascade_plan(
    entity_id: &str,
    parent_col_name: &str,
    relationships: &[(String, RelationshipDescriptor)],
    opts_include: &HashMap<String, CascadeOption>,
    all_collections: &IndexMap<String, Collection>,
) -> Vec<CascadePlanEntry> {
    let mut plan = Vec::new();

    for (rel_name, rel_desc) in relationships {
        if rel_desc.kind != RelationshipKind::Inverse {
            continue;
        }

        let opt = opts_include
            .get(rel_name)
            .cloned()
            .unwrap_or(CascadeOption::Preserve);

        if opt == CascadeOption::Preserve {
            continue;
        }

        let fk_field = match resolve_inv_fk_crud(rel_desc, parent_col_name, all_collections) {
            Some(f) => f,
            None => continue,
        };

        let child_ids = related_entity_ids(all_collections, &rel_desc.target, &fk_field, entity_id);

        plan.push(CascadePlanEntry {
            target_collection: rel_desc.target.clone(),
            child_ids,
            foreign_key: fk_field,
            option: opt,
        });
    }

    plan
}
