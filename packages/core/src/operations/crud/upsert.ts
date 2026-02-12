/**
 * Effect-based upsert operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors (ValidationError, ForeignKeyError).
 *
 * Upsert = find by `where` clause → update if exists, create if not.
 */

import { Effect, PubSub, Ref, type Schema } from "effect";
import type {
	ForeignKeyError,
	HookError,
	UniqueConstraintError,
	ValidationError,
} from "../../errors/crud-errors.js";
import {
	runAfterCreateHooks,
	runAfterUpdateHooks,
	runBeforeCreateHooks,
	runBeforeUpdateHooks,
	runOnChangeHooks,
} from "../../hooks/hook-runner.js";
import {
	addManyToIndex,
	addToIndex,
	updateInIndex,
} from "../../indexes/index-manager.js";
import {
	addToSearchIndex,
	updateInSearchIndex,
} from "../../indexes/search-index.js";
import type {
	MinimalEntity,
	UpdateWithOperators,
	UpsertInternalInput,
	UpsertManyResult,
	UpsertResult,
} from "../../types/crud-types.js";
import type { HooksConfig } from "../../types/hook-types.js";
import type { CollectionIndexes } from "../../types/index-types.js";
import type { ChangeEvent } from "../../types/reactive-types.js";
import type { SearchIndexMap } from "../../types/search-types.js";
import { generateId } from "../../utils/id-generator.js";
import { validateForeignKeysEffect } from "../../validators/foreign-key.js";
import { validateEntity } from "../../validators/schema-validator.js";
import {
	checkBatchUniqueConstraints,
	checkUniqueConstraints,
	type NormalizedConstraints,
	validateUpsertWhere,
} from "./unique-check.js";
import { applyUpdates } from "./update.js";

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string };

type RelationshipConfig = {
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey?: string;
};

// ============================================================================
// Find by Where Clause
// ============================================================================

/**
 * Find an entity in a ReadonlyMap matching all fields in the where clause.
 * If `where` contains `id`, uses O(1) lookup. Otherwise scans all values.
 */
const findByWhere = <T extends HasId>(
	map: ReadonlyMap<string, T>,
	where: Record<string, unknown>,
): T | undefined => {
	// Fast path: if where has `id`, use direct lookup
	if ("id" in where && typeof where.id === "string") {
		const candidate = map.get(where.id);
		if (candidate === undefined) return undefined;
		// Verify all other where fields match
		for (const [key, value] of Object.entries(where)) {
			if ((candidate as Record<string, unknown>)[key] !== value) {
				return undefined;
			}
		}
		return candidate;
	}

	// Slow path: scan all entities
	for (const entity of map.values()) {
		let matches = true;
		for (const [key, value] of Object.entries(where)) {
			if ((entity as Record<string, unknown>)[key] !== value) {
				matches = false;
				break;
			}
		}
		if (matches) return entity;
	}

	return undefined;
};

// ============================================================================
// Upsert Single Entity
// ============================================================================

/**
 * Upsert a single entity: find by `where`, update if exists, create if not.
 *
 * Steps:
 * 1. Look up entity by where clause in Ref state
 * 2a. If found: run beforeUpdate hooks, apply update operators, validate, update in state, run afterUpdate/onChange
 * 2b. If not found: merge where + create data, generate ID/timestamps, validate, run beforeCreate hooks, add to state, run afterCreate/onChange
 * 3. Validate foreign key constraints
 * 4. Return entity with __action metadata
 */
