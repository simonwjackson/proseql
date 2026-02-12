/**
 * Plugin hooks utilities for merging global hooks with collection hooks.
 *
 * Global plugin hooks run before collection-specific hooks because they represent
 * cross-cutting concerns (audit logging, encryption) that should see data before
 * collection-specific transformations.
 */

import type { HooksConfig } from "../types/hook-types.js";
import type { GlobalHooksConfig } from "./plugin-types.js";

/**
 * Merges global plugin hooks with collection-specific hooks.
 *
 * For each hook type, global hooks are prepended before collection hooks.
 * This ensures global hooks (cross-cutting concerns) run first.
 *
 * Type narrowing: Global hooks are `HooksConfig<Record<string, unknown>>`,
 * collection hooks are `HooksConfig<T>`. The merged result is `HooksConfig<T>`
 * with global hooks cast appropriately.
 *
 * @param globalHooks - Global hooks from plugin registry (may be empty/undefined)
 * @param collectionHooks - Collection-specific hooks (may be empty/undefined)
 * @returns Merged hooks config with global hooks first
 */
export const mergeGlobalHooks = <T extends Record<string, unknown>>(
	globalHooks: GlobalHooksConfig | undefined,
	collectionHooks: HooksConfig<T> | undefined,
): HooksConfig<T> => {
	// If no global hooks, return collection hooks as-is (or empty object)
	if (!globalHooks) {
		return collectionHooks ?? {};
	}

	// If no collection hooks, cast global hooks to the collection type
	if (!collectionHooks) {
		return globalHooks as HooksConfig<T>;
	}

	// Merge each hook array: global first, then collection
	return {
		beforeCreate: mergeHookArrays(
			globalHooks.beforeCreate,
			collectionHooks.beforeCreate,
		),
		afterCreate: mergeHookArrays(
			globalHooks.afterCreate,
			collectionHooks.afterCreate,
		),
		beforeUpdate: mergeHookArrays(
			globalHooks.beforeUpdate,
			collectionHooks.beforeUpdate,
		),
		afterUpdate: mergeHookArrays(
			globalHooks.afterUpdate,
			collectionHooks.afterUpdate,
		),
		beforeDelete: mergeHookArrays(
			globalHooks.beforeDelete,
			collectionHooks.beforeDelete,
		),
		afterDelete: mergeHookArrays(
			globalHooks.afterDelete,
			collectionHooks.afterDelete,
		),
		onChange: mergeHookArrays(globalHooks.onChange, collectionHooks.onChange),
	} as HooksConfig<T>;
};

/**
 * Helper to merge two optional hook arrays.
 * Global hooks come first, then collection hooks.
 * Returns undefined if both are empty/undefined.
 */
const mergeHookArrays = <T>(
	global: ReadonlyArray<T> | undefined,
	collection: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined => {
	const hasGlobal = global && global.length > 0;
	const hasCollection = collection && collection.length > 0;

	if (!hasGlobal && !hasCollection) {
		return undefined;
	}

	if (!hasGlobal) {
		return collection;
	}

	if (!hasCollection) {
		return global;
	}

	return [...global, ...collection];
};
