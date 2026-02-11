import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema, Stream, Chunk } from "effect"
import { addToSearchIndex, buildSearchIndex, lookupSearchIndex, resolveWithSearchIndex } from "../src/indexes/search-index.js"
import type { SearchIndexMap } from "../src/types/search-types.js"
import { createEffectDatabase } from "../src/factories/database-effect.js"

// ============================================================================
// Test Data
// ============================================================================

type Book = { readonly id: string; readonly title: string; readonly author: string }

const sampleBooks: ReadonlyArray<Book> = [
	{ id: "1", title: "Dune", author: "Frank Herbert" },
	{ id: "2", title: "Neuromancer", author: "William Gibson" },
	{ id: "3", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin" },
	{ id: "4", title: "Duneland Adventures", author: "Some Author" },
]

// ============================================================================
// buildSearchIndex Tests
// ============================================================================

describe("buildSearchIndex", () => {
	it("7.1: builds index from entities", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const index = await Effect.runPromise(Ref.get(indexRef))

		// "dune" should map to book 1 and 4 (from "Dune" and "Duneland")
		expect(index.get("dune")?.has("1")).toBe(true)
		expect(index.get("duneland")?.has("4")).toBe(true)

		// "frank" should map to book 1
		expect(index.get("frank")?.has("1")).toBe(true)

		// "herbert" should map to book 1
		expect(index.get("herbert")?.has("1")).toBe(true)

		// "neuromancer" should map to book 2
		expect(index.get("neuromancer")?.has("2")).toBe(true)
	})

	it("7.1: handles empty entities array", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex<Book>(["title"], []))
		const index = await Effect.runPromise(Ref.get(indexRef))

		expect(index.size).toBe(0)
	})

	it("7.1: handles empty fields array", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex([], sampleBooks))
		const index = await Effect.runPromise(Ref.get(indexRef))

		expect(index.size).toBe(0)
	})
})

// ============================================================================
// addToSearchIndex Tests
// ============================================================================

describe("addToSearchIndex", () => {
	it("8.1: adds a new entity to the search index", async () => {
		// Start with existing books in the index
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, ["title", "author"]))

		const index = await Effect.runPromise(Ref.get(indexRef))

		// New tokens should be in the index
		expect(index.get("snow")?.has("5")).toBe(true)
		expect(index.get("crash")?.has("5")).toBe(true)
		expect(index.get("neal")?.has("5")).toBe(true)
		expect(index.get("stephenson")?.has("5")).toBe(true)
	})

	it("8.1: can find newly added entity via lookup", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, ["title", "author"]))

		// Should be able to find the new book via search
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["snow"]))
		expect(ids.has("5")).toBe(true)
	})

	it("8.1: does not affect existing entries", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))

		// Verify initial state
		const idsBefore = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune"]))
		expect(idsBefore.has("1")).toBe(true)
		expect(idsBefore.has("4")).toBe(true)

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, ["title", "author"]))

		// Existing entries should still be searchable
		const idsAfter = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune"]))
		expect(idsAfter.has("1")).toBe(true)
		expect(idsAfter.has("4")).toBe(true)
	})

	it("8.1: adds to existing token sets when token already exists", async () => {
		// Create index with book containing "frank"
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))

		// Add another book with "Frank" in the title
		const newBook = { id: "5", title: "Frank's Adventure", author: "Someone" }
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, ["title", "author"]))

		// Both books should be in the "frank" token set
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["frank"]))
		expect(ids.has("1")).toBe(true) // Original "Frank Herbert"
		expect(ids.has("5")).toBe(true) // New "Frank's Adventure"
	})

	it("8.1: handles empty fields array", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const indexBefore = await Effect.runPromise(Ref.get(indexRef))
		const sizeBefore = indexBefore.size

		// Add entity with no fields to index
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, []))

		const indexAfter = await Effect.runPromise(Ref.get(indexRef))
		// Size should be unchanged
		expect(indexAfter.size).toBe(sizeBefore)
	})

	it("8.1: skips non-string fields", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex<Book>(["title", "author"], []))

		// Add an entity with a non-existent field (simulating non-string)
		const entity = { id: "1", title: "Test", author: "Author", year: 1999 } as unknown as Book
		await Effect.runPromise(addToSearchIndex(indexRef, entity, ["title", "year"]))

		const index = await Effect.runPromise(Ref.get(indexRef))
		// Should have "test" from title, but nothing from year (number)
		expect(index.get("test")?.has("1")).toBe(true)
		// Should not have "1999" since year is a number
		expect(index.has("1999")).toBe(false)
	})
})

// ============================================================================
// lookupSearchIndex Tests
// ============================================================================

