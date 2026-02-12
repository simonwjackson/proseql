/**
 * Tests for rpc-group.ts — RPC Group derivation from DatabaseConfig.
 *
 * Task 10.1: Verify makeRpcGroup produces correct procedures for a single-collection config.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeAggregateRequest,
	makeCollectionRpcs,
	makeCreateManyRequest,
	makeCreateRequest,
	makeDeleteManyRequest,
	makeDeleteRequest,
	makeFindByIdRequest,
	makeQueryRequest,
	makeQueryStreamRequest,
	makeRpcGroup,
	makeUpdateManyRequest,
	makeUpdateRequest,
	makeUpsertManyRequest,
	makeUpsertRequest,
} from "../src/rpc-group.js";

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

type Book = Schema.Schema.Type<typeof BookSchema>;

// ============================================================================
// Single-Collection Config
// ============================================================================

const singleCollectionConfig = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Multi-Collection Config (for task 10.2)
// ============================================================================

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	birthYear: Schema.Number,
	country: Schema.String,
});

type Author = Schema.Schema.Type<typeof AuthorSchema>;

const PublisherSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	founded: Schema.Number,
	headquarters: Schema.String,
});

type Publisher = Schema.Schema.Type<typeof PublisherSchema>;

const multiCollectionConfig = {
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
	publishers: {
		schema: PublisherSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Tests
// ============================================================================

describe("RPC Group derivation (task 10.1)", () => {
	describe("makeRpcGroup with single-collection config", () => {
		it("should produce RPC definitions for the single collection", () => {
			const rpcs = makeRpcGroup(singleCollectionConfig);

			expect(rpcs.books).toBeDefined();
			expect(rpcs.books.collectionName).toBe("books");
			expect(rpcs.books.entitySchema).toBe(BookSchema);
		});

		it("should include all CRUD request classes", () => {
			const rpcs = makeRpcGroup(singleCollectionConfig);

			expect(rpcs.books.FindByIdRequest).toBeDefined();
			expect(rpcs.books.QueryRequest).toBeDefined();
			expect(rpcs.books.QueryStreamRequest).toBeDefined();
			expect(rpcs.books.CreateRequest).toBeDefined();
			expect(rpcs.books.UpdateRequest).toBeDefined();
			expect(rpcs.books.DeleteRequest).toBeDefined();
			expect(rpcs.books.AggregateRequest).toBeDefined();
		});

		it("should include all batch request classes", () => {
			const rpcs = makeRpcGroup(singleCollectionConfig);

			expect(rpcs.books.CreateManyRequest).toBeDefined();
			expect(rpcs.books.UpdateManyRequest).toBeDefined();
			expect(rpcs.books.DeleteManyRequest).toBeDefined();
			expect(rpcs.books.UpsertRequest).toBeDefined();
			expect(rpcs.books.UpsertManyRequest).toBeDefined();
		});

		it("should produce correctly tagged request instances", () => {
			const rpcs = makeRpcGroup(singleCollectionConfig);

			// Create instances to verify _tag values
			const findById = new rpcs.books.FindByIdRequest({ id: "1" });
			const query = new rpcs.books.QueryRequest({});
			const create = new rpcs.books.CreateRequest({ data: {} });
			const update = new rpcs.books.UpdateRequest({ id: "1", updates: {} });
			const deleteReq = new rpcs.books.DeleteRequest({ id: "1" });
			const aggregate = new rpcs.books.AggregateRequest({ count: true });

			expect(findById._tag).toBe("books.findById");
			expect(query._tag).toBe("books.query");
			expect(create._tag).toBe("books.create");
			expect(update._tag).toBe("books.update");
			expect(deleteReq._tag).toBe("books.delete");
			expect(aggregate._tag).toBe("books.aggregate");
		});

		it("should produce correctly tagged batch request instances", () => {
			const rpcs = makeRpcGroup(singleCollectionConfig);

			const createMany = new rpcs.books.CreateManyRequest({ data: [] });
			const updateMany = new rpcs.books.UpdateManyRequest({
				where: {},
				updates: {},
			});
			const deleteMany = new rpcs.books.DeleteManyRequest({ where: {} });
			const upsert = new rpcs.books.UpsertRequest({
				where: {},
				create: {},
				update: {},
			});
			const upsertMany = new rpcs.books.UpsertManyRequest({ data: [] });

			expect(createMany._tag).toBe("books.createMany");
			expect(updateMany._tag).toBe("books.updateMany");
			expect(deleteMany._tag).toBe("books.deleteMany");
			expect(upsert._tag).toBe("books.upsert");
			expect(upsertMany._tag).toBe("books.upsertMany");
		});
	});

	describe("makeCollectionRpcs", () => {
		it("should create RPC definitions for a single collection", () => {
			const rpcs = makeCollectionRpcs("books", BookSchema);

			expect(rpcs.collectionName).toBe("books");
			expect(rpcs.entitySchema).toBe(BookSchema);
			expect(rpcs.FindByIdRequest).toBeDefined();
			expect(rpcs.QueryRequest).toBeDefined();
			expect(rpcs.CreateRequest).toBeDefined();
			expect(rpcs.UpdateRequest).toBeDefined();
			expect(rpcs.DeleteRequest).toBeDefined();
			expect(rpcs.AggregateRequest).toBeDefined();
		});
	});

	describe("makeFindByIdRequest", () => {
		it("should create a correctly tagged request class", () => {
			const FindByIdRequest = makeFindByIdRequest("books", BookSchema);
			const request = new FindByIdRequest({ id: "123" });

			expect(request._tag).toBe("books.findById");
			expect(request.id).toBe("123");
		});

		it("should accept custom collection names", () => {
			const FindByIdRequest = makeFindByIdRequest("products", BookSchema);
			const request = new FindByIdRequest({ id: "abc" });

			expect(request._tag).toBe("products.findById");
			expect(request.id).toBe("abc");
		});
	});

	describe("makeQueryRequest", () => {
		it("should create a correctly tagged request class", () => {
			const QueryRequest = makeQueryRequest("books", BookSchema);
			const request = new QueryRequest({ where: { genre: "sci-fi" } });

			expect(request._tag).toBe("books.query");
			expect(request.where).toEqual({ genre: "sci-fi" });
		});

		it("should support all query options", () => {
			const QueryRequest = makeQueryRequest("books", BookSchema);
			const request = new QueryRequest({
				where: { year: { $gt: 2000 } },
				sort: { title: "asc" },
				limit: 10,
				offset: 20,
				select: ["title", "author"],
			});

			expect(request._tag).toBe("books.query");
			expect(request.where).toEqual({ year: { $gt: 2000 } });
			expect(request.sort).toEqual({ title: "asc" });
			expect(request.limit).toBe(10);
			expect(request.offset).toBe(20);
			expect(request.select).toEqual(["title", "author"]);
		});
	});

	describe("makeQueryStreamRequest", () => {
		it("should create a correctly tagged stream request class", () => {
			const QueryStreamRequest = makeQueryStreamRequest("books", BookSchema);
			const request = new QueryStreamRequest({});

			expect(request._tag).toBe("books.queryStream");
		});

		it("should support streaming options", () => {
			const QueryStreamRequest = makeQueryStreamRequest("books", BookSchema);
			const request = new QueryStreamRequest({
				where: { genre: "sci-fi" },
				streamingOptions: { chunkSize: 100 },
			});

			expect(request._tag).toBe("books.queryStream");
			expect(request.where).toEqual({ genre: "sci-fi" });
			expect(request.streamingOptions).toEqual({ chunkSize: 100 });
		});
	});

	describe("makeCreateRequest", () => {
		it("should create a correctly tagged request class", () => {
			const CreateRequest = makeCreateRequest("books", BookSchema);
			const request = new CreateRequest({
				data: { title: "Dune", author: "Frank Herbert" },
			});

			expect(request._tag).toBe("books.create");
			expect(request.data).toEqual({ title: "Dune", author: "Frank Herbert" });
		});
	});

	describe("makeUpdateRequest", () => {
		it("should create a correctly tagged request class", () => {
			const UpdateRequest = makeUpdateRequest("books", BookSchema);
			const request = new UpdateRequest({
				id: "1",
				updates: { genre: "classic" },
			});

			expect(request._tag).toBe("books.update");
			expect(request.id).toBe("1");
			expect(request.updates).toEqual({ genre: "classic" });
		});
	});

	describe("makeDeleteRequest", () => {
		it("should create a correctly tagged request class", () => {
			const DeleteRequest = makeDeleteRequest("books", BookSchema);
			const request = new DeleteRequest({ id: "1" });

			expect(request._tag).toBe("books.delete");
			expect(request.id).toBe("1");
		});
	});

	describe("makeAggregateRequest", () => {
		it("should create a correctly tagged request class", () => {
			const AggregateRequest = makeAggregateRequest("books");
			const request = new AggregateRequest({ count: true });

			expect(request._tag).toBe("books.aggregate");
			expect(request.count).toBe(true);
		});

		it("should support all aggregate options", () => {
			const AggregateRequest = makeAggregateRequest("books");
			const request = new AggregateRequest({
				where: { genre: "sci-fi" },
				groupBy: "author",
				count: true,
				sum: "pages",
				avg: "year",
				min: "year",
				max: "year",
			});

			expect(request._tag).toBe("books.aggregate");
			expect(request.where).toEqual({ genre: "sci-fi" });
			expect(request.groupBy).toBe("author");
			expect(request.count).toBe(true);
			expect(request.sum).toBe("pages");
			expect(request.avg).toBe("year");
			expect(request.min).toBe("year");
			expect(request.max).toBe("year");
		});
	});

	describe("makeCreateManyRequest", () => {
		it("should create a correctly tagged request class", () => {
			const CreateManyRequest = makeCreateManyRequest("books");
			const request = new CreateManyRequest({
				data: [{ title: "Book 1" }, { title: "Book 2" }],
			});

			expect(request._tag).toBe("books.createMany");
			expect(request.data).toHaveLength(2);
		});

		it("should support options", () => {
			const CreateManyRequest = makeCreateManyRequest("books");
			const request = new CreateManyRequest({
				data: [],
				options: { skipDuplicates: true },
			});

			expect(request._tag).toBe("books.createMany");
			expect(request.options).toEqual({ skipDuplicates: true });
		});
	});

	describe("makeUpdateManyRequest", () => {
		it("should create a correctly tagged request class", () => {
			const UpdateManyRequest = makeUpdateManyRequest("books");
			const request = new UpdateManyRequest({
				where: { genre: "sci-fi" },
				updates: { genre: "science fiction" },
			});

			expect(request._tag).toBe("books.updateMany");
			expect(request.where).toEqual({ genre: "sci-fi" });
			expect(request.updates).toEqual({ genre: "science fiction" });
		});
	});

	describe("makeDeleteManyRequest", () => {
		it("should create a correctly tagged request class", () => {
			const DeleteManyRequest = makeDeleteManyRequest("books");
			const request = new DeleteManyRequest({
				where: { year: { $lt: 1900 } },
			});

			expect(request._tag).toBe("books.deleteMany");
			expect(request.where).toEqual({ year: { $lt: 1900 } });
		});

		it("should support options", () => {
			const DeleteManyRequest = makeDeleteManyRequest("books");
			const request = new DeleteManyRequest({
				where: {},
				options: { limit: 10 },
			});

			expect(request._tag).toBe("books.deleteMany");
			expect(request.options).toEqual({ limit: 10 });
		});
	});

	describe("makeUpsertRequest", () => {
		it("should create a correctly tagged request class", () => {
			const UpsertRequest = makeUpsertRequest("books");
			const request = new UpsertRequest({
				where: { id: "1" },
				create: { title: "New Book", author: "Author" },
				update: { title: "Updated Book" },
			});

			expect(request._tag).toBe("books.upsert");
			expect(request.where).toEqual({ id: "1" });
			expect(request.create).toEqual({ title: "New Book", author: "Author" });
			expect(request.update).toEqual({ title: "Updated Book" });
		});
	});

	describe("makeUpsertManyRequest", () => {
		it("should create a correctly tagged request class", () => {
			const UpsertManyRequest = makeUpsertManyRequest("books");
			const request = new UpsertManyRequest({
				data: [
					{ where: { id: "1" }, create: {}, update: {} },
					{ where: { id: "2" }, create: {}, update: {} },
				],
			});

			expect(request._tag).toBe("books.upsertMany");
			expect(request.data).toHaveLength(2);
		});
	});
});

// ============================================================================
// Multi-Collection Config Tests (task 10.2)
// ============================================================================

describe("RPC Group derivation with multi-collection config (task 10.2)", () => {
	describe("makeRpcGroup with multi-collection config", () => {
		it("should produce RPC definitions for all collections", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// All three collections should be present
			expect(rpcs.books).toBeDefined();
			expect(rpcs.authors).toBeDefined();
			expect(rpcs.publishers).toBeDefined();

			// Each should have the correct collection name
			expect(rpcs.books.collectionName).toBe("books");
			expect(rpcs.authors.collectionName).toBe("authors");
			expect(rpcs.publishers.collectionName).toBe("publishers");

			// Each should have the correct entity schema
			expect(rpcs.books.entitySchema).toBe(BookSchema);
			expect(rpcs.authors.entitySchema).toBe(AuthorSchema);
			expect(rpcs.publishers.entitySchema).toBe(PublisherSchema);
		});

		it("should produce namespaced _tags for each collection's procedures", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Books procedures should have "books." prefix
			const booksFindById = new rpcs.books.FindByIdRequest({ id: "1" });
			const booksQuery = new rpcs.books.QueryRequest({});
			const booksCreate = new rpcs.books.CreateRequest({ data: {} });
			const booksUpdate = new rpcs.books.UpdateRequest({
				id: "1",
				updates: {},
			});
			const booksDelete = new rpcs.books.DeleteRequest({ id: "1" });
			const booksAggregate = new rpcs.books.AggregateRequest({ count: true });

			expect(booksFindById._tag).toBe("books.findById");
			expect(booksQuery._tag).toBe("books.query");
			expect(booksCreate._tag).toBe("books.create");
			expect(booksUpdate._tag).toBe("books.update");
			expect(booksDelete._tag).toBe("books.delete");
			expect(booksAggregate._tag).toBe("books.aggregate");

			// Authors procedures should have "authors." prefix
			const authorsFindById = new rpcs.authors.FindByIdRequest({ id: "1" });
			const authorsQuery = new rpcs.authors.QueryRequest({});
			const authorsCreate = new rpcs.authors.CreateRequest({ data: {} });
			const authorsUpdate = new rpcs.authors.UpdateRequest({
				id: "1",
				updates: {},
			});
			const authorsDelete = new rpcs.authors.DeleteRequest({ id: "1" });
			const authorsAggregate = new rpcs.authors.AggregateRequest({
				count: true,
			});

			expect(authorsFindById._tag).toBe("authors.findById");
			expect(authorsQuery._tag).toBe("authors.query");
			expect(authorsCreate._tag).toBe("authors.create");
			expect(authorsUpdate._tag).toBe("authors.update");
			expect(authorsDelete._tag).toBe("authors.delete");
			expect(authorsAggregate._tag).toBe("authors.aggregate");

			// Publishers procedures should have "publishers." prefix
			const publishersFindById = new rpcs.publishers.FindByIdRequest({
				id: "1",
			});
			const publishersQuery = new rpcs.publishers.QueryRequest({});
			const publishersCreate = new rpcs.publishers.CreateRequest({ data: {} });
			const publishersUpdate = new rpcs.publishers.UpdateRequest({
				id: "1",
				updates: {},
			});
			const publishersDelete = new rpcs.publishers.DeleteRequest({ id: "1" });
			const publishersAggregate = new rpcs.publishers.AggregateRequest({
				count: true,
			});

			expect(publishersFindById._tag).toBe("publishers.findById");
			expect(publishersQuery._tag).toBe("publishers.query");
			expect(publishersCreate._tag).toBe("publishers.create");
			expect(publishersUpdate._tag).toBe("publishers.update");
			expect(publishersDelete._tag).toBe("publishers.delete");
			expect(publishersAggregate._tag).toBe("publishers.aggregate");
		});

		it("should produce namespaced _tags for batch operations across collections", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Books batch operations
			const booksCreateMany = new rpcs.books.CreateManyRequest({ data: [] });
			const booksUpdateMany = new rpcs.books.UpdateManyRequest({
				where: {},
				updates: {},
			});
			const booksDeleteMany = new rpcs.books.DeleteManyRequest({ where: {} });
			const booksUpsert = new rpcs.books.UpsertRequest({
				where: {},
				create: {},
				update: {},
			});
			const booksUpsertMany = new rpcs.books.UpsertManyRequest({ data: [] });

			expect(booksCreateMany._tag).toBe("books.createMany");
			expect(booksUpdateMany._tag).toBe("books.updateMany");
			expect(booksDeleteMany._tag).toBe("books.deleteMany");
			expect(booksUpsert._tag).toBe("books.upsert");
			expect(booksUpsertMany._tag).toBe("books.upsertMany");

			// Authors batch operations
			const authorsCreateMany = new rpcs.authors.CreateManyRequest({
				data: [],
			});
			const authorsUpdateMany = new rpcs.authors.UpdateManyRequest({
				where: {},
				updates: {},
			});
			const authorsDeleteMany = new rpcs.authors.DeleteManyRequest({
				where: {},
			});
			const authorsUpsert = new rpcs.authors.UpsertRequest({
				where: {},
				create: {},
				update: {},
			});
			const authorsUpsertMany = new rpcs.authors.UpsertManyRequest({
				data: [],
			});

			expect(authorsCreateMany._tag).toBe("authors.createMany");
			expect(authorsUpdateMany._tag).toBe("authors.updateMany");
			expect(authorsDeleteMany._tag).toBe("authors.deleteMany");
			expect(authorsUpsert._tag).toBe("authors.upsert");
			expect(authorsUpsertMany._tag).toBe("authors.upsertMany");

			// Publishers batch operations
			const publishersCreateMany = new rpcs.publishers.CreateManyRequest({
				data: [],
			});
			const publishersUpdateMany = new rpcs.publishers.UpdateManyRequest({
				where: {},
				updates: {},
			});
			const publishersDeleteMany = new rpcs.publishers.DeleteManyRequest({
				where: {},
			});
			const publishersUpsert = new rpcs.publishers.UpsertRequest({
				where: {},
				create: {},
				update: {},
			});
			const publishersUpsertMany = new rpcs.publishers.UpsertManyRequest({
				data: [],
			});

			expect(publishersCreateMany._tag).toBe("publishers.createMany");
			expect(publishersUpdateMany._tag).toBe("publishers.updateMany");
			expect(publishersDeleteMany._tag).toBe("publishers.deleteMany");
			expect(publishersUpsert._tag).toBe("publishers.upsert");
			expect(publishersUpsertMany._tag).toBe("publishers.upsertMany");
		});

		it("should produce namespaced _tags for stream operations across collections", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Stream request tags should also be properly namespaced
			const booksQueryStream = new rpcs.books.QueryStreamRequest({});
			const authorsQueryStream = new rpcs.authors.QueryStreamRequest({});
			const publishersQueryStream = new rpcs.publishers.QueryStreamRequest({});

			expect(booksQueryStream._tag).toBe("books.queryStream");
			expect(authorsQueryStream._tag).toBe("authors.queryStream");
			expect(publishersQueryStream._tag).toBe("publishers.queryStream");
		});

		it("should produce unique request classes for each collection", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Each collection should have its own distinct request class instances
			// (not shared across collections)
			expect(rpcs.books.FindByIdRequest).not.toBe(rpcs.authors.FindByIdRequest);
			expect(rpcs.books.FindByIdRequest).not.toBe(
				rpcs.publishers.FindByIdRequest,
			);
			expect(rpcs.authors.FindByIdRequest).not.toBe(
				rpcs.publishers.FindByIdRequest,
			);

			expect(rpcs.books.QueryRequest).not.toBe(rpcs.authors.QueryRequest);
			expect(rpcs.books.CreateRequest).not.toBe(rpcs.authors.CreateRequest);
			expect(rpcs.books.UpdateRequest).not.toBe(rpcs.authors.UpdateRequest);
			expect(rpcs.books.DeleteRequest).not.toBe(rpcs.authors.DeleteRequest);
			expect(rpcs.books.AggregateRequest).not.toBe(
				rpcs.authors.AggregateRequest,
			);
		});

		it("should include all CRUD and batch request classes for each collection", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Verify all expected request classes exist for each collection
			const expectedRequestClasses = [
				"FindByIdRequest",
				"QueryRequest",
				"QueryStreamRequest",
				"CreateRequest",
				"UpdateRequest",
				"DeleteRequest",
				"AggregateRequest",
				"CreateManyRequest",
				"UpdateManyRequest",
				"DeleteManyRequest",
				"UpsertRequest",
				"UpsertManyRequest",
			] as const;

			for (const requestClass of expectedRequestClasses) {
				expect(rpcs.books[requestClass]).toBeDefined();
				expect(rpcs.authors[requestClass]).toBeDefined();
				expect(rpcs.publishers[requestClass]).toBeDefined();
			}
		});
	});
});
