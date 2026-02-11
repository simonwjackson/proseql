import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema, Chunk, Stream } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"
import type { CursorPageResult } from "../core/types/cursor-types.js"

// ============================================================================
// Test Schema
// ============================================================================

const ItemSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Item = Schema.Schema.Type<typeof ItemSchema>

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generate N sequentially-IDed items.
 * IDs are zero-padded for correct string sorting (e.g., "item-001", "item-002", ...).
 */
const generateItems = (count: number): ReadonlyArray<Item> => {
	const items: Item[] = []
	for (let i = 1; i <= count; i++) {
		// Zero-pad to 3 digits for proper string sorting
		const paddedId = String(i).padStart(3, "0")
		items.push({
			id: `item-${paddedId}`,
			name: `Item ${i}`,
			price: i * 10,
			category: i % 3 === 0 ? "electronics" : i % 2 === 0 ? "books" : "clothing",
		})
	}
	return items
}

/**
 * Config for cursor pagination tests.
 */
const config = {
	items: {
		schema: ItemSchema,
		relationships: {},
	},
} as const

/**
 * Helper to create a database with items and run a cursor query.
 * Returns the CursorPageResult.
 */
const runCursorQuery = async (
	items: ReadonlyArray<Item>,
	options: {
		readonly where?: Record<string, unknown>
		readonly sort?: Record<string, "asc" | "desc">
		readonly select?: Record<string, boolean> | ReadonlyArray<string>
		readonly cursor: {
			readonly key: string
			readonly after?: string
			readonly before?: string
			readonly limit: number
		}
	},
): Promise<CursorPageResult<Record<string, unknown>>> => {
	const db = await Effect.runPromise(
		createEffectDatabase(config, { items: items as ReadonlyArray<Record<string, unknown>> }),
	)
	// Query with cursor returns RunnableCursorPage, use runPromise
	return await (db.items.query(options) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise
}

/**
 * Helper to create a database and return it for multi-step test scenarios.
 */
const createTestDatabase = async (items: ReadonlyArray<Item>) => {
	return await Effect.runPromise(
		createEffectDatabase(config, { items: items as ReadonlyArray<Record<string, unknown>> }),
	)
}

// ============================================================================
// Tests
// ============================================================================

describe("Cursor Pagination", () => {
	describe("test helpers", () => {
		it("generateItems should create sequentially-IDed items", () => {
			const items = generateItems(5)
			expect(items).toHaveLength(5)
			expect(items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
				"item-004",
				"item-005",
			])
		})

		it("generateItems IDs should sort correctly as strings", () => {
			const items = generateItems(100)
			const ids = items.map((i) => i.id)
			const sortedIds = [...ids].sort()
			expect(ids).toEqual(sortedIds)
		})

		it("runCursorQuery should return a CursorPageResult", async () => {
			const items = generateItems(10)
			const result = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})

			expect(result).toBeDefined()
			expect(result.items).toBeDefined()
			expect(Array.isArray(result.items)).toBe(true)
			expect(result.pageInfo).toBeDefined()
			expect(typeof result.pageInfo.hasNextPage).toBe("boolean")
			expect(typeof result.pageInfo.hasPreviousPage).toBe("boolean")
		})

		it("createTestDatabase should return a usable database", async () => {
			const items = generateItems(5)
			const db = await createTestDatabase(items)

			expect(db).toBeDefined()
			expect(db.items).toBeDefined()
			expect(typeof db.items.query).toBe("function")
			expect(typeof db.items.create).toBe("function")
		})
	})

	describe("forward pagination", () => {
		it("first page returns correct items and hasNextPage = true", async () => {
			const items = generateItems(10)
			const result = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})

			// Should return first 3 items
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Should have next page (7 more items)
			expect(result.pageInfo.hasNextPage).toBe(true)
			// Should not have previous page (this is the first page)
			expect(result.pageInfo.hasPreviousPage).toBe(false)

			// Cursors should match first and last items
			expect(result.pageInfo.startCursor).toBe("item-001")
			expect(result.pageInfo.endCursor).toBe("item-003")
		})

		it("second page via after: endCursor returns next items", async () => {
			const items = generateItems(10)

			// First page
			const firstPage = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})

			// Second page using endCursor from first page
			const secondPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			// Should return next 3 items (items 4-6)
			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Should have both next and previous pages
			expect(secondPage.pageInfo.hasNextPage).toBe(true)
			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)

			// Cursors should match first and last items
			expect(secondPage.pageInfo.startCursor).toBe("item-004")
			expect(secondPage.pageInfo.endCursor).toBe("item-006")
		})

		it("final page has hasNextPage = false", async () => {
			const items = generateItems(10)

			// Navigate to the last page
			// First page: items 1-3
			const firstPage = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})
			// Second page: items 4-6
			const secondPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})
			// Third page: items 7-9
			const thirdPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: secondPage.pageInfo.endCursor!,
				},
			})
			// Fourth (final) page: item 10 only
			const finalPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: thirdPage.pageInfo.endCursor!,
				},
			})

			// Should return only the last item
			expect(finalPage.items).toHaveLength(1)
			expect(finalPage.items.map((i) => i.id)).toEqual(["item-010"])

			// Should not have next page
			expect(finalPage.pageInfo.hasNextPage).toBe(false)
			// Should have previous page
			expect(finalPage.pageInfo.hasPreviousPage).toBe(true)

			// Cursors should match the single item
			expect(finalPage.pageInfo.startCursor).toBe("item-010")
			expect(finalPage.pageInfo.endCursor).toBe("item-010")
		})

		it("can paginate through all items forward", async () => {
			const items = generateItems(7)
			const collectedItems: Array<Record<string, unknown>> = []
			let cursor: string | undefined

			// Paginate forward collecting all items
			while (true) {
				const page = await runCursorQuery(items, {
					cursor: { key: "id", limit: 2, after: cursor },
				})

				collectedItems.push(...page.items)

				if (!page.pageInfo.hasNextPage) {
					break
				}
				cursor = page.pageInfo.endCursor!
			}

			// Should have collected all 7 items
			expect(collectedItems).toHaveLength(7)
			expect(collectedItems.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
				"item-004",
				"item-005",
				"item-006",
				"item-007",
			])
		})
	})
})
