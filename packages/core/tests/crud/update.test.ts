import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { EffectDatabase } from "../../src/factories/database-effect";
import { createEffectDatabase } from "../../src/factories/database-effect";

// Effect Schemas
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	bio: Schema.optional(Schema.NullOr(Schema.String)),
	tags: Schema.optional(Schema.Array(Schema.String), {
		default: () => [] as ReadonlyArray<string>,
	}),
	score: Schema.optional(Schema.Number, { default: () => 0 }),
	isActive: Schema.optional(Schema.Boolean, { default: () => true }),
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
	deletedAt: Schema.optional(Schema.String),
});

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	employeeCount: Schema.optional(Schema.Number, { default: () => 0 }),
	revenue: Schema.optional(Schema.Number, { default: () => 0 }),
	tags: Schema.optional(Schema.Array(Schema.String), {
		default: () => [] as ReadonlyArray<string>,
	}),
	isPublic: Schema.optional(Schema.Boolean, { default: () => false }),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	price: Schema.Number,
	stock: Schema.Number,
	soldCount: Schema.optional(Schema.Number, { default: () => 0 }),
	tags: Schema.optional(Schema.Array(Schema.String), {
		default: () => [] as ReadonlyArray<string>,
	}),
	features: Schema.optional(Schema.Array(Schema.String), {
		default: () => [] as ReadonlyArray<string>,
	}),
	isAvailable: Schema.optional(Schema.Boolean, { default: () => true }),
	categoryId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const CategorySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

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

