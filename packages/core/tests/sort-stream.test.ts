import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applySort } from "../core/operations/query/sort-stream.js";

describe("applySort Stream combinator", () => {
  // Test data
  const users = [
    { id: "u1", name: "Alice", age: 30, score: 95, active: true, companyId: "c1" },
    { id: "u2", name: "Bob", age: 25, score: 82, active: true, companyId: "c2" },
    { id: "u3", name: "Charlie", age: 35, score: undefined as number | undefined, active: false, companyId: "c3" },
    { id: "u4", name: "Diana", age: 28, score: 90, active: true, companyId: "c1" },
    { id: "u5", name: "Eve", age: 32, score: 88, active: true, companyId: undefined as string | undefined },
    { id: "u6", name: "Frank", age: 25, score: 75, active: false, companyId: "c4" },
  ];

  const toStream = <T>(items: ReadonlyArray<T>) => Stream.fromIterable(items);

  const collectSorted = <T extends Record<string, unknown>>(
    items: ReadonlyArray<T>,
    sort: Partial<Record<string, "asc" | "desc">> | undefined,
  ) =>
    Effect.runPromise(
      Stream.runCollect(toStream(items).pipe(applySort<T>(sort))),
    ).then(Chunk.toArray);

  // ============================================================================
  // Pass-through behavior
  // ============================================================================

  describe("pass-through when no sort config", () => {
    it("should return stream unchanged when sort is undefined", async () => {
      const result = await collectSorted(users, undefined);
      expect(result).toEqual(users);
    });

    it("should return stream unchanged when sort is empty object", async () => {
      const result = await collectSorted(users, {});
      expect(result).toEqual(users);
    });
  });

  // ============================================================================
  // Single field sorting
  // ============================================================================

  describe("single field sorting", () => {
    it("should sort by string field ascending", async () => {
      const result = await collectSorted(users, { name: "asc" });
      const names = result.map((r) => r.name);
      expect(names).toEqual(["Alice", "Bob", "Charlie", "Diana", "Eve", "Frank"]);
    });

    it("should sort by string field descending", async () => {
      const result = await collectSorted(users, { name: "desc" });
      const names = result.map((r) => r.name);
      expect(names).toEqual(["Frank", "Eve", "Diana", "Charlie", "Bob", "Alice"]);
    });

    it("should sort by number field ascending", async () => {
      const result = await collectSorted(users, { age: "asc" });
      const ages = result.map((r) => r.age);
      expect(ages).toEqual([25, 25, 28, 30, 32, 35]);
    });

    it("should sort by number field descending", async () => {
      const result = await collectSorted(users, { age: "desc" });
      const ages = result.map((r) => r.age);
      expect(ages).toEqual([35, 32, 30, 28, 25, 25]);
    });

    it("should sort by boolean field ascending (false < true)", async () => {
      const result = await collectSorted(users, { active: "asc" });
      const states = result.map((r) => r.active);
      expect(states).toEqual([false, false, true, true, true, true]);
    });

    it("should sort by boolean field descending (true before false)", async () => {
      const result = await collectSorted(users, { active: "desc" });
      const states = result.map((r) => r.active);
      expect(states).toEqual([true, true, true, true, false, false]);
    });

    it("should sort by date string field ascending", async () => {
      const items = [
        { id: "1", date: "2023-03-01T00:00:00Z" },
        { id: "2", date: "2023-01-15T00:00:00Z" },
        { id: "3", date: "2023-02-10T00:00:00Z" },
      ];
      const result = await collectSorted(items, { date: "asc" });
      expect(result.map((r) => r.date)).toEqual([
        "2023-01-15T00:00:00Z",
        "2023-02-10T00:00:00Z",
        "2023-03-01T00:00:00Z",
      ]);
    });
  });

  // ============================================================================
  // Multi-field sorting
  // ============================================================================

  describe("multi-field sorting", () => {
    it("should sort by two fields with same direction", async () => {
      const result = await collectSorted(users, { age: "asc", name: "asc" });
      const sorted = result.map((r) => ({ age: r.age, name: r.name }));
      expect(sorted).toEqual([
        { age: 25, name: "Bob" },
        { age: 25, name: "Frank" },
        { age: 28, name: "Diana" },
        { age: 30, name: "Alice" },
        { age: 32, name: "Eve" },
        { age: 35, name: "Charlie" },
      ]);
    });

    it("should sort by two fields with different directions", async () => {
      const result = await collectSorted(users, { active: "desc", score: "desc" });
      // Active users first (desc), then by score (desc)
      const activeUsers = result.filter((u) => u.active);
      const scores = activeUsers.map((u) => u.score);
      expect(scores).toEqual([95, 90, 88, 82]);
    });

    it("should handle three sort fields", async () => {
      const posts = [
        { id: "1", published: true, likes: 42, title: "B post" },
        { id: "2", published: false, likes: 5, title: "A draft" },
        { id: "3", published: true, likes: 65, title: "C post" },
        { id: "4", published: true, likes: 42, title: "A post" },
      ];
      const result = await collectSorted(posts, { published: "desc", likes: "desc", title: "asc" });
      expect(result.map((r) => r.title)).toEqual(["C post", "A post", "B post", "A draft"]);
    });
  });

  // ============================================================================
  // Undefined/null handling
  // ============================================================================

  describe("undefined/null value handling", () => {
    it("should push undefined values to end in ascending sort", async () => {
      const result = await collectSorted(users, { score: "asc" });
      const scores = result.map((r) => r.score);
      expect(scores[scores.length - 1]).toBeUndefined();
      const defined = scores.filter((s) => s !== undefined);
      expect(defined).toEqual([75, 82, 88, 90, 95]);
    });

    it("should push undefined values to end in descending sort", async () => {
      const result = await collectSorted(users, { score: "desc" });
      const scores = result.map((r) => r.score);
      expect(scores[scores.length - 1]).toBeUndefined();
      const defined = scores.filter((s) => s !== undefined);
      expect(defined).toEqual([95, 90, 88, 82, 75]);
    });

    it("should handle undefined in relationship-like fields", async () => {
      const result = await collectSorted(users, { companyId: "asc" });
      const ids = result.map((r) => r.companyId);
      expect(ids[ids.length - 1]).toBeUndefined();
    });
  });

  // ============================================================================
  // Nested (dot notation) field sorting
  // ============================================================================

  describe("nested field paths (dot notation)", () => {
    it("should sort by nested field", async () => {
      const items = [
        { id: "1", company: { name: "Zebra Corp" } },
        { id: "2", company: { name: "Alpha Inc" } },
        { id: "3", company: { name: "Middle Co" } },
      ];
      const result = await collectSorted(items, { "company.name": "asc" });
      expect(result.map((r) => (r.company as Record<string, unknown>).name)).toEqual([
        "Alpha Inc",
        "Middle Co",
        "Zebra Corp",
      ]);
    });

    it("should handle missing nested paths", async () => {
      const items = [
        { id: "1", company: { name: "Bravo" } },
        { id: "2", company: undefined as Record<string, unknown> | undefined },
        { id: "3", company: { name: "Alpha" } },
      ];
      const result = await collectSorted(items, { "company.name": "asc" });
      // undefined nested path should sort to end
      expect(result[0].id).toBe("3"); // Alpha
      expect(result[1].id).toBe("1"); // Bravo
      expect(result[2].id).toBe("2"); // undefined
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe("edge cases", () => {
    it("should handle empty stream", async () => {
      const result = await collectSorted([], { name: "asc" });
      expect(result).toEqual([]);
    });

    it("should handle single item stream", async () => {
      const result = await collectSorted([users[0]], { name: "asc" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Alice");
    });

    it("should handle sort on non-existent field", async () => {
      const result = await collectSorted(users, { nonExistent: "asc" });
      // All values for nonExistent are undefined, so order is stable
      expect(result).toHaveLength(6);
    });

    it("should preserve Stream error channel", async () => {
      const failingStream = Stream.concat(
        Stream.fromIterable([{ id: "1", name: "A" }]),
        Stream.fail("test-error"),
      );

      const sorted = failingStream.pipe(applySort({ name: "asc" }));
      const result = await Effect.runPromise(
        Effect.either(Stream.runCollect(sorted)),
      );

      expect(result._tag).toBe("Left");
    });

    it("should preserve Stream context (R) type", async () => {
      // This is a compile-time check — the combinator should propagate R
      const stream: Stream.Stream<{ id: string; name: string }, never, never> =
        Stream.fromIterable([{ id: "1", name: "A" }]);
      const sorted = stream.pipe(applySort({ name: "asc" }));

      const result = await Effect.runPromise(Stream.runCollect(sorted));
      expect(Chunk.toArray(result)).toEqual([{ id: "1", name: "A" }]);
    });
  });
});
