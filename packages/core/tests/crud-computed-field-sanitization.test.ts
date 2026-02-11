import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect";
import type { EffectDatabase } from "../src/factories/database-effect";

/**
 * Task 7.4 & 7.5: Test CRUD input sanitization for computed fields.
 *
 * The design specifies that computed field names in create/update input should
 * be silently stripped before schema validation. TypeScript prevents computed
 * field names from appearing in autocompletion, but runtime input may still
 * contain them (e.g., from API payloads). This test verifies that:
 *
 * 1. Creating an entity with a computed field name in the input ignores the
 *    provided value and uses the derivation function instead.
 * 2. Updating an entity with a computed field name in the input ignores the
 *    provided value (computed fields are re-derived on query, not stored).
 *
 * The stripping happens in crud-factory.ts (tasks 7.1-7.2) and
 * crud-factory-with-relationships.ts (task 7.3).
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

type Book = typeof BookSchema.Type;

// Author schema
const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

// Database config with computed fields
const config = {
	books: {
		schema: BookSchema,
		relationships: {
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
		},
		// Computed fields - these are derived, not stored
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

describe("Task 7.4: Create with computed field names in input", () => {
	let db: EffectDatabase<typeof config>;

	beforeEach(async () => {
		db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: [],
				authors: [{ id: "author1", name: "Frank Herbert" }],
			}),
		);
	});

	describe("create() ignores computed field values in input", () => {
		it("should ignore displayName in create input and derive it from stored fields", async () => {
			// Attempt to create a book with a displayName in the input
			// TypeScript would normally prevent this, but runtime input may have it
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
				// Pass a wrong displayName - this should be IGNORED
				displayName: "WRONG VALUE - should be ignored",
			} as Parameters<typeof db.books.create>[0]).runPromise;

			// Read from Ref to verify stored value
			const stored = await db.books.findById(created.id).runPromise;

			// Stored entity should NOT have displayName (it's a computed field)
			const storedRecord = stored as unknown as Record<string, unknown>;
			expect(storedRecord.displayName).toBeUndefined();
			expect("displayName" in storedRecord).toBe(false);

			// Verify stored fields are correct
			expect(stored.title).toBe("Dune");
			expect(stored.year).toBe(1965);
		});

		it("should ignore isClassic boolean in create input", async () => {
			// isClassic should be true for year < 1980, but we pass false
			const created = await db.books.create({
				title: "Dune",
				year: 1965, // This makes isClassic = true
				genre: "sci-fi",
				authorId: "author1",
				// Pass wrong isClassic - this should be IGNORED
				isClassic: false,
			} as Parameters<typeof db.books.create>[0]).runPromise;

			// Read from Ref
			const stored = await db.books.findById(created.id).runPromise;

			// Stored entity should NOT have isClassic
			const storedRecord = stored as unknown as Record<string, unknown>;
			expect(storedRecord.isClassic).toBeUndefined();
			expect("isClassic" in storedRecord).toBe(false);

			// The stored year is correct (from which isClassic would be derived)
			expect(stored.year).toBe(1965);
		});

		it("should ignore yearsSincePublication in create input", async () => {
			const created = await db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
				// Pass wrong yearsSincePublication - this should be IGNORED
				yearsSincePublication: 999,
			} as Parameters<typeof db.books.create>[0]).runPromise;

			// Read from Ref
			const stored = await db.books.findById(created.id).runPromise;

			// Stored entity should NOT have yearsSincePublication
			const storedRecord = stored as unknown as Record<string, unknown>;
			expect(storedRecord.yearsSincePublication).toBeUndefined();
			expect("yearsSincePublication" in storedRecord).toBe(false);

			// Stored year is correct
			expect(stored.year).toBe(1965);
		});

		it("should ignore ALL computed fields when multiple are provided in create input", async () => {
			// Pass all computed fields with wrong values
			const created = await db.books.create({
				title: "Neuromancer",
				year: 1984,
				genre: "sci-fi",
				authorId: "author1",
				// All computed fields with wrong values - ALL should be IGNORED
				displayName: "WRONG DISPLAY NAME",
				isClassic: true, // Wrong: 1984 is >= 1980, so isClassic should be false
				yearsSincePublication: 0,
			} as Parameters<typeof db.books.create>[0]).runPromise;

			// Read from Ref
			const stored = await db.books.findById(created.id).runPromise;

			// None of the computed fields should be stored
			const storedRecord = stored as unknown as Record<string, unknown>;
			expect(storedRecord.displayName).toBeUndefined();
			expect(storedRecord.isClassic).toBeUndefined();
			expect(storedRecord.yearsSincePublication).toBeUndefined();

			// Only stored fields should be present
			const keys = Object.keys(stored);
			expect(keys).not.toContain("displayName");
			expect(keys).not.toContain("isClassic");
			expect(keys).not.toContain("yearsSincePublication");

			// Stored fields are correct
			expect(stored.title).toBe("Neuromancer");
			expect(stored.year).toBe(1984);
		});

		it("should preserve all stored fields while stripping computed fields", async () => {
			const created = await db.books.create({
				id: "custom-id",
				title: "The Left Hand of Darkness",
				year: 1969,
				genre: "sci-fi",
				authorId: "author1",
				// Computed field - should be ignored
				displayName: "IGNORED",
			} as Parameters<typeof db.books.create>[0]).runPromise;

			// All stored fields should be preserved exactly
			expect(created.id).toBe("custom-id");
			expect(created.title).toBe("The Left Hand of Darkness");
			expect(created.year).toBe(1969);
			expect(created.genre).toBe("sci-fi");
			expect(created.authorId).toBe("author1");
			expect(created.createdAt).toBeDefined();
			expect(created.updatedAt).toBeDefined();
		});
	});

	describe("createMany() ignores computed field values in inputs", () => {
		it("should ignore computed fields in batch create input", async () => {
			const result = await db.books.createMany([
				{
					title: "Dune",
					year: 1965,
					genre: "sci-fi",
					authorId: "author1",
					displayName: "WRONG",
					isClassic: false, // Wrong
				} as Parameters<typeof db.books.create>[0],
				{
					title: "Neuromancer",
					year: 1984,
					genre: "sci-fi",
					authorId: "author1",
					displayName: "ALSO WRONG",
					isClassic: true, // Wrong
				} as Parameters<typeof db.books.create>[0],
			]).runPromise;

			expect(result.created).toHaveLength(2);

			// Verify each stored entity has no computed fields
			for (const created of result.created) {
				const stored = await db.books.findById(created.id).runPromise;
				const storedRecord = stored as unknown as Record<string, unknown>;

				expect(storedRecord.displayName).toBeUndefined();
				expect(storedRecord.isClassic).toBeUndefined();
				expect("displayName" in storedRecord).toBe(false);
				expect("isClassic" in storedRecord).toBe(false);
			}
		});

		it("should preserve stored fields while stripping computed fields in batch", async () => {
			const result = await db.books.createMany([
				{
					id: "book1",
					title: "Dune",
					year: 1965,
					genre: "sci-fi",
					authorId: "author1",
					displayName: "IGNORED",
				} as Parameters<typeof db.books.create>[0],
				{
					id: "book2",
					title: "Neuromancer",
					year: 1984,
					genre: "cyberpunk",
					authorId: "author1",
					yearsSincePublication: 999, // IGNORED
				} as Parameters<typeof db.books.create>[0],
			]).runPromise;

			expect(result.created).toHaveLength(2);

			// First book
			const book1 = await db.books.findById("book1").runPromise;
			expect(book1.title).toBe("Dune");
			expect(book1.year).toBe(1965);
			expect(book1.genre).toBe("sci-fi");

			// Second book
			const book2 = await db.books.findById("book2").runPromise;
			expect(book2.title).toBe("Neuromancer");
			expect(book2.year).toBe(1984);
			expect(book2.genre).toBe("cyberpunk");
		});
	});

	describe("Schema validation still works after stripping computed fields", () => {
		it("should fail validation when required stored field is missing (not masked by computed field)", async () => {
			// Try to create with a computed field but missing required stored field
			// This should fail with ValidationError, not succeed
			const effect = db.books.create({
				// Missing 'title' - a required stored field
				year: 1965,
				genre: "sci-fi",
				authorId: "author1",
				displayName: "This won't save the day", // computed, gets stripped
			} as Parameters<typeof db.books.create>[0]);

			const result = await Effect.runPromise(Effect.flip(effect));

			expect(result._tag).toBe("ValidationError");
		});

		it("should validate stored field types correctly after stripping", async () => {
			// Pass invalid type for stored field, but valid computed field
			const effect = db.books.create({
				title: "Dune",
				year: "not a number" as unknown as number, // Invalid type
				genre: "sci-fi",
				authorId: "author1",
				displayName: "Dune (1965)", // Correct value, but should be stripped
			} as Parameters<typeof db.books.create>[0]);

			const result = await Effect.runPromise(Effect.flip(effect));

			expect(result._tag).toBe("ValidationError");
		});
	});

	describe("Foreign key validation still works after stripping computed fields", () => {
		it("should validate foreign keys correctly when computed fields are in input", async () => {
			const effect = db.books.create({
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
				authorId: "nonexistent-author", // Invalid FK
				displayName: "Dune (1965)", // computed, gets stripped
			} as Parameters<typeof db.books.create>[0]);

			const result = await Effect.runPromise(Effect.flip(effect));

			expect(result._tag).toBe("ForeignKeyError");
		});
	});
});
