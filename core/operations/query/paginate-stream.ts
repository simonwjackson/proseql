import { Stream } from "effect";

/**
 * Apply pagination as a Stream combinator using Stream.drop for offset and Stream.take for limit.
 * Returns a function that transforms Stream<T> → Stream<T>, skipping `offset` items
 * and emitting at most `limit` items.
 */
export const applyPagination = (
  offset: number | undefined,
  limit: number | undefined,
) =>
  <T, E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
    let result = stream;

    if (offset !== undefined && offset > 0) {
      result = Stream.drop(result, offset);
    }

    if (limit !== undefined && limit > 0) {
      result = Stream.take(result, limit);
    }

    return result;
  };
