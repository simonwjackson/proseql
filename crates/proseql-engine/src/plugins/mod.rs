use std::collections::{HashMap, HashSet};

use crate::callbacks::CallbackRegistry;
use crate::descriptor::CollectionDescriptor;
use crate::errors::{EngineError, PluginError};

const BUILT_IN_OPERATORS: &[&str] = &[
    "$eq",
    "$ne",
    "$in",
    "$nin",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
    "$startsWith",
    "$endsWith",
    "$contains",
    "$all",
    "$size",
    "$search",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCodecMetadata {
    pub name: String,
    pub extensions: Vec<String>,
    pub encode_callback_id: String,
    pub decode_callback_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginOperatorMetadata {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginIdGeneratorMetadata {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlobalHookIds {
    pub before_create: Vec<String>,
    pub after_create: Vec<String>,
    pub before_update: Vec<String>,
    pub after_update: Vec<String>,
    pub before_delete: Vec<String>,
    pub after_delete: Vec<String>,
    pub on_change: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginDefinition {
    pub name: String,
    pub dependencies: Vec<String>,
    pub conflicts: Vec<String>,
    pub codecs: Vec<PluginCodecMetadata>,
    pub operators: Vec<PluginOperatorMetadata>,
    pub id_generators: Vec<PluginIdGeneratorMetadata>,
    pub global_hooks: GlobalHookIds,
    pub initialize_callback_id: Option<String>,
    pub shutdown_callback_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginRegistry {
    pub plugins: Vec<PluginDefinition>,
    pub codecs: Vec<PluginCodecMetadata>,
    pub operators: HashMap<String, String>,
    pub id_generators: HashMap<String, String>,
    pub global_hooks: GlobalHookIds,
}

fn plugin_error(plugin: &str, reason: &str, message: impl Into<String>) -> EngineError {
    EngineError::Plugin(Box::new(PluginError {
        plugin: plugin.to_owned(),
        reason: reason.to_owned(),
        message: message.into(),
    }))
}

pub fn validate_plugin_definition(plugin: &PluginDefinition) -> Result<(), EngineError> {
    if plugin.name.trim().is_empty() {
        return Err(plugin_error(
            plugin.name.as_str(),
            "invalid_name",
            "Plugin name must be a non-empty string",
        ));
    }

    for (index, codec) in plugin.codecs.iter().enumerate() {
        if codec.name.trim().is_empty() {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_codec",
                format!("Codec at index {index} must have a non-empty 'name' string"),
            ));
        }
        if codec.extensions.is_empty() || codec.extensions.iter().any(|ext| ext.trim().is_empty()) {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_codec",
                format!(
                    "Codec '{}' must have a non-empty 'extensions' array",
                    codec.name
                ),
            ));
        }
        if codec.encode_callback_id.trim().is_empty() || codec.decode_callback_id.trim().is_empty()
        {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_codec",
                format!(
                    "Codec '{}' must declare non-empty encode/decode callback ids",
                    codec.name
                ),
            ));
        }
    }

    for (index, operator) in plugin.operators.iter().enumerate() {
        if operator.name.trim().is_empty() {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_operator",
                format!("Operator at index {index} must have a non-empty 'name' string"),
            ));
        }
        if !operator.name.starts_with('$') {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_operator",
                format!("Operator '{}' name must start with '$'", operator.name),
            ));
        }
    }

    for (index, generator) in plugin.id_generators.iter().enumerate() {
        if generator.name.trim().is_empty() {
            return Err(plugin_error(
                plugin.name.as_str(),
                "invalid_id_generator",
                format!("ID generator at index {index} must have a non-empty 'name' string"),
            ));
        }
    }

    Ok(())
}

