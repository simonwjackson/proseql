import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "../../core/factories/database-effect"
import type { EffectDatabase } from "../../core/factories/database-effect"

// Effect Schemas
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
})

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	categoryId: Schema.String,
	status: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
})

const CategorySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const CommentSchema = Schema.Struct({
	id: Schema.String,
	content: Schema.String,
	postId: Schema.String,
	authorId: Schema.String,
	flagged: Schema.optional(Schema.Boolean, { default: () => false }),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
})

const LogSchema = Schema.Struct({
	id: Schema.String,
	message: Schema.String,
	level: Schema.String,
	userId: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
			posts: { type: "inverse" as const, target: "posts" as const, foreignKey: "authorId" },
			comments: { type: "inverse" as const, target: "comments" as const, foreignKey: "authorId" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			users: { type: "inverse" as const, target: "users" as const, foreignKey: "companyId" },
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" as const, foreignKey: "authorId" },
			category: { type: "ref" as const, target: "categories" as const },
			comments: { type: "inverse" as const, target: "comments" as const, foreignKey: "postId" },
		},
	},
	categories: {
		schema: CategorySchema,
		relationships: {
			posts: { type: "inverse" as const, target: "posts" as const, foreignKey: "categoryId" },
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
			user: { type: "ref" as const, target: "users" as const, foreignKey: "userId" },
		},
	},
} as const

