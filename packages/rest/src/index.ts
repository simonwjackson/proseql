/**
 * proseql-rest — Auto-generated REST API for proseql databases.
 *
 * Given a proseql DatabaseConfig, generates framework-agnostic HTTP handlers
 * for CRUD operations, queries, and aggregations. Includes query parameter
 * parsing for filters, sorting, pagination, and field selection.
 *
 * @example
 * ```ts
 * import { createRestHandlers } from "proseql-rest"
 * import { createEffectDatabase } from "proseql"
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

export {};
