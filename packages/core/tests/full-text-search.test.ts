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
})
