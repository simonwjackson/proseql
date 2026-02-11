import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
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
	})
})
