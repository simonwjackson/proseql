import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { upsert, upsertMany } from "../src/operations/crud/upsert.js"
import { ValidationError } from "../src/errors/crud-errors.js"
import { normalizeConstraints } from "../src/operations/crud/unique-check.js"

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
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Setting>([existingSetting])
				const stateRefs = yield* makeStateRefs({ settings: [existingSetting] })

				// Upsert using { userId, settingKey } — valid because [userId, settingKey] is a compound constraint
				const result = yield* upsert(
					"settings",
					SettingSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					settingUniqueFields, // [["userId", "settingKey"]] configured
				)({
					where: { userId: "user1", settingKey: "theme" }, // Using compound constraint fields
					create: {
						userId: "user1",
						settingKey: "theme",
						value: "new-value",
					},
					update: { value: "updated-value" },
				})

				// Should update existing setting (matched by compound key)
				expect(result.__action).toBe("updated")
				expect(result.id).toBe("setting1")
				expect(result.value).toBe("updated-value")

				return result
			})

			await Effect.runPromise(program)
		})

		it("should create when compound where clause does not match existing", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Setting>([existingSetting])
				const stateRefs = yield* makeStateRefs({ settings: [existingSetting] })

				// Upsert with compound where that doesn't match — should create
				const result = yield* upsert(
					"settings",
					SettingSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					settingUniqueFields,
				)({
					where: { userId: "user1", settingKey: "language" }, // Different settingKey
					create: {
						userId: "user1",
						settingKey: "language",
						value: "en",
					},
					update: { value: "fr" },
				})

				// Should create new setting (no match for compound key)
				expect(result.__action).toBe("created")
				expect(result.userId).toBe("user1")
				expect(result.settingKey).toBe("language")
				expect(result.value).toBe("en")

				return result
			})

			await Effect.runPromise(program)
		})

		it("should reject partial compound where (missing one field)", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Setting>([existingSetting])
				const stateRefs = yield* makeStateRefs({ settings: [existingSetting] })

				// Upsert using only { userId } — invalid because compound constraint requires BOTH userId AND settingKey
				const result = yield* upsert(
					"settings",
					SettingSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					settingUniqueFields, // [["userId", "settingKey"]] configured
				)({
					where: { userId: "user1" }, // Only one of the compound fields — should fail
					create: {
						userId: "user1",
						settingKey: "theme",
						value: "dark",
					},
					update: { value: "updated-value" },
				})

				return result
			})

			const error = await Effect.runPromise(
				program.pipe(
					Effect.flip, // Convert failure to success for assertion
				),
			)

			// Should fail with ValidationError because partial compound where doesn't match any constraint
			expect(error).toBeInstanceOf(ValidationError)
			expect(error._tag).toBe("ValidationError")
			expect(error.message).toContain("unique")
			expect(error.issues).toHaveLength(1)
			expect(error.issues[0].field).toBe("where")
			// Should mention the invalid field(s) and collection
			expect(error.issues[0].message).toContain("userId")
			expect(error.issues[0].message).toContain("settings")
			// Should mention valid unique fields (the compound constraint)
			expect(error.issues[0].message).toContain("userId, settingKey")
		})
	})

	describe("collection without uniqueFields", () => {
		it("should only accept { id } as where clause", async () => {
			// Test that a collection with no uniqueFields configured only accepts { id } in where clause
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Profile>([existingProfile])
				const stateRefs = yield* makeStateRefs({ profiles: [existingProfile] })

				// Upsert using { name } — should fail because no uniqueFields are configured
				// and "name" is not a valid unique field (only "id" is implicitly valid)
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
					where: { name: "Alice Profile" }, // Using non-id field when no uniqueFields configured
					create: {
						name: "Alice Profile",
						bio: "New bio",
					},
					update: { bio: "Updated bio" },
				})

				return result
			})

			const error = await Effect.runPromise(
				program.pipe(
					Effect.flip, // Convert failure to success for assertion
				),
			)

			// Should fail with ValidationError because only { id } is valid when no uniqueFields are configured
			expect(error).toBeInstanceOf(ValidationError)
			expect(error._tag).toBe("ValidationError")
			expect(error.message).toContain("unique")
			expect(error.issues).toHaveLength(1)
			expect(error.issues[0].field).toBe("where")
			// Should mention the collection
			expect(error.issues[0].message).toContain("profiles")
			// Should mention that only "id" is valid (the value object with "name" is in the value property)
			expect(error.issues[0].message).toContain("id")
			// The where clause value is captured in the issue
			expect(error.issues[0].value).toEqual({ name: "Alice Profile" })
		})

		it("should accept { id } when no uniqueFields are configured", async () => {
			// This is a positive test confirming { id } works with no uniqueFields
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Profile>([existingProfile])
				const stateRefs = yield* makeStateRefs({ profiles: [existingProfile] })

				// Upsert using { id } — always valid, even with no uniqueFields
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
					update: { bio: "Updated via id" },
				})

				expect(result.__action).toBe("updated")
				expect(result.bio).toBe("Updated via id")

				return result
			})

			await Effect.runPromise(program)
		})
	})

	describe("upsert where with extra fields", () => {
		it("should accept where clause with extra fields beyond constraint", async () => {
			// Test that where clause can include additional fields beyond the constraint.
			// If uniqueFields is ["email"], then where: { email: "...", age: 30 } is valid
			// because it fully covers the "email" constraint (the extra "age" field is allowed).
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// Upsert using { email, age } — valid because email is a unique field
				// and age is just extra filtering criteria
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
					where: { email: "alice@example.com", age: 30 }, // email covers constraint, age is extra
					create: {
						name: "Alice New",
						email: "alice@example.com",
						username: "alice-new",
						age: 30,
					},
					update: { age: 31 },
				})

				// Should update existing user (matched by email, age is extra filter)
				expect(result.__action).toBe("updated")
				expect(result.id).toBe("user1")
				expect(result.age).toBe(31)

				return result
			})

			await Effect.runPromise(program)
		})

		it("should accept compound where clause with extra fields", async () => {
			// Test that where clause can include additional fields beyond a compound constraint.
			// If uniqueFields is [["userId", "settingKey"]], then where: { userId, settingKey, value }
			// is valid because it fully covers the compound constraint (value is extra).
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<Setting>([existingSetting])
				const stateRefs = yield* makeStateRefs({ settings: [existingSetting] })

				// Upsert using { userId, settingKey, value } — valid because [userId, settingKey]
				// is a compound constraint, and value is just extra filtering criteria
				const result = yield* upsert(
					"settings",
					SettingSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					settingUniqueFields, // [["userId", "settingKey"]] configured
				)({
					where: { userId: "user1", settingKey: "theme", value: "dark" }, // compound constraint covered, value is extra
					create: {
						userId: "user1",
						settingKey: "theme",
						value: "dark",
					},
					update: { value: "light" },
				})

				// Should update existing setting (matched by compound key, value is extra filter)
				expect(result.__action).toBe("updated")
				expect(result.id).toBe("setting1")
				expect(result.value).toBe("light")

				return result
			})

			await Effect.runPromise(program)
		})
	})

	describe("upsertMany validation", () => {
		it("should fail on first invalid where clause", async () => {
			// Test that upsertMany validates all where clauses and fails on the first invalid one.
			// The first input is valid (uses email, a unique field), but the second uses "name"
			// which is NOT in uniqueFields.
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				// First upsert: valid where clause using email (a declared unique field)
				// Second upsert: invalid where clause using name (NOT a unique field)
				const result = yield* upsertMany(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)([
					{
						where: { email: "alice@example.com" }, // Valid: email is unique
						create: {
							name: "Alice",
							email: "alice@example.com",
							username: "alice",
							age: 30,
						},
						update: { age: 31 },
					},
					{
						where: { name: "Bob" }, // Invalid: name is NOT unique
						create: {
							name: "Bob",
							email: "bob@example.com",
							username: "bob",
							age: 25,
						},
						update: { age: 26 },
					},
				])

				return result
			})

			const error = await Effect.runPromise(
				program.pipe(
					Effect.flip, // Convert failure to success for assertion
				),
			)

			// Should fail with ValidationError for the invalid where clause
			expect(error).toBeInstanceOf(ValidationError)
			expect(error._tag).toBe("ValidationError")
			expect(error.message).toContain("unique")
			expect(error.issues).toHaveLength(1)
			expect(error.issues[0].field).toBe("where")
			// Should mention the invalid field
			expect(error.issues[0].message).toContain("name")
			expect(error.issues[0].message).toContain("users")
			// Should mention valid unique fields
			expect(error.issues[0].message).toContain("email")
			expect(error.issues[0].message).toContain("username")
		})

		it("should fail immediately on first invalid where in batch", async () => {
			// Test that upsertMany fails on the FIRST invalid where clause,
			// even if there are multiple invalid ones in the batch.
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([])
				const stateRefs = yield* makeStateRefs({ users: [] })

				// All three use invalid where clauses (age is not unique)
				const result = yield* upsertMany(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)([
					{
						where: { age: 25 }, // Invalid: age is NOT unique
						create: {
							name: "First",
							email: "first@example.com",
							username: "first",
							age: 25,
						},
						update: { age: 26 },
					},
					{
						where: { age: 30 }, // Also invalid, but shouldn't be checked
						create: {
							name: "Second",
							email: "second@example.com",
							username: "second",
							age: 30,
						},
						update: { age: 31 },
					},
				])

				return result
			})

			const error = await Effect.runPromise(
				program.pipe(
					Effect.flip,
				),
			)

			// Should fail with ValidationError for the first invalid where clause
			expect(error).toBeInstanceOf(ValidationError)
			expect(error._tag).toBe("ValidationError")
			// The error value should contain the first invalid where clause (age: 25)
			expect(error.issues[0].value).toEqual({ age: 25 })
			// Should mention valid unique fields
			expect(error.issues[0].message).toContain("email")
			expect(error.issues[0].message).toContain("username")
		})

		it("should succeed when all where clauses are valid", async () => {
			// Test that upsertMany succeeds when all where clauses use valid unique fields
			const program = Effect.gen(function* () {
				const ref = yield* makeRef<User>([existingUser])
				const stateRefs = yield* makeStateRefs({ users: [existingUser] })

				const result = yield* upsertMany(
					"users",
					UserSchema,
					noRelationships,
					ref,
					stateRefs,
					undefined,
					undefined,
					userUniqueFields, // ["email", "username"] configured
				)([
					{
						where: { email: "alice@example.com" }, // Valid: email is unique
						create: {
							name: "Alice",
							email: "alice@example.com",
							username: "alice",
							age: 30,
						},
						update: { age: 32 },
					},
					{
						where: { username: "bob" }, // Valid: username is unique
						create: {
							name: "Bob",
							email: "bob@example.com",
							username: "bob",
							age: 25,
						},
						update: { age: 26 },
					},
					{
						where: { id: "carol" }, // Valid: id is always accepted
						create: {
							name: "Carol",
							email: "carol@example.com",
							username: "carol",
							age: 28,
						},
						update: { age: 29 },
					},
				])

				// Should have updated Alice and created Bob and Carol
				expect(result.updated).toHaveLength(1)
				expect(result.updated[0].email).toBe("alice@example.com")
				expect(result.updated[0].age).toBe(32)

				expect(result.created).toHaveLength(2)
				const createdUsernames = result.created.map((u) => u.username)
				expect(createdUsernames).toContain("bob")
				expect(createdUsernames).toContain("carol")

				return result
			})

			await Effect.runPromise(program)
		})
	})
})
