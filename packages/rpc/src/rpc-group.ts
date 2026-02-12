/**
 * RPC Group derivation for proseql databases.
 *
 * Derives RPC request schemas and router from a DatabaseConfig, creating typed
 * procedures for each collection. Each procedure's payload, success, and error
 * schemas are derived from the collection's Effect Schema.
 *
 * Uses `Schema.TaggedRequest` pattern as required by @effect/rpc v0.51.x.
 *
 * @module
 */

import { Rpc, RpcRouter } from "@effect/rpc";
import type { CollectionConfig, DatabaseConfig } from "@proseql/core";
import { Schema } from "effect";
import {
	DanglingReferenceErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	NotFoundErrorSchema,
	OperationErrorSchema,
	UniqueConstraintErrorSchema,
	ValidationErrorSchema,
} from "./rpc-errors.js";
import {
	AggregatePayloadSchema,
	AggregateResultSchema,
	CreateManyPayloadSchema,
	CreateManyResultSchema,
	CreatePayloadSchema,
	DeleteManyPayloadSchema,
	DeleteManyResultSchema,
	DeletePayloadSchema,
	GroupedAggregateResultSchema,
	QueryPayloadSchema,
	UpdateManyPayloadSchema,
	UpdateManyResultSchema,
	UpdatePayloadSchema,
	UpsertManyPayloadSchema,
	UpsertManyResultSchema,
	UpsertPayloadSchema,
	UpsertResultSchema,
} from "./rpc-schemas.js";

// ============================================================================
// TaggedRequest Schema Factories
// ============================================================================

/**
 * Creates a FindById TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new FindByIdRequest({ id: "123" })
 * 2. Define RPC handlers: Rpc.effect(FindByIdRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(findByIdRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A TaggedRequest class for findById operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const FindByIdRequest = makeFindByIdRequest("books", BookSchema)
 * // _tag: "books.findById"
 * // payload: { id: string }
 * // success: Book
 * // failure: NotFoundError
 * ```
 */
export function makeFindByIdRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): FindByIdRequestClass<CollectionName, EntitySchema> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class FindByIdRequest extends Schema.TaggedRequest<FindByIdRequest>()(
		`${collectionName}.findById` as `${CollectionName}.findById`,
		{
			failure: NotFoundErrorSchema,
			success: entitySchema,
			payload: {
				id: Schema.String,
			},
		},
	) {};

	return RequestClass as unknown as FindByIdRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Type for a FindById TaggedRequest class.
 * This is the class type returned by makeFindByIdRequest.
 */
export type FindByIdRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = {
	/**
	 * The request _tag (e.g., "books.findById")
	 */
	readonly _tag: `${CollectionName}.findById`;
	/**
	 * The success schema (entity type)
	 */
	readonly success: EntitySchema;
	/**
	 * The failure schema (NotFoundError)
	 */
	readonly failure: typeof NotFoundErrorSchema;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly id: string;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.findById`;
		readonly id: string;
	};
};

/**
 * Union schema for query errors (DanglingReferenceError | ValidationError).
 */
const QueryErrorUnionSchema = Schema.Union(
	DanglingReferenceErrorSchema,
	ValidationErrorSchema,
);

/**
 * Union schema for create errors (ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError).
 */
const CreateErrorUnionSchema = Schema.Union(
	ValidationErrorSchema,
	DuplicateKeyErrorSchema,
	UniqueConstraintErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
);

/**
 * Union schema for update errors (ValidationError | NotFoundError | UniqueConstraintError | HookError).
 */
const UpdateErrorUnionSchema = Schema.Union(
	ValidationErrorSchema,
	NotFoundErrorSchema,
	UniqueConstraintErrorSchema,
	HookErrorSchema,
);

/**
 * Union schema for delete errors (NotFoundError | HookError).
 */
const DeleteErrorUnionSchema = Schema.Union(
	NotFoundErrorSchema,
	HookErrorSchema,
);

/**
 * Union schema for createMany errors (ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError).
 * Same as CreateErrorUnionSchema.
 */
const CreateManyErrorUnionSchema = CreateErrorUnionSchema;

/**
 * Union schema for updateMany errors (ValidationError | ForeignKeyError | HookError | UniqueConstraintError).
 */
const UpdateManyErrorUnionSchema = Schema.Union(
	ValidationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
);

/**
 * Union schema for deleteMany errors (OperationError | ForeignKeyError | HookError).
 */
const DeleteManyErrorUnionSchema = Schema.Union(
	OperationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
);

/**
 * Union schema for upsert errors (ValidationError | ForeignKeyError | HookError | UniqueConstraintError).
 */
const UpsertErrorUnionSchema = Schema.Union(
	ValidationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
);

/**
 * Union schema for upsertMany errors (ValidationError | ForeignKeyError | HookError | UniqueConstraintError).
 * Same as UpsertErrorUnionSchema.
 */
const UpsertManyErrorUnionSchema = UpsertErrorUnionSchema;

/**
 * Creates a Query TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new QueryRequest({ where: { ... } })
 * 2. Define RPC handlers: Rpc.effect(QueryRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(queryRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A TaggedRequest class for query operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const QueryRequest = makeQueryRequest("books", BookSchema)
 * // _tag: "books.query"
 * // payload: QueryPayload
 * // success: ReadonlyArray<Book>
 * // failure: DanglingReferenceError | ValidationError
 * ```
 */
export function makeQueryRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): QueryRequestClass<CollectionName, EntitySchema> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class QueryRequest extends Schema.TaggedRequest<QueryRequest>()(
		`${collectionName}.query` as `${CollectionName}.query`,
		{
			failure: QueryErrorUnionSchema,
			success: Schema.Array(entitySchema),
			payload: {
				where: QueryPayloadSchema.fields.where,
				sort: QueryPayloadSchema.fields.sort,
				select: QueryPayloadSchema.fields.select,
				populate: QueryPayloadSchema.fields.populate,
				limit: QueryPayloadSchema.fields.limit,
				offset: QueryPayloadSchema.fields.offset,
				cursor: QueryPayloadSchema.fields.cursor,
			},
		},
	) {};

	return RequestClass as unknown as QueryRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Type for a Query TaggedRequest class.
 * This is the class type returned by makeQueryRequest.
 */
