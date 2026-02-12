/**
 * Verification test for task 2.9:
 * Verify that multiple collections in a config each produce their own namespaced set of procedures.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeRpcGroup, makeCollectionRpcs } from "../src/rpc-group.js";

// Define test schemas for multiple collections
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	authorId: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	bio: Schema.optional(Schema.String),
});

const PublisherSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	country: Schema.String,
});

// Multi-collection config
const multiCollectionConfig = {
	books: {
		schema: BookSchema,
		relationships: {
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
		},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {
			books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
		},
	},
	publishers: {
		schema: PublisherSchema,
		relationships: {},
	},
} as const;

describe("Multi-collection RPC namespacing (task 2.9)", () => {
	describe("makeRpcGroup with multiple collections", () => {
		it("should produce separate RPC definitions for each collection", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Verify all collections are present
			expect(rpcs.books).toBeDefined();
			expect(rpcs.authors).toBeDefined();
			expect(rpcs.publishers).toBeDefined();

			// Verify each collection has its own set of procedures
			expect(rpcs.books.collectionName).toBe("books");
			expect(rpcs.authors.collectionName).toBe("authors");
			expect(rpcs.publishers.collectionName).toBe("publishers");
		});

		it("should namespace findById requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Create request instances to verify _tag namespacing
			const booksFindById = new rpcs.books.FindByIdRequest({ id: "1" });
			const authorsFindById = new rpcs.authors.FindByIdRequest({ id: "1" });
			const publishersFindById = new rpcs.publishers.FindByIdRequest({ id: "1" });

			expect(booksFindById._tag).toBe("books.findById");
			expect(authorsFindById._tag).toBe("authors.findById");
			expect(publishersFindById._tag).toBe("publishers.findById");
		});

		it("should namespace query requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			const booksQuery = new rpcs.books.QueryRequest({});
			const authorsQuery = new rpcs.authors.QueryRequest({});
			const publishersQuery = new rpcs.publishers.QueryRequest({});

			expect(booksQuery._tag).toBe("books.query");
			expect(authorsQuery._tag).toBe("authors.query");
			expect(publishersQuery._tag).toBe("publishers.query");
		});

		it("should namespace create requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			const booksCreate = new rpcs.books.CreateRequest({ data: {} });
			const authorsCreate = new rpcs.authors.CreateRequest({ data: {} });
			const publishersCreate = new rpcs.publishers.CreateRequest({ data: {} });

			expect(booksCreate._tag).toBe("books.create");
			expect(authorsCreate._tag).toBe("authors.create");
			expect(publishersCreate._tag).toBe("publishers.create");
		});

		it("should namespace update requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			const booksUpdate = new rpcs.books.UpdateRequest({ id: "1", updates: {} });
			const authorsUpdate = new rpcs.authors.UpdateRequest({ id: "1", updates: {} });
			const publishersUpdate = new rpcs.publishers.UpdateRequest({ id: "1", updates: {} });

			expect(booksUpdate._tag).toBe("books.update");
			expect(authorsUpdate._tag).toBe("authors.update");
			expect(publishersUpdate._tag).toBe("publishers.update");
		});

		it("should namespace delete requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			const booksDelete = new rpcs.books.DeleteRequest({ id: "1" });
			const authorsDelete = new rpcs.authors.DeleteRequest({ id: "1" });
			const publishersDelete = new rpcs.publishers.DeleteRequest({ id: "1" });

			expect(booksDelete._tag).toBe("books.delete");
			expect(authorsDelete._tag).toBe("authors.delete");
			expect(publishersDelete._tag).toBe("publishers.delete");
		});

		it("should namespace aggregate requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			const booksAggregate = new rpcs.books.AggregateRequest({ count: true });
			const authorsAggregate = new rpcs.authors.AggregateRequest({ count: true });
			const publishersAggregate = new rpcs.publishers.AggregateRequest({ count: true });

			expect(booksAggregate._tag).toBe("books.aggregate");
			expect(authorsAggregate._tag).toBe("authors.aggregate");
			expect(publishersAggregate._tag).toBe("publishers.aggregate");
		});

		it("should namespace batch operation requests with collection prefix", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// createMany
			const booksCreateMany = new rpcs.books.CreateManyRequest({ data: [] });
			const authorsCreateMany = new rpcs.authors.CreateManyRequest({ data: [] });
			expect(booksCreateMany._tag).toBe("books.createMany");
			expect(authorsCreateMany._tag).toBe("authors.createMany");

			// updateMany
			const booksUpdateMany = new rpcs.books.UpdateManyRequest({ where: {}, updates: {} });
			const authorsUpdateMany = new rpcs.authors.UpdateManyRequest({ where: {}, updates: {} });
			expect(booksUpdateMany._tag).toBe("books.updateMany");
			expect(authorsUpdateMany._tag).toBe("authors.updateMany");

			// deleteMany
			const booksDeleteMany = new rpcs.books.DeleteManyRequest({ where: {} });
			const authorsDeleteMany = new rpcs.authors.DeleteManyRequest({ where: {} });
			expect(booksDeleteMany._tag).toBe("books.deleteMany");
			expect(authorsDeleteMany._tag).toBe("authors.deleteMany");

			// upsert
			const booksUpsert = new rpcs.books.UpsertRequest({ where: {}, create: {}, update: {} });
			const authorsUpsert = new rpcs.authors.UpsertRequest({ where: {}, create: {}, update: {} });
			expect(booksUpsert._tag).toBe("books.upsert");
			expect(authorsUpsert._tag).toBe("authors.upsert");

			// upsertMany
			const booksUpsertMany = new rpcs.books.UpsertManyRequest({ data: [] });
			const authorsUpsertMany = new rpcs.authors.UpsertManyRequest({ data: [] });
			expect(booksUpsertMany._tag).toBe("books.upsertMany");
			expect(authorsUpsertMany._tag).toBe("authors.upsertMany");
		});

		it("should preserve entity schema for each collection", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Verify each collection has its own entity schema reference
			expect(rpcs.books.entitySchema).toBe(BookSchema);
			expect(rpcs.authors.entitySchema).toBe(AuthorSchema);
			expect(rpcs.publishers.entitySchema).toBe(PublisherSchema);
		});

		it("should create independent procedure sets (no shared state)", () => {
			const rpcs = makeRpcGroup(multiCollectionConfig);

			// Verify that the request classes are distinct for each collection
			// (not the same class shared between collections)
			expect(rpcs.books.FindByIdRequest).not.toBe(rpcs.authors.FindByIdRequest);
			expect(rpcs.books.QueryRequest).not.toBe(rpcs.authors.QueryRequest);
			expect(rpcs.books.CreateRequest).not.toBe(rpcs.authors.CreateRequest);
			expect(rpcs.books.UpdateRequest).not.toBe(rpcs.authors.UpdateRequest);
			expect(rpcs.books.DeleteRequest).not.toBe(rpcs.authors.DeleteRequest);
			expect(rpcs.books.AggregateRequest).not.toBe(rpcs.authors.AggregateRequest);
			expect(rpcs.books.CreateManyRequest).not.toBe(rpcs.authors.CreateManyRequest);
			expect(rpcs.books.UpdateManyRequest).not.toBe(rpcs.authors.UpdateManyRequest);
			expect(rpcs.books.DeleteManyRequest).not.toBe(rpcs.authors.DeleteManyRequest);
			expect(rpcs.books.UpsertRequest).not.toBe(rpcs.authors.UpsertRequest);
			expect(rpcs.books.UpsertManyRequest).not.toBe(rpcs.authors.UpsertManyRequest);
		});
	});

	describe("makeCollectionRpcs for individual collections", () => {
		it("should produce correctly namespaced procedures for a single collection", () => {
			const bookRpcs = makeCollectionRpcs("books", BookSchema);

			expect(bookRpcs.collectionName).toBe("books");

			// Verify all operations are namespaced correctly
			const findById = new bookRpcs.FindByIdRequest({ id: "1" });
			const query = new bookRpcs.QueryRequest({});
			const create = new bookRpcs.CreateRequest({ data: {} });
			const update = new bookRpcs.UpdateRequest({ id: "1", updates: {} });
			const del = new bookRpcs.DeleteRequest({ id: "1" });
			const aggregate = new bookRpcs.AggregateRequest({ count: true });
			const createMany = new bookRpcs.CreateManyRequest({ data: [] });
			const updateMany = new bookRpcs.UpdateManyRequest({ where: {}, updates: {} });
			const deleteMany = new bookRpcs.DeleteManyRequest({ where: {} });
			const upsert = new bookRpcs.UpsertRequest({ where: {}, create: {}, update: {} });
			const upsertMany = new bookRpcs.UpsertManyRequest({ data: [] });

			expect(findById._tag).toBe("books.findById");
			expect(query._tag).toBe("books.query");
			expect(create._tag).toBe("books.create");
			expect(update._tag).toBe("books.update");
			expect(del._tag).toBe("books.delete");
			expect(aggregate._tag).toBe("books.aggregate");
			expect(createMany._tag).toBe("books.createMany");
			expect(updateMany._tag).toBe("books.updateMany");
			expect(deleteMany._tag).toBe("books.deleteMany");
			expect(upsert._tag).toBe("books.upsert");
			expect(upsertMany._tag).toBe("books.upsertMany");
		});

		it("should produce unique tags for different collection names", () => {
			const books = makeCollectionRpcs("books", BookSchema);
			const authors = makeCollectionRpcs("authors", AuthorSchema);
			const products = makeCollectionRpcs("products", BookSchema); // Reusing schema intentionally

			// Same schema, different collection name should produce different tags
			const booksCreate = new books.CreateRequest({ data: {} });
			const productsCreate = new products.CreateRequest({ data: {} });

			expect(booksCreate._tag).toBe("books.create");
			expect(productsCreate._tag).toBe("products.create");
			expect(booksCreate._tag).not.toBe(productsCreate._tag);
		});
	});
});
