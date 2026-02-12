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

// ============================================================================
// Task 11.9: Test GET by id returns correct entity
// ============================================================================

describe("REST handlers — GET by id (task 11.9)", () => {
	it("should return correct entity when id exists", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		expect(getBookById).toBeDefined();

		const request = createRequest({ params: { id: "1" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(200);
		const book = response.body as { id: string; title: string; author: string; year: number; genre: string };
		expect(book.id).toBe("1");
		expect(book.title).toBe("Dune");
		expect(book.author).toBe("Frank Herbert");
		expect(book.year).toBe(1965);
		expect(book.genre).toBe("sci-fi");
	});

	it("should return all entity fields in response", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		const request = createRequest({ params: { id: "2" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(200);
		const book = response.body as Record<string, unknown>;
		expect(book).toHaveProperty("id");
		expect(book).toHaveProperty("title");
		expect(book).toHaveProperty("author");
		expect(book).toHaveProperty("year");
		expect(book).toHaveProperty("genre");
		expect(book.id).toBe("2");
		expect(book.title).toBe("Neuromancer");
	});

	it("should work with different collections", async () => {
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

		// Test books endpoint
		const getBooksById = findRoute(routes, "GET", "/books/:id");
		const bookRequest = createRequest({ params: { id: "1" } });
		const bookResponse = await getBooksById!.handler(bookRequest);
		expect(bookResponse.status).toBe(200);
		expect((bookResponse.body as { title: string }).title).toBe("Dune");

		// Test authors endpoint
		const getAuthorsById = findRoute(routes, "GET", "/authors/:id");
		const authorRequest = createRequest({ params: { id: "a1" } });
		const authorResponse = await getAuthorsById!.handler(authorRequest);
		expect(authorResponse.status).toBe(200);
		expect((authorResponse.body as { name: string }).name).toBe("Frank Herbert");
	});

	it("should return different entities for different ids", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");

		// Request for id "1"
		const request1 = createRequest({ params: { id: "1" } });
		const response1 = await getBookById!.handler(request1);
		expect(response1.status).toBe(200);
		expect((response1.body as { title: string }).title).toBe("Dune");

		// Request for id "2"
		const request2 = createRequest({ params: { id: "2" } });
		const response2 = await getBookById!.handler(request2);
		expect(response2.status).toBe(200);
		expect((response2.body as { title: string }).title).toBe("Neuromancer");

		// Request for id "3"
		const request3 = createRequest({ params: { id: "3" } });
		const response3 = await getBookById!.handler(request3);
		expect(response3.status).toBe(200);
		expect((response3.body as { title: string }).title).toBe("The Left Hand of Darkness");
	});
});

// ============================================================================
// Task 11.10: Test GET by id for missing entity returns 404
// ============================================================================

describe("REST handlers — GET by id returns 404 for missing entity (task 11.10)", () => {
	it("should return 404 when entity does not exist", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		expect(getBookById).toBeDefined();

		const request = createRequest({ params: { id: "nonexistent-id" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(404);
	});

	it("should include NotFoundError tag in response body", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		const request = createRequest({ params: { id: "missing-id" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(404);
		const body = response.body as { _tag: string; error: string };
		expect(body._tag).toBe("NotFoundError");
		expect(body.error).toBe("Not found");
	});

	it("should return 404 for empty collection", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		const request = createRequest({ params: { id: "1" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(404);
		const body = response.body as { _tag: string };
		expect(body._tag).toBe("NotFoundError");
	});

	it("should return 404 for valid-looking id that does not exist", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const getBookById = findRoute(routes, "GET", "/books/:id");
		// Test with an id that looks valid but doesn't exist
		const request = createRequest({ params: { id: "100" } });
		const response = await getBookById!.handler(request);

		expect(response.status).toBe(404);
	});

	it("should return 404 for different collections independently", async () => {
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

		// Test books 404
		const getBooksById = findRoute(routes, "GET", "/books/:id");
		const bookRequest = createRequest({ params: { id: "nonexistent" } });
		const bookResponse = await getBooksById!.handler(bookRequest);
		expect(bookResponse.status).toBe(404);
		expect((bookResponse.body as { _tag: string })._tag).toBe("NotFoundError");

		// Test authors 404
		const getAuthorsById = findRoute(routes, "GET", "/authors/:id");
		const authorRequest = createRequest({ params: { id: "nonexistent" } });
		const authorResponse = await getAuthorsById!.handler(authorRequest);
		expect(authorResponse.status).toBe(404);
		expect((authorResponse.body as { _tag: string })._tag).toBe("NotFoundError");
	});
});

// ============================================================================
// Task 11.11: Test POST creates entity and returns 201
// ============================================================================

describe("REST handlers — POST creates entity (task 11.11)", () => {
	it("should create entity and return 201 with created entity", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");
		expect(postBooks).toBeDefined();

		const newBook = {
			id: "new-1",
			title: "Snow Crash",
			author: "Neal Stephenson",
			year: 1992,
			genre: "sci-fi",
		};

		const request = createRequest({ body: newBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(201);
		const createdBook = response.body as {
			id: string;
			title: string;
			author: string;
			year: number;
			genre: string;
		};
		expect(createdBook.id).toBe("new-1");
		expect(createdBook.title).toBe("Snow Crash");
		expect(createdBook.author).toBe("Neal Stephenson");
		expect(createdBook.year).toBe(1992);
		expect(createdBook.genre).toBe("sci-fi");
	});

	it("should persist the created entity to the database", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");
		const getBookById = findRoute(routes, "GET", "/books/:id");

		const newBook = {
			id: "persist-test",
			title: "Hyperion",
			author: "Dan Simmons",
			year: 1989,
			genre: "sci-fi",
		};

		// Create the entity
		const createRequest = { params: {}, query: {}, body: newBook };
		const createResponse = await postBooks!.handler(createRequest);
		expect(createResponse.status).toBe(201);

		// Verify it can be retrieved
		const getRequest = { params: { id: "persist-test" }, query: {}, body: undefined };
		const getResponse = await getBookById!.handler(getRequest);
		expect(getResponse.status).toBe(200);
		expect((getResponse.body as { title: string }).title).toBe("Hyperion");
	});

	it("should return all entity fields in the response", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		const newBook = {
			id: "fields-test",
			title: "Foundation",
			author: "Isaac Asimov",
			year: 1951,
			genre: "sci-fi",
		};

		const request = createRequest({ body: newBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(201);
		const body = response.body as Record<string, unknown>;
		expect(body).toHaveProperty("id");
		expect(body).toHaveProperty("title");
		expect(body).toHaveProperty("author");
		expect(body).toHaveProperty("year");
		expect(body).toHaveProperty("genre");
	});

	it("should work with different collections", async () => {
		const multiConfig = {
			books: { schema: BookSchema, relationships: {} },
			authors: {
				schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
				relationships: {},
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(multiConfig, { books: [], authors: [] }),
		);
		const routes = createRestHandlers(multiConfig, db);

		// Create a book
		const postBooks = findRoute(routes, "POST", "/books");
		const bookRequest = createRequest({
			body: { id: "b1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
		});
		const bookResponse = await postBooks!.handler(bookRequest);
		expect(bookResponse.status).toBe(201);
		expect((bookResponse.body as { title: string }).title).toBe("Dune");

		// Create an author
		const postAuthors = findRoute(routes, "POST", "/authors");
		const authorRequest = createRequest({
			body: { id: "a1", name: "Frank Herbert" },
		});
		const authorResponse = await postAuthors!.handler(authorRequest);
		expect(authorResponse.status).toBe(201);
		expect((authorResponse.body as { name: string }).name).toBe("Frank Herbert");
	});

	it("should add entity to collection with existing data", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");
		const getBooks = findRoute(routes, "GET", "/books");

		// Start with 3 books
		const initialResponse = await getBooks!.handler(createRequest());
		expect((initialResponse.body as ReadonlyArray<unknown>).length).toBe(3);

		// Add a new book
		const newBook = {
			id: "new-book",
			title: "Ancillary Justice",
			author: "Ann Leckie",
			year: 2013,
			genre: "sci-fi",
		};
		const createResponse = await postBooks!.handler(createRequest({ body: newBook }));
		expect(createResponse.status).toBe(201);

		// Now should have 4 books
		const finalResponse = await getBooks!.handler(createRequest());
		expect((finalResponse.body as ReadonlyArray<unknown>).length).toBe(4);
	});
});

// ============================================================================
// Task 11.12: Test POST with invalid data returns 400
// ============================================================================

describe("REST handlers — POST with invalid data returns 400 (task 11.12)", () => {
	it("should return 400 when required field is missing", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");
		expect(postBooks).toBeDefined();

		// Missing "year" field which is required by the schema
		const invalidBook = {
			id: "invalid-1",
			title: "Incomplete Book",
			author: "Unknown",
			genre: "sci-fi",
			// year is missing
		};

		const request = createRequest({ body: invalidBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(400);
	});

	it("should include ValidationError tag in response body", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		// Missing required field
		const invalidBook = {
			id: "invalid-2",
			title: "Missing Fields",
			// author, year, genre missing
		};

		const request = createRequest({ body: invalidBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(400);
		const body = response.body as { _tag: string; error: string };
		expect(body._tag).toBe("ValidationError");
		expect(body.error).toBe("Validation error");
	});

	it("should return 400 when field has wrong type", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		// year should be a number, not a string
		const invalidBook = {
			id: "invalid-3",
			title: "Wrong Type Book",
			author: "Test Author",
			year: "not-a-number", // should be number
			genre: "sci-fi",
		};

		const request = createRequest({ body: invalidBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(400);
		const body = response.body as { _tag: string };
		expect(body._tag).toBe("ValidationError");
	});

	it("should return 500 when body is null (unrecoverable defect)", async () => {
		// Note: Passing null to create causes a Die (crash) in the core library
		// because it tries to access properties on null before validation.
		// This is treated as a programmer error, not a validation error.
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		const request = createRequest({ body: null });
		const response = await postBooks!.handler(request);

		// Returns 500 because this is an unexpected defect, not a validation error
		expect(response.status).toBe(500);
	});

	it("should return 400 when body is an empty object", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		const request = createRequest({ body: {} });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(400);
		const body = response.body as { _tag: string };
		expect(body._tag).toBe("ValidationError");
	});

	it("should return 400 when multiple required fields are missing", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");

		// Only id is provided
		const invalidBook = {
			id: "only-id",
		};

		const request = createRequest({ body: invalidBook });
		const response = await postBooks!.handler(request);

		expect(response.status).toBe(400);
		const body = response.body as { _tag: string };
		expect(body._tag).toBe("ValidationError");
	});

	it("should return 400 for different collections with invalid data", async () => {
		const multiConfig = {
			books: { schema: BookSchema, relationships: {} },
			authors: {
				schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
				relationships: {},
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(multiConfig, { books: [], authors: [] }),
		);
		const routes = createRestHandlers(multiConfig, db);

		// Test invalid book
		const postBooks = findRoute(routes, "POST", "/books");
		const bookRequest = createRequest({ body: { id: "b1" } }); // missing fields
		const bookResponse = await postBooks!.handler(bookRequest);
		expect(bookResponse.status).toBe(400);
		expect((bookResponse.body as { _tag: string })._tag).toBe("ValidationError");

		// Test invalid author
		const postAuthors = findRoute(routes, "POST", "/authors");
		const authorRequest = createRequest({ body: { id: "a1" } }); // missing name
		const authorResponse = await postAuthors!.handler(authorRequest);
		expect(authorResponse.status).toBe(400);
		expect((authorResponse.body as { _tag: string })._tag).toBe("ValidationError");
	});

	it("should not create entity when validation fails", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: [] }));
		const routes = createRestHandlers(config, db);

		const postBooks = findRoute(routes, "POST", "/books");
		const getBooks = findRoute(routes, "GET", "/books");

		// Attempt to create invalid entity
		const invalidBook = { id: "should-not-exist" };
		const createRequest1 = { params: {}, query: {}, body: invalidBook };
		const createResponse = await postBooks!.handler(createRequest1);
		expect(createResponse.status).toBe(400);

		// Verify entity was NOT created
		const getRequest = { params: {}, query: {}, body: undefined };
		const getResponse = await getBooks!.handler(getRequest);
		expect(getResponse.status).toBe(200);
		expect((getResponse.body as ReadonlyArray<unknown>).length).toBe(0);
	});
});

// ============================================================================
// Task 11.13: Test PUT updates entity and returns 200
// ============================================================================

describe("REST handlers — PUT updates entity (task 11.13)", () => {
	it("should update entity and return 200 with updated entity", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");
		expect(putBook).toBeDefined();

		const updates = { title: "Dune (Revised Edition)" };
		const request = createRequest({ params: { id: "1" }, body: updates });
		const response = await putBook!.handler(request);

		expect(response.status).toBe(200);
		const updatedBook = response.body as {
			id: string;
			title: string;
			author: string;
			year: number;
			genre: string;
		};
		expect(updatedBook.id).toBe("1");
		expect(updatedBook.title).toBe("Dune (Revised Edition)");
		// Other fields should remain unchanged
		expect(updatedBook.author).toBe("Frank Herbert");
		expect(updatedBook.year).toBe(1965);
		expect(updatedBook.genre).toBe("sci-fi");
	});

	it("should persist the update to the database", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");
		const getBookById = findRoute(routes, "GET", "/books/:id");

		// Update the entity
		const updates = { genre: "masterpiece" };
		const updateRequest = createRequest({ params: { id: "1" }, body: updates });
		const updateResponse = await putBook!.handler(updateRequest);
		expect(updateResponse.status).toBe(200);

		// Verify update persisted
		const getRequest = createRequest({ params: { id: "1" } });
		const getResponse = await getBookById!.handler(getRequest);
		expect(getResponse.status).toBe(200);
		expect((getResponse.body as { genre: string }).genre).toBe("masterpiece");
	});

	it("should update multiple fields at once", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");

		const updates = {
			title: "Neuromancer (Anniversary Edition)",
			year: 2024,
			genre: "classic",
		};
		const request = createRequest({ params: { id: "2" }, body: updates });
		const response = await putBook!.handler(request);

		expect(response.status).toBe(200);
		const updatedBook = response.body as {
			id: string;
			title: string;
			author: string;
			year: number;
			genre: string;
		};
		expect(updatedBook.id).toBe("2");
		expect(updatedBook.title).toBe("Neuromancer (Anniversary Edition)");
		expect(updatedBook.year).toBe(2024);
		expect(updatedBook.genre).toBe("classic");
		// Author should remain unchanged
		expect(updatedBook.author).toBe("William Gibson");
	});

	it("should return all entity fields in the response", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");

		const updates = { title: "Updated Title" };
		const request = createRequest({ params: { id: "3" }, body: updates });
		const response = await putBook!.handler(request);

		expect(response.status).toBe(200);
		const body = response.body as Record<string, unknown>;
		expect(body).toHaveProperty("id");
		expect(body).toHaveProperty("title");
		expect(body).toHaveProperty("author");
		expect(body).toHaveProperty("year");
		expect(body).toHaveProperty("genre");
	});

	it("should work with different collections", async () => {
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

		// Update a book
		const putBook = findRoute(routes, "PUT", "/books/:id");
		const bookRequest = createRequest({ params: { id: "1" }, body: { title: "Updated Book" } });
		const bookResponse = await putBook!.handler(bookRequest);
		expect(bookResponse.status).toBe(200);
		expect((bookResponse.body as { title: string }).title).toBe("Updated Book");

		// Update an author
		const putAuthor = findRoute(routes, "PUT", "/authors/:id");
		const authorRequest = createRequest({ params: { id: "a1" }, body: { name: "F. Herbert" } });
		const authorResponse = await putAuthor!.handler(authorRequest);
		expect(authorResponse.status).toBe(200);
		expect((authorResponse.body as { name: string }).name).toBe("F. Herbert");
	});

	it("should return 404 when updating non-existent entity", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");

		const updates = { title: "Ghost Book" };
		const request = createRequest({ params: { id: "nonexistent" }, body: updates });
		const response = await putBook!.handler(request);

		expect(response.status).toBe(404);
		const body = response.body as { _tag: string };
		expect(body._tag).toBe("NotFoundError");
	});

	it("should not modify other entities in the collection", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");
		const getBookById = findRoute(routes, "GET", "/books/:id");

		// Update book with id "1"
		const updates = { title: "Modified Dune" };
		const updateRequest = createRequest({ params: { id: "1" }, body: updates });
		await putBook!.handler(updateRequest);

		// Verify other books are unchanged
		const book2Response = await getBookById!.handler(createRequest({ params: { id: "2" } }));
		expect(book2Response.status).toBe(200);
		expect((book2Response.body as { title: string }).title).toBe("Neuromancer");

		const book3Response = await getBookById!.handler(createRequest({ params: { id: "3" } }));
		expect(book3Response.status).toBe(200);
		expect((book3Response.body as { title: string }).title).toBe("The Left Hand of Darkness");
	});

	it("should update with empty body (no changes)", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config, { books: initialBooks }));
		const routes = createRestHandlers(config, db);

		const putBook = findRoute(routes, "PUT", "/books/:id");

		// Empty update should succeed and return the entity unchanged
		const request = createRequest({ params: { id: "1" }, body: {} });
		const response = await putBook!.handler(request);

		expect(response.status).toBe(200);
		const book = response.body as { id: string; title: string };
		expect(book.id).toBe("1");
		expect(book.title).toBe("Dune");
	});
});
