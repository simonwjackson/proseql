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
import { createWithRelationships } from "../operations/crud/create-with-relationships.js"
import { updateWithRelationships } from "../operations/crud/update-with-relationships.js"
import {
	deleteWithRelationships,
	deleteManyWithRelationships,
} from "../operations/crud/delete-with-relationships.js"
import { applyFilter } from "../operations/query/filter-stream.js"
import { applySort } from "../operations/query/sort-stream.js"
import { applySelect, applySelectToArray } from "../operations/query/select-stream.js"
import { applyPagination } from "../operations/query/paginate-stream.js"
import { applyPopulate } from "../operations/relationships/populate-stream.js"
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
	type OperationError,
} from "../errors/crud-errors.js"
import type {
	StorageError,
	SerializationError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js"
import { StorageAdapter } from "../storage/storage-service.js"
import { SerializerRegistry } from "../serializers/serializer-service.js"
import { saveData } from "../storage/persistence-effect.js"

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
	) => RunnableEffect<T, ValidationError | DuplicateKeyError | ForeignKeyError>
	readonly createMany: (
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	) => RunnableEffect<
		CreateManyResult<T>,
		ValidationError | DuplicateKeyError | ForeignKeyError
	>

	readonly update: (
		id: string,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<T, ValidationError | NotFoundError | ForeignKeyError>
	readonly updateMany: (
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<UpdateManyResult<T>, ValidationError | ForeignKeyError>

	readonly delete: (
		id: string,
		options?: { readonly soft?: boolean },
	) => RunnableEffect<T, NotFoundError | OperationError | ForeignKeyError>
	readonly deleteMany: (
		predicate: (entity: T) => boolean,
		options?: { readonly soft?: boolean; readonly limit?: number },
	) => RunnableEffect<
		DeleteManyResult<T>,
		OperationError | ForeignKeyError
	>

	readonly upsert: (
		input: UpsertInput<T>,
	) => RunnableEffect<UpsertResult<T>, ValidationError | ForeignKeyError>
	readonly upsertMany: (
		inputs: ReadonlyArray<UpsertInput<T>>,
	) => RunnableEffect<UpsertManyResult<T>, ValidationError | ForeignKeyError>

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
 * Database type: a record of collection names to EffectCollections.
 */
export type EffectDatabase<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: EffectCollection<
		Schema.Schema.Type<Config[K]["schema"]> & HasId
	>
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
 */
const buildCollection = <T extends HasId>(
	collectionName: string,
	collectionConfig: CollectionConfig,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: StateRefs,
	dbConfig: DatabaseConfig,
	afterMutation?: () => Effect.Effect<void>,
): EffectCollection<T> => {
	const schema = collectionConfig.schema as Schema.Schema<T, unknown>
	const relationships = collectionConfig.relationships as Record<
		string,
		{ readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }
	>

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

			// Cursor pagination branch: filter → populate → sort → applyCursor → select
			const cursorEffect = Effect.gen(function* () {
				const map = yield* Ref.get(ref)
				const items = Array.from(map.values()) as Array<Record<string, unknown>>
				let s: Stream.Stream<Record<string, unknown>, DanglingReferenceError> =
					Stream.fromIterable(items)

				// Apply pipeline stages: filter → populate → sort
				s = applyFilter(options?.where)(s)
				s = applyPopulate(
					populateConfig as Record<string, boolean | Record<string, unknown>> | undefined,
					stateRefs as Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
					dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }> }>,
					collectionName,
				)(s)
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

		// Standard stream branch: filter → populate → sort → paginate → select
		const stream = Stream.unwrap(
			Effect.gen(function* () {
				const map = yield* Ref.get(ref)
				const items = Array.from(map.values()) as Array<Record<string, unknown>>
				let s: Stream.Stream<Record<string, unknown>, DanglingReferenceError> =
					Stream.fromIterable(items)

				// Apply pipeline stages
				s = applyFilter(options?.where)(s)
				s = applyPopulate(
					populateConfig as Record<string, boolean | Record<string, unknown>> | undefined,
					stateRefs as Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
					dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }> }>,
					collectionName,
				)(s)
				s = applySort(effectiveSort)(s)
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
	const createFn = wrapEffect(create(collectionName, schema, relationships, ref, stateRefs))
	const createManyFn = wrapEffect(createMany(collectionName, schema, relationships, ref, stateRefs))
	const updateFn = wrapEffect(update(collectionName, schema, relationships, ref, stateRefs))
	const updateManyFn = wrapEffect(updateMany(collectionName, schema, relationships, ref, stateRefs))
	// Check if schema defines a deletedAt field for soft delete support
	const supportsSoftDelete = "fields" in schema && "deletedAt" in (schema as Record<string, unknown> & { fields: Record<string, unknown> }).fields
	const deleteFn = wrapEffect(del(collectionName, allRelationships, ref, stateRefs, supportsSoftDelete))
	const deleteManyFn = wrapEffect(deleteMany(collectionName, allRelationships, ref, stateRefs, supportsSoftDelete))
	const upsertFn = wrapEffect(upsert(collectionName, schema, relationships, ref, stateRefs))
	const upsertManyFn = wrapEffect(upsertMany(collectionName, schema, relationships, ref, stateRefs))
	const createWithRelsFn = wrapEffect(createWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	))
	const updateWithRelsFn = wrapEffect(updateWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
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
): Effect.Effect<EffectDatabase<Config>> =>
	Effect.gen(function* () {
		// 1. Create Ref for each collection from initial data
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

		// 2. Build each collection with its Ref and shared state refs
		const collections: Record<string, EffectCollection<HasId>> = {}

		for (const collectionName of Object.keys(config)) {
			collections[collectionName] = buildCollection(
				collectionName,
				config[collectionName],
				typedRefs[collectionName],
				stateRefs,
				config,
			)
		}

		return collections as EffectDatabase<Config>
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
	never,
	StorageAdapter | SerializerRegistry | Scope.Scope
> =>
	Effect.gen(function* () {
		// 1. Resolve services from the environment and capture as a Layer
		// so save effects can be executed outside the creation runtime.
		const storageAdapter = yield* StorageAdapter
		const serializerRegistry = yield* SerializerRegistry
		const serviceLayer = Layer.merge(
			Layer.succeed(StorageAdapter, storageAdapter),
			Layer.succeed(SerializerRegistry, serializerRegistry),
		)

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

		// 3. Build the save effect factory. Each save reads the Ref at execution
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
					)
				}),
				serviceLayer,
			)
		}

		// 4. Create the runtime-independent persistence trigger
		const trigger = createPersistenceTrigger(
			persistenceConfig?.writeDebounce ?? 100,
			makeSaveEffect,
		)

		// 5. Register scope finalizer: flush pending writes and shut down timers
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => trigger.flush()).pipe(
				Effect.catchAll(() => Effect.void),
				Effect.tap(() => Effect.sync(() => trigger.shutdown())),
			),
		)

		// 6. Build each collection with its Ref, state refs, and persistence hooks
		const collections: Record<string, EffectCollection<HasId>> = {}

		for (const collectionName of Object.keys(config)) {
			const filePath = config[collectionName].file

			// afterMutation: synchronously schedule a debounced save (fire-and-forget)
			const afterMutation = filePath
				? () => Effect.sync(() => trigger.schedule(collectionName))
				: undefined

			collections[collectionName] = buildCollection(
				collectionName,
				config[collectionName],
				typedRefs[collectionName],
				stateRefs,
				config,
				afterMutation,
			)
		}

		const db = collections as EffectDatabase<Config>
		return Object.assign(db, {
			flush: () => trigger.flush(),
			pendingCount: () => trigger.pendingCount(),
		}) as EffectDatabaseWithPersistence<Config>
	})
