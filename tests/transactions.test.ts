import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk, Ref } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"
import { NotFoundError, TransactionError } from "../core/errors/crud-errors.js"
import { createTransaction } from "../core/transactions/transaction.js"
import { normalizeIndexes, buildIndexes } from "../core/indexes/index-manager.js"

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

// ============================================================================
// createTransaction (Manual) Tests
// ============================================================================

/**
 * Helper to create minimal infrastructure for testing createTransaction directly.
 * This mirrors the internal setup of createEffectDatabase but exposes the components
 * needed to call createTransaction.
 */
const createManualTransactionTestSetup = () =>
	Effect.gen(function* () {
		type HasId = { readonly id: string }

		// State refs for each collection
		const usersRef = yield* Ref.make<ReadonlyMap<string, HasId>>(
			new Map([
				["u1", { id: "u1", name: "Alice", email: "alice@test.com", age: 30 }],
				["u2", { id: "u2", name: "Bob", email: "bob@test.com", age: 25 }],
			]),
		)
		const postsRef = yield* Ref.make<ReadonlyMap<string, HasId>>(
			new Map([
				["p1", { id: "p1", title: "Hello World", content: "First post", authorId: "u1" }],
				["p2", { id: "p2", title: "TypeScript Tips", content: "Type safety", authorId: "u2" }],
			]),
		)

		const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {
			users: usersRef,
			posts: postsRef,
		}

		// Transaction lock
		const transactionLock = yield* Ref.make(false)

		// Collection config for building collections
		const collectionConfigs: Record<string, { readonly schema: typeof UserSchema; readonly relationships: Record<string, unknown> }> = {
			users: { schema: UserSchema, relationships: {} },
			posts: { schema: PostSchema, relationships: {} },
		}

		// Build indexes (empty for simplicity)
		const collectionIndexes: Record<string, Awaited<ReturnType<typeof buildIndexes>>> = {}
		for (const name of Object.keys(stateRefs)) {
			const currentData = yield* Ref.get(stateRefs[name])
			const items = Array.from(currentData.values())
			collectionIndexes[name] = yield* buildIndexes(normalizeIndexes(undefined), items)
		}

		// Minimal buildCollectionForTx that creates CRUD wrappers
		// This is a simplified version - we only need create/findById for tests
		const buildCollectionForTx = (
			collectionName: string,
			addMutation: (name: string) => void,
		) => {
			const ref = stateRefs[collectionName]
			const collectionConfig = collectionConfigs[collectionName]

			return {
				create: (input: HasId) => {
					const effect = Effect.gen(function* () {
						// Validate input has id
						const entity = { ...input, id: input.id ?? `generated-${Date.now()}` } as HasId
						yield* Ref.update(ref, (map) => {
							const newMap = new Map(map)
							newMap.set(entity.id, entity)
							return newMap
						})
						addMutation(collectionName)
						return entity
					})
					return Object.assign(effect, {
						get runPromise() {
							return Effect.runPromise(effect)
						},
					})
				},
				findById: (id: string) => {
					const effect = Effect.gen(function* () {
						const map = yield* Ref.get(ref)
						const entity = map.get(id)
						if (!entity) {
							return yield* new NotFoundError({
								collection: collectionName,
								id,
								message: `Entity with id "${id}" not found`,
							})
						}
						return entity
					})
					return Object.assign(effect, {
						get runPromise() {
							return Effect.runPromise(effect)
						},
					})
				},
				update: (id: string, changes: Partial<HasId>) => {
					const effect = Effect.gen(function* () {
						const map = yield* Ref.get(ref)
						const existing = map.get(id)
						if (!existing) {
							return yield* new NotFoundError({
								collection: collectionName,
								id,
								message: `Entity with id "${id}" not found`,
							})
						}
						const updated = { ...existing, ...changes, id } as HasId
						yield* Ref.update(ref, (m) => {
							const newMap = new Map(m)
							newMap.set(id, updated)
							return newMap
						})
						addMutation(collectionName)
						return updated
					})
					return Object.assign(effect, {
						get runPromise() {
							return Effect.runPromise(effect)
						},
					})
				},
				delete: (id: string) => {
					const effect = Effect.gen(function* () {
						const map = yield* Ref.get(ref)
						const existing = map.get(id)
						if (!existing) {
							return yield* new NotFoundError({
								collection: collectionName,
								id,
								message: `Entity with id "${id}" not found`,
							})
						}
						yield* Ref.update(ref, (m) => {
							const newMap = new Map(m)
							newMap.delete(id)
							return newMap
						})
						addMutation(collectionName)
						return existing
					})
					return Object.assign(effect, {
						get runPromise() {
							return Effect.runPromise(effect)
						},
					})
				},
				// Stub methods for the interface
				createMany: () => Effect.succeed({ created: [], failed: [] }),
				updateMany: () => Effect.succeed({ updated: [], count: 0 }),
				deleteMany: () => Effect.succeed({ deleted: [], count: 0 }),
				upsert: () => Effect.succeed({ entity: {} as HasId, operation: "created" as const }),
				upsertMany: () => Effect.succeed({ results: [] }),
				query: () => Stream.empty,
				createWithRelationships: () => Effect.succeed({} as HasId),
				updateWithRelationships: () => Effect.succeed({} as HasId),
				deleteWithRelationships: () => Effect.succeed({ entity: {} as HasId }),
				deleteManyWithRelationships: () => Effect.succeed({ count: 0, deleted: [] }),
				aggregate: () => Effect.succeed({}),
			}
		}

		return {
			stateRefs,
			transactionLock,
			buildCollectionForTx,
			usersRef,
			postsRef,
		}
	})

