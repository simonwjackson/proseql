//! Recursive relationship population.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::collection::Collection;
use crate::descriptor::RelationshipKind;
use crate::errors::{CollectionNotFoundError, DanglingReferenceError, EngineError};

use super::helpers::{col_nf, ref_fk, resolve_inv_fk_population};
use crate::value::BOUNDARY_INTERNAL_UNDEFINED_SENTINEL_KEY;

fn undefined_value() -> Value {
    Value::Object(Map::from_iter([(
        BOUNDARY_INTERNAL_UNDEFINED_SENTINEL_KEY.to_owned(),
        Value::from(1),
    )]))
}

struct InverseLookup<'a> {
    collection: String,
    foreign_key: String,
    postings: HashMap<String, Vec<&'a Value>>,
}

struct PopulateResolver<'a> {
    collections: &'a IndexMap<String, Collection>,
    inverse: Vec<InverseLookup<'a>>,
}

impl<'a> PopulateResolver<'a> {
    fn new(collections: &'a IndexMap<String, Collection>) -> Self {
        Self {
            collections,
            inverse: Vec::new(),
        }
    }

    fn inverse_rows(
        &mut self,
        collection: &str,
        foreign_key: &str,
        relationship: &str,
        owner_id: &str,
    ) -> Result<Vec<&'a Value>, EngineError> {
        let index = match self
            .inverse
            .iter()
            .position(|index| index.collection == collection && index.foreign_key == foreign_key)
        {
            Some(index) => index,
            None => {
                let target = self.collections.get(collection).ok_or_else(|| {
                    EngineError::CollectionNotFound(CollectionNotFoundError {
                        collection: collection.to_owned(),
                        message: format!(
                            "Populate: collection '{collection}' referenced by inverse '{relationship}' relationship is not in the database"
                        ),
                    })
                })?;
                let mut postings: HashMap<String, Vec<&Value>> = HashMap::new();
                for row in target.list() {
                    if let Some(value) = row.get(foreign_key).and_then(Value::as_str) {
                        postings.entry(value.to_owned()).or_default().push(row);
                    }
                }
                self.inverse.push(InverseLookup {
                    collection: collection.to_owned(),
                    foreign_key: foreign_key.to_owned(),
                    postings,
                });
                self.inverse.len() - 1
            }
        };
        Ok(self.inverse[index]
            .postings
            .get(owner_id)
            .cloned()
            .unwrap_or_default())
    }

    /// Walk once for both validation-only and materializing callers. Keeping the
    /// relationship/error path shared avoids a second WASM copy of the recursive
    /// resolver while validation still performs no row clones.
    fn walk(
        &mut self,
        entities: Vec<&Value>,
        populate: &Value,
        source: &str,
        depth: usize,
        materialize: bool,
    ) -> Result<Vec<Value>, EngineError> {
        if depth > 5 {
            return Ok(if materialize {
                entities.into_iter().cloned().collect()
            } else {
                Vec::new()
            });
        }
        let config = match populate.as_object() {
            Some(config) if !config.is_empty() => config,
            _ => {
                return Ok(if materialize {
                    entities.into_iter().cloned().collect()
                } else {
                    Vec::new()
                })
            }
        };
        let relationships = self
            .collections
            .get(source)
            .ok_or_else(|| col_nf(source))?
            .descriptor
            .relationships
            .clone();
        let mut output = Vec::with_capacity(if materialize { entities.len() } else { 0 });
        for entity in entities {
            let mut populated =
                materialize.then(|| entity.as_object().cloned().unwrap_or_default());
            for (name, nested) in config {
                let Some((_, relation)) = relationships
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                else {
                    continue;
                };
                match relation.kind {
                    RelationshipKind::Ref => {
                        let foreign_key = ref_fk(name, &relation.foreign_key);
                        let Some(target_id) = entity.get(&foreign_key).and_then(Value::as_str)
                        else {
                            if let Some(output) = populated.as_mut() {
                                output.insert(name.clone(), undefined_value());
                            }
                            continue;
                        };
                        let target = self.collections.get(&relation.target).ok_or_else(|| {
                            EngineError::CollectionNotFound(CollectionNotFoundError {
                                collection: relation.target.clone(),
                                message: format!(
                                    "Populate: collection '{}' referenced by '{}' relationship is not in the database",
                                    relation.target, name
                                ),
                            })
                        })?;
                        let target_row = target.get(target_id).ok_or_else(|| {
                            EngineError::DanglingReference(DanglingReferenceError {
                                collection: relation.target.clone(),
                                field: foreign_key.clone(),
                                target_id: target_id.to_owned(),
                                message: format!(
                                    "Entity in \"{}\" references missing \"{}\" with {}=\"{}\"",
                                    source, relation.target, foreign_key, target_id
                                ),
                            })
                        })?;
                        if let Some(output) = populated.as_mut() {
                            let value = if nested.is_object() {
                                self.walk(
                                    vec![target_row],
                                    nested,
                                    &relation.target,
                                    depth + 1,
                                    true,
                                )?
                                .into_iter()
                                .next()
                                .unwrap_or(Value::Null)
                            } else {
                                target_row.clone()
                            };
                            output.insert(name.clone(), value);
                        } else if nested.is_object() {
                            self.walk(
                                vec![target_row],
                                nested,
                                &relation.target,
                                depth + 1,
                                false,
                            )?;
                        }
                    }
                    RelationshipKind::Inverse => {
                        let foreign_key =
                            resolve_inv_fk_population(relation, source, self.collections);
                        let children = self.inverse_rows(
                            &relation.target,
                            &foreign_key,
                            name,
                            entity.get("id").and_then(Value::as_str).unwrap_or_default(),
                        )?;
                        if let Some(output) = populated.as_mut() {
                            let values = if nested.is_object() {
                                self.walk(children, nested, &relation.target, depth + 1, true)?
                            } else {
                                children.into_iter().cloned().collect()
                            };
                            output.insert(name.clone(), Value::Array(values));
                        } else if nested.is_object() {
                            self.walk(children, nested, &relation.target, depth + 1, false)?;
                        }
                    }
                }
            }
            if let Some(populated) = populated {
                output.push(Value::Object(populated));
            }
        }
        Ok(output)
    }
}

pub(super) fn apply_populate_borrowed(
    entities: Vec<&Value>,
    populate: &Value,
    source: &str,
    collections: &IndexMap<String, Collection>,
    depth: usize,
) -> Result<Vec<Value>, EngineError> {
    PopulateResolver::new(collections).walk(entities, populate, source, depth, true)
}

pub(super) fn validate_populate_borrowed(
    entities: Vec<&Value>,
    populate: &Value,
    source: &str,
    collections: &IndexMap<String, Collection>,
    depth: usize,
) -> Result<(), EngineError> {
    PopulateResolver::new(collections)
        .walk(entities, populate, source, depth, false)
        .map(drop)
}
