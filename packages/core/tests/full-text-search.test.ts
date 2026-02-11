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
})