pub fn build_plugin_registry(
    plugins: &[PluginDefinition],
    callbacks: &mut CallbackRegistry,
) -> Result<PluginRegistry, EngineError> {
    for plugin in plugins {
        validate_plugin_definition(plugin)?;
    }

    let plugin_names = plugins
        .iter()
        .map(|plugin| plugin.name.clone())
        .collect::<HashSet<_>>();
    for plugin in plugins {
        let mut missing = Vec::new();
        for dependency in &plugin.dependencies {
            if !plugin_names.contains(dependency) {
                missing.push(dependency.clone());
            }
        }
        if !missing.is_empty() {
            let suffix = if missing.len() == 1 {
                "dependency"
            } else {
                "dependencies"
            };
            return Err(plugin_error(
                plugin.name.as_str(),
                "missing_dependencies",
                format!("Missing {suffix}: {}", missing.join(", ")),
            ));
        }
        for conflict in &plugin.conflicts {
            if plugin_names.contains(conflict) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "plugin_conflict",
                    format!(
                        "Plugin '{}' conflicts with plugin '{}'",
                        plugin.name, conflict
                    ),
                ));
            }
        }
    }

    let mut operators = HashMap::new();
    let mut id_generators = HashMap::new();
    let mut codecs = Vec::new();
    let mut global_hooks = GlobalHookIds::default();

    for plugin in plugins {
        for codec in &plugin.codecs {
            if !callbacks.has_codec_encode(codec.encode_callback_id.as_str())
                || !callbacks.has_codec_decode(codec.decode_callback_id.as_str())
            {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_codec",
                    format!(
                        "Codec '{}' must register both encode callback '{}' and decode callback '{}'",
                        codec.name, codec.encode_callback_id, codec.decode_callback_id
                    ),
                ));
            }
        }
        codecs.extend(plugin.codecs.clone());
        for operator in &plugin.operators {
            if BUILT_IN_OPERATORS
                .iter()
                .any(|built_in| *built_in == operator.name)
            {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "operator_conflict",
                    format!(
                        "Operator '{}' conflicts with built-in operator",
                        operator.name
                    ),
                ));
            }
            if let Some(existing) = operators.insert(operator.name.clone(), plugin.name.clone()) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "operator_conflict",
                    format!(
                        "Operator '{}' conflicts with operator from plugin '{}'",
                        operator.name, existing
                    ),
                ));
            }
            if !callbacks.has_custom_operator(operator.name.as_str()) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_operator",
                    format!(
                        "Operator '{}' is not registered in CallbackRegistry",
                        operator.name
                    ),
                ));
            }
        }
        for generator in &plugin.id_generators {
            if let Some(existing) =
                id_generators.insert(generator.name.clone(), plugin.name.clone())
            {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "id_generator_conflict",
                    format!(
                        "ID generator '{}' conflicts with generator from plugin '{}'",
                        generator.name, existing
                    ),
                ));
            }
            if !callbacks.has_id_generator(generator.name.as_str()) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_id_generator",
                    format!(
                        "ID generator '{}' is not registered in CallbackRegistry",
                        generator.name
                    ),
                ));
            }
        }

        for hook_id in &plugin.global_hooks.before_create {
            if callbacks.before_create_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global beforeCreate hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.before_update {
            if callbacks.before_update_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global beforeUpdate hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.before_delete {
            if callbacks.before_delete_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global beforeDelete hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.after_create {
            if callbacks.after_create_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global afterCreate hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.after_update {
            if callbacks.after_update_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global afterUpdate hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.after_delete {
            if callbacks.after_delete_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global afterDelete hook '{}' is not registered", hook_id),
                ));
            }
        }
        for hook_id in &plugin.global_hooks.on_change {
            if callbacks.on_change_hook(hook_id).is_none() {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_hook",
                    format!("Global onChange hook '{}' is not registered", hook_id),
                ));
            }
        }

        if let Some(callback_id) = &plugin.initialize_callback_id {
            if !callbacks.has_lifecycle_callback(callback_id) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_initialize",
                    format!("Initialize callback '{}' is not registered", callback_id),
                ));
            }
        }
        if let Some(callback_id) = &plugin.shutdown_callback_id {
            if !callbacks.has_lifecycle_callback(callback_id) {
                return Err(plugin_error(
                    plugin.name.as_str(),
                    "invalid_shutdown",
                    format!("Shutdown callback '{}' is not registered", callback_id),
                ));
            }
        }

        global_hooks
            .before_create
            .extend(plugin.global_hooks.before_create.clone());
        global_hooks
            .after_create
            .extend(plugin.global_hooks.after_create.clone());
        global_hooks
            .before_update
            .extend(plugin.global_hooks.before_update.clone());
        global_hooks
            .after_update
            .extend(plugin.global_hooks.after_update.clone());
        global_hooks
            .before_delete
            .extend(plugin.global_hooks.before_delete.clone());
        global_hooks
            .after_delete
            .extend(plugin.global_hooks.after_delete.clone());
        global_hooks
            .on_change
            .extend(plugin.global_hooks.on_change.clone());
    }

    callbacks.set_global_before_create_hooks(global_hooks.before_create.clone());
    callbacks.set_global_after_create_hooks(global_hooks.after_create.clone());
    callbacks.set_global_before_update_hooks(global_hooks.before_update.clone());
    callbacks.set_global_after_update_hooks(global_hooks.after_update.clone());
    callbacks.set_global_before_delete_hooks(global_hooks.before_delete.clone());
    callbacks.set_global_after_delete_hooks(global_hooks.after_delete.clone());
    callbacks.set_global_on_change_hooks(global_hooks.on_change.clone());

    Ok(PluginRegistry {
        plugins: plugins.to_vec(),
        codecs,
        operators,
        id_generators,
        global_hooks,
    })
}

pub fn initialize_plugins(
    registry: &PluginRegistry,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    for plugin in &registry.plugins {
        if let Some(callback_id) = &plugin.initialize_callback_id {
            if let Some(result) = callbacks.invoke_lifecycle_callback(callback_id) {
                result?;
            }
        }
    }
    Ok(())
}

pub fn shutdown_plugins(registry: &PluginRegistry, callbacks: &CallbackRegistry) {
    for plugin in registry.plugins.iter().rev() {
        if let Some(callback_id) = &plugin.shutdown_callback_id {
            if let Some(result) = callbacks.invoke_lifecycle_callback(callback_id) {
                let _ = result;
            }
        }
    }
}

pub fn finalize_plugins(
    registry: &PluginRegistry,
    callbacks: &CallbackRegistry,
    flush: impl FnOnce() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let flush_result = flush();
    shutdown_plugins(registry, callbacks);
    flush_result
}

pub fn validate_collection_id_generators(
    collections: &[CollectionDescriptor],
    registry: &PluginRegistry,
) -> Result<(), EngineError> {
    for collection in collections {
        if let Some(id_generator) = &collection.id_generator {
            if !registry.id_generators.contains_key(id_generator) {
                return Err(plugin_error(
                    "(collection config)",
                    "missing_id_generator",
                    format!(
                        "Collection '{}' references idGenerator '{}' which is not registered by any plugin",
                        collection.name, id_generator
                    ),
                ));
            }
        }
        if let crate::descriptor::IdStrategy::NamedGenerator { name } = &collection.id_strategy {
            if !registry.id_generators.contains_key(name) {
                return Err(plugin_error(
                    "(collection config)",
                    "missing_id_generator",
                    format!(
                        "Collection '{}' references named id generator '{}' which is not registered by any plugin",
                        collection.name, name
                    ),
                ));
            }
        }
    }
    Ok(())
}
