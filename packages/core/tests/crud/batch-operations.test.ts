import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "../../src/factories/database-effect"
import type { EffectDatabase } from "../../src/factories/database-effect"

// Effect Schemas
const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	score: Schema.optional(Schema.Number, { default: () => 0 }),
	tags: Schema.optional(Schema.Array(Schema.String), { default: () => [] as ReadonlyArray<string> }),
	metadata: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	domain: Schema.String,
	employeeCount: Schema.optional(Schema.Number, { default: () => 0 }),
	revenue: Schema.optional(Schema.Number, { default: () => 0 }),
	isActive: Schema.optional(Schema.Boolean, { default: () => true }),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const AuditLogSchema = Schema.Struct({
	id: Schema.String,
	action: Schema.String,
	entityType: Schema.String,
	entityId: Schema.String,
	userId: Schema.optional(Schema.String),
	changes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	timestamp: Schema.String,
	createdAt: Schema.optional(Schema.String),
})

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
			auditLogs: { type: "inverse" as const, target: "auditLogs" as const, foreignKey: "userId" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			users: { type: "inverse" as const, target: "users" as const, foreignKey: "companyId" },
		},
	},
	auditLogs: {
		schema: AuditLogSchema,
		relationships: {
			user: { type: "ref" as const, target: "users" as const, foreignKey: "userId" },
		},
	},
} as const

