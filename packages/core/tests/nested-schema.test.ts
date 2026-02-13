/**
 * Nested Schema Integration Tests (Task 9)
 *
 * End-to-end tests for nested schema support including filtering, sorting,
 * aggregation, pagination, updates, persistence, computed fields, and reactive queries.
 */

import { Chunk, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "../src/factories/database-effect.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";

// ============================================================================
// Test Schema (Task 9.1)
// ============================================================================

/**
 * Test schema with nested objects:
 * - id: string
 * - title: string
 * - genre: string
 * - metadata: { views: number, rating: number, tags: string[], description: string }
 * - author: { name: string, country: string }
 */
const NestedBookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	genre: Schema.String,
	metadata: Schema.Struct({
		views: Schema.Number,
		rating: Schema.Number,
		tags: Schema.Array(Schema.String),
		description: Schema.String,
	}),
	author: Schema.Struct({
		name: Schema.String,
		country: Schema.String,
	}),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type NestedBook = Schema.Schema.Type<typeof NestedBookSchema>;

// ============================================================================
// Test Configuration
// ============================================================================

const config = {
	books: {
		schema: NestedBookSchema,
		relationships: {},
	},
} as const;

// Config with indexes on nested fields
const indexedConfig = {
	books: {
		schema: NestedBookSchema,
		indexes: ["metadata.views", "metadata.rating", "author.country"] as const,
		relationships: {},
	},
} as const;

// Config with search index on nested fields
const searchIndexedConfig = {
	books: {
		schema: NestedBookSchema,
		searchIndex: ["title", "metadata.description", "author.name"] as const,
		relationships: {},
	},
} as const;

// Config with computed fields based on nested data
const computedConfig = {
	books: {
		schema: NestedBookSchema,
		relationships: {},
		computed: {
			viewCount: (book: NestedBook) => book.metadata.views,
			isHighlyRated: (book: NestedBook) => book.metadata.rating >= 4,
			authorCountry: (book: NestedBook) => book.author.country,
			summary: (book: NestedBook) =>
				`${book.title} by ${book.author.name} (${book.metadata.rating}/5)`,
		},
	},
} as const;

// Config for persistence tests
const persistentConfig = {
	books: {
		schema: NestedBookSchema,
		file: "/data/nested-books.json",
		relationships: {},
	},
} as const;

// ============================================================================
// Test Data
// ============================================================================

const testBooks: ReadonlyArray<
	Omit<NestedBook, "createdAt" | "updatedAt" | "id"> & { id: string }
> = [
	{
		id: "b1",
		title: "Dune",
		genre: "sci-fi",
		metadata: {
			views: 1000,
			rating: 5,
			tags: ["classic", "space", "politics"],
			description: "A science fiction epic about desert planet Arrakis",
		},
		author: {
			name: "Frank Herbert",
			country: "USA",
		},
	},
	{
		id: "b2",
		title: "Neuromancer",
		genre: "sci-fi",
		metadata: {
			views: 800,
			rating: 4,
			tags: ["cyberpunk", "hacking"],
			description: "The book that launched the cyberpunk genre",
		},
		author: {
			name: "William Gibson",
			country: "USA",
		},
	},
	{
		id: "b3",
		title: "The Hobbit",
		genre: "fantasy",
		metadata: {
			views: 1200,
			rating: 5,
			tags: ["adventure", "dragons"],
			description: "A fantastical journey through Middle-earth",
		},
		author: {
			name: "J.R.R. Tolkien",
			country: "UK",
		},
	},
	{
		id: "b4",
		title: "1984",
		genre: "dystopian",
		metadata: {
			views: 600,
			rating: 4,
			tags: ["political", "surveillance"],
			description: "A chilling vision of totalitarian future",
		},
		author: {
			name: "George Orwell",
			country: "UK",
		},
	},
	{
		id: "b5",
		title: "Foundation",
		genre: "sci-fi",
		metadata: {
			views: 400,
			rating: 3,
			tags: ["space", "empire"],
			description: "The fall and rise of galactic civilization",
		},
		author: {
			name: "Isaac Asimov",
			country: "USA",
		},
	},
];

// ============================================================================
// Test Helpers
// ============================================================================

const createTestDb = () =>
	Effect.runPromise(createEffectDatabase(config, { books: testBooks }));

const createIndexedTestDb = () =>
	Effect.runPromise(createEffectDatabase(indexedConfig, { books: testBooks }));

const createSearchIndexedTestDb = () =>
	Effect.runPromise(
		createEffectDatabase(searchIndexedConfig, { books: testBooks }),
	);

const createComputedTestDb = () =>
	Effect.runPromise(createEffectDatabase(computedConfig, { books: testBooks }));

const makeTestLayer = (store?: Map<string, string>) => {
	const s = store ?? new Map<string, string>();
	return {
		store: s,
		layer: Layer.merge(
			makeInMemoryStorageLayer(s),
			makeSerializerLayer([jsonCodec(), yamlCodec()]),
		),
	};
};

// ============================================================================
// Integration Tests (Tasks 9.1 - 9.9)
// ============================================================================

describe("Nested Schema Integration Tests", () => {
	// =========================================================================
	// Task 9.1: Schema Setup Verification
	// =========================================================================
	describe("Task 9.1: Schema with nested objects", () => {
		it("should create a database with nested schema", async () => {
			const db = await createTestDb();
			expect(db).toBeDefined();
			expect(db.books).toBeDefined();
		});

		it("should load entities with nested fields intact", async () => {
			const db = await createTestDb();
			const books = await db.books.query().runPromise;

			expect(books).toHaveLength(5);

			// Verify nested metadata structure
			const dune = books.find((b) => b.id === "b1");
			expect(dune).toBeDefined();
			expect(dune?.metadata.views).toBe(1000);
			expect(dune?.metadata.rating).toBe(5);
			expect(dune?.metadata.tags).toContain("classic");
			expect(dune?.metadata.description).toContain("desert planet");

			// Verify nested author structure
			expect(dune?.author.name).toBe("Frank Herbert");
			expect(dune?.author.country).toBe("USA");
		});

		it("should preserve nested structure in findById", async () => {
			const db = await createTestDb();
			const book = await db.books.findById("b3").runPromise;

			expect(book.title).toBe("The Hobbit");
			expect(book.metadata.views).toBe(1200);
			expect(book.metadata.rating).toBe(5);
			expect(book.author.name).toBe("J.R.R. Tolkien");
			expect(book.author.country).toBe("UK");
		});
	});

	// =========================================================================
	// Task 9.2: End-to-end query with nested filter + sort + select
	// =========================================================================
	describe("Task 9.2: Nested filter + sort + select", () => {
		it("should filter by nested field using shape-mirroring", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: { metadata: { rating: 5 } },
			}).runPromise;

			expect(results).toHaveLength(2);
			expect(results.map((b) => b.title)).toContain("Dune");
			expect(results.map((b) => b.title)).toContain("The Hobbit");
		});

		it("should filter by nested field using dot-notation", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: { "metadata.rating": 5 },
			}).runPromise;

			expect(results).toHaveLength(2);
			expect(results.map((b) => b.title)).toContain("Dune");
			expect(results.map((b) => b.title)).toContain("The Hobbit");
		});

		it("should filter with nested operators", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: { metadata: { views: { $gt: 700 } } },
				sort: { title: "asc" },
			}).runPromise;

			expect(results).toHaveLength(3);
			expect(results[0].title).toBe("Dune");
			expect(results[1].title).toBe("Neuromancer");
			expect(results[2].title).toBe("The Hobbit");
		});

		it("should sort by nested field", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				sort: { "metadata.views": "desc" },
			}).runPromise;

			expect(results).toHaveLength(5);
			expect(results[0].title).toBe("The Hobbit"); // 1200 views
			expect(results[1].title).toBe("Dune"); // 1000 views
			expect(results[2].title).toBe("Neuromancer"); // 800 views
			expect(results[3].title).toBe("1984"); // 600 views
			expect(results[4].title).toBe("Foundation"); // 400 views
		});

		it("should combine nested filter, sort, and limit", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: { author: { country: "USA" } },
				sort: { "metadata.rating": "desc" },
				limit: 2,
			}).runPromise;

			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Dune"); // rating 5
			expect(results[1].title).toBe("Neuromancer"); // rating 4
		});

		it("should select specific fields including nested paths", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				select: ["title", "metadata", "author"],
			}).runPromise;

			expect(results).toHaveLength(5);
			for (const book of results) {
				expect(book).toHaveProperty("title");
				expect(book).toHaveProperty("metadata");
				expect(book).toHaveProperty("author");
				// id is excluded when not in select
				expect(Object.keys(book)).not.toContain("genre");
			}
		});
	});

	// =========================================================================
	// Task 9.3: Nested filter + pagination (offset-based)
	// =========================================================================
	describe("Task 9.3: Nested filter + offset pagination", () => {
		it("should paginate filtered results with offset", async () => {
			const db = await createTestDb();

			// First page
			const page1 = await db.books.query({
				where: { metadata: { rating: { $gte: 4 } } },
				sort: { title: "asc" },
				limit: 2,
				offset: 0,
			}).runPromise;

			expect(page1).toHaveLength(2);
			expect(page1[0].title).toBe("1984");
			expect(page1[1].title).toBe("Dune");

			// Second page
			const page2 = await db.books.query({
				where: { metadata: { rating: { $gte: 4 } } },
				sort: { title: "asc" },
				limit: 2,
				offset: 2,
			}).runPromise;

			expect(page2).toHaveLength(2);
			expect(page2[0].title).toBe("Neuromancer");
			expect(page2[1].title).toBe("The Hobbit");
		});

		it("should handle empty page at end of results", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: { metadata: { rating: 5 } },
				sort: { title: "asc" },
				limit: 2,
				offset: 10, // Beyond available data
			}).runPromise;

			expect(results).toHaveLength(0);
		});
	});

	// =========================================================================
	// Task 9.4: Nested filter + cursor pagination
	// =========================================================================
	describe("Task 9.4: Nested filter + cursor pagination", () => {
		it("should paginate filtered results with cursor", async () => {
			const db = await createTestDb();

			// First page using cursor pagination
			const page1 = await db.books.query({
				where: { author: { country: "USA" } },
				sort: { title: "asc" },
				cursor: { key: "title", limit: 2 },
			}).runPromise;

			expect(page1.items).toHaveLength(2);
			expect(page1.items[0].title).toBe("Dune");
			expect(page1.items[1].title).toBe("Foundation");
			expect(page1.pageInfo.hasNextPage).toBe(true);
			expect(page1.pageInfo.endCursor).toBe("Foundation");

			// Second page using cursor
			const page2 = await db.books.query({
				where: { author: { country: "USA" } },
				sort: { title: "asc" },
				cursor: { key: "title", after: page1.pageInfo.endCursor, limit: 2 },
			}).runPromise;

			expect(page2.items).toHaveLength(1);
			expect(page2.items[0].title).toBe("Neuromancer");
			expect(page2.pageInfo.hasNextPage).toBe(false);
		});

		it("should handle cursor on nested field sort", async () => {
			const db = await createTestDb();

			const page1 = await db.books.query({
				where: { genre: "sci-fi" },
				sort: { "metadata.views": "desc" },
				cursor: { key: "metadata.views", limit: 2 },
			}).runPromise;

			expect(page1.items).toHaveLength(2);
			// Sorted by views desc: Dune (1000), Neuromancer (800), Foundation (400)
			expect(page1.items[0].title).toBe("Dune");
			expect(page1.items[1].title).toBe("Neuromancer");
		});
	});

	// =========================================================================
	// Task 9.5: Nested filter + aggregation
	// =========================================================================
	describe("Task 9.5: Nested filter + aggregation", () => {
		it("should aggregate with nested field filter", async () => {
			const db = await createTestDb();
			const result = await db.books.aggregate({
				where: { metadata: { rating: { $gte: 4 } } },
				count: true,
				sum: "metadata.views",
				avg: "metadata.rating",
			}).runPromise;

			// Books with rating >= 4: Dune (5), Neuromancer (4), The Hobbit (5), 1984 (4)
			expect(result.count).toBe(4);
			// Sum of views: 1000 + 800 + 1200 + 600 = 3600
			expect(result.sum?.["metadata.views"]).toBe(3600);
			// Avg of ratings: (5 + 4 + 5 + 4) / 4 = 4.5
			expect(result.avg?.["metadata.rating"]).toBe(4.5);
		});

		it("should group by nested field", async () => {
			const db = await createTestDb();
			const result = await db.books.aggregate({
				groupBy: "author.country",
				count: true,
				avg: "metadata.rating",
			}).runPromise;

			expect(result).toHaveLength(2);

			const usaGroup = result.find((g) => g.group["author.country"] === "USA");
			const ukGroup = result.find((g) => g.group["author.country"] === "UK");

			// USA: Dune, Neuromancer, Foundation → 3 books
			expect(usaGroup?.count).toBe(3);
			// UK: The Hobbit, 1984 → 2 books
			expect(ukGroup?.count).toBe(2);

			// USA avg rating: (5 + 4 + 3) / 3 = 4
			expect(usaGroup?.avg?.["metadata.rating"]).toBe(4);
			// UK avg rating: (5 + 4) / 2 = 4.5
			expect(ukGroup?.avg?.["metadata.rating"]).toBe(4.5);
		});

		it("should combine nested filter and nested groupBy", async () => {
			const db = await createTestDb();
			const result = await db.books.aggregate({
				where: { metadata: { views: { $gte: 600 } } },
				groupBy: "metadata.rating",
				count: true,
			}).runPromise;

			// Books with views >= 600: Dune (5), Neuromancer (4), The Hobbit (5), 1984 (4)
			// Grouped by rating:
			// rating 5: Dune, The Hobbit → 2
			// rating 4: Neuromancer, 1984 → 2

			expect(result).toHaveLength(2);

			const rating5 = result.find((g) => g.group["metadata.rating"] === 5);
			const rating4 = result.find((g) => g.group["metadata.rating"] === 4);

			expect(rating5?.count).toBe(2);
			expect(rating4?.count).toBe(2);
		});
	});

	// =========================================================================
	// Task 9.6: Nested updates + re-query
	// =========================================================================
	describe("Task 9.6: Nested updates + re-query", () => {
		it("should deep merge nested updates", async () => {
			const db = await createTestDb();

			// Update only metadata.views, preserving other metadata fields
			await db.books.update("b1", {
				metadata: { views: 1500 },
			}).runPromise;

			const updated = await db.books.findById("b1").runPromise;

			expect(updated.metadata.views).toBe(1500);
			expect(updated.metadata.rating).toBe(5); // Preserved
			expect(updated.metadata.tags).toContain("classic"); // Preserved
			expect(updated.metadata.description).toContain("desert planet"); // Preserved
		});

		it("should apply nested operators", async () => {
			const db = await createTestDb();

			// Increment views using operator
			await db.books.update("b1", {
				metadata: { views: { $increment: 100 } },
			}).runPromise;

			const updated = await db.books.findById("b1").runPromise;
			expect(updated.metadata.views).toBe(1100); // 1000 + 100
		});

		it("should verify state consistency after nested update", async () => {
			const db = await createTestDb();

			// Update nested author field
			await db.books.update("b1", {
				author: { country: "CA" },
			}).runPromise;

			// Re-query with filter to verify state consistency
			const usaBooks = await db.books.query({
				where: { author: { country: "USA" } },
			}).runPromise;

			// Dune is now CA, so only Neuromancer and Foundation are USA
			expect(usaBooks).toHaveLength(2);
			expect(usaBooks.map((b) => b.title)).not.toContain("Dune");
			expect(usaBooks.map((b) => b.title)).toContain("Neuromancer");
			expect(usaBooks.map((b) => b.title)).toContain("Foundation");
		});

		it("should update multiple nested paths", async () => {
			const db = await createTestDb();

			await db.books.update("b2", {
				metadata: { rating: 5, views: { $increment: 200 } },
				author: { country: "CA" },
			}).runPromise;

			const updated = await db.books.findById("b2").runPromise;

			expect(updated.metadata.rating).toBe(5);
			expect(updated.metadata.views).toBe(1000); // 800 + 200
			expect(updated.author.country).toBe("CA");
			expect(updated.author.name).toBe("William Gibson"); // Preserved
		});
	});

	// =========================================================================
	// Task 9.7: Persistence round-trip with nested data
	// =========================================================================
	describe("Task 9.7: Persistence round-trip", () => {
		it("should persist nested data and reload intact", async () => {
			const { store, layer } = makeTestLayer();

			// Create database, add nested data, and flush
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: testBooks,
							}),
							layer,
						);

						// Modify nested field
						yield* db.books.update("b1", {
							metadata: { views: 9999 },
						});

						// Flush to storage
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify file exists
			expect(store.has("/data/nested-books.json")).toBe(true);

			// Reload from storage and verify nested data
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, { books: [] }),
							layer,
						);

						const reloaded = yield* db.books.findById("b1");

						expect(reloaded.title).toBe("Dune");
						expect(reloaded.metadata.views).toBe(9999); // Updated value
						expect(reloaded.metadata.rating).toBe(5); // Preserved
						expect(reloaded.metadata.tags).toContain("classic"); // Preserved
						expect(reloaded.author.name).toBe("Frank Herbert"); // Preserved
					}),
				),
			);
		});

		it("should preserve all nested structures through persistence", async () => {
			const { store, layer } = makeTestLayer();

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(persistentConfig, {
								books: testBooks,
							}),
							layer,
						);

						// Trigger a save by creating an entity
						yield* db.books.create({
							title: "Trigger Save",
							genre: "test",
							metadata: {
								views: 1,
								rating: 1,
								tags: [],
								description: "Trigger",
							},
							author: { name: "Test", country: "Test" },
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Parse persisted JSON and verify structure
			const parsed = JSON.parse(store.get("/data/nested-books.json")!);

			// Verify nested metadata structure
			expect(parsed.b1.metadata.views).toBe(1000);
			expect(parsed.b1.metadata.rating).toBe(5);
			expect(parsed.b1.metadata.tags).toEqual(["classic", "space", "politics"]);
			expect(parsed.b1.metadata.description).toBe(
				"A science fiction epic about desert planet Arrakis",
			);

			// Verify nested author structure
			expect(parsed.b1.author.name).toBe("Frank Herbert");
			expect(parsed.b1.author.country).toBe("USA");
		});
	});

	// =========================================================================
	// Task 9.8: Computed fields on nested source data
	// =========================================================================
	describe("Task 9.8: Computed fields on nested data", () => {
		it("should compute fields from nested source data", async () => {
			const db = await createComputedTestDb();
			const results = await db.books.query({ where: { id: "b1" } }).runPromise;

			expect(results).toHaveLength(1);
			const dune = results[0];

			// Computed from nested metadata.views
			expect(dune.viewCount).toBe(1000);

			// Computed from nested metadata.rating
			expect(dune.isHighlyRated).toBe(true);

			// Computed from nested author.country
			expect(dune.authorCountry).toBe("USA");

			// Computed from multiple nested paths
			expect(dune.summary).toBe("Dune by Frank Herbert (5/5)");
		});

		it("should filter on computed fields derived from nested data", async () => {
			const db = await createComputedTestDb();
			const results = await db.books.query({
				where: { isHighlyRated: true },
			}).runPromise;

			// Books with rating >= 4: Dune (5), Neuromancer (4), The Hobbit (5), 1984 (4)
			expect(results).toHaveLength(4);
		});

		it("should sort on computed fields derived from nested data", async () => {
			const db = await createComputedTestDb();
			const results = await db.books.query({
				sort: { viewCount: "desc" },
				limit: 3,
			}).runPromise;

			expect(results).toHaveLength(3);
			expect(results[0].title).toBe("The Hobbit"); // 1200 views
			expect(results[1].title).toBe("Dune"); // 1000 views
			expect(results[2].title).toBe("Neuromancer"); // 800 views
		});

		it("should update computed values after nested update", async () => {
			const db = await createComputedTestDb();

			// Foundation has rating 3, so isHighlyRated = false
			const before = await db.books.query({ where: { id: "b5" } }).runPromise;
			expect(before[0].isHighlyRated).toBe(false);

			// Update rating to 4
			await db.books.update("b5", { metadata: { rating: 4 } }).runPromise;

			// Now isHighlyRated should be true
			const after = await db.books.query({ where: { id: "b5" } }).runPromise;
			expect(after[0].isHighlyRated).toBe(true);
		});
	});

	// =========================================================================
	// Task 9.9: Reactive queries emit on nested field updates
	// =========================================================================
	describe("Task 9.9: Reactive queries emit on nested updates", () => {
		it("should emit on nested field update via watch", async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createEffectDatabase(config, { books: testBooks });

						// Watch books with rating >= 4
						const stream = yield* db.books.watch({
							where: { metadata: { rating: { $gte: 4 } } },
						});

						// Collect first emission (initial state)
						const firstEmission = yield* Stream.runCollect(
							Stream.take(stream, 1),
						);
						const initial = Chunk.toReadonlyArray(firstEmission)[0];

						// Should have 4 books with rating >= 4
						expect(initial).toHaveLength(4);

						// Update Foundation (rating 3) to have rating 4
						yield* db.books.update("b5", { metadata: { rating: 4 } });

						// Get next emission
						const secondEmission = yield* Stream.runCollect(
							Stream.take(stream, 1),
						);
						const updated = Chunk.toReadonlyArray(secondEmission)[0];

						// Now should have 5 books with rating >= 4
						expect(updated).toHaveLength(5);
						expect(updated.map((b) => b.id)).toContain("b5");
					}),
				),
			);
		});

		it("should emit on watchById when nested field changes", async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createEffectDatabase(config, { books: testBooks });

						// Watch a specific book
						const stream = yield* db.books.watchById("b1");

						// Get initial emission
						const firstEmission = yield* Stream.runCollect(
							Stream.take(stream, 1),
						);
						const initial = Chunk.toReadonlyArray(firstEmission)[0];

						expect(initial?.metadata.views).toBe(1000);

						// Update nested field
						yield* db.books.update("b1", { metadata: { views: 5000 } });

						// Get updated emission
						const secondEmission = yield* Stream.runCollect(
							Stream.take(stream, 1),
						);
						const updated = Chunk.toReadonlyArray(secondEmission)[0];

						expect(updated?.metadata.views).toBe(5000);
					}),
				),
			);
		});
	});

	// =========================================================================
	// Additional Integration Tests
	// =========================================================================
	describe("Additional nested schema scenarios", () => {
		it("should work with indexed nested fields", async () => {
			const db = await createIndexedTestDb();

			// Query using indexed nested field
			const results = await db.books.query({
				where: { "metadata.rating": 5 },
			}).runPromise;

			expect(results).toHaveLength(2);
			expect(results.map((b) => b.title)).toContain("Dune");
			expect(results.map((b) => b.title)).toContain("The Hobbit");
		});

		it("should search nested fields with search index", async () => {
			const db = await createSearchIndexedTestDb();

			// Search across title, metadata.description, and author.name
			const results = await db.books.query({
				where: {
					$search: { query: "cyberpunk", fields: ["metadata.description"] },
				},
			}).runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Neuromancer");
		});

		it("should handle $or with nested conditions", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: {
					$or: [
						{ metadata: { rating: 5 } },
						{ author: { country: "UK" } },
					],
				},
			}).runPromise;

			// rating 5: Dune, The Hobbit
			// UK authors: The Hobbit, 1984
			// Union (no duplicates): Dune, The Hobbit, 1984
			expect(results).toHaveLength(3);
			expect(results.map((b) => b.title)).toContain("Dune");
			expect(results.map((b) => b.title)).toContain("The Hobbit");
			expect(results.map((b) => b.title)).toContain("1984");
		});

		it("should handle $not with nested conditions", async () => {
			const db = await createTestDb();
			const results = await db.books.query({
				where: {
					$not: { author: { country: "USA" } },
				},
			}).runPromise;

			// Non-USA authors: The Hobbit (UK), 1984 (UK)
			expect(results).toHaveLength(2);
			expect(results.map((b) => b.title)).toContain("The Hobbit");
			expect(results.map((b) => b.title)).toContain("1984");
		});

		it("should create entity with nested fields", async () => {
			const db = await createTestDb();

			const newBook = await db.books.create({
				title: "Snow Crash",
				genre: "sci-fi",
				metadata: {
					views: 700,
					rating: 4,
					tags: ["metaverse", "linguistics"],
					description: "A dive into virtual reality and ancient Sumerian myths",
				},
				author: {
					name: "Neal Stephenson",
					country: "USA",
				},
			}).runPromise;

			expect(newBook.id).toBeDefined();
			expect(newBook.metadata.views).toBe(700);
			expect(newBook.metadata.tags).toContain("metaverse");
			expect(newBook.author.name).toBe("Neal Stephenson");

			// Verify it's queryable
			const found = await db.books.findById(newBook.id).runPromise;
			expect(found.title).toBe("Snow Crash");
			expect(found.metadata.rating).toBe(4);
		});

		it("should delete entity and verify nested queries update", async () => {
			const db = await createTestDb();

			// Delete a USA author's book
			await db.books.delete("b1").runPromise;

			// Verify USA books count reduced
			const usaBooks = await db.books.query({
				where: { author: { country: "USA" } },
			}).runPromise;

			expect(usaBooks).toHaveLength(2); // Was 3, now 2
			expect(usaBooks.map((b) => b.title)).not.toContain("Dune");
		});
	});
});
