/**
 * proseql-rpc — Type-safe Effect RPC layer for proseql databases.
 *
 * Derives an RpcGroup from a proseql DatabaseConfig, exposing all CRUD
 * operations and queries as typed RPC procedures. The client gets full
 * type inference including entity types, error channels, and relationship
 * population — no schema duplication required.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect"
 * import { Rpc, RpcGroup } from "@effect/rpc"
 * import { createEffectDatabase } from "proseql"
 * import { makeRpcGroup, makeRpcHandlers } from "proseql-rpc"
 *
 * // 1. Derive RPC group from your database config
 * const BooksRpc = makeRpcGroup(config)
 *
 * // 2. Create handler layer (wires RPCs to a live database)
 * const HandlerLayer = makeRpcHandlers(config, initialData)
 *
 * // 3. Client gets full type safety
 * const result = yield* client.books.query({ where: { year: { $gt: 2000 } } })
 * //    ^? ReadonlyArray<Book>
 * ```
 *
 * @module
 */

// ============================================================================
// Error Schemas
// ============================================================================

export {
	// Individual error schemas
	NotFoundErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	ValidationIssueSchema,
	ValidationErrorSchema,
	UniqueConstraintErrorSchema,
	ConcurrencyErrorSchema,
	OperationErrorSchema,
	TransactionErrorSchema,
	HookErrorSchema,
	DanglingReferenceErrorSchema,
	CollectionNotFoundErrorSchema,
	PopulationErrorSchema,
	// Union schemas
	CrudErrorSchema,
	QueryErrorSchema,
	RpcErrorSchema,
	// Type exports
	type NotFoundError,
	type DuplicateKeyError,
	type ForeignKeyError,
	type ValidationError,
	type UniqueConstraintError,
	type ConcurrencyError,
	type OperationError,
	type TransactionError,
	type HookError,
	type DanglingReferenceError,
	type CollectionNotFoundError,
	type PopulationError,
	type CrudError,
	type QueryError,
	type RpcError,
} from "./rpc-errors.js";

// ============================================================================
// Payload Schemas
// ============================================================================

export {
	// Common schemas
	SortOrderSchema,
	SortConfigSchema,
	CursorConfigSchema,
	FilterOperatorsSchema,
	WhereClauseSchema,
	SearchConfigSchema,
	PopulateConfigSchema,
	SelectConfigSchema,
	// Streaming options
	StreamingOptionsSchema,
	// Payload schemas
	FindByIdPayloadSchema,
	QueryPayloadSchema,
	CreatePayloadSchema,
	UpdatePayloadSchema,
	DeletePayloadSchema,
	AggregatePayloadSchema,
	CreateManyPayloadSchema,
	UpdateManyPayloadSchema,
	DeleteManyPayloadSchema,
	UpsertPayloadSchema,
	UpsertManyPayloadSchema,
	// Result schemas
	AggregateResultSchema,
	GroupResultSchema,
	GroupedAggregateResultSchema,
	CursorPageInfoSchema,
	CursorPageResultSchema,
	CreateManyResultSchema,
	UpdateManyResultSchema,
	DeleteManyResultSchema,
	UpsertResultSchema,
	UpsertManyResultSchema,
	// Type exports
	type StreamingOptions,
	type FindByIdPayload,
	type QueryPayload,
	type CreatePayload,
	type UpdatePayload,
	type DeletePayload,
	type AggregatePayload,
	type CreateManyPayload,
	type UpdateManyPayload,
	type DeleteManyPayload,
	type UpsertPayload,
	type UpsertManyPayload,
	type AggregateResultType,
	type GroupResultType,
	type GroupedAggregateResultType,
	type CursorPageInfoType,
	type CursorPageResultType,
	type CreateManyResultType,
	type UpdateManyResultType,
	type DeleteManyResultType,
	type UpsertResultType,
	type UpsertManyResultType,
} from "./rpc-schemas.js";

// ============================================================================
// RPC Group Derivation
// ============================================================================

export {
	// Main entry point
	makeRpcGroup,
	makeCollectionRpcs,
	RpcRouter,
	// Request factory functions
	makeFindByIdRequest,
	makeQueryRequest,
	makeQueryStreamRequest,
	makeCreateRequest,
	makeUpdateRequest,
	makeDeleteRequest,
	makeAggregateRequest,
	makeCreateManyRequest,
	makeUpdateManyRequest,
	makeDeleteManyRequest,
	makeUpsertRequest,
	makeUpsertManyRequest,
	// Type exports
	type RpcGroupFromConfig,
	type CollectionRpcDefinitions,
	type FindByIdRequestClass,
	type QueryRequestClass,
	type QueryStreamRequestClass,
	type CreateRequestClass,
	type UpdateRequestClass,
	type DeleteRequestClass,
	type AggregateRequestClass,
	type CreateManyRequestClass,
	type UpdateManyRequestClass,
	type DeleteManyRequestClass,
	type UpsertRequestClass,
	type UpsertManyRequestClass,
} from "./rpc-group.js";

// ============================================================================
// RPC Handler Layer
// ============================================================================

export {
	makeRpcHandlers,
	makeRpcHandlersFromDatabase,
	makeRpcHandlersLayer,
	makeRpcHandlersLayerFromDatabase,
	makeDatabaseContextTag,
	type RpcHandlers,
	type DatabaseContext,
} from "./rpc-handlers.js";
