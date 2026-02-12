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
import { Schema } from "effect";
import type { DatabaseConfig, CollectionConfig } from "@proseql/core";
import {
	NotFoundErrorSchema,
	DanglingReferenceErrorSchema,
	ValidationErrorSchema,
	DuplicateKeyErrorSchema,
	UniqueConstraintErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
} from "./rpc-errors.js";
import {
	QueryPayloadSchema,
	CreatePayloadSchema,
	UpdatePayloadSchema,
	DeletePayloadSchema,
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
	new (props: { readonly id: string }): Schema.TaggedRequest.Any & {
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
const DeleteErrorUnionSchema = Schema.Union(NotFoundErrorSchema, HookErrorSchema);

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
	const CreateRequest = makeCreateRequest(collectionName, entitySchema);
	const UpdateRequest = makeUpdateRequest(collectionName, entitySchema);
	const DeleteRequest = makeDeleteRequest(collectionName, entitySchema);

	return {
		FindByIdRequest,
		QueryRequest,
		CreateRequest,
		UpdateRequest,
		DeleteRequest,
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
 * - query: Query entities with filtering, sorting, pagination
 * - create: Create a new entity
 * - update: Update an existing entity by ID
 * - delete: Delete an entity by ID
 *
 * Additional procedures (aggregate, batch ops) will be added in subsequent tasks.
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
 * // Build a router
 * const router = RpcRouter.make(findBookById, queryBooks, createBook, updateBook, deleteBook)
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
