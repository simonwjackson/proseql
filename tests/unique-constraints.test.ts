import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { create, createMany } from "../core/operations/crud/create.js"
import { update, updateMany } from "../core/operations/crud/update.js"
import { UniqueConstraintError } from "../core/errors/crud-errors.js"
import { normalizeConstraints } from "../core/operations/crud/unique-check.js"

// ============================================================================
// Test Schemas
// ============================================================================

/**
 * User schema with email and username as unique fields.
 * This is the primary test subject for unique constraint enforcement.
 */
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	username: Schema.String,
	age: Schema.Number,
	role: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

// ============================================================================
// Test Helpers
// ============================================================================

type HasId = { readonly id: string }

/**
 * Create a Ref<ReadonlyMap> from an array of entities.
 */
const makeRef = <T extends HasId>(
	items: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> =>
	Ref.make(
		new Map(items.map((item) => [item.id, item])) as ReadonlyMap<string, T>,
	)

/**
 * Create state refs from a record of collection names to entity arrays.
 */
const makeStateRefs = (
	collections: Record<string, ReadonlyArray<HasId>>,
): Effect.Effect<Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>> =>
	Effect.gen(function* () {
		const refs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {}
		for (const [name, items] of Object.entries(collections)) {
			refs[name] = yield* makeRef(items)
		}
		return refs
	})

/**
 * Normalized unique constraints for the User schema.
 * ["email", "username"] normalized to [["email"], ["username"]]
 */
const userUniqueFields = normalizeConstraints(["email", "username"])

/**
 * No relationships configured for the User schema in these tests.
 */
const noRelationships = {}

// ============================================================================
// Test Data
// ============================================================================

const existingUser: User = {
	id: "user1",
	name: "Alice",
	email: "alice@example.com",
	username: "alice",
	age: 30,
}

const anotherUser: User = {
	id: "user2",
	name: "Bob",
	email: "bob@example.com",
	username: "bob",
	age: 25,
}

// ============================================================================
// Tests
// ============================================================================

describe("Unique Constraints - Single Field", () => {
	describe("create", () => {
		it("should fail with UniqueConstraintError when email already exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser] })

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined, // indexes
						undefined, // hooks
						userUniqueFields,
					)

					return yield* doCreate({
						name: "Duplicate",
						email: "alice@example.com", // same as existingUser
						username: "newuser",
						age: 25,
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("UniqueConstraintError")
			if (result._tag === "UniqueConstraintError") {
				expect(result.collection).toBe("users")
				expect(result.constraint).toBe("unique_email")
				expect(result.fields).toEqual(["email"])
				expect(result.values).toEqual({ email: "alice@example.com" })
				expect(result.existingId).toBe("user1")
			}
		})

		it("should fail with UniqueConstraintError when username already exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser] })

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					return yield* doCreate({
						name: "Duplicate",
						email: "new@example.com",
						username: "alice", // same as existingUser
						age: 25,
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("UniqueConstraintError")
			if (result._tag === "UniqueConstraintError") {
				expect(result.constraint).toBe("unique_username")
				expect(result.fields).toEqual(["username"])
				expect(result.values).toEqual({ username: "alice" })
			}
		})

		it("should succeed when all unique values are different", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser] })

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					return yield* doCreate({
						name: "New User",
						email: "new@example.com",
						username: "newuser",
						age: 28,
					})
				}),
			)

			expect(result.name).toBe("New User")
			expect(result.email).toBe("new@example.com")
			expect(result.username).toBe("newuser")
		})

		it("should succeed when unique field is null (nulls not checked)", async () => {
			// Schema with optional email to allow null
			const UserWithOptionalEmail = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				email: Schema.NullOr(Schema.String),
				username: Schema.String,
				age: Schema.Number,
				createdAt: Schema.optional(Schema.String),
				updatedAt: Schema.optional(Schema.String),
			})

			type UserOptEmail = typeof UserWithOptionalEmail.Type

			const existingWithNullEmail: UserOptEmail = {
				id: "user1",
				name: "Alice",
				email: null,
				username: "alice",
				age: 30,
			}

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<UserOptEmail>([existingWithNullEmail])
					const stateRefs = yield* makeStateRefs({ users: [existingWithNullEmail] })

					const doCreate = create(
						"users",
						UserWithOptionalEmail,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						normalizeConstraints(["email", "username"]),
					)

					// Create another user with null email - should succeed
					return yield* doCreate({
						name: "New User",
						email: null,
						username: "newuser",
						age: 25,
					})
				}),
			)

			expect(result.name).toBe("New User")
			expect(result.email).toBe(null)
		})
	})

	describe("createMany", () => {
		it("should fail on inter-batch duplicates", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({ users: [] })

					const doCreateMany = createMany(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					return yield* doCreateMany([
						{ name: "User 1", email: "same@example.com", username: "user1", age: 25 },
						{ name: "User 2", email: "same@example.com", username: "user2", age: 30 }, // duplicate email
					]).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("UniqueConstraintError")
			if (result._tag === "UniqueConstraintError") {
				expect(result.values).toEqual({ email: "same@example.com" })
			}
		})

		it("should skip unique violations when skipDuplicates is true", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser] })

					const doCreateMany = createMany(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					return yield* doCreateMany(
						[
							{ name: "Duplicate", email: "alice@example.com", username: "dup", age: 25 }, // conflicts with existingUser
							{ name: "Valid", email: "valid@example.com", username: "valid", age: 30 },
						],
						{ skipDuplicates: true },
					)
				}),
			)

			expect(result.created).toHaveLength(1)
			expect(result.created[0]!.name).toBe("Valid")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0]!.reason).toContain("Unique constraint violation")
		})
	})

	describe("update", () => {
		it("should fail when changing unique field to conflicting value", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser, anotherUser] })

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined, // indexes
						undefined, // hooks
						userUniqueFields,
					)

					// Try to change Bob's email to Alice's email
					return yield* doUpdate("user2", { email: "alice@example.com" }).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("UniqueConstraintError")
			if (result._tag === "UniqueConstraintError") {
				expect(result.existingId).toBe("user1")
				expect(result.values).toEqual({ email: "alice@example.com" })
			}
		})

		it("should succeed when changing unique field to non-conflicting value", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser, anotherUser] })

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					// Change Bob's email to a new unique email
					return yield* doUpdate("user2", { email: "newemail@example.com" })
				}),
			)

			expect(result.email).toBe("newemail@example.com")
		})

		it("should succeed when changing non-unique field", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser, anotherUser] })

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					)

					// Change Bob's age (non-unique field)
					return yield* doUpdate("user2", { age: 100 })
				}),
			)

			expect(result.age).toBe(100)
			expect(result.email).toBe("bob@example.com")
		})
	})

	describe("collection without uniqueFields", () => {
		it("should only enforce ID uniqueness", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser])
					const stateRefs = yield* makeStateRefs({ users: [existingUser] })

					// No uniqueFields configured (empty array)
					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						[], // empty uniqueFields
					)

					// Same email should be allowed since no uniqueFields configured
					return yield* doCreate({
						name: "Duplicate Email",
						email: "alice@example.com", // same as existingUser
						username: "differentuser",
						age: 25,
					})
				}),
			)

			expect(result.name).toBe("Duplicate Email")
			expect(result.email).toBe("alice@example.com")
		})
	})
})
