/**
 * Hook runner functions for executing lifecycle hooks.
 *
 * Before-hooks chain: each hook receives the output of the previous one.
 * After-hooks and onChange run independently with errors swallowed.
 */

import { Effect } from "effect"
import type { HookError } from "../errors/crud-errors.js"
import type {
	BeforeCreateHook,
	BeforeUpdateHook,
	BeforeDeleteHook,
	BeforeCreateContext,
	BeforeUpdateContext,
	BeforeDeleteContext,
} from "../types/hook-types.js"
import type { UpdateWithOperators } from "../types/crud-types.js"

// ============================================================================
// Before Hooks - Chain in Order
// ============================================================================

/**
 * Run beforeCreate hooks in order, chaining each hook's output to the next.
 * Returns the final transformed data, or fails with HookError if any hook rejects.
 *
 * If hooks array is empty or undefined, returns the initial data unchanged.
 */
export const runBeforeCreateHooks = <T>(
	hooks: ReadonlyArray<BeforeCreateHook<T>> | undefined,
	initialCtx: BeforeCreateContext<T>,
): Effect.Effect<T, HookError> => {
	if (!hooks || hooks.length === 0) {
		return Effect.succeed(initialCtx.data)
	}

	return Effect.reduce(hooks, initialCtx.data, (data, hook) =>
		hook({
			...initialCtx,
			data,
		}),
	)
}

/**
 * Run beforeUpdate hooks in order, chaining each hook's output to the next.
 * Returns the final transformed update payload, or fails with HookError if any hook rejects.
 *
 * If hooks array is empty or undefined, returns the initial update unchanged.
 */
export const runBeforeUpdateHooks = <T>(
	hooks: ReadonlyArray<BeforeUpdateHook<T>> | undefined,
	initialCtx: BeforeUpdateContext<T>,
): Effect.Effect<UpdateWithOperators<T>, HookError> => {
	if (!hooks || hooks.length === 0) {
		return Effect.succeed(initialCtx.update)
	}

	return Effect.reduce(hooks, initialCtx.update, (update, hook) =>
		hook({
			...initialCtx,
			update,
		}),
	)
}

/**
 * Run beforeDelete hooks in order. Each hook receives the same context.
 * Returns void on success, or fails with HookError if any hook rejects.
 *
 * If hooks array is empty or undefined, returns void (no-op).
 */
export const runBeforeDeleteHooks = <T>(
	hooks: ReadonlyArray<BeforeDeleteHook<T>> | undefined,
	ctx: BeforeDeleteContext<T>,
): Effect.Effect<void, HookError> => {
	if (!hooks || hooks.length === 0) {
		return Effect.void
	}

	return Effect.forEach(hooks, (hook) => hook(ctx), { discard: true })
}