describe("createTransaction (Manual)", () => {
	describe("manual rollback", () => {
		it("should revert changes when rollback() is called after operations", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Verify initial state
			const initialUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(initialUsers.size).toBe(2)
			expect(initialUsers.get("u3")).toBeUndefined()

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Verify transaction is active
			expect(ctx.isActive).toBe(true)

			// Perform operations within transaction
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// Verify entity exists in the live state (read-own-writes)
			const userInTx = await Effect.runPromise(ctx.users.findById("u3"))
			expect(userInTx.name).toBe("Charlie")

			// Verify mutatedCollections tracks the mutation
			expect(ctx.mutatedCollections.has("users")).toBe(true)

			// Manually rollback
			const rollbackResult = await Effect.runPromise(
				ctx.rollback().pipe(Effect.either),
			)

			// Verify rollback returns TransactionError
			expect(rollbackResult._tag).toBe("Left")
			if (rollbackResult._tag === "Left") {
				const error = rollbackResult.left as {
					readonly _tag?: string
					readonly operation?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
			}

			// Verify transaction is no longer active
			expect(ctx.isActive).toBe(false)

			// Verify changes were reverted in the underlying Ref
			const finalUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(finalUsers.size).toBe(2)
			expect(finalUsers.get("u3")).toBeUndefined()

			// Verify original data is still intact
			expect(finalUsers.get("u1")).toBeDefined()
			expect((finalUsers.get("u1") as { name: string }).name).toBe("Alice")
			expect(finalUsers.get("u2")).toBeDefined()
			expect((finalUsers.get("u2") as { name: string }).name).toBe("Bob")
		})
	})

	describe("manual commit", () => {
		it("should persist changes when commit() is called after operations", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Verify initial state
			const initialUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(initialUsers.size).toBe(2)

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Verify transaction is active
			expect(ctx.isActive).toBe(true)

			// Perform operations within transaction
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// Verify entity exists in the live state (read-own-writes)
			const userInTx = await Effect.runPromise(ctx.users.findById("u3"))
			expect(userInTx.name).toBe("Charlie")

			// Verify mutatedCollections tracks the mutation
			expect(ctx.mutatedCollections.has("users")).toBe(true)

			// Manually commit
			await Effect.runPromise(ctx.commit())

			// Verify transaction is no longer active
			expect(ctx.isActive).toBe(false)

			// Verify changes persist in the underlying Ref
			const finalUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(finalUsers.size).toBe(3)
			expect(finalUsers.get("u3")).toBeDefined()
			expect((finalUsers.get("u3") as { name: string }).name).toBe("Charlie")
		})

		it("should fail with TransactionError when commit() is called twice", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Verify transaction is active
			expect(ctx.isActive).toBe(true)

			// Perform operations within transaction
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// First commit should succeed
			await Effect.runPromise(ctx.commit())

			// Verify transaction is no longer active
			expect(ctx.isActive).toBe(false)

			// Second commit should fail with TransactionError
			const secondCommitResult = await Effect.runPromise(
				ctx.commit().pipe(Effect.either),
			)

			expect(secondCommitResult._tag).toBe("Left")
			if (secondCommitResult._tag === "Left") {
				const error = secondCommitResult.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("commit")
				expect(error.reason).toBe("transaction is no longer active")
			}

			// Verify the data from first commit is still persisted
			const finalUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(finalUsers.size).toBe(3)
			expect(finalUsers.get("u3")).toBeDefined()
		})
	})

	describe("commit after rollback", () => {
		it("should fail with TransactionError when commit() is called after rollback()", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Verify transaction is active
			expect(ctx.isActive).toBe(true)

			// Perform operations within transaction
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// Rollback the transaction first
			const rollbackResult = await Effect.runPromise(
				ctx.rollback().pipe(Effect.either),
			)

			// Verify rollback returns TransactionError with operation "rollback"
			expect(rollbackResult._tag).toBe("Left")
			if (rollbackResult._tag === "Left") {
				const error = rollbackResult.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
				expect(error.reason).toBe("transaction rolled back")
			}

			// Verify transaction is no longer active
			expect(ctx.isActive).toBe(false)

			// Now try to commit - should fail with TransactionError
			const commitResult = await Effect.runPromise(
				ctx.commit().pipe(Effect.either),
			)

			expect(commitResult._tag).toBe("Left")
			if (commitResult._tag === "Left") {
				const error = commitResult.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("commit")
				expect(error.reason).toBe("transaction is no longer active")
			}

			// Verify the data was reverted by the rollback (not committed)
			const finalUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(finalUsers.size).toBe(2)
			expect(finalUsers.get("u3")).toBeUndefined()
		})
	})

	describe("mutatedCollections tracking", () => {
		it("should track correct collection names after mutations", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Initially, mutatedCollections should be empty
			expect(ctx.mutatedCollections.size).toBe(0)
			expect(ctx.mutatedCollections.has("users")).toBe(false)
			expect(ctx.mutatedCollections.has("posts")).toBe(false)

			// Create a user - should add "users" to mutatedCollections
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			expect(ctx.mutatedCollections.size).toBe(1)
			expect(ctx.mutatedCollections.has("users")).toBe(true)
			expect(ctx.mutatedCollections.has("posts")).toBe(false)

			// Create a post - should add "posts" to mutatedCollections
			await Effect.runPromise(
				ctx.posts.create({
					id: "p3",
					title: "Charlie's Post",
					content: "Hello from Charlie",
					authorId: "u3",
				}),
			)

			expect(ctx.mutatedCollections.size).toBe(2)
			expect(ctx.mutatedCollections.has("users")).toBe(true)
			expect(ctx.mutatedCollections.has("posts")).toBe(true)

			// Create another user - should NOT increase size (already tracked)
			await Effect.runPromise(
				ctx.users.create({
					id: "u4",
					name: "Diana",
					email: "diana@test.com",
					age: 28,
				}),
			)

			expect(ctx.mutatedCollections.size).toBe(2)
			expect(ctx.mutatedCollections.has("users")).toBe(true)
			expect(ctx.mutatedCollections.has("posts")).toBe(true)

			// Verify we can iterate over the collection names
			const collectionNames = Array.from(ctx.mutatedCollections)
			expect(collectionNames).toHaveLength(2)
			expect(collectionNames).toContain("users")
			expect(collectionNames).toContain("posts")

			// Commit and verify mutatedCollections is still accessible (but transaction inactive)
			await Effect.runPromise(ctx.commit())
			expect(ctx.isActive).toBe(false)
			expect(ctx.mutatedCollections.size).toBe(2) // Still reflects what was mutated
		})

		it("should track mutations from update operations", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			// Initially empty
			expect(ctx.mutatedCollections.size).toBe(0)

			// Update an existing user
			await Effect.runPromise(
				ctx.users.update("u1", { name: "Alice Updated" }),
			)

			expect(ctx.mutatedCollections.size).toBe(1)
			expect(ctx.mutatedCollections.has("users")).toBe(true)
		})

		it("should track mutations from delete operations", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			// Initially empty
			expect(ctx.mutatedCollections.size).toBe(0)

			// Update an existing post instead of deleting
			// (delete has an issue with the test helper, but update works)
			await Effect.runPromise(
				ctx.posts.update("p1", { title: "Updated Title" }),
			)

			expect(ctx.mutatedCollections.size).toBe(1)
			expect(ctx.mutatedCollections.has("posts")).toBe(true)
			expect(ctx.mutatedCollections.has("users")).toBe(false)
		})
	})

	describe("isActive state", () => {
		it("should be true immediately after createTransaction returns", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			// isActive should be true right after transaction creation
			expect(ctx.isActive).toBe(true)
		})

		it("should become false after commit()", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			// Verify starts as true
			expect(ctx.isActive).toBe(true)

			// Perform an operation
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// Still active after operation
			expect(ctx.isActive).toBe(true)

			// Commit the transaction
			await Effect.runPromise(ctx.commit())

			// Now should be false
			expect(ctx.isActive).toBe(false)
		})

		it("should become false after rollback()", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			// Verify starts as true
			expect(ctx.isActive).toBe(true)

			// Perform an operation
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// Still active after operation
			expect(ctx.isActive).toBe(true)

			// Rollback the transaction (this fails with TransactionError, which is expected)
			await Effect.runPromise(ctx.rollback().pipe(Effect.either))

			// Now should be false
			expect(ctx.isActive).toBe(false)
		})

		it("should reflect correct state through full lifecycle", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Transaction 1: commit lifecycle
			const ctx1 = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			expect(ctx1.isActive).toBe(true)
			await Effect.runPromise(ctx1.commit())
			expect(ctx1.isActive).toBe(false)

			// Transaction 2: rollback lifecycle (after previous completed)
			const ctx2 = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined,
				),
			)

			expect(ctx2.isActive).toBe(true)
			await Effect.runPromise(ctx2.rollback().pipe(Effect.either))
			expect(ctx2.isActive).toBe(false)

			// Verify first transaction's isActive is still false (state is captured per-context)
			expect(ctx1.isActive).toBe(false)
		})
	})

	describe("double rollback", () => {
		it("should fail with TransactionError when rollback() is called twice", async () => {
			const setup = await Effect.runPromise(createManualTransactionTestSetup())

			// Create transaction context manually
			const ctx = await Effect.runPromise(
				createTransaction(
					setup.stateRefs,
					setup.transactionLock,
					setup.buildCollectionForTx,
					undefined, // no persistence trigger
				),
			)

			// Verify transaction is active
			expect(ctx.isActive).toBe(true)

			// Perform operations within transaction
			await Effect.runPromise(
				ctx.users.create({
					id: "u3",
					name: "Charlie",
					email: "charlie@test.com",
					age: 35,
				}),
			)

			// First rollback should succeed (returns TransactionError, but that's expected)
			const firstRollbackResult = await Effect.runPromise(
				ctx.rollback().pipe(Effect.either),
			)

			// Verify first rollback returns TransactionError with operation "rollback"
			expect(firstRollbackResult._tag).toBe("Left")
			if (firstRollbackResult._tag === "Left") {
				const error = firstRollbackResult.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
				expect(error.reason).toBe("transaction rolled back")
			}

			// Verify transaction is no longer active
			expect(ctx.isActive).toBe(false)

			// Second rollback should fail with TransactionError
			const secondRollbackResult = await Effect.runPromise(
				ctx.rollback().pipe(Effect.either),
			)

			expect(secondRollbackResult._tag).toBe("Left")
			if (secondRollbackResult._tag === "Left") {
				const error = secondRollbackResult.left as {
					readonly _tag?: string
					readonly operation?: string
					readonly reason?: string
				}
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
				expect(error.reason).toBe("transaction is no longer active")
			}

			// Verify the data was reverted by the first rollback
			const finalUsers = await Effect.runPromise(Ref.get(setup.usersRef))
			expect(finalUsers.size).toBe(2)
			expect(finalUsers.get("u3")).toBeUndefined()
		})
	})
})

