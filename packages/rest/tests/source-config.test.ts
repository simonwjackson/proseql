import { createEffectDatabase } from "@proseql/effect";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	createRelationshipRoutes,
	createRestHandlers,
	extractRelationships,
	type HttpMethod,
	type RestRequest,
	type RouteDescriptor,
} from "../src/index.js";

const config = {
	collections: {
		authors: {
			schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
			relationships: {
				books: { type: "inverse", target: "books", foreignKey: "authorId" },
			},
		},
		books: {
			schema: Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				authorId: Schema.String,
				year: Schema.Number,
			}),
			relationships: {
				author: { type: "ref", target: "authors", foreignKey: "authorId" },
			},
		},
	},
	sources: [
		{
			id: "library",
			kind: "documents",
			root: "/data",
			format: "yaml",
			collections: "all",
			outbox: "/data/generated.yaml",
		},
	],
} as const;

const initialData = {
	authors: [
		{ id: "a1", name: "Frank Herbert" },
		{ id: "a2", name: "William Gibson" },
	],
	books: [
		{ id: "b1", title: "Dune", authorId: "a1", year: 1965 },
		{ id: "b2", title: "Dune Messiah", authorId: "a1", year: 1969 },
		{ id: "b3", title: "Neuromancer", authorId: "a2", year: 1984 },
	],
} as const;

const callRoute = (
	routes: ReadonlyArray<RouteDescriptor>,
	method: HttpMethod,
	path: string,
	request: Partial<RestRequest> = {},
) => {
	const route = routes.find(
		(route) => route.method === method && route.path === path,
	);
	if (!route) throw new Error(`Missing route: ${method} ${path}`);
	return route.handler({ params: {}, query: {}, body: undefined, ...request });
};

const makeDatabase = () =>
	Effect.runPromise(createEffectDatabase(config, initialData));

describe("REST routes with source-oriented configs", () => {
	it("generates the same route shapes as classic configs, without metadata routes", async () => {
		const db = await makeDatabase();
		const routes = createRestHandlers(config, db);
		const routeShapes = (routes: ReadonlyArray<RouteDescriptor>) =>
			routes.map(({ method, path }) => ({ method, path }));

		expect(routes).toHaveLength(14);
		expect(routeShapes(routes)).toEqual(
			routeShapes(createRestHandlers(config.collections, db)),
		);
		expect(
			routes.some(({ path }) => /^\/(collections|sources)(\/|$)/.test(path)),
		).toBe(false);
		expect(await callRoute(routes, "GET", "/authors")).toEqual({
			status: 200,
			body: initialData.authors,
		});
	});

	it("creates, reads, updates and deletes through the generated routes", async () => {
		const routes = createRestHandlers(config, await makeDatabase());
		const book = {
			id: "b4",
			title: "Children of Dune",
			authorId: "a1",
			year: 1976,
		};
		const params = { id: book.id };

		expect(await callRoute(routes, "POST", "/books", { body: book })).toEqual({
			status: 201,
			body: book,
		});
		expect(await callRoute(routes, "GET", "/books/:id", { params })).toEqual({
			status: 200,
			body: book,
		});
		expect(
			await callRoute(routes, "PUT", "/books/:id", {
				params,
				body: { year: 1977 },
			}),
		).toEqual({
			status: 200,
			body: { ...book, year: 1977 },
		});
		expect(await callRoute(routes, "DELETE", "/books/:id", { params })).toEqual(
			{
				status: 200,
				body: { ...book, year: 1977 },
			},
		);
		expect(await callRoute(routes, "GET", "/books/:id", { params })).toEqual({
			status: 404,
			body: { error: "Not found", _tag: "NotFoundError" },
		});
	});

	it("creates a batch and returns it through the query route", async () => {
		const routes = createRestHandlers(config, await makeDatabase());
		const books = [
			{ id: "b4", title: "Children of Dune", authorId: "a1", year: 1976 },
			{ id: "b5", title: "God Emperor of Dune", authorId: "a1", year: 1981 },
		];
		const response = await callRoute(routes, "POST", "/books/batch", {
			body: books,
		});
		expect(response.status).toBe(201);
		expect(response.body).toMatchObject({ created: books });
		expect(
			await callRoute(routes, "GET", "/books", {
				query: { "year[$gte]": "1976", authorId: "a1", sort: "year:asc" },
			}),
		).toEqual({
			status: 200,
			body: books,
		});
	});

	it("applies query filters, sorting, pagination and field selection", async () => {
		const routes = createRestHandlers(config, await makeDatabase());
		expect(
			await callRoute(routes, "GET", "/books", {
				query: {
					authorId: "a1",
					"year[$gte]": "1960",
					sort: "year:desc",
					offset: "1",
					limit: "1",
					select: "title,year",
				},
			}),
		).toEqual({ status: 200, body: [{ title: "Dune", year: 1965 }] });
	});

	it("aggregates the real collection with parsed filters", async () => {
		const routes = createRestHandlers(config, await makeDatabase());
		expect(
			await callRoute(routes, "GET", "/books/aggregate", {
				query: {
					count: "true",
					sum: "year",
					avg: "year",
					min: "year",
					max: "year",
					authorId: "a1",
					"year[$lt]": "1970",
				},
			}),
		).toEqual({
			status: 200,
			body: {
				count: 2,
				sum: { year: 3934 },
				avg: { year: 1967 },
				min: { year: 1965 },
				max: { year: 1969 },
			},
		});
	});

	it("returns populated ref and inverse relationships through sub-routes", async () => {
		const db = await makeDatabase();
		const routes = createRelationshipRoutes(config, db);
		expect(extractRelationships(config)).toEqual(
			extractRelationships(config.collections),
		);
		expect(routes.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: "GET", path: "/authors/:id/books" },
			{ method: "GET", path: "/books/:id/author" },
		]);
		expect(
			await callRoute(routes, "GET", "/books/:id/author", {
				params: { id: "b1" },
			}),
		).toEqual({ status: 200, body: initialData.authors[0] });
		expect(
			await callRoute(routes, "GET", "/authors/:id/books", {
				params: { id: "a1" },
			}),
		).toEqual({ status: 200, body: initialData.books.slice(0, 2) });
	});
});
