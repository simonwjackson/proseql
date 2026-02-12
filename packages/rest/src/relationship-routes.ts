/**
 * REST Relationship Route Generation for proseql databases.
 *
 * Generates framework-agnostic HTTP handlers for relationship sub-routes
 * derived from collection relationship definitions in the DatabaseConfig.
 *
 * For `ref` relationships (e.g., books.author), generates:
 *   GET /books/:id/author — returns the related author entity
 *
 * For `inverse` relationships (e.g., authors.books), generates:
 *   GET /authors/:id/books — returns related book entities
 *
 * @module
 */

import { Chunk, Effect, Stream } from "effect";
import type {
	DatabaseConfig,
	EffectDatabase,
	EffectDatabaseWithPersistence,
} from "@proseql/core";
import type { RestHandler, RestResponse, RouteDescriptor } from "./handlers.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Relationship definition as found in collection config.
 */
interface RelationshipDef {
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey?: string;
}

/**
 * Information about a relationship route to be generated.
 */
interface RelationshipRouteInfo {
	/** The source collection name (e.g., "books") */
	readonly sourceCollection: string;
	/** The relationship name (e.g., "author") */
	readonly relationshipName: string;
	/** The relationship definition */
	readonly relationship: RelationshipDef;
}

// ============================================================================
// Relationship Inspection
// ============================================================================

/**
 * Extract all relationship definitions from a database configuration.
 *
 * Iterates over all collections in the config and extracts relationship
 * metadata for each defined relationship.
 *
 * @param config - The database configuration
 * @returns Array of relationship route info objects
 */
export const extractRelationships = <Config extends DatabaseConfig>(
	config: Config,
): ReadonlyArray<RelationshipRouteInfo> => {
	const relationships: Array<RelationshipRouteInfo> = [];

	for (const [collectionName, collectionConfig] of Object.entries(config)) {
		const collectionRelationships = collectionConfig.relationships;
		if (!collectionRelationships) continue;

		for (const [relationshipName, relationship] of Object.entries(
			collectionRelationships,
		)) {
			relationships.push({
				sourceCollection: collectionName,
				relationshipName,
				relationship: relationship as RelationshipDef,
			});
		}
	}

	return relationships;
};

// ============================================================================
// Handler Creation
// ============================================================================

/**
 * Create a handler for a `ref` relationship route.
 *
 * For a `ref` relationship like `books.author`, this generates a handler for
 * `GET /books/:id/author` that:
 * 1. Finds the source entity (book) by ID
 * 2. Follows the foreign key to the target collection (authors)
 * 3. Returns the related entity
 *
 * @param sourceCollection - The collection object for the source entity
 * @param targetCollection - The collection object for the target entity
 * @param foreignKey - The foreign key field name on the source entity
 * @returns A REST handler function
 */
const createRefRelationshipHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	sourceCollection: Record<string, (...args: ReadonlyArray<any>) => any>,
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	targetCollection: Record<string, (...args: ReadonlyArray<any>) => any>,
	foreignKey: string,
): RestHandler => {
	return async (req): Promise<RestResponse> => {
		const { id } = req.params;

		try {
			// Find the source entity
			const findSourceEffect = sourceCollection.findById(
				id,
			) as Effect.Effect<Record<string, unknown>, unknown>;
			const sourceEntity = await Effect.runPromise(findSourceEffect);

			// Get the foreign key value
			const targetId = sourceEntity[foreignKey];
			if (targetId === null || targetId === undefined) {
				// No related entity (foreign key is null/undefined)
				return { status: 200, body: null };
			}

			// Find the related entity
			const findTargetEffect = targetCollection.findById(
				targetId as string,
			) as Effect.Effect<Record<string, unknown>, unknown>;
			const targetEntity = await Effect.runPromise(findTargetEffect);

			return { status: 200, body: targetEntity };
		} catch (error) {
			if (isTaggedError(error, "NotFoundError")) {
				return {
					status: 404,
					body: { error: "Not found", _tag: "NotFoundError" },
				};
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

/**
 * Create a handler for an `inverse` relationship route.
 *
 * For an `inverse` relationship like `authors.books`, this generates a handler
 * for `GET /authors/:id/books` that:
 * 1. Verifies the source entity (author) exists
 * 2. Queries the target collection (books) filtered by the foreign key
 * 3. Returns the related entities array
 *
 * @param sourceCollection - The collection object for the source entity
 * @param targetCollection - The collection object for the target entity
 * @param foreignKey - The foreign key field name on the target entity
 * @returns A REST handler function
 */
const createInverseRelationshipHandler = (
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	sourceCollection: Record<string, (...args: ReadonlyArray<any>) => any>,
	// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
	targetCollection: Record<string, (...args: ReadonlyArray<any>) => any>,
	foreignKey: string,
): RestHandler => {
	return async (req): Promise<RestResponse> => {
		const { id } = req.params;

		try {
			// Verify the source entity exists
			const findSourceEffect = sourceCollection.findById(
				id,
			) as Effect.Effect<Record<string, unknown>, unknown>;
			await Effect.runPromise(findSourceEffect);

			// Query the target collection for related entities
			const queryConfig = {
				where: { [foreignKey]: id },
			};
			const stream = targetCollection.query(queryConfig);
			const results = await Effect.runPromise(
				Stream.runCollect(
					stream as Stream.Stream<Record<string, unknown>>,
				).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			return { status: 200, body: results };
		} catch (error) {
			if (isTaggedError(error, "NotFoundError")) {
				return {
					status: 404,
					body: { error: "Not found", _tag: "NotFoundError" },
				};
			}
			return { status: 500, body: { error: "Internal server error" } };
		}
	};
};

// ============================================================================
// Route Generation
// ============================================================================

/**
 * Create REST handlers for all relationship routes in a database.
 *
 * Generates sub-routes for navigating relationships:
 * - `ref` relationships: `GET /:collection/:id/:relationshipName`
 * - `inverse` relationships: `GET /:collection/:id/:relationshipName`
 *
 * @param config - The database configuration defining collections and relationships
 * @param db - An EffectDatabase or EffectDatabaseWithPersistence instance
 * @returns Array of route descriptors for relationship routes
 *
 * @example
 * ```typescript
 * const config = {
 *   books: {
 *     schema: BookSchema,
 *     relationships: {
 *       author: { type: "ref", target: "authors", foreignKey: "authorId" },
 *     },
 *   },
 *   authors: {
 *     schema: AuthorSchema,
 *     relationships: {
 *       books: { type: "inverse", target: "books", foreignKey: "authorId" },
 *     },
 *   },
 * } as const
 *
 * const routes = createRelationshipRoutes(config, db)
 * // Generates:
 * //   GET /books/:id/author  — returns the author of a book
 * //   GET /authors/:id/books — returns all books by an author
 * ```
 */
export const createRelationshipRoutes = <Config extends DatabaseConfig>(
	config: Config,
	db: EffectDatabase<Config> | EffectDatabaseWithPersistence<Config>,
): ReadonlyArray<RouteDescriptor> => {
	const routes: Array<RouteDescriptor> = [];
	const relationships = extractRelationships(config);

	for (const { sourceCollection, relationshipName, relationship } of relationships) {
		// Get the source and target collections from the database
		// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
		const source = (db as Record<string, any>)[sourceCollection];
		// biome-ignore lint/suspicious/noExplicitAny: Collection type is dynamic
		const target = (db as Record<string, any>)[relationship.target];

		if (!source || !target) {
			// Skip if collections don't exist (shouldn't happen with valid config)
			continue;
		}

		const path = `/${sourceCollection}/:id/${relationshipName}`;

		if (relationship.type === "ref") {
			// For ref relationships, the foreign key is on the source entity
			const foreignKey = relationship.foreignKey || `${relationshipName}Id`;
			routes.push({
				method: "GET",
				path,
				handler: createRefRelationshipHandler(source, target, foreignKey),
			});
		} else if (relationship.type === "inverse") {
			// For inverse relationships, the foreign key is on the target entity
			// The foreignKey in the config specifies the field on the target that points back
			const foreignKey = relationship.foreignKey || deriveForeignKey(sourceCollection);
			routes.push({
				method: "GET",
				path,
				handler: createInverseRelationshipHandler(source, target, foreignKey),
			});
		}
	}

	return routes;
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Derive a default foreign key name from a collection name.
 *
 * Converts plural collection names to singular + "Id":
 * - "users" → "userId"
 * - "companies" → "companyId"
 * - "categories" → "categoryId"
 *
 * @param collectionName - The collection name (typically plural)
 * @returns The derived foreign key field name
 */
const deriveForeignKey = (collectionName: string): string => {
	// Handle "-ies" plural (companies → companyId)
	if (collectionName.endsWith("ies")) {
		return `${collectionName.slice(0, -3)}yId`;
	}
	// Handle regular "-s" plural (users → userId)
	if (collectionName.endsWith("s")) {
		return `${collectionName.slice(0, -1)}Id`;
	}
	// Fallback: just append "Id"
	return `${collectionName}Id`;
};

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
