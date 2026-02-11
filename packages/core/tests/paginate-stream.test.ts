import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applyPagination } from "../src/operations/query/paginate-stream.js";

describe("applyPagination Stream combinator", () => {
  const items = [
    { id: "1", name: "Alice" },
    { id: "2", name: "Bob" },
    { id: "3", name: "Charlie" },
    { id: "4", name: "Diana" },
    { id: "5", name: "Eve" },
    { id: "6", name: "Frank" },
    { id: "7", name: "Grace" },
    { id: "8", name: "Hank" },
    { id: "9", name: "Ivy" },
    { id: "10", name: "Jack" },
  ];

  const toStream = <T>(data: ReadonlyArray<T>) => Stream.fromIterable(data);

  const collectPaginated = (
    offset: number | undefined,
    limit: number | undefined,
  ) =>
    Effect.runPromise(
      Stream.runCollect(toStream(items).pipe(applyPagination(offset, limit))),
    ).then(Chunk.toArray);

  // ============================================================================
  // Pass-through behavior
  // ============================================================================

  describe("pass-through when no pagination", () => {
    it("should return stream unchanged when both offset and limit are undefined", async () => {
      const result = await collectPaginated(undefined, undefined);
      expect(result).toEqual(items);
    });

    it("should return stream unchanged when offset is 0 and limit is undefined", async () => {
      const result = await collectPaginated(0, undefined);
      expect(result).toEqual(items);
    });
  });

  // ============================================================================
  // Offset only
  // ============================================================================

  describe("offset only", () => {
    it("should skip the first N items", async () => {
      const result = await collectPaginated(3, undefined);
      expect(result).toEqual(items.slice(3));
    });

    it("should return empty when offset exceeds item count", async () => {
      const result = await collectPaginated(20, undefined);
      expect(result).toEqual([]);
    });

    it("should return all items when offset is 0", async () => {
      const result = await collectPaginated(0, undefined);
      expect(result).toEqual(items);
    });
  });

  // ============================================================================
  // Limit only
  // ============================================================================

  describe("limit only", () => {
    it("should take at most N items", async () => {
      const result = await collectPaginated(undefined, 3);
      expect(result).toEqual(items.slice(0, 3));
    });

    it("should return all items when limit exceeds item count", async () => {
      const result = await collectPaginated(undefined, 100);
      expect(result).toEqual(items);
    });

    it("should return single item when limit is 1", async () => {
      const result = await collectPaginated(undefined, 1);
      expect(result).toEqual([items[0]]);
    });
  });

  // ============================================================================
  // Offset + Limit combined
  // ============================================================================

  describe("offset and limit combined", () => {
    it("should skip offset then take limit", async () => {
      const result = await collectPaginated(2, 3);
      expect(result).toEqual(items.slice(2, 5));
    });

    it("should handle offset + limit exceeding item count", async () => {
      const result = await collectPaginated(8, 5);
      expect(result).toEqual(items.slice(8));
    });

    it("should return empty when offset exceeds item count", async () => {
      const result = await collectPaginated(20, 5);
      expect(result).toEqual([]);
    });

    it("should handle page-style pagination (page 1)", async () => {
      const result = await collectPaginated(0, 3);
      expect(result).toEqual(items.slice(0, 3));
    });

    it("should handle page-style pagination (page 2)", async () => {
      const result = await collectPaginated(3, 3);
      expect(result).toEqual(items.slice(3, 6));
    });

    it("should handle page-style pagination (last partial page)", async () => {
      const result = await collectPaginated(9, 3);
      expect(result).toEqual(items.slice(9));
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe("edge cases", () => {
    it("should handle empty stream", async () => {
      const result = await Effect.runPromise(
        Stream.runCollect(
          Stream.fromIterable([]).pipe(applyPagination(0, 5)),
        ),
      ).then(Chunk.toArray);
      expect(result).toEqual([]);
    });

    it("should preserve Stream error channel", async () => {
      const failingStream = Stream.concat(
        Stream.fromIterable(items),
        Stream.fail("test-error"),
      );

      const paginated = failingStream.pipe(applyPagination(0, 5));
      const result = await Effect.runPromise(
        Effect.either(Stream.runCollect(paginated)),
      );

      // Takes 5 items before hitting the error, so should succeed
      expect(result._tag).toBe("Right");
    });

    it("should propagate Stream error when it occurs within the window", async () => {
      const failingStream = Stream.concat(
        Stream.fromIterable([items[0]]),
        Stream.fail("test-error"),
      );

      const paginated = failingStream.pipe(applyPagination(0, 5));
      const result = await Effect.runPromise(
        Effect.either(Stream.runCollect(paginated)),
      );

      expect(result._tag).toBe("Left");
    });
  });
});