export type QueryRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = {
	/**
	 * The request _tag (e.g., "books.query")
	 */
	readonly _tag: `${CollectionName}.query`;
	/**
	 * The success schema (array of entity type)
	 */
	readonly success: Schema.Array$<EntitySchema>;
	/**
	 * The failure schema (DanglingReferenceError | ValidationError)
	 */
	readonly failure: typeof QueryErrorUnionSchema;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly where?: typeof QueryPayloadSchema.Type.where;
		readonly sort?: typeof QueryPayloadSchema.Type.sort;
		readonly select?: typeof QueryPayloadSchema.Type.select;
		readonly populate?: typeof QueryPayloadSchema.Type.populate;
		readonly limit?: typeof QueryPayloadSchema.Type.limit;
		readonly offset?: typeof QueryPayloadSchema.Type.offset;
		readonly cursor?: typeof QueryPayloadSchema.Type.cursor;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.query`;
		readonly where?: typeof QueryPayloadSchema.Type.where;
		readonly sort?: typeof QueryPayloadSchema.Type.sort;
		readonly select?: typeof QueryPayloadSchema.Type.select;
		readonly populate?: typeof QueryPayloadSchema.Type.populate;
		readonly limit?: typeof QueryPayloadSchema.Type.limit;
		readonly offset?: typeof QueryPayloadSchema.Type.offset;
		readonly cursor?: typeof QueryPayloadSchema.Type.cursor;
	};
};

// ============================================================================
// Streaming Query Request Factory
// ============================================================================

/**
 * Creates a streaming Query TaggedRequest class for a collection.
 *
 * Unlike makeQueryRequest which returns an array-collecting RPC,
 * this creates an RPC that streams results incrementally, allowing
 * large result sets to flow through the transport without buffering.
 *
 * Uses `Rpc.StreamRequest` which marks the request for streaming handling.
 * Handlers must return a `Stream<Entity, Error>` instead of `Effect<Array<Entity>, Error>`.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A StreamRequest class for streaming query operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const QueryStreamRequest = makeQueryStreamRequest("books", BookSchema)
 * // _tag: "books.queryStream"
 * // payload: QueryPayload
 * // success: Stream<Book, DanglingReferenceError | ValidationError>
 *
 * // Use with Rpc.stream to create a handler
 * const handler = Rpc.stream(QueryStreamRequest, (req) =>
 *   db.books.query({ where: req.where, sort: req.sort })
 * )
 * ```
 */
export function makeQueryStreamRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): QueryStreamRequestClass<CollectionName, EntitySchema> {
	// Use Rpc.StreamRequest to create a streaming RPC schema
	// The handler for this request must return a Stream, not an Effect
	const RequestClass = Rpc.StreamRequest<
		QueryStreamRequestInstance<CollectionName, EntitySchema>
	>()(`${collectionName}.queryStream` as `${CollectionName}.queryStream`, {
		failure: QueryErrorUnionSchema,
		success: entitySchema,
		payload: {
			where: QueryPayloadSchema.fields.where,
			sort: QueryPayloadSchema.fields.sort,
			select: QueryPayloadSchema.fields.select,
			populate: QueryPayloadSchema.fields.populate,
			limit: QueryPayloadSchema.fields.limit,
			offset: QueryPayloadSchema.fields.offset,
			cursor: QueryPayloadSchema.fields.cursor,
			streamingOptions: QueryPayloadSchema.fields.streamingOptions,
		},
	});

	return RequestClass as unknown as QueryStreamRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Instance type for a QueryStream request.
 */
interface QueryStreamRequestInstance<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> extends Rpc.StreamRequest<
		`${CollectionName}.queryStream`,
		never,
		{
			readonly _tag: `${CollectionName}.queryStream`;
			readonly where?: typeof QueryPayloadSchema.Type.where;
			readonly sort?: typeof QueryPayloadSchema.Type.sort;
			readonly select?: typeof QueryPayloadSchema.Type.select;
			readonly populate?: typeof QueryPayloadSchema.Type.populate;
			readonly limit?: typeof QueryPayloadSchema.Type.limit;
			readonly offset?: typeof QueryPayloadSchema.Type.offset;
			readonly cursor?: typeof QueryPayloadSchema.Type.cursor;
			readonly streamingOptions?: typeof QueryPayloadSchema.Type.streamingOptions;
		},
		QueryStreamRequestInstance<CollectionName, EntitySchema>,
		never,
		Schema.Schema.Encoded<typeof QueryErrorUnionSchema>,
		Schema.Schema.Type<typeof QueryErrorUnionSchema>,
		Schema.Schema.Encoded<EntitySchema>,
		Schema.Schema.Type<EntitySchema>
	> {
	readonly _tag: `${CollectionName}.queryStream`;
	readonly where?: typeof QueryPayloadSchema.Type.where;
	readonly sort?: typeof QueryPayloadSchema.Type.sort;
	readonly select?: typeof QueryPayloadSchema.Type.select;
	readonly populate?: typeof QueryPayloadSchema.Type.populate;
	readonly limit?: typeof QueryPayloadSchema.Type.limit;
	readonly offset?: typeof QueryPayloadSchema.Type.offset;
	readonly cursor?: typeof QueryPayloadSchema.Type.cursor;
	readonly streamingOptions?: typeof QueryPayloadSchema.Type.streamingOptions;
}

/**
 * Type for a streaming Query TaggedRequest class.
 * This is the class type returned by makeQueryStreamRequest.
 */
export type QueryStreamRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = Rpc.StreamRequestConstructor<
	`${CollectionName}.queryStream`,
	QueryStreamRequestInstance<CollectionName, EntitySchema>,
	never,
	{
		readonly where?: typeof QueryPayloadSchema.Encoded.where;
		readonly sort?: typeof QueryPayloadSchema.Encoded.sort;
		readonly select?: typeof QueryPayloadSchema.Encoded.select;
		readonly populate?: typeof QueryPayloadSchema.Encoded.populate;
		readonly limit?: typeof QueryPayloadSchema.Encoded.limit;
		readonly offset?: typeof QueryPayloadSchema.Encoded.offset;
		readonly cursor?: typeof QueryPayloadSchema.Encoded.cursor;
		readonly streamingOptions?: typeof QueryPayloadSchema.Encoded.streamingOptions;
	},
	{
		readonly where?: typeof QueryPayloadSchema.Type.where;
		readonly sort?: typeof QueryPayloadSchema.Type.sort;
		readonly select?: typeof QueryPayloadSchema.Type.select;
		readonly populate?: typeof QueryPayloadSchema.Type.populate;
		readonly limit?: typeof QueryPayloadSchema.Type.limit;
		readonly offset?: typeof QueryPayloadSchema.Type.offset;
		readonly cursor?: typeof QueryPayloadSchema.Type.cursor;
		readonly streamingOptions?: typeof QueryPayloadSchema.Type.streamingOptions;
	},
	never,
	Schema.Schema.Encoded<typeof QueryErrorUnionSchema>,
	Schema.Schema.Type<typeof QueryErrorUnionSchema>,
	Schema.Schema.Encoded<EntitySchema>,
	Schema.Schema.Type<EntitySchema>
>;

/**
 * Creates a Create TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new CreateRequest({ data: { ... } })
 * 2. Define RPC handlers: Rpc.effect(CreateRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(createRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A TaggedRequest class for create operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const CreateRequest = makeCreateRequest("books", BookSchema)
 * // _tag: "books.create"
 * // payload: { data: Record<string, unknown> }
 * // success: Book
 * // failure: ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError
 * ```
 */
export function makeCreateRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): CreateRequestClass<CollectionName, EntitySchema> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class CreateRequest extends Schema.TaggedRequest<CreateRequest>()(
		`${collectionName}.create` as `${CollectionName}.create`,
		{
			failure: CreateErrorUnionSchema,
			success: entitySchema,
			payload: {
				data: CreatePayloadSchema.fields.data,
			},
		},
	) {};

	return RequestClass as unknown as CreateRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Type for a Create TaggedRequest class.
 * This is the class type returned by makeCreateRequest.
 */
