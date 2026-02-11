/**
 * Effect-based database factory.
 *
 * Creates an in-memory database with typed collections, each backed by
 * Ref<ReadonlyMap<string, T>> for O(1) ID lookup and atomic state updates.
 *
 * Query pipeline: Ref snapshot → Stream.fromIterable → filter → populate → sort → paginate → select
 * CRUD: Effect-based operations with typed error channels
 * Persistence: Optional debounced save after each CRUD mutation via Effect.fork
 */

import { Effect, Ref, Stream, Schema, Chunk, Layer, Scope } from "effect"
import type { DatabaseConfig } from "../types/database-config-types.js"
import type { CollectionConfig } from "../types/database-config-types.js"
import type { CollectionIndexes } from "../types/index-types.js"
import { normalizeIndexes, buildIndexes } from "../indexes/index-manager.js"
import { resolveWithIndex } from "../indexes/index-lookup.js"
import { validateMigrationRegistry, dryRunMigrations } from "../migrations/migration-runner.js"
import type { MigrationError } from "../errors/migration-errors.js"
import type { DryRunResult } from "../migrations/migration-types.js"
import type {
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	UpdateWithOperators,
	MinimalEntity,
	UpdateManyResult,
	DeleteManyResult,
	UpsertInput,
	UpsertResult,
	UpsertManyResult,
} from "../types/crud-types.js"
import type { RelationshipDef } from "../types/types.js"
import type {
	CreateWithRelationshipsInput,
	UpdateWithRelationshipsInput,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
} from "../types/crud-relationship-types.js"
import { create, createMany } from "../operations/crud/create.js"
import { update, updateMany } from "../operations/crud/update.js"
import { del, deleteMany } from "../operations/crud/delete.js"
import { upsert, upsertMany } from "../operations/crud/upsert.js"
import { normalizeConstraints } from "../operations/crud/unique-check.js"
import { createWithRelationships } from "../operations/crud/create-with-relationships.js"
import { updateWithRelationships } from "../operations/crud/update-with-relationships.js"
import {
	deleteWithRelationships,
	deleteManyWithRelationships,
} from "../operations/crud/delete-with-relationships.js"
import { applyFilter } from "../operations/query/filter-stream.js"
import { applySort, applyRelevanceSort, extractSearchConfig } from "../operations/query/sort-stream.js"
import { applySelect, applySelectToArray } from "../operations/query/select-stream.js"
import { applyPagination } from "../operations/query/paginate-stream.js"
import { applyPopulate } from "../operations/relationships/populate-stream.js"
import {
	resolveComputedStream,
	resolveComputedStreamWithLazySkip,
} from "../operations/query/resolve-computed.js"
import type { CursorConfig, CursorPageResult, RunnableCursorPage } from "../types/cursor-types.js"
import { applyCursor } from "../operations/query/cursor-stream.js"
import {
	computeAggregates,
	computeGroupedAggregates,
} from "../operations/query/aggregate.js"
import {
	isGroupedAggregateConfig,
	type AggregateConfig,
	type AggregateResult,
	type GroupedAggregateResult,
} from "../types/aggregate-types.js"
import type { DanglingReferenceError } from "../errors/query-errors.js"
import {
	NotFoundError,
	ValidationError,
	type DuplicateKeyError,
	type ForeignKeyError,
	type HookError,
	type OperationError,
	type UniqueConstraintError,
} from "../errors/crud-errors.js"
import type {
	StorageError,
	SerializationError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js"
import { StorageAdapter } from "../storage/storage-service.js"
import { SerializerRegistry } from "../serializers/serializer-service.js"
import { saveData, loadData } from "../storage/persistence-effect.js"
import { $transaction as $transactionImpl } from "../transactions/transaction.js"
import type { TransactionContext } from "../types/crud-types.js"
import { TransactionError } from "../errors/crud-errors.js"

// ============================================================================
// Convenience API: runPromise
// ============================================================================

/**
 * An Effect with a lazy `runPromise` getter for non-Effect consumers.
 * Accessing `.runPromise` runs the effect and returns a Promise.
 */
export type RunnableEffect<A, E> = Effect.Effect<A, E, never> & {
	readonly runPromise: Promise<A>
}

/**
 * A Stream with a lazy `runPromise` getter for non-Effect consumers.
 * Accessing `.runPromise` collects the stream into an array and returns a Promise.
 */
export type RunnableStream<A, E> = Stream.Stream<A, E, never> & {
	readonly runPromise: Promise<ReadonlyArray<A>>
}

/**
 * Attach a lazy `runPromise` getter to an Effect value.
 * The effect is only executed when `.runPromise` is accessed.
 */
const withRunPromise = <A, E>(
	effect: Effect.Effect<A, E, never>,
): RunnableEffect<A, E> => {
	let cached: Promise<A> | undefined
	Object.defineProperty(effect, "runPromise", {
		get() {
			if (cached === undefined) {
				cached = Effect.runPromise(effect)
			}
			return cached
		},
		enumerable: false,
		configurable: true,
	})
	return effect as RunnableEffect<A, E>
}

/**
 * Attach a lazy `runPromise` getter to a Stream value.
 * The stream is collected into an array when `.runPromise` is accessed.
 */
const withStreamRunPromise = <A, E>(
	stream: Stream.Stream<A, E, never>,
): RunnableStream<A, E> => {
	let cached: Promise<ReadonlyArray<A>> | undefined
	Object.defineProperty(stream, "runPromise", {
		get() {
			if (cached === undefined) {
				cached = Effect.runPromise(
					Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
				)
			}
			return cached
		},
		enumerable: false,
		configurable: true,
	})
	return stream as RunnableStream<A, E>
}

/**
 * Attach a lazy `runPromise` getter to an Effect returning CursorPageResult.
 * The effect is only executed when `.runPromise` is accessed.
 */
const withCursorRunPromise = <T, E>(
	effect: Effect.Effect<CursorPageResult<T>, E, never>,
): RunnableCursorPage<T, E> => {
	let cached: Promise<CursorPageResult<T>> | undefined
	Object.defineProperty(effect, "runPromise", {
		get() {
			if (cached === undefined) {
				cached = Effect.runPromise(effect)
			}
			return cached
		},
		enumerable: false,
		configurable: true,
	})
	return effect as RunnableCursorPage<T, E>
}

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

/**
 * Shape of a single Effect-based collection.
 * Query returns a RunnableStream (or RunnableCursorPage when cursor is specified),
 * CRUD methods return RunnableEffects.
 * Both have a `.runPromise` getter for non-Effect consumers.
 */
export interface EffectCollection<T extends HasId> {
	readonly query: (options?: {
		readonly where?: Record<string, unknown>
		readonly populate?: Record<string, unknown>
		readonly sort?: Record<string, "asc" | "desc">
		readonly select?: Record<string, unknown> | ReadonlyArray<string>
		readonly limit?: number
		readonly offset?: number
		readonly cursor?: CursorConfig
	}) => RunnableStream<Record<string, unknown>, DanglingReferenceError | ValidationError> | RunnableCursorPage<Record<string, unknown>, DanglingReferenceError | ValidationError>

	readonly findById: (
		id: string,
	) => RunnableEffect<T, NotFoundError>

	readonly create: (
		input: CreateInput<T>,
	) => RunnableEffect<T, ValidationError | DuplicateKeyError | ForeignKeyError | HookError | UniqueConstraintError>
	readonly createMany: (
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	) => RunnableEffect<
		CreateManyResult<T>,
		ValidationError | DuplicateKeyError | ForeignKeyError | HookError | UniqueConstraintError
	>

	readonly update: (
		id: string,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<T, ValidationError | NotFoundError | ForeignKeyError | HookError | UniqueConstraintError>
	readonly updateMany: (
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<UpdateManyResult<T>, ValidationError | ForeignKeyError | HookError | UniqueConstraintError>

	readonly delete: (
		id: string,
		options?: { readonly soft?: boolean },
	) => RunnableEffect<T, NotFoundError | OperationError | ForeignKeyError | HookError>
	readonly deleteMany: (
		predicate: (entity: T) => boolean,
		options?: { readonly soft?: boolean; readonly limit?: number },
	) => RunnableEffect<
		DeleteManyResult<T>,
		OperationError | ForeignKeyError | HookError
	>

	readonly upsert: (
		input: UpsertInput<T>,
	) => RunnableEffect<UpsertResult<T>, ValidationError | ForeignKeyError | HookError | UniqueConstraintError>
	readonly upsertMany: (
		inputs: ReadonlyArray<UpsertInput<T>>,
	) => RunnableEffect<UpsertManyResult<T>, ValidationError | ForeignKeyError | HookError | UniqueConstraintError>

	readonly createWithRelationships: (
		input: CreateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => RunnableEffect<
		T,
		ValidationError | ForeignKeyError | OperationError
	>
	readonly updateWithRelationships: (
		id: string,
		input: UpdateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => RunnableEffect<
		T,
		ValidationError | NotFoundError | ForeignKeyError | OperationError
	>
	readonly deleteWithRelationships: (
		id: string,
		options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>>,
	) => RunnableEffect<
		DeleteWithRelationshipsResult<T>,
		NotFoundError | ValidationError | OperationError
	>
	readonly deleteManyWithRelationships: (
		predicate: (entity: T) => boolean,
		options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>> & {
			readonly limit?: number
		},
	) => RunnableEffect<
		{
			readonly count: number
			readonly deleted: ReadonlyArray<T>
			readonly cascaded?: Record<string, { readonly count: number; readonly ids: ReadonlyArray<string> }>
		},
		ValidationError | OperationError
	>

	readonly aggregate: <C extends AggregateConfig>(
		config: C,
	) => C extends { readonly groupBy: string | ReadonlyArray<string> }
		? RunnableEffect<GroupedAggregateResult, never>
		: RunnableEffect<AggregateResult, never>
}

/**
 * Database type: a record of collection names to EffectCollections,
 * plus the $transaction method for atomic operations.
 */
export type EffectDatabase<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: EffectCollection<
		Schema.Schema.Type<Config[K]["schema"]> & HasId
	>
} & {
	/**
	 * Execute multiple operations atomically within a transaction.
	 * On success, all changes are committed and persistence is triggered.
	 * On failure, all changes are rolled back and the original error is re-raised.
	 */
	readonly $transaction: <A, E>(
		fn: (ctx: TransactionContext) => Effect.Effect<A, E>,
	) => RunnableEffect<A, E | TransactionError>
}

/**
 * Configuration for database persistence.
 * When provided, CRUD mutations trigger debounced saves to disk.
 */
export interface EffectDatabasePersistenceConfig {
	/** Debounce delay in milliseconds (default 100) */
	readonly writeDebounce?: number
}

/**
 * Extended database type with persistence control methods.
 */
export type EffectDatabaseWithPersistence<Config extends DatabaseConfig> =
	EffectDatabase<Config> & {
		/** Flush all pending debounced writes immediately. Returns a Promise. */
		readonly flush: () => Promise<void>
		/** Returns the number of writes currently pending. */
		readonly pendingCount: () => number
		/**
		 * Preview which files need migration and what transforms would apply.
		 * No transforms are executed. No files are written.
		 */
		readonly $dryRunMigrations: () => RunnableEffect<DryRunResult, MigrationError | StorageError | SerializationError | UnsupportedFormatError>
	}

// ============================================================================
// Runtime-independent Debounced Persistence Trigger
// ============================================================================

/**
 * A runtime-independent debounced writer that uses JS setTimeout for debouncing
 * and Effect.runPromise to execute save effects when timers fire.
 *
 * This design allows debounce timers to survive across individual Effect.runPromise
 * calls, which is necessary because each CRUD call may be run in its own runtime.
 */
interface PersistenceTrigger {
	/** Schedule a debounced save for the given key */
	readonly schedule: (key: string) => void
	/** Flush all pending writes immediately */
	readonly flush: () => Promise<void>
	/** Number of pending writes */
	readonly pendingCount: () => number
	/** Cancel all pending timers without executing saves */
	readonly shutdown: () => void
}

const createPersistenceTrigger = (
	delayMs: number,
	makeSaveEffect: (key: string) => Effect.Effect<void, unknown>,
): PersistenceTrigger => {
	const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

	const executeSave = (key: string): Promise<void> =>
		Effect.runPromise(
			makeSaveEffect(key).pipe(Effect.catchAll(() => Effect.void)),
		)

	const schedule = (key: string): void => {
		// Cancel existing timer for this key
		const existing = pendingTimers.get(key)
		if (existing !== undefined) {
			clearTimeout(existing)
		}
		// Schedule new debounced write
		const timer = setTimeout(() => {
			pendingTimers.delete(key)
			executeSave(key)
		}, delayMs)
		pendingTimers.set(key, timer)
	}

	const flush = async (): Promise<void> => {
		// Take all pending keys, clear timers, execute saves
		const keys = Array.from(pendingTimers.keys())
		for (const [, timer] of pendingTimers) {
			clearTimeout(timer)
		}
		pendingTimers.clear()
		// Execute all saves
		await Promise.all(keys.map((key) => executeSave(key)))
	}

	const pendingCount = (): number => pendingTimers.size

	const shutdown = (): void => {
		for (const [, timer] of pendingTimers) {
			clearTimeout(timer)
		}
		pendingTimers.clear()
	}

	return { schedule, flush, pendingCount, shutdown }
}

/**
 * Internal ref map type used for cross-collection references.
 */
type StateRefs = Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>

// ============================================================================
// Extract Populate Config from Object-based Select
// ============================================================================

/**
 * Normalize select config for lazy skip optimization.
 * Returns the select config as a Record if it's object-based, or undefined if it's array-based.
 * The lazy skip optimization only works with object-based select.
 */
function normalizeSelectForLazySkip(
	select: Record<string, unknown> | ReadonlyArray<string> | undefined,
): Record<string, unknown> | undefined {
	if (select === undefined || Array.isArray(select)) {
		// Array-based select or undefined: fall back to full resolution
		// (undefined means select all, which includes computed fields)
		// (array-based select is rare and we don't optimize for it)
		return undefined
	}
	return select
}

function extractPopulateFromSelect(
	select: Record<string, unknown>,
	relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }>,
): Record<string, unknown> | undefined {
	const populate: Record<string, unknown> = {}
	let hasPopulate = false

	for (const [key, value] of Object.entries(select)) {
		if (key in relationships) {
			if (value === true) {
				populate[key] = true
				hasPopulate = true
			} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				populate[key] = { select: value, ...value as Record<string, unknown> }
				hasPopulate = true
			}
		}
	}

	return hasPopulate ? populate : undefined
}

// ============================================================================
// Collection Factory
// ============================================================================

/**
 * Build a single Effect-based collection from its config, Ref, and shared state refs.
 *
 * When `afterMutation` is provided, each CRUD method will fork a fire-and-forget
 * call to it after a successful mutation. This is used to trigger debounced saves.
 *
 * When `indexes` is provided, CRUD operations will maintain the indexes and
 * query operations will use indexes for accelerated lookups.
 */
const buildCollection = <T extends HasId>(
	collectionName: string,
	collectionConfig: CollectionConfig,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: StateRefs,
	dbConfig: DatabaseConfig,
	afterMutation?: () => Effect.Effect<void>,
	indexes?: CollectionIndexes,
): EffectCollection<T> => {
	const schema = collectionConfig.schema as Schema.Schema<T, unknown>
	const relationships = collectionConfig.relationships as Record<
		string,
		{ readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }
	>
	// Default to empty hooks (no-op) when not configured
	const hooks = (collectionConfig.hooks ?? {}) as import("../types/hook-types.js").HooksConfig<T>
	// Normalize unique fields constraints (default to empty array if not configured)
	const uniqueFields = normalizeConstraints(collectionConfig.uniqueFields)
	// Get computed fields config (undefined means no computed fields)
	const computed = collectionConfig.computed

	// Build allRelationships map for delete (needs all collections' relationships)
	const allRelationships: Record<
		string,
		Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }>
	> = {}
	for (const [name, config] of Object.entries(dbConfig)) {
		allRelationships[name] = config.relationships
	}

	// Query function: read Ref snapshot → Stream pipeline
	// Returns RunnableStream for standard queries, RunnableCursorPage for cursor pagination
	const queryFn = (
		options?: {
			readonly where?: Record<string, unknown>
			readonly populate?: Record<string, unknown>
			readonly sort?: Record<string, "asc" | "desc">
			readonly select?: Record<string, unknown> | ReadonlyArray<string>
			readonly limit?: number
			readonly offset?: number
			readonly cursor?: CursorConfig
		},
	): RunnableStream<Record<string, unknown>, DanglingReferenceError | ValidationError> | RunnableCursorPage<Record<string, unknown>, DanglingReferenceError | ValidationError> => {
		// Determine populate config: explicit populate or extract from object-based select
		let populateConfig = options?.populate
		if (
			!populateConfig &&
			options?.select &&
			!Array.isArray(options.select)
		) {
			populateConfig = extractPopulateFromSelect(
				options.select as Record<string, unknown>,
				relationships,
			)
		}

		// Handle cursor pagination: validate and inject implicit sort if needed
		const cursorConfig = options?.cursor
		let effectiveSort = options?.sort

		if (cursorConfig) {
			const cursorKey = cursorConfig.key

			if (options?.sort) {
				// Explicit sort provided: validate cursor key matches primary sort field
				const sortKeys = Object.keys(options.sort)
				if (sortKeys.length === 0) {
					// Empty sort object: inject implicit ascending sort on cursor key
					effectiveSort = { [cursorKey]: "asc" as const }
				} else {
					const primarySortKey = sortKeys[0]
					if (primarySortKey !== cursorKey) {
						// Sort mismatch: return effect that immediately fails
						const errorEffect = Effect.fail(
							new ValidationError({
								message: "Invalid cursor configuration",
								issues: [
									{
										field: "cursor.key",
										message: `cursor key '${cursorKey}' must match primary sort field '${primarySortKey}'`,
									},
								],
							}),
						) as Effect.Effect<CursorPageResult<Record<string, unknown>>, ValidationError, never>
						return withCursorRunPromise(errorEffect)
					}
				}
			} else {
				// No explicit sort: inject implicit ascending sort on cursor key
				effectiveSort = { [cursorKey]: "asc" as const }
			}

			// Cursor pagination branch: populate → resolve computed → filter → sort → applyCursor → select
			const cursorEffect = Effect.gen(function* () {
				const map = yield* Ref.get(ref)
				// Try index-accelerated lookup first
				const narrowed = indexes
					? yield* resolveWithIndex(options?.where, indexes, map)
					: undefined
				const items = (narrowed ?? Array.from(map.values())) as Array<Record<string, unknown>>
				let s: Stream.Stream<Record<string, unknown>, DanglingReferenceError> =
					Stream.fromIterable(items)

				// Apply pipeline stages: populate → resolve computed (with lazy skip) → filter → sort
				s = applyPopulate(
					populateConfig as Record<string, boolean | Record<string, unknown>> | undefined,
					stateRefs as unknown as Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
					dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }> }>,
					collectionName,
				)(s)
				s = resolveComputedStreamWithLazySkip(
					computed,
					normalizeSelectForLazySkip(options?.select),
				)(s)
				s = applyFilter(options?.where)(s)
				s = applySort(effectiveSort)(s)

				// Collect via applyCursor (extracts cursor values from pre-select items)
				const cursorResult = yield* applyCursor(cursorConfig)(s)

				// Apply select to collected items (after cursor extraction)
				const selectedItems = applySelectToArray(
					cursorResult.items,
					options?.select as Record<string, unknown> | ReadonlyArray<string> | undefined,
				)

				// Return CursorPageResult with projected items but original cursor metadata
				return {
					items: selectedItems,
					pageInfo: cursorResult.pageInfo,
				} as CursorPageResult<Record<string, unknown>>
			})

			return withCursorRunPromise(cursorEffect)
		}

		// Standard stream branch: populate → resolve computed → filter → sort → paginate → select
		const stream = Stream.unwrap(
			Effect.gen(function* () {
				const map = yield* Ref.get(ref)
				// Try index-accelerated lookup first
				const narrowed = indexes
					? yield* resolveWithIndex(options?.where, indexes, map)
					: undefined
				const items = (narrowed ?? Array.from(map.values())) as Array<Record<string, unknown>>
				let s: Stream.Stream<Record<string, unknown>, DanglingReferenceError> =
					Stream.fromIterable(items)

				// Apply pipeline stages: populate → resolve computed (with lazy skip) → filter → sort → paginate → select
				s = applyPopulate(
					populateConfig as Record<string, boolean | Record<string, unknown>> | undefined,
					stateRefs as unknown as Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
					dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }> }>,
					collectionName,
				)(s)
				s = resolveComputedStreamWithLazySkip(
					computed,
					normalizeSelectForLazySkip(options?.select),
				)(s)
				s = applyFilter(options?.where)(s)
				// When $search is active and no explicit sort provided, use relevance sort
				const searchConfig = extractSearchConfig(options?.where)
				if (searchConfig && !options?.sort) {
					s = applyRelevanceSort(searchConfig)(s)
				} else {
					s = applySort(effectiveSort)(s)
				}
				s = applyPagination(options?.offset, options?.limit)(s)
				s = applySelect(options?.select as Record<string, unknown> | ReadonlyArray<string> | undefined)(s)

				return s
			}),
		)

		return withStreamRunPromise(stream)
	}

	// Helper to wrap a function so its return value gets .runPromise.
	// When afterMutation is configured, each CRUD method triggers a
	// persistence save schedule after the mutation succeeds (synchronous,
	// non-blocking — the actual save runs in a debounced setTimeout).
	const wrapEffect = <Args extends ReadonlyArray<unknown>, A, E>(
		fn: (...args: Args) => Effect.Effect<A, E, never>,
	) =>
		(...args: Args): RunnableEffect<A, E> => {
			const effect = afterMutation
				? fn(...args).pipe(Effect.tap(() => afterMutation()))
				: fn(...args)
			return withRunPromise(effect)
		}

	// Wire CRUD operations with runPromise convenience
	const createFn = wrapEffect(create(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields, computed))
	const createManyFn = wrapEffect(createMany(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields, computed))
	const updateFn = wrapEffect(update(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields, computed))
	const updateManyFn = wrapEffect(updateMany(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields, computed))
	// Check if schema defines a deletedAt field for soft delete support
	const supportsSoftDelete = "fields" in schema && "deletedAt" in (schema as Record<string, unknown> & { fields: Record<string, unknown> }).fields
	const deleteFn = wrapEffect(del(collectionName, allRelationships, ref, stateRefs, supportsSoftDelete, indexes, hooks))
	const deleteManyFn = wrapEffect(deleteMany(collectionName, allRelationships, ref, stateRefs, supportsSoftDelete, indexes, hooks))
	const upsertFn = wrapEffect(upsert(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields))
	const upsertManyFn = wrapEffect(upsertMany(collectionName, schema, relationships, ref, stateRefs, indexes, hooks, uniqueFields))
	const createWithRelsFn = wrapEffect(createWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>, computed,
	))
	const updateWithRelsFn = wrapEffect(updateWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>, computed,
	))
	const deleteWithRelsFn = wrapEffect(deleteWithRelationships(
		collectionName, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: unknown; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	))
	const deleteManyWithRelsFn = wrapEffect(deleteManyWithRelationships(
		collectionName, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: unknown; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	))

	// findById: O(1) lookup directly from the ReadonlyMap
	const findByIdFn = (id: string): RunnableEffect<T, NotFoundError> => {
		const effect = Effect.gen(function* () {
			const map = yield* Ref.get(ref)
			const entity = map.get(id)
			if (entity === undefined) {
				return yield* new NotFoundError({
					collection: collectionName,
					id,
					message: `Entity with id "${id}" not found in collection "${collectionName}"`,
				})
			}
			return entity
		})
		return withRunPromise(effect)
	}

	// aggregate: read Ref → filter → collect → delegate to aggregate functions
	const aggregateFn = <C extends AggregateConfig>(
		config: C,
	): C extends { readonly groupBy: string | ReadonlyArray<string> }
		? RunnableEffect<GroupedAggregateResult, never>
		: RunnableEffect<AggregateResult, never> => {
		const effect = Effect.gen(function* () {
			// 1. Read Ref snapshot
			const map = yield* Ref.get(ref)
			const items = Array.from(map.values()) as Array<Record<string, unknown>>

			// 2. Create stream and apply filter
			let s: Stream.Stream<Record<string, unknown>, never> = Stream.fromIterable(items)
			s = applyFilter(config.where as Record<string, unknown> | undefined)(s)

			// 3. Collect filtered entities
			const chunk = yield* Stream.runCollect(s)
			const entities = Chunk.toReadonlyArray(chunk)

			// 4. Delegate to appropriate aggregate function based on groupBy presence
			if (isGroupedAggregateConfig(config)) {
				return computeGroupedAggregates(entities, config)
			}
			return computeAggregates(entities, config)
		})

		// Type assertion needed because TypeScript can't infer the conditional return type
		return withRunPromise(effect) as C extends { readonly groupBy: string | ReadonlyArray<string> }
			? RunnableEffect<GroupedAggregateResult, never>
			: RunnableEffect<AggregateResult, never>
	}

	return {
		query: queryFn,
		findById: findByIdFn,
		create: createFn,
		createMany: createManyFn,
		update: updateFn,
		updateMany: updateManyFn,
		delete: deleteFn,
		deleteMany: deleteManyFn,
		upsert: upsertFn,
		upsertMany: upsertManyFn,
		createWithRelationships: createWithRelsFn,
		updateWithRelationships: updateWithRelsFn,
		deleteWithRelationships: deleteWithRelsFn,
		deleteManyWithRelationships: deleteManyWithRelsFn,
		aggregate: aggregateFn,
	}
}

