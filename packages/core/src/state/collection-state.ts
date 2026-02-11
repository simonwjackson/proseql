import { type Effect, Ref } from "effect";

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Creates a Ref holding a ReadonlyMap<string, T> from an initial array of entities.
 *
 * Each entity is keyed by its `id` field, giving O(1) lookup by ID.
 * If no initial data is provided, the Ref starts with an empty map.
 *
 * @param initialData - Array of entities to seed the collection state
 * @returns Effect producing a Ref containing a ReadonlyMap keyed by entity ID
 */
export const createCollectionState = <T extends HasId>(
	initialData: ReadonlyArray<T> = [],
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> => {
	const map: ReadonlyMap<string, T> = new Map(
		initialData.map((entity) => [entity.id, entity]),
	);
	return Ref.make(map);
};
