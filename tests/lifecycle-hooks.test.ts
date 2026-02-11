import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"
import { HookError } from "../core/errors/crud-errors.js"
import type {
	HooksConfig,
	BeforeCreateHook,
	BeforeUpdateHook,
	BeforeDeleteHook,
	AfterCreateHook,
	AfterUpdateHook,
	AfterDeleteHook,
	OnChangeHook,
	BeforeCreateContext,
	BeforeUpdateContext,
	BeforeDeleteContext,
	AfterCreateContext,
	AfterUpdateContext,
	AfterDeleteContext,
	OnChangeContext,
} from "../core/types/hook-types.js"

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

type User = Schema.Schema.Type<typeof UserSchema>

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a database configuration with hooks attached.
 * This is the primary helper for testing lifecycle hooks.
 */
const createHookedConfig = (hooks: HooksConfig<User>) =>
	({
		users: {
			schema: UserSchema,
			hooks,
			relationships: {},
		},
	}) as const

/**
 * Default initial data for tests.
 */
const initialData = {
	users: [
		{ id: "u1", name: "Alice", email: "alice@test.com", age: 30 },
		{ id: "u2", name: "Bob", email: "bob@test.com", age: 25 },
	],
}

/**
 * Creates a database with hooked users collection.
 */
const createHookedDatabase = (hooks: HooksConfig<User>, data = initialData) =>
	createEffectDatabase(createHookedConfig(hooks), data)

/**
 * Helper to create a beforeCreate hook that transforms data.
 */
const makeBeforeCreateHook = (
	transform: (data: User) => User,
): BeforeCreateHook<User> =>
	(ctx) => Effect.succeed(transform(ctx.data))

/**
 * Helper to create a beforeCreate hook that rejects.
 */
const makeRejectingBeforeCreateHook = (
	reason: string,
): BeforeCreateHook<User> =>
	(ctx) =>
		Effect.fail(
			new HookError({
				hook: "beforeCreate",
				collection: ctx.collection,
				operation: "create",
				reason,
				message: `Hook rejected: ${reason}`,
			}),
		)

/**
 * Helper to create a beforeUpdate hook that transforms the update.
 */
const makeBeforeUpdateHook = <T>(
	transform: (update: T) => T,
): BeforeUpdateHook<User> =>
	(ctx) => Effect.succeed(transform(ctx.update) as typeof ctx.update)

/**
 * Helper to create a beforeUpdate hook that rejects.
 */
const makeRejectingBeforeUpdateHook = (
	reason: string,
): BeforeUpdateHook<User> =>
	(ctx) =>
		Effect.fail(
			new HookError({
				hook: "beforeUpdate",
				collection: ctx.collection,
				operation: "update",
				reason,
				message: `Hook rejected: ${reason}`,
			}),
		)

/**
 * Helper to create a beforeDelete hook that rejects.
 */
const makeRejectingBeforeDeleteHook = (
	reason: string,
): BeforeDeleteHook<User> =>
	(ctx) =>
		Effect.fail(
			new HookError({
				hook: "beforeDelete",
				collection: ctx.collection,
				operation: "delete",
				reason,
				message: `Hook rejected: ${reason}`,
			}),
		)

/**
 * Helper to create a beforeDelete hook that passes.
 */
const makePassingBeforeDeleteHook = (): BeforeDeleteHook<User> =>
	() => Effect.void

/**
 * Create a tracking afterCreate hook that records calls.
 */
const makeTrackingAfterCreateHook = (
	calls: Array<AfterCreateContext<User>>,
): AfterCreateHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.void
	}

/**
 * Create a tracking afterUpdate hook that records calls.
 */
const makeTrackingAfterUpdateHook = (
	calls: Array<AfterUpdateContext<User>>,
): AfterUpdateHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.void
	}

/**
 * Create a tracking afterDelete hook that records calls.
 */
const makeTrackingAfterDeleteHook = (
	calls: Array<AfterDeleteContext<User>>,
): AfterDeleteHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.void
	}

/**
 * Create a tracking onChange hook that records calls.
 */
const makeTrackingOnChangeHook = (
	calls: Array<OnChangeContext<User>>,
): OnChangeHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.void
	}

/**
 * Create a tracking beforeCreate hook that records calls.
 */
