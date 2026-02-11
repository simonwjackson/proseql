import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

// ============================================================================
// Test Config
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts" as const,
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" as const },
		},
	},
} as const

// ============================================================================
// Initial Data
// ============================================================================

const initialData = {
	users: [
		{ id: "u1", name: "Alice", email: "alice@test.com", age: 30 },
		{ id: "u2", name: "Bob", email: "bob@test.com", age: 25 },
	],
	posts: [
		{ id: "p1", title: "Hello World", content: "First post", authorId: "u1" },
		{ id: "p2", title: "TypeScript Tips", content: "Type safety", authorId: "u2" },
	],
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a fresh test database with initial data.
 * Returns the database ready for transaction testing.
 */
const createTestDb = () => createEffectDatabase(config, initialData)

// ============================================================================
// Transaction Callback Tests
// ============================================================================

describe("$transaction", () => {
	describe("successful transactions", () => {
		it("should have $transaction method on the database", async () => {
			const db = await Effect.runPromise(createTestDb())
			expect(typeof db.$transaction).toBe("function")
		})

		it("should create user and post in transaction, both visible after commit", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(initialUsers).toHaveLength(2)
			expect(initialPosts).toHaveLength(2)

			// Execute transaction that creates a new user and a post referencing them
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						const newUser = yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})
						const newPost = yield* ctx.posts.create({
							id: "p3",
							title: "Charlie's First Post",
							content: "Hello from Charlie",
							authorId: newUser.id,
						})
						return { user: newUser, post: newPost }
					}),
				)
				.pipe(Effect.runPromise)

			// Verify return value from transaction
			expect(result.user.id).toBe("u3")
			expect(result.user.name).toBe("Charlie")
			expect(result.post.id).toBe("p3")
			expect(result.post.authorId).toBe("u3")

			// Verify both entities are visible in the database after commit
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)

			expect(finalUsers).toHaveLength(3)
			expect(finalPosts).toHaveLength(3)

			// Verify the new entities exist with correct data
			const charlie = finalUsers.find((u) => u.id === "u3")
			expect(charlie).toBeDefined()
			expect(charlie?.name).toBe("Charlie")
			expect(charlie?.email).toBe("charlie@test.com")

			const charliePost = finalPosts.find((p) => p.id === "p3")
			expect(charliePost).toBeDefined()
			expect(charliePost?.title).toBe("Charlie's First Post")
			expect(charliePost?.authorId).toBe("u3")
		})
	})
})
