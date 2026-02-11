import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema, Chunk, Stream, Runtime, Cause } from "effect"
import { createEffectDatabase } from "../src/factories/database-effect.js"
import type { CursorPageResult } from "../src/types/cursor-types.js"
import { ValidationError } from "../src/errors/crud-errors.js"

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

	describe("backward pagination", () => {
		it("page via before cursor returns previous items", async () => {
			const items = generateItems(10)

			// Use before cursor to get items before item-007
			const page = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: "item-007",
				},
			})

			// Should return items 4-6 (the last 3 items before item-007)
			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Should have previous page (items 1-3)
			expect(page.pageInfo.hasPreviousPage).toBe(true)
			// Should have next page (items 7-10)
			expect(page.pageInfo.hasNextPage).toBe(true)

			// Cursors should match first and last items
			expect(page.pageInfo.startCursor).toBe("item-004")
			expect(page.pageInfo.endCursor).toBe("item-006")
		})

		it("first page (before earliest) has hasPreviousPage = false", async () => {
			const items = generateItems(10)

			// Use before cursor to get items before item-004
			// This should return items 1-3
			const page = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: "item-004",
				},
			})

			// Should return items 1-3
			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Should not have previous page (this is the first page)
			expect(page.pageInfo.hasPreviousPage).toBe(false)
			// Should have next page (items 4-10)
			expect(page.pageInfo.hasNextPage).toBe(true)

			// Cursors should match first and last items
			expect(page.pageInfo.startCursor).toBe("item-001")
			expect(page.pageInfo.endCursor).toBe("item-003")
		})

		it("can paginate backward through items", async () => {
			const items = generateItems(10)

			// Start from the end and paginate backward
			// First backward page: items before item-011 (doesn't exist, so all items match)
			// Actually, let's use a real cursor from a forward pagination
			// Navigate to item-010 first
			const lastPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: "item-007",
				},
			})
			// This returns items 8-10

			// Now go backward from item-008 (startCursor of last page)
			const prevPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: lastPage.pageInfo.startCursor!,
				},
			})

			// Should return items 5-7
			expect(prevPage.items).toHaveLength(3)
			expect(prevPage.items.map((i) => i.id)).toEqual([
				"item-005",
				"item-006",
				"item-007",
			])

			expect(prevPage.pageInfo.hasPreviousPage).toBe(true)
			expect(prevPage.pageInfo.hasNextPage).toBe(true)
		})

		it("returns fewer items when near the beginning", async () => {
			const items = generateItems(10)

			// Request 5 items before item-003
			// Only items 1-2 exist before item-003
			const page = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 5,
					before: "item-003",
				},
			})

			// Should return only 2 items (items 1-2)
			expect(page.items).toHaveLength(2)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
			])

			// Should not have previous page (these are the first items)
			expect(page.pageInfo.hasPreviousPage).toBe(false)
			// Should have next page
			expect(page.pageInfo.hasNextPage).toBe(true)

			// Cursors should match first and last items
			expect(page.pageInfo.startCursor).toBe("item-001")
			expect(page.pageInfo.endCursor).toBe("item-002")
		})
	})

	describe("empty results", () => {
		it("query matching no items returns empty items, null cursors, both has-flags false", async () => {
			// Empty database
			const result = await runCursorQuery([], {
				cursor: { key: "id", limit: 10 },
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.items).toEqual([])

			// Should have null cursors
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()

			// Should have both has-flags false
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("forward pagination after last item returns empty result", async () => {
			const items = generateItems(5)

			// Try to get items after the last item
			const result = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: "item-005", // Last item
				},
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.items).toEqual([])

			// Should have null cursors
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()

			// Should have both has-flags false
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("backward pagination before first item returns empty result", async () => {
			const items = generateItems(5)

			// Try to get items before the first item
			const result = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: "item-001", // First item
				},
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.items).toEqual([])

			// Should have null cursors
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()

			// Should have both has-flags false
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("forward pagination with non-existent after cursor returns empty result", async () => {
			const items = generateItems(5)

			// Use a cursor value that's beyond all items
			const result = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: "item-999", // Way beyond any item
				},
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.items).toEqual([])

			// Should have null cursors
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()

			// Should have both has-flags false
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("backward pagination with non-existent before cursor before all items returns empty result", async () => {
			const items = generateItems(5)

			// Use a cursor value that's before all items
			const result = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: "item-000", // Before any item
				},
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.items).toEqual([])

			// Should have null cursors
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()

			// Should have both has-flags false
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})
	})

	describe("stability", () => {
		it("insert between page fetches does not cause duplicates or skips", async () => {
			// Start with items 1-10
			const initialItems = generateItems(10)
			const db = await createTestDatabase(initialItems)

			// Fetch first page: items 1-3
			const firstPage = await (db.items.query({
				cursor: { key: "id", limit: 3 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(firstPage.items).toHaveLength(3)
			expect(firstPage.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])
			expect(firstPage.pageInfo.endCursor).toBe("item-003")

			// Insert a new record BETWEEN existing records
			// "item-002a" will sort after item-002 but before item-003
			// However, since we already have the cursor at item-003, this insert
			// should NOT affect the next page (which starts AFTER item-003)
			await db.items.create({
				id: "item-002a",
				name: "Item 2a",
				price: 25,
				category: "clothing",
			}).runPromise

			// Fetch second page using cursor from first page
			// Should start after item-003, returning items 4-6
			// The newly inserted item-002a is BEFORE the cursor, so it should NOT appear
			const secondPage = await (db.items.query({
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			// Second page should NOT include the inserted item (it's before the cursor)
			// and should NOT skip any items - it should correctly start at item-004
			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Verify no duplicates: first page items should not appear in second page
			const firstPageIds = new Set(firstPage.items.map((i) => i.id))
			for (const item of secondPage.items) {
				expect(firstPageIds.has(item.id as string)).toBe(false)
			}
		})

		it("insert after cursor position appears in next page correctly", async () => {
			// Start with items 1-10
			const initialItems = generateItems(10)
			const db = await createTestDatabase(initialItems)

			// Fetch first page: items 1-3
			const firstPage = await (db.items.query({
				cursor: { key: "id", limit: 3 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(firstPage.pageInfo.endCursor).toBe("item-003")

			// Insert a new record AFTER the cursor position
			// "item-003a" will sort after item-003 but before item-004
			await db.items.create({
				id: "item-003a",
				name: "Item 3a",
				price: 35,
				category: "electronics",
			}).runPromise

			// Fetch second page - the inserted item should appear first
			const secondPage = await (db.items.query({
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			// The inserted item should appear in the second page
			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-003a", // Newly inserted item appears first
				"item-004",
				"item-005",
			])
		})

		it("delete between page fetches maintains correct cursor position", async () => {
			// Start with items 1-10
			const initialItems = generateItems(10)
			const db = await createTestDatabase(initialItems)

			// Fetch first page: items 1-3
			const firstPage = await (db.items.query({
				cursor: { key: "id", limit: 3 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(firstPage.pageInfo.endCursor).toBe("item-003")

			// Delete item-004 (the first item that would appear in the next page)
			await db.items.delete("item-004").runPromise

			// Fetch second page - should skip deleted item and start at item-005
			const secondPage = await (db.items.query({
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			// Should get items 5, 6, 7 (skipping deleted item-004)
			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-005",
				"item-006",
				"item-007",
			])

			// No duplicates from first page
			const firstPageIds = new Set(firstPage.items.map((i) => i.id))
			for (const item of secondPage.items) {
				expect(firstPageIds.has(item.id as string)).toBe(false)
			}
		})
	})

	describe("combined with populate", () => {
		// Define schemas and config for populate tests
		const CategorySchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
		})

		const ProductSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			price: Schema.Number,
			categoryId: Schema.String,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String),
		})

		const populateConfig = {
			categories: {
				schema: CategorySchema,
				relationships: {
					products: { type: "inverse" as const, target: "products" },
				},
			},
			products: {
				schema: ProductSchema,
				relationships: {
					category: { type: "ref" as const, target: "categories" },
				},
			},
		} as const

		const categoriesData = [
			{ id: "cat-1", name: "Electronics" },
			{ id: "cat-2", name: "Books" },
		]

		/**
		 * Generate products with categories.
		 * Products are divided between categories to test population.
		 */
		const generateProductsWithCategory = (count: number) => {
			const products = []
			for (let i = 1; i <= count; i++) {
				const paddedId = String(i).padStart(3, "0")
				products.push({
					id: `prod-${paddedId}`,
					name: `Product ${i}`,
					price: i * 10,
					categoryId: i % 2 === 0 ? "cat-2" : "cat-1", // alternate between categories
				})
			}
			return products
		}

		it("populated fields present in cursor page items via ref relationship", async () => {
			const products = generateProductsWithCategory(10)
			const db = await Effect.runPromise(
				createEffectDatabase(populateConfig, {
					categories: categoriesData,
					products: products as ReadonlyArray<Record<string, unknown>>,
				}),
			)

			// Query products with populated category
			const result = await (db.products.query({
				populate: { category: true },
				cursor: { key: "id", limit: 3 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			// Should have 3 items
			expect(result.items).toHaveLength(3)

			// Each item should have the category populated
			for (const item of result.items) {
				expect(item.category).toBeDefined()
				const category = item.category as Record<string, unknown>
				expect(category.id).toBeDefined()
				expect(category.name).toBeDefined()
				// Verify it's the correct category based on categoryId
				if (item.categoryId === "cat-1") {
					expect(category.name).toBe("Electronics")
				} else {
					expect(category.name).toBe("Books")
				}
			}

			// Cursor metadata should still be correct
			expect(result.pageInfo.startCursor).toBe("prod-001")
			expect(result.pageInfo.endCursor).toBe("prod-003")
			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("populated fields present in cursor page items via inverse relationship", async () => {
			const products = generateProductsWithCategory(6)
			const db = await Effect.runPromise(
				createEffectDatabase(populateConfig, {
					categories: categoriesData,
					products: products as ReadonlyArray<Record<string, unknown>>,
				}),
			)

			// Query categories with populated products
			const result = await (db.categories.query({
				populate: { products: true },
				cursor: { key: "id", limit: 2 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			// Should have 2 categories
			expect(result.items).toHaveLength(2)

			// Each category should have products populated
			for (const item of result.items) {
				expect(item.products).toBeDefined()
				const products = item.products as ReadonlyArray<Record<string, unknown>>
				expect(Array.isArray(products)).toBe(true)
				expect(products.length).toBeGreaterThan(0)
				// Verify each product has expected fields
				for (const product of products) {
					expect(product.id).toBeDefined()
					expect(product.name).toBeDefined()
					expect(product.price).toBeDefined()
				}
			}

			// Cursor metadata should still be correct
			expect(result.pageInfo.startCursor).toBe("cat-1")
			expect(result.pageInfo.endCursor).toBe("cat-2")
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("cursor pagination works with forward navigation on populated items", async () => {
			const products = generateProductsWithCategory(10)
			const db = await Effect.runPromise(
				createEffectDatabase(populateConfig, {
					categories: categoriesData,
					products: products as ReadonlyArray<Record<string, unknown>>,
				}),
			)

			// First page with populate
			const firstPage = await (db.products.query({
				populate: { category: true },
				cursor: { key: "id", limit: 3 },
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(firstPage.items).toHaveLength(3)
			expect(firstPage.items.map((i) => i.id)).toEqual([
				"prod-001",
				"prod-002",
				"prod-003",
			])

			// Second page with populate
			const secondPage = await (db.products.query({
				populate: { category: true },
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"prod-004",
				"prod-005",
				"prod-006",
			])

			// Verify populated fields on second page
			for (const item of secondPage.items) {
				expect(item.category).toBeDefined()
				const category = item.category as Record<string, unknown>
				expect(category.name).toBeDefined()
			}

			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)
			expect(secondPage.pageInfo.hasNextPage).toBe(true)
		})

		it("cursor pagination works with backward navigation on populated items", async () => {
			const products = generateProductsWithCategory(10)
			const db = await Effect.runPromise(
				createEffectDatabase(populateConfig, {
					categories: categoriesData,
					products: products as ReadonlyArray<Record<string, unknown>>,
				}),
			)

			// Get items before prod-007 with populate
			const page = await (db.products.query({
				populate: { category: true },
				cursor: {
					key: "id",
					limit: 3,
					before: "prod-007",
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }).runPromise

			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"prod-004",
				"prod-005",
				"prod-006",
			])

			// Verify populated fields
			for (const item of page.items) {
				expect(item.category).toBeDefined()
			}

			expect(page.pageInfo.hasPreviousPage).toBe(true)
			expect(page.pageInfo.hasNextPage).toBe(true)
		})
	})

	describe("combined with where", () => {
		it("cursor applies after filtering, correct subset paginated", async () => {
			// Generate 15 items with categories:
			// clothing: 1, 5, 7, 11, 13 (odd items not divisible by 3)
			// books: 2, 4, 8, 10, 14 (even items not divisible by 3)
			// electronics: 3, 6, 9, 12, 15 (items divisible by 3)
			const items = generateItems(15)

			// Verify our category distribution is correct
			const electronics = items.filter((i) => i.category === "electronics")
			expect(electronics.map((i) => i.id)).toEqual([
				"item-003",
				"item-006",
				"item-009",
				"item-012",
				"item-015",
			])

			// First page of electronics items (limit 2)
			const firstPage = await runCursorQuery(items, {
				where: { category: "electronics" },
				cursor: { key: "id", limit: 2 },
			})

			// Should return first 2 electronics items
			expect(firstPage.items).toHaveLength(2)
			expect(firstPage.items.map((i) => i.id)).toEqual([
				"item-003",
				"item-006",
			])
			expect(firstPage.items.every((i) => i.category === "electronics")).toBe(true)

			// Should have next page (3 more electronics items)
			expect(firstPage.pageInfo.hasNextPage).toBe(true)
			expect(firstPage.pageInfo.hasPreviousPage).toBe(false)
			expect(firstPage.pageInfo.startCursor).toBe("item-003")
			expect(firstPage.pageInfo.endCursor).toBe("item-006")

			// Second page of electronics items
			const secondPage = await runCursorQuery(items, {
				where: { category: "electronics" },
				cursor: {
					key: "id",
					limit: 2,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			// Should return next 2 electronics items
			expect(secondPage.items).toHaveLength(2)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-009",
				"item-012",
			])
			expect(secondPage.items.every((i) => i.category === "electronics")).toBe(true)

			// Should have both next and previous pages
			expect(secondPage.pageInfo.hasNextPage).toBe(true)
			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)

			// Third (final) page of electronics items
			const thirdPage = await runCursorQuery(items, {
				where: { category: "electronics" },
				cursor: {
					key: "id",
					limit: 2,
					after: secondPage.pageInfo.endCursor!,
				},
			})

			// Should return only the last electronics item
			expect(thirdPage.items).toHaveLength(1)
			expect(thirdPage.items.map((i) => i.id)).toEqual(["item-015"])
			expect(thirdPage.items[0].category).toBe("electronics")

			// Should not have next page
			expect(thirdPage.pageInfo.hasNextPage).toBe(false)
			expect(thirdPage.pageInfo.hasPreviousPage).toBe(true)
		})

		it("cursor backward pagination works with where filter", async () => {
			const items = generateItems(15)

			// Get the last 2 electronics items before item-015
			const page = await runCursorQuery(items, {
				where: { category: "electronics" },
				cursor: {
					key: "id",
					limit: 2,
					before: "item-015",
				},
			})

			// Should return items 9 and 12 (the 2 electronics items before 15)
			expect(page.items).toHaveLength(2)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-009",
				"item-012",
			])
			expect(page.items.every((i) => i.category === "electronics")).toBe(true)

			// Should have both previous and next pages
			expect(page.pageInfo.hasPreviousPage).toBe(true) // items 3 and 6
			expect(page.pageInfo.hasNextPage).toBe(true) // item 15
		})

		it("where filter that matches no items returns empty cursor result", async () => {
			const items = generateItems(10)

			// Query for a category that doesn't exist
			const result = await runCursorQuery(items, {
				where: { category: "nonexistent" },
				cursor: { key: "id", limit: 5 },
			})

			// Should return empty items
			expect(result.items).toHaveLength(0)
			expect(result.pageInfo.startCursor).toBeNull()
			expect(result.pageInfo.endCursor).toBeNull()
			expect(result.pageInfo.hasNextPage).toBe(false)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})
	})

	describe("combined with select", () => {
		it("selected fields applied to page items with cursor metadata correct", async () => {
			const items = generateItems(10)

			// Select only id and name, omitting price and category
			const result = await runCursorQuery(items, {
				select: { id: true, name: true },
				cursor: { key: "id", limit: 3 },
			})

			// Should have 3 items
			expect(result.items).toHaveLength(3)

			// Each item should only have selected fields
			for (const item of result.items) {
				expect(item.id).toBeDefined()
				expect(item.name).toBeDefined()
				// These fields should NOT be present
				expect(item.price).toBeUndefined()
				expect(item.category).toBeUndefined()
			}

			// Verify the specific items
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])
			expect(result.items.map((i) => i.name)).toEqual([
				"Item 1",
				"Item 2",
				"Item 3",
			])

			// Cursor metadata should still be correct
			expect(result.pageInfo.startCursor).toBe("item-001")
			expect(result.pageInfo.endCursor).toBe("item-003")
			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("select with cursor key excluded still works for cursor extraction", async () => {
			const items = generateItems(10)

			// Select only name and price, explicitly excluding id (the cursor key)
			// The cursor extraction should still work before select is applied
			const result = await runCursorQuery(items, {
				select: { name: true, price: true },
				cursor: { key: "id", limit: 3 },
			})

			// Should have 3 items
			expect(result.items).toHaveLength(3)

			// Items should have selected fields only
			for (const item of result.items) {
				expect(item.name).toBeDefined()
				expect(item.price).toBeDefined()
				// id should NOT be present in the final items
				expect(item.id).toBeUndefined()
			}

			// Despite id being excluded from select, cursor metadata should still be correct
			// because cursor extraction happens BEFORE select is applied
			expect(result.pageInfo.startCursor).toBe("item-001")
			expect(result.pageInfo.endCursor).toBe("item-003")
			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("forward pagination with select works across multiple pages", async () => {
			const items = generateItems(10)

			// First page with select
			const firstPage = await runCursorQuery(items, {
				select: { id: true, category: true },
				cursor: { key: "id", limit: 3 },
			})

			expect(firstPage.items).toHaveLength(3)
			expect(firstPage.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// All items should only have selected fields
			for (const item of firstPage.items) {
				expect(item.id).toBeDefined()
				expect(item.category).toBeDefined()
				expect(item.name).toBeUndefined()
				expect(item.price).toBeUndefined()
			}

			// Second page using endCursor from first page
			const secondPage = await runCursorQuery(items, {
				select: { id: true, category: true },
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Second page items should also only have selected fields
			for (const item of secondPage.items) {
				expect(item.id).toBeDefined()
				expect(item.category).toBeDefined()
				expect(item.name).toBeUndefined()
				expect(item.price).toBeUndefined()
			}

			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)
			expect(secondPage.pageInfo.hasNextPage).toBe(true)
		})

		it("backward pagination with select works correctly", async () => {
			const items = generateItems(10)

			// Get items before item-007 with select
			const page = await runCursorQuery(items, {
				select: { id: true, price: true },
				cursor: {
					key: "id",
					limit: 3,
					before: "item-007",
				},
			})

			// Should return items 4-6
			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Items should only have selected fields
			for (const item of page.items) {
				expect(item.id).toBeDefined()
				expect(item.price).toBeDefined()
				expect(item.name).toBeUndefined()
				expect(item.category).toBeUndefined()
			}

			// Verify price values are correct
			expect(page.items.map((i) => i.price)).toEqual([40, 50, 60])

			expect(page.pageInfo.hasPreviousPage).toBe(true)
			expect(page.pageInfo.hasNextPage).toBe(true)
		})

		it("select with array notation works with cursor pagination", async () => {
			const items = generateItems(10)

			// Use array notation for select
			const result = await runCursorQuery(items, {
				select: ["id", "name"],
				cursor: { key: "id", limit: 3 },
			})

			// Should have 3 items
			expect(result.items).toHaveLength(3)

			// Each item should only have selected fields
			for (const item of result.items) {
				expect(item.id).toBeDefined()
				expect(item.name).toBeDefined()
				expect(item.price).toBeUndefined()
				expect(item.category).toBeUndefined()
			}

			// Cursor metadata should be correct
			expect(result.pageInfo.startCursor).toBe("item-001")
			expect(result.pageInfo.endCursor).toBe("item-003")
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("select combined with where and cursor works correctly", async () => {
			const items = generateItems(15)

			// Query electronics category with select
			const result = await runCursorQuery(items, {
				where: { category: "electronics" },
				select: { id: true, name: true },
				cursor: { key: "id", limit: 2 },
			})

			// Should have 2 items (electronics: 3, 6, 9, 12, 15)
			expect(result.items).toHaveLength(2)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-003",
				"item-006",
			])

			// Items should only have selected fields
			for (const item of result.items) {
				expect(item.id).toBeDefined()
				expect(item.name).toBeDefined()
				expect(item.price).toBeUndefined()
				// category should not be in output even though we filtered by it
				expect(item.category).toBeUndefined()
			}

			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})
	})

	describe("combined with explicit sort", () => {
		it("cursor key matches primary sort field with ascending order", async () => {
			const items = generateItems(10)

			// Explicit ascending sort on id (matches cursor key)
			const result = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: { key: "id", limit: 3 },
			})

			// Should return first 3 items in ascending order
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
			expect(result.pageInfo.startCursor).toBe("item-001")
			expect(result.pageInfo.endCursor).toBe("item-003")
		})

		it("forward pagination works with explicit ascending sort", async () => {
			const items = generateItems(10)

			// First page with ascending sort
			const firstPage = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: { key: "id", limit: 3 },
			})

			expect(firstPage.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Second page using after cursor
			const secondPage = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			expect(secondPage.pageInfo.hasNextPage).toBe(true)
			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)
		})

		it("backward pagination works with explicit ascending sort", async () => {
			const items = generateItems(10)

			// Get items before item-007 with ascending sort
			const page = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: {
					key: "id",
					limit: 3,
					before: "item-007",
				},
			})

			// Should return items 4-6 (last 3 items before item-007)
			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			expect(page.pageInfo.hasPreviousPage).toBe(true)
			expect(page.pageInfo.hasNextPage).toBe(true)
		})

		it("sort on non-id field with matching cursor key", async () => {
			const items = generateItems(10)

			// Sort by price (numeric, ascending) with cursor on price
			const result = await runCursorQuery(items, {
				sort: { price: "asc" },
				cursor: { key: "price", limit: 3 },
			})

			// Prices are 10, 20, 30, ... 100
			expect(result.items).toHaveLength(3)
			// First 3 items by price: item-001 (10), item-002 (20), item-003 (30)
			expect(result.items.map((i) => i.price)).toEqual([10, 20, 30])

			// Cursor values are string representations of the price
			expect(result.pageInfo.startCursor).toBe("10")
			expect(result.pageInfo.endCursor).toBe("30")
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("forward pagination on price field", async () => {
			const items = generateItems(10)

			// First page sorted by price
			const firstPage = await runCursorQuery(items, {
				sort: { price: "asc" },
				cursor: { key: "price", limit: 3 },
			})

			expect(firstPage.items.map((i) => i.price)).toEqual([10, 20, 30])

			// Second page: after price 30
			const secondPage = await runCursorQuery(items, {
				sort: { price: "asc" },
				cursor: {
					key: "price",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			expect(secondPage.items.map((i) => i.price)).toEqual([40, 50, 60])
			expect(secondPage.pageInfo.hasPreviousPage).toBe(true)
			expect(secondPage.pageInfo.hasNextPage).toBe(true)
		})

		it("multi-field sort with cursor key matching primary sort field", async () => {
			const items = generateItems(10)

			// Sort by category (primary), then by id (secondary)
			// Cursor key must match the primary sort field (category)
			const result = await runCursorQuery(items, {
				sort: { category: "asc", id: "asc" },
				cursor: { key: "category", limit: 4 },
			})

			// Categories in ascending order: books, clothing, electronics
			// First 4 items should be from books (items 2, 4, 8, 10 have category books)
			expect(result.items).toHaveLength(4)

			// All should be books (first category alphabetically)
			expect(result.items.every((i) => i.category === "books")).toBe(true)

			expect(result.pageInfo.startCursor).toBe("books")
			expect(result.pageInfo.endCursor).toBe("books")
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("explicit sort combined with where filter", async () => {
			const items = generateItems(15)

			// Filter electronics, sort by price ascending, paginate
			const result = await runCursorQuery(items, {
				where: { category: "electronics" },
				sort: { price: "asc" },
				cursor: { key: "price", limit: 2 },
			})

			// Electronics: items 3 (30), 6 (60), 9 (90), 12 (120), 15 (150)
			// Ascending: 30, 60, 90, 120, 150
			expect(result.items).toHaveLength(2)
			expect(result.items.map((i) => i.price)).toEqual([30, 60])

			expect(result.pageInfo.startCursor).toBe("30")
			expect(result.pageInfo.endCursor).toBe("60")
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("empty sort object injects implicit ascending sort on cursor key", async () => {
			const items = generateItems(10)

			// Empty sort object should be treated as implicit ascending sort on cursor key
			const result = await runCursorQuery(items, {
				sort: {},
				cursor: { key: "id", limit: 3 },
			})

			// Should return first 3 items in ascending order
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("can paginate through all items with explicit ascending sort", async () => {
			const items = generateItems(7)
			const collectedItems: Array<Record<string, unknown>> = []
			let cursor: string | undefined

			// Paginate forward collecting all items
			while (true) {
				const page = await runCursorQuery(items, {
					sort: { id: "asc" },
					cursor: { key: "id", limit: 2, after: cursor },
				})

				collectedItems.push(...page.items)

				if (!page.pageInfo.hasNextPage) {
					break
				}
				cursor = page.pageInfo.endCursor!
			}

			// Should have collected all 7 items in order
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

	describe("implicit sort", () => {
		it("omitting sort with cursor key uses ascending order on cursor key", async () => {
			const items = generateItems(10)

			// NO explicit sort provided - should default to ascending on cursor key
			const result = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})

			// Should return first 3 items in ascending order by id
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Verify order is ascending (each id should be greater than previous)
			for (let i = 1; i < result.items.length; i++) {
				const prev = result.items[i - 1].id as string
				const curr = result.items[i].id as string
				expect(curr > prev).toBe(true)
			}

			expect(result.pageInfo.hasNextPage).toBe(true)
			expect(result.pageInfo.hasPreviousPage).toBe(false)
		})

		it("implicit sort produces same results as explicit ascending sort", async () => {
			const items = generateItems(10)

			// Query with implicit sort (no sort option)
			const implicitResult = await runCursorQuery(items, {
				cursor: { key: "id", limit: 5 },
			})

			// Query with explicit ascending sort
			const explicitResult = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: { key: "id", limit: 5 },
			})

			// Results should be identical
			expect(implicitResult.items).toEqual(explicitResult.items)
			expect(implicitResult.pageInfo).toEqual(explicitResult.pageInfo)
		})

		it("implicit sort on non-id field uses ascending order", async () => {
			const items = generateItems(10)

			// No sort, but cursor on price field
			const result = await runCursorQuery(items, {
				cursor: { key: "price", limit: 3 },
			})

			// Prices should be in ascending order: 10, 20, 30, ...
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.price)).toEqual([10, 20, 30])

			// Verify ascending order
			for (let i = 1; i < result.items.length; i++) {
				const prev = result.items[i - 1].price as number
				const curr = result.items[i].price as number
				expect(curr > prev).toBe(true)
			}

			expect(result.pageInfo.startCursor).toBe("10")
			expect(result.pageInfo.endCursor).toBe("30")
			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("forward pagination works with implicit sort", async () => {
			const items = generateItems(10)

			// First page - no explicit sort
			const firstPage = await runCursorQuery(items, {
				cursor: { key: "id", limit: 3 },
			})

			expect(firstPage.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Second page - no explicit sort
			const secondPage = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					after: firstPage.pageInfo.endCursor!,
				},
			})

			expect(secondPage.items).toHaveLength(3)
			expect(secondPage.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			// Items should continue in ascending order
			expect((secondPage.items[0].id as string) > (firstPage.items[2].id as string)).toBe(true)
		})

		it("backward pagination works with implicit sort", async () => {
			const items = generateItems(10)

			// Get items before item-007 - no explicit sort
			const page = await runCursorQuery(items, {
				cursor: {
					key: "id",
					limit: 3,
					before: "item-007",
				},
			})

			// Should return items 4-6 in ascending order
			expect(page.items).toHaveLength(3)
			expect(page.items.map((i) => i.id)).toEqual([
				"item-004",
				"item-005",
				"item-006",
			])

			expect(page.pageInfo.hasPreviousPage).toBe(true)
			expect(page.pageInfo.hasNextPage).toBe(true)
		})

		it("can paginate through all items with implicit sort", async () => {
			const items = generateItems(7)
			const collectedItems: Array<Record<string, unknown>> = []
			let cursor: string | undefined

			// Paginate forward without explicit sort
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

			// Should have collected all 7 items in ascending order
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

			// Verify order is strictly ascending
			for (let i = 1; i < collectedItems.length; i++) {
				const prev = collectedItems[i - 1].id as string
				const curr = collectedItems[i].id as string
				expect(curr > prev).toBe(true)
			}
		})

		it("implicit sort combined with where filter", async () => {
			const items = generateItems(15)

			// Filter electronics, no explicit sort
			const result = await runCursorQuery(items, {
				where: { category: "electronics" },
				cursor: { key: "id", limit: 2 },
			})

			// Electronics: items 3, 6, 9, 12, 15
			// Should be in ascending order by id
			expect(result.items).toHaveLength(2)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-003",
				"item-006",
			])
			expect(result.items.every((i) => i.category === "electronics")).toBe(true)

			expect(result.pageInfo.hasNextPage).toBe(true)
		})

		it("implicit sort combined with select", async () => {
			const items = generateItems(10)

			// Select specific fields, no explicit sort
			const result = await runCursorQuery(items, {
				select: { id: true, name: true },
				cursor: { key: "id", limit: 3 },
			})

			// Should return first 3 items in ascending order
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])

			// Verify only selected fields present
			for (const item of result.items) {
				expect(item.id).toBeDefined()
				expect(item.name).toBeDefined()
				expect(item.price).toBeUndefined()
				expect(item.category).toBeUndefined()
			}
		})
	})

	describe("validation errors", () => {
		/**
		 * Helper to extract the actual error from Effect's FiberFailure wrapper.
		 * When Effect.runPromise rejects, it wraps the error in a FiberFailure.
		 */
		const extractEffectError = (e: unknown): unknown => {
			if (Runtime.isFiberFailure(e) && Cause.isCause((e as Record<symbol, unknown>)[Runtime.FiberFailureCauseId])) {
				const cause = (e as Record<symbol, unknown>)[Runtime.FiberFailureCauseId] as Cause.Cause<unknown>
				if (Cause.isFailType(cause)) {
					return cause.error
				}
			}
			return e
		}

		it("both after and before set produces ValidationError", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Query with both after and before set - should fail
			const queryEffect = db.items.query({
				cursor: {
					key: "id",
					limit: 3,
					after: "item-003",
					before: "item-007",
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor",
						message: "after and before are mutually exclusive",
					},
				])
			}
		})

		it("limit <= 0 produces ValidationError (zero)", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Query with limit = 0 - should fail
			const queryEffect = db.items.query({
				cursor: {
					key: "id",
					limit: 0,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.limit",
						message: "limit must be a positive integer",
					},
				])
			}
		})

		it("limit <= 0 produces ValidationError (negative)", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Query with negative limit - should fail
			const queryEffect = db.items.query({
				cursor: {
					key: "id",
					limit: -5,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.limit",
						message: "limit must be a positive integer",
					},
				])
			}
		})

		it("invalid cursor key that does not exist on entity produces ValidationError", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Query with a key that doesn't exist on the items
			const queryEffect = db.items.query({
				cursor: {
					key: "nonexistentField",
					limit: 3,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.key",
						message: "key 'nonexistentField' does not exist on entity",
					},
				])
			}
		})

		it("invalid nested cursor key produces ValidationError", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Query with a nested key that doesn't exist
			const queryEffect = db.items.query({
				cursor: {
					key: "nested.path.field",
					limit: 3,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.key",
						message: "key 'nested.path.field' does not exist on entity",
					},
				])
			}
		})

		it("cursor key mismatch with explicit sort field produces ValidationError", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Sort by 'name' but cursor key is 'id' - should fail
			const queryEffect = db.items.query({
				sort: { name: "asc" },
				cursor: {
					key: "id",
					limit: 3,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.key",
						message: "cursor key 'id' must match primary sort field 'name'",
					},
				])
			}
		})

		it("cursor key mismatch with first field in multi-field sort produces ValidationError", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Sort by category (primary), id (secondary) but cursor key is 'id' - should fail
			// because cursor key must match the PRIMARY sort field
			const queryEffect = db.items.query({
				sort: { category: "asc", id: "asc" },
				cursor: {
					key: "id",
					limit: 3,
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBe("Invalid cursor configuration")
				expect(error.issues).toEqual([
					{
						field: "cursor.key",
						message: "cursor key 'id' must match primary sort field 'category'",
					},
				])
			}
		})

		it("cursor key matching primary sort field does not produce error", async () => {
			const items = generateItems(10)

			// Sort by 'id' and cursor key is 'id' - should succeed
			const result = await runCursorQuery(items, {
				sort: { id: "asc" },
				cursor: {
					key: "id",
					limit: 3,
				},
			})

			// Should succeed and return items
			expect(result.items).toHaveLength(3)
			expect(result.items.map((i) => i.id)).toEqual([
				"item-001",
				"item-002",
				"item-003",
			])
		})

		it("cursor key matching primary field in multi-field sort does not produce error", async () => {
			const items = generateItems(10)

			// Sort by category (primary), id (secondary) and cursor key is 'category' - should succeed
			const result = await runCursorQuery(items, {
				sort: { category: "asc", id: "asc" },
				cursor: {
					key: "category",
					limit: 4,
				},
			})

			// Should succeed and return items
			expect(result.items).toHaveLength(4)
			// All should be 'books' (first category alphabetically)
			expect(result.items.every((i) => i.category === "books")).toBe(true)
		})

		it("validation error includes proper error structure", async () => {
			const items = generateItems(10)
			const db = await createTestDatabase(items)

			// Use both after and before to trigger validation error
			const queryEffect = db.items.query({
				cursor: {
					key: "id",
					limit: 3,
					after: "item-003",
					before: "item-007",
				},
			}) as { runPromise: Promise<CursorPageResult<Record<string, unknown>>> }

			try {
				await queryEffect.runPromise
				expect.fail("Should have thrown ValidationError")
			} catch (e) {
				const error = extractEffectError(e) as ValidationError
				// Verify error is a ValidationError with expected structure
				expect(error._tag).toBe("ValidationError")
				expect(error.message).toBeDefined()
				expect(error.issues).toBeDefined()
				expect(Array.isArray(error.issues)).toBe(true)
				expect(error.issues.length).toBeGreaterThan(0)
				expect(error.issues[0]).toHaveProperty("field")
				expect(error.issues[0]).toHaveProperty("message")
			}
		})
	})
})
