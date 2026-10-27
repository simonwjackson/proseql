//! Aggregate flat collection files and project only changed partitions.
use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, SourceConfigError};
use proseql_formats::FormatRegistry;
use serde_json::Value;

use crate::append::{is_append_format, load_append_file, TornLineDiagnostic};
use crate::collection_file::{
    encode_collection_file, load_collection_file, validate_collection_file_ids,
};
use crate::document_source::PlannedDocumentWrite;
use crate::host::StorageHost;
use crate::path::{join_path, normalize_path};
use crate::persistence::CollectionStorageConfig;
use crate::source_config::{
    NormalizedCollectionFileSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};

#[derive(Debug, Clone, Default)]
pub struct LoadedPartitions {
    pub files: IndexMap<String, IndexMap<String, Value>>,
}

impl LoadedPartitions {
    pub fn records(&self) -> IndexMap<String, Value> {
        self.files
            .values()
            .flat_map(|records| {
                records
                    .iter()
                    .map(|(id, record)| (id.clone(), record.clone()))
            })
            .collect()
    }
}

pub(crate) fn safe_component(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('.')
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn error(source: &PartitionedSourceConfig, path: &str, message: impl Into<String>) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id: Some(source.id.clone()),
        collection: Some(source.collection.clone()),
        path: Some(path.into()),
    }))
}

/// The bucket key of a UTC timestamp `YYYY-MM-DDTHH:MM:SS(.f+)?Z`, or `None`
/// when the value does not match the pattern or names an invalid date or time.
/// A leap second (`23:59:60`, RFC 3339 section 5.7) belongs to the bucket of
/// its date; second 60 at any other minute is invalid.
pub fn time_bucket_key(value: &str, bucket: TimeBucket) -> Option<&str> {
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = bytes.get(range)?;
        part.iter().all(u8::is_ascii_digit).then(|| {
            part.iter()
                .fold(0, |sum, digit| sum * 10 + u32::from(digit - b'0'))
        })
    };
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if bytes.len() < 20
        || separators
            .iter()
            .any(|(index, expected)| bytes[*index] != *expected)
        || bytes[bytes.len() - 1] != b'Z'
    {
        return None;
    }
    let fraction = &bytes[19..bytes.len() - 1];
    let fraction_ok = fraction.is_empty()
        || (fraction.len() >= 2
            && fraction[0] == b'.'
            && fraction[1..].iter().all(u8::is_ascii_digit));
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    let leap_second = hour == 23 && minute == 59 && second == 60;
    let valid = fraction_ok
        && (1..=days).contains(&day)
        && hour < 24
        && minute < 60
        && (second < 60 || leap_second);
    valid.then(|| match bucket {
        TimeBucket::Year => &value[..4],
        TimeBucket::Month => &value[..7],
        TimeBucket::Day => &value[..10],
    })
}

pub fn partition_path(
    source: &PartitionedSourceConfig,
    record: &Value,
) -> Result<String, EngineError> {
    let field = source.partition_by.field();
    let value = record.get(field).and_then(Value::as_str).ok_or_else(|| {
        error(
            source,
            &source.root,
            format!("Partition field '{field}' must be a string"),
        )
    })?;
    let key = match &source.partition_by {
        PartitionKey::Field { .. } => value,
        PartitionKey::TimeBucket { bucket, .. } => {
            time_bucket_key(value, *bucket).ok_or_else(|| {
                error(
                    source,
                    &source.root,
                    format!(
                        "Partition field '{field}' must be a UTC timestamp YYYY-MM-DDTHH:MM:SS(.fff)Z"
                    ),
                )
            })?
        }
        PartitionKey::Prefix { delimiter, .. } => value
            .split_once(delimiter)
            .map(|(prefix, _)| prefix)
            .ok_or_else(|| {
                error(
                    source,
                    &source.root,
                    format!("Partition field '{field}' has no delimiter '{delimiter}'"),
                )
            })?,
    };
    if !safe_component(key) {
        return Err(error(
            source,
            &source.root,
            format!("Unsafe partition key '{key}'"),
        ));
    }
    Ok(join_path(&source.root, &format!("{key}.{}", source.format)))
}

pub fn matches_partition_path(source: &PartitionedSourceConfig, path: &str) -> bool {
    let normalized = normalize_path(path);
    let prefix = format!("{}/", source.root.trim_end_matches('/'));
    let relative = if source.root == "." && !std::path::Path::new(&normalized).is_absolute() {
        Some(normalized.as_str())
    } else {
        normalized.strip_prefix(&prefix)
    };
    relative.is_some_and(|relative| {
        !relative.contains('/') && relative.ends_with(&format!(".{}", source.format))
    })
}

/// The collection-file view of one partition file.
pub fn file_source(
    source: &PartitionedSourceConfig,
    path: &str,
) -> NormalizedCollectionFileSourceConfig {
    NormalizedCollectionFileSourceConfig {
        id: source.id.clone(),
        collection: source.collection.clone(),
        path: path.into(),
        format: source.format.clone(),
        prose: source.prose.clone(),
    }
}

