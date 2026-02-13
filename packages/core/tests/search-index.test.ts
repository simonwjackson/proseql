import { Effect, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/factories/database-effect.js";
import {
	addToSearchIndex,
	buildSearchIndex,
	lookupSearchIndex,
	resolveWithSearchIndex,
} from "../src/indexes/search-index.js";

// ============================================================================
// Test Data
// ============================================================================

type Book = {
	readonly id: string;
	readonly title: string;
	readonly author: string;
};

const sampleBooks: ReadonlyArray<Book> = [
	{ id: "1", title: "Dune", author: "Frank Herbert" },
	{ id: "2", title: "Neuromancer", author: "William Gibson" },
	{ id: "3", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin" },
	{ id: "4", title: "Duneland Adventures", author: "Some Author" },
];

// ============================================================================
// buildSearchIndex Tests
// ============================================================================

describe("buildSearchIndex", () => {
	it("7.1: builds index from entities", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const index = await Effect.runPromise(Ref.get(indexRef));

		// "dune" should map to book 1 and 4 (from "Dune" and "Duneland")
		expect(index.get("dune")?.has("1")).toBe(true);
		expect(index.get("duneland")?.has("4")).toBe(true);

		// "frank" should map to book 1
		expect(index.get("frank")?.has("1")).toBe(true);

		// "herbert" should map to book 1
		expect(index.get("herbert")?.has("1")).toBe(true);

		// "neuromancer" should map to book 2
		expect(index.get("neuromancer")?.has("2")).toBe(true);
	});

	it("7.1: handles empty entities array", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex<Book>(["title"], []),
		);
		const index = await Effect.runPromise(Ref.get(indexRef));

		expect(index.size).toBe(0);
	});

	it("7.1: handles empty fields array", async () => {
		const indexRef = await Effect.runPromise(buildSearchIndex([], sampleBooks));
		const index = await Effect.runPromise(Ref.get(indexRef));

		expect(index.size).toBe(0);
	});
});

// ============================================================================
// addToSearchIndex Tests
// ============================================================================

describe("addToSearchIndex", () => {
	it("8.1: adds a new entity to the search index", async () => {
		// Start with existing books in the index
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" };
		await Effect.runPromise(
			addToSearchIndex(indexRef, newBook, ["title", "author"]),
		);

		const index = await Effect.runPromise(Ref.get(indexRef));

		// New tokens should be in the index
		expect(index.get("snow")?.has("5")).toBe(true);
		expect(index.get("crash")?.has("5")).toBe(true);
		expect(index.get("neal")?.has("5")).toBe(true);
		expect(index.get("stephenson")?.has("5")).toBe(true);
	});

	it("8.1: can find newly added entity via lookup", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" };
		await Effect.runPromise(
			addToSearchIndex(indexRef, newBook, ["title", "author"]),
		);

		// Should be able to find the new book via search
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["snow"]));
		expect(ids.has("5")).toBe(true);
	});

	it("8.1: does not affect existing entries", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);

		// Verify initial state
		const idsBefore = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["dune"]),
		);
		expect(idsBefore.has("1")).toBe(true);
		expect(idsBefore.has("4")).toBe(true);

		// Add a new book
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" };
		await Effect.runPromise(
			addToSearchIndex(indexRef, newBook, ["title", "author"]),
		);

		// Existing entries should still be searchable
		const idsAfter = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["dune"]),
		);
		expect(idsAfter.has("1")).toBe(true);
		expect(idsAfter.has("4")).toBe(true);
	});

	it("8.1: adds to existing token sets when token already exists", async () => {
		// Create index with book containing "frank"
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);

		// Add another book with "Frank" in the title
		const newBook = { id: "5", title: "Frank's Adventure", author: "Someone" };
		await Effect.runPromise(
			addToSearchIndex(indexRef, newBook, ["title", "author"]),
		);

		// Both books should be in the "frank" token set
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["frank"]));
		expect(ids.has("1")).toBe(true); // Original "Frank Herbert"
		expect(ids.has("5")).toBe(true); // New "Frank's Adventure"
	});

	it("8.1: handles empty fields array", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const indexBefore = await Effect.runPromise(Ref.get(indexRef));
		const sizeBefore = indexBefore.size;

		// Add entity with no fields to index
		const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" };
		await Effect.runPromise(addToSearchIndex(indexRef, newBook, []));

		const indexAfter = await Effect.runPromise(Ref.get(indexRef));
		// Size should be unchanged
		expect(indexAfter.size).toBe(sizeBefore);
	});

	it("8.1: skips non-string fields", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex<Book>(["title", "author"], []),
		);

		// Add an entity with a non-existent field (simulating non-string)
		const entity = {
			id: "1",
			title: "Test",
			author: "Author",
			year: 1999,
		} as unknown as Book;
		await Effect.runPromise(
			addToSearchIndex(indexRef, entity, ["title", "year"]),
		);

		const index = await Effect.runPromise(Ref.get(indexRef));
		// Should have "test" from title, but nothing from year (number)
		expect(index.get("test")?.has("1")).toBe(true);
		// Should not have "1999" since year is a number
		expect(index.has("1999")).toBe(false);
	});
});