export type CreateRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = {
	/**
	 * The request _tag (e.g., "books.create")
	 */
	readonly _tag: `${CollectionName}.create`;
	/**
	 * The success schema (entity type)
	 */
	readonly success: EntitySchema;
	/**
	 * The failure schema (ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError)
	 */
	readonly failure: typeof CreateErrorUnionSchema;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly data: typeof CreatePayloadSchema.Type.data;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.create`;
		readonly data: typeof CreatePayloadSchema.Type.data;
	};
};

/**
 * Creates an Update TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new UpdateRequest({ id: "123", updates: { ... } })
 * 2. Define RPC handlers: Rpc.effect(UpdateRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(updateRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A TaggedRequest class for update operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const UpdateRequest = makeUpdateRequest("books", BookSchema)
 * // _tag: "books.update"
 * // payload: { id: string, updates: Record<string, unknown> }
 * // success: Book
 * // failure: ValidationError | NotFoundError | UniqueConstraintError | HookError
 * ```
 */
export function makeUpdateRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): UpdateRequestClass<CollectionName, EntitySchema> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class UpdateRequest extends Schema.TaggedRequest<UpdateRequest>()(
		`${collectionName}.update` as `${CollectionName}.update`,
		{
			failure: UpdateErrorUnionSchema,
			success: entitySchema,
			payload: {
				id: UpdatePayloadSchema.fields.id,
				updates: UpdatePayloadSchema.fields.updates,
			},
		},
	) {};

	return RequestClass as unknown as UpdateRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Type for an Update TaggedRequest class.
 * This is the class type returned by makeUpdateRequest.
 */
