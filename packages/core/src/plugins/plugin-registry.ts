/**
 * Plugin registry builder.
 * Validates plugins and merges their contributions into a single registry.
 */

import { Effect } from "effect";
import type { PluginError } from "../errors/plugin-errors.js";
import type {
	CustomIdGenerator,
	CustomOperator,
	GlobalHooksConfig,
	PluginRegistry,
	ProseQLPlugin,
} from "./plugin-types.js";
import {
	validateDependencies,
	validateOperatorConflicts,
	validatePlugin,
} from "./plugin-validation.js";

// ============================================================================
// Plugin Registry Builder
// ============================================================================

/**
 * Creates an empty PluginRegistry with no contributions.
 */
const createEmptyRegistry = (): PluginRegistry => ({
	codecs: [],
	operators: new Map<string, CustomOperator>(),
	idGenerators: new Map<string, CustomIdGenerator>(),
	globalHooks: {},
});

/**
 * Builds a PluginRegistry from an array of plugins.
 *
 * This function:
 * 1. Validates each plugin individually (structure, codecs, operators, generators)
 * 2. Validates operator conflicts (between plugins and with built-in operators)
 * 3. Validates dependencies (all declared dependencies must exist)
 * 4. Merges codecs (append in registration order)
 * 5. Merges operators into a Map (O(1) lookup)
 * 6. Merges ID generators into a Map (O(1) lookup)
 * 7. Merges global hooks (concatenate arrays in registration order)
 *
 * If plugins is undefined or empty, returns an empty registry.
 *
 * @param plugins - Array of plugins to validate and merge (optional)
 * @returns Effect<PluginRegistry, PluginError> - The merged registry or validation error
 */
export const buildPluginRegistry = (
	plugins?: ReadonlyArray<ProseQLPlugin>,
): Effect.Effect<PluginRegistry, PluginError> => {
	// Handle empty or undefined plugin arrays
	if (plugins === undefined || plugins.length === 0) {
		return Effect.succeed(createEmptyRegistry());
	}

	return Effect.gen(function* () {
		// Validate each plugin individually
		for (const plugin of plugins) {
			yield* validatePlugin(plugin);
		}

		// Validate operator conflicts
		yield* validateOperatorConflicts(plugins);

		// Validate dependencies
		yield* validateDependencies(plugins);

		// Merge codecs (append in registration order)
		const codecs = plugins.flatMap((plugin) => plugin.codecs ?? []);

		// Merge operators into a Map
		const operators = new Map<string, CustomOperator>();
		for (const plugin of plugins) {
			if (plugin.operators !== undefined) {
				for (const operator of plugin.operators) {
					operators.set(operator.name, operator);
				}
			}
		}

		// Merge ID generators into a Map
		const idGenerators = new Map<string, CustomIdGenerator>();
		for (const plugin of plugins) {
			if (plugin.idGenerators !== undefined) {
				for (const generator of plugin.idGenerators) {
					idGenerators.set(generator.name, generator);
				}
			}
		}

		// Merge global hooks (concatenate arrays in registration order)
		const globalHooks = mergeGlobalHooks(plugins);

		return {
			codecs,
			operators,
			idGenerators,
			globalHooks,
		};
	});
};

/**
 * Merges global hooks from all plugins.
 * Hooks are concatenated in plugin registration order.
 */
const mergeGlobalHooks = (
	plugins: ReadonlyArray<ProseQLPlugin>,
): GlobalHooksConfig => {
	// Use a mutable object for building
	const mutableResult: {
		beforeCreate?: Array<GlobalHooksConfig["beforeCreate"]>;
		afterCreate?: Array<GlobalHooksConfig["afterCreate"]>;
		beforeUpdate?: Array<GlobalHooksConfig["beforeUpdate"]>;
		afterUpdate?: Array<GlobalHooksConfig["afterUpdate"]>;
		beforeDelete?: Array<GlobalHooksConfig["beforeDelete"]>;
		afterDelete?: Array<GlobalHooksConfig["afterDelete"]>;
		onChange?: Array<GlobalHooksConfig["onChange"]>;
	} = {};

	for (const plugin of plugins) {
		if (plugin.hooks === undefined) {
			continue;
		}

		if (plugin.hooks.beforeCreate !== undefined) {
			mutableResult.beforeCreate = mutableResult.beforeCreate ?? [];
			mutableResult.beforeCreate.push(plugin.hooks.beforeCreate);
		}

		if (plugin.hooks.afterCreate !== undefined) {
			mutableResult.afterCreate = mutableResult.afterCreate ?? [];
			mutableResult.afterCreate.push(plugin.hooks.afterCreate);
		}

		if (plugin.hooks.beforeUpdate !== undefined) {
			mutableResult.beforeUpdate = mutableResult.beforeUpdate ?? [];
			mutableResult.beforeUpdate.push(plugin.hooks.beforeUpdate);
		}

		if (plugin.hooks.afterUpdate !== undefined) {
			mutableResult.afterUpdate = mutableResult.afterUpdate ?? [];
			mutableResult.afterUpdate.push(plugin.hooks.afterUpdate);
		}

		if (plugin.hooks.beforeDelete !== undefined) {
			mutableResult.beforeDelete = mutableResult.beforeDelete ?? [];
			mutableResult.beforeDelete.push(plugin.hooks.beforeDelete);
		}

		if (plugin.hooks.afterDelete !== undefined) {
			mutableResult.afterDelete = mutableResult.afterDelete ?? [];
			mutableResult.afterDelete.push(plugin.hooks.afterDelete);
		}

		if (plugin.hooks.onChange !== undefined) {
			mutableResult.onChange = mutableResult.onChange ?? [];
			mutableResult.onChange.push(plugin.hooks.onChange);
		}
	}

	// Flatten the arrays
	const finalResult: GlobalHooksConfig = {};

	if (mutableResult.beforeCreate !== undefined) {
		(
			finalResult as { beforeCreate: GlobalHooksConfig["beforeCreate"] }
		).beforeCreate = mutableResult.beforeCreate.flat();
	}

	if (mutableResult.afterCreate !== undefined) {
		(
			finalResult as { afterCreate: GlobalHooksConfig["afterCreate"] }
		).afterCreate = mutableResult.afterCreate.flat();
	}

	if (mutableResult.beforeUpdate !== undefined) {
		(
			finalResult as { beforeUpdate: GlobalHooksConfig["beforeUpdate"] }
		).beforeUpdate = mutableResult.beforeUpdate.flat();
	}

	if (mutableResult.afterUpdate !== undefined) {
		(
			finalResult as { afterUpdate: GlobalHooksConfig["afterUpdate"] }
		).afterUpdate = mutableResult.afterUpdate.flat();
	}

	if (mutableResult.beforeDelete !== undefined) {
		(
			finalResult as { beforeDelete: GlobalHooksConfig["beforeDelete"] }
		).beforeDelete = mutableResult.beforeDelete.flat();
	}

	if (mutableResult.afterDelete !== undefined) {
		(
			finalResult as { afterDelete: GlobalHooksConfig["afterDelete"] }
		).afterDelete = mutableResult.afterDelete.flat();
	}

	if (mutableResult.onChange !== undefined) {
		(finalResult as { onChange: GlobalHooksConfig["onChange"] }).onChange =
			mutableResult.onChange.flat();
	}

	return finalResult;
};
