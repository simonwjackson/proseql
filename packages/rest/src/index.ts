/**
 * proseql-rest — Auto-generated REST API for proseql databases.
 *
 * Given a proseql DatabaseConfig, generates framework-agnostic HTTP handlers
 * for CRUD operations, queries, and aggregations. Includes query parameter
 * parsing for filters, sorting, pagination, and field selection.
 *
 * @example
 * ```ts
 * import { createRestHandlers } from "@proseql/rest"
 * import { createEffectDatabase } from "@proseql/core"
 *
 * const handlers = createRestHandlers(config, db)
 *
 * // Framework-agnostic handler signature:
 * // (req: { params, query, body }) => Promise<{ status, body }>
 *
 * // Generated routes:
 * // GET    /books          — query with filters, sort, pagination
 * // GET    /books/:id      — findById
 * // POST   /books          — create
 * // PUT    /books/:id      — update
 * // DELETE /books/:id      — delete
 * // POST   /books/batch    — createMany
 * // GET    /books/aggregate — aggregation
 * ```
 *
 * @module
 */

// ============================================================================
// Handler Generation
// ============================================================================

export {
	createRestHandlers,
	type HttpMethod,
	type RestHandler,
	type RestRequest,
	type RestResponse,
	type RouteDescriptor,
} from "./handlers.js";

// ============================================================================
// Query Parameter Parsing
// ============================================================================

export {
	type ParsedAggregateConfig,
	type ParsedQueryConfig,
	parseAggregateParams,
	parseQueryParams,
	type QueryParams,
} from "./query-params.js";

// ============================================================================
// Error Mapping
// ============================================================================

export { type ErrorResponse, mapErrorToResponse } from "./error-mapping.js";

// ============================================================================
// Relationship Routes
// ============================================================================

export {
	createRelationshipRoutes,
	extractRelationships,
} from "./relationship-routes.js";