export const upsert =
	<T extends HasId, I = T>(
		collectionName: string,
		schema: Schema.Schema<T, I>,
		relationships: Record<string, RelationshipConfig>,
		ref: Ref.Ref<ReadonlyMap<string, T>>,
		stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
		indexes?: CollectionIndexes,
		hooks?: HooksConfig<T>,
		uniqueFields: NormalizedConstraints = [],
		searchIndexRef?: Ref.Ref<SearchIndexMap>,
		searchIndexFields?: ReadonlyArray<string>,
		changePubSub?: PubSub.PubSub<ChangeEvent>,
	) =>
	(
		input: UpsertInternalInput<T>,
	): Effect.Effect<
		UpsertResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	> =>
		Effect.gen(function* () {
			const where = input.where as Record<string, unknown>;

			// Validate that the where clause targets a unique field or id
			yield* validateUpsertWhere(where, uniqueFields, collectionName);

			const currentMap = yield* Ref.get(ref);
			const existing = findByWhere(currentMap, where);

			if (existing !== undefined) {
				// === UPDATE PATH ===
				// Run beforeUpdate hooks (can transform the update payload)
				const transformedUpdates = yield* runBeforeUpdateHooks(
					hooks?.beforeUpdate,
					{
						operation: "update",
						collection: collectionName,
						id: existing.id,
						existing,
						update: input.update as UpdateWithOperators<T>,
					},
				);

				const updated = applyUpdates(
					existing as T & MinimalEntity,
					transformedUpdates as UpdateWithOperators<T & MinimalEntity>,
				);

				// Validate through Effect Schema
				const validated = yield* validateEntity(schema, updated);

				// Validate foreign keys if relationship fields were updated
				const relationshipFields = Object.keys(relationships).map(
					(field) => relationships[field].foreignKey || `${field}Id`,
				);
				const hasRelationshipUpdate = Object.keys(transformedUpdates).some(
					(key) => relationshipFields.includes(key),
				);

				if (hasRelationshipUpdate) {
					yield* validateForeignKeysEffect(
						validated,
						collectionName,
						relationships,
						stateRefs,
					);
				}

				// Atomically update in state
				yield* Ref.update(ref, (map) => {
					const next = new Map(map);
					next.set(existing.id, validated);
					return next;
				});

				// Update indexes if provided
				if (indexes && indexes.size > 0) {
					yield* updateInIndex(indexes, existing, validated);
				}

				// Update search index if configured
				if (
					searchIndexRef &&
					searchIndexFields &&
					searchIndexFields.length > 0
				) {
					yield* updateInSearchIndex(
						searchIndexRef,
						existing,
						validated,
						searchIndexFields,
					);
				}

				// Run afterUpdate hooks (fire-and-forget, errors swallowed)
				yield* runAfterUpdateHooks(hooks?.afterUpdate, {
					operation: "update",
					collection: collectionName,
					id: existing.id,
					previous: existing,
					current: validated,
					update: transformedUpdates,
				});

				// Run onChange hooks with type: "update" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "update",
					collection: collectionName,
					id: existing.id,
					previous: existing,
					current: validated,
				});

				// Publish change event to reactive subscribers
				if (changePubSub) {
					yield* PubSub.publish(changePubSub, {
						collection: collectionName,
						operation: "update",
					});
				}

				return { ...validated, __action: "updated" as const };
			}

			// === CREATE PATH ===
			const id =
				(typeof where.id === "string" ? where.id : undefined) || generateId();
			const now = new Date().toISOString();

			const createData = {
				...where,
				...input.create,
				id,
				createdAt: now,
				updatedAt: now,
			};

			// Validate through Effect Schema
			const validated = yield* validateEntity(schema, createData);

			// Run beforeCreate hooks (can transform the entity)
			const entity = yield* runBeforeCreateHooks(hooks?.beforeCreate, {
				operation: "create",
				collection: collectionName,
				data: validated,
			});

			// Check unique constraints
			yield* checkUniqueConstraints(
				entity,
				currentMap,
				uniqueFields,
				collectionName,
			);

			// Validate foreign keys
			yield* validateForeignKeysEffect(
				entity,
				collectionName,
				relationships,
				stateRefs,
			);

			// Atomically add to state
			yield* Ref.update(ref, (map) => {
				const next = new Map(map);
				next.set(id, entity);
				return next;
			});

			// Update indexes if provided
			if (indexes && indexes.size > 0) {
				yield* addToIndex(indexes, entity);
			}

			// Update search index if configured
			if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
				yield* addToSearchIndex(searchIndexRef, entity, searchIndexFields);
			}

			// Run afterCreate hooks (fire-and-forget, errors swallowed)
			yield* runAfterCreateHooks(hooks?.afterCreate, {
				operation: "create",
				collection: collectionName,
				entity,
			});

			// Run onChange hooks with type: "create" (fire-and-forget, errors swallowed)
			yield* runOnChangeHooks(hooks?.onChange, {
				type: "create",
				collection: collectionName,
				entity,
			});

			// Publish change event to reactive subscribers
			if (changePubSub) {
				yield* PubSub.publish(changePubSub, {
					collection: collectionName,
					operation: "create",
				});
			}

			return { ...entity, __action: "created" as const };
		});