// ============================================================================
// Transaction Collection Factory
// ============================================================================

/**
 * Callback type for building a collection with transaction-aware afterMutation.
 * The afterMutation adds the collection name to the mutation set instead of
 * scheduling a persistence write.
 */
type BuildCollectionForTx = (
	collectionName: string,
	addMutation: (name: string) => void,
) => EffectCollection<HasId>

/**
 * Create a `buildCollectionForTx` callback that mirrors `buildCollection` but
 * accepts a transaction-aware `afterMutation`. The returned callback creates
 * collection accessors that record mutations to the transaction's set instead
 * of triggering persistence writes.
 *
 * Used by `createTransaction` and `$transaction` to provide collection accessors
 * that participate in transaction semantics.
 *
 * @param config - The database configuration
 * @param stateRefs - Shared state refs for cross-collection access
 * @param typedRefs - Typed refs for each collection
 * @param collectionIndexes - Pre-built indexes for each collection
 * @returns A callback matching the BuildCollectionForTx type
 */
const makeBuildCollectionForTx = (
	config: DatabaseConfig,
	stateRefs: StateRefs,
	typedRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	collectionIndexes: Record<string, CollectionIndexes>,
): BuildCollectionForTx => {
	return (collectionName: string, addMutation: (name: string) => void) => {
		// Transaction-aware afterMutation: records mutation instead of scheduling persistence
		const afterMutation = () => Effect.sync(() => addMutation(collectionName))

		return buildCollection(
			collectionName,
			config[collectionName],
			typedRefs[collectionName],
			stateRefs,
			config,
			afterMutation,
			collectionIndexes[collectionName],
		)
	}
}

