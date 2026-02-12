/**
 * RPC Payload Schemas for proseql operations.
 *
 * These schemas define the wire format for RPC procedure payloads.
 * They wrap the underlying proseql types (QueryConfig, AggregateConfig, etc.)
 * in a form that can be serialized across RPC transport.
 *
 * @module
 */

import { Schema } from "effect";

// ============================================================================
// Common Schemas
// ============================================================================

/**
 * Schema for sort order values.
 */
export const SortOrderSchema = Schema.Literal("asc", "desc");

/**
 * Schema for sort configuration.
 * Maps field names to sort order.
 */
export const SortConfigSchema = Schema.Record({
	key: Schema.String,
	value: SortOrderSchema,
});

/**
 * Schema for cursor pagination configuration.
 */
export const CursorConfigSchema = Schema.Struct({
	key: Schema.String,
	after: Schema.optional(Schema.String),
	before: Schema.optional(Schema.String),
	limit: Schema.Number,
});

/**
 * Schema for filter operators on values.
 * Supports MongoDB-style comparison and logical operators.
 */
export const FilterOperatorsSchema = Schema.Struct({
	$eq: Schema.optional(Schema.Unknown),
	$ne: Schema.optional(Schema.Unknown),
	$gt: Schema.optional(Schema.Unknown),
	$gte: Schema.optional(Schema.Unknown),
	$lt: Schema.optional(Schema.Unknown),
	$lte: Schema.optional(Schema.Unknown),
	$in: Schema.optional(Schema.Array(Schema.Unknown)),
	$nin: Schema.optional(Schema.Array(Schema.Unknown)),
	$startsWith: Schema.optional(Schema.String),
	$endsWith: Schema.optional(Schema.String),
	$contains: Schema.optional(Schema.Unknown),
	$search: Schema.optional(Schema.String),
	$all: Schema.optional(Schema.Array(Schema.Unknown)),
	$size: Schema.optional(Schema.Number),
});

/**
 * Schema for a where clause condition.
 * Can be a direct value, filter operators, or logical operators.
 */
export const WhereClauseSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Union(
		Schema.Unknown, // Direct value match
		FilterOperatorsSchema, // Operator-based filter
	),
});

/**
 * Schema for search configuration.
 */
export const SearchConfigSchema = Schema.Struct({
	query: Schema.String,
	fields: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * Schema for populate configuration.
 * Maps relationship names to true or nested populate config.
 */
export const PopulateConfigSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Union(Schema.Literal(true), Schema.Unknown),
});

/**
 * Schema for select configuration.
 * Can be an array of field names or an object with true values.
 */
export const SelectConfigSchema = Schema.Union(
	Schema.Array(Schema.String),
	Schema.Record({ key: Schema.String, value: Schema.Literal(true) }),
);

// ============================================================================
// Payload Schemas
// ============================================================================

/**
 * Payload for findById operations.
 */
export const FindByIdPayloadSchema = Schema.Struct({
	id: Schema.String,
});

export type FindByIdPayload = typeof FindByIdPayloadSchema.Type;

/**
 * Payload for query operations.
 * Wraps the full QueryConfig structure.
 */
export const QueryPayloadSchema = Schema.Struct({
	where: Schema.optional(
		Schema.Record({
			key: Schema.String,
			value: Schema.Unknown,
		}),
	),
	sort: Schema.optional(SortConfigSchema),
	select: Schema.optional(SelectConfigSchema),
	populate: Schema.optional(PopulateConfigSchema),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
	cursor: Schema.optional(CursorConfigSchema),
});

export type QueryPayload = typeof QueryPayloadSchema.Type;

/**
 * Payload for create operations.
 * The data field contains the entity to create (id is optional).
 */
export const CreatePayloadSchema = Schema.Struct({
	data: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
});

export type CreatePayload = typeof CreatePayloadSchema.Type;

/**
 * Payload for update operations.
 * Includes the entity ID and the partial updates to apply.
 */
export const UpdatePayloadSchema = Schema.Struct({
	id: Schema.String,
	updates: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
});

export type UpdatePayload = typeof UpdatePayloadSchema.Type;

/**
 * Payload for delete operations.
 */
export const DeletePayloadSchema = Schema.Struct({
	id: Schema.String,
});

export type DeletePayload = typeof DeletePayloadSchema.Type;

/**
 * Payload for aggregate operations.
 * Supports scalar and grouped aggregation.
 */
export const AggregatePayloadSchema = Schema.Struct({
	where: Schema.optional(
		Schema.Record({
			key: Schema.String,
			value: Schema.Unknown,
		}),
	),
	groupBy: Schema.optional(
		Schema.Union(Schema.String, Schema.Array(Schema.String)),
	),
	count: Schema.optional(Schema.Literal(true)),
	sum: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
	avg: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
	min: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
	max: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
});

export type AggregatePayload = typeof AggregatePayloadSchema.Type;

// ============================================================================
// Batch Operation Payload Schemas
// ============================================================================

/**
 * Payload for createMany operations.
 */
