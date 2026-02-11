import { Stream } from "effect";

/**
 * A select configuration can be either:
 * - Object-based: `{ name: true, email: true, company: { name: true } }`
 * - Array-based: `["name", "email"]` (picks those fields)
 */
type SelectConfig =
  | Record<string, unknown>
  | ReadonlyArray<string>;

/**
 * Type guard to check if a value is a record (non-null, non-array object).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply object-based field selection to a single item.
 * Handles nested selection for populated relationships (both objects and arrays).
 */
function applyObjectSelect(
  item: Record<string, unknown>,
  selection: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(selection)) {
    if (!(key in item)) continue;

    if (value === true) {
      result[key] = item[key];
    } else if (isRecord(value)) {
      // Nested selection for populated relationships
      const nestedData = item[key];
      if (Array.isArray(nestedData)) {
        result[key] = nestedData
          .filter(isRecord)
          .map((nested) => applyObjectSelect(nested, value));
      } else if (isRecord(nestedData)) {
        result[key] = applyObjectSelect(nestedData, value);
      }
    }
  }

  return result;
}

/**
 * Convert an array-based select config to an object-based one.
 * `["name", "email"]` becomes `{ name: true, email: true }`.
 */
function arraySelectToObject(
  fields: ReadonlyArray<string>,
): Record<string, true> {
  const result: Record<string, true> = {};
  for (const field of fields) {
    result[field] = true;
  }
  return result;
}

/**
 * Apply a field selection as a Stream combinator.
 * Returns a function that transforms Stream<T> → Stream<T>, projecting each entity
 * to only the selected fields.
 *
 * Supports both object-based (`{ name: true, email: true }`) and
 * array-based (`["name", "email"]`) selection configs.
 * Nested selection on populated relationships is supported via object-based config:
 * `{ name: true, company: { name: true } }`.
 */
export const applySelect = <T extends Record<string, unknown>>(
  select: SelectConfig | undefined,
) =>
  <E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    if (select === undefined || select === null) return stream;

    if (Array.isArray(select)) {
      if (select.length === 0) return stream;
      const objectSelect = arraySelectToObject(select);
      return Stream.map(stream, (item: T) =>
        applyObjectSelect(item, objectSelect) as T,
      );
    }

    if (isRecord(select) && Object.keys(select).length === 0) return stream;

    return Stream.map(stream, (item: T) =>
      applyObjectSelect(item, select as Record<string, unknown>) as T,
    );
  };

/**
 * Apply a field selection to an array of items.
 *
 * This is used by cursor pagination where items are collected before selection.
 * Supports both object-based and array-based selection configs.
 */
export const applySelectToArray = <T extends Record<string, unknown>>(
  items: ReadonlyArray<T>,
  select: SelectConfig | undefined,
): ReadonlyArray<T> => {
  if (select === undefined || select === null) return items;

  if (Array.isArray(select)) {
    if (select.length === 0) return items;
    const objectSelect = arraySelectToObject(select);
    return items.map((item) => applyObjectSelect(item, objectSelect) as T);
  }

  if (isRecord(select) && Object.keys(select).length === 0) return items;

  return items.map((item) =>
    applyObjectSelect(item, select as Record<string, unknown>) as T,
  );
};