describe("CRUD Update Operations (Effect-based)", () => {
	let db: EffectDatabase<typeof config>;
	let now: string;

	beforeEach(async () => {
		now = new Date().toISOString();
		db = await Effect.runPromise(
			createEffectDatabase(config, {
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
			}),
		);
	});

	describe("update method (single entity)", () => {
		describe("basic updates", () => {
			it("should update a single field", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.update("user1", { name: "John Updated" })
					.runPromise;

				expect(result.name).toBe("John Updated");
				expect(result.email).toBe("john@example.com");
				expect(result.age).toBe(30);
				expect(result.updatedAt).not.toBe(now);

				// Verify in database
				const allUsers = await db.users.query().runPromise;
				const updatedUser = allUsers.find(
					(u: Record<string, unknown>) => u.id === "user1",
				);
				expect(updatedUser?.name).toBe("John Updated");
			});

			it("should update multiple fields", async () => {
				const result = await db.users.update("user2", {
					name: "Jane Updated",
					age: 26,
					bio: "Senior designer",
				}).runPromise;

				expect(result.name).toBe("Jane Updated");
				expect(result.age).toBe(26);
				expect(result.bio).toBe("Senior designer");
				expect(result.email).toBe("jane@example.com");
			});

			it("should handle null values to remove optional fields", async () => {
				const result = await db.users.update("user1", { bio: null }).runPromise;

				expect(result.bio).toBeNull();
			});

			it("should auto-update updatedAt timestamp", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.update("user1", { score: 110 })
					.runPromise;

				expect(result.updatedAt).toBeDefined();
				expect(result.updatedAt).not.toBe(now);
				expect(new Date(result.updatedAt!).getTime()).toBeGreaterThan(
					new Date(now).getTime(),
				);
			});

			it("should allow manual updatedAt override", async () => {
				const customTimestamp = "2024-01-01T00:00:00.000Z";

				const result = await db.users.update("user1", {
					score: 110,
					updatedAt: customTimestamp,
				}).runPromise;

				expect(result.updatedAt).toBe(customTimestamp);
			});
		});

		describe("update operators", () => {
			describe("number operators", () => {
				it("should increment number fields", async () => {
					const result = await db.users.update("user1", {
						score: { $increment: 10 },
					}).runPromise;

					expect(result.score).toBe(110);
				});

				it("should decrement number fields", async () => {
					const result = await db.users.update("user2", {
						score: { $decrement: 20 },
					}).runPromise;

					expect(result.score).toBe(30);
				});

				it("should multiply number fields", async () => {
					const result = await db.companies.update("comp1", {
						revenue: { $multiply: 1.5 },
					}).runPromise;

					expect(result.revenue).toBe(1500000);
				});

				it("should set number fields explicitly", async () => {
					const result = await db.products.update("prod1", {
						price: { $set: 1799.99 },
					}).runPromise;

					expect(result.price).toBe(1799.99);
				});
			});

			describe("string operators", () => {
				it("should append to string fields", async () => {
					const result = await db.users.update("user1", {
						name: { $append: " Sr." },
					}).runPromise;

					expect(result.name).toBe("John Doe Sr.");
				});

				it("should prepend to string fields", async () => {
					const result = await db.users.update("user1", {
						name: { $prepend: "Dr. " },
					}).runPromise;

					expect(result.name).toBe("Dr. John Doe");
				});

				it("should set string fields explicitly", async () => {
					const result = await db.users.update("user1", {
						name: { $set: "John Smith" },
					}).runPromise;

					expect(result.name).toBe("John Smith");
				});
			});

			describe("array operators", () => {
				it("should append single item to array", async () => {
					const result = await db.users.update("user1", {
						tags: { $append: "lead" },
					}).runPromise;

					expect(result.tags).toEqual(["developer", "senior", "lead"]);
				});

				it("should append multiple items to array", async () => {
					const result = await db.users.update("user1", {
						tags: { $append: ["lead", "architect"] },
					}).runPromise;

					expect(result.tags).toEqual([
						"developer",
						"senior",
						"lead",
						"architect",
					]);
				});

				it("should prepend items to array", async () => {
					const result = await db.products.update("prod1", {
						features: { $prepend: ["Touchscreen"] },
					}).runPromise;

					expect(result.features).toEqual([
						"Touchscreen",
						"16GB RAM",
						"512GB SSD",
					]);
				});

				it("should remove specific item from array", async () => {
					const result = await db.users.update("user1", {
						tags: { $remove: "senior" },
					}).runPromise;

					expect(result.tags).toEqual(["developer"]);
				});

				it("should remove items by predicate function", async () => {
					const result = await db.companies.update("comp1", {
						tags: { $remove: (tag: string) => tag.includes("start") },
					}).runPromise;

					expect(result.tags).toEqual(["tech"]);
				});

				it("should set array explicitly", async () => {
					const result = await db.users.update("user1", {
						tags: { $set: ["expert", "consultant"] },
					}).runPromise;

					expect(result.tags).toEqual(["expert", "consultant"]);
				});
			});

			describe("boolean operators", () => {
				it("should toggle boolean fields", async () => {
					const result = await db.users.update("user1", {
						isActive: { $toggle: true },
					}).runPromise;

					expect(result.isActive).toBe(false);

					const result2 = await db.users.update("user1", {
						isActive: { $toggle: true },
					}).runPromise;

					expect(result2.isActive).toBe(true);
				});

				it("should set boolean fields explicitly", async () => {
					const result = await db.companies.update("comp1", {
						isPublic: { $set: true },
					}).runPromise;

					expect(result.isPublic).toBe(true);
				});
			});

			describe("multiple operators", () => {
				it("should apply multiple operators in single update", async () => {
					const result = await db.products.update("prod1", {
						stock: { $decrement: 1 },
						soldCount: { $increment: 1 },
						tags: { $append: "bestseller" },
					}).runPromise;

					expect(result.stock).toBe(9);
					expect(result.soldCount).toBe(6);
					expect(result.tags).toContain("bestseller");
				});
			});
		});

		describe("error handling", () => {
			it("should return NotFoundError for non-existent entity", async () => {
				const error = await Effect.runPromise(
					db.users
						.update("non-existent", { name: "Updated" })
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("NotFoundError");
				if (error._tag === "NotFoundError") {
					expect(error.collection).toBe("users");
					expect(error.id).toBe("non-existent");
				}
			});

			it("should not allow updating immutable fields", async () => {
				const error = await Effect.runPromise(
					db.users
						.update("user1", { id: "new-id" } as Record<string, unknown>)
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ValidationError");

				const error2 = await Effect.runPromise(
					db.users
						.update("user1", {
							createdAt: "2024-01-01T00:00:00.000Z",
						} as Record<string, unknown>)
						.pipe(Effect.flip),
				);

				expect(error2._tag).toBe("ValidationError");
			});

			it("should validate foreign key constraints", async () => {
				const error = await Effect.runPromise(
					db.users
						.update("user1", { companyId: "non-existent-company" })
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});
		});

		describe("relationship updates", () => {
			it("should update relationship field with valid foreign key", async () => {
				const result = await db.users.update("user1", { companyId: "comp2" })
					.runPromise;

				expect(result.companyId).toBe("comp2");

				const allUsers = await db.users.query().runPromise;
				const updatedUser = allUsers.find(
					(u: Record<string, unknown>) => u.id === "user1",
				);
				expect(updatedUser?.companyId).toBe("comp2");
			});

			it("should validate new foreign key exists", async () => {
				const error = await Effect.runPromise(
					db.products
						.update("prod1", { categoryId: "cat-invalid" })
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});
		});
	});

	describe("updateMany method (batch update)", () => {
		describe("basic batch updates", () => {
			it("should update all matching entities", async () => {
				const result = await db.users.updateMany(
					(u) => u.companyId === "comp1",
					{ bio: "TechCorp employee" },
				).runPromise;

				expect(result.count).toBe(2);
				expect(result.updated).toHaveLength(2);
				expect(result.updated.every((u) => u.bio === "TechCorp employee")).toBe(
					true,
				);
			});

			it("should handle empty matches", async () => {
				const result = await db.users.updateMany((u) => u.age > 100, {
					score: 0,
				}).runPromise;

				expect(result.count).toBe(0);
				expect(result.updated).toHaveLength(0);
			});

			it("should update all entities when predicate always true", async () => {
				const result = await db.companies.updateMany(() => true, {
					tags: { $append: "2024" },
				}).runPromise;

				expect(result.count).toBe(2);
				expect(result.updated.every((c) => c.tags?.includes("2024"))).toBe(
					true,
				);
			});
		});

		describe("batch updates with operators", () => {
			it("should increment/decrement in batch", async () => {
				const result = await db.products.updateMany(
					(p) => p.categoryId === "cat1",
					{
						stock: { $decrement: 1 },
						soldCount: { $increment: 1 },
					},
				).runPromise;

				expect(result.count).toBe(1);
				expect(result.updated[0].stock).toBe(9);
				expect(result.updated[0].soldCount).toBe(6);
			});

			it("should apply multiple operators across entities", async () => {
				const result = await db.companies.updateMany(() => true, {
					employeeCount: { $multiply: 1.1 },
					revenue: { $multiply: 1.2 },
					isPublic: { $set: true },
				}).runPromise;

				expect(result.count).toBe(2);
				expect(result.updated[0].employeeCount).toBeCloseTo(110, 10);
				expect(result.updated[0].revenue).toBeCloseTo(1200000, 10);
				expect(result.updated.every((c) => c.isPublic)).toBe(true);
			});

			it("should handle array operations in batch", async () => {
				const result = await db.users.updateMany(
					(u) => u.tags?.includes("senior") ?? false,
					{
						tags: { $append: "experienced" },
						score: { $increment: 25 },
					},
				).runPromise;

				expect(result.count).toBe(2);
				expect(
					result.updated.every((u) => u.tags?.includes("experienced")),
				).toBe(true);
				expect(result.updated.find((u) => u.id === "user1")?.score).toBe(125);
				expect(result.updated.find((u) => u.id === "user3")?.score).toBe(100);
			});
		});

		describe("batch update error handling", () => {
			it("should validate all entities before updating", async () => {
				const error = await Effect.runPromise(
					db.users
						.updateMany(() => true, {
							age: "not-a-number" as unknown as number,
						})
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ValidationError");
			});

			it("should validate foreign keys in batch updates", async () => {
				const error = await Effect.runPromise(
					db.products
						.updateMany((p) => p.categoryId === "cat2", {
							categoryId: "invalid-category",
						})
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});
		});

		describe("batch update special cases", () => {
			it("should update entities matching OR-like conditions", async () => {
				const result = await db.users.updateMany(
					(u) => u.age < 26 || !u.isActive,
					{ tags: { $append: "special" } },
				).runPromise;

				expect(result.count).toBe(2);
				expect(result.updated.map((u) => u.id).sort()).toEqual([
					"user2",
					"user3",
				]);
			});

			it("should maintain updatedAt consistency in batch", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.updateMany(() => true, {
					score: { $set: 0 },
				}).runPromise;

				expect(result.count).toBe(3);
				for (const user of result.updated) {
					expect(user.updatedAt).toBeDefined();
					expect(user.updatedAt).not.toBe(now);
				}
			});
		});
	});
});
