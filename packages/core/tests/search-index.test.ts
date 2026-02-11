import { describe, it, expect } from "vitest"
import { Effect, Ref } from "effect"
import { buildSearchIndex, lookupSearchIndex } from "../src/indexes/search-index.js"
import type { SearchIndexMap } from "../src/types/search-types.js"

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
