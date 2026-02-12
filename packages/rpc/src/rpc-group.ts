/**
 * RPC Group derivation for proseql databases.
 *
 * Derives an RpcGroup from a DatabaseConfig, creating typed procedures
 * for each collection. Each procedure's payload, success, and error schemas
 * are derived from the collection's Effect Schema.
 *
 * @module
 */

import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { DatabaseConfig, CollectionConfig } from "@proseql/core";
import {
	FindByIdPayloadSchema,
	type FindByIdPayload,
} from "./rpc-schemas.js";
import { NotFoundErrorSchema } from "./rpc-errors.js";

// ============================================================================
// RPC Group Factory
// ============================================================================

/**
 * Creates an RpcGroup from a DatabaseConfig.
 *
 * Iterates over collection names in the config and builds an RpcGroup
 * with typed procedures per collection. Each collection gets procedures for:
 * - findById: Find entity by ID
 * - query: Query entities with filters/sorting/pagination
 * - create: Create a new entity
 * - update: Update an existing entity
 * - delete: Delete an entity
 * - aggregate: Compute aggregates
 * - createMany, updateMany, deleteMany: Batch operations
 * - upsert, upsertMany: Upsert operations
 *
 * Procedures are namespaced by collection name (e.g., "books.findById").
 *
 * @param config - The database configuration
 * @returns An RpcGroup with procedures for all collections
 *
 * @example
 * ```ts
 * import { makeRpcGroup } from "@proseql/rpc"
 *
 * const config = {
 *   books: { schema: BookSchema, relationships: {} },
 *   authors: { schema: AuthorSchema, relationships: {} },
 * } as const
 *
 * const BooksRpc = makeRpcGroup(config)
 * // Produces procedures: books.findById, books.query, books.create, ...
 * //                      authors.findById, authors.query, authors.create, ...
 * ```
 */
export function makeRpcGroup<Config extends DatabaseConfig>(
	config: Config,
): RpcGroup.RpcGroup<CollectionRpcs<Config>> {
	const rpcs: Array<Rpc.Any> = [];

	// Iterate over collection names and build RPCs for each
	for (const collectionName of Object.keys(config)) {
		const collectionRpcs = makeCollectionRpcs(collectionName);
		rpcs.push(...collectionRpcs);
	}

	return RpcGroup.make(...rpcs) as RpcGroup.RpcGroup<CollectionRpcs<Config>>;
}

/**
 * Creates RPC procedures for a single collection.
 *
 * @param collectionName - The name of the collection
 * @returns Array of RPC procedures for this collection
 */
function makeCollectionRpcs(collectionName: string): Array<Rpc.Any> {
	// For now, create the findById procedure as specified in task 2.1
	// Subsequent tasks (2.2-2.8) will add more procedures
	const findById = Rpc.make(`${collectionName}.findById`, {
		payload: FindByIdPayloadSchema,
		// Success returns the entity (Unknown for now, will be typed per-collection in handlers)
		success: Schema.Unknown,
		// Error includes NotFoundError
		error: NotFoundErrorSchema,
	});

	return [findById];
}

// ============================================================================
// Type-Level Derivation
// ============================================================================

/**
 * Union type of all RPC procedures for all collections in a config.
 * This is a type-level mapping that produces the correct procedure types.
 */
export type CollectionRpcs<Config extends DatabaseConfig> = {
	[K in keyof Config]: CollectionProcedures<K & string>;
}[keyof Config];

/**
 * Union type of all RPC procedures for a single collection.
 * Currently includes findById; will be extended in tasks 2.2-2.8.
 */
export type CollectionProcedures<CollectionName extends string> = Rpc.Rpc<
	`${CollectionName}.findById`,
	typeof FindByIdPayloadSchema,
	typeof Schema.Unknown,
	typeof NotFoundErrorSchema
>;

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { DatabaseConfig, CollectionConfig };
