import { Effect, Option, Ref } from "effect"
import { NotFoundError } from "../errors/crud-errors.js"

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string }

/**
 * Gets a single entity by ID from a collection Ref.
 * Returns Option.some if found, Option.none if not.
 */
export const getEntity = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	id: string,
): Effect.Effect<Option.Option<T>> =>
	Ref.get(ref).pipe(
		Effect.map((map) => Option.fromNullable(map.get(id))),
	)

/**
 * Gets a single entity by ID, failing with NotFoundError if not present.
 */
export const getEntityOrFail = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	id: string,
	collection: string,
): Effect.Effect<T, NotFoundError> =>
	getEntity(ref, id).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new NotFoundError({
							collection,
							id,
							message: `Entity with id "${id}" not found in collection "${collection}"`,
						}),
					),
				onSome: Effect.succeed,
			}),
		),
	)

/**
 * Gets all entities from a collection Ref as a ReadonlyArray.
 */
export const getAllEntities = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
): Effect.Effect<ReadonlyArray<T>> =>
	Ref.get(ref).pipe(Effect.map((map) => Array.from(map.values())))

/**
 * Sets (creates or replaces) an entity in the collection Ref.
 * The entity is keyed by its `id` field.
 */
export const setEntity = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	entity: T,
): Effect.Effect<void> =>
	Ref.update(ref, (map) => {
		const next = new Map(map)
		next.set(entity.id, entity)
		return next
	})

/**
 * Removes an entity by ID from the collection Ref.
 * Returns true if the entity existed and was removed, false if it was not present.
 */
export const removeEntity = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	id: string,
): Effect.Effect<boolean> =>
	Ref.modify(ref, (map) => {
		if (!map.has(id)) {
			return [false, map]
		}
		const next = new Map(map)
		next.delete(id)
		return [true, next]
	})

/**
 * Atomically updates an entity by ID using an updater function.
 * Returns the updated entity. Fails with NotFoundError if the entity doesn't exist.
 */
export const updateEntity = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	id: string,
	updater: (entity: T) => T,
	collection: string,
): Effect.Effect<T, NotFoundError> =>
	Ref.modify(ref, (map) => {
		const existing = map.get(id)
		if (existing === undefined) {
			return [
				Option.none<T>(),
				map,
			]
		}
		const updated = updater(existing)
		const next = new Map(map)
		next.set(id, updated)
		return [Option.some(updated), next]
	}).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new NotFoundError({
							collection,
							id,
							message: `Entity with id "${id}" not found in collection "${collection}"`,
						}),
					),
				onSome: Effect.succeed,
			}),
		),
	)
