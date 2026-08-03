use proseql_engine::errors::{CollectionNotFoundError, EngineError};
use proseql_engine::query::{
    execute_aggregate, execute_grouped_aggregate, matches_where_with_registry,
};
use proseql_engine::reactive::WatchDelivery;
use proseql_engine::relationships::Database;
use serde_json::{json, Value};

use crate::runtime::RuntimeCore;
use crate::types::{
    aggregate_result_value, create_many_result_value, cursor_page_value, delete_many_result_value,
    dry_run_report_value, group_by_fields, group_results_value, parse_json, to_aggregate_config,
    to_cursor, to_query_input, to_watch_config, unknown_command_error, update_many_result_value,
    upsert_many_result_value, upsert_outcome_value, AggregateCommand, CollectionManyCommand,
    CollectionValueCommand, CommitSnapshotTransactionCommand, DeleteCommand, DeleteManyCommand,
    DeleteManyWithRelationshipsCommand, DeleteWithRelationshipsCommand, DumpCollectionCommand,
    QueryCommand, QueryCursorCommand, ReloadCollectionCommand, TransactionCommand,
    TransactionOperationInput, TransactionOperationOutput, UpdateCommand, UpdateManyCommand,
    UpsertCommand, UpsertManyCommand, WatchByIdCommand, WatchCommand,
};

fn collection_not_found(collection: &str) -> EngineError {
    EngineError::CollectionNotFound(CollectionNotFoundError {
        collection: collection.to_owned(),
        message: format!("Collection '{}' not found", collection),
    })
}

