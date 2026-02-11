/**
 * Type definitions for CRUD operations with relationships
 * Implements Phase 2 relationship features with full type safety
 */

import type { CreateInput, UpdateInput } from "./crud-types.js";
import type { RelationshipDef } from "./types.js";

// ============================================================================
// Connection Types
// ============================================================================

/**
 * Input type for connecting to existing entities
 * Supports connection by ID or any unique field combination
 */
export type ConnectInput<T> = { id: string } | Partial<T>; // Any unique field combination

/**
 * Input type for connect or create pattern
 * If entity doesn't exist, create it with provided data
 */
export type ConnectOrCreateInput<T> = {
	where: ConnectInput<T>;
	create: CreateInput<T>;
};

/**
 * Input type for updating with where clause
 * Used for updating specific items in many-to-many relationships
 */
export type UpdateWithWhereInput<T> = {
	where: ConnectInput<T>;
	data: UpdateInput<T>;
};

// ============================================================================
// Relationship Operation Types
// ============================================================================

/**
 * Operations available for single (ref) relationships
 */
export type SingleRelationshipInput<T> = {
	$connect?: ConnectInput<T>;
	$disconnect?: boolean;
	$create?: CreateInput<T>;
	$connectOrCreate?: ConnectOrCreateInput<T>;
	$update?: UpdateInput<T>;
	$delete?: boolean;
};

/**
 * Operations available for many (inverse) relationships
 */
export type ManyRelationshipInput<T> = {
	$connect?: ConnectInput<T> | ConnectInput<T>[];
	$disconnect?: ConnectInput<T> | ConnectInput<T>[] | boolean;
	$create?: CreateInput<T> | CreateInput<T>[];
	$createMany?: CreateInput<T>[];
	$update?: UpdateWithWhereInput<T> | UpdateWithWhereInput<T>[];
	$updateMany?: {
		where: Partial<T>;
		data: UpdateInput<T>;
	};
	$delete?: ConnectInput<T> | ConnectInput<T>[];
	$deleteMany?: Partial<T>;
	$set?: ConnectInput<T>[]; // Replace all (many-to-many)
	$connectOrCreate?: ConnectOrCreateInput<T> | ConnectOrCreateInput<T>[];
};

/**
 * Extract relationship input type based on relationship type
 */
export type RelationshipInput<R> =
	R extends RelationshipDef<infer T, "ref">
		? SingleRelationshipInput<T> | ConnectInput<T>
		: R extends RelationshipDef<infer T, "inverse">
			? ManyRelationshipInput<T>
			: never;

// ============================================================================
// Create with Relationships Types
// ============================================================================

/**
 * Transform entity relationships for create input
 * Allows relationship operations during entity creation
 */
export type CreateWithRelationshipsInput<T, Relations> = CreateInput<T> & {
	[K in keyof Relations]?: RelationshipInput<Relations[K]>;
};

// ============================================================================
// Update with Relationships Types
// ============================================================================

/**
 * Transform entity relationships for update input
 * Allows relationship operations during entity update
 */
export type UpdateWithRelationshipsInput<T, Relations> = UpdateInput<T> & {
	[K in keyof Relations]?: RelationshipInput<Relations[K]>;
};

// ============================================================================
// Delete with Relationships Types
// ============================================================================

/**
 * Cascade behavior options for delete operations
 */
export type CascadeOption =
	| "cascade" // Delete related entities
	| "restrict" // Prevent deletion if related entities exist
	| "set_null" // Set foreign key to null
	| "cascade_soft" // Soft delete related entities
	| "preserve"; // Do nothing (default)

/**
 * Delete options with cascade configuration
 */
export type DeleteWithRelationshipsOptions<_T, Relations> = {
	soft?: boolean;
	returnDeleted?: boolean;
	include?: {
		[K in keyof Relations]?: CascadeOption;
	};
};

/**
 * Result of delete operation with cascade information
 */
export type DeleteWithRelationshipsResult<T> = {
	deleted: T;
	cascaded?: {
		[collection: string]: {
			count: number;
			ids: string[];
		};
	};
};

// ============================================================================
// Batch Operations with Relationships
// ============================================================================

/**
 * Options for batch operations with relationships
 */
export type BatchRelationshipOptions = {
	validateRelationships?: boolean;
	skipDuplicates?: boolean;
};

/**
 * Result of batch operations with relationship information
 */
export type BatchRelationshipResult<T> = {
	success: T[];
	failed: Array<{
		data: Partial<T>;
		error: string;
		index: number;
	}>;
	cascaded?: {
		[collection: string]: {
			count: number;
			action: CascadeOption;
		};
	};
};

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Relationship constraint validation
 */
export type RelationshipConstraint = {
	type: "max_count" | "unique" | "required";
	field: string;
	value?: unknown;
	message: string;
};

/**
 * Foreign key violation error details
 */
export type ForeignKeyViolation = {
	field: string;
	targetCollection: string;
	missingId: string;
	message: string;
};

/**
 * Restrict violation error details
 */
export type RestrictViolation = {
	collection: string;
	relatedCollection: string;
	relatedCount: number;
	message: string;
};

// ============================================================================
// Type Helpers
// ============================================================================

/**
 * Check if a relationship input contains operations
 */
export function isRelationshipOperation(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const keys = Object.keys(value);
	return keys.some((key) => key.startsWith("$"));
}

/**
 * Extract entity type from relationship definition
 */
export type ExtractRelationshipEntity<R> =
	R extends RelationshipDef<infer T, infer _> ? T : never;

/**
 * Extract relationship type (ref/inverse) from definition
 */
export type ExtractRelationshipType<R> =
	R extends RelationshipDef<infer _, infer Type> ? Type : never;

/**
 * Filter relationships by type
 */
export type FilterRelationshipsByType<
	Relations,
	Type extends "ref" | "inverse",
> = {
	[K in keyof Relations as Relations[K] extends RelationshipDef<infer _, Type>
		? K
		: never]: Relations[K];
};

/**
 * Get ref relationships only
 */
export type RefRelationships<Relations> = FilterRelationshipsByType<
	Relations,
	"ref"
>;

/**
 * Get inverse relationships only
 */
export type InverseRelationships<Relations> = FilterRelationshipsByType<
	Relations,
	"inverse"
>;
