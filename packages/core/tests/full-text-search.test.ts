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

// ============================================================================
// 11. Relevance Scoring Tests
// ============================================================================

describe("Full-text search: Relevance Scoring (task 11)", () => {
	// Extended test data for relevance scoring with entities that have varying degrees of match
	const relevanceTestBooks: ReadonlyArray<Book> = [
		{
			id: "1",
			title: "The Left Hand of Darkness",
			author: "Ursula K. Le Guin",
			year: 1969,
			description: "A story exploring gender and society on a winter planet",
		},
		{
			id: "2",
			title: "The Dark Tower",
			author: "Stephen King",
			year: 1982,
			description: "A gunslinger walks through a desert world", // no "hand"
		},
		{
			id: "3",
			title: "Dune",
			author: "Frank Herbert",
			year: 1965,
			description: "A desert planet story about spice and sandworms",
		},
		{
			id: "4",
			title: "Duneland",
			author: "Various",
			year: 2020,
			description: "An anthology about deserts", // "Duneland" for prefix test
		},
	]

	const createRelevanceTestDatabase = () =>
		Effect.runPromise(
			createEffectDatabase(
				{
					books: { schema: BookSchema, relationships: {} },
				},
				{ books: relevanceTestBooks },
			),
		)

	describe("11.1: Relevance ordering", () => {
		it("should rank entity with higher relevance score first when multiple entities match", async () => {
			const db = await createRelevanceTestDatabase()
			// "dark" search:
			// - "The Left Hand of Darkness" matches "dark" as prefix of "darkness" in title
			// - "The Dark Tower" matches "dark" as exact match in title
			// Exact match should score higher than prefix match
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title"] } },
			}).runPromise

			// Should return both matching books
			expect(results.length).toBe(2)

			// "The Dark Tower" has exact "dark" match - should rank first
			expect(results[0].title).toBe("The Dark Tower")
			// "The Left Hand of Darkness" has prefix match "darkness" starting with "dark" - should rank second
			expect(results[1].title).toBe("The Left Hand of Darkness")
		})

		it("should rank entities with more term matches higher", async () => {
			// Add custom test data where one entity has more matches
			const booksWithVaryingMatches: ReadonlyArray<Book> = [
				{
					id: "1",
					title: "The Dark Night Returns",
					author: "Frank Miller",
					year: 1986,
					description: "Batman story with dark themes and night scenes",
				},
				{
					id: "2",
					title: "Dark",
					author: "Unknown",
					year: 2000,
					description: "A short story",
				},
			]

			const db = await Effect.runPromise(
				createEffectDatabase(
					{ books: { schema: BookSchema, relationships: {} } },
					{ books: booksWithVaryingMatches },
				),
			)

			// Search for "dark night" in all string fields
			const results = await db.books.query({
				where: { $search: { query: "dark night" } },
			}).runPromise

			// Only "The Dark Night Returns" matches BOTH terms (dark and night appear multiple times)
			// "Dark" title book only matches "dark", not "night", so it shouldn't match at all
			// (search requires ALL query terms to match)
			expect(results.length).toBe(1)
			expect(results[0].title).toBe("The Dark Night Returns")
		})

		it("should order by relevance when multiple entities match the same query", async () => {
			const db = await createRelevanceTestDatabase()
			// "dark" matches two books, should be ordered by relevance score
			const results = await db.books.query({
				where: { $search: { query: "dark" } },
			}).runPromise

			expect(results.length).toBe(2)
			// Both match "dark" but with different score profiles:
			// - "The Dark Tower" has exact match "dark"
			// - "The Left Hand of Darkness" has prefix match "darkness"
			// Exact match scores higher than prefix match
			expect(results[0].title).toBe("The Dark Tower")
			expect(results[1].title).toBe("The Left Hand of Darkness")
		})
	})

	describe("11.2: Explicit sort overrides relevance", () => {
		it("should sort by explicit sort option instead of relevance", async () => {
			const db = await createRelevanceTestDatabase()
			// Search for "dark" which matches "The Dark Tower" (1982) and "The Left Hand of Darkness" (1969)
			// By relevance, "The Dark Tower" should come first (exact match)
			// But with sort: { year: "asc" }, "The Left Hand of Darkness" (1969) should come first
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title"] } },
				sort: { year: "asc" },
			}).runPromise

			expect(results.length).toBe(2)
			// Sorted by year ascending: 1969 comes before 1982
			expect(results[0].title).toBe("The Left Hand of Darkness")
			expect(results[0].year).toBe(1969)
			expect(results[1].title).toBe("The Dark Tower")
			expect(results[1].year).toBe(1982)
		})

		it("should sort by year descending when specified", async () => {
			const db = await createRelevanceTestDatabase()
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title"] } },
				sort: { year: "desc" },
			}).runPromise

			expect(results.length).toBe(2)
			// Sorted by year descending: 1982 comes before 1969
			expect(results[0].title).toBe("The Dark Tower")
			expect(results[0].year).toBe(1982)
			expect(results[1].title).toBe("The Left Hand of Darkness")
			expect(results[1].year).toBe(1969)
		})

		it("should sort by title when specified, ignoring relevance", async () => {
			const db = await createRelevanceTestDatabase()
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title"] } },
				sort: { title: "asc" },
			}).runPromise

			expect(results.length).toBe(2)
			// Alphabetically: "The Dark Tower" < "The Left Hand of Darkness"
			expect(results[0].title).toBe("The Dark Tower")
			expect(results[1].title).toBe("The Left Hand of Darkness")
		})

		it("should apply explicit sort with field-level $search", async () => {
			const db = await createRelevanceTestDatabase()
			// Field-level $search with explicit sort
			const results = await db.books.query({
				where: { title: { $search: "dark" } },
				sort: { year: "asc" },
			}).runPromise

			expect(results.length).toBe(2)
			expect(results[0].year).toBe(1969)
			expect(results[1].year).toBe(1982)
		})

		it("should apply explicit sort with top-level $search without fields", async () => {
			const db = await createRelevanceTestDatabase()
			// Top-level $search (all string fields) with explicit sort
			const results = await db.books.query({
				where: { $search: { query: "dark" } },
				sort: { year: "asc" },
			}).runPromise

			expect(results.length).toBe(2)
			expect(results[0].year).toBe(1969)
			expect(results[1].year).toBe(1982)
		})
	})

	describe("11.3: Exact match scores higher than prefix match", () => {
		it("should rank exact 'Dune' above 'Duneland' when searching for 'dune'", async () => {
			const db = await createRelevanceTestDatabase()
			// "dune" query:
			// - "Dune" has exact match for "dune" in title
			// - "Duneland" has prefix match (duneland starts with "dune")
			// Exact match should score higher (1.0) than prefix match (0.5)
			const results = await db.books.query({
				where: { $search: { query: "dune", fields: ["title"] } },
			}).runPromise

			expect(results.length).toBe(2)
			// Exact match "Dune" should rank first
			expect(results[0].title).toBe("Dune")
			// Prefix match "Duneland" should rank second
			expect(results[1].title).toBe("Duneland")
		})

		it("should rank exact match higher even when prefix match is in a longer title", async () => {
			const db = await createRelevanceTestDatabase()
			// Using field-level $search to test the same behavior
			const results = await db.books.query({
				where: { title: { $search: "dune" } },
			}).runPromise

			expect(results.length).toBe(2)
			expect(results[0].title).toBe("Dune")
			expect(results[1].title).toBe("Duneland")
		})

		it("should rank exact match higher with top-level $search (all string fields)", async () => {
			const db = await createRelevanceTestDatabase()
			// Top-level $search without explicit fields
			const results = await db.books.query({
				where: { $search: { query: "dune" } },
			}).runPromise

			// Both "Dune" and "Duneland" should match
			expect(results.length).toBe(2)
			// Exact match should rank first
			expect(results[0].title).toBe("Dune")
			expect(results[1].title).toBe("Duneland")
		})

		it("should correctly rank when multiple terms have different match types", async () => {
			// Create test data where one entity has an exact match on one term
			// and a prefix match on another
			const mixedMatchBooks: ReadonlyArray<Book> = [
				{
					id: "1",
					title: "Dark Stories",
					author: "Unknown",
					year: 2000,
					description: "A collection",
				},
				{
					id: "2",
					title: "Darkness Falls",
					author: "Unknown",
					year: 2001,
					description: "A story",
				},
			]

			const db = await Effect.runPromise(
				createEffectDatabase(
					{ books: { schema: BookSchema, relationships: {} } },
					{ books: mixedMatchBooks },
				),
			)

			// Search for "dark" - "Dark Stories" has exact match, "Darkness Falls" has prefix
			const results = await db.books.query({
				where: { $search: { query: "dark", fields: ["title"] } },
			}).runPromise

			expect(results.length).toBe(2)
			// Exact "dark" in "Dark Stories" should score higher than prefix "dark" in "Darkness"
			expect(results[0].title).toBe("Dark Stories")
			expect(results[1].title).toBe("Darkness Falls")
		})

		it("should verify scoring difference between exact and prefix matches", async () => {
			const db = await createRelevanceTestDatabase()
			// Get results and verify the order reflects scoring rules
			const results = await db.books.query({
				where: { $search: { query: "dune", fields: ["title"] } },
			}).runPromise

			expect(results.length).toBe(2)

			// First result should be exact match
			expect(results[0].title).toBe("Dune")
			// Second result should be prefix match
			expect(results[1].title).toBe("Duneland")

			// The scoring formula gives:
			// - "Dune" exact match: coverage=1, tf=1+1/1=2, lengthNorm=1/log(2)≈1.44 → score≈2.88
			// - "Duneland" prefix match: coverage=1, tf=1+0.5/1=1.5, lengthNorm=1/log(2)≈1.44 → score≈2.16
			// The ratio should be approximately 2:1.5 = 1.33x difference
		})
	})
})