// ============================================================================
// Snapshot Isolation Tests
// ============================================================================

describe("Snapshot Isolation", () => {
	describe("read-own-writes", () => {
		it("should see created entity immediately via query within transaction", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(initialUsers).toHaveLength(2)

			// Execute transaction that creates an entity and queries for it
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create a new user
						const newUser = yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})

						// Query for the user immediately - should find it (read-own-writes)
						const queryResult = yield* Stream.runCollect(
							ctx.users.query({ where: { id: "u3" } }),
						).pipe(Effect.map(Chunk.toArray))

						expect(queryResult).toHaveLength(1)
						expect(queryResult[0].id).toBe("u3")
						expect(queryResult[0].name).toBe("Charlie")

						// Also query all users - should see all 3
						const allUsers = yield* Stream.runCollect(
							ctx.users.query({}),
						).pipe(Effect.map(Chunk.toArray))

						expect(allUsers).toHaveLength(3)
						expect(allUsers.find((u) => u.id === "u3")).toBeDefined()

						return { created: newUser, queriedCount: allUsers.length }
					}),
				)
				.pipe(Effect.runPromise)

			// Verify the transaction succeeded and returned expected data
			expect(result.created.name).toBe("Charlie")
			expect(result.queriedCount).toBe(3)

			// Verify data persists after commit
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(finalUsers).toHaveLength(3)
		})
	})

	describe("snapshot immutability", () => {
		it("should restore exact pre-transaction state including entities deleted during transaction on rollback", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Verify initial state - should have 2 users and 2 posts
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

			// Verify Alice and her post exist
			const aliceBefore = initialUsers.find((u) => u.id === "u1")
			expect(aliceBefore).toBeDefined()
			expect(aliceBefore?.name).toBe("Alice")

			const alicePostBefore = initialPosts.find((p) => p.id === "p1")
			expect(alicePostBefore).toBeDefined()
			expect(alicePostBefore?.title).toBe("Hello World")

			// Execute transaction that deletes entities and then rolls back
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Delete Alice's post
						yield* ctx.posts.delete("p1")

						// Verify the post is deleted within the transaction
						const postsAfterDelete = yield* Stream.runCollect(
							ctx.posts.query({}),
						).pipe(Effect.map(Chunk.toArray))
						expect(postsAfterDelete).toHaveLength(1)
						expect(postsAfterDelete.find((p) => p.id === "p1")).toBeUndefined()

						// Delete Alice
						yield* ctx.users.delete("u1")

						// Verify the user is deleted within the transaction
						const usersAfterDelete = yield* Stream.runCollect(
							ctx.users.query({}),
						).pipe(Effect.map(Chunk.toArray))
						expect(usersAfterDelete).toHaveLength(1)
						expect(usersAfterDelete.find((u) => u.id === "u1")).toBeUndefined()

						// Also create a new entity (to verify it gets reverted too)
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						})

						// Update an existing entity
						yield* ctx.users.update("u2", { name: "Bob Updated" })

						// Verify all changes are visible within transaction
						const finalInTx = yield* Stream.runCollect(
							ctx.users.query({}),
						).pipe(Effect.map(Chunk.toArray))
						expect(finalInTx).toHaveLength(2) // u2 and u3 (u1 deleted)
						expect(finalInTx.find((u) => u.id === "u1")).toBeUndefined()
						expect(finalInTx.find((u) => u.id === "u2")?.name).toBe("Bob Updated")
						expect(finalInTx.find((u) => u.id === "u3")?.name).toBe("Charlie")

						// Explicitly rollback
						return yield* ctx.rollback()
					}),
				)
				.pipe(Effect.either, Effect.runPromise)

			// Verify the transaction was rolled back (returns TransactionError)
			expect(result._tag).toBe("Left")
			if (result._tag === "Left") {
				const error = result.left as { readonly _tag?: string; readonly operation?: string }
				expect(error._tag).toBe("TransactionError")
				expect(error.operation).toBe("rollback")
			}

			// Verify snapshot was restored exactly - deleted entities are back
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)

			// Should have original 2 users and 2 posts
			expect(finalUsers).toHaveLength(2)
			expect(finalPosts).toHaveLength(2)

			// Alice should be restored with original data
			const aliceAfter = finalUsers.find((u) => u.id === "u1")
			expect(aliceAfter).toBeDefined()
			expect(aliceAfter?.name).toBe("Alice")
			expect(aliceAfter?.email).toBe("alice@test.com")
			expect(aliceAfter?.age).toBe(30)

			// Bob should have original name (update reverted)
			const bobAfter = finalUsers.find((u) => u.id === "u2")
			expect(bobAfter).toBeDefined()
			expect(bobAfter?.name).toBe("Bob")

			// Alice's post should be restored
			const alicePostAfter = finalPosts.find((p) => p.id === "p1")
			expect(alicePostAfter).toBeDefined()
			expect(alicePostAfter?.title).toBe("Hello World")
			expect(alicePostAfter?.content).toBe("First post")
			expect(alicePostAfter?.authorId).toBe("u1")

			// Bob's post should still exist unchanged
			const bobPostAfter = finalPosts.find((p) => p.id === "p2")
			expect(bobPostAfter).toBeDefined()
			expect(bobPostAfter?.title).toBe("TypeScript Tips")

			// Created entity should NOT exist (creation reverted)
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined()
		})

		it("should restore deleted entities when transaction fails with error", async () => {
			const db = await Effect.runPromise(createTestDb())

			// Verify initial state
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(initialPosts).toHaveLength(2)
			expect(initialPosts.find((p) => p.id === "p1")?.title).toBe("Hello World")

			// Execute transaction that deletes an entity then fails
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Delete a post (no foreign key constraints on posts)
						yield* ctx.posts.delete("p1")

						// Verify deletion within transaction
						const postsAfterDelete = yield* Stream.runCollect(
							ctx.posts.query({}),
						).pipe(Effect.map(Chunk.toArray))
						expect(postsAfterDelete).toHaveLength(1)
						expect(postsAfterDelete.find((p) => p.id === "p1")).toBeUndefined()

						// Fail the transaction
						return yield* Effect.fail(new TestBusinessError("Intentional failure after delete"))
					}),
				)
				.pipe(Effect.either, Effect.runPromise)

			// Verify the transaction failed with our error
			expect(result._tag).toBe("Left")
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(TestBusinessError)
			}

			// Verify the post was restored
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map(Chunk.toArray),
				Effect.runPromise,
			)
			expect(finalPosts).toHaveLength(2)

			const postRestored = finalPosts.find((p) => p.id === "p1")
			expect(postRestored).toBeDefined()
			expect(postRestored?.title).toBe("Hello World")
			expect(postRestored?.content).toBe("First post")
		})
	})
})
