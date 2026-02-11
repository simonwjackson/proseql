import { Effect, Ref, Stream } from "effect";
import type { CollectionConfig } from "../../types/database-config-types.js";
import { DanglingReferenceError } from "../../errors/query-errors.js";

/**
 * Maximum recursion depth for nested population (mirrors PopulateConfig type depth limit).
 */
const MAX_POPULATE_DEPTH = 5;

/**
 * PopulateValue can be:
 * - `true` to populate a relationship with all fields
 * - An object with nested populate config for recursive population
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
 * Populate a single item's relationships recursively.
 *
 * For each relationship key in the populate config:
 * - `ref`: look up a single entity in the target collection by foreign key
 * - `inverse`: find all entities whose foreign key points back to this item
 *
 * When the populate value is a nested config object (not just `true`),
 * recursively populate the related entity's relationships using the
 * target collection's relationship definitions.
 *
 * Recursion stops at MAX_POPULATE_DEPTH (5) to prevent infinite loops
 * in circular relationship graphs.
 */
function populateItem(
  item: Record<string, unknown>,
  populateConfig: Record<string, PopulateValue>,
  stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
  dbConfig: Record<string, CollectionConfig>,
  collectionName: string,
  depth: number,
): Effect.Effect<Record<string, unknown>, DanglingReferenceError> {
  return Effect.gen(function* () {
    const sourceConfig = dbConfig[collectionName];
    if (!sourceConfig) return item;

    const relationships = sourceConfig.relationships;
    const populateEntries = Object.entries(populateConfig).filter(
      ([key]) => relationships[key] !== undefined,
    );

    if (populateEntries.length === 0) return item;

    const populated: Record<string, unknown> = { ...item };

    for (const [key, value] of populateEntries) {
      const relationship = relationships[key];
      const targetRef = stateRefs[relationship.target];
      if (!targetRef) continue;

      const targetMap = yield* Ref.get(targetRef);

      if (relationship.type === "ref") {
        const foreignKeyField = relationship.foreignKey || key + "Id";
        const foreignKeyValue = item[foreignKeyField];

        if (typeof foreignKeyValue === "string") {
          const related = targetMap.get(foreignKeyValue);
          if (related) {
            populated[key] = yield* maybeRecurse(
              related, value, relationship.target, stateRefs, dbConfig, depth,
            );
          } else {
            yield* new DanglingReferenceError({
              collection: relationship.target,
              field: foreignKeyField,
              targetId: foreignKeyValue,
              message: `Entity in "${collectionName}" references missing "${relationship.target}" with ${foreignKeyField}="${foreignKeyValue}"`,
            });
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
          if (entity[foreignKeyField] === item.id) {
            relatedItems.push(entity);
          }
        }

        if (value === true || !isRecord(value)) {
          populated[key] = relatedItems;
        } else {
          const populatedRelated: Record<string, unknown>[] = [];
          for (const relItem of relatedItems) {
            populatedRelated.push(
              yield* maybeRecurse(
                relItem, value, relationship.target, stateRefs, dbConfig, depth,
              ),
            );
          }
          populated[key] = populatedRelated;
        }
      }
    }

    return populated;
  });
}

/**
 * If the populate value is a nested config and we haven't hit the depth limit,
 * recursively populate the related entity. Otherwise return the entity as-is.
 */
function maybeRecurse(
  entity: Record<string, unknown>,
  value: PopulateValue,
  targetCollectionName: string,
  stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>>,
  dbConfig: Record<string, CollectionConfig>,
  depth: number,
): Effect.Effect<Record<string, unknown>, DanglingReferenceError> {
  if (value === true || !isPopulateConfig(value) || depth >= MAX_POPULATE_DEPTH) {
    return Effect.succeed(entity);
  }

  return populateItem(
    entity, value, stateRefs, dbConfig, targetCollectionName, depth + 1,
  );
}

/**
 * Apply relationship population as a Stream combinator.
 *
 * For each item in the stream, resolves relationships by reading related
 * entities from collection Refs. Supports nested population recursively
 * up to a depth of 5.
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
  <E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E | DanglingReferenceError, R> => {
    if (!populateConfig || !isPopulateConfig(populateConfig)) return stream;

    const sourceConfig = dbConfig[collectionName];
    if (!sourceConfig) return stream;

    const relationships = sourceConfig.relationships;
    const populateEntries = Object.entries(populateConfig).filter(
      ([key]) => relationships[key] !== undefined,
    );

    if (populateEntries.length === 0) return stream;

    return Stream.mapEffect(stream, (item: T) =>
      populateItem(
        item, populateConfig, stateRefs, dbConfig, collectionName, 0,
      ) as Effect.Effect<T, DanglingReferenceError>,
    );
  };
