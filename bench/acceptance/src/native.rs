use crate::{
    fixture,
    query::{Answer, Query},
    Error,
};
use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::query::{aggregate::AggregateConfig, pipeline::QueryInput};
use proseql_native::{
    ExecutionModel, FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use std::path::Path;

fn tag(error: proseql_engine::errors::EngineError) -> Error {
    format!("{}: {error}", error.tag()).into()
}

pub fn open(root: &Path, kind: &str, model: ExecutionModel) -> Result<NativeRuntime, Error> {
    let mut fields = [
        "id",
        "metric",
        "at",
        "source",
        "receivedAt",
        "rawId",
        "month",
        "date",
        "atUtc",
    ]
    .into_iter()
    .map(|name| StructField {
        name: name.into(),
        schema: SchemaNode::Str,
    })
    .collect::<Vec<_>>();
    fields.push(StructField {
        name: "value".into(),
        schema: SchemaNode::Num,
    });
    fields.push(StructField {
        name: "end".into(),
        schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
    });
    if kind == "raw" {
        fields.push(StructField {
            name: "shard".into(),
            schema: SchemaNode::Str,
        });
    }
    let descriptor = CollectionDescriptor {
        name: kind.into(),
        schema: SchemaNode::Struct { fields },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec!["atUtc".into()],
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
        append_only: true,
        duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
        validation_mode: ValidationMode::Strict,
    };
    let config = NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(descriptor)],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: kind.into(),
            collection: kind.into(),
            root: root.join(kind).to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: if kind == "raw" {
                PartitionKey::Field {
                    field: "shard".into(),
                }
            } else {
                PartitionKey::TimeBucket {
                    field: "atUtc".into(),
                    bucket: TimeBucket::Month,
                }
            },
            prose: None,
        })],
    };
    let options = NativeSourceRuntimeOptions {
        execution_model: model,
        watch_debounce: None,
        lazy_partitions: IndexMap::from([(
            kind.into(),
            LazyPartitionPolicy {
                max_loaded_partitions: 1,
                full_scan: FullScanPolicy::Allow,
            },
        )]),
        ..Default::default()
    };
    NativeRuntime::open_sources_with_options(config, options).map_err(tag)
}
pub fn query(runtime: &NativeRuntime, kind: &str, q: &Query) -> Result<Answer, Error> {
    if q.aggregate {
        let groups = runtime
            .aggregate_grouped_bounded(
                kind,
                Some(q.filter()),
                &["date".into(), "metric".into()],
                &AggregateConfig {
                    count: true,
                    sum: vec!["value".into()],
                    ..Default::default()
                },
            )
            .map_err(tag)?;
        let mut answer = Answer::default();
        for group in groups {
            answer.group(
                group.group["date"].as_str().unwrap(),
                group.group["metric"].as_str().unwrap(),
                group.count.unwrap(),
                group.sum.unwrap()["value"],
            );
        }
        Ok(answer)
    } else if let Some(id) = &q.id {
        Ok(Answer::rows(
            runtime
                .find_by_id(kind, id)
                .map_err(tag)?
                .into_iter()
                .collect(),
        ))
    } else {
        Ok(Answer::rows(
            runtime
                .query_bounded(
                    kind,
                    QueryInput {
                        r#where: Some(q.filter()),
                        ..Default::default()
                    },
                )
                .map_err(tag)?,
        ))
    }
}
pub fn append(runtime: &NativeRuntime, kind: &str) -> Result<Answer, Error> {
    let rows = fixture::append_rows(kind);
    runtime
        .mutate(|tx| tx.create_many(kind, rows.clone()).map(|_| ()))
        .map_err(tag)?;
    Ok(Answer::rows(rows))
}