// ============================================================================
// lookupSearchIndex Tests
// ============================================================================

describe("lookupSearchIndex", () => {
	it("7.2: finds exact match for single token", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["dune"]));

		// Should find book 1 (Dune) and book 4 (Duneland Adventures - via prefix)
		expect(ids.has("1")).toBe(true);
		expect(ids.has("4")).toBe(true);
		expect(ids.size).toBe(2);
	});

	it("7.2: finds prefix matches", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["neuro"]));

		// Should find book 2 (Neuromancer via prefix match)
		expect(ids.has("2")).toBe(true);
		expect(ids.size).toBe(1);
	});

	it("7.2: intersects results for multi-token query (AND semantics)", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const ids = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["dune", "frank"]),
		);

		// Only book 1 has both "dune" (in title) and "frank" (in author)
		expect(ids.has("1")).toBe(true);
		expect(ids.size).toBe(1);
	});

	it("7.2: returns empty set when no match", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const ids = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["xyz123"]),
		);

		expect(ids.size).toBe(0);
	});

	it("7.2: returns empty set for empty query tokens", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, []));

		expect(ids.size).toBe(0);
	});

	it("7.2: returns empty set when one token has no matches", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		// "dune" matches, but "xyz" doesn't - intersection should be empty
		const ids = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["dune", "xyz"]),
		);

		expect(ids.size).toBe(0);
	});

	it("7.2: handles multiple tokens that all match same entity", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		// "william" and "gibson" both from book 2's author
		const ids = await Effect.runPromise(
			lookupSearchIndex(indexRef, ["william", "gibson"]),
		);

		expect(ids.has("2")).toBe(true);
		expect(ids.size).toBe(1);
	});

	it("7.2: prefix match includes longer tokens", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		// "le" should match "le" (from Le Guin) and "left" (from Left Hand)
		const ids = await Effect.runPromise(lookupSearchIndex(indexRef, ["le"]));

		// Book 3 has both "left" and "le" in its indexed fields
		expect(ids.has("3")).toBe(true);
	});
});

// ============================================================================
// resolveWithSearchIndex Tests
// ============================================================================

describe("resolveWithSearchIndex", () => {
	it("7.3: returns undefined when no search index is configured", async () => {
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ title: { $search: "dune" } },
				undefined,
				undefined,
				map,
			),
		);
		expect(result).toBeUndefined();
	});

	it("7.3: returns undefined when where clause has no $search", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ title: "Dune" },
				indexRef,
				["title", "author"],
				map,
			),
		);
		expect(result).toBeUndefined();
	});

	it("7.3: returns candidates for top-level $search when fields match index", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "dune", fields: ["title"] } },
				indexRef,
				["title", "author"],
				map,
			),
		);
		expect(result).not.toBeUndefined();
		// Should return books that contain "dune" token
		expect(result?.some((b) => b.id === "1")).toBe(true); // "Dune"
		expect(result?.some((b) => b.id === "4")).toBe(true); // "Duneland Adventures"
	});

	it("7.3: returns candidates for field-level $search when field is in index", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ title: { $search: "neuromancer" } },
				indexRef,
				["title", "author"],
				map,
			),
		);
		expect(result).not.toBeUndefined();
		expect(result?.length).toBe(1);
		expect(result?.[0].id).toBe("2");
	});

	it("7.3: returns undefined when queried fields are not covered by index", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title"], sampleBooks),
		); // Only title indexed
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "dune", fields: ["author"] } }, // Searching author which is not indexed
				indexRef,
				["title"], // Only title is indexed
				map,
			),
		);
		expect(result).toBeUndefined();
	});

	it("7.3: returns empty array when no matches found", async () => {
		const indexRef = await Effect.runPromise(
			buildSearchIndex(["title", "author"], sampleBooks),
		);
		const map = new Map(sampleBooks.map((b) => [b.id, b]));
		const result = await Effect.runPromise(
			resolveWithSearchIndex(
				{ $search: { query: "xyz123nonexistent", fields: ["title"] } },
				indexRef,
				["title", "author"],
				map,
			),
		);
		expect(result).not.toBeUndefined();
		expect(result?.length).toBe(0);
	});
});

// ============================================================================
// Search Index Integration in Query Pipeline Tests
// ============================================================================

