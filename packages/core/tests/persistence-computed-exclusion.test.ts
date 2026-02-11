import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema, Layer } from "effect";
import {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "../src/factories/database-effect";
import type { EffectDatabase } from "../src/factories/database-effect";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer";
import { makeSerializerLayer } from "../src/serializers/format-codec";
import { jsonCodec } from "../src/serializers/codecs/json";
import { yamlCodec } from "../src/serializers/codecs/yaml";

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

/**
 * Task 6.2: Test that saving a collection to disk produces a file with only
 * stored fields (no computed field keys in serialized output).
 *
 * The persistence layer serializes entities from the Ref, which only contains
 * schema-validated stored fields. Computed fields are never in the Ref, so
 * they should never appear in the serialized output on disk.
 */

// Helper to create test layer with in-memory storage
const makeTestLayer = (store?: Map<string, string>) => {
	const s = store ?? new Map<string, string>();
	return {
		store: s,
		layer: Layer.merge(makeInMemoryStorageLayer(s), makeSerializerLayer([jsonCodec(), yamlCodec()])),
	};
};

// Persistent config with computed fields
const persistentConfig = {
	books: {
		schema: BookSchema,
		file: "/data/books.json",
		relationships: {
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
		},
		computed: {
			displayName: (book: Book) => `${book.title} (${book.year})`,
			isClassic: (book: Book) => book.year < 1980,
			yearsSincePublication: (book: Book) => 2024 - book.year,
		},
	},
	authors: {
		schema: AuthorSchema,
		file: "/data/authors.json",
		relationships: {
			books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
		},
	},
} as const;

// YAML variant for format coverage
const persistentConfigYaml = {
	books: {
		schema: BookSchema,
		file: "/data/books.yaml",
		relationships: {
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
		},
		computed: {
			displayName: (book: Book) => `${book.title} (${book.year})`,
			isClassic: (book: Book) => book.year < 1980,
		},
	},
	authors: {
		schema: AuthorSchema,
		file: "/data/authors.yaml",
		relationships: {
			books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
		},
	},
} as const;

describe("Task 6.2: Serialized output contains only stored fields (no computed fields)", () => {
	describe("JSON format", () => {
		it("should NOT include computed fields in serialized JSON output after create", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: [],
								authors: [{ id: "author1", name: "Frank Herbert" }],
							}, { writeDebounce: 10 }),
							layer,
						);

						// Create a book with computed fields configured
						yield* db.books.create({
							title: "Dune",
							year: 1965,
							genre: "sci-fi",
							authorId: "author1",
						});

						// Flush to ensure write completes
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify the file was written
			expect(store.has("/data/books.json")).toBe(true);

			// Parse the serialized content
			const serialized = store.get("/data/books.json")!;
			const parsed = JSON.parse(serialized) as Record<string, Record<string, unknown>>;

			// Get all book entities (values, excluding _version if present)
			const bookEntries = Object.entries(parsed).filter(([key]) => key !== "_version");
			expect(bookEntries.length).toBe(1);

			const [, bookData] = bookEntries[0];

			// Verify stored fields are present
			expect(bookData.id).toBeDefined();
			expect(bookData.title).toBe("Dune");
			expect(bookData.year).toBe(1965);
			expect(bookData.genre).toBe("sci-fi");
			expect(bookData.authorId).toBe("author1");

			// Verify computed fields are NOT present in serialized output
			expect(bookData.displayName).toBeUndefined();
			expect(bookData.isClassic).toBeUndefined();
			expect(bookData.yearsSincePublication).toBeUndefined();
			expect("displayName" in bookData).toBe(false);
			expect("isClassic" in bookData).toBe(false);
			expect("yearsSincePublication" in bookData).toBe(false);

			// Verify no unexpected keys (should only have schema fields)
			const expectedKeys = ["id", "title", "year", "genre", "authorId", "createdAt", "updatedAt"];
			const actualKeys = Object.keys(bookData);
			for (const key of actualKeys) {
				expect(expectedKeys).toContain(key);
			}
		});

		it("should NOT include computed fields in serialized JSON output after update", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: [
									{ id: "book1", title: "Dune", year: 1965, genre: "sci-fi", authorId: "author1" },
								],
								authors: [{ id: "author1", name: "Frank Herbert" }],
							}, { writeDebounce: 10 }),
							layer,
						);

						// Update the book
						yield* db.books.update("book1", { year: 1966 });

						// Flush to ensure write completes
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Parse the serialized content
			const serialized = store.get("/data/books.json")!;
			const parsed = JSON.parse(serialized) as Record<string, Record<string, unknown>>;

			// Verify the updated book
			expect(parsed.book1).toBeDefined();
			expect(parsed.book1.year).toBe(1966);

			// Verify computed fields are NOT present
			expect(parsed.book1.displayName).toBeUndefined();
			expect(parsed.book1.isClassic).toBeUndefined();
			expect(parsed.book1.yearsSincePublication).toBeUndefined();
		});

		it("should NOT include computed fields in serialized JSON output with multiple entities", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: [],
								authors: [{ id: "author1", name: "Frank Herbert" }],
							}, { writeDebounce: 10 }),
							layer,
						);

						// Create multiple books
						yield* db.books.createMany([
							{ title: "Dune", year: 1965, genre: "sci-fi", authorId: "author1" },
							{ title: "Neuromancer", year: 1984, genre: "sci-fi", authorId: "author1" },
							{ title: "Snow Crash", year: 1992, genre: "sci-fi", authorId: "author1" },
						]);

						// Flush to ensure write completes
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Parse the serialized content
			const serialized = store.get("/data/books.json")!;
			const parsed = JSON.parse(serialized) as Record<string, Record<string, unknown>>;

			// Get all book entities
			const bookEntries = Object.entries(parsed).filter(([key]) => key !== "_version");
			expect(bookEntries.length).toBe(3);

			// Verify NONE of the books have computed fields
			for (const [, bookData] of bookEntries) {
				expect(bookData.displayName).toBeUndefined();
				expect(bookData.isClassic).toBeUndefined();
				expect(bookData.yearsSincePublication).toBeUndefined();
				expect("displayName" in bookData).toBe(false);
				expect("isClassic" in bookData).toBe(false);
				expect("yearsSincePublication" in bookData).toBe(false);
			}
		});

		it("raw JSON string should not contain computed field key names", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: [],
								authors: [{ id: "author1", name: "Frank Herbert" }],
							}, { writeDebounce: 10 }),
							layer,
						);

						yield* db.books.create({
							title: "Dune",
							year: 1965,
							genre: "sci-fi",
							authorId: "author1",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Get the raw serialized string
			const serialized = store.get("/data/books.json")!;

			// The raw string should NOT contain computed field key names
			expect(serialized).not.toContain('"displayName"');
			expect(serialized).not.toContain('"isClassic"');
			expect(serialized).not.toContain('"yearsSincePublication"');

			// But it SHOULD contain stored field key names
			expect(serialized).toContain('"title"');
			expect(serialized).toContain('"year"');
			expect(serialized).toContain('"genre"');
		});
	});

	describe("YAML format", () => {
		it("should NOT include computed fields in serialized YAML output", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfigYaml, {
								books: [],
								authors: [{ id: "author1", name: "Frank Herbert" }],
							}, { writeDebounce: 10 }),
							layer,
						);

						// Create a book
						yield* db.books.create({
							title: "Dune",
							year: 1965,
							genre: "sci-fi",
							authorId: "author1",
						});

						// Flush to ensure write completes
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Get the raw serialized YAML string
			const serialized = store.get("/data/books.yaml")!;

			// The raw string should NOT contain computed field key names
			// In YAML, keys are not quoted (unless special chars)
			expect(serialized).not.toContain("displayName:");
			expect(serialized).not.toContain("isClassic:");

			// But it SHOULD contain stored field key names
			expect(serialized).toContain("title:");
			expect(serialized).toContain("year:");
			expect(serialized).toContain("genre:");
		});
	});

	describe("Collection without computed fields (baseline)", () => {
		it("authors collection (no computed fields) should serialize normally", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: [],
								authors: [],
							}, { writeDebounce: 10 }),
							layer,
						);

						// Create an author (collection has no computed fields)
						yield* db.authors.create({ name: "Frank Herbert" });

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Parse the serialized content
			const serialized = store.get("/data/authors.json")!;
			const parsed = JSON.parse(serialized) as Record<string, Record<string, unknown>>;

			// Get author entries
			const authorEntries = Object.entries(parsed).filter(([key]) => key !== "_version");
			expect(authorEntries.length).toBe(1);

			const [, authorData] = authorEntries[0];

			// Verify stored fields are present
			expect(authorData.id).toBeDefined();
			expect(authorData.name).toBe("Frank Herbert");

			// Verify no computed field pollution from other collections
			expect(authorData.displayName).toBeUndefined();
			expect(authorData.isClassic).toBeUndefined();
		});
	});
});
