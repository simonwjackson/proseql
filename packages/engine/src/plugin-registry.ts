import {
	type CustomIdGenerator,
	type CustomOperator,
	type GlobalHooksConfig,
	type PluginRegistry,
	type ProseQLPlugin,
	validateDependencies,
	validateOperatorConflicts,
	validatePlugin,
} from "@proseql/core";
import { Effect } from "effect";

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

export const buildPluginRegistry = async (
	plugins?: ReadonlyArray<ProseQLPlugin>,
): Promise<PluginRegistry> => {
	if (!plugins || plugins.length === 0) {
		return {
			codecs: [],
			operators: new Map<string, CustomOperator>(),
			idGenerators: new Map<string, CustomIdGenerator>(),
			globalHooks: {},
		};
	}
	for (const plugin of plugins) {
		await Effect.runPromise(validatePlugin(plugin));
	}
	await Effect.runPromise(validateOperatorConflicts(plugins));
	await Effect.runPromise(validateDependencies(plugins));
	for (const plugin of plugins) {
		if (plugin.initialize) {
			await Effect.runPromise(plugin.initialize());
		}
	}
	const codecs = plugins.flatMap((plugin) => plugin.codecs ?? []);
	const operators = new Map<string, CustomOperator>();
	const idGenerators = new Map<string, CustomIdGenerator>();
	for (const plugin of plugins) {
		for (const operator of plugin.operators ?? [])
			operators.set(operator.name, operator);
		for (const generator of plugin.idGenerators ?? [])
			idGenerators.set(generator.name, generator);
	}
	return {
		codecs,
		operators,
		idGenerators,
		globalHooks: mergeGlobalHooks(plugins),
	};
};

export const mergeGlobalHooks = (
	plugins: ReadonlyArray<ProseQLPlugin>,
): GlobalHooksConfig => {
	const merged: {
		beforeCreate?: GlobalHooksConfig["beforeCreate"];
		afterCreate?: GlobalHooksConfig["afterCreate"];
		beforeUpdate?: GlobalHooksConfig["beforeUpdate"];
		afterUpdate?: GlobalHooksConfig["afterUpdate"];
		beforeDelete?: GlobalHooksConfig["beforeDelete"];
		afterDelete?: GlobalHooksConfig["afterDelete"];
		onChange?: GlobalHooksConfig["onChange"];
	} = {};
	const merge = <T>(
		global: ReadonlyArray<T> | undefined,
		local: ReadonlyArray<T> | undefined,
	): ReadonlyArray<T> | undefined => {
		const values = [...(global ?? []), ...(local ?? [])].filter(isDefined);
		return values.length > 0 ? values : undefined;
	};
	for (const plugin of plugins) {
		const hooks = plugin.hooks;
		if (!hooks) continue;
		merged.beforeCreate = merge(merged.beforeCreate, hooks.beforeCreate);
		merged.afterCreate = merge(merged.afterCreate, hooks.afterCreate);
		merged.beforeUpdate = merge(merged.beforeUpdate, hooks.beforeUpdate);
		merged.afterUpdate = merge(merged.afterUpdate, hooks.afterUpdate);
		merged.beforeDelete = merge(merged.beforeDelete, hooks.beforeDelete);
		merged.afterDelete = merge(merged.afterDelete, hooks.afterDelete);
		merged.onChange = merge(merged.onChange, hooks.onChange);
	}
	return merged as GlobalHooksConfig;
};
