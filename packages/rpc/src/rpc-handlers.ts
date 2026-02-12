/**
 * RPC Handler Layer implementation.
 *
 * Creates an Effect Layer that provides handlers for all RPC procedures
 * derived from a DatabaseConfig. The layer internally creates an EffectDatabase
 * and wires each handler to the appropriate collection method.
 */

import { Chunk, Context, Effect, Layer, Stream } from "effect";
import {
	createEffectDatabase,
	type DatabaseConfig,
	type DatasetFor,
	type EffectDatabase,
	type MigrationError,
	type PluginError,
} from "@proseql/core";

// ============================================================================
// DatabaseContext Service
// ============================================================================

/**
 * Service tag for providing the database instance to handlers.
 * This allows handlers to access the database without creating it themselves.
 */
export interface DatabaseContext<Config extends DatabaseConfig> {
	readonly db: EffectDatabase<Config>;
}

/**
 * Create a Context.Tag for a specific database configuration.
 * Each config type gets its own unique service identifier.
 */
export const makeDatabaseContextTag = <Config extends DatabaseConfig>() =>
	Context.GenericTag<DatabaseContext<Config>>(
		"@proseql/rpc/DatabaseContext",
	);

// ============================================================================
// Handler Implementations
// ============================================================================

/**
 * Internal function to create handlers for a single collection.
 * Returns an object with handler functions for each RPC operation.
 */
