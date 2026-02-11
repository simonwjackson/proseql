import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "../../src/factories/database-effect"
import type { EffectDatabase } from "../../src/factories/database-effect"
import type { CreateInput } from "../../src/types/crud-types"

// Effect Schemas
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type
type Company = typeof CompanySchema.Type

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			users: { type: "inverse" as const, target: "users" as const },
		},
	},
} as const

describe("CRUD Create Operations (Effect-based)", () => {
	let db: EffectDatabase<typeof config>

	beforeEach(async () => {
		db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [],
				companies: [
					{ id: "comp1", name: "TechCorp" },
					{ id: "comp2", name: "DataInc" },
				],
			}),
		)
	})

	describe("create method", () => {
		it("should create a new entity with auto-generated ID", async () => {
			const user = await db.users.create({
				name: "John Doe",
				email: "john@example.com",
				age: 30,
				companyId: "comp1",
			}).runPromise

			expect(user.name).toBe("John Doe")
			expect(user.email).toBe("john@example.com")
			expect(user.age).toBe(30)
			expect(user.companyId).toBe("comp1")
			expect(user.id).toBeDefined()
			expect(user.createdAt).toBeDefined()
			expect(user.updatedAt).toBeDefined()
			expect(user.createdAt).toBe(user.updatedAt)

			// Verify entity was added to database
			const allUsers = await db.users.query().runPromise
			expect(allUsers).toHaveLength(1)
			expect(allUsers[0]?.name).toBe("John Doe")
		})

		it("should create entity with custom ID", async () => {
			const user = await db.users.create({
				id: "custom-user-id",
				name: "Jane Smith",
				email: "jane@example.com",
				age: 25,
				companyId: "comp2",
			}).runPromise

			expect(user.id).toBe("custom-user-id")
			expect(user.name).toBe("Jane Smith")
		})

		it("should fail with duplicate ID", async () => {
			await db.users.create({
				id: "user123",
				name: "User One",
				email: "user1@example.com",
				age: 30,
				companyId: "comp1",
			}).runPromise

			const error = await Effect.runPromise(
				db.users.create({
					id: "user123",
					name: "User Two",
					email: "user2@example.com",
					age: 35,
					companyId: "comp1",
				}).pipe(Effect.flip),
			)

			expect(error._tag).toBe("DuplicateKeyError")
		})

		it("should validate required fields", async () => {
			const incompleteUser = {
				name: "Invalid User",
				age: 30,
				companyId: "comp1",
			}

			const error = await Effect.runPromise(
				db.users.create(
					incompleteUser as CreateInput<User & { readonly id: string }>,
				).pipe(Effect.flip),
			)

			expect(error._tag).toBe("ValidationError")
		})

		it("should validate foreign key constraints", async () => {
			const error = await Effect.runPromise(
				db.users.create({
					name: "John Doe",
					email: "john@example.com",
					age: 30,
					companyId: "non-existent-company",
				}).pipe(Effect.flip),
			)

			expect(error._tag).toBe("ForeignKeyError")
		})
	})

	describe("createMany method", () => {
		it("should create multiple entities", async () => {
			const result = await db.users.createMany([
				{
					name: "User 1",
					email: "user1@example.com",
					age: 25,
					companyId: "comp1",
				},
				{
					name: "User 2",
					email: "user2@example.com",
					age: 30,
					companyId: "comp2",
				},
				{
					name: "User 3",
					email: "user3@example.com",
					age: 35,
					companyId: "comp1",
				},
			]).runPromise

			expect(result.created).toHaveLength(3)
			expect(result.skipped).toBeUndefined()

			// Verify all have unique IDs
			const ids = result.created.map((u) => u.id)
			expect(new Set(ids).size).toBe(3)

			// Verify all have timestamps
			for (const user of result.created) {
				expect(user.createdAt).toBeDefined()
				expect(user.updatedAt).toBeDefined()
			}

			// Verify in database
			const allUsers = await db.users.query().runPromise
			expect(allUsers).toHaveLength(3)
		})

		it("should skip duplicates when option is set", async () => {
			await db.users.create({
				id: "existing-user",
				name: "Existing User",
				email: "existing@example.com",
				age: 40,
				companyId: "comp1",
			}).runPromise

			const result = await db.users.createMany(
				[
					{
						id: "existing-user",
						name: "Duplicate User",
						email: "duplicate@example.com",
						age: 45,
						companyId: "comp1",
					},
					{
						name: "New User",
						email: "new@example.com",
						age: 30,
						companyId: "comp2",
					},
				],
				{ skipDuplicates: true },
			).runPromise

			expect(result.created).toHaveLength(1)
			expect(result.created[0].name).toBe("New User")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0].reason).toContain("Duplicate ID")
		})

		it("should fail fast without skipDuplicates", async () => {
			await db.users.create({
				id: "existing-user",
				name: "Existing User",
				email: "existing@example.com",
				age: 40,
				companyId: "comp1",
			}).runPromise

			const error = await Effect.runPromise(
				db.users.createMany([
					{
						name: "Valid User",
						email: "valid@example.com",
						age: 30,
						companyId: "comp1",
					},
					{
						id: "existing-user",
						name: "Duplicate User",
						email: "duplicate@example.com",
						age: 45,
						companyId: "comp1",
					},
				]).pipe(Effect.flip),
			)

			expect(error._tag).toBe("DuplicateKeyError")

			// Verify no new users were created (only the existing one)
			const allUsers = await db.users.query().runPromise
			expect(allUsers).toHaveLength(1)
		})

		it("should validate all foreign keys with skipDuplicates", async () => {
			const result = await db.users.createMany(
				[
					{
						name: "User 1",
						email: "user1@example.com",
						age: 25,
						companyId: "comp1",
					},
					{
						name: "User 2",
						email: "user2@example.com",
						age: 30,
						companyId: "invalid-company",
					},
				],
				{ skipDuplicates: true },
			).runPromise

			expect(result.created).toHaveLength(1)
			expect(result.created[0]?.name).toBe("User 1")
			expect(result.skipped).toHaveLength(1)
			expect(result.skipped![0].reason).toContain("Foreign key violation")
		})

		it("should handle empty array", async () => {
			const result = await db.users.createMany([]).runPromise

			expect(result.created).toHaveLength(0)
			expect(result.skipped).toBeUndefined()
		})
	})
})
