/**
 * Serializable Effect Schemas for proseql tagged errors.
 *
 * These schemas enable proseql's errors to be serialized/deserialized across
 * RPC transport, allowing typed errors to flow through to clients where they
 * can be caught with `Effect.catchTag`.
 *
 * @module
 */

import { Schema } from "effect";

// ============================================================================
// CRUD Error Schemas
// ============================================================================

/**
 * Schema for NotFoundError — entity with the given ID was not found.
 */
export class NotFoundErrorSchema extends Schema.TaggedError<NotFoundErrorSchema>(
	"NotFoundError",
)("NotFoundError", {
	collection: Schema.String,
	id: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for DuplicateKeyError — entity with the same key already exists.
 */
export class DuplicateKeyErrorSchema extends Schema.TaggedError<DuplicateKeyErrorSchema>(
	"DuplicateKeyError",
)("DuplicateKeyError", {
	collection: Schema.String,
	field: Schema.String,
	value: Schema.String,
	existingId: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for ForeignKeyError — referenced entity does not exist.
 */
export class ForeignKeyErrorSchema extends Schema.TaggedError<ForeignKeyErrorSchema>(
	"ForeignKeyError",
)("ForeignKeyError", {
	collection: Schema.String,
	field: Schema.String,
	value: Schema.String,
	targetCollection: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for a single validation issue.
 */
export const ValidationIssueSchema = Schema.Struct({
	field: Schema.String,
	message: Schema.String,
	value: Schema.optional(Schema.Unknown),
	expected: Schema.optional(Schema.String),
	received: Schema.optional(Schema.String),
});

/**
 * Schema for ValidationError — schema validation failed.
 */
export class ValidationErrorSchema extends Schema.TaggedError<ValidationErrorSchema>(
	"ValidationError",
)("ValidationError", {
	message: Schema.String,
	issues: Schema.Array(ValidationIssueSchema),
}) {}

/**
 * Schema for UniqueConstraintError — unique constraint was violated.
 */
export class UniqueConstraintErrorSchema extends Schema.TaggedError<UniqueConstraintErrorSchema>(
	"UniqueConstraintError",
)("UniqueConstraintError", {
	collection: Schema.String,
	constraint: Schema.String,
	fields: Schema.Array(Schema.String),
	values: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	existingId: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for ConcurrencyError — concurrent modification conflict.
 */
export class ConcurrencyErrorSchema extends Schema.TaggedError<ConcurrencyErrorSchema>(
	"ConcurrencyError",
)("ConcurrencyError", {
	collection: Schema.String,
	id: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for OperationError — operation was rejected (e.g., update/delete on append-only).
 */
export class OperationErrorSchema extends Schema.TaggedError<OperationErrorSchema>(
	"OperationError",
)("OperationError", {
	operation: Schema.String,
	reason: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for TransactionError — transaction operation failed.
 */
export class TransactionErrorSchema extends Schema.TaggedError<TransactionErrorSchema>(
	"TransactionError",
)("TransactionError", {
	operation: Schema.Literal("begin", "commit", "rollback"),
	reason: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for HookError — lifecycle hook rejected the operation.
 */
export class HookErrorSchema extends Schema.TaggedError<HookErrorSchema>(
	"HookError",
)("HookError", {
	hook: Schema.String,
	collection: Schema.String,
	operation: Schema.Literal("create", "update", "delete"),
	reason: Schema.String,
	message: Schema.String,
}) {}

// ============================================================================
// Query Error Schemas
// ============================================================================

/**
 * Schema for DanglingReferenceError — referenced entity no longer exists.
 */
export class DanglingReferenceErrorSchema extends Schema.TaggedError<DanglingReferenceErrorSchema>(
	"DanglingReferenceError",
)("DanglingReferenceError", {
	collection: Schema.String,
	field: Schema.String,
	targetId: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for CollectionNotFoundError — collection does not exist in config.
 */
export class CollectionNotFoundErrorSchema extends Schema.TaggedError<CollectionNotFoundErrorSchema>(
	"CollectionNotFoundError",
)("CollectionNotFoundError", {
	collection: Schema.String,
	message: Schema.String,
}) {}

/**
 * Schema for PopulationError — relationship population failed.
 */
export class PopulationErrorSchema extends Schema.TaggedError<PopulationErrorSchema>(
	"PopulationError",
)("PopulationError", {
	collection: Schema.String,
	relationship: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

// ============================================================================
// Union Schemas
// ============================================================================

/**
 * Union of all CRUD error schemas.
 */
export const CrudErrorSchema = Schema.Union(
	NotFoundErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	ValidationErrorSchema,
	UniqueConstraintErrorSchema,
	ConcurrencyErrorSchema,
	OperationErrorSchema,
	TransactionErrorSchema,
	HookErrorSchema,
);

/**
 * Union of all query error schemas.
 */
export const QueryErrorSchema = Schema.Union(
	DanglingReferenceErrorSchema,
	CollectionNotFoundErrorSchema,
	PopulationErrorSchema,
);

/**
 * Union of all RPC error schemas.
 */
export const RpcErrorSchema = Schema.Union(
	NotFoundErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	ValidationErrorSchema,
	UniqueConstraintErrorSchema,
	ConcurrencyErrorSchema,
	OperationErrorSchema,
	TransactionErrorSchema,
	HookErrorSchema,
	DanglingReferenceErrorSchema,
	CollectionNotFoundErrorSchema,
	PopulationErrorSchema,
);

// ============================================================================
// Type Exports
// ============================================================================

export type NotFoundError = typeof NotFoundErrorSchema.Type;
export type DuplicateKeyError = typeof DuplicateKeyErrorSchema.Type;
export type ForeignKeyError = typeof ForeignKeyErrorSchema.Type;
export type ValidationError = typeof ValidationErrorSchema.Type;
export type UniqueConstraintError = typeof UniqueConstraintErrorSchema.Type;
export type ConcurrencyError = typeof ConcurrencyErrorSchema.Type;
export type OperationError = typeof OperationErrorSchema.Type;
export type TransactionError = typeof TransactionErrorSchema.Type;
export type HookError = typeof HookErrorSchema.Type;
export type DanglingReferenceError = typeof DanglingReferenceErrorSchema.Type;
export type CollectionNotFoundError = typeof CollectionNotFoundErrorSchema.Type;
export type PopulationError = typeof PopulationErrorSchema.Type;
export type CrudError = typeof CrudErrorSchema.Type;
export type QueryError = typeof QueryErrorSchema.Type;
export type RpcError = typeof RpcErrorSchema.Type;
