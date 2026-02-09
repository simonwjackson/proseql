import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type { DatasetFor } from "../core/types/types";

describe("Database field selection integration", () => {
	const userSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		age: z.number(),
		isActive: z.boolean(),
	});

	const postSchema = z.object({
		id: z.string(),
		title: z.string(),
		content: z.string(),
		authorId: z.string(),
		publishedAt: z.string(),
		views: z.number(),
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
	} as const;

	const testData: DatasetFor<typeof config> = {
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
			{
				id: "3",
				name: "Charlie",
				email: "charlie@example.com",
				age: 35,
				isActive: true,
			},
		],
		posts: [
			{
				id: "p1",
				title: "First Post",
				content: "Hello World",
				authorId: "1",
				publishedAt: "2024-01-01",
				views: 100,
			},
			{
				id: "p2",
				title: "Second Post",
				content: "Another post",
				authorId: "1",
				publishedAt: "2024-01-02",
				views: 200,
			},
			{
				id: "p3",
				title: "Bob's Post",
				content: "Bob's content",
				authorId: "2",
				publishedAt: "2024-01-03",
				views: 50,
			},
		],
	};

	async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
		const results: T[] = [];
		for await (const item of iterable) {
			results.push(item);
		}
		return results;
	}

	it("should select specific fields from query results", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.users.query({ select: { id: true, name: true } }),
		);

		expect(results).toHaveLength(3);
		expect(results[0]).toEqual({ id: "1", name: "Alice" });
		expect(results[1]).toEqual({ id: "2", name: "Bob" });
		expect(results[2]).toEqual({ id: "3", name: "Charlie" });

		// Verify that non-selected fields are not included
		expect(results[0]).not.toHaveProperty("email");
		expect(results[0]).not.toHaveProperty("age");
		expect(results[0]).not.toHaveProperty("isActive");
	});

	it("should work with empty select object", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(db.users.query({ select: {} }));

		expect(results).toHaveLength(3);
		expect(results[0]).toEqual({});
		expect(results[1]).toEqual({});
		expect(results[2]).toEqual({});
	});

	it("should combine select with where clause", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.users.query({
				where: { isActive: true },
				select: { name: true, email: true },
			}),
		);

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ name: "Alice", email: "alice@example.com" });
		expect(results[1]).toEqual({
			name: "Charlie",
			email: "charlie@example.com",
		});
	});

	it("should combine select with populate", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.posts.query({
				select: { id: true, title: true, author: true },
			}),
		);

		expect(results).toHaveLength(3);

		// Should have selected fields plus populated author
		expect(results[0]).toHaveProperty("id");
		expect(results[0]).toHaveProperty("title");
		expect(results[0]).toHaveProperty("author");

		// Should not have non-selected fields
		expect(results[0]).not.toHaveProperty("content");
		expect(results[0]).not.toHaveProperty("authorId");
		expect(results[0]).not.toHaveProperty("publishedAt");
		expect(results[0]).not.toHaveProperty("views");

		// Author should be fully populated (not affected by select)
		if (results[0].author) {
			expect(results[0].author).toEqual({
				id: "1",
				name: "Alice",
				email: "alice@example.com",
				age: 30,
				isActive: true,
			});
		}
	});

	it("should combine select with sort", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.users.query({
				sort: { age: "desc" },
				select: { name: true, age: true },
			}),
		);

		expect(results).toHaveLength(3);
		expect(results[0]).toEqual({ name: "Charlie", age: 35 });
		expect(results[1]).toEqual({ name: "Alice", age: 30 });
		expect(results[2]).toEqual({ name: "Bob", age: 25 });
	});

	it("should combine select with limit and offset", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.posts.query({
				select: { title: true, views: true },
				sort: { views: "desc" },
				limit: 2,
				offset: 1,
			}),
		);

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ title: "First Post", views: 100 });
		expect(results[1]).toEqual({ title: "Bob's Post", views: 50 });
	});

	it("should work with all query features combined", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.posts.query({
				where: { views: { $gte: 100 } },
				select: { title: true, views: true, author: true },
				sort: { views: "asc" },
				limit: 10,
			}),
		);

		expect(results).toHaveLength(2);

		// First result (100 views)
		const first = results[0];
		expect(first.title).toBe("First Post");
		expect(first.views).toBe(100);
		if (first.author) {
			expect(first.author.name).toBe("Alice");
		}
		expect(first).not.toHaveProperty("content");

		// Second result (200 views)
		const second = results[1];
		expect(second.title).toBe("Second Post");
		expect(second.views).toBe(200);
		if (second.author) {
			expect(second.author.name).toBe("Alice");
		}
		expect(second).not.toHaveProperty("content");
	});

	it("should handle selection with inverse relationships", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.users.query({
				where: { id: "1" },
				select: { name: true, posts: true },
			}),
		);

		expect(results).toHaveLength(1);
		const result = results[0];
		expect(result.name).toBe("Alice");
		if ("posts" in result && result.posts) {
			expect(result.posts).toHaveLength(2);
			expect(result.posts[0]).toHaveProperty("title");
		}
		expect(result).not.toHaveProperty("email");
		expect(result).not.toHaveProperty("age");
	});

	it("should preserve type safety with select", async () => {
		const db = createDatabase(config, testData);

		// This test primarily verifies that TypeScript inference works correctly
		// The actual runtime behavior is tested above
		const results = await collect(
			db.users.query({ select: { id: true, name: true } }),
		);

		// TypeScript should know that results have only id and name properties
		// This is a compile-time check, runtime assertion added for completeness
		type ResultType = (typeof results)[0];
		type ExpectedKeys = "id" | "name";
		type ActualKeys = keyof ResultType;

		// This would fail to compile if types don't match
		const _typeCheck: ActualKeys extends ExpectedKeys ? true : false = true;
		const _reverseCheck: ExpectedKeys extends ActualKeys ? true : false = true;

		expect(true).toBe(true); // Dummy assertion since this is mainly a type test
	});
});