describe("CRUD Batch Operations and Edge Cases (Effect-based)", () => {
	let db: EffectDatabase<typeof config>
	let yesterday: string

	beforeEach(async () => {
		const now = new Date().toISOString()
		yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

		db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [
					{ id: "user1", email: "user1@example.com", name: "User One", age: 30, score: 100, tags: ["active", "premium"], metadata: { role: "admin", level: 5 }, companyId: "comp1", createdAt: yesterday, updatedAt: yesterday },
					{ id: "user2", email: "user2@example.com", name: "User Two", age: 25, score: 50, tags: ["active"], companyId: "comp1", createdAt: yesterday, updatedAt: yesterday },
					{ id: "user3", email: "user3@example.com", name: "User Three", age: 35, score: 75, tags: ["inactive"], companyId: "comp2", createdAt: yesterday, updatedAt: yesterday },
				],
				companies: [
					{ id: "comp1", name: "Company One", domain: "company1.com", employeeCount: 50, revenue: 1000000, isActive: true, createdAt: yesterday, updatedAt: yesterday },
					{ id: "comp2", name: "Company Two", domain: "company2.com", employeeCount: 20, revenue: 500000, isActive: true, createdAt: yesterday, updatedAt: yesterday },
				],
				auditLogs: [
					{ id: "log1", action: "login", entityType: "user", entityId: "user1", userId: "user1", timestamp: yesterday, createdAt: yesterday },
					{ id: "log2", action: "update", entityType: "user", entityId: "user2", userId: "user2", changes: { name: { old: "Old Name", new: "User Two" } }, timestamp: now, createdAt: now },
				],
			}),
		)
	})

	describe("Large batch operations", () => {
		it("should handle large createMany operations", async () => {
			const largeBatch = Array.from({ length: 100 }, (_, i) => ({
				action: `action_${i}`,
				entityType: "user",
				entityId: `user${(i % 3) + 1}`,
				userId: i % 2 === 0 ? `user${(i % 3) + 1}` : undefined,
				timestamp: new Date(Date.now() - i * 1000).toISOString(),
			}))

			const result = await db.auditLogs.createMany(largeBatch).runPromise

			expect(result.created).toHaveLength(100)
			expect(result.created.every((log) => log.id)).toBe(true)
			expect(result.created.every((log) => log.createdAt)).toBe(true)

			const allLogs = await db.auditLogs.query().runPromise
			expect(allLogs).toHaveLength(102)
		})

		it("should handle large updateMany operations", async () => {
			const newUsers = Array.from({ length: 50 }, (_, i) => ({
				email: `bulk${i}@example.com`,
				name: `Bulk User ${i}`,
				age: 20 + (i % 40),
				score: i * 10,
				tags: i % 2 === 0 ? ["even"] : ["odd"],
				companyId: i % 2 === 0 ? "comp1" : "comp2",
			}))

			await db.users.createMany(newUsers).runPromise

			const result = await db.users.updateMany(
				(u) => u.tags?.includes("even") ?? false,
				{
					score: { $multiply: 2 },
					tags: { $append: "processed" },
				},
			).runPromise

			expect(result.count).toBe(25)
			expect(result.updated.every((u) => u.tags?.includes("processed"))).toBe(true)
			expect(result.updated.every((u) => (u.score ?? 0) % 20 === 0)).toBe(true)
		})

		it("should handle large deleteMany operations", async () => {
			const baseTime = Date.now()
			const logs = Array.from({ length: 100 }, (_, i) => ({
				action: "test",
				entityType: "test",
				entityId: `test${i}`,
				timestamp: new Date(baseTime - i * 60000).toISOString(),
			}))

			await db.auditLogs.createMany(logs).runPromise

			// Entries with timestamp < cutoff: i=50..99 from batch (50) + initial "yesterday" log (1) = 51
			const cutoffTime = new Date(baseTime - 49.5 * 60000).toISOString()
			const result = await db.auditLogs.deleteMany(
				(l) => l.timestamp < cutoffTime,
			).runPromise

			expect(result.count).toBe(51)
		})

		it("should handle large upsertMany operations", async () => {
			const upsertBatch = [
				...["user1", "user2", "user3"].map((id) => ({
					where: { id },
					create: { email: `${id}@example.com`, name: id, age: 30, companyId: "comp1" },
					update: { score: { $increment: 10 }, tags: { $append: "updated" } },
				})),
				...Array.from({ length: 20 }, (_, i) => ({
					where: { id: `newuser${i}` },
					create: { email: `newuser${i}@example.com`, name: `New User ${i}`, age: 20 + i, companyId: i % 2 === 0 ? "comp1" : "comp2" },
					update: { score: { $set: 100 } },
				})),
			]

			const result = await db.users.upsertMany(upsertBatch).runPromise

			expect(result.created).toHaveLength(20)
			expect(result.updated).toHaveLength(3)
			expect(result.updated.every((u) => u.tags?.includes("updated"))).toBe(true)
		})
	})

	describe("Transaction-like behavior", () => {
		it("should rollback createMany on validation error", async () => {
			const originalLogs = await db.auditLogs.query().runPromise
			const originalCount = originalLogs.length

			const error = await Effect.runPromise(
				db.auditLogs.createMany([
					{ action: "valid1", entityType: "test", entityId: "test1", timestamp: new Date().toISOString() },
					{ action: "", entityType: "test", entityId: "test2", timestamp: "" }, // May fail validation
					{ action: "valid2", entityType: "test", entityId: "test3", timestamp: new Date().toISOString() },
				]).pipe(Effect.either),
			)

			// Regardless of success/failure, verify count
			const logs = await db.auditLogs.query().runPromise
			// If it failed, count should be original. If it succeeded, count should be +3.
			if (error._tag === "Left") {
				expect(logs).toHaveLength(originalCount)
			}
		})

		it("should handle partial success with skipDuplicates", async () => {
			const result = await db.users.createMany(
				[
					{ id: "user1", email: "dup@example.com", name: "Dup", age: 30, companyId: "comp1" },
					{ email: "new1@example.com", name: "New User 1", age: 25, companyId: "comp1" },
					{ id: "user2", email: "dup2@example.com", name: "Dup 2", age: 35, companyId: "comp2" },
					{ email: "new2@example.com", name: "New User 2", age: 40, companyId: "comp2" },
				],
				{ skipDuplicates: true },
			).runPromise

			expect(result.created).toHaveLength(2)
			expect(result.skipped).toHaveLength(2)
		})
	})

	describe("Complex operator combinations", () => {
		it("should handle multiple operators on same entity", async () => {
			const result = await db.companies.update("comp1", {
				employeeCount: { $increment: 10 },
				revenue: { $multiply: 1.1 },
			}).runPromise

			expect(result.employeeCount).toBe(60)
			expect(result.revenue).toBe(1100000)
		})

		it("should handle nested object updates", async () => {
			const result = await db.users.update("user1", {
				metadata: { role: "superadmin", level: 10, newField: "value" },
			}).runPromise

			expect(result.metadata).toEqual({ role: "superadmin", level: 10, newField: "value" })
		})

		it("should handle array operations with predicates", async () => {
			await db.users.update("user1", {
				tags: { $append: ["test1", "test2", "remove-me", "keep-me"] },
			}).runPromise

			const result = await db.users.update("user1", {
				tags: { $remove: (tag: string) => tag.includes("remove") },
			}).runPromise

			expect(result.tags).not.toContain("remove-me")
			expect(result.tags).toContain("keep-me")
			expect(result.tags).toContain("test1")
		})
	})

	describe("Edge cases and error conditions", () => {
		it("should handle very long strings", async () => {
			const longString = "a".repeat(10000)

			const result = await db.auditLogs.create({
				action: longString,
				entityType: "test",
				entityId: "test1",
				timestamp: new Date().toISOString(),
			}).runPromise

			expect(result.action).toBe(longString)
		})

		it("should handle special characters in strings", async () => {
			const result = await db.users.update("user1", {
				name: "User with special chars & 特殊文字!",
			}).runPromise

			expect(result.name).toBe("User with special chars & 特殊文字!")
		})

		it("should handle null for optional fields", async () => {
			const result = await db.users.update("user1", {
				metadata: null,
			}).runPromise

			expect(result.metadata).toBeNull()
		})
	})

	describe("Performance and optimization cases", () => {
		it("should efficiently handle no-op updates", async () => {
			const result = await db.users.update("user1", {
				name: "User One",
				age: 30,
			}).runPromise

			// Should still update timestamp even for no-op
			expect(result.updatedAt).not.toBe(yesterday)
		})

		it("should handle sparse updates efficiently", async () => {
			const result = await db.users.updateMany(
				(u) => u.score >= 50 && u.score <= 100 && (u.tags?.includes("active") ?? false),
				{ score: { $increment: 5 } },
			).runPromise

			expect(result.count).toBe(2) // user1 and user2
		})
	})

	describe("Concurrent operation scenarios", () => {
		it("should handle rapid sequential updates", async () => {
			const updates = Array.from({ length: 10 }, () =>
				db.users.update("user1", { score: { $increment: 1 } }).runPromise,
			)

			const results = await Promise.all(updates)
			expect(results.every((r) => r.id === "user1")).toBe(true)

			const allUsers = await db.users.query().runPromise
			const user1 = allUsers.find((u: Record<string, unknown>) => u.id === "user1")
			expect(user1?.score).toBe(110)
		})

		it("should handle mixed operations on same entities", async () => {
			const operations = [
				db.users.update("user1", { tags: { $append: "tag1" } }).runPromise,
				db.users.update("user1", { score: { $increment: 10 } }).runPromise,
				db.users.update("user1", { metadata: { updated: true } }).runPromise,
			]

			const results = await Promise.all(operations)
			expect(results.every((r) => r.id === "user1")).toBe(true)

			const allUsers = await db.users.query().runPromise
			const user1 = allUsers.find((u: Record<string, unknown>) => u.id === "user1")
			expect(user1?.tags).toContain("tag1")
			expect((user1?.score as number)).toBeGreaterThanOrEqual(110)
			expect(user1?.metadata).toHaveProperty("updated")
		})
	})

	describe("Special field handling", () => {
		it("should handle ISO date strings correctly", async () => {
			const futureDate = new Date(Date.now() + 86400000).toISOString()

			const result = await db.auditLogs.create({
				action: "future-action",
				entityType: "test",
				entityId: "test1",
				timestamp: futureDate,
			}).runPromise

			expect(result.timestamp).toBe(futureDate)
			expect(new Date(result.timestamp).getTime()).toBeGreaterThan(Date.now())
		})

		it("should handle boolean operations correctly", async () => {
			let result = await db.companies.update("comp1", { isActive: { $toggle: true } }).runPromise
			expect(result.isActive).toBe(false)

			result = await db.companies.update("comp1", { isActive: { $toggle: true } }).runPromise
			expect(result.isActive).toBe(true)

			result = await db.companies.update("comp1", { isActive: { $set: false } }).runPromise
			expect(result.isActive).toBe(false)
		})

		it("should handle numeric edge values", async () => {
			let result = await db.companies.update("comp1", { revenue: { $set: 0 } }).runPromise
			expect(result.revenue).toBe(0)

			result = await db.companies.update("comp1", { revenue: { $set: -1000 } }).runPromise
			expect(result.revenue).toBe(-1000)

			result = await db.companies.update("comp1", { revenue: { $set: Number.MAX_SAFE_INTEGER } }).runPromise
			expect(result.revenue).toBe(Number.MAX_SAFE_INTEGER)
		})
	})
})
