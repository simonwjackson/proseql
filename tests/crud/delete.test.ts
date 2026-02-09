import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import {
	isOk,
	isErr,
	type Result,
	type CrudError,
} from "../../core/errors/crud-errors";
import { collect } from "../../core/utils/async-iterable.js";
import { softDeleteOptions, softDeleteManyOptions } from "./test-helpers";

describe("CRUD Delete Operations", () => {
	// Test schemas
	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string().email(),
		age: z.number().min(0).max(150),
		companyId: z.string(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(), // For soft delete
	});

	const CompanySchema = z.object({
		id: z.string(),
		name: z.string(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(), // For soft delete
	});

	const PostSchema = z.object({
		id: z.string(),
		title: z.string(),
		content: z.string(),
		authorId: z.string(),
		categoryId: z.string(),
		status: z.enum(["draft", "published", "archived"]),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(), // For soft delete
	});

	const CategorySchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	const CommentSchema = z.object({
		id: z.string(),
		content: z.string(),
		postId: z.string(),
		authorId: z.string(),
		flagged: z.boolean().default(false),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(), // For soft delete
	});

	const LogSchema = z.object({
		id: z.string(),
		message: z.string(),
		level: z.enum(["info", "warning", "error"]),
		userId: z.string().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	// Test configuration with cascade delete relationships
	const config = {
		users: {
			schema: UserSchema,
			relationships: {
				company: { type: "ref" as const, target: "companies" as const },
				posts: {
					type: "inverse" as const,
					target: "posts" as const,
					foreignKey: "authorId",
				},
				comments: {
					type: "inverse" as const,
					target: "comments" as const,
					foreignKey: "authorId",
				},
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				users: {
					type: "inverse" as const,
					target: "users" as const,
					foreignKey: "companyId",
				},
			},
		},
		posts: {
			schema: PostSchema,
			relationships: {
				author: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "authorId",
				},
				category: { type: "ref" as const, target: "categories" as const },
				comments: {
					type: "inverse" as const,
					target: "comments" as const,
					foreignKey: "postId",
				},
			},
		},
		categories: {
			schema: CategorySchema,
			relationships: {
				posts: {
					type: "inverse" as const,
					target: "posts" as const,
					foreignKey: "categoryId",
				},
			},
		},
		comments: {
			schema: CommentSchema,
			relationships: {
				post: { type: "ref" as const, target: "posts" as const },
				author: { type: "ref" as const, target: "users" as const },
			},
		},
		logs: {
			schema: LogSchema,
			relationships: {
				user: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "userId",
				},
			},
		},
	} as const;

	// Test data
	let testData: {
		users: z.infer<typeof UserSchema>[];
		companies: z.infer<typeof CompanySchema>[];
		posts: z.infer<typeof PostSchema>[];
		categories: z.infer<typeof CategorySchema>[];
		comments: z.infer<typeof CommentSchema>[];
		logs: z.infer<typeof LogSchema>[];
	};

	beforeEach(() => {
		const now = new Date().toISOString();
		const oneYearAgo = new Date(
			Date.now() - 365 * 24 * 60 * 60 * 1000,
		).toISOString();
		const thirtyDaysAgo = new Date(
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		).toISOString();

		testData = {
			users: [
				{
					id: "user1",
					name: "John Doe",
					email: "john@example.com",
					age: 30,
					companyId: "comp1",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "user2",
					name: "Jane Smith",
					email: "jane@example.com",
					age: 25,
					companyId: "comp2",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "user3",
					name: "Bob Johnson",
					email: "bob@example.com",
					age: 35,
					companyId: "comp1",
					createdAt: thirtyDaysAgo,
					updatedAt: thirtyDaysAgo,
					deletedAt: thirtyDaysAgo, // Already soft deleted
				},
			],
			companies: [
				{
					id: "comp1",
					name: "TechCorp",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "comp2",
					name: "DataInc",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
			],
			posts: [
				{
					id: "post1",
					title: "First Post",
					content: "Hello World",
					authorId: "user1",
					categoryId: "cat1",
					status: "published",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "post2",
					title: "Second Post",
					content: "Another post",
					authorId: "user2",
					categoryId: "cat1",
					status: "draft",
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "post3",
					title: "Old Post",
					content: "Archived content",
					authorId: "user1",
					categoryId: "cat2",
					status: "archived",
					createdAt: oneYearAgo,
					updatedAt: oneYearAgo,
					deletedAt: undefined,
				},
			],
			categories: [
				{
					id: "cat1",
					name: "Technology",
					description: "Tech posts",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "cat2",
					name: "Archive",
					description: "Old posts",
					createdAt: now,
					updatedAt: now,
				},
			],
			comments: [
				{
					id: "comm1",
					content: "Great post!",
					postId: "post1",
					authorId: "user2",
					flagged: false,
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "comm2",
					content: "Spam comment",
					postId: "post1",
					authorId: "user3",
					flagged: true,
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
				{
					id: "comm3",
					content: "Another comment",
					postId: "post2",
					authorId: "user1",
					flagged: false,
					createdAt: now,
					updatedAt: now,
					deletedAt: undefined,
				},
			],
			logs: [
				{
					id: "log1",
					message: "User logged in",
					level: "info",
					userId: "user1",
					createdAt: now,
				},
				{
					id: "log2",
					message: "Old log entry",
					level: "info",
					createdAt: oneYearAgo,
				},
				{
					id: "log3",
					message: "Error occurred",
					level: "error",
					createdAt: thirtyDaysAgo,
				},
			],
		};
	});

	describe("delete method (single entity)", () => {
		describe("hard delete", () => {
			it("should delete entity and return it", async () => {
				const db = createDatabase(config, testData);

				// Delete in proper order: comments first, then posts, then user
				// Delete all comments on posts by user2
				await db.comments.deleteMany({ postId: "post2" }); // post2 is by user2
				// Delete comments authored by user2
				await db.comments.deleteMany({ authorId: "user2" });
				// Now delete posts by user2
				await db.posts.deleteMany({ authorId: "user2" });

				const result = await db.users.delete("user2");

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("user2");
					expect(result.data.name).toBe("Jane Smith");
				}

				// Verify entity is removed from database
				const users = await collect(db.users.query());
				expect(users).toHaveLength(2); // user1 and user3
				expect(users.find((u) => u.id === "user2")).toBeUndefined();
			});

			it("should delete entity without soft delete field", async () => {
				const db = createDatabase(config, testData);

				// First delete posts in cat2
				await db.posts.deleteMany({ categoryId: "cat2" });

				const result = await db.categories.delete("cat2");

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("cat2");
					expect(result.data.name).toBe("Archive");
				}

				// Verify hard deletion
				const categories = await collect(db.categories.query());
				expect(categories).toHaveLength(1);
				expect(categories[0].id).toBe("cat1");
			});

			it("should handle returnDeleted option", async () => {
				const db = createDatabase(config, testData);

				// First delete comments on post1
				await db.comments.deleteMany({ postId: "post1" });

				const result = await db.posts.delete("post1", { returnDeleted: true });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("post1");
					expect(result.data.title).toBe("First Post");
				}

				// Verify deletion
				const posts = await collect(db.posts.query());
				expect(posts.find((p) => p.id === "post1")).toBeUndefined();
			});
		});

		describe("soft delete", () => {
			it("should soft delete entity with deletedAt field", async () => {
				const db = createDatabase(config, testData);

				// Delete in proper order: comments on user1's posts first
				await db.comments.deleteMany({ postId: "post1" }); // post1 is by user1
				await db.comments.deleteMany({ postId: "post3" }); // post3 is by user1
				// Delete comments authored by user1
				await db.comments.deleteMany({ authorId: "user1" });
				// Now delete posts by user1
				await db.posts.deleteMany({ authorId: "user1" });
				// Delete logs referencing user1
				await db.logs.deleteMany({ userId: "user1" });

				// Using explicit options - TypeScript should infer this correctly
				const result = await db.users.delete("user1", { soft: true });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("user1");
					expect(result.data.deletedAt).toBeDefined();
				}

				// Verify entity still exists but is marked as deleted
				const allUsers = await collect(db.users.query());
				const deletedUser = allUsers.find((u) => u.id === "user1");
				expect(deletedUser).toBeDefined();
				expect(deletedUser?.deletedAt).toBeDefined();
			});

			it("should soft delete posts", async () => {
				const db = createDatabase(config, testData);
				const beforeDelete = new Date();

				// First delete comments on post2
				await db.comments.deleteMany({ postId: "post2" });

				const result = await db.posts.delete("post2", { soft: true });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("post2");
					expect(result.data.deletedAt).toBeDefined();

					// Verify timestamp is recent
					const deletedAt = new Date(result.data.deletedAt!);
					expect(deletedAt.getTime()).toBeGreaterThanOrEqual(
						beforeDelete.getTime(),
					);
				}
			});

			it("should handle soft delete on already soft-deleted entity", async () => {
				const db = createDatabase(config, testData);

				// First delete dependent entities for user3
				await db.posts.deleteMany({ authorId: "user3" });
				await db.comments.deleteMany({ authorId: "user3" });
				await db.logs.deleteMany({ userId: "user3" });

				// user3 is already soft deleted
				const deleteOpts = softDeleteOptions<z.infer<typeof UserSchema>>({
					soft: true,
				});
				const result = await db.users.delete("user3", deleteOpts);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.id).toBe("user3");
					// Should keep original deletedAt
					expect(result.data.deletedAt).toBe(testData.users[2].deletedAt);
				}
			});

			it("should fail soft delete on entity without deletedAt field", async () => {
				const db = createDatabase(config, testData);

				// Categories don't have deletedAt field
				// TypeScript correctly prevents soft delete on entities without deletedAt
				// But we want to test the runtime error handling
				const result = await (
					db.categories.delete as (
						id: string,
						options: { soft: boolean },
					) => Promise<Result<unknown, CrudError<unknown>>>
				)("cat1", { soft: true });

				// Should return an error because categories don't have deletedAt
				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("OPERATION_NOT_ALLOWED");
					expect(result.error.message).toContain(
						"Entity does not have a deletedAt field",
					);
				}

				// Verify it was NOT deleted
				const categories = await collect(db.categories.query());
				expect(categories.find((c) => c.id === "cat1")).toBeDefined();
			});
		});

		describe("error handling", () => {
			it("should return NOT_FOUND error for non-existent entity", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.delete("non-existent");

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("NOT_FOUND");
					// TypeScript requires narrowing the error type
					if (result.error.code === "NOT_FOUND") {
						expect(result.error.entity).toBe("users");
						expect(result.error.id).toBe("non-existent");
					}
				}
			});

			it("should handle cascade delete restrictions", async () => {
				const db = createDatabase(config, testData);

				// Try to delete a company that has users
				const result = await db.companies.delete("comp1");

				// Should fail because comp1 has users referencing it
				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("OPERATION_NOT_ALLOWED");
					expect(result.error.message).toContain("Cannot delete");
					expect(result.error.message).toContain(
						"users entities reference this companies",
					);
				}
			});

			it("should handle foreign key constraints", async () => {
				const db = createDatabase(config, testData);

				// Try to delete a user that has posts
				const result = await db.users.delete("user1");

				// Should fail because user1 has posts and other dependencies
				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("OPERATION_NOT_ALLOWED");
					expect(result.error.message).toContain("Cannot delete");
					// Message will mention one of the dependent collections
					expect(result.error.message).toMatch(/posts|comments|logs/);
				}
			});
		});
	});

	describe("deleteMany method (batch delete)", () => {
		describe("basic batch deletion", () => {
			it("should delete all matching entities", async () => {
				const db = createDatabase(config, testData);

				const result = await db.comments.deleteMany({
					flagged: true,
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1); // Only comm2 is flagged
					expect(result.data.deleted).toHaveLength(1);
					expect(result.data.deleted[0].id).toBe("comm2");
				}

				// Verify deletion
				const comments = await collect(db.comments.query());
				expect(comments).toHaveLength(2); // comm1 and comm3 remain
				expect(comments.find((c) => c.flagged)).toBeUndefined();
			});

			it("should delete with complex conditions", async () => {
				const db = createDatabase(config, testData);
				// Use a date 6 months ago to ensure we capture the year-old log
				const sixMonthsAgo = new Date(
					Date.now() - 180 * 24 * 60 * 60 * 1000,
				).toISOString();

				const result = await db.logs.deleteMany({
					createdAt: { $lt: sixMonthsAgo },
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1); // log2 (created oneYearAgo)
					expect(result.data.deleted[0].id).toBe("log2");
				}

				// Verify only recent logs remain
				const logs = await collect(db.logs.query());
				expect(logs).toHaveLength(2);
				expect(
					logs.every((l) => new Date(l.createdAt!) > new Date(sixMonthsAgo)),
				).toBe(true);
			});

			it("should delete with OR conditions", async () => {
				const db = createDatabase(config, testData);

				// First delete comments on posts that will be deleted
				await db.comments.deleteMany({ postId: "post2" });
				// post3 doesn't have comments

				const result = await db.posts.deleteMany({
					$or: [{ status: "draft" }, { status: "archived" }],
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // post2 and post3
					expect(result.data.deleted.map((p) => p.id).sort()).toEqual([
						"post2",
						"post3",
					]);
				}

				// Only published posts remain
				const posts = await collect(db.posts.query());
				expect(posts).toHaveLength(1);
				expect(posts[0].status).toBe("published");
			});

			it("should handle empty matches", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.deleteMany({
					age: { $gt: 100 }, // No users over 100
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(0);
					expect(result.data.deleted).toHaveLength(0);
				}

				// Verify no users were deleted
				const users = await collect(db.users.query());
				expect(users).toHaveLength(3);
			});

			it("should delete all when empty where clause", async () => {
				const db = createDatabase(config, testData);

				const result = await db.logs.deleteMany({});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(3); // All logs
					expect(result.data.deleted).toHaveLength(3);
				}

				// Verify all logs deleted
				const logs = await collect(db.logs.query());
				expect(logs).toHaveLength(0);
			});
		});

		describe("batch soft delete", () => {
			it("should soft delete multiple entities", async () => {
				const db = createDatabase(config, testData);

				const result = await db.comments.deleteMany(
					{ postId: "post1" },
					{ soft: true },
				);

				if (isErr(result)) {
					console.error("Soft delete comments error:", result.error);
				}

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // comm1 and comm2
					expect(result.data.deleted.every((c) => c.deletedAt)).toBe(true);
				}

				// Verify soft deletion
				const comments = await collect(db.comments.query());
				expect(comments).toHaveLength(3); // All still exist
				const post1Comments = comments.filter((c) => c.postId === "post1");
				expect(post1Comments.every((c) => c.deletedAt)).toBe(true);
			});

			it("should handle mixed soft delete capability", async () => {
				const db = createDatabase(config, testData);

				// Try soft delete on logs (no deletedAt field)
				// TypeScript correctly prevents soft delete on entities without deletedAt
				// But we want to test the runtime error handling
				const result = await (
					db.logs.deleteMany as (
						where: unknown,
						options: { soft: boolean },
					) => Promise<Result<unknown, CrudError<unknown>>>
				)({ level: "error" }, { soft: true });

				// Should fail because logs don't have deletedAt field
				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("OPERATION_NOT_ALLOWED");
					expect(result.error.message).toContain(
						"Entities do not have a deletedAt field",
					);
				}

				// Verify no logs were deleted
				const logs = await collect(db.logs.query());
				expect(logs).toHaveLength(3);
				expect(logs.find((l) => l.level === "error")).toBeDefined();
			});

			it("should respect already soft-deleted entities", async () => {
				const db = createDatabase(config, testData);

				// First delete dependencies for user1 (user3 is already soft deleted)
				// Delete in order: comments -> posts -> logs
				// First delete all comments on user1's posts
				const user1Posts = await collect(
					db.posts.query({ where: { authorId: "user1" } }),
				);
				for (const post of user1Posts) {
					await db.comments.deleteMany({ postId: post.id });
				}

				// Then delete user1's posts
				await db.posts.deleteMany({ authorId: "user1" });

				// Delete user1's comments
				await db.comments.deleteMany({ authorId: "user1" });

				// Delete user1's logs
				await db.logs.deleteMany({ userId: "user1" });

				// user3 is already soft deleted
				const result = await db.users.deleteMany(
					{ companyId: "comp1" },
					{ soft: true },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					// Both user1 and user3 match the filter, both are returned as "deleted"
					// even though user3 was already soft-deleted
					expect(result.data.count).toBe(2);
					expect(result.data.deleted).toHaveLength(2);

					// Verify user1 has a new deletedAt timestamp
					const user1 = result.data.deleted.find((u) => u.id === "user1");
					expect(user1?.deletedAt).toBeDefined();

					// Verify user3 still has its old deletedAt timestamp
					const user3 = result.data.deleted.find((u) => u.id === "user3");
					expect(user3?.deletedAt).toBe(testData.users[2].deletedAt);
				}
			});
		});

		describe("batch delete with limit", () => {
			it("should respect limit option", async () => {
				const db = createDatabase(config, testData);

				const result = await db.comments.deleteMany({}, { limit: 2 });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // Limited to 2
					expect(result.data.deleted).toHaveLength(2);
				}

				// Verify one comment remains
				const comments = await collect(db.comments.query());
				expect(comments).toHaveLength(1);
			});

			it("should handle limit with soft delete", async () => {
				const db = createDatabase(config, testData);

				// First delete all comments to avoid foreign key constraints
				await db.comments.deleteMany({});

				const result = await db.posts.deleteMany({}, { soft: true, limit: 1 });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1);
					expect(result.data.deleted).toHaveLength(1);
					expect(result.data.deleted[0].deletedAt).toBeDefined();
				}

				// Verify only one was soft deleted
				const posts = await collect(db.posts.query());
				expect(posts).toHaveLength(3); // All still exist
				const deletedPosts = posts.filter((p) => p.deletedAt);
				expect(deletedPosts).toHaveLength(1);
			});

			it("should apply limit after filtering", async () => {
				const db = createDatabase(config, testData);

				// Test on comments instead to avoid complex foreign key issues
				const result = await db.comments.deleteMany(
					{ flagged: false }, // Matches comm1 and comm3
					{ limit: 1 },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1);
					expect(result.data.deleted).toHaveLength(1);
				}

				// Two comments should remain (one not matching filter, one limited)
				const comments = await collect(db.comments.query());
				expect(comments).toHaveLength(2);
			});
		});

		describe("batch delete with relationships", () => {
			it("should delete entities based on relationship conditions", async () => {
				const db = createDatabase(config, testData);

				// First delete comments on posts by user1
				await db.comments.deleteMany({ postId: "post1" });
				// post3 doesn't have comments

				// Delete posts by author
				const result = await db.posts.deleteMany({
					authorId: "user1",
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // post1 and post3
					expect(result.data.deleted.map((p) => p.id).sort()).toEqual([
						"post1",
						"post3",
					]);
				}
			});

			it("should handle nested relationship queries", async () => {
				const db = createDatabase(config, testData);

				// Delete comments on posts in specific category
				const result = await db.comments.deleteMany({
					post: {
						categoryId: "cat1",
					},
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(3); // All comments are on cat1 posts
					expect(result.data.deleted).toHaveLength(3);
				}

				const comments = await collect(db.comments.query());
				expect(comments).toHaveLength(0);
			});

			it("should handle multiple relationship conditions", async () => {
				const db = createDatabase(config, testData);

				// Delete logs for users in specific company
				const result = await db.logs.deleteMany({
					user: {
						companyId: "comp1",
					},
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1); // log1 (user1 is in comp1)
					expect(result.data.deleted[0].id).toBe("log1");
				}
			});
		});

		describe("batch delete error handling", () => {
			it("should handle empty result gracefully", async () => {
				const db = createDatabase(config, testData);

				const result = await db.posts.deleteMany({
					title: { $contains: "NonExistent" },
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(0);
					expect(result.data.deleted).toHaveLength(0);
				}
			});

			it("should validate options", async () => {
				const db = createDatabase(config, testData);

				// Negative limit should be handled
				const result = await db.logs.deleteMany({}, { limit: -1 });

				// Implementation should ignore negative limit
				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					// Should ignore invalid limit and delete all
					expect(result.data.count).toBe(3);
				}
			});
		});

		describe("cascade behavior", () => {
			it("should handle orphaned references after deletion", async () => {
				const db = createDatabase(config, testData);

				// Try to delete a user that has comments
				const deleteResult = await db.users.delete("user2");

				// Should fail due to foreign key constraint
				expect(isErr(deleteResult)).toBe(true);
				if (isErr(deleteResult)) {
					expect(deleteResult.error.code).toBe("OPERATION_NOT_ALLOWED");
				}

				// Verify user still exists
				const users = await collect(db.users.query());
				expect(users.find((u) => u.id === "user2")).toBeDefined();

				// Comments still reference the user
				const comments = await collect(db.comments.query());
				const userComments = comments.filter((c) => c.authorId === "user2");
				expect(userComments).toHaveLength(1); // comm1
			});

			it("should allow deletion of referenced entities", async () => {
				const db = createDatabase(config, testData);

				// Try to delete a category that has posts
				const result = await db.categories.delete("cat1");

				// Should fail because cat1 has posts referencing it
				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("OPERATION_NOT_ALLOWED");
					expect(result.error.message).toContain(
						"posts entities reference this categories",
					);
				}

				// Verify category still exists
				const categories = await collect(db.categories.query());
				expect(categories.find((c) => c.id === "cat1")).toBeDefined();

				// Posts still exist with valid categoryId
				const posts = await collect(db.posts.query());
				const cat1Posts = posts.filter((p) => p.categoryId === "cat1");
				expect(cat1Posts).toHaveLength(2); // post1 and post2
			});
		});
	});
});
