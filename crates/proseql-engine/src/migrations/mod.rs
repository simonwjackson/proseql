use serde_json::{Map, Value};

use crate::callbacks::CallbackRegistry;
use crate::descriptor::MigrationDescriptor;
use crate::errors::{EngineError, MigrationError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DryRunStatus {
    UpToDate,
    NeedsMigration,
    Ahead,
    NoFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunMigration {
    pub from: u32,
    pub to: u32,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunReport {
    pub current_version: u32,
    pub target_version: u32,
    pub status: DryRunStatus,
    pub migrations_to_apply: Vec<DryRunMigration>,
}

fn migration_error(
    collection: &str,
    from_version: u32,
    to_version: u32,
    step: i32,
    reason: &str,
    message: impl Into<String>,
) -> EngineError {
    EngineError::Migration(Box::new(MigrationError {
        collection: collection.to_owned(),
        from_version,
        to_version,
        step,
        reason: reason.to_owned(),
        message: message.into(),
    }))
}

pub fn validate_migration_registry(
    collection: &str,
    version: u32,
    migrations: &[MigrationDescriptor],
) -> Result<(), EngineError> {
    if version == 0 && migrations.is_empty() {
        return Ok(());
    }
    if version > 0 && migrations.is_empty() {
        return Err(migration_error(
            collection,
            0,
            version,
            -1,
            "empty-registry",
            format!(
                "Collection \"{}\" has version {} but no migrations defined. Cannot migrate from version 0 to {}.",
                collection, version, version
            ),
        ));
    }

    for (index, migration) in migrations.iter().enumerate() {
        if migration.to != migration.from + 1 {
            return Err(migration_error(
                collection,
                migration.from,
                migration.to,
                index as i32,
                "invalid-increment",
                format!(
                    "Migration at index {} has from={} and to={}, but to must equal from + 1.",
                    index, migration.from, migration.to
                ),
            ));
        }
    }

    let mut seen_from = std::collections::HashSet::new();
    for (index, migration) in migrations.iter().enumerate() {
        if !seen_from.insert(migration.from) {
            return Err(migration_error(
                collection,
                migration.from,
                migration.to,
                index as i32,
                "duplicate-from",
                format!(
                    "Duplicate migration from version {}. Each version can only have one migration.",
                    migration.from
                ),
            ));
        }
    }

    let mut sorted = migrations.to_vec();
    sorted.sort_by_key(|migration| migration.from);
    let Some(first) = sorted.first() else {
        return Ok(());
    };
    if first.from != 0 {
        return Err(migration_error(
            collection,
            0,
            first.from,
            -1,
            "missing-start",
            format!(
                "First migration starts at version {}, but must start at version 0. No path from version 0 to {}.",
                first.from, first.from
            ),
        ));
    }

    for window in sorted.windows(2) {
        let previous = &window[0];
        let current = &window[1];
        if current.from != previous.to {
            return Err(migration_error(
                collection,
                previous.to,
                current.from,
                -1,
                "gap-in-chain",
                format!(
                    "Gap in migration chain: no migration from version {} to {}.",
                    previous.to, current.from
                ),
            ));
        }
    }

    let last = sorted.last().expect("sorted is not empty");
    if last.to != version {
        return Err(migration_error(
            collection,
            last.from,
            last.to,
            -1,
            "version-mismatch",
            format!(
                "Last migration goes to version {}, but collection version is {}.",
                last.to, version
            ),
        ));
    }

    Ok(())
}

pub fn applicable_migrations(
    migrations: &[MigrationDescriptor],
    file_version: u32,
    target_version: u32,
) -> Vec<MigrationDescriptor> {
    let mut applicable = migrations
        .iter()
        .filter(|migration| migration.from >= file_version && migration.to <= target_version)
        .cloned()
        .collect::<Vec<_>>();
    applicable.sort_by_key(|migration| migration.from);
    applicable
}

pub fn run_migrations(
    registry: &CallbackRegistry,
    collection: &str,
    file_version: u32,
    target_version: u32,
    migrations: &[MigrationDescriptor],
    data: Map<String, Value>,
) -> Result<Map<String, Value>, EngineError> {
    if file_version >= target_version {
        return Ok(data);
    }

    validate_migration_registry(collection, target_version, migrations)?;
    let applicable = applicable_migrations(migrations, file_version, target_version);
    if applicable.is_empty() {
        return Ok(data);
    }

    let mut current = data;
    for (index, migration) in applicable.iter().enumerate() {
        let callback = registry.invoke_migration(migration.callback_id.as_str(), &current);
        let Some(result) = callback else {
            return Err(migration_error(
                collection,
                migration.from,
                migration.to,
                index as i32,
                "transform-failed",
                format!(
                    "Migration {}→{} failed: callback '{}' is not registered",
                    migration.from, migration.to, migration.callback_id
                ),
            ));
        };
        current = result.map_err(|error| match error {
            EngineError::Migration(_) => error,
            other => migration_error(
                collection,
                migration.from,
                migration.to,
                index as i32,
                "transform-failed",
                format!(
                    "Migration {}→{} failed: {}",
                    migration.from, migration.to, other
                ),
            ),
        })?;
    }

    Ok(current)
}

pub fn post_migration_validation_error(
    collection: &str,
    from_version: u32,
    to_version: u32,
    message: impl Into<String>,
) -> EngineError {
    migration_error(
        collection,
        from_version,
        to_version,
        -1,
        "post-migration-validation-failed",
        message,
    )
}

pub fn dry_run_report(
    file_exists: bool,
    file_version: u32,
    target_version: u32,
    migrations: &[MigrationDescriptor],
) -> DryRunReport {
    if !file_exists {
        return DryRunReport {
            current_version: 0,
            target_version,
            status: DryRunStatus::NoFile,
            migrations_to_apply: Vec::new(),
        };
    }
    if file_version > target_version {
        return DryRunReport {
            current_version: file_version,
            target_version,
            status: DryRunStatus::Ahead,
            migrations_to_apply: Vec::new(),
        };
    }
    if file_version == target_version {
        return DryRunReport {
            current_version: file_version,
            target_version,
            status: DryRunStatus::UpToDate,
            migrations_to_apply: Vec::new(),
        };
    }
    DryRunReport {
        current_version: file_version,
        target_version,
        status: DryRunStatus::NeedsMigration,
        migrations_to_apply: applicable_migrations(migrations, file_version, target_version)
            .into_iter()
            .map(|migration| DryRunMigration {
                from: migration.from,
                to: migration.to,
                description: migration.description,
            })
            .collect(),
    }
}
