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

		it("multiple after-hooks run in order", async () => {
			// Track the order in which hooks are called for each operation type
			const createHookOrder: Array<number> = []
			const updateHookOrder: Array<number> = []
			const deleteHookOrder: Array<number> = []

			// Create numbered after-hooks that record their position
			const makeOrderedAfterCreateHook = (index: number): AfterCreateHook<User> =>
				() => {
					createHookOrder.push(index)
					return Effect.void
				}

			const makeOrderedAfterUpdateHook = (index: number): AfterUpdateHook<User> =>
				() => {
					updateHookOrder.push(index)
					return Effect.void
				}

			const makeOrderedAfterDeleteHook = (index: number): AfterDeleteHook<User> =>
				() => {
					deleteHookOrder.push(index)
					return Effect.void
				}

			const hooks: HooksConfig<User> = {
				afterCreate: [
					makeOrderedAfterCreateHook(1),
					makeOrderedAfterCreateHook(2),
					makeOrderedAfterCreateHook(3),
				],
				afterUpdate: [
					makeOrderedAfterUpdateHook(1),
					makeOrderedAfterUpdateHook(2),
					makeOrderedAfterUpdateHook(3),
				],
				afterDelete: [
					makeOrderedAfterDeleteHook(1),
					makeOrderedAfterDeleteHook(2),
					makeOrderedAfterDeleteHook(3),
				],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Create a user - all 3 afterCreate hooks should run in order
					const created = yield* db.users.create({
						name: "Order Test User",
						email: "order@test.com",
						age: 30,
					})

					// Update the user - all 3 afterUpdate hooks should run in order
					yield* db.users.update(created.id, {
						name: "Updated Order Test User",
					})

					// Delete the user - all 3 afterDelete hooks should run in order
					yield* db.users.delete(created.id)
				}),
			)

			// Verify afterCreate hooks ran in registration order
			expect(createHookOrder).toEqual([1, 2, 3])

			// Verify afterUpdate hooks ran in registration order
			expect(updateHookOrder).toEqual([1, 2, 3])

			// Verify afterDelete hooks ran in registration order
			expect(deleteHookOrder).toEqual([1, 2, 3])
		})

		it("after-hooks run after state mutation is complete", async () => {
			// This test verifies that when after-hooks run, the database state
			// has already been updated. The hook queries the database to confirm
			// the mutation has been applied before the hook runs.

			// We need to capture the database reference to query inside hooks
			let dbRef: Awaited<ReturnType<typeof Effect.runPromise<ReturnType<typeof createHookedDatabase>>>> | null = null

			// Track what we find when querying the database from inside hooks
			const afterCreateFindings: Array<{ found: boolean; entity: User | null }> = []
			const afterUpdateFindings: Array<{ found: boolean; entity: User | null; nameUpdated: boolean }> = []
			const afterDeleteFindings: Array<{ found: boolean }> = []

			// afterCreate hook that verifies the entity exists in the database
			const verifyingAfterCreateHook: AfterCreateHook<User> = (ctx) =>
				Effect.gen(function* () {
					if (!dbRef) return
					// Try to find the entity that was just created
					const result = yield* dbRef.users.findById(ctx.entity.id).pipe(
						Effect.matchEffect({
							onFailure: () => Effect.succeed(null),
							onSuccess: (user) => Effect.succeed(user),
						}),
					)
					afterCreateFindings.push({
						found: result !== null,
						entity: result,
					})
				})

			// afterUpdate hook that verifies the entity is updated in the database
			const verifyingAfterUpdateHook: AfterUpdateHook<User> = (ctx) =>
				Effect.gen(function* () {
					if (!dbRef) return
					// Try to find the entity and check if it has the new values
					const result = yield* dbRef.users.findById(ctx.id).pipe(
						Effect.matchEffect({
							onFailure: () => Effect.succeed(null),
							onSuccess: (user) => Effect.succeed(user),
						}),
					)
					afterUpdateFindings.push({
						found: result !== null,
						entity: result,
						nameUpdated: result?.name === ctx.current.name,
					})
				})

			// afterDelete hook that verifies the entity is deleted from the database
			const verifyingAfterDeleteHook: AfterDeleteHook<User> = (ctx) =>
				Effect.gen(function* () {
					if (!dbRef) return
					// Try to find the entity - it should NOT exist
					const result = yield* dbRef.users.findById(ctx.id).pipe(
						Effect.matchEffect({
							onFailure: () => Effect.succeed(null),
							onSuccess: (user) => Effect.succeed(user),
						}),
					)
					afterDeleteFindings.push({
						found: result !== null,
					})
				})

			const hooks: HooksConfig<User> = {
				afterCreate: [verifyingAfterCreateHook],
				afterUpdate: [verifyingAfterUpdateHook],
				afterDelete: [verifyingAfterDeleteHook],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })
					dbRef = db

					// Create a user - afterCreate hook should see the entity in the database
					const created = yield* db.users.create({
						name: "State Test User",
						email: "state@test.com",
						age: 25,
					})

					// Update the user - afterUpdate hook should see the updated entity
					yield* db.users.update(created.id, {
						name: "Updated State Test User",
					})

					// Delete the user - afterDelete hook should NOT find the entity
					yield* db.users.delete(created.id)
				}),
			)

			// Verify afterCreate saw the entity in the database
			expect(afterCreateFindings).toHaveLength(1)
			expect(afterCreateFindings[0].found).toBe(true)
			expect(afterCreateFindings[0].entity?.name).toBe("State Test User")

			// Verify afterUpdate saw the updated entity in the database
			expect(afterUpdateFindings).toHaveLength(1)
			expect(afterUpdateFindings[0].found).toBe(true)
			expect(afterUpdateFindings[0].nameUpdated).toBe(true)
			expect(afterUpdateFindings[0].entity?.name).toBe("Updated State Test User")

			// Verify afterDelete did NOT find the entity (it was already deleted)
			expect(afterDeleteFindings).toHaveLength(1)
			expect(afterDeleteFindings[0].found).toBe(false)
		})
	})

	describe("onChange hooks", () => {
		it("onChange fires on create with type: 'create'", async () => {
			const onChangeCalls: Array<OnChangeContext<User>> = []
			const hooks: HooksConfig<User> = {
				onChange: [makeTrackingOnChangeHook(onChangeCalls)],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })
					const created = yield* db.users.create({
						name: "OnChange Test User",
						email: "onchange@test.com",
						age: 32,
					})
					return created
				}),
			)

			// Verify onChange was called exactly once
			expect(onChangeCalls).toHaveLength(1)
			const ctx = onChangeCalls[0]

			// Verify the context has the correct discriminated union type
			expect(ctx.type).toBe("create")
			expect(ctx.collection).toBe("users")

			// Type narrowing based on discriminant
			if (ctx.type === "create") {
				// Verify the entity matches what was created
				expect(ctx.entity.id).toBe(result.id)
				expect(ctx.entity.name).toBe("OnChange Test User")
				expect(ctx.entity.email).toBe("onchange@test.com")
				expect(ctx.entity.age).toBe(32)

				// The entity should be the same as what was returned from create
				expect(ctx.entity).toEqual(result)
			} else {
				// Fail if wrong type
				expect.fail("Expected onChange context type to be 'create'")
			}
		})

		it("onChange fires on update with type: 'update', previous/current", async () => {
			const onChangeCalls: Array<OnChangeContext<User>> = []
			const hooks: HooksConfig<User> = {
				onChange: [makeTrackingOnChangeHook(onChangeCalls)],
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

			// Verify onChange was called exactly once
			expect(onChangeCalls).toHaveLength(1)
			const ctx = onChangeCalls[0]

			// Verify the context has the correct discriminated union type
			expect(ctx.type).toBe("update")
			expect(ctx.collection).toBe("users")

			// Type narrowing based on discriminant
			if (ctx.type === "update") {
				// Verify the id
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
			} else {
				// Fail if wrong type
				expect.fail("Expected onChange context type to be 'update'")
			}
		})

		it("onChange fires on delete with type: 'delete'", async () => {
			const onChangeCalls: Array<OnChangeContext<User>> = []
			const hooks: HooksConfig<User> = {
				onChange: [makeTrackingOnChangeHook(onChangeCalls)],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks)
					// u1 starts as: { id: "u1", name: "Alice", email: "alice@test.com", age: 30 }
					const deleted = yield* db.users.delete("u1")
					return deleted
				}),
			)

			// Verify onChange was called exactly once
			expect(onChangeCalls).toHaveLength(1)
			const ctx = onChangeCalls[0]

			// Verify the context has the correct discriminated union type
			expect(ctx.type).toBe("delete")
			expect(ctx.collection).toBe("users")

			// Type narrowing based on discriminant
			if (ctx.type === "delete") {
				// Verify the id
				expect(ctx.id).toBe("u1")

				// Verify the entity matches what was deleted
				expect(ctx.entity.id).toBe("u1")
				expect(ctx.entity.name).toBe("Alice")
				expect(ctx.entity.email).toBe("alice@test.com")
				expect(ctx.entity.age).toBe(30)

				// The entity should be the same as what was returned from delete
				expect(ctx.entity).toEqual(result)
			} else {
				// Fail if wrong type
				expect.fail("Expected onChange context type to be 'delete'")
			}
		})

		it("onChange fires after specific after-hooks", async () => {
			// Track the order in which hooks are called
			// Execution order should be:
			// 1. Before-hooks (not tested here)
			// 2. State mutation
			// 3. Specific after-hooks (afterCreate/afterUpdate/afterDelete)
			// 4. onChange hooks (after specific after-hooks)
			const hookOrder: Array<string> = []

			// Specific after-hooks
			const afterCreateHook: AfterCreateHook<User> = () => {
				hookOrder.push("afterCreate")
				return Effect.void
			}

			const afterUpdateHook: AfterUpdateHook<User> = () => {
				hookOrder.push("afterUpdate")
				return Effect.void
			}

			const afterDeleteHook: AfterDeleteHook<User> = () => {
				hookOrder.push("afterDelete")
				return Effect.void
			}

			// onChange hook
			const onChangeHook: OnChangeHook<User> = (ctx) => {
				hookOrder.push(`onChange:${ctx.type}`)
				return Effect.void
			}

			const hooks: HooksConfig<User> = {
				afterCreate: [afterCreateHook],
				afterUpdate: [afterUpdateHook],
				afterDelete: [afterDeleteHook],
				onChange: [onChangeHook],
			}

			await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Create a user - afterCreate should run before onChange
					const created = yield* db.users.create({
						name: "Order Test User",
						email: "order@test.com",
						age: 30,
					})

					// Update the user - afterUpdate should run before onChange
					yield* db.users.update(created.id, {
						name: "Updated Order Test User",
					})

					// Delete the user - afterDelete should run before onChange
					yield* db.users.delete(created.id)
				}),
			)

			// Verify the hook execution order:
			// - For each operation, the specific after-hook should run before onChange
			expect(hookOrder).toEqual([
				"afterCreate",    // specific after-hook runs first
				"onChange:create", // then onChange fires
				"afterUpdate",    // specific after-hook runs first
				"onChange:update", // then onChange fires
				"afterDelete",    // specific after-hook runs first
				"onChange:delete", // then onChange fires
			])
		})

		it("onChange works alongside specific hooks (both fire)", async () => {
			// This test verifies that when both specific hooks (before/after) and
			// onChange are configured, all of them fire and receive correct data.
			// This covers the use case where someone wants specific hooks for
			// targeted logic and onChange for generic cross-cutting concerns.

			// Track all hook calls with their received data
			const beforeCreateCalls: Array<{ name: string }> = []
			const afterCreateCalls: Array<{ name: string }> = []
			const onChangeCalls: Array<{ type: string; name: string }> = []

			const beforeUpdateCalls: Array<{ existing: string; update: Partial<User> }> = []
			const afterUpdateCalls: Array<{ previous: string; current: string }> = []

			const beforeDeleteCalls: Array<{ name: string }> = []
			const afterDeleteCalls: Array<{ name: string }> = []

			// beforeCreate: transform the data (add a suffix)
			const beforeCreateHook: BeforeCreateHook<User> = (ctx) => {
				beforeCreateCalls.push({ name: ctx.data.name })
				return Effect.succeed({
					...ctx.data,
					name: `${ctx.data.name}-transformed`,
				})
			}

			// afterCreate: record the final entity
			const afterCreateHook: AfterCreateHook<User> = (ctx) => {
				afterCreateCalls.push({ name: ctx.entity.name })
				return Effect.void
			}

			// beforeUpdate: record what we're updating
			const beforeUpdateHook: BeforeUpdateHook<User> = (ctx) => {
				beforeUpdateCalls.push({ existing: ctx.existing.name, update: ctx.update })
				return Effect.succeed(ctx.update)
			}

			// afterUpdate: record previous and current
			const afterUpdateHook: AfterUpdateHook<User> = (ctx) => {
				afterUpdateCalls.push({ previous: ctx.previous.name, current: ctx.current.name })
				return Effect.void
			}

			// beforeDelete: record what we're deleting
			const beforeDeleteHook: BeforeDeleteHook<User> = (ctx) => {
				beforeDeleteCalls.push({ name: ctx.entity.name })
				return Effect.void
			}

			// afterDelete: record the deleted entity
			const afterDeleteHook: AfterDeleteHook<User> = (ctx) => {
				afterDeleteCalls.push({ name: ctx.entity.name })
				return Effect.void
			}

			// onChange: generic listener that records all changes
			const onChangeHook: OnChangeHook<User> = (ctx) => {
				if (ctx.type === "create") {
					onChangeCalls.push({ type: ctx.type, name: ctx.entity.name })
				} else if (ctx.type === "update") {
					onChangeCalls.push({ type: ctx.type, name: ctx.current.name })
				} else if (ctx.type === "delete") {
					onChangeCalls.push({ type: ctx.type, name: ctx.entity.name })
				}
				return Effect.void
			}

			const hooks: HooksConfig<User> = {
				beforeCreate: [beforeCreateHook],
				afterCreate: [afterCreateHook],
				beforeUpdate: [beforeUpdateHook],
				afterUpdate: [afterUpdateHook],
				beforeDelete: [beforeDeleteHook],
				afterDelete: [afterDeleteHook],
				onChange: [onChangeHook],
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createHookedDatabase(hooks, { users: [] })

					// Create a user
					const created = yield* db.users.create({
						name: "TestUser",
						email: "test@example.com",
						age: 25,
					})

					// Update the user
					const updated = yield* db.users.update(created.id, {
						name: "UpdatedUser",
					})

					// Delete the user
					const deleted = yield* db.users.delete(created.id)

					return { created, updated, deleted }
				}),
			)

			// Verify all beforeCreate hooks were called with original data
			expect(beforeCreateCalls).toHaveLength(1)
			expect(beforeCreateCalls[0].name).toBe("TestUser")

			// Verify afterCreate received the transformed entity
			expect(afterCreateCalls).toHaveLength(1)
			expect(afterCreateCalls[0].name).toBe("TestUser-transformed")

			// Verify beforeUpdate received the existing entity and update
			expect(beforeUpdateCalls).toHaveLength(1)
			expect(beforeUpdateCalls[0].existing).toBe("TestUser-transformed")
			expect(beforeUpdateCalls[0].update).toEqual({ name: "UpdatedUser" })

			// Verify afterUpdate received both previous and current
			expect(afterUpdateCalls).toHaveLength(1)
			expect(afterUpdateCalls[0].previous).toBe("TestUser-transformed")
			expect(afterUpdateCalls[0].current).toBe("UpdatedUser")

			// Verify beforeDelete received the entity to be deleted
			expect(beforeDeleteCalls).toHaveLength(1)
			expect(beforeDeleteCalls[0].name).toBe("UpdatedUser")

			// Verify afterDelete received the deleted entity
			expect(afterDeleteCalls).toHaveLength(1)
			expect(afterDeleteCalls[0].name).toBe("UpdatedUser")

			// Verify onChange fired for all three operations with correct data
			expect(onChangeCalls).toHaveLength(3)
			expect(onChangeCalls[0]).toEqual({ type: "create", name: "TestUser-transformed" })
			expect(onChangeCalls[1]).toEqual({ type: "update", name: "UpdatedUser" })
			expect(onChangeCalls[2]).toEqual({ type: "delete", name: "UpdatedUser" })

			// Verify the returned results are correct
			expect(result.created.name).toBe("TestUser-transformed")
			expect(result.updated.name).toBe("UpdatedUser")
			expect(result.deleted.name).toBe("UpdatedUser")
		})
	})
})