describe("Search Index in Query Pipeline (task 7.3)", () => {
	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		author: Schema.String,
		year: Schema.Number,
	});

	const testBooks = [
		{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
		{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
		{
			id: "3",
			title: "The Left Hand of Darkness",
			author: "Ursula K. Le Guin",
			year: 1969,
		},
		{
			id: "4",
			title: "Duneland Adventures",
			author: "Some Author",
			year: 2020,
		},
	];

	it("7.3: uses search index to narrow candidates for $search queries", async () => {
		// Create database with searchIndex configured
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		);

		// Query with $search - should use the search index
		const results = await db.books.query({
			where: { $search: { query: "dune" } },
		}).runPromise;

		// Should find books with "dune" in title (Dune and Duneland Adventures)
		expect(results.length).toBe(2);
		expect(results.some((r) => r.id === "1")).toBe(true);
		expect(results.some((r) => r.id === "4")).toBe(true);
	});

	it("7.3: uses search index for field-level $search", async () => {
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		);

		// Query with field-level $search
		const results = await db.books.query({
			where: { title: { $search: "neuromancer" } },
		}).runPromise;

		expect(results.length).toBe(1);
		expect(results[0].id).toBe("2");
	});

	it("7.3: search index works with other filters", async () => {
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				searchIndex: ["title", "author"] as const,
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		);

		// Query with $search and additional filter
		const results = await db.books.query({
			where: {
				$search: { query: "dune" },
				year: { $lt: 2000 },
			},
		}).runPromise;

		// Should only find Dune (1965), not Duneland Adventures (2020)
		expect(results.length).toBe(1);
		expect(results[0].id).toBe("1");
	});

	it("7.3: search without searchIndex config still works (full scan)", async () => {
		// Create database WITHOUT searchIndex configured
		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				// No searchIndex configured
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: testBooks,
			}),
		);

		// Query with $search should still work via full scan
		const results = await db.books.query({
			where: { $search: { query: "dune" } },
		}).runPromise;

		// Should still find books with "dune"
		expect(results.length).toBe(2);
	});
});

// ============================================================================
// Nested Search Index Tests (task 7.3)
// ============================================================================

