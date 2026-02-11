import { describe, it, expect } from "vitest";
import { Effect, Schema, Stream, Chunk } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect";

describe("Object-based field selection (Effect/Stream)", () => {
	const userSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		email: Schema.String,
		age: Schema.Number,
		isActive: Schema.Boolean,
	});

	const postSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		content: Schema.String,
		authorId: Schema.String,
	});

	const companySchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		industry: Schema.String,
	});

	const config = {
		users: {
			schema: userSchema,
			relationships: {
				posts: {
					type: "inverse" as const,
					target: "posts",
					foreignKey: "authorId",
				},
				company: {
					type: "ref" as const,
					target: "companies",
					foreignKey: "companyId",
				},
			},
		},
		posts: {
			schema: postSchema,
			relationships: {
				author: {
					type: "ref" as const,
					target: "users",
					foreignKey: "authorId",
				},
			},
		},
		companies: {
			schema: companySchema,
			relationships: {},
		},
	} as const;

	const testData = {
		users: [
			{
				id: "1",
				name: "Alice",
				email: "alice@example.com",
				age: 30,
				isActive: true,
			},
			{
				id: "2",
				name: "Bob",
				email: "bob@example.com",
				age: 25,
				isActive: false,
			},
		],
		posts: [
			{ id: "p1", title: "Post 1", content: "Content 1", authorId: "1" },
			{ id: "p2", title: "Post 2", content: "Content 2", authorId: "1" },
		],
		companies: [{ id: "c1", name: "Tech Corp", industry: "Technology" }],
	};

	// Helper: create database and collect query results
	const collectQuery = (
		collection: string,
		options: Record<string, unknown>,
	): Promise<ReadonlyArray<Record<string, unknown>>> =>
		Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, testData);
				const coll = (db as Record<string, { query: (opts: Record<string, unknown>) => Stream.Stream<Record<string, unknown>> }>)[collection];
				return yield* Stream.runCollect(coll.query(options)).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);
			}),
		);

	it("should support basic object-based field selection", async () => {
		const results = await collectQuery("users", {
			select: { name: true, email: true },
		});

		expect(results).toHaveLength(2);

		// Should have selected fields
		expect(results[0]).toHaveProperty("name", "Alice");
		expect(results[0]).toHaveProperty("email", "alice@example.com");
		expect(results[1]).toHaveProperty("name", "Bob");
		expect(results[1]).toHaveProperty("email", "bob@example.com");

		// Should NOT have non-selected fields
		expect(results[0]).not.toHaveProperty("id");
		expect(results[0]).not.toHaveProperty("age");
		expect(results[0]).not.toHaveProperty("isActive");
	});

	it("should support nested object-based selection with population", async () => {
		const results = await collectQuery("posts", {
			select: {
				title: true,
				author: {
					name: true,
					email: true,
				},
			},
			populate: {
				author: true,
			},
		});

		expect(results).toHaveLength(2);

		// Should have selected fields from post
		expect(results[0]).toHaveProperty("title", "Post 1");
		expect(results[1]).toHaveProperty("title", "Post 2");

		// Should NOT have non-selected post fields
		expect(results[0]).not.toHaveProperty("id");
		expect(results[0]).not.toHaveProperty("content");
		expect(results[0]).not.toHaveProperty("authorId");

		// Should have nested selection from author
		const author0 = results[0].author as Record<string, unknown>;
		expect(author0).toHaveProperty("name", "Alice");
		expect(author0).toHaveProperty("email", "alice@example.com");

		// Should NOT have non-selected author fields
		expect(author0).not.toHaveProperty("id");
		expect(author0).not.toHaveProperty("age");
		expect(author0).not.toHaveProperty("isActive");
	});

	it("should handle complex object-based selection scenarios", async () => {
		const results = await collectQuery("users", {
			select: { name: true, email: true, age: true },
		});

		expect(results).toHaveLength(2);

		// Should have selected fields
		expect(results[0]).toHaveProperty("name", "Alice");
		expect(results[0]).toHaveProperty("email", "alice@example.com");
		expect(results[0]).toHaveProperty("age", 30);

		// Should NOT have non-selected fields
		expect(results[0]).not.toHaveProperty("id");
		expect(results[0]).not.toHaveProperty("isActive");
	});

	it("should support populate without select — returns all fields", async () => {
		const results = await collectQuery("posts", {
			populate: {
				author: true,
			},
		});

		expect(results).toHaveLength(2);

		// Should have all post fields
		expect(results[0]).toHaveProperty("id");
		expect(results[0]).toHaveProperty("title");
		expect(results[0]).toHaveProperty("content");
		expect(results[0]).toHaveProperty("authorId");

		// Should have populated author with all fields
		const author0 = results[0].author as Record<string, unknown>;
		expect(author0).toHaveProperty("id");
		expect(author0).toHaveProperty("name");
		expect(author0).toHaveProperty("email");
		expect(author0).toHaveProperty("age");
		expect(author0).toHaveProperty("isActive");
	});
});
