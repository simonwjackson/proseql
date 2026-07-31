use std::collections::HashMap;

use proseql_engine::{
    collection::{
        CreateManyResult, DeleteManyResult, SkippedEntry, UpdateManyResult, UpsertAction,
        UpsertManyResult, UpsertOutcome,
    },
    descriptor::{DatabaseDescriptor, MigrationDescriptor},
    errors::{EngineError, OperationError},
    migrations::DryRunStatus,
    query::{
        AggregateConfig, CursorConfig, CursorPageResult, GroupResult, QueryInput, SortEntry,
        SortOrder,
    },
    relationships::{DeleteManyWithRelResult, DeleteRelationshipsOptions, DeleteWithRelResult},
    value::decode_boundary_input_value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateDatabaseInput {
    pub descriptor: DatabaseDescriptor,
    #[serde(default)]
    pub initial_collections: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryCommand {
    pub collection: String,
    #[serde(default)]
    pub query: QueryPayload,
    #[serde(default)]
    pub populate: Option<Value>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryPayload {
    #[serde(default)]
    pub r#where: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub select: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryCursorCommand {
    pub collection: String,
    #[serde(default)]
    pub query: QueryPayload,
    pub cursor: CursorPayload,
    #[serde(default)]
    pub populate: Option<Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorPayload {
    pub key: String,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateCommand {
    pub collection: String,
    #[serde(default)]
    pub r#where: Option<Value>,
    #[serde(default)]
    pub config: AggregatePayload,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregatePayload {
    #[serde(default)]
    pub count: bool,
    #[serde(default)]
    pub sum: Vec<String>,
    #[serde(default)]
    pub avg: Vec<String>,
    #[serde(default)]
    pub min: Vec<String>,
    #[serde(default)]
    pub max: Vec<String>,
    #[serde(default)]
    pub group_by: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionValueCommand {
    pub collection: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionManyCommand {
    pub collection: String,
    pub items: Vec<Value>,
    #[serde(default)]
    pub skip_duplicates: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCommand {
    pub collection: String,
    pub id: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateManyCommand {
    pub collection: String,
    pub r#where: Value,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCommand {
    pub collection: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteManyCommand {
    pub collection: String,
    pub r#where: Value,
    #[serde(default)]
    pub soft: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertCommand {
    pub collection: String,
    pub r#where: Value,
    pub create: Value,
    pub update: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertManyCommand {
    pub collection: String,
    pub items: Vec<UpsertInput>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertInput {
    pub r#where: Value,
    pub create: Value,
    pub update: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteWithRelationshipsCommand {
    pub collection: String,
    pub id: String,
    #[serde(default)]
    pub options: DeleteRelationshipsOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteManyWithRelationshipsCommand {
    pub collection: String,
    pub r#where: Value,
    #[serde(default)]
    pub options: DeleteRelationshipsOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReloadCollectionCommand {
    pub collection: String,
    pub records: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DumpCollectionCommand {
    pub collection: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchCommand {
    pub collection: String,
    #[serde(default)]
    pub config: WatchPayload,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchPayload {
    #[serde(default)]
    pub r#where: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub select: Option<Value>,
    #[serde(default)]
    pub debounce_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchByIdCommand {
    pub collection: String,
    pub id: String,
    #[serde(default)]
    pub debounce_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DryRunCollectionInput {
    pub name: String,
    #[serde(default)]
    pub exists: bool,
    #[serde(default)]
    pub current_version: u32,
    pub target_version: u32,
    #[serde(default)]
    pub migrations: Vec<MigrationDescriptor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DryRunInput {
    pub collections: Vec<DryRunCollectionInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionCommand {
    pub operations: Vec<TransactionOperationInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitSnapshotTransactionCommand {
    pub collections: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TransactionOperationInput {
    Create {
        collection: String,
        data: Value,
    },
    CreateMany {
        collection: String,
        items: Vec<Value>,
        #[serde(default)]
        skip_duplicates: bool,
    },
    Update {
        collection: String,
        id: String,
        data: Value,
    },
    UpdateMany {
        collection: String,
        r#where: Value,
        data: Value,
    },
    Delete {
        collection: String,
        id: String,
    },
    DeleteMany {
        collection: String,
        r#where: Value,
        #[serde(default)]
        soft: bool,
        #[serde(default)]
        limit: Option<usize>,
    },
    Upsert {
        collection: String,
        r#where: Value,
        create: Value,
        update: Value,
    },
    UpsertMany {
        collection: String,
        items: Vec<UpsertInput>,
    },
    CreateWithRelationships {
        collection: String,
        data: Value,
    },
    UpdateWithRelationships {
        collection: String,
        id: String,
        data: Value,
    },
    DeleteWithRelationships {
        collection: String,
        id: String,
        #[serde(default)]
        options: DeleteRelationshipsOptions,
    },
    DeleteManyWithRelationships {
        collection: String,
        r#where: Value,
        #[serde(default)]
        options: DeleteRelationshipsOptions,
    },
    Query {
        collection: String,
        #[serde(default)]
        query: QueryPayload,
        #[serde(default)]
        populate: Option<Value>,
    },
    QueryCursor {
        collection: String,
        #[serde(default)]
        query: QueryPayload,
        cursor: CursorPayload,
        #[serde(default)]
        populate: Option<Value>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TransactionOperationOutput {
    Value { value: Value },
    Values { values: Vec<Value> },
    CursorPage { value: Value },
    CreateMany { value: Value },
    UpdateMany { value: Value },
    DeleteMany { value: Value },
    Upsert { value: Value },
    UpsertMany { value: Value },
    DeleteWithRelationships { value: DeleteWithRelResult },
    DeleteManyWithRelationships { value: DeleteManyWithRelResult },
}

pub(crate) fn invalid_json_error(operation: &str, error: impl Into<String>) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_owned(),
        reason: "invalid-json".to_owned(),
        message: error.into(),
    })
}

pub(crate) fn unknown_command_error(operation: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_owned(),
        reason: "unknown-command".to_owned(),
        message: format!("Unknown proseql-wasm command '{operation}'"),
    })
}

pub(crate) fn parse_json<T: for<'de> Deserialize<'de>>(
    raw: &str,
    operation: &str,
) -> Result<T, EngineError> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| invalid_json_error(operation, error.to_string()))?;
    serde_json::from_value(decode_boundary_input_value(value))
        .map_err(|error| invalid_json_error(operation, error.to_string()))
}

pub(crate) fn parse_sort(sort: Option<Value>) -> Vec<SortEntry> {
    let Some(sort) = sort else {
        return Vec::new();
    };
    match sort {
        Value::Object(map) => map
            .into_iter()
            .filter_map(|(field, order)| {
                order
                    .as_str()
                    .and_then(SortOrder::parse)
                    .map(|order| (field, order))
            })
            .collect(),
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::Object(mut map) => {
                    let field = map.remove("field")?.as_str()?.to_owned();
                    let order = map.remove("order")?.as_str()?.to_owned();
                    SortOrder::parse(order.as_str()).map(|parsed| (field, parsed))
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn to_query_input(payload: QueryPayload) -> QueryInput {
    QueryInput {
        r#where: payload.r#where,
        sort: parse_sort(payload.sort),
        offset: payload.offset,
        limit: payload.limit,
        cursor: None,
        select: payload.select,
    }
}

pub(crate) fn to_watch_config(payload: WatchPayload) -> proseql_engine::reactive::WatchQueryConfig {
    proseql_engine::reactive::WatchQueryConfig {
        r#where: payload.r#where,
        sort: parse_sort(payload.sort),
        offset: payload.offset,
        limit: payload.limit,
        select: payload.select,
        debounce_ms: payload.debounce_ms,
    }
}

pub(crate) fn to_cursor(payload: CursorPayload) -> CursorConfig {
    CursorConfig {
        key: payload.key,
        after: payload.after,
        before: payload.before,
        limit: payload.limit,
    }
}

pub(crate) fn to_aggregate_config(payload: &AggregatePayload) -> AggregateConfig {
    AggregateConfig {
        count: payload.count,
        sum: payload.sum.clone(),
        avg: payload.avg.clone(),
        min: payload.min.clone(),
        max: payload.max.clone(),
    }
}

pub(crate) fn group_by_fields(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value],
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn upsert_outcome_value(outcome: UpsertOutcome) -> Value {
    let mut entity = outcome.entity.as_object().cloned().unwrap_or_default();
    entity.insert(
        "__action".to_owned(),
        Value::String(
            match outcome.action {
                UpsertAction::Created => "created",
                UpsertAction::Updated => "updated",
            }
            .to_owned(),
        ),
    );
    Value::Object(entity)
}

pub(crate) fn create_many_result_value(result: CreateManyResult) -> Value {
    json!({
        "created": result.created,
        "skipped": result.skipped.into_iter().map(skipped_entry_value).collect::<Vec<_>>()
    })
}

pub(crate) fn update_many_result_value(result: UpdateManyResult) -> Value {
    json!({"count": result.count, "updated": result.updated})
}

pub(crate) fn delete_many_result_value(result: DeleteManyResult) -> Value {
    json!({"count": result.count, "deleted": result.deleted})
}

pub(crate) fn upsert_many_result_value(result: UpsertManyResult) -> Value {
    json!({
        "created": result.created,
        "updated": result.updated,
        "unchanged": result.unchanged,
    })
}

pub(crate) fn cursor_page_value(result: CursorPageResult) -> Value {
    json!({"items": result.items, "pageInfo": result.page_info})
}

pub(crate) fn aggregate_result_value(result: proseql_engine::query::AggregateResult) -> Value {
    let mut map = Map::new();
    if let Some(count) = result.count {
        map.insert("count".to_owned(), Value::Number(count.into()));
    }
    if let Some(sum) = result.sum {
        map.insert(
            "sum".to_owned(),
            serde_json::to_value(sum).unwrap_or(Value::Null),
        );
    }
    if let Some(avg) = result.avg {
        map.insert(
            "avg".to_owned(),
            serde_json::to_value(avg).unwrap_or(Value::Null),
        );
    }
    if let Some(min) = result.min {
        map.insert("min".to_owned(), Value::Object(min.into_iter().collect()));
    }
    if let Some(max) = result.max {
        map.insert("max".to_owned(), Value::Object(max.into_iter().collect()));
    }
    Value::Object(map)
}

pub(crate) fn group_results_value(results: Vec<GroupResult>) -> Value {
    Value::Array(
        results
            .into_iter()
            .map(|result| {
                let mut map = Map::new();
                map.insert("group".to_owned(), Value::Object(result.group));
                if let Some(count) = result.count {
                    map.insert("count".to_owned(), Value::Number(count.into()));
                }
                if let Some(sum) = result.sum {
                    map.insert(
                        "sum".to_owned(),
                        serde_json::to_value(sum).unwrap_or(Value::Null),
                    );
                }
                if let Some(avg) = result.avg {
                    map.insert(
                        "avg".to_owned(),
                        serde_json::to_value(avg).unwrap_or(Value::Null),
                    );
                }
                if let Some(min) = result.min {
                    map.insert("min".to_owned(), Value::Object(min.into_iter().collect()));
                }
                if let Some(max) = result.max {
                    map.insert("max".to_owned(), Value::Object(max.into_iter().collect()));
                }
                Value::Object(map)
            })
            .collect(),
    )
}

fn dry_run_status_name(status: DryRunStatus) -> &'static str {
    match status {
        DryRunStatus::UpToDate => "up-to-date",
        DryRunStatus::NeedsMigration => "needs-migration",
        DryRunStatus::Ahead => "ahead",
        DryRunStatus::NoFile => "no-file",
    }
}

pub(crate) fn dry_run_report_value(input: DryRunInput) -> Value {
    json!({
        "collections": input.collections.into_iter().map(|collection| {
            let report = proseql_engine::migrations::dry_run_report(
                collection.exists,
                collection.current_version,
                collection.target_version,
                &collection.migrations,
            );
            json!({
                "name": collection.name,
                "currentVersion": report.current_version,
                "targetVersion": report.target_version,
                "status": dry_run_status_name(report.status),
                "migrationsToApply": report.migrations_to_apply.into_iter().map(|migration| json!({
                    "from": migration.from,
                    "to": migration.to,
                    "description": migration.description,
                })).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>()
    })
}

fn skipped_entry_value(entry: SkippedEntry) -> Value {
    json!({"data": entry.data, "reason": entry.reason})
}
