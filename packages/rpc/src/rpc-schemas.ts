import { Schema } from "effect";

export const RpcRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
export const SortOrderSchema = Schema.Literals(["asc", "desc"]);
export const SortConfigSchema = Schema.Record(Schema.String, SortOrderSchema);
export const CursorConfigSchema = Schema.Struct({
	key: Schema.String,
	after: Schema.optional(Schema.String),
	before: Schema.optional(Schema.String),
	limit: Schema.Number,
});
export const SearchConfigSchema = Schema.Struct({
	query: Schema.String,
	fields: Schema.optional(Schema.Array(Schema.String)),
});
export const SelectConfigSchema = Schema.Union([
	Schema.Array(Schema.String),
	RpcRecordSchema,
]);
export const PopulateConfigSchema = RpcRecordSchema;
export const WhereClauseSchema = RpcRecordSchema;

export const FindByIdPayloadSchema = Schema.Struct({ id: Schema.String });
export const QueryPayloadSchema = Schema.Struct({
	where: Schema.optional(WhereClauseSchema),
	sort: Schema.optional(SortConfigSchema),
	select: Schema.optional(SelectConfigSchema),
	populate: Schema.optional(PopulateConfigSchema),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
	cursor: Schema.optional(CursorConfigSchema),
});
export const CreatePayloadSchema = Schema.Struct({ data: RpcRecordSchema });
export const UpdatePayloadSchema = Schema.Struct({
	id: Schema.String,
	updates: RpcRecordSchema,
});
export const DeletePayloadSchema = Schema.Struct({ id: Schema.String });
const StringOrStringsSchema = Schema.Union([
	Schema.String,
	Schema.Array(Schema.String),
]);
export const AggregatePayloadSchema = Schema.Struct({
	where: Schema.optional(WhereClauseSchema),
	groupBy: Schema.optional(StringOrStringsSchema),
	count: Schema.optional(Schema.Literal(true)),
	sum: Schema.optional(StringOrStringsSchema),
	avg: Schema.optional(StringOrStringsSchema),
	min: Schema.optional(StringOrStringsSchema),
	max: Schema.optional(StringOrStringsSchema),
});
export const CreateManyPayloadSchema = Schema.Struct({
	data: Schema.Array(RpcRecordSchema),
	options: Schema.optional(
		Schema.Struct({
			skipDuplicates: Schema.optional(Schema.Boolean),
			validateRelationships: Schema.optional(Schema.Boolean),
		}),
	),
});
export const UpdateManyPayloadSchema = Schema.Struct({
	where: WhereClauseSchema,
	updates: RpcRecordSchema,
});
export const DeleteManyPayloadSchema = Schema.Struct({
	where: WhereClauseSchema,
	options: Schema.optional(
		Schema.Struct({
			soft: Schema.optional(Schema.Boolean),
			limit: Schema.optional(Schema.Number),
		}),
	),
});
export const UpsertPayloadSchema = Schema.Struct({
	where: WhereClauseSchema,
	create: RpcRecordSchema,
	update: RpcRecordSchema,
});
export const UpsertManyPayloadSchema = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			where: WhereClauseSchema,
			create: RpcRecordSchema,
			update: RpcRecordSchema,
		}),
	),
});

export const QueryRowSchema = RpcRecordSchema;
export const CursorPageInfoSchema = Schema.Struct({
	startCursor: Schema.NullOr(Schema.String),
	endCursor: Schema.NullOr(Schema.String),
	hasNextPage: Schema.Boolean,
	hasPreviousPage: Schema.Boolean,
});
export const CursorPageResultSchema = Schema.Struct({
	items: Schema.Array(QueryRowSchema),
	pageInfo: CursorPageInfoSchema,
});
export const CollectedQueryResultSchema = Schema.Union([
	Schema.Array(QueryRowSchema),
	CursorPageResultSchema,
]);

const NumberRecordSchema = Schema.Record(Schema.String, Schema.Number);
const NullableNumberRecordSchema = Schema.Record(
	Schema.String,
	Schema.NullOr(Schema.Number),
);
export const AggregateResultSchema = Schema.Struct({
	count: Schema.optional(Schema.Number),
	sum: Schema.optional(NumberRecordSchema),
	avg: Schema.optional(NullableNumberRecordSchema),
	min: Schema.optional(RpcRecordSchema),
	max: Schema.optional(RpcRecordSchema),
});
export const GroupResultSchema = Schema.Struct({
	group: RpcRecordSchema,
	count: Schema.optional(Schema.Number),
	sum: Schema.optional(NumberRecordSchema),
	avg: Schema.optional(NullableNumberRecordSchema),
	min: Schema.optional(RpcRecordSchema),
	max: Schema.optional(RpcRecordSchema),
});
export const GroupedAggregateResultSchema = Schema.Array(GroupResultSchema);
export const AggregateRpcResultSchema = Schema.Union([
	AggregateResultSchema,
	GroupedAggregateResultSchema,
]);

export const CreateManyResultSchema = Schema.Struct({
	created: Schema.Array(QueryRowSchema),
	skipped: Schema.optional(
		Schema.Array(
			Schema.Struct({ data: Schema.Unknown, reason: Schema.String }),
		),
	),
});
export const UpdateManyResultSchema = Schema.Struct({
	count: Schema.Number,
	updated: Schema.Array(QueryRowSchema),
});
export const DeleteManyResultSchema = Schema.Struct({
	count: Schema.Number,
	deleted: Schema.Array(QueryRowSchema),
});
export const UpsertResultSchema = RpcRecordSchema;
export const UpsertManyResultSchema = Schema.Struct({
	created: Schema.Array(QueryRowSchema),
	updated: Schema.Array(QueryRowSchema),
	unchanged: Schema.Array(QueryRowSchema),
});

export type FindByIdPayload = typeof FindByIdPayloadSchema.Type;
export type QueryPayload = typeof QueryPayloadSchema.Type;
export type CreatePayload = typeof CreatePayloadSchema.Type;
export type UpdatePayload = typeof UpdatePayloadSchema.Type;
export type DeletePayload = typeof DeletePayloadSchema.Type;
export type AggregatePayload = typeof AggregatePayloadSchema.Type;
export type CreateManyPayload = typeof CreateManyPayloadSchema.Type;
export type UpdateManyPayload = typeof UpdateManyPayloadSchema.Type;
export type DeleteManyPayload = typeof DeleteManyPayloadSchema.Type;
export type UpsertPayload = typeof UpsertPayloadSchema.Type;
export type UpsertManyPayload = typeof UpsertManyPayloadSchema.Type;
export type CollectedQueryResult = typeof CollectedQueryResultSchema.Type;
