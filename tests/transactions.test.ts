import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"
import { NotFoundError } from "../core/errors/crud-errors.js"

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

// ============================================================================
// Custom Test Errors
// ============================================================================

class TestBusinessError extends Error {
	readonly _tag = "TestBusinessError"
	constructor(message: string) {
		super(message)
		this.name = "TestBusinessError"
	}
}

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

	describe("explicit rollback", () => {
		it("should revert all changes when ctx.rollback() is called mid-transaction", async () => {
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

			// Execute transaction that creates entities then explicitly rolls back
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create user and post - should be reverted on rollback
						const newUser = yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})
						yield* ctx.posts.create({
							id: "p3",
							title: "Charlie's Post",
							content: "This will be rolled back",
							authorId: newUser.id,
						})

						// Verify entities exist within the transaction (read-own-writes)
						const userInTx = yield* ctx.users.findById("u3")
						expect(userInTx.name).toBe("Charlie")

						const postInTx = yield* ctx.posts.findById("p3")
						expect(postInTx.title).toBe("Charlie's Post")

						// Explicitly rollback mid-transaction
						return yield* ctx.rollback()
					}),
				)
				.pipe(Effect.either, Effect.runPromise)

			// Verify the transaction resulted in a TransactionError from rollback
			expect(result._tag).toBe("Left")
			if (result._tag === "Left") {
				// The error should be a TransactionError with operation "rollback"
				const error = result.left as { readonly _tag?: string; readonly operation?: string }
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
			}

			// Verify all changes were reverted
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)

			expect(finalUsers).toHaveLength(2)
			expect(finalPosts).toHaveLength(2)
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined()
			expect(finalPosts.find((p) => p.id === "p3")).toBeUndefined()

			// Verify original data is still intact
			expect(finalUsers.find((u) => u.id === "u1")?.name).toBe("Alice")
			expect(finalUsers.find((u) => u.id === "u2")?.name).toBe("Bob")
			expect(finalPosts.find((p) => p.id === "p1")?.title).toBe("Hello World")
			expect(finalPosts.find((p) => p.id === "p2")?.title).toBe("TypeScript Tips")
		})
	})

	describe("failed transactions", () => {
		it("should revert user creation when transaction fails with Effect.fail", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(initialUsers).toHaveLength(2)
			expect(initialUsers.find((u) => u.id === "u3")).toBeUndefined()

			// Execute transaction that creates a user then fails
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create user - this should be reverted on rollback
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})

						// Verify the user exists within the transaction (read-own-writes)
						const userInTx = yield* ctx.users.findById("u3")
						expect(userInTx.name).toBe("Charlie")

						// Now fail the transaction with a business error
						return yield* Effect.fail(
							new TestBusinessError("Simulated failure after user creation"),
						)
					}),
				)
				.pipe(
					Effect.either,
					Effect.runPromise,
				)

			// Verify the transaction failed with our error
			expect(result._tag).toBe("Left")
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(TestBusinessError)
				expect((result.left as TestBusinessError).message).toBe(
					"Simulated failure after user creation",
				)
			}

			// Verify the user creation was reverted
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(finalUsers).toHaveLength(2)
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined()

			// Verify original users are still intact
			expect(finalUsers.find((u) => u.id === "u1")?.name).toBe("Alice")
			expect(finalUsers.find((u) => u.id === "u2")?.name).toBe("Bob")
		})

		it("should preserve original CRUD error type accessible via catchTag after rollback", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Execute transaction that triggers a CRUD error (NotFoundError)
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Try to find a non-existent user - this will fail with NotFoundError
						const user = yield* ctx.users.findById("non-existent-id")
						return user
					}),
				)
				.pipe(
					// Use catchTag to verify the original error type is preserved
					Effect.catchTag("NotFoundError", (error) =>
						Effect.succeed({
							caught: true,
							errorTag: error._tag,
							collection: error.collection,
							id: error.id,
						}),
					),
					Effect.runPromise,
				)

			// Verify the NotFoundError was caught and its properties are accessible
			expect(result).toEqual({
				caught: true,
				errorTag: "NotFoundError",
				collection: "users",
				id: "non-existent-id",
			})

			// Verify database state is unchanged (rollback happened)
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(users).toHaveLength(2)
		})

		it("should preserve custom business error type accessible via catchTag after rollback", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Execute transaction that fails with custom error after successful operation
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create a user (this will be rolled back)
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})

						// Fail with our custom error
						return yield* Effect.fail(new TestBusinessError("Custom failure message"))
					}),
				)
				.pipe(
					// Catch by checking the _tag property (since TestBusinessError uses _tag)
					Effect.catchIf(
						(error): error is TestBusinessError =>
							error instanceof TestBusinessError && error._tag === "TestBusinessError",
						(error) =>
							Effect.succeed({
								caught: true,
								errorTag: error._tag,
								message: error.message,
							}),
					),
					Effect.runPromise,
				)

			// Verify the custom error was caught with full properties
			expect(result).toEqual({
				caught: true,
				errorTag: "TestBusinessError",
				message: "Custom failure message",
			})

			// Verify user creation was rolled back
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(users).toHaveLength(2)
			expect(users.find((u) => u.id === "u3")).toBeUndefined()
		})
	})

	describe("nested transactions", () => {
		it("should reject nested $transaction with TransactionError", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Attempt to nest a $transaction inside another $transaction
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create a user in the outer transaction
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})

						// Attempt to start a nested transaction - this should fail
						const nestedResult = yield* db.$transaction((innerCtx) =>
							Effect.gen(function* () {
								yield* innerCtx.users.create({
									id: "u4",
									name: "Diana",
									email: "diana@test.com",
									age: 28,
								})
								return "nested completed"
							}),
						)

						return nestedResult
					}),
				)
				.pipe(Effect.either, Effect.runPromise)

			// Verify the transaction failed with TransactionError
			expect(result._tag).toBe("Left")
			if (result._tag === "Left") {
				const error = result.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("begin")
				expect(error.reason).toBe("nested transactions not supported")
			}

			// Verify both user creations were rolled back (the outer transaction's user too)
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(users).toHaveLength(2)
			expect(users.find((u) => u.id === "u3")).toBeUndefined()
			expect(users.find((u) => u.id === "u4")).toBeUndefined()
		})

		it("should allow new transaction after previous completes", async () => {
			const db = await Effect.runPromise(createTestDb())

			// First transaction - creates a user
			await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})
						return "first completed"
					}),
				)
				.pipe(Effect.runPromise)

			// Second transaction - should work since first one completed
			await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						yield* ctx.users.create({
							id: "u4",
							name: "Diana",
							email: "diana@test.com",
							age: 28,
						})
						return "second completed"
					}),
				)
				.pipe(Effect.runPromise)

			// Verify both users were created
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(users).toHaveLength(4)
			expect(users.find((u) => u.id === "u3")?.name).toBe("Charlie")
			expect(users.find((u) => u.id === "u4")?.name).toBe("Diana")
		})
	})
})
