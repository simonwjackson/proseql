/**
 * Core type definitions for CRUD operations with full type safety
 */

import type { Effect } from "effect";
import type { TransactionError } from "../errors/crud-errors.js";
import type { SmartCollection } from "./types.js";

// ============================================================================
// Base Entity Types
// ============================================================================

/**
 * Base requirements for all entities in the database
 */
export interface BaseEntity {
	id: string;
	createdAt?: string;
	updatedAt?: string;
}

/**
 * Minimal entity type with just id field
 */
export interface MinimalEntity {
	id: string;
}

// ============================================================================
// Create Operation Types
// ============================================================================

/**
 * Input type for create operations
 * - ID is optional (will be auto-generated if not provided)
 * - Timestamps are excluded (will be auto-generated)
 */
export type CreateInput<T> = Omit<T, "id" | "createdAt" | "updatedAt"> & {
	id?: string;
};

/**
 * Options for batch create operations
 */
export type CreateManyOptions = {
	skipDuplicates?: boolean;
	validateRelationships?: boolean;
};

// ============================================================================
// Update Operation Types
// ============================================================================

/**
 * Input type for update operations
 * - ID and createdAt are immutable
 * - All other fields are optional
 */
export type UpdateInput<T> = Partial<Omit<T, "id" | "createdAt">> & {
	updatedAt?: string;
};

/**
 * Type-safe update operators for different field types
 */
export type UpdateOperatorValue<T> = T extends number
	? {
			$increment?: number;
			$decrement?: number;
			$multiply?: number;
			$set?: T;
		}
	: T extends string
		? {
				$set?: T;
				$append?: string;
				$prepend?: string;
			}
		: T extends unknown[]
			? {
					$append?: T extends (infer U)[] ? U | U[] : never;
					$prepend?: T extends (infer U)[] ? U | U[] : never;
					$remove?: T extends (infer U)[] ? U | ((item: U) => boolean) : never;
					$set?: T;
				}
			: T extends boolean
				? {
						$set?: T;
						$toggle?: boolean;
					}
				: {
						$set?: T;
					};

/**
 * Update input with support for operators
 */
export type UpdateWithOperators<T> = {
	[K in keyof UpdateInput<T>]?:
		| UpdateInput<T>[K]
		| UpdateOperatorValue<K extends keyof T ? T[K] : never>;
};

// ============================================================================
// Delete Operation Types
// ============================================================================

/**
 * Options for delete operations
 * - Soft delete is only available if entity has deletedAt field
 */
export type DeleteOptions<T> = T extends {
	deletedAt?: string | null | undefined;
}
	? {
			soft?: boolean;
			returnDeleted?: boolean;
		}
	: {
			returnDeleted?: boolean;
		};

/**
 * Options for batch delete operations
 */
export type DeleteManyOptions<T> = DeleteOptions<T> & {
	limit?: number;
};

// ============================================================================
// Upsert Operation Types
// ============================================================================

/**
 * Input for upsert operations
 * - Where clause must use unique fields
 * - Create and update can have different shapes
 */
export type UpsertInput<T, UniqueFields extends keyof T = never> = {
	where: [UniqueFields] extends [never]
		? { id: string } // If no unique fields, must use ID
		: Pick<T, UniqueFields> | { id: string }; // Can use unique fields or ID
	create: CreateInput<T>;
	update: UpdateWithOperators<T>;
};

/**
 * Internal input type for upsert operations.
 * Allows any where clause since validation is done at runtime.
 * Use this for internal implementation; UpsertInput provides compile-time safety.
 */
export type UpsertInternalInput<T> = {
	where: Partial<T> | { id: string };
	create: CreateInput<T>;
	update: UpdateWithOperators<T>;
};

/**
 * Result type for upsert operations
 * Includes metadata about whether entity was created or updated
 */
export type UpsertResult<T> = T & {
	__action: "created" | "updated";
};

// ============================================================================
// Batch Operation Result Types
// ============================================================================

/**
 * Result for batch operations that can partially fail
 */
export type BatchResult<T, E = never> = {
	success: T[];
	failed: Array<{
		data: Partial<T>;
		error: E;
		index: number;
	}>;
	skipped?: Array<{
		data: Partial<T>;
		reason: string;
		index: number;
	}>;
};

/**
 * Result for createMany operations
 */
export type CreateManyResult<T> = {
	created: T[];
	skipped?: Array<{
		data: Partial<T>;
		reason: string;
	}>;
};

/**
 * Result for updateMany operations
 */
export type UpdateManyResult<T> = {
	count: number;
	updated: T[];
};

/**
 * Result for deleteMany operations
 */
export type DeleteManyResult<T> = {
	count: number;
	deleted: T[];
};

