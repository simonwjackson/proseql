import { Effect, Ref, Stream } from "effect";
import type { CollectionConfig } from "../../types/database-config-types.js";

/**
 * PopulateValue can be:
 * - `true` to populate a relationship with all fields
 * - An object with nested populate config (handled in task 7.2)
 */
type PopulateValue = boolean | Record<string, unknown>;

/**
 * Type guard: is value a non-null, non-array object?
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for populate config objects.
 */
function isPopulateConfig(
  value: unknown,
): value is Record<string, PopulateValue> {
  return isRecord(value);
}

/**
 * Derive the foreign key field for an inverse relationship.
 *
 * Priority:
 * 1. Explicit `foreignKey` on the inverse relationship definition
 * 2. Explicit `foreignKey` on the corresponding ref relationship in the target collection
 * 3. Default naming convention: singularize source collection name + "Id"
 */
function resolveInverseForeignKey(
  relationship: { readonly type: "ref" | "inverse"; readonly target: string; readonly foreignKey?: string },
  collectionName: string,
  dbConfig: Record<string, CollectionConfig>,
): string {
  if (relationship.foreignKey) {
    return relationship.foreignKey;
  }

  const targetConfig = dbConfig[relationship.target];
  if (targetConfig) {
    const reverseRel = Object.entries(targetConfig.relationships).find(
      ([, rel]) => rel.type === "ref" && rel.target === collectionName,
    );
    if (reverseRel && reverseRel[1].foreignKey) {
      return reverseRel[1].foreignKey;
    }
  }

  // Default: singularize collection name + "Id"
  const singularName = collectionName.endsWith("ies")
    ? collectionName.slice(0, -3) + "y"
    : collectionName.replace(/s$/, "");
  return singularName + "Id";
}

/**
 * Apply relationship population as a Stream combinator.
 *
 * For each item in the stream, resolves relationships by reading related
 * entities from collection Refs.
 *
 * - `ref` relationships: look up a single entity in the target collection
 *   using the foreign key field (default: `<relationName>Id`)
 * - `inverse` relationships: find all entities in the target collection
 *   whose foreign key points back to this item's `id`
 *
 * @param populateConfig - Which relationships to populate (e.g. `{ company: true }`)
 * @param stateRefs - Map of collection name → Ref<ReadonlyMap<string, entity>>
 * @param dbConfig - Full database config with relationship definitions
 * @param collectionName - Name of the source collection being queried
 */
export const applyPopulate = <T extends Record<string, unknown>>(
  populateConfig: Record<string, PopulateValue> | undefined,
  stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
  dbConfig: Record<string, CollectionConfig>,
  collectionName: string,
) =>
  <E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    if (!populateConfig || !isPopulateConfig(populateConfig)) return stream;

    const sourceConfig = dbConfig[collectionName];
    if (!sourceConfig) return stream;

    const relationships = sourceConfig.relationships;
    const populateEntries = Object.entries(populateConfig).filter(
      ([key]) => relationships[key] !== undefined,
    );

    if (populateEntries.length === 0) return stream;

    return Stream.mapEffect(stream, (item: T) =>
      Effect.gen(function* () {
        const populated: Record<string, unknown> = { ...item };

        for (const [key, value] of populateEntries) {
          const relationship = relationships[key];
          const targetRef = stateRefs[relationship.target];
          if (!targetRef) continue;

          const targetMap = yield* Ref.get(targetRef);

          if (relationship.type === "ref") {
            const foreignKeyField = relationship.foreignKey || key + "Id";
            const foreignKeyValue = (item as Record<string, unknown>)[foreignKeyField];

            if (typeof foreignKeyValue === "string") {
              const related = targetMap.get(foreignKeyValue);
              if (related && (value === true || isRecord(value))) {
                populated[key] = related;
              } else {
                populated[key] = undefined;
              }
            } else {
              populated[key] = undefined;
            }
          } else if (relationship.type === "inverse") {
            const foreignKeyField = resolveInverseForeignKey(
              relationship,
              collectionName,
              dbConfig,
            );

            const relatedItems: Record<string, unknown>[] = [];
            for (const entity of targetMap.values()) {
              if ((entity as Record<string, unknown>)[foreignKeyField] === (item as Record<string, unknown>).id) {
                relatedItems.push(entity as Record<string, unknown>);
              }
            }

            populated[key] = relatedItems;
          }
        }

        return populated as T;
      }),
    );
  };