pub(crate) fn dispatch(
    runtime: &mut RuntimeCore,
    handle: u32,
    method: &str,
    payload_json: Option<&str>,
) -> Result<Value, EngineError> {
    let payload_json = payload_json.unwrap_or("{}");
    let context = runtime.database_mut(handle)?;

    match method {
        "query" => {
            let command: QueryCommand = parse_json(payload_json, "query")?;
            Ok(Value::Array(context.db.query(
                &command.collection,
                to_query_input(command.query),
                command.populate,
            )?))
        }
        "queryCursor" => {
            let command: QueryCursorCommand = parse_json(payload_json, "queryCursor")?;
            Ok(cursor_page_value(context.db.query_cursor(
                &command.collection,
                &to_query_input(command.query),
                &to_cursor(command.cursor),
                command.populate,
            )?))
        }
        "aggregate" => {
            let command: AggregateCommand = parse_json(payload_json, "aggregate")?;
            let collection = context
                .db
                .collection(&command.collection)
                .ok_or_else(|| collection_not_found(&command.collection))?;
            if let Some(group_by) = command.config.group_by.clone() {
                Ok(group_results_value(execute_grouped_aggregate(
                    collection,
                    command.r#where.as_ref(),
                    &group_by_fields(Some(group_by)),
                    &to_aggregate_config(&command.config),
                    &context.registry,
                )?))
            } else {
                Ok(aggregate_result_value(execute_aggregate(
                    collection,
                    command.r#where.as_ref(),
                    &to_aggregate_config(&command.config),
                    &context.registry,
                )?))
            }
        }
        "findById" => {
            let command: DeleteCommand = parse_json(payload_json, "findById")?;
            let collection = context
                .db
                .collection(&command.collection)
                .ok_or_else(|| collection_not_found(&command.collection))?;
            collection.get_or_fail(&command.id).cloned()
        }
        "groupAggregate" => {
            let command: AggregateCommand = parse_json(payload_json, "groupAggregate")?;
            let collection = context
                .db
                .collection(&command.collection)
                .ok_or_else(|| collection_not_found(&command.collection))?;
            let group_by = group_by_fields(command.config.group_by.clone());
            Ok(group_results_value(execute_grouped_aggregate(
                collection,
                command.r#where.as_ref(),
                &group_by,
                &to_aggregate_config(&command.config),
                &context.registry,
            )?))
        }
        "create" => {
            let command: CollectionValueCommand = parse_json(payload_json, "create")?;
            context.db.create(&command.collection, command.data)
        }
        "createMany" => {
            let command: CollectionManyCommand = parse_json(payload_json, "createMany")?;
            let result = context.db.create_many(
                &command.collection,
                command.items,
                command.skip_duplicates,
            )?;
            Ok(create_many_result_value(result))
        }
        "update" => {
            let command: UpdateCommand = parse_json(payload_json, "update")?;
            context
                .db
                .update(&command.collection, &command.id, command.data)
        }
        "updateMany" => {
            let command: UpdateManyCommand = parse_json(payload_json, "updateMany")?;
            Ok(update_many_result_value(context.db.update_many(
                &command.collection,
                command.r#where,
                command.data,
            )?))
        }
        "delete" => {
            let command: DeleteCommand = parse_json(payload_json, "delete")?;
            context.db.delete(&command.collection, &command.id)
        }
        "deleteMany" => {
            let command: DeleteManyCommand = parse_json(payload_json, "deleteMany")?;
            Ok(delete_many_result_value(context.db.delete_many(
                &command.collection,
                command.r#where,
                command.soft,
                command.limit,
            )?))
        }
        "upsert" => {
            let command: UpsertCommand = parse_json(payload_json, "upsert")?;
            Ok(upsert_outcome_value(context.db.upsert(
                &command.collection,
                command.r#where,
                command.create,
                command.update,
            )?))
        }
        "upsertMany" => {
            let command: UpsertManyCommand = parse_json(payload_json, "upsertMany")?;
            Ok(upsert_many_result_value(
                context.db.upsert_many(
                    &command.collection,
                    command
                        .items
                        .into_iter()
                        .map(|item| (item.r#where, item.create, item.update))
                        .collect(),
                )?,
            ))
        }
        "createWithRelationships" => {
            let command: CollectionValueCommand =
                parse_json(payload_json, "createWithRelationships")?;
            context
                .db
                .create_with_relationships(&command.collection, command.data)
        }
        "updateWithRelationships" => {
            let command: UpdateCommand = parse_json(payload_json, "updateWithRelationships")?;
            context
                .db
                .update_with_relationships(&command.collection, &command.id, command.data)
        }
        "deleteWithRelationships" => {
            let command: DeleteWithRelationshipsCommand =
                parse_json(payload_json, "deleteWithRelationships")?;
            Ok(json!(context.db.delete_with_relationships(
                &command.collection,
                &command.id,
                command.options,
            )?))
        }
        "deleteManyWithRelationships" => {
            let command: DeleteManyWithRelationshipsCommand =
                parse_json(payload_json, "deleteManyWithRelationships")?;
            let where_clause = command.r#where;
            Ok(json!(context.db.delete_many_with_relationships(
                &command.collection,
                &|entity| matches_where_with_registry(
                    entity,
                    &where_clause,
                    Some(context.registry.as_ref())
                ),
                command.options,
            )?))
        }
        "transaction" => {
            let command: TransactionCommand = parse_json(payload_json, "transaction")?;
            Ok(json!(run_transaction(
                &mut context.db,
                context.registry.clone(),
                command
            )?))
        }
        "commitSnapshotTransaction" => {
            let command: CommitSnapshotTransactionCommand =
                parse_json(payload_json, "commitSnapshotTransaction")?;
            Ok(json!({
                "changedCollections": context
                    .db
                    .commit_snapshot_transaction(command.collections.into_iter().collect())?
            }))
        }
        "dumpCollection" => {
            let command: DumpCollectionCommand = parse_json(payload_json, "dumpCollection")?;
            let collection = context
                .db
                .collection(&command.collection)
                .ok_or_else(|| collection_not_found(&command.collection))?;
            Ok(Value::Array(
                collection.list().into_iter().cloned().collect::<Vec<_>>(),
            ))
        }
        "dumpAll" => Ok(json!(context.snapshot_all())),
        "reloadCollection" => {
            let command: ReloadCollectionCommand = parse_json(payload_json, "reloadCollection")?;
            context
                .db
                .reload_collection(&command.collection, command.records)?;
            Ok(Value::Null)
        }
        "dryRunMigrations" => {
            let input = parse_json(payload_json, "dryRunMigrations")?;
            Ok(dry_run_report_value(input))
        }
        other => Err(unknown_command_error(other)),
    }
}

pub(crate) fn subscribe_watch(
    runtime: &mut RuntimeCore,
    handle: u32,
    command_json: &str,
    callback: impl Fn(WatchDelivery) + Send + Sync + 'static,
) -> Result<Value, EngineError> {
    let command: WatchCommand = parse_json(command_json, "subscribeWatch")?;
    let context = runtime.database_mut(handle)?;
    let subscription_id = context.next_subscription_id.max(1);
    context.next_subscription_id = context.next_subscription_id.saturating_add(1);
    let subscription = context.db.watch_with_delivery_callback(
        &command.collection,
        to_watch_config(command.config),
        Box::new(callback),
    )?;
    context.subscriptions.insert(subscription_id, subscription);
    Ok(json!(subscription_id))
}

pub(crate) fn subscribe_watch_by_id(
    runtime: &mut RuntimeCore,
    handle: u32,
    command_json: &str,
    callback: impl Fn(WatchDelivery) + Send + Sync + 'static,
) -> Result<Value, EngineError> {
    let command: WatchByIdCommand = parse_json(command_json, "subscribeWatchById")?;
    let context = runtime.database_mut(handle)?;
    let subscription_id = context.next_subscription_id.max(1);
    context.next_subscription_id = context.next_subscription_id.saturating_add(1);
    let subscription = context.db.watch_by_id_with_delivery_callback(
        &command.collection,
        &command.id,
        command.debounce_ms,
        Box::new(callback),
    )?;
    context.subscriptions.insert(subscription_id, subscription);
    Ok(json!(subscription_id))
}

pub(crate) fn unsubscribe(
    runtime: &mut RuntimeCore,
    handle: u32,
    subscription_id: u32,
) -> Result<Value, EngineError> {
    let context = runtime.database_mut(handle)?;
    Ok(json!(context
        .subscriptions
        .remove(&subscription_id)
        .is_some()))
}

fn run_transaction(
    db: &mut Database,
    registry: std::sync::Arc<proseql_engine::callbacks::CallbackRegistry>,
    command: TransactionCommand,
) -> Result<Vec<TransactionOperationOutput>, EngineError> {
    db.transaction(None, |tx| {
        let mut outputs = Vec::with_capacity(command.operations.len());
        for operation in command.operations {
            let output = match operation {
                TransactionOperationInput::Create { collection, data } => {
                    TransactionOperationOutput::Value {
                        value: tx.create(&collection, data)?,
                    }
                }
                TransactionOperationInput::CreateMany {
                    collection,
                    items,
                    skip_duplicates,
                } => TransactionOperationOutput::CreateMany {
                    value: create_many_result_value(tx.create_many(
                        &collection,
                        items,
                        skip_duplicates,
                    )?),
                },
                TransactionOperationInput::Update {
                    collection,
                    id,
                    data,
                } => TransactionOperationOutput::Value {
                    value: tx.update(&collection, &id, data)?,
                },
                TransactionOperationInput::UpdateMany {
                    collection,
                    r#where,
                    data,
                } => TransactionOperationOutput::UpdateMany {
                    value: update_many_result_value(tx.update_many(&collection, r#where, data)?),
                },
                TransactionOperationInput::Delete { collection, id } => {
                    TransactionOperationOutput::Value {
                        value: tx.delete(&collection, &id)?,
                    }
                }
                TransactionOperationInput::DeleteMany {
                    collection,
                    r#where,
                    soft,
                    limit,
                } => TransactionOperationOutput::DeleteMany {
                    value: delete_many_result_value(tx.delete_many(
                        &collection,
                        r#where,
                        soft,
                        limit,
                    )?),
                },
                TransactionOperationInput::Upsert {
                    collection,
                    r#where,
                    create,
                    update,
                } => TransactionOperationOutput::Upsert {
                    value: upsert_outcome_value(tx.upsert(&collection, r#where, create, update)?),
                },
                TransactionOperationInput::UpsertMany { collection, items } => {
                    TransactionOperationOutput::UpsertMany {
                        value: upsert_many_result_value(
                            tx.upsert_many(
                                &collection,
                                items
                                    .into_iter()
                                    .map(|item| (item.r#where, item.create, item.update))
                                    .collect(),
                            )?,
                        ),
                    }
                }
                TransactionOperationInput::CreateWithRelationships { collection, data } => {
                    TransactionOperationOutput::Value {
                        value: tx.create_with_relationships(&collection, data)?,
                    }
                }
                TransactionOperationInput::UpdateWithRelationships {
                    collection,
                    id,
                    data,
                } => TransactionOperationOutput::Value {
                    value: tx.update_with_relationships(&collection, &id, data)?,
                },
                TransactionOperationInput::DeleteWithRelationships {
                    collection,
                    id,
                    options,
                } => TransactionOperationOutput::DeleteWithRelationships {
                    value: tx.delete_with_relationships(&collection, &id, options)?,
                },
                TransactionOperationInput::DeleteManyWithRelationships {
                    collection,
                    r#where,
                    options,
                } => TransactionOperationOutput::DeleteManyWithRelationships {
                    value: tx.delete_many_with_relationships(
                        &collection,
                        &|entity| {
                            matches_where_with_registry(entity, &r#where, Some(registry.as_ref()))
                        },
                        options,
                    )?,
                },
                TransactionOperationInput::Query {
                    collection,
                    query,
                    populate,
                } => TransactionOperationOutput::Values {
                    values: tx.query(&collection, to_query_input(query), populate)?,
                },
                TransactionOperationInput::QueryCursor {
                    collection,
                    query,
                    cursor,
                    populate,
                } => TransactionOperationOutput::CursorPage {
                    value: cursor_page_value(tx.query_cursor(
                        &collection,
                        &to_query_input(query),
                        &to_cursor(cursor),
                        populate,
                    )?),
                },
            };
            outputs.push(output);
        }
        Ok(outputs)
    })
}
