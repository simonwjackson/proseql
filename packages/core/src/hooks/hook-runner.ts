/**
 * Hook runner functions for executing lifecycle hooks.
 *
 * Before-hooks chain: each hook receives the output of the previous one.
 * After-hooks and onChange run independently with errors swallowed.
 */

import { Effect } from "effect";
import type { HookError } from "../errors/crud-errors.js";
import type { UpdateWithOperators } from "../types/crud-types.js";
import type {
	AfterCreateContext,
	AfterCreateHook,
	AfterDeleteContext,
	AfterDeleteHook,
	AfterUpdateContext,
	AfterUpdateHook,
	BeforeCreateContext,
	BeforeCreateHook,
	BeforeDeleteContext,
	BeforeDeleteHook,
	BeforeUpdateContext,
	BeforeUpdateHook,
	OnChangeContext,
	OnChangeHook,
} from "../types/hook-types.js";

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
		return Effect.succeed(initialCtx.data);
	}

	return Effect.reduce(hooks, initialCtx.data, (data, hook) =>
		hook({
			...initialCtx,
			data,
		}),
	);
};

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
		return Effect.succeed(initialCtx.update);
	}

	return Effect.reduce(hooks, initialCtx.update, (update, hook) =>
		hook({
			...initialCtx,
			update,
		}),
	);
};

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
		return Effect.void;
	}

	return Effect.forEach(hooks, (hook) => hook(ctx), { discard: true });
};

// ============================================================================
// After Hooks - Run In Order, Swallow Errors
// ============================================================================

/**
 * Run afterCreate hooks in order. Each hook receives the same context.
 * Errors are swallowed (fire-and-forget).
 *
 * If hooks array is empty or undefined, no-op.
 */
export const runAfterCreateHooks = <T>(
	hooks: ReadonlyArray<AfterCreateHook<T>> | undefined,
	ctx: AfterCreateContext<T>,
): Effect.Effect<void, never> => {
	if (!hooks || hooks.length === 0) {
		return Effect.void;
	}

	return Effect.forEach(
		hooks,
		(hook) =>
			Effect.catchAll(
				hook(ctx) as Effect.Effect<void, unknown>,
				() => Effect.void,
			),
		{ discard: true },
	);
};

/**
 * Run afterUpdate hooks in order. Each hook receives the same context.
 * Errors are swallowed (fire-and-forget).
 *
 * If hooks array is empty or undefined, no-op.
 */
export const runAfterUpdateHooks = <T>(
	hooks: ReadonlyArray<AfterUpdateHook<T>> | undefined,
	ctx: AfterUpdateContext<T>,
): Effect.Effect<void, never> => {
	if (!hooks || hooks.length === 0) {
		return Effect.void;
	}

	return Effect.forEach(
		hooks,
		(hook) =>
			Effect.catchAll(
				hook(ctx) as Effect.Effect<void, unknown>,
				() => Effect.void,
			),
		{ discard: true },
	);
};

/**
 * Run afterDelete hooks in order. Each hook receives the same context.
 * Errors are swallowed (fire-and-forget).
 *
 * If hooks array is empty or undefined, no-op.
 */
export const runAfterDeleteHooks = <T>(
	hooks: ReadonlyArray<AfterDeleteHook<T>> | undefined,
	ctx: AfterDeleteContext<T>,
): Effect.Effect<void, never> => {
	if (!hooks || hooks.length === 0) {
		return Effect.void;
	}

	return Effect.forEach(
		hooks,
		(hook) =>
			Effect.catchAll(
				hook(ctx) as Effect.Effect<void, unknown>,
				() => Effect.void,
			),
		{ discard: true },
	);
};

// ============================================================================
// onChange Hooks - Run In Order, Swallow Errors
// ============================================================================

/**
 * Run onChange hooks in order. Each hook receives the same context.
 * Errors are swallowed (fire-and-forget).
 *
 * If hooks array is empty or undefined, no-op.
 */
export const runOnChangeHooks = <T>(
	hooks: ReadonlyArray<OnChangeHook<T>> | undefined,
	ctx: OnChangeContext<T>,
): Effect.Effect<void, never> => {
	if (!hooks || hooks.length === 0) {
		return Effect.void;
	}

	return Effect.forEach(
		hooks,
		(hook) =>
			Effect.catchAll(
				hook(ctx) as Effect.Effect<void, unknown>,
				() => Effect.void,
			),
		{ discard: true },
	);
};