describe("CRUD Delete Operations (Effect-based)", () => {
	let db: EffectDatabase<typeof config>
	let now: string
	let thirtyDaysAgo: string

	beforeEach(async () => {
		now = new Date().toISOString()
		const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
		thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

		db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [
					{ id: "user1", name: "John Doe", email: "john@example.com", age: 30, companyId: "comp1", createdAt: now, updatedAt: now },
					{ id: "user2", name: "Jane Smith", email: "jane@example.com", age: 25, companyId: "comp2", createdAt: now, updatedAt: now },
					{ id: "user3", name: "Bob Johnson", email: "bob@example.com", age: 35, companyId: "comp1", createdAt: thirtyDaysAgo, updatedAt: thirtyDaysAgo, deletedAt: thirtyDaysAgo },
				],
				companies: [
					{ id: "comp1", name: "TechCorp", createdAt: now, updatedAt: now },
					{ id: "comp2", name: "DataInc", createdAt: now, updatedAt: now },
				],
				posts: [
					{ id: "post1", title: "First Post", content: "Hello World", authorId: "user1", categoryId: "cat1", status: "published", createdAt: now, updatedAt: now },
					{ id: "post2", title: "Second Post", content: "Another post", authorId: "user2", categoryId: "cat1", status: "draft", createdAt: now, updatedAt: now },
					{ id: "post3", title: "Old Post", content: "Archived content", authorId: "user1", categoryId: "cat2", status: "archived", createdAt: oneYearAgo, updatedAt: oneYearAgo },
				],
				categories: [
					{ id: "cat1", name: "Technology", description: "Tech posts", createdAt: now, updatedAt: now },
					{ id: "cat2", name: "Archive", description: "Old posts", createdAt: now, updatedAt: now },
				],
				comments: [
					{ id: "comm1", content: "Great post!", postId: "post1", authorId: "user2", flagged: false, createdAt: now, updatedAt: now },
					{ id: "comm2", content: "Spam comment", postId: "post1", authorId: "user3", flagged: true, createdAt: now, updatedAt: now },
					{ id: "comm3", content: "Another comment", postId: "post2", authorId: "user1", flagged: false, createdAt: now, updatedAt: now },
				],
				logs: [
					{ id: "log1", message: "User logged in", level: "info", userId: "user1", createdAt: now },
					{ id: "log2", message: "Old log entry", level: "info", createdAt: oneYearAgo },
					{ id: "log3", message: "Error occurred", level: "error", createdAt: thirtyDaysAgo },
				],
			}),
		)
	})

	describe("delete method (single entity)", () => {
		describe("hard delete", () => {
			it("should delete entity and return it", async () => {
				await db.comments.deleteMany((c) => c.postId === "post2").runPromise
				await db.comments.deleteMany((c) => c.authorId === "user2").runPromise
				await db.posts.deleteMany((p) => p.authorId === "user2").runPromise

				const result = await db.users.delete("user2").runPromise

				expect(result.id).toBe("user2")
				expect(result.name).toBe("Jane Smith")

				const users = await db.users.query().runPromise
				expect(users).toHaveLength(2)
				expect(users.find((u: Record<string, unknown>) => u.id === "user2")).toBeUndefined()
			})

			it("should delete entity without soft delete field", async () => {
				await db.posts.deleteMany((p) => p.categoryId === "cat2").runPromise

				const result = await db.categories.delete("cat2").runPromise

				expect(result.id).toBe("cat2")
				expect(result.name).toBe("Archive")

				const categories = await db.categories.query().runPromise
				expect(categories).toHaveLength(1)
			})
		})

		describe("soft delete", () => {
			it("should soft delete entity with deletedAt field", async () => {
				await db.comments.deleteMany((c) => c.postId === "post1" || c.postId === "post3").runPromise
				await db.comments.deleteMany((c) => c.authorId === "user1").runPromise
				await db.posts.deleteMany((p) => p.authorId === "user1").runPromise
				await db.logs.deleteMany((l) => l.userId === "user1").runPromise

				const result = await db.users.delete("user1", { soft: true }).runPromise

				expect(result.id).toBe("user1")
				expect(result.deletedAt).toBeDefined()

				const allUsers = await db.users.query().runPromise
				const deletedUser = allUsers.find((u: Record<string, unknown>) => u.id === "user1")
				expect(deletedUser).toBeDefined()
				expect(deletedUser?.deletedAt).toBeDefined()
			})

			it("should soft delete posts", async () => {
				const beforeDelete = new Date()
				await db.comments.deleteMany((c) => c.postId === "post2").runPromise

				const result = await db.posts.delete("post2", { soft: true }).runPromise

				expect(result.id).toBe("post2")
				expect(result.deletedAt).toBeDefined()
				expect(new Date(result.deletedAt!).getTime()).toBeGreaterThanOrEqual(beforeDelete.getTime())
			})

			it("should fail soft delete on entity without deletedAt field", async () => {
				const error = await Effect.runPromise(
					db.categories.delete("cat1", { soft: true }).pipe(Effect.flip),
				)

				expect(error._tag).toBe("OperationError")

				const categories = await db.categories.query().runPromise
				expect(categories.find((c: Record<string, unknown>) => c.id === "cat1")).toBeDefined()
			})
		})

		describe("error handling", () => {
			it("should return NotFoundError for non-existent entity", async () => {
				const error = await Effect.runPromise(
					db.users.delete("non-existent").pipe(Effect.flip),
				)
				expect(error._tag).toBe("NotFoundError")
			})

			it("should handle foreign key constraints", async () => {
				const error = await Effect.runPromise(
					db.users.delete("user1").pipe(Effect.flip),
				)
				expect(error._tag).toBe("OperationError")
			})

			it("should handle cascade delete restrictions", async () => {
				const error = await Effect.runPromise(
					db.companies.delete("comp1").pipe(Effect.flip),
				)
				expect(error._tag).toBe("OperationError")
			})
		})
	})

	describe("deleteMany method (batch delete)", () => {
		describe("basic batch deletion", () => {
			it("should delete all matching entities", async () => {
				const result = await db.comments.deleteMany((c) => c.flagged === true).runPromise

				expect(result.count).toBe(1)
				expect(result.deleted).toHaveLength(1)
				expect(result.deleted[0].id).toBe("comm2")

				const comments = await db.comments.query().runPromise
				expect(comments).toHaveLength(2)
			})

			it("should delete with complex conditions", async () => {
				const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()

				const result = await db.logs.deleteMany(
					(l) => l.createdAt !== undefined && l.createdAt < sixMonthsAgo,
				).runPromise

				expect(result.count).toBe(1)
				expect(result.deleted[0].id).toBe("log2")
			})

			it("should delete with OR-like conditions", async () => {
				await db.comments.deleteMany((c) => c.postId === "post2").runPromise

				const result = await db.posts.deleteMany(
					(p) => p.status === "draft" || p.status === "archived",
				).runPromise

				expect(result.count).toBe(2)
				expect(result.deleted.map((p) => p.id).sort()).toEqual(["post2", "post3"])

				const posts = await db.posts.query().runPromise
				expect(posts).toHaveLength(1)
			})

			it("should handle empty matches", async () => {
				const result = await db.users.deleteMany((u) => u.age > 100).runPromise

				expect(result.count).toBe(0)
				expect(result.deleted).toHaveLength(0)
			})

			it("should delete all when predicate always true", async () => {
				const result = await db.logs.deleteMany(() => true).runPromise

				expect(result.count).toBe(3)
				expect(result.deleted).toHaveLength(3)

				const logs = await db.logs.query().runPromise
				expect(logs).toHaveLength(0)
			})
		})

		describe("batch soft delete", () => {
			it("should soft delete multiple entities", async () => {
				const result = await db.comments.deleteMany(
					(c) => c.postId === "post1",
					{ soft: true },
				).runPromise

				expect(result.count).toBe(2)
				expect(result.deleted.every((c) => c.deletedAt)).toBe(true)

				const comments = await db.comments.query().runPromise
				expect(comments).toHaveLength(3)
			})

			it("should handle mixed soft delete capability", async () => {
				const error = await Effect.runPromise(
					db.logs.deleteMany((l) => l.level === "error", { soft: true }).pipe(Effect.flip),
				)

				expect(error._tag).toBe("OperationError")

				const logs = await db.logs.query().runPromise
				expect(logs).toHaveLength(3)
			})
		})

		describe("batch delete with limit", () => {
			it("should respect limit option", async () => {
				const result = await db.comments.deleteMany(() => true, { limit: 2 }).runPromise

				expect(result.count).toBe(2)
				expect(result.deleted).toHaveLength(2)

				const comments = await db.comments.query().runPromise
				expect(comments).toHaveLength(1)
			})

			it("should handle limit with soft delete", async () => {
				await db.comments.deleteMany(() => true).runPromise

				const result = await db.posts.deleteMany(() => true, { soft: true, limit: 1 }).runPromise

				expect(result.count).toBe(1)
				expect(result.deleted).toHaveLength(1)
				expect(result.deleted[0].deletedAt).toBeDefined()
			})

			it("should apply limit after filtering", async () => {
				const result = await db.comments.deleteMany(
					(c) => c.flagged === false,
					{ limit: 1 },
				).runPromise

				expect(result.count).toBe(1)
				expect(result.deleted).toHaveLength(1)

				const comments = await db.comments.query().runPromise
				expect(comments).toHaveLength(2)
			})
		})

		describe("batch delete error handling", () => {
			it("should handle empty result gracefully", async () => {
				const result = await db.posts.deleteMany(
					(p) => p.title.includes("NonExistent"),
				).runPromise

				expect(result.count).toBe(0)
				expect(result.deleted).toHaveLength(0)
			})

			it("should handle negative limit by deleting all", async () => {
				const result = await db.logs.deleteMany(() => true, { limit: -1 }).runPromise
				expect(result.count).toBe(3)
			})
		})

		describe("cascade behavior", () => {
			it("should prevent deletion of entities with dependents", async () => {
				const error = await Effect.runPromise(
					db.users.delete("user2").pipe(Effect.flip),
				)
				expect(error._tag).toBe("OperationError")

				const users = await db.users.query().runPromise
				expect(users.find((u: Record<string, unknown>) => u.id === "user2")).toBeDefined()
			})

			it("should prevent deletion of referenced entities", async () => {
				const error = await Effect.runPromise(
					db.categories.delete("cat1").pipe(Effect.flip),
				)
				expect(error._tag).toBe("OperationError")

				const categories = await db.categories.query().runPromise
				expect(categories.find((c: Record<string, unknown>) => c.id === "cat1")).toBeDefined()
			})
		})
	})
})
