import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema, Chunk } from "effect"
import { create, createMany } from "../core/operations/crud/create.js"
import {
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
} from "../core/errors/crud-errors.js"

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Company = typeof CompanySchema.Type

// ============================================================================
// Helpers
// ============================================================================

type HasId = { readonly id: string }

const makeRef = <T extends HasId>(
	items: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> =>
	Ref.make(
		new Map(items.map((item) => [item.id, item])) as ReadonlyMap<string, T>,
	)

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

// ============================================================================
// Test Data
// ============================================================================

const companies: ReadonlyArray<Company> = [
	{ id: "comp1", name: "TechCorp" },
	{ id: "comp2", name: "DataInc" },
]

const userRelationships = {
	company: { type: "ref" as const, target: "companies" as const },
}

// ============================================================================
// Tests
// ============================================================================

describe("Effect-based CRUD Create Operations", () => {
	describe("create (single entity)", () => {
		it("should create a new entity with auto-generated ID", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					const doCreate = create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)

					const user = yield* doCreate({
						name: "John Doe",
						email: "john@example.com",
						age: 30,
						companyId: "comp1",
					})

					return { user, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.user.name).toBe("John Doe")
			expect(result.user.email).toBe("john@example.com")
			expect(result.user.age).toBe(30)
			expect(result.user.companyId).toBe("comp1")
			expect(result.user.id).toBeDefined()
			expect(result.user.id.length).toBeGreaterThan(0)
			expect(result.user.createdAt).toBeDefined()
			expect(result.user.updatedAt).toBeDefined()
			expect(result.user.createdAt).toBe(result.user.updatedAt)

			// Verify entity was added to state
			expect(result.map.size).toBe(1)
			expect(result.map.get(result.user.id)).toEqual(result.user)
		})

		it("should create entity with custom ID", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						id: "custom-user-id",
						name: "Jane Smith",
						email: "jane@example.com",
						age: 25,
						companyId: "comp2",
					})
				}),
			)

			expect(result.id).toBe("custom-user-id")
			expect(result.name).toBe("Jane Smith")
		})

		it("should fail with DuplicateKeyError on duplicate ID", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([
						{ id: "user123", name: "Existing", email: "x@x.com", age: 20, companyId: "comp1" },
					])
					const stateRefs = yield* makeStateRefs({
						users: [{ id: "user123" }],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						id: "user123",
						name: "Duplicate User",
						email: "dup@example.com",
						age: 30,
						companyId: "comp1",
					}).pipe(
						Effect.flip, // Convert to success containing the error
					)
				}),
			)

			expect(result._tag).toBe("DuplicateKeyError")
			if (result._tag === "DuplicateKeyError") {
				expect(result.field).toBe("id")
				expect(result.value).toBe("user123")
			}
		})

		it("should fail with ValidationError for missing required fields", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						name: "No Email",
						age: 30,
						companyId: "comp1",
					} as Parameters<ReturnType<typeof create<User>>>[0]).pipe(
						Effect.flip,
					)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should fail with ValidationError for invalid field types", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						name: "Bad Age",
						email: "bad@example.com",
						age: "not a number" as unknown as number,
						companyId: "comp1",
					}).pipe(
						Effect.flip,
					)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should fail with ForeignKeyError for invalid foreign key references", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						name: "John Doe",
						email: "john@example.com",
						age: 30,
						companyId: "non-existent-company",
					}).pipe(
						Effect.flip,
					)
				}),
			)

			expect(result._tag).toBe("ForeignKeyError")
			if (result._tag === "ForeignKeyError") {
				expect(result.field).toBe("companyId")
				expect(result.value).toBe("non-existent-company")
				expect(result.targetCollection).toBe("companies")
			}
		})

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([
						{ id: "u1", name: "Existing", email: "e@e.com", age: 20, companyId: "comp1" },
					])
					const stateRefs = yield* makeStateRefs({
						users: [{ id: "u1" }],
						companies,
					})

					return yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						id: "u1",
						name: "Dup",
						email: "d@d.com",
						age: 25,
						companyId: "comp1",
					}).pipe(
						Effect.catchTag("DuplicateKeyError", (e) =>
							Effect.succeed(`caught: ${e.value}`),
						),
						Effect.catchTag("ValidationError", () =>
							Effect.succeed("caught: validation"),
						),
						Effect.catchTag("ForeignKeyError", () =>
							Effect.succeed("caught: fk"),
						),
					)
				}),
			)

			expect(result).toBe("caught: u1")
		})

		it("should not mutate state on validation failure", async () => {
			const mapSize = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						name: "Bad",
						age: "not number" as unknown as number,
						email: "x@x.com",
						companyId: "comp1",
					}).pipe(Effect.ignore)

					const map = yield* Ref.get(usersRef)
					return map.size
				}),
			)

			expect(mapSize).toBe(0)
		})

		it("should not mutate state on FK failure", async () => {
			const mapSize = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					yield* create(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						name: "FK fail",
						email: "fk@test.com",
						age: 30,
						companyId: "nonexistent",
					}).pipe(Effect.ignore)

					const map = yield* Ref.get(usersRef)
					return map.size
				}),
			)

			expect(mapSize).toBe(0)
		})
	})

	describe("createMany (batch)", () => {
		it("should create multiple entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					const doCreateMany = createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)

					const batch = yield* doCreateMany([
						{ name: "User 1", email: "u1@x.com", age: 25, companyId: "comp1" },
						{ name: "User 2", email: "u2@x.com", age: 30, companyId: "comp2" },
						{ name: "User 3", email: "u3@x.com", age: 35, companyId: "comp1" },
					])

					return { batch, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.batch.created).toHaveLength(3)
			expect(result.batch.skipped).toBeUndefined()

			// All have unique IDs
			const ids = result.batch.created.map((u) => u.id)
			expect(new Set(ids).size).toBe(3)

			// All have timestamps
			for (const user of result.batch.created) {
				expect(user.createdAt).toBeDefined()
				expect(user.updatedAt).toBeDefined()
			}

			// Verify in state
			expect(result.map.size).toBe(3)
		})

		it("should skip duplicates when option is set", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([
						{ id: "existing-user", name: "Existing", email: "e@e.com", age: 40, companyId: "comp1" },
					])
					const stateRefs = yield* makeStateRefs({
						users: [{ id: "existing-user" }],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ id: "existing-user", name: "Duplicate", email: "dup@x.com", age: 45, companyId: "comp1" },
							{ name: "New User", email: "new@x.com", age: 30, companyId: "comp2" },
						],
						{ skipDuplicates: true },
					)
				}),
			)

			expect(result.created).toHaveLength(1)
			expect(result.created[0]!.name).toBe("New User")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0]!.reason).toContain("Duplicate ID")
		})

		it("should fail fast without skipDuplicates", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([
						{ id: "existing-user", name: "Existing", email: "e@e.com", age: 40, companyId: "comp1" },
					])
					const stateRefs = yield* makeStateRefs({
						users: [{ id: "existing-user" }],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ name: "Valid", email: "v@x.com", age: 30, companyId: "comp1" },
							{ id: "existing-user", name: "Dup", email: "d@x.com", age: 45, companyId: "comp1" },
						],
					).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("DuplicateKeyError")
		})

		it("should skip entities with FK violations when skipDuplicates is set", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ name: "User 1", email: "u1@x.com", age: 25, companyId: "comp1" },
							{ name: "User 2", email: "u2@x.com", age: 30, companyId: "invalid-company" },
						],
						{ skipDuplicates: true },
					)
				}),
			)

			expect(result.created).toHaveLength(1)
			expect(result.created[0]!.name).toBe("User 1")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0]!.reason).toContain("Foreign key violation")
		})

		it("should handle empty array", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([], {})
				}),
			)

			expect(result.created).toHaveLength(0)
			expect(result.skipped).toBeUndefined()
		})

		it("should skip validation errors when skipDuplicates is set", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ name: "Valid User", email: "valid@x.com", age: 30, companyId: "comp1" },
							{ name: "Bad Age", email: "bad@x.com", age: "not a number" as unknown as number, companyId: "comp1" },
						],
						{ skipDuplicates: true },
					)
				}),
			)

			expect(result.created).toHaveLength(1)
			expect(result.created[0]!.name).toBe("Valid User")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0]!.reason).toContain("Validation failed")
		})

		it("should fail fast on validation error without skipDuplicates", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ name: "Bad Age", email: "bad@x.com", age: "not a number" as unknown as number, companyId: "comp1" },
							{ name: "Valid User", email: "valid@x.com", age: 30, companyId: "comp1" },
						],
					).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should detect duplicates within the batch itself", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ id: "same-id", name: "First", email: "f@x.com", age: 25, companyId: "comp1" },
							{ id: "same-id", name: "Second", email: "s@x.com", age: 30, companyId: "comp1" },
						],
						{ skipDuplicates: true },
					)
				}),
			)

			expect(result.created).toHaveLength(1)
			expect(result.created[0]!.name).toBe("First")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0]!.reason).toContain("Duplicate ID")
		})

		it("should skip FK validation when validateRelationships is false", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					})

					return yield* createMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						[
							{ name: "User 1", email: "u1@x.com", age: 25, companyId: "nonexistent1" },
							{ name: "User 2", email: "u2@x.com", age: 30, companyId: "nonexistent2" },
						],
						{ validateRelationships: false },
					)
				}),
			)

			// Should succeed because FK validation is skipped
			expect(result.created).toHaveLength(2)
		})
	})
})
