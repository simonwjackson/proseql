use serde_json::Value;

use crate::callbacks::CallbackRegistry;
use crate::errors::{EngineError, HookError, HookOperation};

#[derive(Debug, Clone, PartialEq)]
pub struct BeforeCreateContext {
    pub operation: HookOperation,
    pub collection: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BeforeUpdateContext {
    pub operation: HookOperation,
    pub collection: String,
    pub id: String,
    pub existing: Value,
    pub update: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BeforeDeleteContext {
    pub operation: HookOperation,
    pub collection: String,
    pub id: String,
    pub entity: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AfterCreateContext {
    pub operation: HookOperation,
    pub collection: String,
    pub entity: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AfterUpdateContext {
    pub operation: HookOperation,
    pub collection: String,
    pub id: String,
    pub previous: Value,
    pub current: Value,
    pub update: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AfterDeleteContext {
    pub operation: HookOperation,
    pub collection: String,
    pub id: String,
    pub entity: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OnChangeContext {
    Create {
        collection: String,
        entity: Value,
    },
    Update {
        collection: String,
        id: String,
        previous: Value,
        current: Value,
    },
    Delete {
        collection: String,
        id: String,
        entity: Value,
    },
}

fn missing_hook_error(hook_id: &str, collection: &str, operation: HookOperation) -> EngineError {
    EngineError::Hook(HookError {
        hook: hook_id.to_owned(),
        collection: collection.to_owned(),
        operation,
        reason: "missing-hook-callback".to_owned(),
        message: format!(
            "Hook callback '{}' for collection '{}' and operation '{:?}' is not registered",
            hook_id, collection, operation
        ),
    })
}

fn coerce_hook_error(
    hook_id: &str,
    collection: &str,
    operation: HookOperation,
    error: EngineError,
) -> EngineError {
    match error {
        EngineError::Hook(_) => error,
        other => EngineError::Hook(HookError {
            hook: hook_id.to_owned(),
            collection: collection.to_owned(),
            operation,
            reason: other.to_string(),
            message: other.to_string(),
        }),
    }
}

pub fn run_before_create_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    initial: BeforeCreateContext,
) -> Result<Value, EngineError> {
    let mut data = initial.data;
    for hook_id in hook_ids {
        let ctx = BeforeCreateContext {
            operation: HookOperation::Create,
            collection: initial.collection.clone(),
            data,
        };
        let Some(callback) = registry.before_create_hook(hook_id) else {
            return Err(missing_hook_error(
                hook_id,
                initial.collection.as_str(),
                HookOperation::Create,
            ));
        };
        data = callback(&ctx).map_err(|error| {
            coerce_hook_error(
                hook_id,
                initial.collection.as_str(),
                HookOperation::Create,
                error,
            )
        })?;
    }
    Ok(data)
}

pub fn run_before_update_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    initial: BeforeUpdateContext,
) -> Result<Value, EngineError> {
    let mut update = initial.update;
    for hook_id in hook_ids {
        let ctx = BeforeUpdateContext {
            operation: HookOperation::Update,
            collection: initial.collection.clone(),
            id: initial.id.clone(),
            existing: initial.existing.clone(),
            update,
        };
        let Some(callback) = registry.before_update_hook(hook_id) else {
            return Err(missing_hook_error(
                hook_id,
                initial.collection.as_str(),
                HookOperation::Update,
            ));
        };
        update = callback(&ctx).map_err(|error| {
            coerce_hook_error(
                hook_id,
                initial.collection.as_str(),
                HookOperation::Update,
                error,
            )
        })?;
    }
    Ok(update)
}

pub fn run_before_delete_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    ctx: &BeforeDeleteContext,
) -> Result<(), EngineError> {
    for hook_id in hook_ids {
        let Some(callback) = registry.before_delete_hook(hook_id) else {
            return Err(missing_hook_error(
                hook_id,
                ctx.collection.as_str(),
                HookOperation::Delete,
            ));
        };
        callback(ctx).map_err(|error| {
            coerce_hook_error(
                hook_id,
                ctx.collection.as_str(),
                HookOperation::Delete,
                error,
            )
        })?;
    }
    Ok(())
}

pub fn run_after_create_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    ctx: &AfterCreateContext,
) {
    for hook_id in hook_ids {
        if let Some(callback) = registry.after_create_hook(hook_id) {
            let _ = callback(ctx);
        }
    }
}

pub fn run_after_update_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    ctx: &AfterUpdateContext,
) {
    for hook_id in hook_ids {
        if let Some(callback) = registry.after_update_hook(hook_id) {
            let _ = callback(ctx);
        }
    }
}

pub fn run_after_delete_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    ctx: &AfterDeleteContext,
) {
    for hook_id in hook_ids {
        if let Some(callback) = registry.after_delete_hook(hook_id) {
            let _ = callback(ctx);
        }
    }
}

pub fn run_on_change_hooks(
    registry: &CallbackRegistry,
    hook_ids: &[String],
    ctx: &OnChangeContext,
) {
    for hook_id in hook_ids {
        if let Some(callback) = registry.on_change_hook(hook_id) {
            let _ = callback(ctx);
        }
    }
}
