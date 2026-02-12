/**
 * Tests for REST handlers — CRUD operations via framework-agnostic handlers.
 *
 * Task 11.7: Test GET collection returns all entities.
 */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "@proseql/core";
import { createRestHandlers } from "../src/handlers.js";
import type { RestRequest } from "../src/handlers.js";

// ============================================================================
// Test Schemas
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});

// ============================================================================
// Test Config
// ============================================================================

const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Initial Test Data
// ============================================================================

const initialBooks = [
	{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
	{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi" },
	{ id: "3", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969, genre: "sci-fi" },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a minimal RestRequest for testing.
 */
const createRequest = (overrides: Partial<RestRequest> = {}): RestRequest => ({
	params: {},
	query: {},
	body: undefined,
	...overrides,
});

/**
 * Find a route handler by method and path pattern.
 */
const findRoute = (
	routes: ReadonlyArray<{ method: string; path: string; handler: (req: RestRequest) => Promise<unknown> }>,
	method: string,
	path: string,
) => {
	return routes.find((r) => r.method === method && r.path === path);
};

// ============================================================================
// Task 11.7: Test GET collection returns all entities
// ============================================================================

describe("REST handlers — GET collection (task 11.7)", () => {
	it("should return all entities when no query params are provided", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		expect(getBooks).toBeDefined();

		const request = createRequest();
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		expect(Array.isArray(response.body)).toBe(true);
		expect((response.body as ReadonlyArray<unknown>).length).toBe(3);

		// Verify entities are returned in expected order
		const books = response.body as ReadonlyArray<{ id: string; title: string }>;
		expect(books[0].title).toBe("Dune");
		expect(books[1].title).toBe("Neuromancer");
		expect(books[2].title).toBe("The Left Hand of Darkness");
	});

	it("should return empty array for empty collection", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest();
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		expect(response.body).toEqual([]);
	});

	it("should return correct content-type header is not set (left to framework adapter)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest();
		const response = await getBooks!.handler(request);

		// Headers are optional and typically set by the framework adapter
		expect(response.status).toBe(200);
	});

	it("should generate GET routes for all collections in config", async () => {
		const multiConfig = {
			books: { schema: BookSchema, relationships: {} },
			authors: {
				schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
				relationships: {},
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(multiConfig, {
				books: initialBooks,
				authors: [{ id: "a1", name: "Frank Herbert" }],
			}),
		);
		const routes = createRestHandlers(multiConfig, db);

		const getBooksRoute = findRoute(routes, "GET", "/books");
		const getAuthorsRoute = findRoute(routes, "GET", "/authors");

		expect(getBooksRoute).toBeDefined();
		expect(getAuthorsRoute).toBeDefined();

		// Verify books route returns books
		const booksResponse = await getBooksRoute!.handler(createRequest());
		expect(booksResponse.status).toBe(200);
		expect((booksResponse.body as ReadonlyArray<unknown>).length).toBe(3);

		// Verify authors route returns authors
		const authorsResponse = await getAuthorsRoute!.handler(createRequest());
		expect(authorsResponse.status).toBe(200);
		expect((authorsResponse.body as ReadonlyArray<unknown>).length).toBe(1);
	});

	it("should return all entity fields in response", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest();
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<Record<string, unknown>>;

		// Verify all fields are present
		const dune = books.find((b) => b.id === "1");
		expect(dune).toBeDefined();
		expect(dune!.id).toBe("1");
		expect(dune!.title).toBe("Dune");
		expect(dune!.author).toBe("Frank Herbert");
		expect(dune!.year).toBe(1965);
		expect(dune!.genre).toBe("sci-fi");
	});
});

// ============================================================================
// Task 11.8: Test GET collection with query params returns filtered results
// ============================================================================

