/**
 * REST Handler Generation for proseql databases.
 *
 * Generates framework-agnostic HTTP handlers for CRUD operations, queries,
 * and aggregations from a DatabaseConfig and EffectDatabase instance.
 *
 * @module
 */

import { Chunk, Effect, Stream } from "effect";
import type {
	DatabaseConfig,
	EffectDatabase,
	EffectDatabaseWithPersistence,
} from "@proseql/core";

// ============================================================================
// Types
// ============================================================================

/**
 * Framework-agnostic request object shape.
 * Adapters for specific frameworks (Express, Hono, Bun.serve) convert their
 * native request objects to this shape before invoking handlers.
 */
export interface RestRequest {
	/**
	 * URL path parameters extracted by the framework's router.
	 * Example: for route "/books/:id", params = { id: "123" }
	 */
	readonly params: Record<string, string>;

	/**
	 * URL query parameters (search params).
	 * Values can be strings or arrays of strings for repeated parameters.
	 * Example: ?genre=sci-fi&year=1984 → { genre: "sci-fi", year: "1984" }
	 * Example: ?tags=a&tags=b → { tags: ["a", "b"] }
	 */
	readonly query: Record<string, string | ReadonlyArray<string>>;

	/**
	 * Parsed request body (for POST/PUT/PATCH requests).
	 * The framework adapter is responsible for parsing JSON bodies.
	 */
	readonly body: unknown;
}

/**
 * Framework-agnostic response object shape.
 * Handlers return this shape; framework adapters convert it to native responses.
 */
export interface RestResponse {
	/** HTTP status code (e.g., 200, 201, 400, 404, 500) */
	readonly status: number;

	/** Response body to serialize as JSON */
	readonly body: unknown;

	/** Optional additional headers */
	readonly headers?: Record<string, string>;
}

/**
 * Framework-agnostic HTTP handler function.
 * Receives a request object and returns a promise resolving to a response object.
 */
export type RestHandler = (req: RestRequest) => Promise<RestResponse>;

/**
 * HTTP method type for route definitions.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Route descriptor returned by createRestHandlers.
 * Contains the HTTP method, path pattern, and handler function.
 */
export interface RouteDescriptor {
	/** HTTP method for this route */
	readonly method: HttpMethod;

	/** URL path pattern (e.g., "/books", "/books/:id") */
	readonly path: string;

	/** Handler function to invoke for matching requests */
	readonly handler: RestHandler;
}

// ============================================================================
// Handler Factory
// ============================================================================

/**
 * Create REST handlers for all collections in a database.
 *
 * Generates framework-agnostic route descriptors that can be adapted to any
 * HTTP framework (Express, Hono, Bun.serve, etc.).
 *
 * Generated routes per collection:
 * - GET    /:collection           — Query with filters, sort, pagination
 * - GET    /:collection/:id       — Find by ID
 * - POST   /:collection           — Create entity
 * - PUT    /:collection/:id       — Update entity
 * - DELETE /:collection/:id       — Delete entity
 * - POST   /:collection/batch     — Create multiple entities
 * - GET    /:collection/aggregate — Aggregation queries
 *
 * @param config - The database configuration defining collections
 * @param db - An EffectDatabase or EffectDatabaseWithPersistence instance
 * @returns Array of route descriptors with method, path, and handler
 *
 * @example
 * ```typescript
 * import { createRestHandlers } from "@proseql/rest"
 * import { createEffectDatabase } from "@proseql/core"
 *
 * const config = {
 *   books: { schema: BookSchema, relationships: {} },
 * } as const
 *
 * const db = await Effect.runPromise(createEffectDatabase(config, initialData))
 * const routes = createRestHandlers(config, db)
 *
 * // Adapt to your framework:
 * for (const { method, path, handler } of routes) {
 *   app[method.toLowerCase()](path, async (req, res) => {
 *     const response = await handler({
 *       params: req.params,
 *       query: req.query,
 *       body: req.body,
 *     })
 *     res.status(response.status).json(response.body)
 *   })
 * }
 * ```
 */
