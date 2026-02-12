import { createEffectDatabase } from "@proseql/core";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	createRelationshipRoutes,
	extractRelationships,
} from "../src/relationship-routes.js";

// ============================================================================
// Test Schemas
// ============================================================================

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.optional(Schema.String),
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	authorId: Schema.String,
	year: Schema.optional(Schema.Number),
});

// ============================================================================
// Test Configuration
// ============================================================================

const config = {
	authors: {
		schema: AuthorSchema,
		relationships: {
			books: {
				type: "inverse" as const,
				target: "books" as const,
				foreignKey: "authorId",
			},
		},
	},
	books: {
		schema: BookSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "authors" as const,
				foreignKey: "authorId",
			},
		},
	},
} as const;

// ============================================================================
// Tests
// ============================================================================

describe("extractRelationships", () => {
	it("should extract relationships from config", () => {
		const relationships = extractRelationships(config);

		expect(relationships).toHaveLength(2);

		// authors.books (inverse)
		const authorBooks = relationships.find(
			(r) => r.sourceCollection === "authors" && r.relationshipName === "books",
		);
		expect(authorBooks).toBeDefined();
		expect(authorBooks?.relationship.type).toBe("inverse");
		expect(authorBooks?.relationship.target).toBe("books");

		// books.author (ref)
		const bookAuthor = relationships.find(
			(r) => r.sourceCollection === "books" && r.relationshipName === "author",
		);
		expect(bookAuthor).toBeDefined();
		expect(bookAuthor?.relationship.type).toBe("ref");
		expect(bookAuthor?.relationship.target).toBe("authors");
	});
});

describe("createRelationshipRoutes", () => {
	it("should generate routes for all relationships", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, { authors: [], books: [] }),
		);

		const routes = createRelationshipRoutes(config, db);

		expect(routes).toHaveLength(2);

		// GET /books/:id/author route
		const bookAuthorRoute = routes.find(
			(r) => r.path === "/books/:id/author" && r.method === "GET",
		);
		expect(bookAuthorRoute).toBeDefined();

		// GET /authors/:id/books route
		const authorBooksRoute = routes.find(
			(r) => r.path === "/authors/:id/books" && r.method === "GET",
		);
		expect(authorBooksRoute).toBeDefined();
	});
});

describe("ref relationship handler (GET /books/:id/author)", () => {
	it("should return the related author for a book", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				authors: [{ id: "a1", name: "Frank Herbert", email: "frank@dune.com" }],
				books: [{ id: "b1", title: "Dune", authorId: "a1", year: 1965 }],
			}),
		);

		const routes = createRelationshipRoutes(config, db);
		const handler = routes.find((r) => r.path === "/books/:id/author")?.handler;
		expect(handler).toBeDefined();

		const response = await handler?.({
			params: { id: "b1" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(200);
		expect(response.body).toEqual({
			id: "a1",
			name: "Frank Herbert",
			email: "frank@dune.com",
		});
	});

	it("should return 404 when book does not exist", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				authors: [{ id: "a1", name: "Frank Herbert" }],
				books: [],
			}),
		);

		const routes = createRelationshipRoutes(config, db);
		const handler = routes.find((r) => r.path === "/books/:id/author")?.handler;

		const response = await handler?.({
			params: { id: "nonexistent" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(404);
		expect(response.body).toHaveProperty("_tag", "NotFoundError");
	});

	it("should return null when foreign key is null", async () => {
		// For this test we need a schema that allows null authorId
		const NullableBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.NullOr(Schema.String),
		});

		const nullableConfig = {
			authors: {
				schema: AuthorSchema,
				relationships: {
					books: {
						type: "inverse" as const,
						target: "books" as const,
						foreignKey: "authorId",
					},
				},
			},
			books: {
				schema: NullableBookSchema,
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "authorId",
					},
				},
			},
		} as const;

		const db = await Effect.runPromise(
			createEffectDatabase(nullableConfig, {
				authors: [],
				books: [{ id: "b1", title: "Anonymous", authorId: null }],
			}),
		);

		const routes = createRelationshipRoutes(nullableConfig, db);
		const handler = routes.find((r) => r.path === "/books/:id/author")?.handler;

		const response = await handler?.({
			params: { id: "b1" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(200);
		expect(response.body).toBe(null);
	});
});

describe("inverse relationship handler (GET /authors/:id/books)", () => {
	it("should return all related books for an author", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				authors: [{ id: "a1", name: "Frank Herbert" }],
				books: [
					{ id: "b1", title: "Dune", authorId: "a1", year: 1965 },
					{ id: "b2", title: "Dune Messiah", authorId: "a1", year: 1969 },
					{ id: "b3", title: "Neuromancer", authorId: "a2", year: 1984 },
				],
			}),
		);

		const routes = createRelationshipRoutes(config, db);
		const handler = routes.find(
			(r) => r.path === "/authors/:id/books",
		)?.handler;
		expect(handler).toBeDefined();

		const response = await handler?.({
			params: { id: "a1" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(200);
		expect(response.body).toHaveLength(2);
		expect(response.body).toContainEqual(
			expect.objectContaining({ id: "b1", title: "Dune" }),
		);
		expect(response.body).toContainEqual(
			expect.objectContaining({ id: "b2", title: "Dune Messiah" }),
		);
	});

	it("should return empty array when author has no books", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				authors: [{ id: "a1", name: "New Author" }],
				books: [],
			}),
		);

		const routes = createRelationshipRoutes(config, db);
		const handler = routes.find(
			(r) => r.path === "/authors/:id/books",
		)?.handler;

		const response = await handler?.({
			params: { id: "a1" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(200);
		expect(response.body).toEqual([]);
	});

	it("should return 404 when author does not exist", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				authors: [],
				books: [],
			}),
		);

		const routes = createRelationshipRoutes(config, db);
		const handler = routes.find(
			(r) => r.path === "/authors/:id/books",
		)?.handler;

		const response = await handler?.({
			params: { id: "nonexistent" },
			query: {},
			body: undefined,
		});

		expect(response.status).toBe(404);
		expect(response.body).toHaveProperty("_tag", "NotFoundError");
	});
});
