import { Stream } from "effect";

/**
 * Apply pagination as a Stream combinator using Stream.drop for offset and Stream.take for limit.
 * Returns a function that transforms Stream<T> → Stream<T>, skipping `offset` items
 * and emitting at most `limit` items.
 *
 * Normalizes inputs: negative values are clamped to 0, fractional values are floored.
 * A limit of 0 returns an empty stream. Undefined limit means no limit (all remaining items).
 */
export const applyPagination = (
  offset: number | undefined,
  limit: number | undefined,
) =>
  <T, E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    const normalizedOffset = offset !== undefined ? Math.max(0, Math.floor(offset)) : 0;
    const normalizedLimit = limit !== undefined ? Math.max(0, Math.floor(limit)) : undefined;

    let result = stream;

    if (normalizedOffset > 0) {
      result = Stream.drop(result, normalizedOffset);
    }

    if (normalizedLimit !== undefined) {
      result = Stream.take(result, normalizedLimit);
    }

    return result;
  };
