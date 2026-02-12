/**
 * Tests for rpc-group.ts — RPC Group derivation from DatabaseConfig.
 *
 * Task 10.1: Verify makeRpcGroup produces correct procedures for a single-collection config.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeRpcGroup,
	makeCollectionRpcs,
	makeFindByIdRequest,
	makeQueryRequest,
	makeQueryStreamRequest,
	makeCreateRequest,
	makeUpdateRequest,
	makeDeleteRequest,
	makeAggregateRequest,
	makeCreateManyRequest,
	makeUpdateManyRequest,
	makeDeleteManyRequest,
	makeUpsertRequest,
	makeUpsertManyRequest,
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
			const updateMany = new rpcs.books.UpdateManyRequest({ where: {}, updates: {} });
			const deleteMany = new rpcs.books.DeleteManyRequest({ where: {} });
			const upsert = new rpcs.books.UpsertRequest({ where: {}, create: {}, update: {} });
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
				data: [
					{ title: "Book 1" },
					{ title: "Book 2" },
				],
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