describe("Nested Search Index (task 7.3)", () => {
	// Schema with nested fields
	const NestedBookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		genre: Schema.String,
		metadata: Schema.Struct({
			description: Schema.String,
			tags: Schema.Array(Schema.String),
			stats: Schema.Struct({
				views: Schema.Number,
			}),
		}),
		author: Schema.Struct({
			name: Schema.String,
			bio: Schema.String,
		}),
	});

	const nestedTestBooks = [
		{
			id: "1",
			title: "Dune",
			genre: "sci-fi",
			metadata: {
				description: "Epic desert planet saga about spice and sandworms",
				tags: ["sci-fi", "classic"],
				stats: { views: 1000 },
			},
			author: {
				name: "Frank Herbert",
				bio: "American science fiction author",
			},
		},
		{
			id: "2",
			title: "Neuromancer",
			genre: "cyberpunk",
			metadata: {
				description: "Groundbreaking cyberpunk novel about hackers and AI",
				tags: ["cyberpunk", "noir"],
				stats: { views: 800 },
			},
			author: {
				name: "William Gibson",
				bio: "Father of cyberpunk literature",
			},
		},
		{
			id: "3",
			title: "Foundation",
			genre: "sci-fi",
			metadata: {
				description: "Psychohistory and the fall of a galactic empire",
				tags: ["sci-fi", "space opera"],
				stats: { views: 1200 },
			},
			author: {
				name: "Isaac Asimov",
				bio: "Prolific science fiction and popular science author",
			},
		},
	];

	describe("buildSearchIndex with nested fields", () => {
		it("7.3: builds index from nested field metadata.description", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["metadata.description"], nestedTestBooks),
			);
			const index = await Effect.runPromise(Ref.get(indexRef));

			// "desert" from book 1's metadata.description
			expect(index.get("desert")?.has("1")).toBe(true);
			// "cyberpunk" from book 2's metadata.description
			expect(index.get("cyberpunk")?.has("2")).toBe(true);
			// "psychohistory" from book 3's metadata.description
			expect(index.get("psychohistory")?.has("3")).toBe(true);
		});

		it("7.3: builds index from nested field author.bio", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["author.bio"], nestedTestBooks),
			);
			const index = await Effect.runPromise(Ref.get(indexRef));

			// "american" from book 1's author.bio
			expect(index.get("american")?.has("1")).toBe(true);
			// "father" from book 2's author.bio
			expect(index.get("father")?.has("2")).toBe(true);
			// "prolific" from book 3's author.bio
			expect(index.get("prolific")?.has("3")).toBe(true);
		});

		it("7.3: builds index from multiple nested fields", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(
					["metadata.description", "author.bio"],
					nestedTestBooks,
				),
			);
			const index = await Effect.runPromise(Ref.get(indexRef));

			// Check tokens from both fields are indexed
			// From metadata.description
			expect(index.get("desert")?.has("1")).toBe(true);
			expect(index.get("hackers")?.has("2")).toBe(true);
			// From author.bio
			expect(index.get("american")?.has("1")).toBe(true);
			expect(index.get("prolific")?.has("3")).toBe(true);
		});

		it("7.3: builds index from mix of flat and nested fields", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["title", "metadata.description"], nestedTestBooks),
			);
			const index = await Effect.runPromise(Ref.get(indexRef));

			// From flat field "title"
			expect(index.get("dune")?.has("1")).toBe(true);
			expect(index.get("neuromancer")?.has("2")).toBe(true);
			expect(index.get("foundation")?.has("3")).toBe(true);
			// From nested field "metadata.description"
			expect(index.get("desert")?.has("1")).toBe(true);
			expect(index.get("cyberpunk")?.has("2")).toBe(true);
		});

		it("7.3: skips non-string nested fields gracefully", async () => {
			// metadata.stats.views is a number, should be skipped
			const indexRef = await Effect.runPromise(
				buildSearchIndex(
					["metadata.stats.views", "metadata.description"],
					nestedTestBooks,
				),
			);
			const index = await Effect.runPromise(Ref.get(indexRef));

			// Should not have the number indexed as a string
			expect(index.has("1000")).toBe(false);
			expect(index.has("800")).toBe(false);
			// But description should still be indexed
			expect(index.get("desert")?.has("1")).toBe(true);
		});
	});

	describe("lookupSearchIndex with nested indexed fields", () => {
		it("7.3: finds entities via nested field tokens", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["metadata.description"], nestedTestBooks),
			);

			const ids = await Effect.runPromise(
				lookupSearchIndex(indexRef, ["sandworms"]),
			);
			expect(ids.has("1")).toBe(true);
			expect(ids.size).toBe(1);
		});

		it("7.3: multi-token search works with nested fields", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["metadata.description"], nestedTestBooks),
			);

			// Both "hackers" and "ai" are in book 2's description
			const ids = await Effect.runPromise(
				lookupSearchIndex(indexRef, ["hackers", "ai"]),
			);
			expect(ids.has("2")).toBe(true);
			expect(ids.size).toBe(1);
		});

		it("7.3: prefix match works with nested fields", async () => {
			const indexRef = await Effect.runPromise(
				buildSearchIndex(["metadata.description"], nestedTestBooks),
			);

			// "psycho" should prefix-match "psychohistory" from book 3
			const ids = await Effect.runPromise(
				lookupSearchIndex(indexRef, ["psycho"]),
			);
			expect(ids.has("3")).toBe(true);
		});
	});

	describe("Search Index Integration with nested fields in database", () => {
		it("7.3: searchIndex with nested field builds correct inverted index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: nestedTestBooks,
				}),
			);

			// Search for term only in nested description field
			const results = await db.books.query({
				where: { $search: { query: "sandworms" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("1");
			expect(results[0].title).toBe("Dune");
		});

		it("7.3: searchIndex with deeply nested path builds correct index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["author.bio"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: nestedTestBooks,
				}),
			);

			// Search for term only in nested author.bio field
			const results = await db.books.query({
				where: { $search: { query: "cyberpunk literature" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("2");
		});

		it("7.3: searchIndex with multiple nested fields works", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description", "author.bio"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: nestedTestBooks,
				}),
			);

			// Search for term in description
			const descResults = await db.books.query({
				where: { $search: { query: "galactic empire" } },
			}).runPromise;
			expect(descResults.length).toBe(1);
			expect(descResults[0].id).toBe("3");

			// Search for term in author.bio
			const bioResults = await db.books.query({
				where: { $search: { query: "american" } },
			}).runPromise;
			expect(bioResults.length).toBe(1);
			expect(bioResults[0].id).toBe("1");
		});

		it("7.3: searchIndex with mix of flat and nested fields works", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["title", "metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: nestedTestBooks,
				}),
			);

			// Search for term in title (flat field)
			const titleResults = await db.books.query({
				where: { $search: { query: "foundation" } },
			}).runPromise;
			expect(titleResults.length).toBe(1);
			expect(titleResults[0].id).toBe("3");

			// Search for term in metadata.description (nested field)
			const descResults = await db.books.query({
				where: { $search: { query: "hackers" } },
			}).runPromise;
			expect(descResults.length).toBe(1);
			expect(descResults[0].id).toBe("2");
		});

		it("7.3: top-level $search with specific nested fields uses index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description", "author.bio"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: nestedTestBooks,
				}),
			);

			// Search with explicit nested fields
			const results = await db.books.query({
				where: {
					$search: { query: "prolific", fields: ["author.bio"] },
				},
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("3"); // Asimov's bio contains "prolific"
		});
	});
});

// ============================================================================
// Search Index Maintenance with Nested Fields (task 7.4)
// ============================================================================

