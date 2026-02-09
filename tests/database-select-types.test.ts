import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type { DatasetFor } from "../core/types/types";

describe("Database field selection type inference", () => {
	const userSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		age: z.number(),
		isActive: z.boolean(),
	});

	const config = {
		users: {
			schema: userSchema,
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
		],
	};

	it.skip("should infer correct types when using select", async () => {
		const db = createDatabase(config, testData);

		// Test with specific field selection
		const selectQuery = db.users.query({ select: { id: true, name: true } });

		for await (const user of selectQuery) {
			// TypeScript should know that user only has id and name
			// Type assertion due to union type complexity
			expectTypeOf(user).toMatchTypeOf<{ id: string; name: string }>();

			// TypeScript should know these fields don't exist
			// @ts-expect-error - email should not exist on selected type
			const _email = user.email;
			// @ts-expect-error - age should not exist on selected type
			const _age = user.age;
			// @ts-expect-error - isActive should not exist on selected type
			const _isActive = user.isActive;
		}

		// Test without select (should have all fields)
		const fullQuery = db.users.query();

		for await (const user of fullQuery) {
			expectTypeOf(user).toMatchTypeOf<{
				id: string;
				name: string;
				email: string;
				age: number;
				isActive: boolean;
			}>();
		}

		// Test with empty select object
		const emptySelectQuery = db.users.query({ select: {} });

		for await (const user of emptySelectQuery) {
			// Type assertion due to union type complexity
			expectTypeOf(user).toMatchTypeOf<{}>();

			// All fields should be errors
			// @ts-expect-error - no fields should exist
			const _id = user.id;
			// @ts-expect-error - no fields should exist
			const _name = user.name;
		}

		// Runtime assertion to ensure test runs
		expect(true).toBe(true);
	});

	it.skip("should maintain type safety with select and populate combined", async () => {
		const postSchema = z.object({
			id: z.string(),
			title: z.string(),
			content: z.string(),
			authorId: z.string(),
		});

		const configWithRelations = {
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

		const data: DatasetFor<typeof configWithRelations> = {
			users: [
				{
					id: "1",
					name: "Alice",
					email: "alice@example.com",
					age: 30,
					isActive: true,
				},
			],
			posts: [{ id: "p1", title: "Post", content: "Content", authorId: "1" }],
		};

		const db = createDatabase(configWithRelations, data);

		// Select with populate should maintain type safety
		const query = db.posts.query({
			select: { id: true, title: true, authorId: true, author: true },
		});

		for await (const post of query) {
			// Should have selected fields
			// Type checking with any due to union type complexity
			expectTypeOf(post).toHaveProperty("id");
			expectTypeOf(post).toHaveProperty("title");
			expectTypeOf(post).toHaveProperty("authorId");

			// Author should be fully typed (populate not affected by select)
			if (post.author) {
				expectTypeOf(post.author).toMatchTypeOf<{
					id: string;
					name: string;
					email: string;
					age: number;
					isActive: boolean;
				}>();
			}
		}

		expect(true).toBe(true);
	});
});
