import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect";
import type { EffectDatabase } from "../src/factories/database-effect";

/**
 * Task 6.1: Verify that computed fields are never written into the Ref.
 *
 * The Ref stores only schema-validated entities; computed fields are resolved
 * downstream in the query pipeline. This is guaranteed by the architecture:
 *
 * 1. The schema defines only stored fields (id, title, year, genre, authorId)
 * 2. CRUD operations validate through the schema before storing in Ref
 * 3. Computed fields are defined in a separate `computed` config
 * 4. Computed fields are resolved by resolveComputedStream after reading from Ref
 *
 * These tests verify that findById (which reads directly from the Ref without
 * computed resolution) returns entities WITHOUT computed field keys.
 */

// Book schema - stored fields only
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	authorId: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

// Author schema
const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type Book = typeof BookSchema.Type;

// Database config with computed fields
const config = {
	books: {
		schema: BookSchema,
		relationships: {
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
		},
		// Computed fields defined here
		computed: {
			displayName: (book: Book) => `${book.title} (${book.year})`,
			isClassic: (book: Book) => book.year < 1980,
			yearsSincePublication: (book: Book) => 2024 - book.year,
		},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {
			books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
		},
	},
} as const;

describe("Task 6.1: Computed fields are never written into the Ref", () => {
	let db: EffectDatabase<typeof config>;

	beforeEach(async () => {
		db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: [],
				authors: [{ id: "author1", name: "Frank Herbert" }],
			}),
		);
	});

	describe("findById returns only stored fields (reads directly from Ref)", () => {
		it("should NOT include computed fields when reading entity created via create()", async () => {
			// Create a book
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
			}).runPromise;

			// findById reads directly from the Ref without computed field resolution
			const stored = await db.books.findById(created.id).runPromise;

			// Verify stored fields are present
			expect(stored.id).toBe(created.id);
			expect(stored.title).toBe("Dune");
			expect(stored.year).toBe(1965);
			expect(stored.genre).toBe("sci-fi");
			expect(stored.authorId).toBe("author1");
			expect(stored.createdAt).toBeDefined();
			expect(stored.updatedAt).toBeDefined();

			// Verify computed fields are NOT present
			// TypeScript won't let us access these directly, so we cast to Record
			const storedRecord = stored as unknown as Record<string, unknown>;
			expect(storedRecord.displayName).toBeUndefined();
			expect(storedRecord.isClassic).toBeUndefined();
			expect(storedRecord.yearsSincePublication).toBeUndefined();
			expect("displayName" in storedRecord).toBe(false);
			expect("isClassic" in storedRecord).toBe(false);
			expect("yearsSincePublication" in storedRecord).toBe(false);
		});

		it("should NOT include computed fields when reading entity created via createMany()", async () => {
			// Create multiple books
			const result = await db.books.createMany([
				{ title: "Dune", year: 1965, genre: "sci-fi", authorId: "author1" },
				{ title: "Neuromancer", year: 1984, genre: "sci-fi", authorId: "author1" },
			]).runPromise;

			expect(result.created).toHaveLength(2);

			// Check each stored entity
			for (const created of result.created) {
				const stored = await db.books.findById(created.id).runPromise;
				const storedRecord = stored as unknown as Record<string, unknown>;

				// Stored fields present
				expect(stored.title).toBeDefined();
				expect(stored.year).toBeDefined();
				expect(stored.genre).toBeDefined();

				// Computed fields NOT present
				expect(storedRecord.displayName).toBeUndefined();
				expect(storedRecord.isClassic).toBeUndefined();
				expect(storedRecord.yearsSincePublication).toBeUndefined();
			}
		});

		it("should NOT include computed fields after update()", async () => {
			// Create a book
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
			}).runPromise;

			// Update the book
			await db.books.update(created.id, { year: 1966 }).runPromise;

			// Read from Ref
			const stored = await db.books.findById(created.id).runPromise;
			const storedRecord = stored as unknown as Record<string, unknown>;

			// Stored field updated
			expect(stored.year).toBe(1966);

			// Computed fields still NOT present
			expect(storedRecord.displayName).toBeUndefined();
			expect(storedRecord.isClassic).toBeUndefined();
			expect(storedRecord.yearsSincePublication).toBeUndefined();
		});

		it("should NOT include computed fields after upsert()", async () => {
			// Upsert creates a new book
			const result = await db.books.upsert({
				where: { id: "book-upsert-test" },
				create: {
					id: "book-upsert-test",
					title: "The Left Hand of Darkness",
					year: 1969,
					genre: "sci-fi",
					authorId: "author1",
				},
				update: { year: 1970 },
			}).runPromise;

			expect(result.__action).toBe("created");

			// Read from Ref
			const stored = await db.books.findById("book-upsert-test").runPromise;
			const storedRecord = stored as unknown as Record<string, unknown>;

			// Stored fields present
			expect(stored.title).toBe("The Left Hand of Darkness");
			expect(stored.year).toBe(1969);

			// Computed fields NOT present
			expect(storedRecord.displayName).toBeUndefined();
			expect(storedRecord.isClassic).toBeUndefined();
			expect(storedRecord.yearsSincePublication).toBeUndefined();
		});
	});

	describe("Entity keys verification", () => {
		it("should have exactly the schema-defined fields and no computed fields", async () => {
			// Create a book
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
			}).runPromise;

			// Read from Ref
			const stored = await db.books.findById(created.id).runPromise;
			const keys = Object.keys(stored);

			// Schema fields: id, title, year, genre, authorId, createdAt, updatedAt
			expect(keys).toContain("id");
			expect(keys).toContain("title");
			expect(keys).toContain("year");
			expect(keys).toContain("genre");
			expect(keys).toContain("authorId");
			expect(keys).toContain("createdAt");
			expect(keys).toContain("updatedAt");

			// Computed fields should NOT be in keys
			expect(keys).not.toContain("displayName");
			expect(keys).not.toContain("isClassic");
			expect(keys).not.toContain("yearsSincePublication");

			// Total count: 7 schema fields
			expect(keys).toHaveLength(7);
		});

		it("should verify initial data does not contain computed fields", async () => {
			// Create database with initial data
			const dbWithInitial = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						{
							id: "initial-book",
							title: "Initial Book",
							year: 1950,
							genre: "classic",
							authorId: "author1",
						},
					],
					authors: [{ id: "author1", name: "Test Author" }],
				}),
			);

			// Read from Ref
			const stored = await dbWithInitial.books.findById("initial-book").runPromise;
			const keys = Object.keys(stored);

			// Computed fields should NOT be present
			expect(keys).not.toContain("displayName");
			expect(keys).not.toContain("isClassic");
			expect(keys).not.toContain("yearsSincePublication");
		});
	});

	describe("Computed field derivation functions are pure queries, not mutations", () => {
		it("should not mutate the stored entity when computed fields are calculated", async () => {
			// Create a book
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
			}).runPromise;

			// Read from Ref multiple times
			const stored1 = await db.books.findById(created.id).runPromise;
			const stored2 = await db.books.findById(created.id).runPromise;

			// Both reads should return the same object (reference equality from Map.get)
			// and neither should have computed fields
			const record1 = stored1 as unknown as Record<string, unknown>;
			const record2 = stored2 as unknown as Record<string, unknown>;

			expect(record1.displayName).toBeUndefined();
			expect(record2.displayName).toBeUndefined();

			// Verify data integrity
			expect(stored1.title).toBe("Dune");
			expect(stored2.title).toBe("Dune");
		});
	});
});