export const CreateManyPayloadSchema = Schema.Struct({
	data: Schema.Array(
		Schema.Record({
			key: Schema.String,
			value: Schema.Unknown,
		}),
	),
	options: Schema.optional(
		Schema.Struct({
			skipDuplicates: Schema.optional(Schema.Boolean),
			validateRelationships: Schema.optional(Schema.Boolean),
		}),
	),
});

export type CreateManyPayload = typeof CreateManyPayloadSchema.Type;

/**
 * Payload for updateMany operations.
 * Uses a predicate function serialized as a string (for RPC).
 * Note: The actual predicate is passed as a function at runtime;
 * for RPC, we accept a where clause instead.
 */
export const UpdateManyPayloadSchema = Schema.Struct({
	where: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
	updates: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
});

export type UpdateManyPayload = typeof UpdateManyPayloadSchema.Type;

/**
 * Payload for deleteMany operations.
 * Uses a where clause to identify entities to delete.
 */
export const DeleteManyPayloadSchema = Schema.Struct({
	where: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
	options: Schema.optional(
		Schema.Struct({
			limit: Schema.optional(Schema.Number),
		}),
	),
});

export type DeleteManyPayload = typeof DeleteManyPayloadSchema.Type;

/**
 * Payload for upsert operations.
 */
export const UpsertPayloadSchema = Schema.Struct({
	where: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
	create: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
	update: Schema.Record({
		key: Schema.String,
		value: Schema.Unknown,
	}),
});

export type UpsertPayload = typeof UpsertPayloadSchema.Type;

/**
 * Payload for upsertMany operations.
 */
export const UpsertManyPayloadSchema = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			where: Schema.Record({
				key: Schema.String,
				value: Schema.Unknown,
			}),
			create: Schema.Record({
				key: Schema.String,
				value: Schema.Unknown,
			}),
			update: Schema.Record({
				key: Schema.String,
				value: Schema.Unknown,
			}),
		}),
	),
});

export type UpsertManyPayload = typeof UpsertManyPayloadSchema.Type;

// ============================================================================
// Result Schemas
// ============================================================================

/**
 * Schema for aggregate results (scalar aggregation).
 */
export const AggregateResultSchema = Schema.Struct({
	count: Schema.optional(Schema.Number),
	sum: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Number })),
	avg: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Number) }),
	),
	min: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	max: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export type AggregateResultType = typeof AggregateResultSchema.Type;

/**
 * Schema for a single group result in grouped aggregation.
 */
export const GroupResultSchema = Schema.Struct({
	group: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	count: Schema.optional(Schema.Number),
	sum: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Number })),
	avg: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Number) }),
	),
	min: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	max: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export type GroupResultType = typeof GroupResultSchema.Type;

/**
 * Schema for grouped aggregate results.
 */
export const GroupedAggregateResultSchema = Schema.Array(GroupResultSchema);

export type GroupedAggregateResultType = typeof GroupedAggregateResultSchema.Type;

/**
 * Schema for cursor page info.
 */
export const CursorPageInfoSchema = Schema.Struct({
	startCursor: Schema.NullOr(Schema.String),
	endCursor: Schema.NullOr(Schema.String),
	hasNextPage: Schema.Boolean,
	hasPreviousPage: Schema.Boolean,
});

export type CursorPageInfoType = typeof CursorPageInfoSchema.Type;

/**
 * Schema for cursor page result.
 */
export const CursorPageResultSchema = Schema.Struct({
	items: Schema.Array(Schema.Unknown),
	pageInfo: CursorPageInfoSchema,
});

export type CursorPageResultType = typeof CursorPageResultSchema.Type;

/**
 * Schema for createMany result.
 */
export const CreateManyResultSchema = Schema.Struct({
	created: Schema.Array(Schema.Unknown),
	skipped: Schema.optional(
		Schema.Array(
			Schema.Struct({
				data: Schema.Unknown,
				reason: Schema.String,
			}),
		),
	),
});

export type CreateManyResultType = typeof CreateManyResultSchema.Type;

/**
 * Schema for updateMany result.
 */
export const UpdateManyResultSchema = Schema.Struct({
	count: Schema.Number,
	updated: Schema.Array(Schema.Unknown),
});

export type UpdateManyResultType = typeof UpdateManyResultSchema.Type;

/**
 * Schema for deleteMany result.
 */
export const DeleteManyResultSchema = Schema.Struct({
	count: Schema.Number,
	deleted: Schema.Array(Schema.Unknown),
});

export type DeleteManyResultType = typeof DeleteManyResultSchema.Type;

/**
 * Schema for upsert result.
 */
export const UpsertResultSchema = Schema.Struct({
	entity: Schema.Unknown,
	__action: Schema.Literal("created", "updated"),
});

export type UpsertResultType = typeof UpsertResultSchema.Type;

/**
 * Schema for upsertMany result.
 */
export const UpsertManyResultSchema = Schema.Struct({
	created: Schema.Array(Schema.Unknown),
	updated: Schema.Array(Schema.Unknown),
	unchanged: Schema.Array(Schema.Unknown),
});

export type UpsertManyResultType = typeof UpsertManyResultSchema.Type;
