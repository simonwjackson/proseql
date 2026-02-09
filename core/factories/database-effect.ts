/**
 * Effect-based database factory.
 *
 * Creates an in-memory database with typed collections, each backed by
 * Ref<ReadonlyMap<string, T>> for O(1) ID lookup and atomic state updates.
 *
 * Query pipeline: Ref snapshot → Stream.fromIterable → filter → populate → sort → paginate → select
 * CRUD: Effect-based operations with typed error channels
 */

import { Effect, Ref, Stream, Schema } from "effect"
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
import { applySelect } from "../operations/query/select-stream.js"
import { applyPagination } from "../operations/query/paginate-stream.js"
import { applyPopulate } from "../operations/relationships/populate-stream.js"
import type { DanglingReferenceError } from "../errors/query-errors.js"
import type {
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	OperationError,
} from "../errors/crud-errors.js"

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

/**
 * Shape of a single Effect-based collection.
 * Query returns a Stream, CRUD methods return Effects.
 */
export interface EffectCollection<T extends HasId> {
	readonly query: (options?: {
		readonly where?: Record<string, unknown>
		readonly populate?: Record<string, unknown>
		readonly sort?: Record<string, "asc" | "desc">
		readonly select?: Record<string, unknown> | ReadonlyArray<string>
		readonly limit?: number
		readonly offset?: number
	}) => Stream.Stream<Record<string, unknown>, DanglingReferenceError>

	readonly create: (
		input: CreateInput<T>,
	) => Effect.Effect<T, ValidationError | DuplicateKeyError | ForeignKeyError>
	readonly createMany: (
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	) => Effect.Effect<
		CreateManyResult<T>,
		ValidationError | DuplicateKeyError | ForeignKeyError
	>

	readonly update: (
		id: string,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => Effect.Effect<T, ValidationError | NotFoundError | ForeignKeyError>
	readonly updateMany: (
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => Effect.Effect<UpdateManyResult<T>, ValidationError | ForeignKeyError>

	readonly delete: (
		id: string,
		options?: { readonly soft?: boolean },
	) => Effect.Effect<T, NotFoundError | OperationError | ForeignKeyError>
	readonly deleteMany: (
		predicate: (entity: T) => boolean,
		options?: { readonly soft?: boolean; readonly limit?: number },
	) => Effect.Effect<
		DeleteManyResult<T>,
		OperationError | ForeignKeyError
	>

	readonly upsert: (
		input: UpsertInput<T>,
	) => Effect.Effect<UpsertResult<T>, ValidationError | ForeignKeyError>
	readonly upsertMany: (
		inputs: ReadonlyArray<UpsertInput<T>>,
	) => Effect.Effect<UpsertManyResult<T>, ValidationError | ForeignKeyError>

	readonly createWithRelationships: (
		input: CreateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => Effect.Effect<
		T,
		ValidationError | ForeignKeyError | OperationError
	>
	readonly updateWithRelationships: (
		id: string,
		input: UpdateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => Effect.Effect<
		T,
		ValidationError | NotFoundError | ForeignKeyError | OperationError
	>
	readonly deleteWithRelationships: (
		id: string,
		options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>>,
	) => Effect.Effect<
		DeleteWithRelationshipsResult<T>,
		NotFoundError | ValidationError | OperationError
	>
	readonly deleteManyWithRelationships: (
		predicate: (entity: T) => boolean,
		options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>> & {
			readonly limit?: number
		},
	) => Effect.Effect<
		{
			readonly count: number
			readonly deleted: ReadonlyArray<T>
			readonly cascaded?: Record<string, { readonly count: number; readonly ids: ReadonlyArray<string> }>
		},
		ValidationError | OperationError
	>
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
 */
const buildCollection = <T extends HasId>(
	collectionName: string,
	collectionConfig: CollectionConfig,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: StateRefs,
	dbConfig: DatabaseConfig,
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
	const queryFn = (
		options?: {
			readonly where?: Record<string, unknown>
			readonly populate?: Record<string, unknown>
			readonly sort?: Record<string, "asc" | "desc">
			readonly select?: Record<string, unknown> | ReadonlyArray<string>
			readonly limit?: number
			readonly offset?: number
		},
	): Stream.Stream<Record<string, unknown>, DanglingReferenceError> => {
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

		return Stream.unwrap(
			Effect.gen(function* () {
				const map = yield* Ref.get(ref)
				const items = Array.from(map.values()) as Array<Record<string, unknown>>
				let stream: Stream.Stream<Record<string, unknown>, DanglingReferenceError> =
					Stream.fromIterable(items)

				// Apply pipeline stages
				stream = applyFilter(options?.where)(stream)
				stream = applyPopulate(
					populateConfig as Record<string, boolean | Record<string, unknown>> | undefined,
					stateRefs as Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
					dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string }> }>,
					collectionName,
				)(stream)
				stream = applySort(options?.sort)(stream)
				stream = applyPagination(options?.offset, options?.limit)(stream)
				stream = applySelect(options?.select as Record<string, unknown> | ReadonlyArray<string> | undefined)(stream)

				return stream
			}),
		)
	}

	// Wire CRUD operations
	const createFn = create(collectionName, schema, relationships, ref, stateRefs)
	const createManyFn = createMany(collectionName, schema, relationships, ref, stateRefs)
	const updateFn = update(collectionName, schema, relationships, ref, stateRefs)
	const updateManyFn = updateMany(collectionName, schema, relationships, ref, stateRefs)
	const deleteFn = del(collectionName, allRelationships, ref, stateRefs)
	const deleteManyFn = deleteMany(collectionName, allRelationships, ref, stateRefs)
	const upsertFn = upsert(collectionName, schema, relationships, ref, stateRefs)
	const upsertManyFn = upsertMany(collectionName, schema, relationships, ref, stateRefs)
	const createWithRelsFn = createWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	)
	const updateWithRelsFn = updateWithRelationships(
		collectionName, schema, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: Schema.Schema<HasId, unknown>; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	)
	const deleteWithRelsFn = deleteWithRelationships(
		collectionName, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: unknown; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	)
	const deleteManyWithRelsFn = deleteManyWithRelationships(
		collectionName, relationships, ref, stateRefs, dbConfig as Record<string, { readonly schema: unknown; readonly relationships: Record<string, { readonly type: "ref" | "inverse"; readonly target?: string; readonly __targetCollection?: string; readonly foreignKey?: string }> }>,
	)

	return {
		query: queryFn,
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