pub fn load_partitioned_source(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
) -> Result<LoadedPartitions, EngineError> {
    load_partitioned_source_with(host, formats, source, collection, false).map(|(loaded, _)| loaded)
}

/// Load every partition. With `append_only` on a JSONL source, a torn final
/// line in a partition is ignored and returned as a diagnostic (see
/// [`crate::append`]); all other checks are unchanged.
pub fn load_partitioned_source_with(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
    append_only: bool,
) -> Result<(LoadedPartitions, Vec<TornLineDiagnostic>), EngineError> {
    let mut loaded = LoadedPartitions::default();
    let mut torn = Vec::new();
    if !host.exists(&source.root)? {
        return Ok((loaded, torn));
    }
    let tolerate_torn = append_only && is_append_format(&source.format);
    let mut paths = host.list_directory(&source.root)?;
    paths.sort();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if !matches_partition_path(source, &path) || !host.exists(&path)? {
            continue;
        }
        let file = file_source(source, &path);
        let records = if tolerate_torn {
            let file = load_append_file(host, formats, &file, collection, true)?;
            torn.extend(file.torn);
            file.records
        } else {
            validate_collection_file_ids(host, formats, &file)?;
            load_collection_file(host, formats, &file, collection)?
        };
        for (id, record) in &records {
            if !seen.insert(id.clone()) {
                return Err(error(
                    source,
                    &path,
                    format!("Duplicate partition record '{id}'"),
                ));
            }
            check_partition_record(source, &path, id, record)?;
        }
        loaded.files.insert(path, records);
    }
    Ok((loaded, torn))
}

/// Check that a record loaded from the partition file `path` routes to that
/// file: its partition field is valid and gives the file's key.
pub fn check_partition_record(
    source: &PartitionedSourceConfig,
    path: &str,
    id: &str,
    record: &Value,
) -> Result<(), EngineError> {
    let routed = partition_path(source, record).map_err(|cause| {
        let message = match &cause {
            EngineError::SourceConfig(config) => config.message.clone(),
            other => other.to_string(),
        };
        error(source, path, format!("Record '{id}': {message}"))
    })?;
    if routed != path {
        return Err(error(
            source,
            path,
            format!("Record '{id}' is in the wrong partition"),
        ));
    }
    Ok(())
}

pub fn plan_partitioned_source(
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
    previous: &LoadedPartitions,
    candidate: &IndexMap<String, Value>,
) -> Result<(LoadedPartitions, Vec<PlannedDocumentWrite>), EngineError> {
    let mut next = LoadedPartitions {
        files: previous
            .files
            .keys()
            .map(|path| (path.clone(), IndexMap::new()))
            .collect(),
    };
    for (id, record) in candidate {
        let path = partition_path(source, record)?;
        next.files
            .entry(path)
            .or_default()
            .insert(id.clone(), record.clone());
    }
    let mut writes = Vec::new();
    for (path, records) in &next.files {
        if previous.files.get(path) == Some(records) {
            continue;
        }
        writes.push(PlannedDocumentWrite {
            path: path.clone(),
            content: encode_collection_file(
                formats,
                &file_source(source, path),
                collection,
                records,
            )?,
        });
    }
    Ok((next, writes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_bucket_keys_accept_only_utc_timestamps() {
        let value = "2026-04-01T08:15:00.123Z";
        assert_eq!(time_bucket_key(value, TimeBucket::Year), Some("2026"));
        assert_eq!(time_bucket_key(value, TimeBucket::Month), Some("2026-04"));
        assert_eq!(time_bucket_key(value, TimeBucket::Day), Some("2026-04-01"));
        assert_eq!(
            time_bucket_key("2024-02-29T23:59:59Z", TimeBucket::Day),
            Some("2024-02-29")
        );
        assert_eq!(
            time_bucket_key("2016-12-31T23:59:60Z", TimeBucket::Month),
            Some("2016-12")
        );
        assert_eq!(
            time_bucket_key("2016-12-31T23:59:60.500Z", TimeBucket::Day),
            Some("2016-12-31")
        );
        for invalid in [
            "2026-04-01T08:15:00.123+02:00",
            "2026-04-01T08:15:00.123",
            "2026-04-01 08:15:00Z",
            "2026-04-01",
            "2026-4-01T08:15:00Z",
            "2026-13-01T08:15:00Z",
            "2026-02-29T08:15:00Z",
            "2026-04-31T08:15:00Z",
            "2026-04-01T24:00:00Z",
            "2026-04-01T08:60:00Z",
            "2026-04-01T08:15:60Z",
            "2026-04-01T23:58:60Z",
            "2026-04-01T23:59:61Z",
            "2026-04-01T08:15:00.Z",
            "2026-04-01T08:15:00.12aZ",
            "+02026-04-01T08:15:00Z",
            "2026-04-01T08:15:00z",
            "",
        ] {
            assert_eq!(
                time_bucket_key(invalid, TimeBucket::Month),
                None,
                "{invalid}"
            );
        }
    }
}