/**
 * Result for upsertMany operations
 */
export type UpsertManyResult<T> = {
	created: T[];
	updated: T[];
	unchanged: T[];
};

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result of validation operations
 */
export type ValidationResult<T = unknown> = {
	valid: boolean;
	errors: Array<{
		field: string;
		message: string;
		value?: unknown;
		code?: string;
	}>;
	warnings?: Array<{
		field: string;
		message: string;
	}>;
};

/**
 * Foreign key validation configuration
 */
export type ForeignKeyValidation = {
	field: string;
	foreignKey: string;
	targetCollection: string;
	optional?: boolean;
};

// ============================================================================
// Transaction Types
// ============================================================================

/**
 * Transaction context for multi-operation atomicity.
 * Provides collection accessors, lifecycle methods, and introspection.
 */
export type TransactionContext<DB = Record<string, SmartCollection<unknown>>> = {
	/** Finalize changes, trigger persistence for mutated collections, mark inactive */
	readonly commit: () => Effect.Effect<void, TransactionError>;
	/** Restore all snapshots, mark inactive, trigger no persistence. Always fails to short-circuit. */
	readonly rollback: () => Effect.Effect<never, TransactionError>;
	/** Whether the transaction is still open */
	readonly isActive: boolean;
	/** Which collections have been written to during the transaction */
	readonly mutatedCollections: ReadonlySet<string>;
} & {
	/** Collection accessors — same interface as db.collectionName */
	readonly [K in keyof DB]: DB[K];
};

// ============================================================================
// Type Helpers
// ============================================================================

/**
 * Helper to make specific fields optional
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Helper to make specific fields required
 */
export type RequiredBy<T, K extends keyof T> = Omit<T, K> &
	Required<Pick<T, K>>;

/**
 * Deep partial type that handles nested objects
 */
export type DeepPartial<T> = T extends object
	? {
			[P in keyof T]?: DeepPartial<T[P]>;
		}
	: T;

/**
 * Extract the entity type from a collection
 */
export type ExtractEntity<T> = T extends { query: () => AsyncIterable<infer E> }
	? E
	: never;

/**
 * Check if a type has a specific field
 */
export type HasField<T, K extends string> = K extends keyof T ? true : false;

/**
 * Type guard for checking if value is an update operator
 */
export function isUpdateOperator(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const keys = Object.keys(value);
	return keys.some((key) => key.startsWith("$"));
}

/**
 * Type guard for checking if entity has soft delete capability
 */
export function hasSoftDelete<T extends MinimalEntity>(
	entity: T,
): entity is T & { deletedAt?: string } {
	return "deletedAt" in entity;
}

/**
 * Helper to create delete options for soft-deletable entities
 */
export function softDelete(returnDeleted: boolean = false): SoftDeleteOptions {
	return { soft: true, returnDeleted };
}

/**
 * Helper to create delete options for hard delete
 */
export function hardDelete(returnDeleted: boolean = false): HardDeleteOptions {
	return { returnDeleted };
}

/**
 * Helper to create deleteMany options for soft-deletable entities
 */
export function softDeleteMany(
	options: { returnDeleted?: boolean; limit?: number } = {},
): SoftDeleteManyOptions {
	return { soft: true, ...options };
}

/**
 * Helper to create deleteMany options for hard delete
 */
export function hardDeleteMany(
	options: { returnDeleted?: boolean; limit?: number } = {},
): HardDeleteManyOptions {
	return options;
}

// ============================================================================
// Helper Types for Delete Operation Overloading
// ============================================================================

/**
 * Constraint for entities that support soft delete
 */
export type SoftDeletable = { deletedAt?: string };

/**
 * Check if a type is soft deletable at the type level
 */
export type IsSoftDeletable<T> = T extends SoftDeletable ? true : false;

/**
 * Extract entities that support soft delete
 */
export type ExtractSoftDeletable<T> = T extends SoftDeletable ? T : never;

/**
 * Extract entities that don't support soft delete
 */
export type ExtractNonSoftDeletable<T> = T extends SoftDeletable ? never : T;

/**
 * Explicit delete options for soft-deletable entities
 */
export type SoftDeleteOptions = {
	soft?: boolean;
	returnDeleted?: boolean;
};

/**
 * Explicit delete options for non-soft-deletable entities
 */
export type HardDeleteOptions = {
	returnDeleted?: boolean;
};

/**
 * Explicit delete many options for soft-deletable entities
 */
export type SoftDeleteManyOptions = {
	soft?: boolean;
	returnDeleted?: boolean;
	limit?: number;
};

/**
 * Explicit delete many options for non-soft-deletable entities
 */
export type HardDeleteManyOptions = {
	returnDeleted?: boolean;
	limit?: number;
};