export const createRestHandlers = <Config extends DatabaseConfig>(
	config: Config,
	db: EffectDatabase<Config> | EffectDatabaseWithPersistence<Config>,
): ReadonlyArray<RouteDescriptor> => {
	const routes: Array<RouteDescriptor> = [];

	// Generate routes for each collection
	for (const collectionName of Object.keys(config)) {
		// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic based on config
		const collection = (db as Record<string, any>)[collectionName];

		// GET /:collection — Query with filters, sort, pagination
		routes.push({
			method: "GET",
			path: `/${collectionName}`,
			handler: createQueryHandler(collection),
		});

		// GET /:collection/aggregate — Aggregation queries
		// Must be before /:collection/:id to avoid matching "aggregate" as an ID
		routes.push({
			method: "GET",
			path: `/${collectionName}/aggregate`,
			handler: createAggregateHandler(collection),
		});

		// GET /:collection/:id — Find by ID
		routes.push({
			method: "GET",
			path: `/${collectionName}/:id`,
			handler: createFindByIdHandler(collection),
		});

		// POST /:collection — Create entity
		routes.push({
			method: "POST",
			path: `/${collectionName}`,
			handler: createCreateHandler(collection),
		});

		// POST /:collection/batch — Create multiple entities
		routes.push({
			method: "POST",
			path: `/${collectionName}/batch`,
			handler: createBatchHandler(collection),
		});

		// PUT /:collection/:id — Update entity
		routes.push({
			method: "PUT",
			path: `/${collectionName}/:id`,
			handler: createUpdateHandler(collection),
		});

		// DELETE /:collection/:id — Delete entity
		routes.push({
			method: "DELETE",
			path: `/${collectionName}/:id`,
			handler: createDeleteHandler(collection),
		});
	}

	return routes;
};

// ============================================================================
// Individual Handler Factories
// ============================================================================

/**
 * Create a GET handler for querying a collection.
 * Parses query parameters and delegates to the collection's query method.
 */
const createQueryHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (_req: RestRequest): Promise<RestResponse> => {
		// TODO: Parse query params via parseQueryParams (task 6.1)
		// For now, return all results
		const stream = collection.query({});
		const result = await Effect.runPromise(
			Stream.runCollect(stream as Stream.Stream<Record<string, unknown>>).pipe(
				Effect.map(Chunk.toReadonlyArray),
			),
		);
		return { status: 200, body: result };
	};
};

/**
 * Create a GET handler for finding an entity by ID.
 */
const createFindByIdHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (req: RestRequest): Promise<RestResponse> => {
		const { id } = req.params;
		try {
			const findEffect = collection.findById(id) as Effect.Effect<Record<string, unknown>, unknown>;
			const entity = await Effect.runPromise(findEffect);
			return { status: 200, body: entity };
		} catch (error) {
			// TODO: Map errors via mapErrorToResponse (task 8.1)
			if (isTaggedError(error, "NotFoundError")) {
				return { status: 404, body: { error: "Not found", _tag: "NotFoundError" } };
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a POST handler for creating an entity.
 */
const createCreateHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (req: RestRequest): Promise<RestResponse> => {
		try {
			const createEffect = collection.create(req.body) as Effect.Effect<Record<string, unknown>, unknown>;
			const entity = await Effect.runPromise(createEffect);
			return { status: 201, body: entity };
		} catch (error) {
			// TODO: Map errors via mapErrorToResponse (task 8.1)
			if (isTaggedError(error, "ValidationError")) {
				return { status: 400, body: { error: "Validation error", _tag: "ValidationError" } };
			}
			if (isTaggedError(error, "DuplicateKeyError")) {
				return { status: 409, body: { error: "Duplicate key", _tag: "DuplicateKeyError" } };
			}
			if (isTaggedError(error, "UniqueConstraintError")) {
				return { status: 409, body: { error: "Unique constraint violation", _tag: "UniqueConstraintError" } };
			}
			if (isTaggedError(error, "ForeignKeyError")) {
				return { status: 422, body: { error: "Foreign key violation", _tag: "ForeignKeyError" } };
			}
			if (isTaggedError(error, "HookError")) {
				return { status: 422, body: { error: "Hook error", _tag: "HookError" } };
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a PUT handler for updating an entity.
 */
const createUpdateHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (req: RestRequest): Promise<RestResponse> => {
		const { id } = req.params;
		try {
			const updateEffect = collection.update(id, req.body) as Effect.Effect<Record<string, unknown>, unknown>;
			const entity = await Effect.runPromise(updateEffect);
			return { status: 200, body: entity };
		} catch (error) {
			// TODO: Map errors via mapErrorToResponse (task 8.1)
			if (isTaggedError(error, "NotFoundError")) {
				return { status: 404, body: { error: "Not found", _tag: "NotFoundError" } };
			}
			if (isTaggedError(error, "ValidationError")) {
				return { status: 400, body: { error: "Validation error", _tag: "ValidationError" } };
			}
			if (isTaggedError(error, "UniqueConstraintError")) {
				return { status: 409, body: { error: "Unique constraint violation", _tag: "UniqueConstraintError" } };
			}
			if (isTaggedError(error, "HookError")) {
				return { status: 422, body: { error: "Hook error", _tag: "HookError" } };
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a DELETE handler for deleting an entity.
 */
const createDeleteHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (req: RestRequest): Promise<RestResponse> => {
		const { id } = req.params;
		try {
			const deleteEffect = collection.delete(id) as Effect.Effect<Record<string, unknown>, unknown>;
			const entity = await Effect.runPromise(deleteEffect);
			return { status: 200, body: entity };
		} catch (error) {
			// TODO: Map errors via mapErrorToResponse (task 8.1)
			if (isTaggedError(error, "NotFoundError")) {
				return { status: 404, body: { error: "Not found", _tag: "NotFoundError" } };
			}
			if (isTaggedError(error, "HookError")) {
				return { status: 422, body: { error: "Hook error", _tag: "HookError" } };
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a POST handler for batch creating entities.
 */
const createBatchHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (req: RestRequest): Promise<RestResponse> => {
		try {
			const batchEffect = collection.createMany(req.body) as Effect.Effect<Record<string, unknown>, unknown>;
			const result = await Effect.runPromise(batchEffect);
			return { status: 201, body: result };
		} catch (error) {
			// TODO: Map errors via mapErrorToResponse (task 8.1)
			if (isTaggedError(error, "ValidationError")) {
				return { status: 400, body: { error: "Validation error", _tag: "ValidationError" } };
			}
			if (isTaggedError(error, "DuplicateKeyError")) {
				return { status: 409, body: { error: "Duplicate key", _tag: "DuplicateKeyError" } };
			}
			if (isTaggedError(error, "UniqueConstraintError")) {
				return { status: 409, body: { error: "Unique constraint violation", _tag: "UniqueConstraintError" } };
			}
			if (isTaggedError(error, "ForeignKeyError")) {
				return { status: 422, body: { error: "Foreign key violation", _tag: "ForeignKeyError" } };
			}
			if (isTaggedError(error, "HookError")) {
				return { status: 422, body: { error: "Hook error", _tag: "HookError" } };
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a GET handler for aggregation queries.
 */
const createAggregateHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	collection: Record<string, (...args: ReadonlyArray<any>) => any>,
): RestHandler => {
	return async (_req: RestRequest): Promise<RestResponse> => {
		// TODO: Parse aggregate query params (task 7.7)
		// For now, return a basic count
		try {
			const aggregateEffect = collection.aggregate({ count: true }) as Effect.Effect<Record<string, unknown>, unknown>;
			const result = await Effect.runPromise(aggregateEffect);
			return { status: 200, body: result };
		} catch (error) {
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Type guard to check if an error has a specific _tag.
 */
const isTaggedError = (error: unknown, tag: string): boolean => {
	return (
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		(error as { _tag: unknown })._tag === tag
	);
};