// ============================================================================
// 12. Search Index Tests
// ============================================================================

describe("Full-text search: Search Index (task 12)", () => {
	describe("12.1: Indexed search returns same results as unindexed search", () => {
		it("should return same results for field-level $search with and without index", async () => {
			// Create databases with and without search index
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Field-level search for "dune"
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { title: { $search: "dune" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { title: { $search: "dune" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same results for top-level $search with explicit fields", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Top-level search with explicit fields
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { $search: { query: "herbert dune", fields: ["title", "author"] } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { $search: { query: "herbert dune", fields: ["title", "author"] } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same results for top-level $search without fields (all string fields)", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Top-level search without fields (searches all string fields)
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { $search: { query: "gibson" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { $search: { query: "gibson" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same results for prefix matching", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Prefix search
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { title: { $search: "neuro" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { title: { $search: "neuro" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same results for multi-term search", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Multi-term search
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { title: { $search: "left hand darkness" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { title: { $search: "left hand darkness" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same empty results when no match", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Search with no matches
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { title: { $search: "xyz123notexist" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { title: { $search: "xyz123notexist" } },
			}).runPromise

			expect(resultsWithoutIndex.length).toBe(0)
			expect(resultsWithIndex.length).toBe(0)
		})

		it("should return same results for search across description field", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Search in description field
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { description: { $search: "cyberpunk" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { description: { $search: "cyberpunk" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should return same results with case-insensitive search", async () => {
			const dbWithoutIndex = await createTestDatabase()
			const dbWithIndex = await createTestDatabaseWithSearchIndex()

			// Case-insensitive search
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { author: { $search: "WILLIAM GIBSON" } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { author: { $search: "WILLIAM GIBSON" } },
			}).runPromise

			expect(resultsWithIndex.length).toBe(resultsWithoutIndex.length)
			expect(resultsWithIndex.map((b) => b.id).sort()).toEqual(
				resultsWithoutIndex.map((b) => b.id).sort(),
			)
		})

		it("should preserve relevance ordering for indexed search", async () => {
			// Create databases for relevance testing - need exact/prefix match scenario
			const relevanceBooks: ReadonlyArray<Book> = [
				{
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					description: "A desert planet story",
				},
				{
					id: "2",
					title: "Duneland",
					author: "Various",
					year: 2020,
					description: "An anthology",
				},
			]

			const dbWithoutIndex = await Effect.runPromise(
				createEffectDatabase(
					{ books: { schema: BookSchema, relationships: {} } },
					{ books: relevanceBooks },
				),
			)
			const dbWithIndex = await Effect.runPromise(
				createEffectDatabase(
					{
						books: {
							schema: BookSchema,
							relationships: {},
							searchIndex: ["title", "author", "description"] as const,
						},
					},
					{ books: relevanceBooks },
				),
			)

			// Search for "dune" - "Dune" should rank higher than "Duneland" (exact vs prefix)
			const resultsWithoutIndex = await dbWithoutIndex.books.query({
				where: { $search: { query: "dune", fields: ["title"] } },
			}).runPromise
			const resultsWithIndex = await dbWithIndex.books.query({
				where: { $search: { query: "dune", fields: ["title"] } },
			}).runPromise

			// Should have same results in same order (relevance preserved)
			expect(resultsWithIndex.length).toBe(2)
			expect(resultsWithIndex.map((b) => b.id)).toEqual(
				resultsWithoutIndex.map((b) => b.id),
			)
			// Verify ordering: "Dune" (exact) before "Duneland" (prefix)
			expect(resultsWithIndex[0].title).toBe("Dune")
			expect(resultsWithIndex[1].title).toBe("Duneland")
		})
	})
})
