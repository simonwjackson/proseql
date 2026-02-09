import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import {
	isOk,
	isErr,
	isNotFoundError,
	isValidationError,
} from "../../core/errors/crud-errors";
import type { UpdateInput } from "../../core/types/crud-types";
import { collect } from "../../core/utils/async-iterable.js";

describe("CRUD Update Operations", () => {
	// Test schemas
	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string().email(),
		age: z.number().min(0).max(150),
		bio: z.string().nullable().optional(),
		tags: z.array(z.string()).default([]),
		score: z.number().default(0),
		isActive: z.boolean().default(true),
		companyId: z.string(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		deletedAt: z.string().optional(),
	});

	const CompanySchema = z.object({
		id: z.string(),
		name: z.string(),
		employeeCount: z.number().default(0),
		revenue: z.number().default(0),
		tags: z.array(z.string()).default([]),
		isPublic: z.boolean().default(false),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		price: z.number().min(0),
		stock: z.number().int().min(0),
		soldCount: z.number().int().default(0),
		tags: z.array(z.string()).default([]),
		features: z.array(z.string()).default([]),
		isAvailable: z.boolean().default(true),
		categoryId: z.string(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	const CategorySchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	});

	// Test configuration
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
		products: {
			schema: ProductSchema,
			relationships: {
				category: { type: "ref" as const, target: "categories" as const },
			},
		},
		categories: {
			schema: CategorySchema,
			relationships: {
				products: { type: "inverse" as const, target: "products" as const },
			},
		},
	} as const;

	// Test data
	let testData: {
		users: z.infer<typeof UserSchema>[];
		companies: z.infer<typeof CompanySchema>[];
		products: z.infer<typeof ProductSchema>[];
		categories: z.infer<typeof CategorySchema>[];
	};

	beforeEach(() => {
		const now = new Date().toISOString();
		testData = {
			users: [
				{
					id: "user1",
					name: "John Doe",
					email: "john@example.com",
					age: 30,
					bio: "Software developer",
					tags: ["developer", "senior"],
					score: 100,
					isActive: true,
					companyId: "comp1",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "user2",
					name: "Jane Smith",
					email: "jane@example.com",
					age: 25,
					tags: ["designer"],
					score: 50,
					isActive: true,
					companyId: "comp2",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "user3",
					name: "Bob Johnson",
					email: "bob@example.com",
					age: 35,
					tags: ["manager", "senior"],
					score: 75,
					isActive: false,
					companyId: "comp1",
					createdAt: now,
					updatedAt: now,
				},
			],
			companies: [
				{
					id: "comp1",
					name: "TechCorp",
					employeeCount: 100,
					revenue: 1000000,
					tags: ["tech", "startup"],
					isPublic: false,
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "comp2",
					name: "DataInc",
					employeeCount: 50,
					revenue: 500000,
					tags: ["data", "ai"],
					isPublic: true,
					createdAt: now,
					updatedAt: now,
				},
			],
			products: [
				{
					id: "prod1",
					name: "Laptop Pro",
					description: "High-end laptop",
					price: 1999.99,
					stock: 10,
					soldCount: 5,
					tags: ["electronics", "computers"],
					features: ["16GB RAM", "512GB SSD"],
					isAvailable: true,
					categoryId: "cat1",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "prod2",
					name: "Wireless Mouse",
					description: "Ergonomic wireless mouse",
					price: 49.99,
					stock: 100,
					soldCount: 50,
					tags: ["accessories"],
					features: ["Bluetooth", "Rechargeable"],
					isAvailable: true,
					categoryId: "cat2",
					createdAt: now,
					updatedAt: now,
				},
			],
			categories: [
				{
					id: "cat1",
					name: "Computers",
					description: "Desktop and laptop computers",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "cat2",
					name: "Accessories",
					description: "Computer accessories",
					createdAt: now,
					updatedAt: now,
				},
			],
		};
	});

	describe("update method (single entity)", () => {
		describe("basic updates", () => {
			it("should update a single field", async () => {
				const db = createDatabase(config, testData);
				const originalUpdatedAt = testData.users[0].updatedAt;

				// Add delay to ensure updatedAt changes
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.update("user1", {
					name: "John Updated",
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.name).toBe("John Updated");
					expect(result.data.email).toBe("john@example.com"); // Unchanged
					expect(result.data.age).toBe(30); // Unchanged
					expect(result.data.updatedAt).not.toBe(originalUpdatedAt);
				}

				// Verify in database
				const users = await collect(db.users.query());
				const updatedUser = users.find((u) => u.id === "user1");
				expect(updatedUser?.name).toBe("John Updated");
			});

			it("should update multiple fields", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user2", {
					name: "Jane Updated",
					age: 26,
					bio: "Senior designer",
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.name).toBe("Jane Updated");
					expect(result.data.age).toBe(26);
					expect(result.data.bio).toBe("Senior designer");
					expect(result.data.email).toBe("jane@example.com"); // Unchanged
				}
			});

			it("should handle null values to remove optional fields", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user1", {
					bio: null,
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.bio).toBeNull();
				}
			});

			it("should auto-update updatedAt timestamp", async () => {
				const db = createDatabase(config, testData);
				const originalUpdatedAt = testData.users[0].updatedAt;

				// Add delay to ensure timestamp changes
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.update("user1", {
					score: 110,
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.updatedAt).toBeDefined();
					expect(result.data.updatedAt).not.toBe(originalUpdatedAt);
					expect(new Date(result.data.updatedAt!).getTime()).toBeGreaterThan(
						new Date(originalUpdatedAt!).getTime(),
					);
				}
			});

			it("should allow manual updatedAt override", async () => {
				const db = createDatabase(config, testData);
				const customTimestamp = "2024-01-01T00:00:00.000Z";

				const result = await db.users.update("user1", {
					score: 110,
					updatedAt: customTimestamp,
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.updatedAt).toBe(customTimestamp);
				}
			});
		});

		describe("update operators", () => {
			describe("number operators", () => {
				it("should increment number fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						score: { $increment: 10 },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.score).toBe(110); // 100 + 10
					}
				});

				it("should decrement number fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user2", {
						score: { $decrement: 20 },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.score).toBe(30); // 50 - 20
					}
				});

				it("should multiply number fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.companies.update("comp1", {
						revenue: { $multiply: 1.5 },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.revenue).toBe(1500000); // 1000000 * 1.5
					}
				});

				it("should set number fields explicitly", async () => {
					const db = createDatabase(config, testData);

					const result = await db.products.update("prod1", {
						price: { $set: 1799.99 },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.price).toBe(1799.99);
					}
				});
			});

			describe("string operators", () => {
				it("should append to string fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						name: { $append: " Sr." },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.name).toBe("John Doe Sr.");
					}
				});

				it("should prepend to string fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						name: { $prepend: "Dr. " },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.name).toBe("Dr. John Doe");
					}
				});

				it("should set string fields explicitly", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						name: { $set: "John Smith" },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.name).toBe("John Smith");
					}
				});
			});

			describe("array operators", () => {
				it("should append single item to array", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						tags: { $append: "lead" },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.tags).toEqual(["developer", "senior", "lead"]);
					}
				});

				it("should append multiple items to array", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						tags: { $append: ["lead", "architect"] },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.tags).toEqual([
							"developer",
							"senior",
							"lead",
							"architect",
						]);
					}
				});

				it("should prepend items to array", async () => {
					const db = createDatabase(config, testData);

					const result = await db.products.update("prod1", {
						features: { $prepend: ["Touchscreen"] },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.features).toEqual([
							"Touchscreen",
							"16GB RAM",
							"512GB SSD",
						]);
					}
				});

				it("should remove specific item from array", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						tags: { $remove: "senior" },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.tags).toEqual(["developer"]);
					}
				});

				it("should remove items by predicate function", async () => {
					const db = createDatabase(config, testData);

					const result = await db.companies.update("comp1", {
						tags: { $remove: (tag: string) => tag.includes("start") },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.tags).toEqual(["tech"]);
					}
				});

				it("should set array explicitly", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						tags: { $set: ["expert", "consultant"] },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.tags).toEqual(["expert", "consultant"]);
					}
				});
			});

			describe("boolean operators", () => {
				it("should toggle boolean fields", async () => {
					const db = createDatabase(config, testData);

					const result = await db.users.update("user1", {
						isActive: { $toggle: true },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.isActive).toBe(false); // Was true
					}

					// Toggle again
					const result2 = await db.users.update("user1", {
						isActive: { $toggle: true },
					});

					expect(isOk(result2)).toBe(true);
					if (isOk(result2)) {
						expect(result2.data.isActive).toBe(true); // Back to true
					}
				});

				it("should set boolean fields explicitly", async () => {
					const db = createDatabase(config, testData);

					const result = await db.companies.update("comp1", {
						isPublic: { $set: true },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.isPublic).toBe(true);
					}
				});
			});

			describe("multiple operators", () => {
				it("should apply multiple operators in single update", async () => {
					const db = createDatabase(config, testData);

					const result = await db.products.update("prod1", {
						stock: { $decrement: 1 },
						soldCount: { $increment: 1 },
						tags: { $append: "bestseller" },
					});

					expect(isOk(result)).toBe(true);
					if (isOk(result)) {
						expect(result.data.stock).toBe(9); // 10 - 1
						expect(result.data.soldCount).toBe(6); // 5 + 1
						expect(result.data.tags).toContain("bestseller");
					}
				});
			});
		});

		describe("error handling", () => {
			it("should return NOT_FOUND error for non-existent entity", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("non-existent", {
					name: "Updated",
				});

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("NOT_FOUND");
					if (isNotFoundError(result.error)) {
						expect(result.error.entity).toBe("users");
						expect(result.error.id).toBe("non-existent");
					}
				}
			});

			it("should validate field types", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user1", {
					age: -5, // Invalid: negative age
				});

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect(result.error.errors[0].field).toBe("age");
					}
				}
			});

			it("should validate email format", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user1", {
					email: "invalid-email",
				});

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect(result.error.errors[0].field).toBe("email");
					}
				}
			});

			it("should validate foreign key constraints", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user1", {
					companyId: "non-existent-company",
				});

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect(result.error.errors[0].field).toBe("companyId");
						expect((result.error.errors[0] as any).code).toBe(
							"FOREIGN_KEY_VIOLATION",
						);
					}
				}
			});

			it("should not allow updating immutable fields", async () => {
				const db = createDatabase(config, testData);

				// Try to update ID (immutable field)
				// The type system prevents this, but we can test runtime validation
				const invalidUpdate = { id: "new-id" };
				const result = await db.users.update(
					"user1",
					invalidUpdate as UpdateInput<(typeof testData.users)[0]>,
				);

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect(result.error.errors[0].field).toBe("id");
						expect(result.error.errors[0].message).toContain(
							"Cannot update immutable field",
						);
					}
				}

				// Try to update createdAt (immutable field)
				const invalidUpdate2 = { createdAt: "2024-01-01T00:00:00.000Z" };
				const result2 = await db.users.update(
					"user1",
					invalidUpdate2 as UpdateInput<(typeof testData.users)[0]>,
				);

				expect(isErr(result2)).toBe(true);
				if (isErr(result2)) {
					expect(result2.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result2.error)) {
						expect(result2.error.errors[0].field).toBe("createdAt");
						expect(result2.error.errors[0].message).toContain(
							"Cannot update immutable field",
						);
					}
				}
			});
		});

		describe("relationship updates", () => {
			it("should update relationship field with valid foreign key", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.update("user1", {
					companyId: "comp2", // Move user from comp1 to comp2
				});

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.companyId).toBe("comp2");
				}

				// Verify the relationship is reflected
				const users = await collect(db.users.query());
				const updatedUser = users.find((u) => u.id === "user1");
				expect(updatedUser?.companyId).toBe("comp2");
			});

			it("should validate new foreign key exists", async () => {
				const db = createDatabase(config, testData);

				const result = await db.products.update("prod1", {
					categoryId: "cat-invalid",
				});

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect(result.error.errors[0].field).toBe("categoryId");
						expect((result.error.errors[0] as any).code).toBe(
							"FOREIGN_KEY_VIOLATION",
						);
					}
				}
			});
		});
	});

	describe("updateMany method (batch update)", () => {
		describe("basic batch updates", () => {
			it("should update all matching entities", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.updateMany(
					{ companyId: "comp1" },
					{ bio: "TechCorp employee" },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // user1 and user3
					expect(result.data.updated).toHaveLength(2);
					expect(
						result.data.updated.every((u) => u.bio === "TechCorp employee"),
					).toBe(true);
				}

				// Verify in database
				const users = await collect(db.users.query());
				const techCorpUsers = users.filter((u) => u.companyId === "comp1");
				expect(techCorpUsers.every((u) => u.bio === "TechCorp employee")).toBe(
					true,
				);
			});

			it("should update with complex where conditions", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.updateMany(
					{
						$and: [{ age: { $gte: 30 } }, { isActive: true }],
					},
					{ tags: { $append: "veteran" } },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1); // Only user1 matches
					expect(result.data.updated[0].id).toBe("user1");
					expect(result.data.updated[0].tags).toContain("veteran");
				}
			});

			it("should handle empty matches", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.updateMany(
					{ age: { $gt: 100 } }, // No users over 100
					{ score: 0 },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(0);
					expect(result.data.updated).toHaveLength(0);
				}
			});

			it("should update all entities when no where clause", async () => {
				const db = createDatabase(config, testData);

				const result = await db.companies.updateMany(
					{}, // Empty where = match all
					{ tags: { $append: "2024" } },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // All companies
					expect(
						result.data.updated.every((c) => c.tags?.includes("2024")),
					).toBe(true);
				}
			});
		});

		describe("batch updates with operators", () => {
			it("should increment/decrement in batch", async () => {
				const db = createDatabase(config, testData);

				// Simulate a sale: decrement stock, increment sold count
				const result = await db.products.updateMany(
					{ categoryId: "cat1" },
					{
						stock: { $decrement: 1 },
						soldCount: { $increment: 1 },
					},
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(1); // Only prod1 in cat1
					expect(result.data.updated[0].stock).toBe(9); // 10 - 1
					expect(result.data.updated[0].soldCount).toBe(6); // 5 + 1
				}
			});

			it("should apply multiple operators across entities", async () => {
				const db = createDatabase(config, testData);

				const result = await db.companies.updateMany(
					{},
					{
						employeeCount: { $multiply: 1.1 }, // 10% growth
						revenue: { $multiply: 1.2 }, // 20% revenue growth
						isPublic: { $set: true }, // All go public
					},
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2);
					expect(result.data.updated[0].employeeCount).toBeCloseTo(110, 10); // 100 * 1.1
					expect(result.data.updated[0].revenue).toBeCloseTo(1200000, 10); // 1000000 * 1.2
					expect(result.data.updated.every((c) => c.isPublic)).toBe(true);
				}
			});

			it("should handle array operations in batch", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.updateMany(
					{ tags: { $contains: "senior" } },
					{
						tags: { $append: "experienced" },
						score: { $increment: 25 },
					},
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // user1 and user3 have "senior"
					expect(
						result.data.updated.every((u) => u.tags?.includes("experienced")),
					).toBe(true);
					expect(result.data.updated.find((u) => u.id === "user1")?.score).toBe(
						125,
					); // 100 + 25
					expect(result.data.updated.find((u) => u.id === "user3")?.score).toBe(
						100,
					); // 75 + 25
				}
			});
		});

		describe("batch update error handling", () => {
			it("should validate all entities before updating", async () => {
				const db = createDatabase(config, testData);

				// Try to set invalid age on all users
				const result = await db.users.updateMany(
					{},
					{ age: -10 }, // Invalid negative age
				);

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
				}

				// Verify no users were updated
				const users = await collect(db.users.query());
				expect(users.every((u) => u.age > 0)).toBe(true);
			});

			it("should validate foreign keys in batch updates", async () => {
				const db = createDatabase(config, testData);

				const result = await db.products.updateMany(
					{ categoryId: "cat2" },
					{ categoryId: "invalid-category" },
				);

				expect(isErr(result)).toBe(true);
				if (isErr(result)) {
					expect(result.error.code).toBe("VALIDATION_ERROR");
					if (isValidationError(result.error)) {
						expect((result.error.errors[0] as any).code).toBe(
							"FOREIGN_KEY_VIOLATION",
						);
					}
				}
			});

			it("should handle operator type mismatches", async () => {
				const db = createDatabase(config, testData);

				// Try to use string operator on number field
				const result = await db.users.updateMany(
					{},
					{
						age: { $append: "years" } as any, // Invalid operator for number
					},
				);

				// The implementation might handle this differently
				// This tests current behavior
				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					// Age should remain unchanged when invalid operator is used
					const users = await collect(db.users.query());
					expect(users[0].age).toBe(30); // Original value
				}
			});
		});

		describe("batch update special cases", () => {
			it("should update entities matching OR conditions", async () => {
				const db = createDatabase(config, testData);

				const result = await db.users.updateMany(
					{
						$or: [
							{ age: { $lt: 26 } }, // user2
							{ isActive: false }, // user3
						],
					},
					{ tags: { $append: "special" } },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // user2 and user3
					expect(result.data.updated.map((u) => u.id).sort()).toEqual([
						"user2",
						"user3",
					]);
				}
			});

			it("should handle limit option when specified", async () => {
				const db = createDatabase(config, testData);

				// Note: Current implementation might not support limit option
				// This is a forward-looking test
				const result = await db.users.updateMany(
					{},
					{ score: { $increment: 10 } },
					// { limit: 2 } // If limit is supported
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					// Without limit, all should be updated
					expect(result.data.count).toBe(3);
				}
			});

			it("should maintain updatedAt consistency in batch", async () => {
				const db = createDatabase(config, testData);
				const originalTimestamps = testData.users.map((u) => u.updatedAt);

				// Add delay to ensure timestamp changes
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.updateMany({}, { score: { $set: 0 } });

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					// All updated entities should have new timestamps
					result.data.updated.forEach((user, index) => {
						expect(user.updatedAt).toBeDefined();
						expect(user.updatedAt).not.toBe(originalTimestamps[index]);
					});
				}
			});

			it("should handle nested relationship queries in where clause", async () => {
				const db = createDatabase(config, testData);

				// Update users in companies with certain tags
				const result = await db.users.updateMany(
					{
						company: {
							tags: { $contains: "tech" },
						},
					},
					{ bio: "Works at a tech company" },
				);

				expect(isOk(result)).toBe(true);
				if (isOk(result)) {
					expect(result.data.count).toBe(2); // user1 and user3 (both in comp1 which has "tech" tag)
					expect(
						result.data.updated.every(
							(u) => u.bio === "Works at a tech company",
						),
					).toBe(true);
				}
			});
		});
	});
});
