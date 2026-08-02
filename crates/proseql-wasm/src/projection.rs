use std::collections::HashMap;

use proseql_engine::{change_set::ChangeSet, relationships::Database};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
struct RowSlot {
    generation: u32,
    revision: u32,
    collection_index: u32,
    materialized: bool,
    positioned: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MaterializedProjection {
    slots: Vec<RowSlot>,
    by_collection: HashMap<String, HashMap<String, u32>>,
    collection_indices: HashMap<String, u32>,
    free: Vec<u32>,
    last_sync: Value,
}

impl MaterializedProjection {
    pub fn from_database(db: &Database, collections: &[String]) -> Self {
        let mut projection = Self {
            last_sync: json!({"changes": []}),
            ..Self::default()
        };
        projection.collection_indices = collections
            .iter()
            .enumerate()
            .map(|(index, collection)| (collection.clone(), index as u32))
            .collect();
        for collection in collections {
            if let Some(rows) = db.collection(collection) {
                for row in rows.list() {
                    if let Some(id) = row.get("id").and_then(Value::as_str) {
                        projection.allocate(collection, id);
                    }
                }
            }
        }
        projection
    }

    fn find(&self, collection: &str, id: &str) -> Option<usize> {
        self.by_collection
            .get(collection)?
            .get(id)
            .copied()
            .map(|slot| slot as usize)
    }

    fn allocate(&mut self, collection: &str, id: &str) -> usize {
        let collection_index = self
            .collection_indices
            .get(collection)
            .copied()
            .unwrap_or(u32::MAX);
        let slot = if let Some(slot) = self.free.pop() {
            let row_slot = &mut self.slots[slot as usize];
            row_slot.revision = 1;
            row_slot.collection_index = collection_index;
            row_slot.materialized = false;
            row_slot.positioned = false;
            slot
        } else {
            let slot = u32::try_from(self.slots.len()).expect("projection slot capacity exceeded");
            self.slots.push(RowSlot {
                generation: 1,
                revision: 1,
                collection_index,
                materialized: false,
                positioned: false,
            });
            slot
        };
        self.by_collection
            .entry(collection.to_owned())
            .or_default()
            .insert(id.to_owned(), slot);
        slot as usize
    }

    fn remove(&mut self, collection: &str, id: &str) -> Option<usize> {
        let slot = self.by_collection.get_mut(collection)?.remove(id)?;
        let metadata = &mut self.slots[slot as usize];
        metadata.generation = metadata.generation.saturating_add(1);
        metadata.revision = 0;
        metadata.materialized = false;
        metadata.positioned = false;
        self.free.push(slot);
        Some(slot as usize)
    }

    fn handle(&self, slot: usize) -> String {
        let metadata = &self.slots[slot];
        format!("{slot}:{}:{}", metadata.generation, metadata.revision)
    }

    fn descriptor_for_storage_id(
        &mut self,
        db: &Database,
        collection: &str,
        storage_id: &str,
        value: Value,
    ) -> Value {
        let Some(slot) = self.find(collection, storage_id) else {
            return json!([Value::Null, value]);
        };
        let canonical = db
            .collection(collection)
            .and_then(|rows| rows.get(storage_id));
        if canonical != Some(&value) {
            return json!([Value::Null, value]);
        }
        if self.slots[slot].materialized {
            json!(slot)
        } else {
            self.slots[slot].materialized = true;
            json!([slot, storage_id, value])
        }
    }

    fn descriptor_for_query_value(
        &mut self,
        db: &Database,
        collection: &str,
        value: Value,
    ) -> Value {
        let Some(rows) = db.collection(collection) else {
            return json!([Value::Null, value]);
        };
        let storage_id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| rows.get(id) == Some(&value))
            .map(str::to_owned)
            .or_else(|| rows.storage_id_for_value(&value).map(str::to_owned));
        match storage_id {
            Some(id) => self.descriptor_for_storage_id(db, collection, &id, value),
            None => json!([Value::Null, value]),
        }
    }

