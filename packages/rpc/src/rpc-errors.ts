import { Schema } from "effect";

const tagged = <const Tag extends string>(tag: Tag) => Schema.Literal(tag);

export const NotFoundErrorSchema = Schema.Struct({
	_tag: tagged("NotFoundError"),
	collection: Schema.String,
	id: Schema.String,
	message: Schema.String,
});
export const DuplicateKeyErrorSchema = Schema.Struct({
	_tag: tagged("DuplicateKeyError"),
	collection: Schema.String,
	field: Schema.String,
	value: Schema.String,
	existingId: Schema.String,
	message: Schema.String,
});
export const ForeignKeyErrorSchema = Schema.Struct({
	_tag: tagged("ForeignKeyError"),
	collection: Schema.String,
	field: Schema.String,
	value: Schema.String,
	targetCollection: Schema.String,
	message: Schema.String,
});
export const ValidationIssueSchema = Schema.Struct({
	field: Schema.String,
	message: Schema.String,
	value: Schema.optional(Schema.Unknown),
	expected: Schema.optional(Schema.String),
	received: Schema.optional(Schema.String),
});
export const ValidationErrorSchema = Schema.Struct({
	_tag: tagged("ValidationError"),
	message: Schema.String,
	issues: Schema.Array(ValidationIssueSchema),
});
export const UniqueConstraintErrorSchema = Schema.Struct({
	_tag: tagged("UniqueConstraintError"),
	collection: Schema.String,
	constraint: Schema.String,
	fields: Schema.Array(Schema.String),
	values: Schema.Record(Schema.String, Schema.Unknown),
	existingId: Schema.String,
	message: Schema.String,
});
export const ConcurrencyErrorSchema = Schema.Struct({
	_tag: tagged("ConcurrencyError"),
	collection: Schema.String,
	id: Schema.String,
	message: Schema.String,
});
export const OperationErrorSchema = Schema.Struct({
	_tag: tagged("OperationError"),
	operation: Schema.String,
	reason: Schema.String,
	message: Schema.String,
});
export const TransactionErrorSchema = Schema.Struct({
	_tag: tagged("TransactionError"),
	operation: Schema.Literals(["begin", "commit", "rollback"]),
	reason: Schema.String,
	message: Schema.String,
});
export const HookErrorSchema = Schema.Struct({
	_tag: tagged("HookError"),
	hook: Schema.String,
	collection: Schema.String,
	operation: Schema.Literals(["create", "update", "delete"]),
	reason: Schema.String,
	message: Schema.String,
});
export const DanglingReferenceErrorSchema = Schema.Struct({
	_tag: tagged("DanglingReferenceError"),
	collection: Schema.String,
	field: Schema.String,
	targetId: Schema.String,
	message: Schema.String,
});
export const CollectionNotFoundErrorSchema = Schema.Struct({
	_tag: tagged("CollectionNotFoundError"),
	collection: Schema.String,
	message: Schema.String,
});
export const PopulationErrorSchema = Schema.Struct({
	_tag: tagged("PopulationError"),
	collection: Schema.String,
	relationship: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
});
export const InvalidRpcRequestErrorSchema = Schema.Struct({
	_tag: tagged("InvalidRpcRequestError"),
	operation: Schema.String,
	message: Schema.String,
	path: Schema.optional(Schema.String),
});

export const CrudErrorSchema = Schema.Union([
	NotFoundErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	ValidationErrorSchema,
	UniqueConstraintErrorSchema,
	ConcurrencyErrorSchema,
	OperationErrorSchema,
	TransactionErrorSchema,
	HookErrorSchema,
]);
export const QueryErrorSchema = Schema.Union([
	DanglingReferenceErrorSchema,
	CollectionNotFoundErrorSchema,
	PopulationErrorSchema,
	ValidationErrorSchema,
	InvalidRpcRequestErrorSchema,
]);
export const RpcErrorSchema = Schema.Union([
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
	InvalidRpcRequestErrorSchema,
]);

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
export type InvalidRpcRequestError = typeof InvalidRpcRequestErrorSchema.Type;
export type CrudError = typeof CrudErrorSchema.Type;
export type QueryError = typeof QueryErrorSchema.Type;
export type RpcError = typeof RpcErrorSchema.Type;
