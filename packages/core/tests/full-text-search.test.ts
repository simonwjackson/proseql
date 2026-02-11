import { Effect, Schema } from "effect"
import { describe, it, expect } from "vitest"
import { createEffectDatabase } from "../src/index.js"

// ============================================================================
// Test Schema
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	description: Schema.String,
})

type Book = typeof BookSchema.Type

// ============================================================================
// Test Data
// ============================================================================

const testBooks: ReadonlyArray<Book> = [
	{
		id: "1",
		title: "Dune",
		author: "Frank Herbert",
		year: 1965,
		description: "A desert planet story about spice and sandworms",
	},
	{
		id: "2",
		title: "Neuromancer",
		author: "William Gibson",
		year: 1984,
		description: "The sky above the port was the color of television",
	},
	{
		id: "3",
		title: "The Left Hand of Darkness",
		author: "Ursula K. Le Guin",
		year: 1969,
		description: "A story exploring gender and society on a winter planet",
	},
	{
		id: "4",
		title: "Foundation",
		author: "Isaac Asimov",
		year: 1951,
		description: "Psychohistory and the fall of a galactic empire",
	},
	{
		id: "5",
		title: "Snow Crash",
		author: "Neal Stephenson",
		year: 1992,
		description: "Virtual reality and pizza delivery in a cyberpunk future",
	},
]

// ============================================================================
// Test Helpers
// ============================================================================

const createTestDatabase = () =>
	Effect.runPromise(
		createEffectDatabase(
			{
				books: { schema: BookSchema, relationships: {} },
			},
			{ books: testBooks },
		),
	)

const createTestDatabaseWithSearchIndex = () =>
	Effect.runPromise(
		createEffectDatabase(
			{
				books: {
					schema: BookSchema,
					relationships: {},
					searchIndex: ["title", "author", "description"] as const,
				},
			},
			{ books: testBooks },
		),
	)

// ============================================================================
// 9. Basic Search Tests
// ============================================================================

describe("Full-text search: Basic Search (task 9)", () => {
	describe("9.1: Test setup verification", () => {
		it("should create database with books collection", async () => {
			const db = await createTestDatabase()
			expect(db.books).toBeDefined()
		})

		it("should have all test books loaded", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query().runPromise
			expect(results.length).toBe(5)
		})

		it("should have correct book fields", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({ where: { id: "1" } }).runPromise
			expect(results.length).toBe(1)
			expect(results[0]).toMatchObject({
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
				description: "A desert planet story about spice and sandworms",
			})
		})
	})

	describe("9.2: Field-level $search basic match", () => {
		it("should match 'Dune' when searching for 'dune'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "dune" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should return the full book object when matched", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "dune" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0]).toMatchObject({
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
			})
		})
	})

	describe("9.3: Case insensitivity", () => {
		it("should match 'Dune' when searching for 'DUNE' (uppercase)", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "DUNE" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should match 'Dune' when searching for 'DuNe' (mixed case)", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "DuNe" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should match 'Neuromancer' when searching for 'NEUROMANCER'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "NEUROMANCER" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
		})

		it("should match author case-insensitively", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { author: { $search: "FRANK HERBERT" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].author).toBe("Frank Herbert")
		})
	})

	describe("9.4: Multi-term search", () => {
		it("should match 'The Left Hand of Darkness' when searching for 'left hand darkness'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "left hand darkness" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("The Left Hand of Darkness")
		})

		it("should match when search terms are in different order than in title", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "darkness hand left" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("The Left Hand of Darkness")
		})

		it("should not match if any search term is missing from the field", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "left hand xyz" } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should match 'Foundation' when searching for 'foundation'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "foundation" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Foundation")
		})

		it("should match 'Snow Crash' when searching for 'snow crash'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "snow crash" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})
	})

	describe("9.5: Prefix matching", () => {
		it("should match 'Neuromancer' when searching for prefix 'neuro'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "neuro" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
		})

		it("should match 'Foundation' when searching for prefix 'found'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "found" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Foundation")
		})

		it("should match 'Dune' when searching for prefix 'du'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "du" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should match 'Snow Crash' when searching for prefix 'cra'", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "cra" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})

		it("should match with multi-term prefix search", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "sno cra" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})

		it("should match author with prefix search", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { author: { $search: "herb" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].author).toBe("Frank Herbert")
		})

		it("should match description with prefix search", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { description: { $search: "cyber" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})
	})

	describe("9.6: No match", () => {
		it("should return no results when searching for 'xyz123' in title", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "xyz123" } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should return no results when searching for nonexistent term in author", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { author: { $search: "xyz123" } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should return no results when searching for nonexistent term in description", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { description: { $search: "xyz123" } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should return no results when no tokens match any field", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "notaword faketerm randomstring" } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should return no results for partial mismatch where only some tokens match", async () => {
			const db = await createTestDatabase()
			// "dune" matches but "xyz123" doesn't, so overall should not match
			const results = await db.books.query({
				where: { title: { $search: "dune xyz123" } },
			}).runPromise
			expect(results.length).toBe(0)
		})
	})

	describe("9.7: Empty search string", () => {
		it("should return all results when searching with empty string in title", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { title: { $search: "" } },
			}).runPromise
			expect(results.length).toBe(5)
		})

		it("should return all results when searching with empty string in author", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { author: { $search: "" } },
			}).runPromise
			expect(results.length).toBe(5)
		})

		it("should return all results when searching with empty string in description", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { description: { $search: "" } },
			}).runPromise
			expect(results.length).toBe(5)
		})

		it("should apply other filters when $search is empty", async () => {
			const db = await createTestDatabase()
			// Empty $search should not filter anything, but year filter should apply
			const results = await db.books.query({
				where: { title: { $search: "" }, year: { $gt: 1980 } },
			}).runPromise
			// Books with year > 1980: Neuromancer (1984), Snow Crash (1992)
			expect(results.length).toBe(2)
			expect(results.map((b) => b.title).sort()).toEqual([
				"Neuromancer",
				"Snow Crash",
			])
		})

		it("should return same results as query without $search filter", async () => {
			const db = await createTestDatabase()
			const withEmptySearch = await db.books.query({
				where: { title: { $search: "" } },
			}).runPromise
			const withoutSearch = await db.books.query().runPromise
			expect(withEmptySearch.length).toBe(withoutSearch.length)
			expect(withEmptySearch.map((b) => b.id).sort()).toEqual(
				withoutSearch.map((b) => b.id).sort(),
			)
		})
	})
})

