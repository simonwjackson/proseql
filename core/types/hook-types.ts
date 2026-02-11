/**
 * Lifecycle hook types for CRUD operations.
 * Hooks intercept operations before/after mutation for transformation, validation, or side effects.
 */

import type { Effect } from "effect";
import type { UpdateWithOperators } from "./crud-types.js";
import type { HookError } from "../errors/crud-errors.js";

// ============================================================================
// Before Hook Context Types
// ============================================================================

/**
 * Context provided to beforeCreate hooks.
 * The hook receives the validated entity about to be inserted and can transform it.
 */
export interface BeforeCreateContext<T> {
	readonly operation: "create";
	readonly collection: string;
	readonly data: T;
}

/**
 * Context provided to beforeUpdate hooks.
 * The hook receives the current entity state and the update payload, and can transform the update.
 */
export interface BeforeUpdateContext<T> {
	readonly operation: "update";
	readonly collection: string;
	readonly id: string;
	readonly existing: T;
	readonly update: UpdateWithOperators<T>;
}

/**
 * Context provided to beforeDelete hooks.
 * The hook can inspect the entity about to be deleted and reject if needed.
 */
export interface BeforeDeleteContext<T> {
	readonly operation: "delete";
	readonly collection: string;
	readonly id: string;
	readonly entity: T;
}

// ============================================================================
// After Hook Context Types
// ============================================================================

/**
 * Context provided to afterCreate hooks.
 * Contains the entity as it was stored after the create operation.
 */
export interface AfterCreateContext<T> {
	readonly operation: "create";
	readonly collection: string;
	readonly entity: T;
}

/**
 * Context provided to afterUpdate hooks.
 * Contains both previous and current state to enable diffing.
 */
export interface AfterUpdateContext<T> {
	readonly operation: "update";
	readonly collection: string;
	readonly id: string;
	readonly previous: T;
	readonly current: T;
	readonly update: UpdateWithOperators<T>;
}

/**
 * Context provided to afterDelete hooks.
 * Contains the entity that was deleted.
 */
export interface AfterDeleteContext<T> {
	readonly operation: "delete";
	readonly collection: string;
	readonly id: string;
	readonly entity: T;
}

// ============================================================================
// onChange Context Type (Discriminated Union)
// ============================================================================

/**
 * Context for onCreate change event.
 */
export interface OnChangeCreateContext<T> {
	readonly type: "create";
	readonly collection: string;
	readonly entity: T;
}

/**
 * Context for onUpdate change event.
 */
export interface OnChangeUpdateContext<T> {
	readonly type: "update";
	readonly collection: string;
	readonly id: string;
	readonly previous: T;
	readonly current: T;
}

/**
 * Context for onDelete change event.
 */
export interface OnChangeDeleteContext<T> {
	readonly type: "delete";
	readonly collection: string;
	readonly id: string;
	readonly entity: T;
}

/**
 * Discriminated union of all change contexts.
 * The `type` field discriminates between create, update, and delete events.
 */
export type OnChangeContext<T> =
	| OnChangeCreateContext<T>
	| OnChangeUpdateContext<T>
	| OnChangeDeleteContext<T>;

// ============================================================================
// Hook Function Signatures
// ============================================================================

/**
 * Before-hook for create operations.
 * Receives the validated entity about to be inserted and can transform it.
 * Return the (possibly transformed) entity, or fail with HookError to abort.
 */
export type BeforeCreateHook<T> = (
	ctx: BeforeCreateContext<T>,
) => Effect.Effect<T, HookError>;

/**
 * Before-hook for update operations.
 * Receives the current entity state and the update payload.
 * Return the (possibly transformed) update payload, or fail with HookError to abort.
 */
export type BeforeUpdateHook<T> = (
	ctx: BeforeUpdateContext<T>,
) => Effect.Effect<UpdateWithOperators<T>, HookError>;

/**
 * Before-hook for delete operations.
 * Can inspect the entity about to be deleted and reject if needed.
 * Return void to proceed, or fail with HookError to abort.
 */
export type BeforeDeleteHook<T> = (
	ctx: BeforeDeleteContext<T>,
) => Effect.Effect<void, HookError>;

/**
 * After-hook for create operations.
 * Receives the entity as it was stored. Used for side effects.
 * Errors are swallowed (fire-and-forget) - hooks may fail but failures are ignored.
 */
export type AfterCreateHook<T> = (
	ctx: AfterCreateContext<T>,
) => Effect.Effect<void, unknown>;

/**
 * After-hook for update operations.
 * Receives both previous and current state to enable diffing.
 * Errors are swallowed (fire-and-forget) - hooks may fail but failures are ignored.
 */
export type AfterUpdateHook<T> = (
	ctx: AfterUpdateContext<T>,
) => Effect.Effect<void, unknown>;

/**
 * After-hook for delete operations.
 * Receives the entity that was deleted.
 * Errors are swallowed (fire-and-forget) - hooks may fail but failures are ignored.
 */
export type AfterDeleteHook<T> = (
	ctx: AfterDeleteContext<T>,
) => Effect.Effect<void, unknown>;

/**
 * Generic change hook that fires after any mutation.
 * Receives a discriminated union context with type "create", "update", or "delete".
 * Errors are swallowed (fire-and-forget) - hooks may fail but failures are ignored.
 */
export type OnChangeHook<T> = (
	ctx: OnChangeContext<T>,
) => Effect.Effect<void, unknown>;

// ============================================================================
// Hooks Configuration
// ============================================================================

/**
 * Configuration object for lifecycle hooks on a collection.
 * All fields are optional. Missing fields mean no hooks for that lifecycle point.
 * Hooks run in array order: before-hooks chain (each receives previous output),
 * after-hooks and onChange run independently (fire-and-forget).
 */
export interface HooksConfig<T> {
	readonly beforeCreate?: ReadonlyArray<BeforeCreateHook<T>>;
	readonly afterCreate?: ReadonlyArray<AfterCreateHook<T>>;
	readonly beforeUpdate?: ReadonlyArray<BeforeUpdateHook<T>>;
	readonly afterUpdate?: ReadonlyArray<AfterUpdateHook<T>>;
	readonly beforeDelete?: ReadonlyArray<BeforeDeleteHook<T>>;
	readonly afterDelete?: ReadonlyArray<AfterDeleteHook<T>>;
	readonly onChange?: ReadonlyArray<OnChangeHook<T>>;
}