export type UpdateRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = {
	/**
	 * The request _tag (e.g., "books.update")
	 */
	readonly _tag: `${CollectionName}.update`;
	/**
	 * The success schema (entity type)
	 */
	readonly success: EntitySchema;
	/**
	 * The failure schema (ValidationError | NotFoundError | UniqueConstraintError | HookError)
	 */
	readonly failure: typeof UpdateErrorUnionSchema;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly id: typeof UpdatePayloadSchema.Type.id;
		readonly updates: typeof UpdatePayloadSchema.Type.updates;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.update`;
		readonly id: typeof UpdatePayloadSchema.Type.id;
		readonly updates: typeof UpdatePayloadSchema.Type.updates;
	};
};

/**
 * Creates a Delete TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new DeleteRequest({ id: "123" })
 * 2. Define RPC handlers: Rpc.effect(DeleteRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(deleteRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns A TaggedRequest class for delete operations
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 * })
 *
 * const DeleteRequest = makeDeleteRequest("books", BookSchema)
 * // _tag: "books.delete"
 * // payload: { id: string }
 * // success: Book
 * // failure: NotFoundError | HookError
 * ```
 */
export function makeDeleteRequest<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): DeleteRequestClass<CollectionName, EntitySchema> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class DeleteRequest extends Schema.TaggedRequest<DeleteRequest>()(
		`${collectionName}.delete` as `${CollectionName}.delete`,
		{
			failure: DeleteErrorUnionSchema,
			success: entitySchema,
			payload: {
				id: DeletePayloadSchema.fields.id,
			},
		},
	) {};

	return RequestClass as unknown as DeleteRequestClass<
		CollectionName,
		EntitySchema
	>;
}

/**
 * Type for a Delete TaggedRequest class.
 * This is the class type returned by makeDeleteRequest.
 */
