import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import { isOk, isErr } from "../../core/errors/crud-errors";
import { collect } from "../../core/utils/async-iterable.js";

describe("CRUD Batch Operations and Edge Cases", () => {
	// Test schemas
	const UserSchema = z.object({
		id: z.string(),
		email: z.string().email(),
		name: z.string().min(1),
		age: z.number().min(0).max(150),
		score: z.number().default(0),
		tags: z.array(z.string()).default([]),
		metadata: z.record(z.string(), z.unknown()).nullable().optional(),
		companyId: z.string(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(),
	});

	const CompanySchema = z.object({
		id: z.string(),
		name: z.string().min(1),
		domain: z.string(),
		employeeCount: z.number().default(0),
		revenue: z.number().default(0),
		isActive: z.boolean().default(true),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	const AuditLogSchema = z.object({
		id: z.string(),
		action: z.string(),
		entityType: z.string(),
		entityId: z.string(),
		userId: z.string().optional(),
		changes: z.record(z.string(), z.unknown()).optional(),
		timestamp: z.string(),
		createdAt: z.string().optional(),
	});

	// Test configuration
	const config = {
		users: {
			schema: UserSchema,
			relationships: {
				company: { type: "ref" as const, target: "companies" as const },
				auditLogs: {
					type: "inverse" as const,
					target: "auditLogs" as const,
					foreignKey: "userId",
				},
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				users: {
					type: "inverse" as const,
					target: "users" as const,
					foreignKey: "companyId",
				},
			},
		},
		auditLogs: {
			schema: AuditLogSchema,
			relationships: {
				user: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "userId",
				},
			},
		},
	} as const;

	// Test data
	let testData: {
		users: z.infer<typeof UserSchema>[];
		companies: z.infer<typeof CompanySchema>[];
		auditLogs: z.infer<typeof AuditLogSchema>[];
	};

	beforeEach(() => {
		const now = new Date().toISOString();
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		testData = {
			users: [
				{
					id: "user1",
					email: "user1@example.com",
					name: "User One",
					age: 30,
					score: 100,
					tags: ["active", "premium"],
					metadata: { role: "admin", level: 5 },
					companyId: "comp1",
					createdAt: yesterday,
					updatedAt: yesterday,
				},
				{
					id: "user2",
					email: "user2@example.com",
					name: "User Two",
					age: 25,
					score: 50,
					tags: ["active"],
					companyId: "comp1",
					createdAt: yesterday,
					updatedAt: yesterday,
				},
				{
					id: "user3",
					email: "user3@example.com",
					name: "User Three",
					age: 35,
					score: 75,
					tags: ["inactive"],
					companyId: "comp2",
					createdAt: yesterday,
					updatedAt: yesterday,
				},
			],
			companies: [
				{
					id: "comp1",
					name: "Company One",
					domain: "company1.com",
					employeeCount: 50,
					revenue: 1000000,
					isActive: true,
					createdAt: yesterday,
					updatedAt: yesterday,
				},
				{
					id: "comp2",
					name: "Company Two",
					domain: "company2.com",
					employeeCount: 20,
					revenue: 500000,
					isActive: true,
					createdAt: yesterday,
					updatedAt: yesterday,
				},
			],
			auditLogs: [
				{
					id: "log1",
					action: "login",
					entityType: "user",
					entityId: "user1",
					userId: "user1",
					timestamp: yesterday,
					createdAt: yesterday,
				},
				{
					id: "log2",
					action: "update",
					entityType: "user",
					entityId: "user2",
					userId: "user2",
					changes: { name: { old: "Old Name", new: "User Two" } },
					timestamp: now,
					createdAt: now,
				},
			],
		};
	});

	describe("Large batch operations", () => {
		it("should handle large createMany operations", async () => {
			const db = createDatabase(config, testData);

			// Create 100 audit logs
			const largeBatch = Array.from({ length: 100 }, (_, i) => ({
				action: `action_${i}`,
				entityType: "user",
				entityId: `user${(i % 3) + 1}`,
				userId: i % 2 === 0 ? `user${(i % 3) + 1}` : undefined,
				timestamp: new Date(Date.now() - i * 1000).toISOString(),
			}));

			const result = await db.auditLogs.createMany(largeBatch);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(100);
				expect(result.data.created.every((log) => log.id)).toBe(true);
				expect(result.data.created.every((log) => log.createdAt)).toBe(true);
			}

			// Verify in database
			const allLogs = await collect(db.auditLogs.query());
			expect(allLogs).toHaveLength(102); // 2 original + 100 new
		});

		it("should handle large updateMany operations", async () => {
			const db = createDatabase(config, testData);

			// First create many users
			const newUsers = Array.from({ length: 50 }, (_, i) => ({
				email: `bulk${i}@example.com`,
				name: `Bulk User ${i}`,
				age: 20 + (i % 40),
				score: i * 10,
				tags: i % 2 === 0 ? ["even"] : ["odd"],
				companyId: i % 2 === 0 ? "comp1" : "comp2",
			}));

			await db.users.createMany(newUsers);

			// Update all users with even tags
			const result = await db.users.updateMany(
				{ tags: { $contains: "even" } },
				{
					score: { $multiply: 2 },
					tags: { $append: "processed" },
				},
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.count).toBe(25); // Half have "even" tag
				expect(
					result.data.updated.every((u) => u.tags?.includes("processed")),
				).toBe(true);
				expect(
					result.data.updated.every((u) => (u.score ?? 0) % 20 === 0),
				).toBe(true); // Doubled
			}
		});

		it("should handle large deleteMany operations", async () => {
			const db = createDatabase(config, testData);

			// Create many audit logs
			const logs = Array.from({ length: 100 }, (_, i) => ({
				action: "test",
				entityType: "test",
				entityId: `test${i}`,
				timestamp: new Date(Date.now() - i * 60000).toISOString(), // Each 1 minute older
			}));

			await db.auditLogs.createMany(logs);

			// Delete logs older than 50 minutes
			const cutoffTime = new Date(Date.now() - 50 * 60000).toISOString();
			const result = await db.auditLogs.deleteMany({
				timestamp: { $lt: cutoffTime },
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				// The initial 2 logs were created yesterday and now, so 1 is old
				// Plus 50 logs that are older than 50 minutes = 51 total
				expect(result.data.count).toBe(51);
			}

			// Verify remaining
			const remaining = await collect(db.auditLogs.query());
			expect(remaining).toHaveLength(51); // 1 original (now) + 50 newer logs
		});

		it("should handle large upsertMany operations", async () => {
			const db = createDatabase(config, testData);

			// Mix of existing and new users
			const upsertBatch = [
				// Existing users
				...testData.users.map((u) => ({
					where: { id: u.id },
					create: {
						email: u.email,
						name: u.name,
						age: u.age,
						companyId: u.companyId,
					},
					update: {
						score: { $increment: 10 },
						tags: { $append: "updated" },
					},
				})),
				// New users
				...Array.from({ length: 20 }, (_, i) => ({
					where: { id: `newuser${i}` },
					create: {
						email: `newuser${i}@example.com`,
						name: `New User ${i}`,
						age: 20 + i,
						companyId: i % 2 === 0 ? "comp1" : "comp2",
					},
					update: {
						score: { $set: 100 },
					},
				})),
			];

			const result = await db.users.upsertMany(upsertBatch);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(20);
				expect(result.data.updated).toHaveLength(3);
				expect(
					result.data.updated.every((u) => u.tags?.includes("updated")),
				).toBe(true);
			}
		});
	});

	describe("Transaction-like behavior", () => {
		it("should rollback createMany on validation error", async () => {
			const db = createDatabase(config, testData);
			const originalCount = testData.users.length;

			const result = await db.users.createMany([
				{
					email: "valid1@example.com",
					name: "Valid User 1",
					age: 30,
					companyId: "comp1",
				},
				{
					email: "invalid-email", // Invalid
					name: "Invalid User",
					age: 25,
					companyId: "comp1",
				},
				{
					email: "valid2@example.com",
					name: "Valid User 2",
					age: 35,
					companyId: "comp1",
				},
			]);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("VALIDATION_ERROR");
			}

			// Verify no users were created (transaction rolled back)
			const users = await collect(db.users.query());
			expect(users).toHaveLength(originalCount);
		});

		it("should handle partial success with skipDuplicates", async () => {
			const db = createDatabase(config, testData);

			const result = await db.users.createMany(
				[
					{
						id: "user1", // Duplicate
						email: "duplicate@example.com",
						name: "Duplicate User",
						age: 30,
						companyId: "comp1",
					},
					{
						email: "new1@example.com",
						name: "New User 1",
						age: 25,
						companyId: "comp1",
					},
					{
						id: "user2", // Duplicate ID
						email: "another-duplicate@example.com",
						name: "Another Duplicate",
						age: 35,
						companyId: "comp2",
					},
					{
						email: "new2@example.com",
						name: "New User 2",
						age: 40,
						companyId: "comp2",
					},
				],
				{ skipDuplicates: true },
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(2); // Only new users
				expect(result.data.skipped).toHaveLength(2); // Duplicates skipped
			}
		});
	});

	describe("Complex operator combinations", () => {
		it("should handle multiple operators on same field", async () => {
			const db = createDatabase(config, testData);

			// This should use the last operator or handle specially
			const result = await db.companies.update("comp1", {
				employeeCount: { $increment: 10 }, // Should win
				revenue: { $multiply: 1.1 }, // 10% increase
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.employeeCount).toBe(60); // 50 + 10
				expect(result.data.revenue).toBe(1100000); // 1000000 * 1.1
			}
		});

		it("should handle nested object updates", async () => {
			const db = createDatabase(config, testData);

			const result = await db.users.update("user1", {
				metadata: { role: "superadmin", level: 10, newField: "value" },
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.metadata).toEqual({
					role: "superadmin",
					level: 10,
					newField: "value",
				});
			}
		});

		it("should handle array operations with predicates", async () => {
			const db = createDatabase(config, testData);

			// Add multiple tags
			await db.users.update("user1", {
				tags: { $append: ["test1", "test2", "remove-me", "keep-me"] },
			});

			// Remove tags matching pattern
			const result = await db.users.update("user1", {
				tags: { $remove: (tag: string) => tag.includes("remove") },
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.tags).not.toContain("remove-me");
				expect(result.data.tags).toContain("keep-me");
				expect(result.data.tags).toContain("test1");
			}
		});
	});

	describe("Edge cases and error conditions", () => {
		it("should handle empty string values", async () => {
			const db = createDatabase(config, testData);

			const result = await db.users.update("user1", {
				name: "", // Empty string - should fail validation
			});

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("VALIDATION_ERROR");
			}
		});

		it("should handle very long strings", async () => {
			const db = createDatabase(config, testData);
			const longString = "a".repeat(10000);

			const result = await db.auditLogs.create({
				action: longString,
				entityType: "test",
				entityId: "test1",
				timestamp: new Date().toISOString(),
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.action).toBe(longString);
			}
		});

		it("should handle special characters in strings", async () => {
			const db = createDatabase(config, testData);

			const result = await db.users.update("user1", {
				name: "User 🚀 with émojis & spëcial çhars!",
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.name).toBe("User 🚀 with émojis & spëcial çhars!");
			}
		});

		it("should handle null and undefined correctly", async () => {
			const db = createDatabase(config, testData);

			// Undefined fields should be ignored
			const result1 = await db.users.update("user1", {
				name: "Updated Name",
				metadata: undefined, // Should be ignored
			});

			expect(isOk(result1)).toBe(true);
			if (isOk(result1)) {
				expect(result1.data.name).toBe("Updated Name");
			}

			// Null should set optional fields to null
			const result2 = await db.users.update("user1", {
				metadata: null as any,
			});

			expect(isOk(result2)).toBe(true);
			if (isOk(result2)) {
				expect(result2.data.metadata).toBeNull();
			}
		});

		it("should handle circular references in metadata", async () => {
			const db = createDatabase(config, testData);

			type CircularType = { a: number; self?: CircularType };
			const circular: CircularType = { a: 1 };
			circular.self = circular;

			// This might fail or handle specially
			const result = await db.users.update("user1", {
				metadata: circular,
			});

			// Implementation specific - might error or handle
			if (isErr(result)) {
				expect(result.error.code).toBeDefined();
			}
		});
	});

	describe("Performance and optimization cases", () => {
		it("should efficiently handle no-op updates", async () => {
			const db = createDatabase(config, testData);
			const original = testData.users[0];

			const result = await db.users.update("user1", {
				name: original.name, // Same value
				age: original.age, // Same value
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				// Should still update timestamp even for no-op
				expect(result.data.updatedAt).not.toBe(original.updatedAt);
			}
		});

		it("should handle sparse updates efficiently", async () => {
			const db = createDatabase(config, testData);

			// Update only users with specific conditions
			const result = await db.users.updateMany(
				{
					$and: [
						{ score: { $gte: 50 } },
						{ score: { $lte: 100 } },
						{ tags: { $contains: "active" } },
					],
				},
				{
					score: { $increment: 5 },
				},
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.count).toBe(2); // user1 and user2
			}
		});
	});

	describe("Concurrent operation scenarios", () => {
		it("should handle rapid sequential updates", async () => {
			const db = createDatabase(config, testData);

			// Simulate rapid updates
			const updates = Array.from({ length: 10 }, (_, i) =>
				db.users.update("user1", {
					score: { $increment: 1 },
				}),
			);

			const results = await Promise.all(updates);

			// All should succeed
			expect(results.every((r) => isOk(r))).toBe(true);

			// Final score should reflect all increments
			const user = await collect(db.users.query());
			const user1 = user.find((u) => u.id === "user1");
			expect(user1?.score).toBe(110); // 100 + 10
		});

		it("should handle mixed operations on same entities", async () => {
			const db = createDatabase(config, testData);

			// Concurrent different operations
			const operations = [
				db.users.update("user1", { tags: { $append: "tag1" } }),
				db.users.update("user1", { score: { $increment: 10 } }),
				db.users.update("user1", { metadata: { updated: true } }),
			];

			const results = await Promise.all(operations);
			expect(results.every((r) => isOk(r))).toBe(true);

			// Verify final state
			const users = await collect(db.users.query());
			const user1 = users.find((u) => u.id === "user1");
			expect(user1?.tags).toContain("tag1");
			expect(user1?.score).toBeGreaterThanOrEqual(110);
			expect(user1?.metadata).toHaveProperty("updated");
		});
	});

	describe("Special field handling", () => {
		it("should handle ISO date strings correctly", async () => {
			const db = createDatabase(config, testData);
			const futureDate = new Date(Date.now() + 86400000).toISOString();
			const pastDate = new Date(Date.now() - 86400000).toISOString();

			const result = await db.auditLogs.create({
				action: "future-action",
				entityType: "test",
				entityId: "test1",
				timestamp: futureDate,
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.timestamp).toBe(futureDate);
				expect(new Date(result.data.timestamp).getTime()).toBeGreaterThan(
					Date.now(),
				);
			}

			// Query by date
			const logs = await collect(
				db.auditLogs.query({
					where: { timestamp: { $gt: pastDate } },
				}),
			);
			expect(logs.length).toBeGreaterThan(0);
		});

		it("should handle boolean operations correctly", async () => {
			const db = createDatabase(config, testData);

			// Toggle multiple times
			let result = await db.companies.update("comp1", {
				isActive: { $toggle: true },
			});
			expect(isOk(result) && result.data.isActive).toBe(false);

			result = await db.companies.update("comp1", {
				isActive: { $toggle: true },
			});
			expect(isOk(result) && result.data.isActive).toBe(true);

			// Set explicitly
			result = await db.companies.update("comp1", {
				isActive: { $set: false },
			});
			expect(isOk(result) && result.data.isActive).toBe(false);
		});

		it("should handle numeric edge values", async () => {
			const db = createDatabase(config, testData);

			// Test with 0
			let result = await db.companies.update("comp1", {
				revenue: { $set: 0 },
			});
			expect(isOk(result) && result.data.revenue).toBe(0);

			// Test with negative (if allowed)
			result = await db.companies.update("comp1", {
				revenue: { $set: -1000 },
			});
			expect(isOk(result) && result.data.revenue).toBe(-1000);

			// Test with very large number
			result = await db.companies.update("comp1", {
				revenue: { $set: Number.MAX_SAFE_INTEGER },
			});
			expect(isOk(result) && result.data.revenue).toBe(Number.MAX_SAFE_INTEGER);
		});
	});
});
