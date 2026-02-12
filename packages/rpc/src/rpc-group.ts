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
import { NotFoundErrorSchema } from "./rpc-errors.js";

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

	return {
		FindByIdRequest,
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
 *
 * Additional procedures (query, create, update, delete, aggregate, batch ops)
 * will be added in subsequent tasks.
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
 * // Build a router
 * const router = RpcRouter.make(findBookById)
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
