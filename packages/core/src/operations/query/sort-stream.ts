import { Chunk, Effect, Stream } from "effect";
import type { SearchConfig } from "../../types/search-types.js";
import { tokenize, computeSearchScore } from "./search.js";

/**
 * A sort configuration mapping field names to sort direction.
 */
type SortConfig = Partial<Record<string, "asc" | "desc">>;

/**
 * Extract SearchConfig from a where clause if present at top level.
 * Returns undefined if no top-level $search is found.
 */
export function extractSearchConfig(
  where: Record<string, unknown> | undefined,
): SearchConfig | undefined {
  if (!where) return undefined;
  const searchValue = where.$search;
  if (searchValue === null || typeof searchValue !== "object") return undefined;
  const config = searchValue as SearchConfig;
  // Validate that it has the required 'query' property
  if (typeof config.query !== "string") return undefined;
  return config;
}

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Compare two values for sorting, returning a negative, zero, or positive number.
 * Handles undefined/null (always sort to end), strings, numbers, booleans, Dates, and fallback toString.
 */
function compareValues(aValue: unknown, bValue: unknown): number {
  // Handle undefined/null values - they always sort to the end
  if (aValue === undefined || aValue === null) {
    if (bValue === undefined || bValue === null) {
      return 0;
    }
    return 1;
  }
  if (bValue === undefined || bValue === null) {
    return -1;
  }

  if (typeof aValue === "string" && typeof bValue === "string") {
    return aValue.localeCompare(bValue);
  }
  if (typeof aValue === "number" && typeof bValue === "number") {
    return aValue - bValue;
  }
  if (typeof aValue === "boolean" && typeof bValue === "boolean") {
    return (aValue ? 1 : 0) - (bValue ? 1 : 0);
  }
  if (aValue instanceof Date && bValue instanceof Date) {
    return aValue.getTime() - bValue.getTime();
  }

  // Fallback: convert to string
  return String(aValue).localeCompare(String(bValue));
}

/**
 * Apply relevance-based sorting for search results.
 * Sorts items by their search relevance score in descending order.
 *
 * @param searchConfig - The search configuration containing query and optional fields
 * @returns A stream combinator that sorts by relevance score
 */
export const applyRelevanceSort = <T extends Record<string, unknown>>(
  searchConfig: SearchConfig,
) =>
  <E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    const queryTokens = tokenize(searchConfig.query);
    // Empty query: no relevance to sort by
    if (queryTokens.length === 0) return stream;

    return Stream.unwrap(
      Effect.map(Stream.runCollect(stream), (chunk: Chunk.Chunk<T>) => {
        const arr = Chunk.toArray(chunk) as Array<T>;

        // Compute scores for all items
        const scored = arr.map((item) => {
          // Determine target fields: explicit or all string fields
          let targetFields: ReadonlyArray<string>;
          if (searchConfig.fields && searchConfig.fields.length > 0) {
            targetFields = searchConfig.fields;
          } else {
            targetFields = Object.keys(item).filter(
              (k) => typeof item[k] === "string",
            );
          }
          const score = computeSearchScore(item, queryTokens, targetFields);
          return { item, score };
        });

        // Sort by score descending (higher scores first)
        scored.sort((a, b) => b.score - a.score);

        return Stream.fromIterable(scored.map(({ item }) => item));
      }),
    );
  };

/**
 * Apply a sort configuration as a Stream combinator.
 * Collects the stream, sorts in memory, and re-emits as a new stream.
 *
 * Supports multi-field sorting with asc/desc order, nested field paths (dot notation),
 * and handles undefined/null values (sorted to the end regardless of direction).
 */
export const applySort = <T extends Record<string, unknown>>(
  sort: SortConfig | undefined,
) =>
  <E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    if (!sort || Object.keys(sort).length === 0) return stream;

    const sortFields = Object.entries(sort);

    return Stream.unwrap(
      Effect.map(Stream.runCollect(stream), (chunk: Chunk.Chunk<T>) => {
        const arr = Chunk.toArray(chunk) as Array<T>;

        arr.sort((a, b) => {
          for (const [field, order] of sortFields) {
            const aValue = getNestedValue(a, field);
            const bValue = getNestedValue(b, field);

            // Undefined/null always sort to the end, regardless of direction
            const aIsNullish = aValue === undefined || aValue === null;
            const bIsNullish = bValue === undefined || bValue === null;
            if (aIsNullish || bIsNullish) {
              if (aIsNullish && bIsNullish) continue;
              return aIsNullish ? 1 : -1;
            }

            const comparison = compareValues(aValue, bValue);
            if (comparison !== 0) {
              return order === "desc" ? -comparison : comparison;
            }
          }
          return 0;
        });

        return Stream.fromIterable(arr);
      }),
    );
  };