export type DeleteRequestClass<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> = {
	/**
	 * The request _tag (e.g., "books.delete")
	 */
	readonly _tag: `${CollectionName}.delete`;
	/**
	 * The success schema (entity type)
	 */
	readonly success: EntitySchema;
	/**
	 * The failure schema (NotFoundError | HookError)
	 */
	readonly failure: typeof DeleteErrorUnionSchema;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly id: typeof DeletePayloadSchema.Type.id;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.delete`;
		readonly id: typeof DeletePayloadSchema.Type.id;
	};
};

/**
 * Union schema for aggregate results (AggregateResult | GroupedAggregateResult).
 * The aggregate operation never fails, so we use Schema.Never for failure.
 */
const AggregateResultUnionSchema = Schema.Union(
	AggregateResultSchema,
	GroupedAggregateResultSchema,
);

/**
 * Creates an Aggregate TaggedRequest class for a collection.
 *
 * The returned class extends Schema.TaggedRequest and can be used to:
 * 1. Create request instances: new AggregateRequest({ count: true })
 * 2. Define RPC handlers: Rpc.effect(AggregateRequest, (req) => ...)
 * 3. Build RPC routers: RpcRouter.make(aggregateRpc, ...)
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for aggregate operations
 *
 * @example
 * ```ts
 * const AggregateRequest = makeAggregateRequest("books")
 * // _tag: "books.aggregate"
 * // payload: AggregateConfig
 * // success: AggregateResult | GroupedAggregateResult
 * // failure: never (aggregate operations cannot fail)
 * ```
 */
export function makeAggregateRequest<CollectionName extends string>(
	collectionName: CollectionName,
): AggregateRequestClass<CollectionName> {
	// Create a TaggedRequest class dynamically
	// The class extends Schema.TaggedRequest with the collection-specific tag
	const RequestClass = class AggregateRequest extends Schema.TaggedRequest<AggregateRequest>()(
		`${collectionName}.aggregate` as `${CollectionName}.aggregate`,
		{
			failure: Schema.Never,
			success: AggregateResultUnionSchema,
			payload: {
				where: AggregatePayloadSchema.fields.where,
				groupBy: AggregatePayloadSchema.fields.groupBy,
				count: AggregatePayloadSchema.fields.count,
				sum: AggregatePayloadSchema.fields.sum,
				avg: AggregatePayloadSchema.fields.avg,
				min: AggregatePayloadSchema.fields.min,
				max: AggregatePayloadSchema.fields.max,
			},
		},
	) {};

	return RequestClass as unknown as AggregateRequestClass<CollectionName>;
}

/**
 * Type for an Aggregate TaggedRequest class.
 * This is the class type returned by makeAggregateRequest.
 */
export type AggregateRequestClass<CollectionName extends string> = {
	/**
	 * The request _tag (e.g., "books.aggregate")
	 */
	readonly _tag: `${CollectionName}.aggregate`;
	/**
	 * The success schema (AggregateResult | GroupedAggregateResult)
	 */
	readonly success: typeof AggregateResultUnionSchema;
	/**
	 * The failure schema (never - aggregate operations cannot fail)
	 */
	readonly failure: typeof Schema.Never;
	/**
	 * Create a new request instance
	 */
	new (props: {
		readonly where?: typeof AggregatePayloadSchema.Type.where;
		readonly groupBy?: typeof AggregatePayloadSchema.Type.groupBy;
		readonly count?: typeof AggregatePayloadSchema.Type.count;
		readonly sum?: typeof AggregatePayloadSchema.Type.sum;
		readonly avg?: typeof AggregatePayloadSchema.Type.avg;
		readonly min?: typeof AggregatePayloadSchema.Type.min;
		readonly max?: typeof AggregatePayloadSchema.Type.max;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.aggregate`;
		readonly where?: typeof AggregatePayloadSchema.Type.where;
		readonly groupBy?: typeof AggregatePayloadSchema.Type.groupBy;
		readonly count?: typeof AggregatePayloadSchema.Type.count;
		readonly sum?: typeof AggregatePayloadSchema.Type.sum;
		readonly avg?: typeof AggregatePayloadSchema.Type.avg;
		readonly min?: typeof AggregatePayloadSchema.Type.min;
		readonly max?: typeof AggregatePayloadSchema.Type.max;
	};
};

// ============================================================================
// Batch Operation TaggedRequest Schema Factories
// ============================================================================

/**
 * Creates a CreateMany TaggedRequest class for a collection.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for createMany operations
 *
 * @example
 * ```ts
 * const CreateManyRequest = makeCreateManyRequest("books")
 * // _tag: "books.createMany"
 * // payload: { data: Array<Record<string, unknown>>, options?: { skipDuplicates?: boolean } }
 * // success: CreateManyResult
 * // failure: ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError
 * ```
 */
export function makeCreateManyRequest<CollectionName extends string>(
	collectionName: CollectionName,
): CreateManyRequestClass<CollectionName> {
	const RequestClass = class CreateManyRequest extends Schema.TaggedRequest<CreateManyRequest>()(
		`${collectionName}.createMany` as `${CollectionName}.createMany`,
		{
			failure: CreateManyErrorUnionSchema,
			success: CreateManyResultSchema,
			payload: {
				data: CreateManyPayloadSchema.fields.data,
				options: CreateManyPayloadSchema.fields.options,
			},
		},
	) {};

	return RequestClass as unknown as CreateManyRequestClass<CollectionName>;
}

/**
 * Type for a CreateMany TaggedRequest class.
 */