const createCollectionHandlers = <Config extends DatabaseConfig>(
	collectionName: keyof Config,
	db: EffectDatabase<Config>,
) => {
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic based on config
	const collection = db[collectionName] as EffectDatabase<Config>[keyof Config];

	return {
		findById: ({ id }: { readonly id: string }) =>
			collection.findById(id),

		query: (config: {
			readonly where?: Record<string, unknown>;
			readonly populate?: Record<string, unknown>;
			readonly sort?: Record<string, "asc" | "desc">;
			readonly select?: Record<string, unknown> | ReadonlyArray<string>;
			readonly limit?: number;
			readonly offset?: number;
		}) => {
			// Query returns a RunnableStream; collect it to an array for RPC response
			const stream = collection.query(config);
			// The stream is a Stream.Stream at runtime (RunnableStream wrapper)
			return Stream.runCollect(stream as Stream.Stream<Record<string, unknown>, unknown>).pipe(
				Effect.map(Chunk.toReadonlyArray),
			);
		},

		create: ({ data }: { readonly data: Record<string, unknown> }) =>
			// biome-ignore lint/suspicious/noExplicitAny: Data type is dynamic based on schema
			collection.create(data as any),

		createMany: ({
			data,
			options,
		}: {
			readonly data: ReadonlyArray<Record<string, unknown>>;
			readonly options?: {
				readonly skipDuplicates?: boolean;
				readonly validateRelationships?: boolean;
			};
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Data type is dynamic based on schema
			collection.createMany(data as any, options),

		update: ({
			id,
			updates,
		}: {
			readonly id: string;
			readonly updates: Record<string, unknown>;
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Updates type is dynamic based on schema
			collection.update(id, updates as any),

		updateMany: ({
			where,
			updates,
		}: {
			readonly where: Record<string, unknown>;
			readonly updates: Record<string, unknown>;
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Predicate and updates are dynamic
			collection.updateMany(
				// For RPC we receive where clause, convert to predicate that matches records
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic predicate
				(entity: any) => {
					for (const [key, value] of Object.entries(where)) {
						if (entity[key] !== value) return false;
					}
					return true;
				},
				updates as any,
			),

		delete: ({ id }: { readonly id: string }) =>
			collection.delete(id),

		deleteMany: ({
			where,
			options,
		}: {
			readonly where: Record<string, unknown>;
			readonly options?: {
				readonly limit?: number;
			};
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Predicate is dynamic
			collection.deleteMany((entity: any) => {
				for (const [key, value] of Object.entries(where)) {
					if (entity[key] !== value) return false;
				}
				return true;
			}, options),

		aggregate: (config: {
			readonly count?: boolean;
			readonly sum?: string | ReadonlyArray<string>;
			readonly avg?: string | ReadonlyArray<string>;
			readonly min?: string | ReadonlyArray<string>;
			readonly max?: string | ReadonlyArray<string>;
			readonly groupBy?: string | ReadonlyArray<string>;
			readonly where?: Record<string, unknown>;
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Aggregate config is dynamic
			collection.aggregate(config as any),

		upsert: ({
			where,
			create: createData,
			update: updateData,
		}: {
			readonly where: Record<string, unknown>;
			readonly create: Record<string, unknown>;
			readonly update: Record<string, unknown>;
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Upsert data is dynamic
			collection.upsert({
				where,
				create: createData,
				update: updateData,
			} as any),

		upsertMany: ({
			data,
		}: {
			readonly data: ReadonlyArray<{
				readonly where: Record<string, unknown>;
				readonly create: Record<string, unknown>;
				readonly update: Record<string, unknown>;
			}>;
		}) =>
			// biome-ignore lint/suspicious/noExplicitAny: Upsert data is dynamic
			collection.upsertMany(data as any),
	};
};

// ============================================================================
// RPC Handler Layer Factory
// ============================================================================

/**
 * Handler type for the RPC layer.
 * This is the shape of handlers that need to be provided to the RpcGroup.
 */
export type RpcHandlers<Config extends DatabaseConfig> = {
	readonly [K in keyof Config & string]: ReturnType<typeof createCollectionHandlers<Config>>;
};

/**
 * Create an Effect Layer that provides handlers for all RPC procedures.
 *
 * The layer:
 * 1. Creates an in-memory EffectDatabase from the config and optional initial data
 * 2. For each collection, wires handlers to the appropriate database methods
 * 3. Returns a Layer that provides the handler implementations
 *
 * @param config - The database configuration defining collections and schemas
 * @param initialData - Optional initial data to seed the database
 * @returns An Effect that produces the handler implementations for use with RpcGroup.toLayer
 *
 * @example
 * ```typescript
 * import { Layer } from "effect"
 * import { makeRpcHandlers, makeRpcGroup } from "@proseql/rpc"
 *
 * const config = {
 *   books: { schema: BookSchema, relationships: {} },
 * } as const
 *
 * const rpcs = makeRpcGroup(config)
 *
 * // Create handler implementations
 * const handlerEffect = makeRpcHandlers(config, {
 *   books: [{ id: "1", title: "Dune" }],
 * })
 *
 * // Use with RpcGroup.toLayer for the complete RPC server layer
 * ```
 */
export const makeRpcHandlers = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: Partial<DatasetFor<Config>>,
): Effect.Effect<RpcHandlers<Config>, MigrationError | PluginError> =>
	Effect.gen(function* () {
		// Create the in-memory database with optional initial data
		// biome-ignore lint/suspicious/noExplicitAny: DatasetFor type is complex and requires casting
		const db = yield* createEffectDatabase(config, initialData as any);

		// Build handlers for each collection
		const handlers = {} as Record<string, ReturnType<typeof createCollectionHandlers>>;
		for (const collectionName of Object.keys(config)) {
			handlers[collectionName] = createCollectionHandlers(
				collectionName as keyof Config,
				db,
			);
		}

		return handlers as RpcHandlers<Config>;
	});

/**
 * Create an Effect Layer that provides RPC handlers for all collections.
 *
 * This is a convenience wrapper that combines makeRpcHandlers with makeRpcGroup
 * to produce a complete Layer ready for use with Effect RPC server.
 *
 * @param config - The database configuration
 * @param initialData - Optional initial data to seed the database
 * @returns A Layer providing all RPC handlers
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { makeRpcHandlersLayer } from "@proseql/rpc"
 *
 * const config = {
 *   books: { schema: BookSchema, relationships: {} },
 * } as const
 *
 * // Create handler layer (can be composed with other layers)
 * const handlersLayer = makeRpcHandlersLayer(config, {
 *   books: [{ id: "1", title: "Dune" }],
 * })
 * ```
 */
export const makeRpcHandlersLayer = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: Partial<DatasetFor<Config>>,
): Layer.Layer<DatabaseContext<Config>, MigrationError | PluginError> => {
	const DatabaseContextTag = makeDatabaseContextTag<Config>();

	return Layer.effect(
		DatabaseContextTag,
		Effect.gen(function* () {
			// biome-ignore lint/suspicious/noExplicitAny: DatasetFor type is complex and requires casting
			const db = yield* createEffectDatabase(config, initialData as any);
			return { db };
		}),
	);
};