describe("lookupSearchIndex", () => {
	it("7.2: finds exact match for single token", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune"]))

		// Should find book 1 (Dune) and book 4 (Duneland Adventures - via prefix)
		expect(ids.has("1")).toBe(true)
		expect(ids.has("4")).toBe(true)
		expect(ids.size).toBe(2)
	})

	it("7.2: finds prefix matches", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["neuro"]))

		// Should find book 2 (Neuromancer via prefix match)
		expect(ids.has("2")).toBe(true)
		expect(ids.size).toBe(1)
	})

	it("7.2: intersects results for multi-token query (AND semantics)", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune", "frank"]))

		// Only book 1 has both "dune" (in title) and "frank" (in author)
		expect(ids.has("1")).toBe(true)
		expect(ids.size).toBe(1)
	})

	it("7.2: returns empty set when no match", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["xyz123"]))

		expect(ids.size).toBe(0)
	})

	it("7.2: returns empty set for empty query tokens", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, []))

		expect(ids.size).toBe(0)
	})

	it("7.2: returns empty set when one token has no matches", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		// "dune" matches, but "xyz" doesn't - intersection should be empty
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune", "xyz"]))

		expect(ids.size).toBe(0)
	})

	it("7.2: handles multiple tokens that all match same entity", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		// "william" and "gibson" both from book 2's author
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["william", "gibson"]))

		expect(ids.has("2")).toBe(true)
		expect(ids.size).toBe(1)
	})

	it("7.2: prefix match includes longer tokens", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		// "le" should match "le" (from Le Guin) and "left" (from Left Hand)
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["le"]))

		// Book 3 has both "left" and "le" in its indexed fields
		expect(ids.has("3")).toBe(true)
	})
})

// ============================================================================
// resolveWithSearchIndex Tests
// ============================================================================

describe("resolveWithSearchIndex", () => {
	it("7.3: returns undefined when no search index is configured", async () => {
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex({ title: { $search: "dune" } }, undefined, undefined, map),
		)
		expect(result).toBeUndefined()
	})

	it("7.3: returns undefined when where clause has no $search", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex({ title: "Dune" }, indexRef, ["title", "author"], map),
		)
		expect(result).toBeUndefined()
	})

	it("7.3: returns candidates for top-level $search when fields match index", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "dune", fields: ["title"] } },
				indexRef,
				["title", "author"],
				map,
			),
		)
		expect(result).not.toBeUndefined()
		// Should return books that contain "dune" token
		expect(result!.some((b) => b.id === "1")).toBe(true) // "Dune"
		expect(result!.some((b) => b.id === "4")).toBe(true) // "Duneland Adventures"
	})

	it("7.3: returns candidates for field-level $search when field is in index", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ title: { $search: "neuromancer" } },
				indexRef,
				["title", "author"],
				map,
			),
		)
		expect(result).not.toBeUndefined()
		expect(result!.length).toBe(1)
		expect(result![0].id).toBe("2")
	})

	it("7.3: returns undefined when queried fields are not covered by index", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title"], sampleBooks)) // Only title indexed
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "dune", fields: ["author"] } }, // Searching author which is not indexed
				indexRef,
				["title"], // Only title is indexed
				map,
			),
		)
		expect(result).toBeUndefined()
	})

	it("7.3: returns empty array when no matches found", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex(["title", "author"], sampleBooks))
		const map = new Map(sampleBooks.map((b) => [b.id, b]))
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "xyz123nonexistent", fields: ["title"] } },
				indexRef,
				["title", "author"],
				map,
			),
		)
		expect(result).not.toBeUndefined()
		expect(result!.length).toBe(0)
	})
})

// ============================================================================
// Search Index Integration in Query Pipeline Tests
// ============================================================================

describe("Search Index in Query Pipeline (task 7.3)", () => {
	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		author: Schema.String,
		year: Schema.Number,
	})

	const testBooks = [
		{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
		{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
		{ id: "3", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969 },
		{ id: "4", title: "Duneland Adventures", author: "Some Author", year: 2020 },
	]

	it("7.3: uses search index to narrow candidates for $search queries", async () => {
		// Create database with searchIndex configured
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		)

		// Query with $search - should use the search index
		const results = await db.books
			.query({
				where: { $search: { query: "dune" } },
			})
			.runPromise

		// Should find books with "dune" in title (Dune and Duneland Adventures)
		expect(results.length).toBe(2)
		expect(results.some((r) => r.id === "1")).toBe(true)
		expect(results.some((r) => r.id === "4")).toBe(true)
	})

	it("7.3: uses search index for field-level $search", async () => {
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		)

		// Query with field-level $search
		const results = await db.books
			.query({
				where: { title: { $search: "neuromancer" } },
			})
			.runPromise

		expect(results.length).toBe(1)
		expect(results[0].id).toBe("2")
	})

	it("7.3: search index works with other filters", async () => {
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		)

		// Query with $search and additional filter
		const results = await db.books
			.query({
				where: {
					$search: { query: "dune" },
					year: { $lt: 2000 },
				},
			})
			.runPromise

		// Should only find Dune (1965), not Duneland Adventures (2020)
		expect(results.length).toBe(1)
		expect(results[0].id).toBe("1")
	})

	it("7.3: search without searchIndex config still works (full scan)", async () => {
		// Create database WITHOUT searchIndex configured
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				// No searchIndex configured
			},
		} as const

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		)

		// Query with $search should still work via full scan
		const results = await db.books
			.query({
				where: { $search: { query: "dune" } },
			})
			.runPromise

		// Should still find books with "dune"
		expect(results.length).toBe(2)
	})
})