export type CreateManyRequestClass<CollectionName extends string> = {
	readonly _tag: `${CollectionName}.createMany`;
	readonly success: typeof CreateManyResultSchema;
	readonly failure: typeof CreateManyErrorUnionSchema;
	new (props: {
		readonly data: typeof CreateManyPayloadSchema.Type.data;
		readonly options?: typeof CreateManyPayloadSchema.Type.options;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.createMany`;
		readonly data: typeof CreateManyPayloadSchema.Type.data;
		readonly options?: typeof CreateManyPayloadSchema.Type.options;
	};
};

/**
 * Creates an UpdateMany TaggedRequest class for a collection.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for updateMany operations
 *
 * @example
 * ```ts
 * const UpdateManyRequest = makeUpdateManyRequest("books")
 * // _tag: "books.updateMany"
 * // payload: { where: Record<string, unknown>, updates: Record<string, unknown> }
 * // success: UpdateManyResult
 * // failure: ValidationError | ForeignKeyError | HookError | UniqueConstraintError
 * ```
 */
export function makeUpdateManyRequest<CollectionName extends string>(
	collectionName: CollectionName,
): UpdateManyRequestClass<CollectionName> {
	const RequestClass = class UpdateManyRequest extends Schema.TaggedRequest<UpdateManyRequest>()(
		`${collectionName}.updateMany` as `${CollectionName}.updateMany`,
		{
			failure: UpdateManyErrorUnionSchema,
			success: UpdateManyResultSchema,
			payload: {
				where: UpdateManyPayloadSchema.fields.where,
				updates: UpdateManyPayloadSchema.fields.updates,
			},
		},
	) {};

	return RequestClass as unknown as UpdateManyRequestClass<CollectionName>;
}

/**
 * Type for an UpdateMany TaggedRequest class.
 */
export type UpdateManyRequestClass<CollectionName extends string> = {
	readonly _tag: `${CollectionName}.updateMany`;
	readonly success: typeof UpdateManyResultSchema;
	readonly failure: typeof UpdateManyErrorUnionSchema;
	new (props: {
		readonly where: typeof UpdateManyPayloadSchema.Type.where;
		readonly updates: typeof UpdateManyPayloadSchema.Type.updates;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.updateMany`;
		readonly where: typeof UpdateManyPayloadSchema.Type.where;
		readonly updates: typeof UpdateManyPayloadSchema.Type.updates;
	};
};

/**
 * Creates a DeleteMany TaggedRequest class for a collection.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for deleteMany operations
 *
 * @example
 * ```ts
 * const DeleteManyRequest = makeDeleteManyRequest("books")
 * // _tag: "books.deleteMany"
 * // payload: { where: Record<string, unknown>, options?: { limit?: number } }
 * // success: DeleteManyResult
 * // failure: OperationError | ForeignKeyError | HookError
 * ```
 */
export function makeDeleteManyRequest<CollectionName extends string>(
	collectionName: CollectionName,
): DeleteManyRequestClass<CollectionName> {
	const RequestClass = class DeleteManyRequest extends Schema.TaggedRequest<DeleteManyRequest>()(
		`${collectionName}.deleteMany` as `${CollectionName}.deleteMany`,
		{
			failure: DeleteManyErrorUnionSchema,
			success: DeleteManyResultSchema,
			payload: {
				where: DeleteManyPayloadSchema.fields.where,
				options: DeleteManyPayloadSchema.fields.options,
			},
		},
	) {};

	return RequestClass as unknown as DeleteManyRequestClass<CollectionName>;
}

/**
 * Type for a DeleteMany TaggedRequest class.
 */
export type DeleteManyRequestClass<CollectionName extends string> = {
	readonly _tag: `${CollectionName}.deleteMany`;
	readonly success: typeof DeleteManyResultSchema;
	readonly failure: typeof DeleteManyErrorUnionSchema;
	new (props: {
		readonly where: typeof DeleteManyPayloadSchema.Type.where;
		readonly options?: typeof DeleteManyPayloadSchema.Type.options;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.deleteMany`;
		readonly where: typeof DeleteManyPayloadSchema.Type.where;
		readonly options?: typeof DeleteManyPayloadSchema.Type.options;
	};
};

/**
 * Creates an Upsert TaggedRequest class for a collection.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for upsert operations
 *
 * @example
 * ```ts
 * const UpsertRequest = makeUpsertRequest("books")
 * // _tag: "books.upsert"
 * // payload: { where: Record<string, unknown>, create: Record<string, unknown>, update: Record<string, unknown> }
 * // success: UpsertResult
 * // failure: ValidationError | ForeignKeyError | HookError | UniqueConstraintError
 * ```
 */
export function makeUpsertRequest<CollectionName extends string>(
	collectionName: CollectionName,
): UpsertRequestClass<CollectionName> {
	const RequestClass = class UpsertRequest extends Schema.TaggedRequest<UpsertRequest>()(
		`${collectionName}.upsert` as `${CollectionName}.upsert`,
		{
			failure: UpsertErrorUnionSchema,
			success: UpsertResultSchema,
			payload: {
				where: UpsertPayloadSchema.fields.where,
				create: UpsertPayloadSchema.fields.create,
				update: UpsertPayloadSchema.fields.update,
			},
		},
	) {};

	return RequestClass as unknown as UpsertRequestClass<CollectionName>;
}

/**
 * Type for an Upsert TaggedRequest class.
 */
export type UpsertRequestClass<CollectionName extends string> = {
	readonly _tag: `${CollectionName}.upsert`;
	readonly success: typeof UpsertResultSchema;
	readonly failure: typeof UpsertErrorUnionSchema;
	new (props: {
		readonly where: typeof UpsertPayloadSchema.Type.where;
		readonly create: typeof UpsertPayloadSchema.Type.create;
		readonly update: typeof UpsertPayloadSchema.Type.update;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.upsert`;
		readonly where: typeof UpsertPayloadSchema.Type.where;
		readonly create: typeof UpsertPayloadSchema.Type.create;
		readonly update: typeof UpsertPayloadSchema.Type.update;
	};
};

/**
 * Creates an UpsertMany TaggedRequest class for a collection.
 *
 * @param collectionName - The name of the collection (used as the request _tag prefix)
 * @returns A TaggedRequest class for upsertMany operations
 *
 * @example
 * ```ts
 * const UpsertManyRequest = makeUpsertManyRequest("books")
 * // _tag: "books.upsertMany"
 * // payload: { data: Array<{ where, create, update }> }
 * // success: UpsertManyResult
 * // failure: ValidationError | ForeignKeyError | HookError | UniqueConstraintError
 * ```
 */
export function makeUpsertManyRequest<CollectionName extends string>(
	collectionName: CollectionName,
): UpsertManyRequestClass<CollectionName> {
	const RequestClass = class UpsertManyRequest extends Schema.TaggedRequest<UpsertManyRequest>()(
		`${collectionName}.upsertMany` as `${CollectionName}.upsertMany`,
		{
			failure: UpsertManyErrorUnionSchema,
			success: UpsertManyResultSchema,
			payload: {
				data: UpsertManyPayloadSchema.fields.data,
			},
		},
	) {};

	return RequestClass as unknown as UpsertManyRequestClass<CollectionName>;
}

/**
 * Type for an UpsertMany TaggedRequest class.
 */
export type UpsertManyRequestClass<CollectionName extends string> = {
	readonly _tag: `${CollectionName}.upsertMany`;
	readonly success: typeof UpsertManyResultSchema;
	readonly failure: typeof UpsertManyErrorUnionSchema;
	new (props: {
		readonly data: typeof UpsertManyPayloadSchema.Type.data;
	}): Schema.TaggedRequest.Any & {
		readonly _tag: `${CollectionName}.upsertMany`;
		readonly data: typeof UpsertManyPayloadSchema.Type.data;
	};
};

// ============================================================================
// Collection RPC Definitions
// ============================================================================

/**
 * Type for collection RPC definitions.
 * Contains the request schemas for all RPC operations on a collection.
 */
export interface CollectionRpcDefinitions<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
> {
	/**
	 * TaggedRequest class for findById operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly FindByIdRequest: FindByIdRequestClass<CollectionName, EntitySchema>;
	/**
	 * TaggedRequest class for query operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly QueryRequest: QueryRequestClass<CollectionName, EntitySchema>;
	/**
	 * StreamRequest class for streaming query operations.
	 * Unlike QueryRequest which collects all results, this streams results incrementally.
	 * Use with Rpc.stream() to create a handler that returns a Stream.
	 */
	readonly QueryStreamRequest: QueryStreamRequestClass<
		CollectionName,
		EntitySchema
	>;
	/**
	 * TaggedRequest class for create operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly CreateRequest: CreateRequestClass<CollectionName, EntitySchema>;
	/**
	 * TaggedRequest class for update operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly UpdateRequest: UpdateRequestClass<CollectionName, EntitySchema>;
	/**
	 * TaggedRequest class for delete operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly DeleteRequest: DeleteRequestClass<CollectionName, EntitySchema>;
	/**
	 * TaggedRequest class for aggregate operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly AggregateRequest: AggregateRequestClass<CollectionName>;
	/**
	 * TaggedRequest class for createMany operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly CreateManyRequest: CreateManyRequestClass<CollectionName>;
	/**
	 * TaggedRequest class for updateMany operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly UpdateManyRequest: UpdateManyRequestClass<CollectionName>;
	/**
	 * TaggedRequest class for deleteMany operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly DeleteManyRequest: DeleteManyRequestClass<CollectionName>;
	/**
	 * TaggedRequest class for upsert operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly UpsertRequest: UpsertRequestClass<CollectionName>;
	/**
	 * TaggedRequest class for upsertMany operations.
	 * Use with Rpc.effect() to create an RPC handler.
	 */
	readonly UpsertManyRequest: UpsertManyRequestClass<CollectionName>;
	/** The collection name */
	readonly collectionName: CollectionName;
	/** The entity schema for this collection */
	readonly entitySchema: EntitySchema;
}

/**
 * Creates RPC definitions for a collection.
 *
 * Returns an object containing the request schemas that can be used to
 * create RPC handlers and add them to an RpcRouter.
 *
 * @param collectionName - The name of the collection
 * @param entitySchema - The Effect Schema for the collection's entities
 * @returns Object with request schemas
 */
export function makeCollectionRpcs<
	CollectionName extends string,
	EntitySchema extends Schema.Schema.Any,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
): CollectionRpcDefinitions<CollectionName, EntitySchema> {
	const FindByIdRequest = makeFindByIdRequest(collectionName, entitySchema);
	const QueryRequest = makeQueryRequest(collectionName, entitySchema);
	const QueryStreamRequest = makeQueryStreamRequest(
		collectionName,
		entitySchema,
	);
	const CreateRequest = makeCreateRequest(collectionName, entitySchema);
	const UpdateRequest = makeUpdateRequest(collectionName, entitySchema);
	const DeleteRequest = makeDeleteRequest(collectionName, entitySchema);
	const AggregateRequest = makeAggregateRequest(collectionName);
	const CreateManyRequest = makeCreateManyRequest(collectionName);
	const UpdateManyRequest = makeUpdateManyRequest(collectionName);
	const DeleteManyRequest = makeDeleteManyRequest(collectionName);
	const UpsertRequest = makeUpsertRequest(collectionName);
	const UpsertManyRequest = makeUpsertManyRequest(collectionName);

	return {
		FindByIdRequest,
		QueryRequest,
		QueryStreamRequest,
		CreateRequest,
		UpdateRequest,
		DeleteRequest,
		AggregateRequest,
		CreateManyRequest,
		UpdateManyRequest,
		DeleteManyRequest,
		UpsertRequest,
		UpsertManyRequest,
		collectionName,
		entitySchema,
	};
}

// ============================================================================
// RpcGroup Factory
// ============================================================================

/**
 * Creates a mapping of collection RPC definitions from a DatabaseConfig.
 *
 * This is the primary entry point for deriving RPC schemas from a database config.
 * Each collection gets typed request schemas for:
 * - findById: Find entity by ID
 * - query: Query entities with filtering, sorting, pagination (collected array result)
 * - queryStream: Query entities with streaming results (incremental delivery)
 * - create: Create a new entity
 * - update: Update an existing entity by ID
 * - delete: Delete an entity by ID
 * - aggregate: Compute aggregates (count, sum, avg, min, max) with optional groupBy
 * - createMany: Create multiple entities in batch
 * - updateMany: Update multiple entities matching a predicate
 * - deleteMany: Delete multiple entities matching a predicate
 * - upsert: Create or update an entity based on a where clause
 * - upsertMany: Create or update multiple entities in batch
 *
 * @param config - The database configuration
 * @returns A mapping of collection names to their RPC definitions
 *
 * @example
 * ```ts
 * import { makeRpcGroup } from "@proseql/rpc"
 * import { Rpc, RpcRouter } from "@effect/rpc"
 *
 * const config = {
 *   books: { schema: BookSchema, relationships: {} },
 *   authors: { schema: AuthorSchema, relationships: {} },
 * } as const
 *
 * const rpcs = makeRpcGroup(config)
 *
 * // Create handlers using the request schemas
 * const findBookById = Rpc.effect(rpcs.books.FindByIdRequest, (req) =>
 *   db.books.findById(req.id)
 * )
 *
 * const queryBooks = Rpc.effect(rpcs.books.QueryRequest, (req) =>
 *   db.books.query({ where: req.where, sort: req.sort }).runPromise
 * )
 *
 * const createBook = Rpc.effect(rpcs.books.CreateRequest, (req) =>
 *   db.books.create(req.data)
 * )
 *
 * const updateBook = Rpc.effect(rpcs.books.UpdateRequest, (req) =>
 *   db.books.update(req.id, req.updates)
 * )
 *
 * const deleteBook = Rpc.effect(rpcs.books.DeleteRequest, (req) =>
 *   db.books.delete(req.id)
 * )
 *
 * const aggregateBooks = Rpc.effect(rpcs.books.AggregateRequest, (req) =>
 *   db.books.aggregate({ count: req.count, groupBy: req.groupBy, ...req })
 * )
 *
 * const createManyBooks = Rpc.effect(rpcs.books.CreateManyRequest, (req) =>
 *   db.books.createMany(req.data, req.options)
 * )
 *
 * // Build a router
 * const router = RpcRouter.make(findBookById, queryBooks, createBook, updateBook, deleteBook, aggregateBooks, createManyBooks)
 * ```
 */
export function makeRpcGroup<Config extends DatabaseConfig>(
	config: Config,
): RpcGroupFromConfig<Config> {
	const result: Record<
		string,
		CollectionRpcDefinitions<string, Schema.Schema.Any>
	> = {};

	for (const collectionName of Object.keys(config)) {
		const collectionConfig = config[collectionName];
		result[collectionName] = makeCollectionRpcs(
			collectionName,
			collectionConfig.schema as Schema.Schema.Any,
		);
	}

	return result as RpcGroupFromConfig<Config>;
}

// ============================================================================
// Type-Level Derivation
// ============================================================================

/**
 * Helper type to extract the Schema from a collection config.
 */
type ExtractCollectionSchema<C extends CollectionConfig> = C["schema"];

/**
 * Type for the RPC group derived from a DatabaseConfig.
 * Maps each collection name to its RPC definitions.
 */
export type RpcGroupFromConfig<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: CollectionRpcDefinitions<
		K & string,
		ExtractCollectionSchema<Config[K]> extends Schema.Schema.Any
			? ExtractCollectionSchema<Config[K]>
			: Schema.Schema<unknown, unknown, never>
	>;
};

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { DatabaseConfig, CollectionConfig };

// Re-export RpcRouter for convenience
export { RpcRouter };
