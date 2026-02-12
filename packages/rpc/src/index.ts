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
	type CollectionNotFoundError,
	CollectionNotFoundErrorSchema,
	type ConcurrencyError,
	ConcurrencyErrorSchema,
	type CrudError,
	// Union schemas
	CrudErrorSchema,
	type DanglingReferenceError,
	DanglingReferenceErrorSchema,
	type DuplicateKeyError,
	DuplicateKeyErrorSchema,
	type ForeignKeyError,
	ForeignKeyErrorSchema,
	type HookError,
	HookErrorSchema,
	// Type exports
	type NotFoundError,
	// Individual error schemas
	NotFoundErrorSchema,
	type OperationError,
	OperationErrorSchema,
	type PopulationError,
	PopulationErrorSchema,
	type QueryError,
	QueryErrorSchema,
	type RpcError,
	RpcErrorSchema,
	type TransactionError,
	TransactionErrorSchema,
	type UniqueConstraintError,
	UniqueConstraintErrorSchema,
	type ValidationError,
	ValidationErrorSchema,
	ValidationIssueSchema,
} from "./rpc-errors.js";

// ============================================================================
// Payload Schemas
// ============================================================================

export {
	type AggregatePayload,
	AggregatePayloadSchema,
	// Result schemas
	AggregateResultSchema,
	type AggregateResultType,
	type CreateManyPayload,
	CreateManyPayloadSchema,
	CreateManyResultSchema,
	type CreateManyResultType,
	type CreatePayload,
	CreatePayloadSchema,
	CursorConfigSchema,
	CursorPageInfoSchema,
	type CursorPageInfoType,
	CursorPageResultSchema,
	type CursorPageResultType,
	type DeleteManyPayload,
	DeleteManyPayloadSchema,
	DeleteManyResultSchema,
	type DeleteManyResultType,
	type DeletePayload,
	DeletePayloadSchema,
	FilterOperatorsSchema,
	type FindByIdPayload,
	// Payload schemas
	FindByIdPayloadSchema,
	GroupedAggregateResultSchema,
	type GroupedAggregateResultType,
	GroupResultSchema,
	type GroupResultType,
	PopulateConfigSchema,
	type QueryPayload,
	QueryPayloadSchema,
	SearchConfigSchema,
	SelectConfigSchema,
	SortConfigSchema,
	// Common schemas
	SortOrderSchema,
	// Type exports
	type StreamingOptions,
	// Streaming options
	StreamingOptionsSchema,
	type UpdateManyPayload,
	UpdateManyPayloadSchema,
	UpdateManyResultSchema,
	type UpdateManyResultType,
	type UpdatePayload,
	UpdatePayloadSchema,
	type UpsertManyPayload,
	UpsertManyPayloadSchema,
	UpsertManyResultSchema,
	type UpsertManyResultType,
	type UpsertPayload,
	UpsertPayloadSchema,
	UpsertResultSchema,
	type UpsertResultType,
	WhereClauseSchema,
} from "./rpc-schemas.js";

// ============================================================================
// RPC Group Derivation
// ============================================================================

export {
	type AggregateRequestClass,
	type CollectionRpcDefinitions,
	type CreateManyRequestClass,
	type CreateRequestClass,
	type DeleteManyRequestClass,
	type DeleteRequestClass,
	type FindByIdRequestClass,
	makeAggregateRequest,
	makeCollectionRpcs,
	makeCreateManyRequest,
	makeCreateRequest,
	makeDeleteManyRequest,
	makeDeleteRequest,
	// Request factory functions
	makeFindByIdRequest,
	makeQueryRequest,
	makeQueryStreamRequest,
	// Main entry point
	makeRpcGroup,
	makeUpdateManyRequest,
	makeUpdateRequest,
	makeUpsertManyRequest,
	makeUpsertRequest,
	type QueryRequestClass,
	type QueryStreamRequestClass,
	// Type exports
	type RpcGroupFromConfig,
	RpcRouter,
	type UpdateManyRequestClass,
	type UpdateRequestClass,
	type UpsertManyRequestClass,
	type UpsertRequestClass,
} from "./rpc-group.js";

// ============================================================================
// RPC Handler Layer
// ============================================================================

export {
	type DatabaseContext,
	makeDatabaseContextTag,
	makeRpcHandlers,
	makeRpcHandlersFromDatabase,
	makeRpcHandlersLayer,
	makeRpcHandlersLayerFromDatabase,
	type RpcHandlers,
} from "./rpc-handlers.js";
