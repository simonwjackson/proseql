import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type { DatasetFor } from "../core/types/types";

describe("Object-based field selection", () => {
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
	});

	const companySchema = z.object({
		id: z.string(),
		name: z.string(),
		industry: z.string(),
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
		],
		posts: [
			{ id: "p1", title: "Post 1", content: "Content 1", authorId: "1" },
			{ id: "p2", title: "Post 2", content: "Content 2", authorId: "1" },
		],
		companies: [{ id: "c1", name: "Tech Corp", industry: "Technology" }],
	};

	async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
		const results: T[] = [];
		for await (const item of iterable) {
			results.push(item);
		}
		return results;
	}

	it("should support basic object-based field selection", async () => {
		const db = createDatabase(config, testData);

		// Object-based selection: select only name and email
		const results = await collect(
			db.users.query({
				select: { name: true, email: true },
			}),
		);

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
		const db = createDatabase(config, testData);

		// Object-based selection with nested selection for populated fields
		const results = await collect(
			db.posts.query({
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
			}),
		);

		expect(results).toHaveLength(2);

		// Should have selected fields from post
		expect(results[0]).toHaveProperty("title", "Post 1");
		expect(results[1]).toHaveProperty("title", "Post 2");

		// Should NOT have non-selected post fields
		expect(results[0]).not.toHaveProperty("id");
		expect(results[0]).not.toHaveProperty("content");
		expect(results[0]).not.toHaveProperty("authorId");

		// Should have nested selection from author
		const author0 = results[0].author;
		expect(author0).toHaveProperty("name", "Alice");
		expect(author0).toHaveProperty("email", "alice@example.com");

		// Should NOT have non-selected author fields
		expect(author0).not.toHaveProperty("id");
		expect(author0).not.toHaveProperty("age");
		expect(author0).not.toHaveProperty("isActive");
	});

	it("should handle complex object-based selection scenarios", async () => {
		const db = createDatabase(config, testData);

		// Object-based selection with multiple fields
		const results = await collect(
			db.users.query({
				select: { name: true, email: true, age: true },
			}),
		);

		expect(results).toHaveLength(2);

		// Should have selected fields
		expect(results[0]).toHaveProperty("name", "Alice");
		expect(results[0]).toHaveProperty("email", "alice@example.com");
		expect(results[0]).toHaveProperty("age", 30);

		// Should NOT have non-selected fields
		expect(results[0]).not.toHaveProperty("id");
		expect(results[0]).not.toHaveProperty("isActive");
	});

	it("should handle empty object selection", async () => {
		const db = createDatabase(config, testData);

		const results = await collect(
			db.users.query({
				select: {},
			}),
		);

		expect(results).toHaveLength(2);

		// Should have no fields
		expect(Object.keys(results[0])).toHaveLength(0);
		expect(Object.keys(results[1])).toHaveLength(0);
	});

	it("should support mixed object and populate without select", async () => {
		const db = createDatabase(config, testData);

		// Just populate without select - should get all fields
		const results = await collect(
			db.posts.query({
				populate: {
					author: true,
				},
			}),
		);

		expect(results).toHaveLength(2);

		// Should have all post fields
		expect(results[0]).toHaveProperty("id");
		expect(results[0]).toHaveProperty("title");
		expect(results[0]).toHaveProperty("content");
		expect(results[0]).toHaveProperty("authorId");

		// Should have populated author with all fields
		const author0 = results[0].author;
		expect(author0).toHaveProperty("id");
		expect(author0).toHaveProperty("name");
		expect(author0).toHaveProperty("email");
		expect(author0).toHaveProperty("age");
		expect(author0).toHaveProperty("isActive");
	});
});
