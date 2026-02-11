import { describe, it, expect } from "vitest"
import { Effect, Stream } from "effect"
import { applyCursor } from "../core/operations/query/cursor-stream.js"
import type { CursorPageResult } from "../core/types/cursor-types.js"

describe("applyCursor", () => {
	// Use zero-padded IDs for correct string sorting (01, 02, ... 10)
	const items = [
		{ id: "01", name: "Alice" },
		{ id: "02", name: "Bob" },
		{ id: "03", name: "Charlie" },
		{ id: "04", name: "Diana" },
		{ id: "05", name: "Eve" },
		{ id: "06", name: "Frank" },
		{ id: "07", name: "Grace" },
		{ id: "08", name: "Hank" },
		{ id: "09", name: "Ivy" },
		{ id: "10", name: "Jack" },
	]

	const toStream = <T>(data: ReadonlyArray<T>) => Stream.fromIterable(data)

	// ============================================================================
	// Forward pagination (after)
	// ============================================================================

	describe("forward pagination (after)", () => {
		it("should return items after cursor with hasNextPage true when more exist", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", after: "03", limit: 3 }),
				),
			)

			expect(result.items).toEqual([
				{ id: "04", name: "Diana" },
				{ id: "05", name: "Eve" },
				{ id: "06", name: "Frank" },
			])
			expect(result.pageInfo).toEqual({
				startCursor: "04",
				endCursor: "06",
				hasNextPage: true,
				hasPreviousPage: true,
			})
		})

		it("should set hasNextPage false when on last page", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", after: "07", limit: 5 }),
				),
			)

			expect(result.items).toEqual([
				{ id: "08", name: "Hank" },
				{ id: "09", name: "Ivy" },
				{ id: "10", name: "Jack" },
			])
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(true)
		})
	})

	// ============================================================================
	// Backward pagination (before)
	// ============================================================================

	describe("backward pagination (before)", () => {
		it("should return items before cursor with hasPreviousPage true when more exist", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", before: "08", limit: 3 }),
				),
			)

			// Should get the last 3 items before "08": 05, 06, 07
			expect(result.items).toEqual([
				{ id: "05", name: "Eve" },
				{ id: "06", name: "Frank" },
				{ id: "07", name: "Grace" },
			])
			expect(result.pageInfo).toEqual({
				startCursor: "05",
				endCursor: "07",
				hasNextPage: true,
				hasPreviousPage: true,
			})
		})

		it("should set hasPreviousPage false when on first page", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", before: "04", limit: 5 }),
				),
			)

			// Items before "04" are: 01, 02, 03 (only 3 items, no overflow)
			expect(result.items).toEqual([
				{ id: "01", name: "Alice" },
				{ id: "02", name: "Bob" },
				{ id: "03", name: "Charlie" },
			])
			expect(result.pageInfo.hasPreviousPage).toBe(false)
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("should maintain ascending order in results", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", before: "06", limit: 3 }),
				),
			)

			// Items before "06" are: 01, 02, 03, 04, 05
			// Taking last 3+1 = 4: 02, 03, 04, 05
			// Has overflow, so hasPreviousPage = true
			// Slice off first (extra) item: 03, 04, 05
			expect(result.items).toEqual([
				{ id: "03", name: "Charlie" },
				{ id: "04", name: "Diana" },
				{ id: "05", name: "Eve" },
			])
			// Verify ascending order
			expect(result.items[0].id < result.items[1].id).toBe(true)
			expect(result.items[1].id < result.items[2].id).toBe(true)
		})

		it("should handle exactly limit items before cursor", async () => {
			// Before "04", we have 01, 02, 03 (exactly 3 items)
			const result = await Effect.runPromise(
				toStream(items).pipe(
					applyCursor({ key: "id", before: "04", limit: 3 }),
				),
			)

			expect(result.items).toEqual([
				{ id: "01", name: "Alice" },
				{ id: "02", name: "Bob" },
				{ id: "03", name: "Charlie" },
			])
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})
	})

	// ============================================================================
	// First page (no after/before)
	// ============================================================================

	describe("first page (no cursor)", () => {
		it("should return first items with hasNextPage true when more exist", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(applyCursor({ key: "id", limit: 3 })),
			)

			expect(result.items).toEqual([
				{ id: "01", name: "Alice" },
				{ id: "02", name: "Bob" },
				{ id: "03", name: "Charlie" },
			])
			expect(result.pageInfo).toEqual({
				startCursor: "01",
				endCursor: "03",
				hasNextPage: true,
				hasPreviousPage: false,
			})
		})

		it("should set hasNextPage false when all items fit", async () => {
			const result = await Effect.runPromise(
				toStream(items).pipe(applyCursor({ key: "id", limit: 15 })),
			)

			expect(result.items.length).toBe(10)
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})
	})
})