// ============================================================================
// Database Factory
// ============================================================================

/**
 * Create an Effect-based in-memory database.
 *
 * Accepts a DatabaseConfig and optional initial data (arrays keyed by collection name).
 * Returns an Effect that initializes Ref state for each collection and wires up
 * the query pipeline and CRUD methods.
 *
 * Usage:
 * ```ts
 * const db = yield* createEffectDatabase(config, {
 *   users: [{ id: "1", name: "Alice", age: 30 }],
 *   companies: [{ id: "c1", name: "TechCorp" }],
 * })
 *
 * // Query
 * const results = yield* Stream.runCollect(db.users.query({ where: { age: { $gt: 18 } } }))
 *
 * // CRUD
 * const user = yield* db.users.create({ name: "Bob", age: 25 })
 * ```
 */
export const createEffectDatabase = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: { readonly [K in keyof Config]?: ReadonlyArray<Record<string, unknown>> },
): Effect.Effect<EffectDatabase<Config>, MigrationError> =>
	Effect.gen(function* () {
		// 0. Validate migration registries for all versioned collections at startup
		for (const collectionName of Object.keys(config)) {
			const collectionConfig = config[collectionName]
			if (collectionConfig.version !== undefined) {
				yield* validateMigrationRegistry(
					collectionName,
					collectionConfig.version,
					collectionConfig.migrations ?? [],
				)
			}
		}

		// 1. Create transaction lock for single-writer isolation
		const transactionLock = yield* Ref.make(false)

		// 2. Create Ref for each collection from initial data
		const stateRefs: StateRefs = {}
		const typedRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {}

		for (const collectionName of Object.keys(config)) {
			const items = (initialData?.[collectionName] ?? []) as ReadonlyArray<HasId>
			const map: ReadonlyMap<string, HasId> = new Map(
				items.map((item) => [item.id, item]),
			)
			const ref = yield* Ref.make(map)
			stateRefs[collectionName] = ref
			typedRefs[collectionName] = ref
		}

		// 3. Build indexes for each collection from initial data
		const collectionIndexes: Record<string, CollectionIndexes> = {}

		for (const collectionName of Object.keys(config)) {
			const collectionConfig = config[collectionName]
			const normalizedIndexes = normalizeIndexes(collectionConfig.indexes)
			const items = (initialData?.[collectionName] ?? []) as ReadonlyArray<HasId>
			const indexes = yield* buildIndexes(normalizedIndexes, items)
			collectionIndexes[collectionName] = indexes
		}

		// 4. Build each collection with its Ref, indexes, and shared state refs
		const collections: Record<string, EffectCollection<HasId>> = {}

		for (const collectionName of Object.keys(config)) {
			collections[collectionName] = buildCollection(
				collectionName,
				config[collectionName],
				typedRefs[collectionName],
				stateRefs,
				config,
				undefined, // afterMutation
				collectionIndexes[collectionName],
			)
		}

		// 5. Build transaction support
		const buildCollectionForTx = makeBuildCollectionForTx(
			config,
			stateRefs,
			typedRefs,
			collectionIndexes,
		)

		// Create the $transaction method
		const $transactionMethod = <A, E>(
			fn: (ctx: TransactionContext<EffectDatabase<Config>>) => Effect.Effect<A, E>,
		): Effect.Effect<A, E | TransactionError> =>
			$transactionImpl(
				stateRefs,
				transactionLock,
				buildCollectionForTx,
				undefined, // no persistence trigger for in-memory database
				fn as unknown as (ctx: TransactionContext<Record<string, EffectCollection<HasId>>>) => Effect.Effect<A, E>,
			)

		// Return database with $transaction method
		return Object.assign(collections, {
			$transaction: $transactionMethod,
		}) as unknown as EffectDatabase<Config> & {
			$transaction<A, E>(
				fn: (ctx: TransactionContext<EffectDatabase<Config>>) => Effect.Effect<A, E>,
			): Effect.Effect<A, E | TransactionError>
		}
	})