const makeTrackingBeforeCreateHook = (
	calls: Array<BeforeCreateContext<User>>,
): BeforeCreateHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.succeed(ctx.data)
	}

/**
 * Create a tracking beforeUpdate hook that records calls.
 */
const makeTrackingBeforeUpdateHook = (
	calls: Array<BeforeUpdateContext<User>>,
): BeforeUpdateHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.succeed(ctx.update)
	}

/**
 * Create a tracking beforeDelete hook that records calls.
 */
const makeTrackingBeforeDeleteHook = (
	calls: Array<BeforeDeleteContext<User>>,
): BeforeDeleteHook<User> =>
	(ctx) => {
		calls.push(ctx)
		return Effect.void
	}

// ============================================================================
// Tests - Test Helpers
// ============================================================================

describe("lifecycle-hooks", () => {
	describe("test helpers", () => {
		it("should create a database with hooked collection", async () => {
			const db = await Effect.runPromise(
				createHookedDatabase({}),
			)
			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
			expect(typeof db.users.create).toBe("function")
			expect(typeof db.users.update).toBe("function")
			expect(typeof db.users.delete).toBe("function")
		})

		it("should create a database with empty hooks (no-op)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase({})
					// Create should work normally with no hooks
					const user = yield* db.users.create({
						name: "Charlie",
						email: "charlie@test.com",
						age: 35,
					})
					return user
				}),
			)
			expect(result.name).toBe("Charlie")
			expect(result.id).toBeDefined()
		})

		it("should apply hooks configuration to collection", async () => {
			const calls: Array<AfterCreateContext<User>> = []
			const hooks: HooksConfig<User> = {
				afterCreate: [makeTrackingAfterCreateHook(calls)],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					yield* db.users.create({
						name: "Dave",
						email: "dave@test.com",
						age: 28,
					})
				}),
			)

			expect(calls).toHaveLength(1)
			expect(calls[0].entity.name).toBe("Dave")
		})

		it("should support multiple hooks of the same type", async () => {
			const calls1: Array<AfterCreateContext<User>> = []
			const calls2: Array<AfterCreateContext<User>> = []
			const hooks: HooksConfig<User> = {
				afterCreate: [
					makeTrackingAfterCreateHook(calls1),
					makeTrackingAfterCreateHook(calls2),
				],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					yield* db.users.create({
						name: "Eve",
						email: "eve@test.com",
						age: 22,
					})
				}),
			)

			expect(calls1).toHaveLength(1)
			expect(calls2).toHaveLength(1)
		})

		it("should support all hook types simultaneously", async () => {
			const beforeCreateCalls: Array<BeforeCreateContext<User>> = []
			const afterCreateCalls: Array<AfterCreateContext<User>> = []
			const onChangeCalls: Array<OnChangeContext<User>> = []

			const hooks: HooksConfig<User> = {
				beforeCreate: [makeTrackingBeforeCreateHook(beforeCreateCalls)],
				afterCreate: [makeTrackingAfterCreateHook(afterCreateCalls)],
				onChange: [makeTrackingOnChangeHook(onChangeCalls)],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					yield* db.users.create({
						name: "Frank",
						email: "frank@test.com",
						age: 40,
					})
				}),
			)

			expect(beforeCreateCalls).toHaveLength(1)
			expect(afterCreateCalls).toHaveLength(1)
			expect(onChangeCalls).toHaveLength(1)
			expect(onChangeCalls[0].type).toBe("create")
		})
	})

	describe("before hooks", () => {
		it("beforeCreate transforms data → inserted entity reflects transformation", async () => {
			// Hook that normalizes email to lowercase and adds a createdAt timestamp
			const hooks: HooksConfig<User> = {
				beforeCreate: [
					makeBeforeCreateHook((user) => ({
						...user,
						email: user.email.toLowerCase(),
						createdAt: "2024-01-01T00:00:00Z",
					})),
				],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })
					const created = yield* db.users.create({
						name: "Test User",
						email: "TEST@EXAMPLE.COM",
						age: 30,
					})
					// Also verify by reading back from the collection
					const found = yield* db.users.findById(created.id)
					return { created, found }
				}),
			)

			// The created entity should have transformed data
			expect(result.created.email).toBe("test@example.com")
			expect(result.created.createdAt).toBe("2024-01-01T00:00:00Z")

			// The entity in the collection should also have the transformed data
			expect(result.found.email).toBe("test@example.com")
			expect(result.found.createdAt).toBe("2024-01-01T00:00:00Z")
		})

		it("beforeCreate rejects → create fails with HookError, no state change", async () => {
			const hooks: HooksConfig<User> = {
				beforeCreate: [makeRejectingBeforeCreateHook("User creation not allowed")],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Attempt to create - should fail with HookError
					const createResult = yield* db.users
						.create({
							name: "Rejected User",
							email: "rejected@test.com",
							age: 25,
						})
						.pipe(
							Effect.matchEffect({
								onFailure: (error) => Effect.succeed({ type: "error" as const, error }),
								onSuccess: (user) => Effect.succeed({ type: "success" as const, user }),
							}),
						)

					// Verify no entity was added to the collection
					const allUsersChunk = yield* Stream.runCollect(
						db.users.query({}) as Stream.Stream<User>,
					)
					const allUsers = Chunk.toReadonlyArray(allUsersChunk)

					return { createResult, allUsers }
				}),
			)

			// The create should have failed
			expect(result.createResult.type).toBe("error")
			if (result.createResult.type === "error") {
				expect(result.createResult.error._tag).toBe("HookError")
				const hookError = result.createResult.error as HookError
				expect(hookError.hook).toBe("beforeCreate")
				expect(hookError.operation).toBe("create")
				expect(hookError.reason).toBe("User creation not allowed")
			}

			// No entity should exist in the collection
			expect(result.allUsers).toHaveLength(0)
		})

		it("multiple beforeCreate hooks chain in order", async () => {
			// Track the order hooks are called and what data they receive
			const hookOrder: Array<{ hookIndex: number; receivedName: string }> = []

			// Hook 1: Appends "-hook1" to name
			const hook1: BeforeCreateHook<User> = (ctx) => {
				hookOrder.push({ hookIndex: 1, receivedName: ctx.data.name })
				return Effect.succeed({
					...ctx.data,
					name: `${ctx.data.name}-hook1`,
				})
			}

			// Hook 2: Appends "-hook2" to name (should receive name with "-hook1" already)
			const hook2: BeforeCreateHook<User> = (ctx) => {
				hookOrder.push({ hookIndex: 2, receivedName: ctx.data.name })
				return Effect.succeed({
					...ctx.data,
					name: `${ctx.data.name}-hook2`,
				})
			}

			// Hook 3: Appends "-hook3" to name (should receive name with "-hook1-hook2" already)
			const hook3: BeforeCreateHook<User> = (ctx) => {
				hookOrder.push({ hookIndex: 3, receivedName: ctx.data.name })
				return Effect.succeed({
					...ctx.data,
					name: `${ctx.data.name}-hook3`,
				})
			}

			const hooks: HooksConfig<User> = {
				beforeCreate: [hook1, hook2, hook3],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })
					const created = yield* db.users.create({
						name: "Original",
						email: "test@example.com",
						age: 25,
					})
					// Also verify by reading back from collection
					const found = yield* db.users.findById(created.id)
					return { created, found }
				}),
			)

			// Verify hooks ran in order
			expect(hookOrder).toHaveLength(3)
			expect(hookOrder[0]).toEqual({ hookIndex: 1, receivedName: "Original" })
			expect(hookOrder[1]).toEqual({ hookIndex: 2, receivedName: "Original-hook1" })
			expect(hookOrder[2]).toEqual({ hookIndex: 3, receivedName: "Original-hook1-hook2" })

			// Verify final entity has all transformations applied
			expect(result.created.name).toBe("Original-hook1-hook2-hook3")
			expect(result.found.name).toBe("Original-hook1-hook2-hook3")
		})

		it("beforeUpdate modifies update payload", async () => {
			// Hook that transforms the update: normalizes email to lowercase and adds updatedAt
			const hooks: HooksConfig<User> = {
				beforeUpdate: [
					makeBeforeUpdateHook((update) => ({
						...update,
						email: typeof update.email === "string" ? update.email.toLowerCase() : update.email,
						updatedAt: "2024-01-15T12:00:00Z",
					})),
				],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					// Update u1's email with uppercase - hook should normalize it
					const updated = yield* db.users.update("u1", {
						email: "ALICE_NEW@EXAMPLE.COM",
					})
					// Also verify by reading back from collection
					const found = yield* db.users.findById("u1")
					return { updated, found }
				}),
			)

			// The updated entity should have transformed data
			expect(result.updated.email).toBe("alice_new@example.com")
			expect(result.updated.updatedAt).toBe("2024-01-15T12:00:00Z")
			expect(result.updated.name).toBe("Alice") // Unchanged field preserved

			// The entity in the collection should also have the transformed data
			expect(result.found.email).toBe("alice_new@example.com")
			expect(result.found.updatedAt).toBe("2024-01-15T12:00:00Z")
		})

		it("beforeUpdate rejects → update fails, entity unchanged", async () => {
			const hooks: HooksConfig<User> = {
				beforeUpdate: [makeRejectingBeforeUpdateHook("Update not allowed")],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)

					// Capture original state of u1
					const originalUser = yield* db.users.findById("u1")

					// Attempt to update - should fail with HookError
					const updateResult = yield* db.users
						.update("u1", {
							name: "Alice Updated",
							email: "alice_updated@test.com",
						})
						.pipe(
							Effect.matchEffect({
								onFailure: (error) => Effect.succeed({ type: "error" as const, error }),
								onSuccess: (user) => Effect.succeed({ type: "success" as const, user }),
							}),
						)

					// Verify entity was not changed
					const afterAttempt = yield* db.users.findById("u1")

					return { originalUser, updateResult, afterAttempt }
				}),
			)

			// The update should have failed
			expect(result.updateResult.type).toBe("error")
			if (result.updateResult.type === "error") {
				expect(result.updateResult.error._tag).toBe("HookError")
				const hookError = result.updateResult.error as HookError
				expect(hookError.hook).toBe("beforeUpdate")
				expect(hookError.operation).toBe("update")
				expect(hookError.reason).toBe("Update not allowed")
			}

			// Entity should be unchanged
			expect(result.afterAttempt.name).toBe(result.originalUser.name)
			expect(result.afterAttempt.email).toBe(result.originalUser.email)
			expect(result.afterAttempt.age).toBe(result.originalUser.age)
		})

		it("beforeDelete rejects → delete fails, entity still exists", async () => {
			const hooks: HooksConfig<User> = {
				beforeDelete: [makeRejectingBeforeDeleteHook("Deletion not allowed")],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)

					// Capture original state of u1
					const originalUser = yield* db.users.findById("u1")

					// Attempt to delete - should fail with HookError
					const deleteResult = yield* db.users
						.delete("u1")
						.pipe(
							Effect.matchEffect({
								onFailure: (error) => Effect.succeed({ type: "error" as const, error }),
								onSuccess: (user) => Effect.succeed({ type: "success" as const, user }),
							}),
						)

					// Verify entity still exists
					const afterAttempt = yield* db.users.findById("u1")

					return { originalUser, deleteResult, afterAttempt }
				}),
			)

			// The delete should have failed
			expect(result.deleteResult.type).toBe("error")
			if (result.deleteResult.type === "error") {
				expect(result.deleteResult.error._tag).toBe("HookError")
				const hookError = result.deleteResult.error as HookError
				expect(hookError.hook).toBe("beforeDelete")
				expect(hookError.operation).toBe("delete")
				expect(hookError.reason).toBe("Deletion not allowed")
			}

			// Entity should still exist and be unchanged
			expect(result.afterAttempt.id).toBe(result.originalUser.id)
			expect(result.afterAttempt.name).toBe(result.originalUser.name)
			expect(result.afterAttempt.email).toBe(result.originalUser.email)
			expect(result.afterAttempt.age).toBe(result.originalUser.age)
		})

		it("hook receives correct context (collection, operation, data)", async () => {
			// Track contexts received by each hook type
			const beforeCreateContexts: Array<BeforeCreateContext<User>> = []
			const beforeUpdateContexts: Array<BeforeUpdateContext<User>> = []
			const beforeDeleteContexts: Array<BeforeDeleteContext<User>> = []

			const hooks: HooksConfig<User> = {
				beforeCreate: [makeTrackingBeforeCreateHook(beforeCreateContexts)],
				beforeUpdate: [makeTrackingBeforeUpdateHook(beforeUpdateContexts)],
				beforeDelete: [makeTrackingBeforeDeleteHook(beforeDeleteContexts)],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Create a user
					const created = yield* db.users.create({
						name: "Context Test User",
						email: "context@test.com",
						age: 30,
					})

					// Update the user
					yield* db.users.update(created.id, {
						name: "Updated Name",
					})

					// Delete the user
					yield* db.users.delete(created.id)
				}),
			)

			// Verify beforeCreate context
			expect(beforeCreateContexts).toHaveLength(1)
			const createCtx = beforeCreateContexts[0]
			expect(createCtx.operation).toBe("create")
			expect(createCtx.collection).toBe("users")
			expect(createCtx.data.name).toBe("Context Test User")
			expect(createCtx.data.email).toBe("context@test.com")
			expect(createCtx.data.age).toBe(30)

			// Verify beforeUpdate context
			expect(beforeUpdateContexts).toHaveLength(1)
			const updateCtx = beforeUpdateContexts[0]
			expect(updateCtx.operation).toBe("update")
			expect(updateCtx.collection).toBe("users")
			expect(updateCtx.id).toBeDefined()
			expect(updateCtx.existing.name).toBe("Context Test User")
			expect(updateCtx.update).toEqual({ name: "Updated Name" })

			// Verify beforeDelete context
			expect(beforeDeleteContexts).toHaveLength(1)
			const deleteCtx = beforeDeleteContexts[0]
			expect(deleteCtx.operation).toBe("delete")
			expect(deleteCtx.collection).toBe("users")
			expect(deleteCtx.id).toBeDefined()
			expect(deleteCtx.entity.name).toBe("Updated Name") // Reflects the update
		})
	})

	describe("after hooks", () => {
		it("afterCreate receives created entity", async () => {
			const afterCreateCalls: Array<AfterCreateContext<User>> = []
			const hooks: HooksConfig<User> = {
				afterCreate: [makeTrackingAfterCreateHook(afterCreateCalls)],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })
					const created = yield* db.users.create({
						name: "New User",
						email: "newuser@test.com",
						age: 28,
					})
					return created
				}),
			)

			// Verify afterCreate was called
			expect(afterCreateCalls).toHaveLength(1)
			const ctx = afterCreateCalls[0]

			// Verify context structure
			expect(ctx.operation).toBe("create")
			expect(ctx.collection).toBe("users")

			// Verify the entity in the context matches the created entity
			expect(ctx.entity.id).toBe(result.id)
			expect(ctx.entity.name).toBe("New User")
			expect(ctx.entity.email).toBe("newuser@test.com")
			expect(ctx.entity.age).toBe(28)

			// The entity should be the same as what was returned from create
			expect(ctx.entity).toEqual(result)
		})

		it("afterUpdate receives previous and current state", async () => {
			const afterUpdateCalls: Array<AfterUpdateContext<User>> = []
			const hooks: HooksConfig<User> = {
				afterUpdate: [makeTrackingAfterUpdateHook(afterUpdateCalls)],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					// u1 starts as: { id: "u1", name: "Alice", email: "alice@test.com", age: 30 }
					const updated = yield* db.users.update("u1", {
						name: "Alice Updated",
						age: 31,
					})
					return updated
				}),
			)

			// Verify afterUpdate was called
			expect(afterUpdateCalls).toHaveLength(1)
			const ctx = afterUpdateCalls[0]

			// Verify context structure
			expect(ctx.operation).toBe("update")
			expect(ctx.collection).toBe("users")
			expect(ctx.id).toBe("u1")

			// Verify previous state (before update)
			expect(ctx.previous.id).toBe("u1")
			expect(ctx.previous.name).toBe("Alice")
			expect(ctx.previous.email).toBe("alice@test.com")
			expect(ctx.previous.age).toBe(30)

			// Verify current state (after update)
			expect(ctx.current.id).toBe("u1")
			expect(ctx.current.name).toBe("Alice Updated")
			expect(ctx.current.email).toBe("alice@test.com") // unchanged
			expect(ctx.current.age).toBe(31)

			// The current should match what was returned from update
			expect(ctx.current).toEqual(result)

			// Verify the update payload is present
			expect(ctx.update).toEqual({ name: "Alice Updated", age: 31 })
		})

		it("afterDelete receives deleted entity", async () => {
			const afterDeleteCalls: Array<AfterDeleteContext<User>> = []
			const hooks: HooksConfig<User> = {
				afterDelete: [makeTrackingAfterDeleteHook(afterDeleteCalls)],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					// u1 starts as: { id: "u1", name: "Alice", email: "alice@test.com", age: 30 }
					const deleted = yield* db.users.delete("u1")
					return deleted
				}),
			)

			// Verify afterDelete was called
			expect(afterDeleteCalls).toHaveLength(1)
			const ctx = afterDeleteCalls[0]

			// Verify context structure
			expect(ctx.operation).toBe("delete")
			expect(ctx.collection).toBe("users")
			expect(ctx.id).toBe("u1")

			// Verify the entity in the context matches the deleted entity
			expect(ctx.entity.id).toBe("u1")
			expect(ctx.entity.name).toBe("Alice")
			expect(ctx.entity.email).toBe("alice@test.com")
			expect(ctx.entity.age).toBe(30)

			// The entity should be the same as what was returned from delete
			expect(ctx.entity).toEqual(result)
		})

		it("after-hook error does not fail the CRUD operation", async () => {
			// Create after-hooks that throw errors
			const failingAfterCreateHook: AfterCreateHook<User> = () =>
				Effect.fail(new Error("afterCreate hook failed!"))

			const failingAfterUpdateHook: AfterUpdateHook<User> = () =>
				Effect.fail(new Error("afterUpdate hook failed!"))

			const failingAfterDeleteHook: AfterDeleteHook<User> = () =>
				Effect.fail(new Error("afterDelete hook failed!"))

			// Track that hooks are actually called (even if they fail)
			const hookCallOrder: Array<string> = []

			const trackingFailingAfterCreateHook: AfterCreateHook<User> = () => {
				hookCallOrder.push("afterCreate")
				return Effect.fail(new Error("afterCreate hook failed!"))
			}

			const trackingFailingAfterUpdateHook: AfterUpdateHook<User> = () => {
				hookCallOrder.push("afterUpdate")
				return Effect.fail(new Error("afterUpdate hook failed!"))
			}

			const trackingFailingAfterDeleteHook: AfterDeleteHook<User> = () => {
				hookCallOrder.push("afterDelete")
				return Effect.fail(new Error("afterDelete hook failed!"))
			}

			const hooks: HooksConfig<User> = {
				afterCreate: [trackingFailingAfterCreateHook],
				afterUpdate: [trackingFailingAfterUpdateHook],
				afterDelete: [trackingFailingAfterDeleteHook],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Create should succeed despite afterCreate hook failing
					const created = yield* db.users.create({
						name: "Test User",
						email: "test@example.com",
						age: 25,
					})

					// Verify entity was created
					const foundAfterCreate = yield* db.users.findById(created.id)

					// Update should succeed despite afterUpdate hook failing
					const updated = yield* db.users.update(created.id, {
						name: "Updated User",
					})

					// Verify entity was updated
					const foundAfterUpdate = yield* db.users.findById(created.id)

					// Delete should succeed despite afterDelete hook failing
					const deleted = yield* db.users.delete(created.id)

					// Verify entity was deleted (should fail to find)
					const findAfterDelete = yield* db.users.findById(created.id).pipe(
						Effect.matchEffect({
							onFailure: (error) => Effect.succeed({ type: "error" as const, error }),
							onSuccess: (user) => Effect.succeed({ type: "found" as const, user }),
						}),
					)

					return {
						created,
						foundAfterCreate,
						updated,
						foundAfterUpdate,
						deleted,
						findAfterDelete,
					}
				}),
			)

			// All CRUD operations should have succeeded
			expect(result.created.name).toBe("Test User")
			expect(result.foundAfterCreate.name).toBe("Test User")
			expect(result.updated.name).toBe("Updated User")
			expect(result.foundAfterUpdate.name).toBe("Updated User")
			expect(result.deleted.name).toBe("Updated User")
			expect(result.findAfterDelete.type).toBe("error") // Entity no longer exists

			// Verify all hooks were actually called (even though they failed)
			expect(hookCallOrder).toEqual(["afterCreate", "afterUpdate", "afterDelete"])
		})
	})
})
