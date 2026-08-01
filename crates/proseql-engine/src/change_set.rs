//! Reversible, entity-granular mutation bookkeeping.
//!
//! Ordinary collection writes record before/after images and insertion positions
//! here. The same records drive incremental indexes, rollback, reactive snapshot
//! updates, and the mutation deltas exposed to the WASM host.

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// One entity's net change since the last committed-delta drain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityChange {
    pub collection: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_position: Option<usize>,
}

/// Ordered net changes produced by one or more state primitives.
///
/// Net-zero entries become tombstones and are compacted only when the set is
/// drained or serialized. This keeps repeated create/delete churn O(1) per
/// primitive without exposing mutable bookkeeping storage.
#[derive(Debug, Clone, Default)]
pub struct ChangeSet {
    entities: Vec<Option<EntityChange>>,
    positions: HashMap<(String, String), usize>,
    len: usize,
}

impl PartialEq for ChangeSet {
    fn eq(&self, other: &Self) -> bool {
        self.entities().eq(other.entities())
    }
}

impl Serialize for ChangeSet {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        struct Wire<'a> {
            entities: Vec<&'a EntityChange>,
        }
        Wire {
            entities: self.entities().collect(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChangeSet {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            entities: Vec<EntityChange>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let mut changes = Self::default();
        for change in wire.entities {
            changes.record(change);
        }
        Ok(changes)
    }
}

impl ChangeSet {
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Iterate over live entity changes in deterministic first-change order.
    pub fn entities(&self) -> impl Iterator<Item = &EntityChange> {
        self.entities.iter().filter_map(Option::as_ref)
    }

    pub(crate) fn entities_mut(&mut self) -> impl Iterator<Item = &mut EntityChange> {
        self.entities.iter_mut().filter_map(Option::as_mut)
    }

    /// Consume the set in deterministic first-change order.
    pub fn into_entities(self) -> impl Iterator<Item = EntityChange> {
        self.entities.into_iter().flatten()
    }

    /// Record a primitive change, compacting repeated changes to the same entity
    /// while retaining the original before-image and final insertion position.
    pub fn record(&mut self, change: EntityChange) {
        let key = (change.collection.clone(), change.id.clone());
        if let Some(index) = self.positions.get(&key).copied() {
            let existing = self.entities[index]
                .as_mut()
                .expect("live change position must reference an entity");
            existing.after = change.after;
            existing.after_position = change.after_position;
            let net_zero = existing.before == existing.after
                && existing.before_position == existing.after_position;
            if net_zero {
                self.entities[index] = None;
                self.positions.remove(&key);
                self.len -= 1;
            }
            return;
        }

        if change.before != change.after || change.before_position != change.after_position {
            let index = self.entities.len();
            self.entities.push(Some(change));
            self.positions.insert(key, index);
            self.len += 1;
        }
    }

    pub fn extend(&mut self, other: ChangeSet) {
        for change in other.into_entities() {
            self.record(change);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn change(id: &str, before: Option<Value>, after: Option<Value>) -> EntityChange {
        EntityChange {
            collection: "users".into(),
            id: id.into(),
            before,
            after,
            before_position: None,
            after_position: None,
        }
    }

    #[test]
    fn compacts_replacement_sequences_but_preserves_reinserted_positions() {
        let mut changes = ChangeSet::default();
        changes.record(EntityChange {
            before_position: Some(0),
            ..change("u1", Some(json!({"name":"before"})), None)
        });
        changes.record(EntityChange {
            after_position: Some(2),
            ..change("u1", None, Some(json!({"name":"after"})))
        });

        let actual = changes.entities().next().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(actual.before, Some(json!({"name":"before"})));
        assert_eq!(actual.after, Some(json!({"name":"after"})));
        assert_eq!(actual.before_position, Some(0));
        assert_eq!(actual.after_position, Some(2));
    }

    #[test]
    fn removes_create_then_delete_net_zero_changes() {
        let mut changes = ChangeSet::default();
        changes.record(EntityChange {
            after_position: Some(0),
            ..change("u1", None, Some(json!({"id":"u1"})))
        });
        changes.record(EntityChange {
            before_position: Some(0),
            ..change("u1", Some(json!({"id":"u1"})), None)
        });
        assert!(changes.is_empty());
    }

    #[test]
    fn high_churn_compaction_is_ordered_and_serializes_as_an_array() {
        let mut changes = ChangeSet::default();
        for index in 0..2_000 {
            let id = format!("transient-{index}");
            changes.record(change(&id, None, Some(json!({"id": id}))));
            changes.record(change(&id, Some(json!({"id": id})), None));
        }
        changes.record(change("kept-a", None, Some(json!({"id":"kept-a"}))));
        changes.record(change("kept-b", None, Some(json!({"id":"kept-b"}))));

        assert_eq!(
            changes
                .entities()
                .map(|change| change.id.as_str())
                .collect::<Vec<_>>(),
            vec!["kept-a", "kept-b"]
        );
        assert_eq!(
            serde_json::to_value(&changes).unwrap()["entities"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
