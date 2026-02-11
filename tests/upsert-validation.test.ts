import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { upsert, upsertMany } from "../core/operations/crud/upsert.js"
import { ValidationError } from "../core/errors/crud-errors.js"
import { normalizeConstraints } from "../core/operations/crud/unique-check.js"

// ============================================================================
// Test Schemas
// ============================================================================

/**
 * User schema with email and username as unique fields.
 * This tests single-field unique constraint validation for upsert where clauses.
 */
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	username: Schema.String,
	age: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

/**
 * Settings schema with compound unique constraint on [userId, settingKey].
 * This tests compound unique constraint validation for upsert where clauses.
 */
const SettingSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	settingKey: Schema.String,
	value: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Setting = typeof SettingSchema.Type

/**
 * Profile schema with no unique fields configured.
 * This tests that only `{ id }` is accepted when no uniqueFields are declared.
 */
const ProfileSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	bio: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Profile = typeof ProfileSchema.Type

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
 * Normalized unique constraints for compound [userId, settingKey].
 */
const settingUniqueFields = normalizeConstraints([["userId", "settingKey"]])

/**
 * No unique fields configured (empty array).
 */
const noUniqueFields = normalizeConstraints([])

/**
 * No relationships configured for test schemas.
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

const existingSetting: Setting = {
	id: "setting1",
	userId: "user1",
	settingKey: "theme",
	value: "dark",
}

const existingProfile: Profile = {
	id: "profile1",
	name: "Alice Profile",
	bio: "A test profile",
}

// ============================================================================
// Tests
// ============================================================================

describe("Upsert Where-Clause Validation", () => {
	describe("upsert with { id }", () => {
		it("should accept where: { id } regardless of uniqueFields config", async () => {
			// Test with collection that has uniqueFields configured
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// Upsert using { id } — should always be valid, even when uniqueFields are configured
				const result = yield* upsert(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)({
					where: { id: "user1" }, // Using id as where clause
					create: {
						name: "Alice Updated",
						email: "alice-new@example.com",
						username: "alice-new",
						age: 31,
					},
					update: { age: 35 },
				})

				// Should update the existing user (not create)
				expect(result.__action).toBe("updated")
				expect(result.age).toBe(35)

				return result
			})

			await Effect.runPromise(program)
		})

		it("should accept where: { id } when collection has no uniqueFields", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Profile>([existingProfile])
				const stateRefs = yield* makeStateRefs({ profiles: [existingProfile] })

				// Upsert using { id } — always valid even with empty uniqueFields
				const result = yield* upsert(
					"profiles",
					ProfileSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					noUniqueFields, // no uniqueFields configured
				)({
					where: { id: "profile1" },
					create: {
						name: "New Profile",
						bio: "New bio",
					},
					update: { bio: "Updated bio" },
				})

				expect(result.__action).toBe("updated")
				expect(result.bio).toBe("Updated bio")

				return result
			})

			await Effect.runPromise(program)
		})

		it("should create entity when where: { id } does not match", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// Upsert with new id — should create
				const result = yield* upsert(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields,
				)({
					where: { id: "user-new" },
					create: {
						name: "Bob",
						email: "bob@example.com",
						username: "bob",
						age: 25,
					},
					update: { age: 30 },
				})

				expect(result.__action).toBe("created")
				expect(result.id).toBe("user-new")
				expect(result.name).toBe("Bob")

				return result
			})

			await Effect.runPromise(program)
		})
	})

	describe("upsert with single unique field", () => {
		it("should accept where clause targeting a declared unique field", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// Upsert using { email } — valid because email is in uniqueFields
				const result = yield* upsert(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)({
					where: { email: "alice@example.com" }, // Using declared unique field
					create: {
						name: "Alice New",
						email: "alice@example.com",
						username: "alice-new",
						age: 25,
					},
					update: { age: 32 },
				})

				// Should update existing user (matched by email)
				expect(result.__action).toBe("updated")
				expect(result.id).toBe("user1")
				expect(result.age).toBe(32)

				return result
			})

			await Effect.runPromise(program)
		})

		it("should reject where clause targeting a non-unique field", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// Upsert using { name } — invalid because name is NOT in uniqueFields
				// uniqueFields is ["email", "username"], so "name" should fail
				const result = yield* upsert(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)({
					where: { name: "Alice" }, // Using non-unique field
					create: {
						name: "Alice",
						email: "alice-new@example.com",
						username: "alice-new",
						age: 25,
					},
					update: { age: 32 },
				})

				return result
			})

			const error = await Effect.runPromise(
				program.pipe(
					Effect.flip, // Convert failure to success for assertion
				),
			)

			// Should fail with ValidationError
			expect(error).toBeInstanceOf(ValidationError)
			expect(error._tag).toBe("ValidationError")
			expect(error.message).toContain("unique")
			expect(error.issues).toHaveLength(1)
			expect(error.issues[0].field).toBe("where")
			expect(error.issues[0].message).toContain("name")
			expect(error.issues[0].message).toContain("users")
			// Should mention valid unique fields
			expect(error.issues[0].message).toContain("email")
			expect(error.issues[0].message).toContain("username")
		})
	})

	describe("upsert with compound unique constraint", () => {
		it("should accept where clause matching compound constraint", async () => {
			// TODO: Task 7.5
		})

		it("should reject partial compound where (missing one field)", async () => {
			// TODO: Task 7.6
		})
	})

	describe("collection without uniqueFields", () => {
		it("should only accept { id } as where clause", async () => {
			// TODO: Task 7.7
		})
	})

	describe("upsert where with extra fields", () => {
		it("should accept where clause with extra fields beyond constraint", async () => {
			// TODO: Task 7.8
		})
	})

	describe("upsertMany validation", () => {
		it("should fail on first invalid where clause", async () => {
			// TODO: Task 7.9
		})
	})
})