    pub fn describe_contiguous_query(
        &mut self,
        db: &Database,
        collection: &str,
        offset: usize,
        len: usize,
    ) -> Value {
        let Some(rows) = db.collection(collection) else {
            return json!({"k": "c", "o": offset, "l": 0});
        };
        let mut additions = Vec::new();
        for (position, (storage_id, value)) in rows.entries().enumerate().skip(offset).take(len) {
            let Some(slot) = self.find(collection, storage_id) else {
                continue;
            };
            if !self.slots[slot].positioned || !self.slots[slot].materialized {
                let row = self.descriptor_for_storage_id(db, collection, storage_id, value.clone());
                self.slots[slot].positioned = true;
                additions.push(json!([position, row]));
            }
        }
        let mut descriptor = json!({
            "k": "c",
            "o": offset,
            "l": len,
            "t": rows.len(),
            "v": rows.revision(),
        });
        if !additions.is_empty() {
            descriptor["a"] = Value::Array(additions);
        }
        descriptor
    }

    pub fn describe_result(
        &mut self,
        db: &Database,
        method: &str,
        collection: &str,
        requested_id: Option<&str>,
        result: Value,
    ) -> Value {
        match (method, result) {
            ("findById", value) => {
                let row = if let Some(id) = requested_id {
                    self.descriptor_for_storage_id(db, collection, id, value)
                } else {
                    self.descriptor_for_query_value(db, collection, value)
                };
                json!({"k": "f", "r": row})
            }
            ("query", Value::Array(values)) => json!({
                "k": "q",
                "r": values.into_iter().map(|value| self.descriptor_for_query_value(db, collection, value)).collect::<Vec<_>>(),
            }),
            (_, value) => value,
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn materialized_slots_for_positions(
        &self,
        db: &Database,
        collection: &str,
        positions: &[usize],
    ) -> Option<Vec<u32>> {
        let rows = db.collection(collection)?;
        positions
            .iter()
            .map(|position| {
                let (id, _) = rows.entry_at(*position)?;
                let slot = self.find(collection, id)?;
                self.slots.get(slot)?.materialized.then_some(slot as u32)
            })
            .collect()
    }

    pub fn fast_find_authorized(&self, expected_slot: u32, authorization_token: f64) -> bool {
        const TOKEN_RADIX: u64 = 1 << 21;
        if !authorization_token.is_finite()
            || authorization_token < 0.0
            || authorization_token.fract() != 0.0
            || authorization_token > (1u64 << 52) as f64
        {
            return false;
        }
        let packed = authorization_token as u64;
        let expected_revision = (packed % TOKEN_RADIX) as u32;
        let collection_and_generation = packed / TOKEN_RADIX;
        let expected_generation = (collection_and_generation % TOKEN_RADIX) as u32;
        let collection_index = (collection_and_generation / TOKEN_RADIX) as u32;
        self.slots
            .get(expected_slot as usize)
            .is_some_and(|metadata| {
                metadata.materialized
                    && metadata.collection_index == collection_index
                    && metadata.generation == expected_generation
                    && metadata.revision == expected_revision
            })
    }

    pub fn authorizes(&self, collection: &str, id: &str, handle: &str) -> bool {
        self.find(collection, id)
            .is_some_and(|slot| self.handle(slot) == handle && self.slots[slot].materialized)
    }

    pub fn reset_materializations(&mut self) {
        for slot in &mut self.slots {
            slot.materialized = false;
            slot.positioned = false;
        }
    }

    pub fn handles(&self, collections: &[String]) -> Value {
        let mut output = Map::new();
        for collection in collections {
            let rows = self
                .by_collection
                .get(collection)
                .into_iter()
                .flatten()
                .map(|(id, slot)| {
                    json!({
                        "id": id,
                        "handle": self.handle(*slot as usize),
                    })
                })
                .collect::<Vec<_>>();
            output.insert(collection.clone(), Value::Array(rows));
        }
        json!({"collections": output})
    }

    pub fn apply_changes(&mut self, changes: &ChangeSet, observed_owner_collection: Option<&str>) {
        let structurally_changed = changes
            .entities()
            .map(|change| change.collection.clone())
            .collect::<std::collections::HashSet<_>>();
        for collection in &structurally_changed {
            if let Some(slots) = self.by_collection.get(collection) {
                for slot in slots.values() {
                    self.slots[*slot as usize].positioned = false;
                }
            }
        }
        let mut wire = Vec::with_capacity(changes.len());
        for change in changes.entities() {
            match (&change.before, &change.after) {
                (Some(_), None) => {
                    if let Some(slot) = self.find(&change.collection, &change.id) {
                        let old_handle = self.handle(slot);
                        self.remove(&change.collection, &change.id);
                        wire.push(json!({
                            "collection": change.collection,
                            "id": change.id,
                            "handle": old_handle,
                            "deleted": true,
                        }));
                    }
                }
                (_, Some(value)) => {
                    let (slot, was_materialized) =
                        if let Some(slot) = self.find(&change.collection, &change.id) {
                            let materialized = self.slots[slot].materialized;
                            self.slots[slot].revision = self.slots[slot].revision.saturating_add(1);
                            (slot, materialized)
                        } else {
                            (self.allocate(&change.collection, &change.id), false)
                        };
                    let mut item = json!({
                        "collection": change.collection,
                        "id": change.id,
                        "handle": self.handle(slot),
                        "position": change.after_position,
                    });
                    if value.get("id").and_then(Value::as_str) != Some(change.id.as_str()) {
                        item["resultId"] = value.get("id").cloned().unwrap_or(Value::Null);
                    }
                    let owner_value_is_in_response =
                        observed_owner_collection == Some(change.collection.as_str());
                    if owner_value_is_in_response {
                        self.slots[slot].materialized = true;
                    } else if was_materialized {
                        item["value"] = value.clone();
                        self.slots[slot].materialized = true;
                    }
                    wire.push(item);
                }
                (None, None) => {}
            }
        }
        self.last_sync = json!({"changes": wire});
    }

    /// Mark successful mutation result rows that were observed without changing
    /// canonical state (for example, `upsertMany.unchanged`). Ambiguous equal
    /// values deliberately remain unmaterialized so no arbitrary handle can be
    /// authorized.
    pub fn observe_unchanged_values(&mut self, db: &Database, collection: &str, values: &[Value]) {
        let Some(rows) = db.collection(collection) else {
            return;
        };
        let mut observed = Vec::with_capacity(values.len());
        for value in values {
            let Some(storage_id) = rows.storage_id_for_value(value).map(str::to_owned) else {
                continue;
            };
            let Some(slot) = self.find(collection, &storage_id) else {
                continue;
            };
            self.slots[slot].materialized = true;
            let mut item = json!({
                "collection": collection,
                "id": storage_id,
                "handle": self.handle(slot),
            });
            if value.get("id").and_then(Value::as_str) != Some(storage_id.as_str()) {
                item["resultId"] = value.get("id").cloned().unwrap_or(Value::Null);
            }
            observed.push(item);
        }
        if let Some(changes) = self
            .last_sync
            .get_mut("changes")
            .and_then(Value::as_array_mut)
        {
            changes.extend(observed);
        }
    }

    pub fn replace_collections(
        &mut self,
        db: &Database,
        collection_names: impl IntoIterator<Item = String>,
    ) {
        let mut resets = Map::new();
        for collection in collection_names {
            let existing = self
                .by_collection
                .get(&collection)
                .map(|ids| ids.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            for id in existing {
                self.remove(&collection, &id);
            }
            let mut rows = Vec::new();
            if let Some(values) = db.collection(&collection) {
                for value in values.list() {
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        let slot = self.allocate(&collection, id);
                        rows.push(json!({
                            "id": id,
                            "handle": self.handle(slot),
                        }));
                    }
                }
            }
            resets.insert(collection, Value::Array(rows));
        }
        self.last_sync = json!({"changes": [], "resetCollections": resets});
    }

    pub fn invalidate(&mut self) {
        self.last_sync = json!({"changes": [], "invalidated": true});
    }

    pub fn last_sync(&self) -> &Value {
        &self.last_sync
    }
}