describe("Search Index Maintenance with Nested Fields (task 7.4)", () => {
	// Schema with nested fields for testing index maintenance
	const NestedBookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		genre: Schema.String,
		metadata: Schema.Struct({
			description: Schema.String,
			tags: Schema.Array(Schema.String),
			stats: Schema.Struct({
				views: Schema.Number,
			}),
		}),
		author: Schema.Struct({
			name: Schema.String,
			bio: Schema.String,
		}),
	});

	const createNestedBook = (
		id: string,
		title: string,
		description: string,
		bio: string,
	) => ({
		id,
		title,
		genre: "sci-fi",
		metadata: {
			description,
			tags: ["test"],
			stats: { views: 100 },
		},
		author: {
			name: "Test Author",
			bio,
		},
	});

	describe("create operation maintains search index with nested fields", () => {
		it("7.4: creating entity adds nested field tokens to search index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description", "author.bio"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { books: [] }),
			);

			// Create a new entity with nested fields
			await db.books.create(
				createNestedBook(
					"1",
					"Test Book",
					"Epic adventure with dragons and wizards",
					"A fantasy author from the mountains",
				),
			).runPromise;

			// Search for token from nested metadata.description
			const descResults = await db.books.query({
				where: { $search: { query: "dragons" } },
			}).runPromise;
			expect(descResults.length).toBe(1);
			expect(descResults[0].id).toBe("1");

			// Search for token from nested author.bio
			const bioResults = await db.books.query({
				where: { $search: { query: "mountains" } },
			}).runPromise;
			expect(bioResults.length).toBe(1);
			expect(bioResults[0].id).toBe("1");
		});

		it("7.4: creating multiple entities builds correct nested field index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { books: [] }),
			);

			// Create multiple entities
			await db.books.create(
				createNestedBook(
					"1",
					"Book One",
					"Story about spaceships",
					"Author bio 1",
				),
			).runPromise;
			await db.books.create(
				createNestedBook(
					"2",
					"Book Two",
					"Tale of ancient kingdoms",
					"Author bio 2",
				),
			).runPromise;
			await db.books.create(
				createNestedBook(
					"3",
					"Book Three",
					"Adventures in spaceships and kingdoms",
					"Author bio 3",
				),
			).runPromise;

			// Search should find correct entities
			const spaceResults = await db.books.query({
				where: { $search: { query: "spaceships" } },
			}).runPromise;
			expect(spaceResults.length).toBe(2);
			expect(spaceResults.some((r) => r.id === "1")).toBe(true);
			expect(spaceResults.some((r) => r.id === "3")).toBe(true);

			const kingdomResults = await db.books.query({
				where: { $search: { query: "kingdoms" } },
			}).runPromise;
			expect(kingdomResults.length).toBe(2);
			expect(kingdomResults.some((r) => r.id === "2")).toBe(true);
			expect(kingdomResults.some((r) => r.id === "3")).toBe(true);
		});
	});

	describe("update operation maintains search index with nested fields", () => {
		it("7.4: updating nested field updates search index tokens", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook(
							"1",
							"Test Book",
							"Story about pirates and treasure",
							"Bio",
						),
					],
				}),
			);

			// Verify initial state - can find by "pirates"
			const initialResults = await db.books.query({
				where: { $search: { query: "pirates" } },
			}).runPromise;
			expect(initialResults.length).toBe(1);

			// Update the nested description field
			await db.books.update("1", {
				metadata: {
					description: "Story about ninjas and stealth",
				},
			}).runPromise;

			// Old token "pirates" should no longer find the entity
			const pirateResults = await db.books.query({
				where: { $search: { query: "pirates" } },
			}).runPromise;
			expect(pirateResults.length).toBe(0);

			// New token "ninjas" should find the entity
			const ninjaResults = await db.books.query({
				where: { $search: { query: "ninjas" } },
			}).runPromise;
			expect(ninjaResults.length).toBe(1);
			expect(ninjaResults[0].id).toBe("1");
		});

		it("7.4: updating non-indexed nested field does not affect search index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook(
							"1",
							"Test Book",
							"Story about robots",
							"Original bio",
						),
					],
				}),
			);

			// Update non-indexed nested field (author.bio is not in searchIndex)
			await db.books.update("1", {
				author: {
					bio: "Updated bio with unique terms like xylophone",
				},
			}).runPromise;

			// Original indexed content should still be searchable
			const robotResults = await db.books.query({
				where: { $search: { query: "robots" } },
			}).runPromise;
			expect(robotResults.length).toBe(1);
			expect(robotResults[0].id).toBe("1");

			// New non-indexed content should NOT be searchable via index
			// (Note: it might still work via full-scan $search, but index won't help)
			// This test verifies the index itself wasn't modified
		});

		it("7.4: partial update of nested object preserves other nested fields in index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description", "author.bio"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook(
							"1",
							"Test Book",
							"Story about elephants",
							"Expert on wildlife conservation",
						),
					],
				}),
			);

			// Update only metadata.description, leaving author.bio unchanged
			await db.books.update("1", {
				metadata: {
					description: "Story about dolphins",
				},
			}).runPromise;

			// New description term should be findable
			const dolphinResults = await db.books.query({
				where: { $search: { query: "dolphins" } },
			}).runPromise;
			expect(dolphinResults.length).toBe(1);

			// Old description term should not be findable
			const elephantResults = await db.books.query({
				where: { $search: { query: "elephants" } },
			}).runPromise;
			expect(elephantResults.length).toBe(0);

			// Unchanged author.bio should still be searchable
			const conservationResults = await db.books.query({
				where: { $search: { query: "conservation" } },
			}).runPromise;
			expect(conservationResults.length).toBe(1);
			expect(conservationResults[0].id).toBe("1");
		});
	});

	describe("delete operation maintains search index with nested fields", () => {
		it("7.4: deleting entity removes nested field tokens from search index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook(
							"1",
							"Book One",
							"Tale of unicorns and magic",
							"Bio 1",
						),
						createNestedBook(
							"2",
							"Book Two",
							"Story of dragons and fire",
							"Bio 2",
						),
					],
				}),
			);

			// Verify both books are searchable
			const initialUnicorn = await db.books.query({
				where: { $search: { query: "unicorns" } },
			}).runPromise;
			expect(initialUnicorn.length).toBe(1);
			expect(initialUnicorn[0].id).toBe("1");

			const initialDragon = await db.books.query({
				where: { $search: { query: "dragons" } },
			}).runPromise;
			expect(initialDragon.length).toBe(1);
			expect(initialDragon[0].id).toBe("2");

			// Delete first book
			await db.books.delete("1").runPromise;

			// Deleted book's tokens should not be findable
			const afterUnicorn = await db.books.query({
				where: { $search: { query: "unicorns" } },
			}).runPromise;
			expect(afterUnicorn.length).toBe(0);

			// Remaining book should still be searchable
			const afterDragon = await db.books.query({
				where: { $search: { query: "dragons" } },
			}).runPromise;
			expect(afterDragon.length).toBe(1);
			expect(afterDragon[0].id).toBe("2");
		});

		it("7.4: deleting entity with shared tokens only removes that entity from index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook("1", "Book One", "Epic adventure story", "Bio 1"),
						createNestedBook(
							"2",
							"Book Two",
							"Another adventure tale",
							"Bio 2",
						),
					],
				}),
			);

			// Both books share "adventure" token
			const initialAdventure = await db.books.query({
				where: { $search: { query: "adventure" } },
			}).runPromise;
			expect(initialAdventure.length).toBe(2);

			// Delete first book
			await db.books.delete("1").runPromise;

			// "adventure" should still find book 2
			const afterAdventure = await db.books.query({
				where: { $search: { query: "adventure" } },
			}).runPromise;
			expect(afterAdventure.length).toBe(1);
			expect(afterAdventure[0].id).toBe("2");

			// "epic" (unique to book 1) should not be findable
			const afterEpic = await db.books.query({
				where: { $search: { query: "epic" } },
			}).runPromise;
			expect(afterEpic.length).toBe(0);
		});

		it("7.4: deleteMany removes all matching entities from search index", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					books: [
						createNestedBook("1", "Book One", "First unique content", "Bio 1"),
						createNestedBook("2", "Book Two", "Second unique content", "Bio 2"),
						createNestedBook("3", "Book Three", "Third distinct text", "Bio 3"),
					],
				}),
			);

			// Delete books with "unique" in description
			await db.books.deleteMany((book) =>
				book.metadata.description.includes("unique"),
			).runPromise;

			// Books 1 and 2 should be gone
			const firstResults = await db.books.query({
				where: { $search: { query: "first" } },
			}).runPromise;
			expect(firstResults.length).toBe(0);

			const secondResults = await db.books.query({
				where: { $search: { query: "second" } },
			}).runPromise;
			expect(secondResults.length).toBe(0);

			// Book 3 should still be searchable
			const thirdResults = await db.books.query({
				where: { $search: { query: "distinct" } },
			}).runPromise;
			expect(thirdResults.length).toBe(1);
			expect(thirdResults[0].id).toBe("3");
		});
	});

	describe("combined operations maintain search index integrity", () => {
		it("7.4: create-update-delete sequence maintains correct index state", async () => {
			const config = {
				books: {
					schema: NestedBookSchema,
					relationships: {},
					searchIndex: ["metadata.description"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { books: [] }),
			);

			// Create
			await db.books.create(
				createNestedBook("1", "Book", "Initial content about astronomy", "Bio"),
			).runPromise;

			let results = await db.books.query({
				where: { $search: { query: "astronomy" } },
			}).runPromise;
			expect(results.length).toBe(1);

			// Update
			await db.books.update("1", {
				metadata: { description: "Updated content about biology" },
			}).runPromise;

			results = await db.books.query({
				where: { $search: { query: "astronomy" } },
			}).runPromise;
			expect(results.length).toBe(0);

			results = await db.books.query({
				where: { $search: { query: "biology" } },
			}).runPromise;
			expect(results.length).toBe(1);

			// Delete
			await db.books.delete("1").runPromise;

			results = await db.books.query({
				where: { $search: { query: "biology" } },
			}).runPromise;
			expect(results.length).toBe(0);
		});
	});
});