describe("REST handlers — GET collection with query params (task 11.8)", () => {
	it("should filter by simple equality (genre=sci-fi)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { genre: "sci-fi" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; genre: string }>;
		expect(books.length).toBe(3); // All test books are sci-fi
		for (const book of books) {
			expect(book.genre).toBe("sci-fi");
		}
	});

	it("should filter by numeric comparison (year[$gte]=1970)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { "year[$gte]": "1970" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; year: number; title: string }>;
		// Only Neuromancer (1984) is >= 1970
		expect(books.length).toBe(1);
		expect(books[0].title).toBe("Neuromancer");
		expect(books[0].year).toBe(1984);
	});

	it("should filter by multiple operators on same field (year[$gte]=1965&year[$lte]=1970)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({
			query: { "year[$gte]": "1965", "year[$lte]": "1970" },
		});
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; year: number; title: string }>;
		// Dune (1965) and Left Hand (1969) are in range
		expect(books.length).toBe(2);
		for (const book of books) {
			expect(book.year).toBeGreaterThanOrEqual(1965);
			expect(book.year).toBeLessThanOrEqual(1970);
		}
	});

	it("should filter with $lt operator (year[$lt]=1970)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { "year[$lt]": "1970" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; year: number; title: string }>;
		// Dune (1965) and Left Hand (1969) are < 1970
		expect(books.length).toBe(2);
		for (const book of books) {
			expect(book.year).toBeLessThan(1970);
		}
	});

	it("should apply sort parameter (sort=year:desc)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { sort: "year:desc" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; year: number; title: string }>;
		expect(books.length).toBe(3);
		// Should be sorted by year descending: Neuromancer (1984), Left Hand (1969), Dune (1965)
		expect(books[0].title).toBe("Neuromancer");
		expect(books[1].title).toBe("The Left Hand of Darkness");
		expect(books[2].title).toBe("Dune");
	});

	it("should apply limit parameter (limit=2)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { limit: "2" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string }>;
		expect(books.length).toBe(2);
	});

	it("should apply offset parameter (offset=1)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { offset: "1" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; title: string }>;
		// Skips first book (Dune)
		expect(books.length).toBe(2);
		expect(books[0].title).toBe("Neuromancer");
		expect(books[1].title).toBe("The Left Hand of Darkness");
	});

	it("should apply limit and offset together (limit=1&offset=1)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { limit: "1", offset: "1" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; title: string }>;
		// Skip 1, take 1 = second book only
		expect(books.length).toBe(1);
		expect(books[0].title).toBe("Neuromancer");
	});

	it("should apply select parameter (select=title,year)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { select: "title,year" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<Record<string, unknown>>;
		expect(books.length).toBe(3);

		// Should only have selected fields
		for (const book of books) {
			expect(book).toHaveProperty("title");
			expect(book).toHaveProperty("year");
			expect(book).not.toHaveProperty("author");
			expect(book).not.toHaveProperty("genre");
		}
	});

	it("should combine filter, sort, limit, offset, and select", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({
			query: {
				genre: "sci-fi",
				sort: "year:desc",
				limit: "2",
				offset: "0",
				select: "title,year",
			},
		});
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<Record<string, unknown>>;
		expect(books.length).toBe(2);

		// Sorted descending: first should be Neuromancer (1984)
		expect(books[0].title).toBe("Neuromancer");
		expect(books[0].year).toBe(1984);

		// Second should be Left Hand (1969)
		expect(books[1].title).toBe("The Left Hand of Darkness");
		expect(books[1].year).toBe(1969);

		// Only selected fields
		expect(books[0]).not.toHaveProperty("author");
		expect(books[0]).not.toHaveProperty("genre");
	});

	it("should return empty array when filter matches nothing", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { genre: "romance" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		expect(response.body).toEqual([]);
	});

	it("should filter by string operator ($contains)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { "title[$contains]": "Dark" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; title: string }>;
		expect(books.length).toBe(1);
		expect(books[0].title).toBe("The Left Hand of Darkness");
	});

	it("should filter by author", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBooks = findRoute(routes, "GET", "/books");
		const request = createRequest({ query: { author: "Frank Herbert" } });
		const response = await getBooks!.handler(request);

		expect(response.status).toBe(200);
		const books = response.body as ReadonlyArray<{ id: string; title: string; author: string }>;
		expect(books.length).toBe(1);
		expect(books[0].title).toBe("Dune");
		expect(books[0].author).toBe("Frank Herbert");
	});
});
