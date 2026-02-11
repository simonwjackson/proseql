/**
 * Lifecycle hook types for CRUD operations.
 * Hooks intercept operations before/after mutation for transformation, validation, or side effects.
 */

import type { UpdateWithOperators } from "./crud-types.js";

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