// ============================================================================
// Upsert Multiple Entities
// ============================================================================

/**
 * Upsert multiple entities efficiently.
 *
 * For each input:
 * - If entity matches where clause: apply updates (or skip if unchanged)
 * - If no match: create new entity
 *
 * All changes validated and applied atomically.
 * Returns categorized results: created, updated, unchanged.
 *
 * Runs hooks per entity:
 * - Create path: beforeCreate → mutation → afterCreate → onChange("create")
 * - Update path: beforeUpdate → mutation → afterUpdate → onChange("update")
 */
export const upsertMany =
	<T extends HasId, I = T>(
		collectionName: string,
		schema: Schema.Schema<T, I>,
		relationships: Record<string, RelationshipConfig>,
		ref: Ref.Ref<ReadonlyMap<string, T>>,
		stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
		indexes?: CollectionIndexes,
		hooks?: HooksConfig<T>,
		uniqueFields: NormalizedConstraints = [],
		searchIndexRef?: Ref.Ref<SearchIndexMap>,
		searchIndexFields?: ReadonlyArray<string>,
		changePubSub?: PubSub.PubSub<ChangeEvent>,
	) =>
	(
		inputs: ReadonlyArray<UpsertInternalInput<T>>,
	): Effect.Effect<
		UpsertManyResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	> =>
		Effect.gen(function* () {
			// Validate all where clauses target unique fields or id
			for (const input of inputs) {
				const where = input.where as Record<string, unknown>;
				yield* validateUpsertWhere(where, uniqueFields, collectionName);
			}

			const currentMap = yield* Ref.get(ref);
			const created: T[] = [];
			const updated: T[] = [];
			const unchanged: T[] = [];
			const now = new Date().toISOString();

			// Phase 1: Process all inputs, validate, run before-hooks, and categorize
			const toCreate: T[] = [];
			const toUpdate: Array<{
				oldEntity: T;
				newEntity: T;
				transformedUpdates: UpdateWithOperators<T>;
			}> = [];

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				if (!input) continue;
				const where = input.where as Record<string, unknown>;
				const existing = findByWhere(currentMap, where);

				if (existing !== undefined) {
					// === UPDATE PATH ===
					// Check if update would change anything
					const wouldChange = Object.keys(input.update).some((key) => {
						const updateValue = (input.update as Record<string, unknown>)[key];
						const currentValue = (existing as Record<string, unknown>)[key];

						// Operator-based updates always cause a change
						if (
							typeof updateValue === "object" &&
							updateValue !== null &&
							!Array.isArray(updateValue)
						) {
							return true;
						}

						return updateValue !== currentValue;
					});

					if (!wouldChange) {
						unchanged.push(existing);
						continue;
					}

					// Run beforeUpdate hooks (can transform the update payload)
					const transformedUpdates = yield* runBeforeUpdateHooks(
						hooks?.beforeUpdate,
						{
							operation: "update",
							collection: collectionName,
							id: existing.id,
							existing,
							update: input.update as UpdateWithOperators<T>,
						},
					);

					// Apply updates with (possibly transformed) payload
					const updatedEntity = applyUpdates(
						existing as T & MinimalEntity,
						transformedUpdates as UpdateWithOperators<T & MinimalEntity>,
					);

					// Validate
					const validated = yield* validateEntity(schema, updatedEntity);
					toUpdate.push({
						oldEntity: existing,
						newEntity: validated,
						transformedUpdates,
					});
				} else {
					// === CREATE PATH ===
					const id =
						(typeof where.id === "string" ? where.id : undefined) ||
						generateId();

					const createData = {
						...where,
						...input.create,
						id,
						createdAt: now,
						updatedAt: now,
					};

					// Validate through schema first
					const validated = yield* validateEntity(schema, createData);

					// Run beforeCreate hooks (can transform the entity)
					const entity = yield* runBeforeCreateHooks(hooks?.beforeCreate, {
						operation: "create",
						collection: collectionName,
						data: validated,
					});

					toCreate.push(entity);
				}
			}

			// Phase 2: Check unique constraints for entities being created
			// This checks against existing data and also inter-batch conflicts
			if (toCreate.length > 0) {
				yield* checkBatchUniqueConstraints(
					toCreate,
					currentMap,
					uniqueFields,
					collectionName,
				);
			}

			// Phase 3: Validate foreign keys for all entities being created or updated
			for (const entity of toCreate) {
				yield* validateForeignKeysEffect(
					entity,
					collectionName,
					relationships,
					stateRefs,
				);
			}
			for (const { newEntity } of toUpdate) {
				yield* validateForeignKeysEffect(
					newEntity,
					collectionName,
					relationships,
					stateRefs,
				);
			}

			// Phase 4: Atomically apply all changes to state
			if (toCreate.length > 0 || toUpdate.length > 0) {
				yield* Ref.update(ref, (map) => {
					const next = new Map(map);
					for (const entity of toCreate) {
						next.set(entity.id, entity);
					}
					for (const { newEntity } of toUpdate) {
						next.set(newEntity.id, newEntity);
					}
					return next;
				});
			}

			// Phase 5: Update indexes if provided
			if (indexes && indexes.size > 0) {
				// Use batch operation for created entities
				if (toCreate.length > 0) {
					yield* addManyToIndex(indexes, toCreate);
				}
				// Update indexes for updated entities
				for (const { oldEntity, newEntity } of toUpdate) {
					yield* updateInIndex(indexes, oldEntity, newEntity);
				}
			}

			// Update search index if configured
			if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
				// Add created entities to search index
				for (const entity of toCreate) {
					yield* addToSearchIndex(searchIndexRef, entity, searchIndexFields);
				}
				// Update search index for updated entities
				for (const { oldEntity, newEntity } of toUpdate) {
					yield* updateInSearchIndex(
						searchIndexRef,
						oldEntity,
						newEntity,
						searchIndexFields,
					);
				}
			}

			// Phase 6: Run after-hooks and onChange hooks for created entities
			for (const entity of toCreate) {
				// Run afterCreate hooks (fire-and-forget, errors swallowed)
				yield* runAfterCreateHooks(hooks?.afterCreate, {
					operation: "create",
					collection: collectionName,
					entity,
				});

				// Run onChange hooks with type: "create" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "create",
					collection: collectionName,
					entity,
				});
			}

			// Phase 7: Run after-hooks and onChange hooks for updated entities
			for (const { oldEntity, newEntity, transformedUpdates } of toUpdate) {
				// Run afterUpdate hooks (fire-and-forget, errors swallowed)
				yield* runAfterUpdateHooks(hooks?.afterUpdate, {
					operation: "update",
					collection: collectionName,
					id: newEntity.id,
					previous: oldEntity,
					current: newEntity,
					update: transformedUpdates,
				});

				// Run onChange hooks with type: "update" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "update",
					collection: collectionName,
					id: newEntity.id,
					previous: oldEntity,
					current: newEntity,
				});
			}

			created.push(...toCreate);
			updated.push(...toUpdate.map(({ newEntity }) => newEntity));

			// Publish change events to reactive subscribers
			// Publish a "create" event if any entities were created
			if (changePubSub && toCreate.length > 0) {
				yield* PubSub.publish(changePubSub, {
					collection: collectionName,
					operation: "create",
				});
			}
			// Publish an "update" event if any entities were updated
			if (changePubSub && toUpdate.length > 0) {
				yield* PubSub.publish(changePubSub, {
					collection: collectionName,
					operation: "update",
				});
			}

			return { created, updated, unchanged };
		});