// ============================================================================
// $search Query Against Nested Indexed Fields (task 7.5)
// ============================================================================

describe("$search Query Against Nested Indexed Fields (task 7.5)", () => {
	// Schema with nested fields for testing $search queries
	const ArticleSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		content: Schema.Struct({
			summary: Schema.String,
			body: Schema.String,
			metadata: Schema.Struct({
				keywords: Schema.String,
				category: Schema.String,
			}),
		}),
		author: Schema.Struct({
			name: Schema.String,
			profile: Schema.String,
		}),
	});

	const createArticle = (
		id: string,
		title: string,
		summary: string,
		body: string,
		keywords: string,
		category: string,
		authorName: string,
		authorProfile: string,
	) => ({
		id,
		title,
		content: {
			summary,
			body,
			metadata: {
				keywords,
				category,
			},
		},
		author: {
			name: authorName,
			profile: authorProfile,
		},
	});

	const testArticles = [
		createArticle(
			"1",
			"Introduction to TypeScript",
			"A beginner guide to TypeScript programming",
			"TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
			"typescript javascript programming",
			"technology",
			"Alice Johnson",
			"Senior software engineer specializing in frontend development",
		),
		createArticle(
			"2",
			"Machine Learning Basics",
			"Understanding neural networks and deep learning",
			"Machine learning is a subset of artificial intelligence that enables systems to learn.",
			"ai machinelearning deeplearning",
			"science",
			"Bob Smith",
			"Data scientist with expertise in neural networks",
		),
		createArticle(
			"3",
			"Cooking Italian Pasta",
			"Traditional recipes from Italy",
			"Learn how to make authentic Italian pasta dishes from scratch.",
			"cooking recipes italian",
			"lifestyle",
			"Maria Romano",
			"Professional chef trained in Italian cuisine",
		),
		createArticle(
			"4",
			"Advanced TypeScript Patterns",
			"Design patterns and advanced techniques in TypeScript",
			"Explore generics, decorators, and other advanced TypeScript features.",
			"typescript patterns generics",
			"technology",
			"Charlie Brown",
			"Full-stack developer passionate about clean code",
		),
	];

	describe("field-level $search on nested indexed field", () => {
		it("7.5: field-level $search on nested path returns correct results", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary", "content.body"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "neural" in content.summary field
			const results = await db.articles.query({
				where: { "content.summary": { $search: "neural" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("2");
			expect(results[0].title).toBe("Machine Learning Basics");
		});

		it("7.5: field-level $search on deeply nested path returns correct results", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: [
						"content.metadata.keywords",
						"content.metadata.category",
					] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "typescript" in content.metadata.keywords
			const results = await db.articles.query({
				where: { "content.metadata.keywords": { $search: "typescript" } },
			}).runPromise;

			expect(results.length).toBe(2);
			expect(results.some((r) => r.id === "1")).toBe(true);
			expect(results.some((r) => r.id === "4")).toBe(true);
		});

		it("7.5: field-level $search with multi-word query on nested field", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["author.profile"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "neural networks" in author.profile (both words must match)
			const results = await db.articles.query({
				where: { "author.profile": { $search: "neural networks" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("2");
		});

		it("7.5: field-level $search with no matches returns empty array", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for term that doesn't exist
			const results = await db.articles.query({
				where: { "content.summary": { $search: "quantum" } },
			}).runPromise;

			expect(results.length).toBe(0);
		});
	});

	describe("top-level $search with explicit nested fields", () => {
		it("7.5: top-level $search with single nested field returns correct results", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: [
						"content.summary",
						"content.body",
						"author.profile",
					] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search only in content.summary
			const results = await db.articles.query({
				where: { $search: { query: "beginner", fields: ["content.summary"] } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("1");
		});

		it("7.5: top-level $search with multiple nested fields returns union of matches", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary", "author.profile"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search in both content.summary and author.profile
			// "italian" appears in article 3's summary and author.profile
			const results = await db.articles.query({
				where: {
					$search: {
						query: "italian",
						fields: ["content.summary", "author.profile"],
					},
				},
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("3");
		});

		it("7.5: top-level $search with nested fields and additional filters", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: [
						"content.metadata.category",
						"content.summary",
					] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "technology" category AND title containing "Advanced"
			const results = await db.articles.query({
				where: {
					$search: {
						query: "technology",
						fields: ["content.metadata.category"],
					},
					title: { $contains: "Advanced" },
				},
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("4");
			expect(results[0].title).toBe("Advanced TypeScript Patterns");
		});

		it("7.5: top-level $search without explicit fields searches all indexed nested fields", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary", "author.profile"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// "chef" appears only in author.profile of article 3
			const results = await db.articles.query({
				where: { $search: { query: "chef" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("3");
		});
	});

	describe("$search with mixed flat and nested indexed fields", () => {
		it("7.5: $search works when index has both flat and nested fields", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["title", "content.summary", "author.name"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "TypeScript" - appears in title of articles 1 and 4
			const titleResults = await db.articles.query({
				where: { $search: { query: "typescript", fields: ["title"] } },
			}).runPromise;
			expect(titleResults.length).toBe(2);

			// Search for "beginner" - appears only in content.summary of article 1
			const summaryResults = await db.articles.query({
				where: { $search: { query: "beginner", fields: ["content.summary"] } },
			}).runPromise;
			expect(summaryResults.length).toBe(1);
			expect(summaryResults[0].id).toBe("1");

			// Search for "Maria" - appears only in author.name of article 3
			const authorResults = await db.articles.query({
				where: { $search: { query: "maria", fields: ["author.name"] } },
			}).runPromise;
			expect(authorResults.length).toBe(1);
			expect(authorResults[0].id).toBe("3");
		});

		it("7.5: cross-field search finds terms across different nested levels", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["title", "content.summary", "content.body"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "typescript" and "superset" - both terms exist but in different fields
			// "typescript" in title, "superset" in content.body for article 1
			const results = await db.articles.query({
				where: { $search: { query: "typescript superset" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("1");
		});
	});

	describe("$search query result ordering and accuracy", () => {
		it("7.5: $search returns all matching entities for nested field query", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.metadata.category"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "technology" - articles 1 and 4 have this category
			const results = await db.articles.query({
				where: { $search: { query: "technology" } },
			}).runPromise;

			expect(results.length).toBe(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("1");
			expect(ids).toContain("4");
		});

		it("7.5: $search with prefix matching works on nested fields", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.metadata.keywords"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "machine" - should prefix-match "machinelearning" in article 2
			const results = await db.articles.query({
				where: { $search: { query: "machine" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("2");
		});

		it("7.5: $search combined with sort on nested field query results", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.metadata.category"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "technology" and sort by title descending
			const results = await db.articles.query({
				where: { $search: { query: "technology" } },
				sort: { title: "desc" },
			}).runPromise;

			expect(results.length).toBe(2);
			// "Introduction to TypeScript" should come after "Advanced TypeScript Patterns" in desc order
			expect(results[0].title).toBe("Introduction to TypeScript");
			expect(results[1].title).toBe("Advanced TypeScript Patterns");
		});

		it("7.5: $search combined with pagination on nested field query results", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.metadata.category"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search for "technology" with pagination
			const page1 = await db.articles.query({
				where: { $search: { query: "technology" } },
				sort: { title: "asc" },
				limit: 1,
				offset: 0,
			}).runPromise;

			expect(page1.length).toBe(1);
			expect(page1[0].title).toBe("Advanced TypeScript Patterns");

			const page2 = await db.articles.query({
				where: { $search: { query: "technology" } },
				sort: { title: "asc" },
				limit: 1,
				offset: 1,
			}).runPromise;

			expect(page2.length).toBe(1);
			expect(page2[0].title).toBe("Introduction to TypeScript");
		});

		it("7.5: $search with select returns only requested fields", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search and select only specific fields
			const results = await db.articles.query({
				where: { $search: { query: "neural" } },
				select: ["id", "title"],
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("2");
			expect(results[0].title).toBe("Machine Learning Basics");
			// Other fields should not be present
			expect("content" in results[0]).toBe(false);
			expect("author" in results[0]).toBe(false);
		});
	});

	describe("edge cases for $search on nested indexed fields", () => {
		it("7.5: $search handles empty query string gracefully", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Empty query should return all articles
			const results = await db.articles.query({
				where: { $search: { query: "" } },
			}).runPromise;

			expect(results.length).toBe(4);
		});

		it("7.5: $search handles whitespace-only query gracefully", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Whitespace-only query should return all articles
			const results = await db.articles.query({
				where: { $search: { query: "   " } },
			}).runPromise;

			expect(results.length).toBe(4);
		});

		it("7.5: $search is case-insensitive on nested fields", async () => {
			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["author.name"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: testArticles }),
			);

			// Search with different cases
			const lowercaseResults = await db.articles.query({
				where: { $search: { query: "alice" } },
			}).runPromise;
			expect(lowercaseResults.length).toBe(1);

			const uppercaseResults = await db.articles.query({
				where: { $search: { query: "ALICE" } },
			}).runPromise;
			expect(uppercaseResults.length).toBe(1);

			const mixedResults = await db.articles.query({
				where: { $search: { query: "AlIcE" } },
			}).runPromise;
			expect(mixedResults.length).toBe(1);
		});

		it("7.5: $search with special characters in nested field", async () => {
			// Create an article with special characters in nested field
			const specialArticles = [
				createArticle(
					"special",
					"Special Article",
					"Contains C++ and .NET frameworks",
					"Programming with C++ is fun",
					"c++ dotnet",
					"technology",
					"Test Author",
					"Expert in C++ and .NET development",
				),
			];

			const config = {
				articles: {
					schema: ArticleSchema,
					relationships: {},
					searchIndex: ["content.summary", "author.profile"] as const,
				},
			} as const;

			const db = await Effect.runPromise(
				createEffectDatabase(config, { articles: specialArticles }),
			);

			// Search for "NET" (from ".NET")
			const results = await db.articles.query({
				where: { $search: { query: "net" } },
			}).runPromise;

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("special");
		});
	});
});