// ============================================================================
// 10. Multi-Field Search Tests
// ============================================================================

describe("Full-text search: Multi-Field Search (task 10)", () => {
	describe("10.1: Top-level multi-field search", () => {
		it("should match when terms span across specified fields", async () => {
			const db = await createTestDatabase()
			// "herbert" is in author field, "dune" is in title field
			const results = await db.books.query({
				where: { $search: { query: "herbert dune", fields: ["title", "author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
			expect(results[0].author).toBe("Frank Herbert")
		})

		it("should match when all terms are in a single field", async () => {
			const db = await createTestDatabase()
			// Both "frank" and "herbert" are in author field
			const results = await db.books.query({
				where: { $search: { query: "frank herbert", fields: ["title", "author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].author).toBe("Frank Herbert")
		})

		it("should return multiple matches when terms span different entities", async () => {
			const db = await createTestDatabase()
			// "gibson" is in Neuromancer's author, search for "william gibson"
			// Both terms should be found in the author field "William Gibson"
			const results = await db.books.query({
				where: { $search: { query: "william gibson", fields: ["author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
		})

		it("should not match when a term is missing from all specified fields", async () => {
			const db = await createTestDatabase()
			// "herbert" is in author but "xyz123" is not in any field
			const results = await db.books.query({
				where: { $search: { query: "herbert xyz123", fields: ["title", "author"] } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should support case-insensitive matching across fields", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { $search: { query: "HERBERT DUNE", fields: ["title", "author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should support prefix matching across fields", async () => {
			const db = await createTestDatabase()
			// "herb" is a prefix of "Herbert", "du" is a prefix of "Dune"
			const results = await db.books.query({
				where: { $search: { query: "herb du", fields: ["title", "author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should match multiple books when terms are shared", async () => {
			const db = await createTestDatabase()
			// "darkness" matches "The Left Hand of Darkness" in title
			// "dark" also matches via prefix
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title", "description"] } },
			}).runPromise
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results.some((r) => r.title === "The Left Hand of Darkness")).toBe(true)
		})
	})

	describe("10.2: Default all string fields search", () => {
		it("should search all string fields when fields is omitted - author match", async () => {
			const db = await createTestDatabase()
			// "gibson" is in author field "William Gibson"
			const results = await db.books.query({
				where: { $search: { query: "gibson" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
			expect(results[0].author).toBe("William Gibson")
		})

		it("should search all string fields when fields is omitted - title match", async () => {
			const db = await createTestDatabase()
			// "dune" is in title field
			const results = await db.books.query({
				where: { $search: { query: "dune" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should search all string fields when fields is omitted - description match", async () => {
			const db = await createTestDatabase()
			// "sandworms" is in description field
			const results = await db.books.query({
				where: { $search: { query: "sandworms" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should match when terms span across different string fields without specifying fields", async () => {
			const db = await createTestDatabase()
			// "herbert" is in author, "spice" is in description
			const results = await db.books.query({
				where: { $search: { query: "herbert spice" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
			expect(results[0].author).toBe("Frank Herbert")
		})

		it("should search multiple string fields and find matches across entities", async () => {
			const db = await createTestDatabase()
			// "television" is in Neuromancer's description
			const results = await db.books.query({
				where: { $search: { query: "television" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
		})

		it("should not search non-string fields like year", async () => {
			const db = await createTestDatabase()
			// "1965" is the year but it's a number field, not string
			// The search should not find it (year field is type Number)
			// Note: This searches string fields only
			const results = await db.books.query({
				where: { $search: { query: "1965" } },
			}).runPromise
			// Should not match because year is a number field
			expect(results.length).toBe(0)
		})

		it("should return multiple matches when query matches different entities", async () => {
			const db = await createTestDatabase()
			// "planet" appears in both Dune's description ("desert planet") and
			// The Left Hand of Darkness's description ("winter planet")
			const results = await db.books.query({
				where: { $search: { query: "planet" } },
			}).runPromise
			expect(results.length).toBe(2)
			const titles = results.map((r) => r.title).sort()
			expect(titles).toEqual(["Dune", "The Left Hand of Darkness"])
		})

		it("should support prefix matching across all string fields", async () => {
			const db = await createTestDatabase()
			// "cyber" is a prefix for "cyberpunk" in Snow Crash's description
			const results = await db.books.query({
				where: { $search: { query: "cyber" } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})
	})

	describe("10.3: Single-field explicit search", () => {
		it("should only search the specified field - title match", async () => {
			const db = await createTestDatabase()
			// "dune" is in title field, should match when fields: ["title"]
			const results = await db.books.query({
				where: { $search: { query: "dune", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should not match when term is in a non-specified field", async () => {
			const db = await createTestDatabase()
			// "herbert" is in author field, but we only search title
			const results = await db.books.query({
				where: { $search: { query: "herbert", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should not match when term is in description but only title is specified", async () => {
			const db = await createTestDatabase()
			// "sandworms" is in description field, but we only search title
			const results = await db.books.query({
				where: { $search: { query: "sandworms", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should only search author field when specified", async () => {
			const db = await createTestDatabase()
			// "gibson" is in author field "William Gibson"
			const results = await db.books.query({
				where: { $search: { query: "gibson", fields: ["author"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Neuromancer")
		})

		it("should not match title terms when only author is specified", async () => {
			const db = await createTestDatabase()
			// "neuromancer" is in title field, but we only search author
			const results = await db.books.query({
				where: { $search: { query: "neuromancer", fields: ["author"] } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should only search description field when specified", async () => {
			const db = await createTestDatabase()
			// "cyberpunk" is in description field
			const results = await db.books.query({
				where: { $search: { query: "cyberpunk", fields: ["description"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Snow Crash")
		})

		it("should support prefix matching in single specified field", async () => {
			const db = await createTestDatabase()
			// "du" is a prefix for "Dune" in title
			const results = await db.books.query({
				where: { $search: { query: "du", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})

		it("should support multi-term search in single specified field", async () => {
			const db = await createTestDatabase()
			// "left hand darkness" all in title field
			const results = await db.books.query({
				where: { $search: { query: "left hand darkness", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("The Left Hand of Darkness")
		})

		it("should fail multi-term search when terms span excluded fields", async () => {
			const db = await createTestDatabase()
			// "herbert" is in author, "dune" is in title -- but only title is searched
			const results = await db.books.query({
				where: { $search: { query: "herbert dune", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(0)
		})

		it("should be case-insensitive in single-field search", async () => {
			const db = await createTestDatabase()
			const results = await db.books.query({
				where: { $search: { query: "DUNE", fields: ["title"] } },
			}).runPromise
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("Dune")
		})
	})
})
