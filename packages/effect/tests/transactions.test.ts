import { Effect, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../core/src/errors/crud-errors.js";
import { createEffectDatabase, type EffectCollection } from "@proseql/effect";

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
});

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

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
} as const;

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
		{
			id: "p2",
			title: "TypeScript Tips",
			content: "Type safety",
			authorId: "u2",
		},
	],
};

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a fresh test database with initial data.
 * Returns the database ready for transaction testing.
 */
const createTestDb = () => createEffectDatabase(config, initialData);

// ============================================================================
// Transaction Callback Tests
// ============================================================================

// ============================================================================
// Custom Test Errors
// ============================================================================

class TestBusinessError extends Error {
	readonly _tag = "TestBusinessError";
	constructor(message: string) {
		super(message);
		this.name = "TestBusinessError";
	}
}

describe("$transaction", () => {
	describe("successful transactions", () => {
		it("should have $transaction method on the database", async () => {
			const db = await Effect.runPromise(createTestDb());
			expect(typeof db.$transaction).toBe("function");
		});

		it("should create user and post in transaction, both visible after commit", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialUsers).toHaveLength(2);
			expect(initialPosts).toHaveLength(2);

			// Execute transaction that creates a new user and a post referencing them
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						const newUser = yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						});
						const newPost = yield* ctx.posts.create({
							id: "p3",
							title: "Charlie's First Post",
							content: "Hello from Charlie",
							authorId: newUser.id,
						});
						return { user: newUser, post: newPost };
					}),
				)
				.pipe(Effect.runPromise);

			// Verify return value from transaction
			expect(result.user.id).toBe("u3");
			expect(result.user.name).toBe("Charlie");
			expect(result.post.id).toBe("p3");
			expect(result.post.authorId).toBe("u3");

			// Verify both entities are visible in the database after commit
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);

			expect(finalUsers).toHaveLength(3);
			expect(finalPosts).toHaveLength(3);

			// Verify the new entities exist with correct data
			const charlie = finalUsers.find((u) => u.id === "u3");
			expect(charlie).toBeDefined();
			expect(charlie?.name).toBe("Charlie");
			expect(charlie?.email).toBe("charlie@test.com");

			const charliePost = finalPosts.find((p) => p.id === "p3");
			expect(charliePost).toBeDefined();
			expect(charliePost?.title).toBe("Charlie's First Post");
			expect(charliePost?.authorId).toBe("u3");
		});
	});

	describe("explicit rollback", () => {
		it("should revert all changes when ctx.rollback() is called mid-transaction", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialUsers).toHaveLength(2);
			expect(initialPosts).toHaveLength(2);

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
						});
						yield* ctx.posts.create({
							id: "p3",
							title: "Charlie's Post",
							content: "This will be rolled back",
							authorId: newUser.id,
						});

						// Verify entities exist within the transaction (read-own-writes)
						const userInTx = yield* ctx.users.findById("u3");
						expect(userInTx.name).toBe("Charlie");

						const postInTx = yield* ctx.posts.findById("p3");
						expect(postInTx.title).toBe("Charlie's Post");

						// Explicitly rollback mid-transaction
						return yield* ctx.rollback();
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify the transaction resulted in a TransactionError from rollback
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				// The error should be a TransactionError with operation "rollback"
				const error = result.failure as {
					readonly _tag?: string;
					readonly operation?: string;
				};
				expect(error._tag).toBe("TransactionError");
				expect(error.operation).toBe("rollback");
			}

			// Verify all changes were reverted
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);

			expect(finalUsers).toHaveLength(2);
			expect(finalPosts).toHaveLength(2);
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined();
			expect(finalPosts.find((p) => p.id === "p3")).toBeUndefined();

			// Verify original data is still intact
			expect(finalUsers.find((u) => u.id === "u1")?.name).toBe("Alice");
			expect(finalUsers.find((u) => u.id === "u2")?.name).toBe("Bob");
			expect(finalPosts.find((p) => p.id === "p1")?.title).toBe("Hello World");
			expect(finalPosts.find((p) => p.id === "p2")?.title).toBe(
				"TypeScript Tips",
			);
		});
	});

	describe("failed transactions", () => {
		it("should revert user creation when transaction fails with Effect.fail", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialUsers).toHaveLength(2);
			expect(initialUsers.find((u) => u.id === "u3")).toBeUndefined();

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
						});

						// Verify the user exists within the transaction (read-own-writes)
						const userInTx = yield* ctx.users.findById("u3");
						expect(userInTx.name).toBe("Charlie");

						// Now fail the transaction with a business error
						return yield* Effect.fail(
							new TestBusinessError("Simulated failure after user creation"),
						);
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify the transaction failed with our error
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(TestBusinessError);
				expect((result.failure as TestBusinessError).message).toBe(
					"Simulated failure after user creation",
				);
			}

			// Verify the user creation was reverted
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(finalUsers).toHaveLength(2);
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined();

			// Verify original users are still intact
			expect(finalUsers.find((u) => u.id === "u1")?.name).toBe("Alice");
			expect(finalUsers.find((u) => u.id === "u2")?.name).toBe("Bob");
		});

		it("should preserve original CRUD error type accessible via catchTag after rollback", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Execute transaction that triggers a CRUD error (NotFoundError)
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Try to find a non-existent user - this will fail with NotFoundError
						const user = yield* ctx.users.findById("non-existent-id");
						return user;
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
				);

			// Verify the NotFoundError was caught and its properties are accessible
			expect(result).toEqual({
				caught: true,
				errorTag: "NotFoundError",
				collection: "users",
				id: "non-existent-id",
			});

			// Verify database state is unchanged (rollback happened)
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(users).toHaveLength(2);
		});

		it("should preserve custom business error type accessible via catchTag after rollback", async () => {
			const db = await Effect.runPromise(createTestDb());

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
						});

						// Fail with our custom error
						return yield* Effect.fail(
							new TestBusinessError("Custom failure message"),
						);
					}),
				)
				.pipe(
					// Catch by checking the _tag property (since TestBusinessError uses _tag)
					Effect.catchIf(
						(error): error is TestBusinessError =>
							error instanceof TestBusinessError &&
							error._tag === "TestBusinessError",
						(error) =>
							Effect.succeed({
								caught: true,
								errorTag: error._tag,
								message: error.message,
							}),
					),
					Effect.runPromise,
				);

			// Verify the custom error was caught with full properties
			expect(result).toEqual({
				caught: true,
				errorTag: "TestBusinessError",
				message: "Custom failure message",
			});

			// Verify user creation was rolled back
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(users).toHaveLength(2);
			expect(users.find((u) => u.id === "u3")).toBeUndefined();
		});
	});

	describe("nested transactions", () => {
		it("should reject nested $transaction with TransactionError", async () => {
			const db = await Effect.runPromise(createTestDb());

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
						});

						// Attempt to start a nested transaction - this should fail
						const nestedResult = yield* db.$transaction((innerCtx) =>
							Effect.gen(function* () {
								yield* innerCtx.users.create({
									id: "u4",
									name: "Diana",
									email: "diana@test.com",
									age: 28,
								});
								return "nested completed";
							}),
						);

						return nestedResult;
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify the transaction failed with TransactionError
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				const error = result.failure as {
					readonly _tag?: string;
					readonly operation?: string;
					readonly reason?: string;
				};
				expect(error._tag).toBe("TransactionError");
				expect(error.operation).toBe("begin");
				expect(error.reason).toBe("nested transactions not supported");
			}

			// Verify both user creations were rolled back (the outer transaction's user too)
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(users).toHaveLength(2);
			expect(users.find((u) => u.id === "u3")).toBeUndefined();
			expect(users.find((u) => u.id === "u4")).toBeUndefined();
		});

		it("should allow new transaction after previous completes", async () => {
			const db = await Effect.runPromise(createTestDb());

			// First transaction - creates a user
			await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						});
						return "first completed";
					}),
				)
				.pipe(Effect.runPromise);

			// Second transaction - should work since first one completed
			await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						yield* ctx.users.create({
							id: "u4",
							name: "Diana",
							email: "diana@test.com",
							age: 28,
						});
						return "second completed";
					}),
				)
				.pipe(Effect.runPromise);

			// Verify both users were created
			const users = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(users).toHaveLength(4);
			expect(users.find((u) => u.id === "u3")?.name).toBe("Charlie");
			expect(users.find((u) => u.id === "u4")?.name).toBe("Diana");
		});
	});
});