/**
 * Create an Effect-based in-memory database with persistence.
 *
 * Like `createEffectDatabase`, but additionally wires debounced persistence hooks
 * so that each CRUD mutation triggers a fire-and-forget save to disk.
 *
 * Collections with a `file` field in their config are persisted. Collections
 * without a `file` are in-memory only.
 *
 * Requires `StorageAdapter` and `SerializerRegistry` services in the environment.
 *
 * Usage:
 * ```ts
 * const db = yield* createPersistentEffectDatabase(config, initialData, { writeDebounce: 200 })
 * // CRUD mutations now trigger debounced saves
 * yield* db.users.create({ name: "Alice", age: 30 })
 * // Flush all pending writes before shutdown
 * yield* db.flush()
 * ```
 */
export const createPersistentEffectDatabase = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: { readonly [K in keyof Config]?: ReadonlyArray<Record<string, unknown>> },
	persistenceConfig?: EffectDatabasePersistenceConfig,
): Effect.Effect<
	EffectDatabaseWithPersistence<Config>,
	MigrationError | StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | Scope.Scope
> =>
	Effect.gen(function* () {
		// 0. Validate migration registries for all versioned collections at startup
		for (const collectionName of Object.keys(config)) {
			const collectionConfig = config[collectionName]
			if (collectionConfig.version !== undefined) {
				yield* validateMigrationRegistry(
					collectionName,
					collectionConfig.version,
					collectionConfig.migrations ?? [],
				)
			}
		}

		// 1. Resolve services from the environment and capture as a Layer
		// so save effects can be executed outside the creation runtime.
		const storageAdapter = yield* StorageAdapter
		const serializerRegistry = yield* SerializerRegistry
		const serviceLayer = Layer.merge(
			Layer.succeed(StorageAdapter, storageAdapter),
			Layer.succeed(SerializerRegistry, serializerRegistry),
		)

		// 2. Create transaction lock for single-writer isolation
		const transactionLock = yield* Ref.make(false)

		// 3. Load data from files for persistent collections, then merge with initialData.
		// initialData takes precedence (allows overriding file data for testing/seeding).
		const stateRefs: StateRefs = {}
		const typedRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {}

		for (const collectionName of Object.keys(config)) {
			const collectionConfig = config[collectionName]
			const filePath = collectionConfig.file

			// Load from file if configured, passing version and migrations for auto-migration
			let loadedData: ReadonlyMap<string, HasId> = new Map()
			if (filePath) {
				// Only pass version options when collection is versioned
				// Build options object conditionally to satisfy exactOptionalPropertyTypes
				const loadOptions =
					collectionConfig.version !== undefined
						? collectionConfig.migrations !== undefined
							? {
									version: collectionConfig.version,
									migrations: collectionConfig.migrations,
									collectionName,
								}
							: { version: collectionConfig.version, collectionName }
						: undefined
				loadedData = yield* loadData(
					filePath,
					collectionConfig.schema as Schema.Schema<HasId, unknown>,
					loadOptions,
				)
			}

			// Merge with initialData (initialData takes precedence)
			const providedItems = (initialData?.[collectionName] ?? []) as ReadonlyArray<HasId>
			const mergedMap = new Map(loadedData)
			for (const item of providedItems) {
				mergedMap.set(item.id, item)
			}

			const ref = yield* Ref.make(mergedMap as ReadonlyMap<string, HasId>)
			stateRefs[collectionName] = ref
			typedRefs[collectionName] = ref
		}

		// 4. Build indexes for each collection from loaded/merged data
		const collectionIndexes: Record<string, CollectionIndexes> = {}

		for (const collectionName of Object.keys(config)) {
			const collectionConfig = config[collectionName]
			const normalizedIndexes = normalizeIndexes(collectionConfig.indexes)
			// Use actual data from the Ref (loaded from file + initialData)
			const dataMap = yield* Ref.get(typedRefs[collectionName])
			const items = Array.from(dataMap.values()) as ReadonlyArray<HasId>
			const indexes = yield* buildIndexes(normalizedIndexes, items)
			collectionIndexes[collectionName] = indexes
		}

		// 5. Build the save effect factory. Each save reads the Ref at execution
		// time (capturing latest state) and writes through saveData with services.
		const collectionFilePaths: Record<string, string> = {}
		for (const collectionName of Object.keys(config)) {
			const filePath = config[collectionName].file
			if (filePath) {
				collectionFilePaths[collectionName] = filePath
			}
		}

		const makeSaveEffect = (collectionName: string): Effect.Effect<void, unknown> => {
			const filePath = collectionFilePaths[collectionName]
			if (!filePath) return Effect.void
			const collectionConfig = config[collectionName]
			return Effect.provide(
				Effect.gen(function* () {
					const currentData = yield* Ref.get(typedRefs[collectionName])
					yield* saveData(
						filePath,
						collectionConfig.schema as Schema.Schema<HasId, unknown>,
						currentData,
						// Pass version option to stamp _version in output for versioned collections
						collectionConfig.version !== undefined
							? { version: collectionConfig.version }
							: undefined,
					)
				}),
				serviceLayer,
			)
		}

		// 6. Create the runtime-independent persistence trigger
		const trigger = createPersistenceTrigger(
			persistenceConfig?.writeDebounce ?? 100,
			makeSaveEffect,
		)

		// 7. Register scope finalizer: flush pending writes and shut down timers
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => trigger.flush()).pipe(
				Effect.catchAll(() => Effect.void),
				Effect.tap(() => Effect.sync(() => trigger.shutdown())),
			),
		)

		// 8. Build each collection with its Ref, indexes, state refs, and persistence hooks
		const collections: Record<string, EffectCollection<HasId>> = {}

		for (const collectionName of Object.keys(config)) {
			const filePath = config[collectionName].file

			// afterMutation: schedule a debounced save (fire-and-forget), but only if
			// no transaction is active. When a transaction is active, the transaction's
			// own afterMutation handles mutation tracking and persistence is deferred
			// until commit. This handles the edge case where non-tx CRUD methods are
			// called during a transaction.
			const afterMutation = filePath
				? () =>
						Ref.get(transactionLock).pipe(
							Effect.flatMap((isLocked) =>
								isLocked
									? Effect.void // Skip persistence during transactions
									: Effect.sync(() => trigger.schedule(collectionName)),
							),
						)
				: undefined

			collections[collectionName] = buildCollection(
				collectionName,
				config[collectionName],
				typedRefs[collectionName],
				stateRefs,
				config,
				afterMutation,
				collectionIndexes[collectionName],
			)
		}

		const db = collections as unknown as EffectDatabase<Config>

		// Build the $dryRunMigrations method
		const dryRunMigrationsFn = (): RunnableEffect<
			DryRunResult,
			MigrationError | StorageError | SerializationError | UnsupportedFormatError
		> => {
			const effect = Effect.provide(
				dryRunMigrations(config, stateRefs),
				serviceLayer,
			)
			return withRunPromise(effect)
		}

		// Build transaction support
		const buildCollectionForTx = makeBuildCollectionForTx(
			config,
			stateRefs,
			typedRefs,
			collectionIndexes,
		)

		// Create the $transaction method with persistence trigger
		const $transactionMethod = <A, E>(
			fn: (ctx: TransactionContext<EffectDatabase<Config>>) => Effect.Effect<A, E>,
		): Effect.Effect<A, E | TransactionError> =>
			$transactionImpl(
				stateRefs,
				transactionLock,
				buildCollectionForTx,
				trigger, // persistence trigger for debounced saves on commit
				fn as unknown as (ctx: TransactionContext<Record<string, EffectCollection<HasId>>>) => Effect.Effect<A, E>,
			)

		return Object.assign(db, {
			flush: () => trigger.flush(),
			pendingCount: () => trigger.pendingCount(),
			$dryRunMigrations: dryRunMigrationsFn,
			$transaction: $transactionMethod,
		}) as EffectDatabaseWithPersistence<Config>
	})
