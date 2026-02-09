import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { update, updateMany } from "../core/operations/crud/update.js"
import {
	NotFoundError,
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
	active: Schema.Boolean,
	tags: Schema.Array(Schema.String),
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

const existingUser: User = {
	id: "user1",
	name: "John Doe",
	email: "john@example.com",
	age: 30,
	active: true,
	tags: ["admin", "dev"],
	companyId: "comp1",
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
}

const existingUsers: ReadonlyArray<User> = [
	existingUser,
	{
		id: "user2",
		name: "Jane Smith",
		email: "jane@example.com",
		age: 25,
		active: true,
		tags: ["dev"],
		companyId: "comp2",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	},
	{
		id: "user3",
		name: "Bob Wilson",
		email: "bob@example.com",
		age: 40,
		active: false,
		tags: ["manager"],
		companyId: "comp1",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	},
]

// ============================================================================
// Tests: update (single entity)
// ============================================================================

describe("Effect-based CRUD Update Operations", () => {
	describe("update (single entity)", () => {
		it("should update a field with direct assignment", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					const doUpdate = update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)

					const updated = yield* doUpdate("user1", { name: "John Updated" })
					return { updated, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.updated.name).toBe("John Updated")
			expect(result.updated.email).toBe("john@example.com") // unchanged
			expect(result.updated.id).toBe("user1") // unchanged
			expect(result.updated.updatedAt).toBeDefined()
			expect(result.updated.updatedAt).not.toBe("2024-01-01T00:00:00.000Z")

			// Verify state was updated
			expect(result.map.get("user1")!.name).toBe("John Updated")
		})

		it("should auto-set updatedAt timestamp", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { name: "Test" })
				}),
			)

			expect(result.updatedAt).toBeDefined()
			expect(result.updatedAt).not.toBe("2024-01-01T00:00:00.000Z")
			expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z") // preserved
		})

		it("should fail with NotFoundError for non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("nonexistent", { name: "Test" }).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("NotFoundError")
			if (result._tag === "NotFoundError") {
				expect(result.id).toBe("nonexistent")
				expect(result.collection).toBe("users")
			}
		})

		it("should fail with ValidationError when trying to update id", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { id: "new-id" } as Record<string, unknown>).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
			if (result._tag === "ValidationError") {
				expect(result.message).toContain("immutable")
				expect(result.issues[0]?.field).toBe("id")
			}
		})

		it("should fail with ValidationError when trying to update createdAt", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { createdAt: "2025-01-01" } as Record<string, unknown>).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
			if (result._tag === "ValidationError") {
				expect(result.message).toContain("immutable")
			}
		})

		it("should fail with ValidationError for invalid field types", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: "not a number" as unknown as number }).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should fail with ForeignKeyError for invalid FK reference", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { companyId: "nonexistent-company" }).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ForeignKeyError")
			if (result._tag === "ForeignKeyError") {
				expect(result.field).toBe("companyId")
				expect(result.value).toBe("nonexistent-company")
				expect(result.targetCollection).toBe("companies")
			}
		})

		it("should allow updating FK to a valid reference", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { companyId: "comp2" })
				}),
			)

			expect(result.companyId).toBe("comp2")
		})

		it("should not mutate state on validation failure", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: "bad" as unknown as number }).pipe(Effect.ignore)

					return yield* Ref.get(usersRef)
				}),
			)

			expect(mapAfter.get("user1")!.age).toBe(30)
		})

		it("should not mutate state on FK failure", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { companyId: "nonexistent" }).pipe(Effect.ignore)

					return yield* Ref.get(usersRef)
				}),
			)

			expect(mapAfter.get("user1")!.companyId).toBe("comp1")
		})

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("nonexistent", { name: "Test" }).pipe(
						Effect.catchTag("NotFoundError", (e) =>
							Effect.succeed(`caught: ${e.id}`),
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

			expect(result).toBe("caught: nonexistent")
		})
	})

	// ============================================================================
	// Tests: Update Operators
	// ============================================================================

	describe("update operators", () => {
		it("should apply $increment operator", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: { $increment: 5 } } as Record<string, unknown>)
				}),
			)

			expect(result.age).toBe(35)
		})

		it("should apply $decrement operator", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: { $decrement: 10 } } as Record<string, unknown>)
				}),
			)

			expect(result.age).toBe(20)
		})

		it("should apply $multiply operator", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: { $multiply: 2 } } as Record<string, unknown>)
				}),
			)

			expect(result.age).toBe(60)
		})

		it("should apply $set operator", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { age: { $set: 99 } } as Record<string, unknown>)
				}),
			)

			expect(result.age).toBe(99)
		})

		it("should apply $append operator to string", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { name: { $append: " Jr." } } as Record<string, unknown>)
				}),
			)

			expect(result.name).toBe("John Doe Jr.")
		})

		it("should apply $prepend operator to string", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { name: { $prepend: "Dr. " } } as Record<string, unknown>)
				}),
			)

			expect(result.name).toBe("Dr. John Doe")
		})

		it("should apply $append operator to array", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { tags: { $append: "qa" } } as Record<string, unknown>)
				}),
			)

			expect(result.tags).toEqual(["admin", "dev", "qa"])
		})

		it("should apply $prepend operator to array", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { tags: { $prepend: "lead" } } as Record<string, unknown>)
				}),
			)

			expect(result.tags).toEqual(["lead", "admin", "dev"])
		})

		it("should apply $remove operator to array (by value)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { tags: { $remove: "admin" } } as Record<string, unknown>)
				}),
			)

			expect(result.tags).toEqual(["dev"])
		})

		it("should apply $toggle operator to boolean", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* update(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)("user1", { active: { $toggle: true } } as Record<string, unknown>)
				}),
			)

			expect(result.active).toBe(false)
		})
	})

	// ============================================================================
	// Tests: updateMany (batch)
	// ============================================================================

	describe("updateMany (batch)", () => {
		it("should update all matching entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					const doUpdateMany = updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)

					const batch = yield* doUpdateMany(
						(user) => user.companyId === "comp1",
						{ name: "Updated User" },
					)

					return { batch, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.batch.count).toBe(2) // user1 and user3
			expect(result.batch.updated).toHaveLength(2)
			for (const u of result.batch.updated) {
				expect(u.name).toBe("Updated User")
			}

			// Verify state
			expect(result.map.get("user1")!.name).toBe("Updated User")
			expect(result.map.get("user3")!.name).toBe("Updated User")
			expect(result.map.get("user2")!.name).toBe("Jane Smith") // unchanged
		})

		it("should return empty result when no entities match", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						(user) => user.age > 100,
						{ name: "Nobody" },
					)
				}),
			)

			expect(result.count).toBe(0)
			expect(result.updated).toHaveLength(0)
		})

		it("should apply operators to all matching entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						(user) => user.active === true,
						{ age: { $increment: 1 } } as Record<string, unknown>,
					)
				}),
			)

			expect(result.count).toBe(2) // user1 (active=true) and user2 (active=true)
			const ages = result.updated.map((u) => u.age).sort()
			expect(ages).toEqual([26, 31]) // 25+1, 30+1
		})

		it("should fail with ValidationError for immutable field updates", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						() => true,
						{ id: "new-id" } as Record<string, unknown>,
					).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
			if (result._tag === "ValidationError") {
				expect(result.message).toContain("immutable")
			}
		})

		it("should fail with ForeignKeyError for invalid FK reference", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						(user) => user.id === "user1",
						{ companyId: "nonexistent" },
					).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ForeignKeyError")
		})

		it("should not mutate state on validation failure", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						() => true,
						{ age: "bad" as unknown as number },
					).pipe(Effect.ignore)

					return yield* Ref.get(usersRef)
				}),
			)

			// All ages should be unchanged
			expect(mapAfter.get("user1")!.age).toBe(30)
			expect(mapAfter.get("user2")!.age).toBe(25)
			expect(mapAfter.get("user3")!.age).toBe(40)
		})

		it("should set updatedAt on all updated entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers)
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					})

					return yield* updateMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)(
						() => true,
						{ name: "All Updated" },
					)
				}),
			)

			for (const entity of result.updated) {
				expect(entity.updatedAt).toBeDefined()
				expect(entity.updatedAt).not.toBe("2024-01-01T00:00:00.000Z")
			}
		})
	})
})