// ============================================================================
// createTransaction (Manual) Tests
// ============================================================================

/**
 * Helper to create minimal infrastructure for testing createTransaction directly.
 * This mirrors the internal setup of createEffectDatabase but exposes the components
 * needed to call createTransaction.
 */
describe("createTransaction (Manual)", () => {
	describe("manual rollback", () => {});

	describe("manual commit", () => {});

	describe("commit after rollback", () => {});

	describe("mutatedCollections tracking", () => {});

	describe("isActive state", () => {});

	describe("double rollback", () => {});
});

// ============================================================================
// Snapshot Isolation Tests
// ============================================================================

describe("Snapshot Isolation", () => {
	describe("read-own-writes", () => {
		it("should see created entity immediately via query within transaction", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialUsers).toHaveLength(2);

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
						});

						// Query for the user immediately - should find it (read-own-writes)
						const queryResult = yield* Stream.runCollect(
							ctx.users.query({ where: { id: "u3" } }),
						).pipe(Effect.map((items) => items));

						expect(queryResult).toHaveLength(1);
						expect(queryResult[0].id).toBe("u3");
						expect(queryResult[0].name).toBe("Charlie");

						// Also query all users - should see all 3
						const allUsers = yield* Stream.runCollect(ctx.users.query({})).pipe(
							Effect.map((items) => items),
						);

						expect(allUsers).toHaveLength(3);
						expect(allUsers.find((u) => u.id === "u3")).toBeDefined();

						return { created: newUser, queriedCount: allUsers.length };
					}),
				)
				.pipe(Effect.runPromise);

			// Verify the transaction succeeded and returned expected data
			expect(result.created.name).toBe("Charlie");
			expect(result.queriedCount).toBe(3);

			// Verify data persists after commit
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(finalUsers).toHaveLength(3);
		});
	});

	describe("snapshot immutability", () => {
		it("should restore exact pre-transaction state including entities deleted during transaction on rollback", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state - should have 2 users and 2 posts
			const initialUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialUsers).toHaveLength(2);
			expect(initialPosts).toHaveLength(2);

			// Verify Alice and her post exist
			const aliceBefore = initialUsers.find((u) => u.id === "u1");
			expect(aliceBefore).toBeDefined();
			expect(aliceBefore?.name).toBe("Alice");

			const alicePostBefore = initialPosts.find((p) => p.id === "p1");
			expect(alicePostBefore).toBeDefined();
			expect(alicePostBefore?.title).toBe("Hello World");

			// Execute transaction that deletes entities and then rolls back
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Delete Alice's post
						yield* ctx.posts.delete("p1");

						// Verify the post is deleted within the transaction
						const postsAfterDelete = yield* Stream.runCollect(
							ctx.posts.query({}),
						).pipe(Effect.map((items) => items));
						expect(postsAfterDelete).toHaveLength(1);
						expect(postsAfterDelete.find((p) => p.id === "p1")).toBeUndefined();

						// Delete Alice
						yield* ctx.users.delete("u1");

						// Verify the user is deleted within the transaction
						const usersAfterDelete = yield* Stream.runCollect(
							ctx.users.query({}),
						).pipe(Effect.map((items) => items));
						expect(usersAfterDelete).toHaveLength(1);
						expect(usersAfterDelete.find((u) => u.id === "u1")).toBeUndefined();

						// Also create a new entity (to verify it gets reverted too)
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						});

						// Update an existing entity
						yield* ctx.users.update("u2", { name: "Bob Updated" });

						// Verify all changes are visible within transaction
						const finalInTx = yield* Stream.runCollect(
							ctx.users.query({}),
						).pipe(Effect.map((items) => items));
						expect(finalInTx).toHaveLength(2); // u2 and u3 (u1 deleted)
						expect(finalInTx.find((u) => u.id === "u1")).toBeUndefined();
						expect(finalInTx.find((u) => u.id === "u2")?.name).toBe(
							"Bob Updated",
						);
						expect(finalInTx.find((u) => u.id === "u3")?.name).toBe("Charlie");

						// Explicitly rollback
						return yield* ctx.rollback();
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify the transaction was rolled back (returns TransactionError)
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				const error = result.failure as {
					readonly _tag?: string;
					readonly operation?: string;
				};
				expect(error._tag).toBe("TransactionError");
				expect(error.operation).toBe("rollback");
			}

			// Verify snapshot was restored exactly - deleted entities are back
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);

			// Should have original 2 users and 2 posts
			expect(finalUsers).toHaveLength(2);
			expect(finalPosts).toHaveLength(2);

			// Alice should be restored with original data
			const aliceAfter = finalUsers.find((u) => u.id === "u1");
			expect(aliceAfter).toBeDefined();
			expect(aliceAfter?.name).toBe("Alice");
			expect(aliceAfter?.email).toBe("alice@test.com");
			expect(aliceAfter?.age).toBe(30);

			// Bob should have original name (update reverted)
			const bobAfter = finalUsers.find((u) => u.id === "u2");
			expect(bobAfter).toBeDefined();
			expect(bobAfter?.name).toBe("Bob");

			// Alice's post should be restored
			const alicePostAfter = finalPosts.find((p) => p.id === "p1");
			expect(alicePostAfter).toBeDefined();
			expect(alicePostAfter?.title).toBe("Hello World");
			expect(alicePostAfter?.content).toBe("First post");
			expect(alicePostAfter?.authorId).toBe("u1");

			// Bob's post should still exist unchanged
			const bobPostAfter = finalPosts.find((p) => p.id === "p2");
			expect(bobPostAfter).toBeDefined();
			expect(bobPostAfter?.title).toBe("TypeScript Tips");

			// Created entity should NOT exist (creation reverted)
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined();
		});

		it("should restore deleted entities when transaction fails with error", async () => {
			const db = await Effect.runPromise(createTestDb());

			// Verify initial state
			const initialPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(initialPosts).toHaveLength(2);
			expect(initialPosts.find((p) => p.id === "p1")?.title).toBe(
				"Hello World",
			);

			// Execute transaction that deletes an entity then fails
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Delete a post (no foreign key constraints on posts)
						yield* ctx.posts.delete("p1");

						// Verify deletion within transaction
						const postsAfterDelete = yield* Stream.runCollect(
							ctx.posts.query({}),
						).pipe(Effect.map((items) => items));
						expect(postsAfterDelete).toHaveLength(1);
						expect(postsAfterDelete.find((p) => p.id === "p1")).toBeUndefined();

						// Fail the transaction
						return yield* Effect.fail(
							new TestBusinessError("Intentional failure after delete"),
						);
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify the transaction failed with our error
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(TestBusinessError);
			}

			// Verify the post was restored
			const finalPosts = await Stream.runCollect(db.posts.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(finalPosts).toHaveLength(2);

			const postRestored = finalPosts.find((p) => p.id === "p1");
			expect(postRestored).toBeDefined();
			expect(postRestored?.title).toBe("Hello World");
			expect(postRestored?.content).toBe("First post");
		});
	});

	describe("lock release on commit", () => {});

	describe("lock release on error", () => {
		it("should allow new transaction to begin after $transaction fails with error", async () => {
			const db = await Effect.runPromise(createTestDb());

			// First transaction fails with an error - automatic rollback should release lock
			const result = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						// Create a user (will be rolled back)
						yield* ctx.users.create({
							id: "u3",
							name: "Charlie",
							email: "charlie@test.com",
							age: 35,
						});

						// Fail the transaction
						return yield* Effect.fail(
							new TestBusinessError("Intentional failure"),
						);
					}),
				)
				.pipe(Effect.result, Effect.runPromise);

			// Verify first transaction failed
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(TestBusinessError);
			}

			// Verify the user was rolled back
			const usersAfterFailure = await Stream.runCollect(
				db.users.query({}),
			).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(usersAfterFailure).toHaveLength(2);
			expect(usersAfterFailure.find((u) => u.id === "u3")).toBeUndefined();

			// Now start a new transaction - should succeed since lock was released on error
			const secondResult = await db
				.$transaction((ctx) =>
					Effect.gen(function* () {
						yield* ctx.users.create({
							id: "u4",
							name: "Diana",
							email: "diana@test.com",
							age: 28,
						});
						return "second transaction succeeded";
					}),
				)
				.pipe(Effect.runPromise);

			// Verify second transaction succeeded
			expect(secondResult).toBe("second transaction succeeded");

			// Verify the new user exists
			const finalUsers = await Stream.runCollect(db.users.query({})).pipe(
				Effect.map((items) => items),
				Effect.runPromise,
			);
			expect(finalUsers).toHaveLength(3);
			expect(finalUsers.find((u) => u.id === "u3")).toBeUndefined(); // From failed tx
			expect(finalUsers.find((u) => u.id === "u4")?.name).toBe("Diana");
		});
	});

	describe("concurrent transaction rejection", () => {});

	describe("lock release on rollback", () => {});
});

// ============================================================================
// Persistence Integration Tests
// ============================================================================

/**
 * Helper to create a manual transaction test setup with a spy on the persistence trigger.
 * This allows us to verify when persistence is triggered.
 */
describe("Persistence Integration", () => {
	describe("no persistence during active transaction", () => {});

	describe("batch persistence on commit", () => {});

	describe("no persistence on rollback", () => {});
});
