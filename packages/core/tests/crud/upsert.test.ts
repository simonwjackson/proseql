import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import type { GenerateDatabase } from "../../src/types/types";

// Effect Schemas
const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	username: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	loginCount: Schema.optional(Schema.Number, { default: () => 0 }),
	lastLoginAt: Schema.optional(Schema.String),
	bio: Schema.optional(Schema.String),
	tags: Schema.optional(Schema.Array(Schema.String), {
		default: () => [] as ReadonlyArray<string>,
	}),
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const ProductSchema = Schema.Struct({
	id: Schema.String,
	sku: Schema.String,
	name: Schema.String,
	description: Schema.String,
	price: Schema.Number,
	stock: Schema.Number,
	lastRestocked: Schema.optional(Schema.String),
	categoryId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const SettingSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	settingKey: Schema.String,
	value: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	domain: Schema.String,
	employeeCount: Schema.optional(Schema.Number, { default: () => 0 }),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const CategorySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	description: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const config = {
	users: {
		schema: UserSchema,
		uniqueFields: ["email", "username"] as const,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
			settings: {
				type: "inverse" as const,
				target: "settings" as const,
				foreignKey: "userId",
			},
		},
	},
	products: {
		schema: ProductSchema,
		uniqueFields: ["sku"] as const,
		relationships: {
			category: { type: "ref" as const, target: "categories" as const },
		},
	},
	settings: {
		schema: SettingSchema,
		uniqueFields: [["userId", "settingKey"]] as const,
		relationships: {
			user: { type: "ref" as const, target: "users" as const },
		},
	},
	companies: {
		schema: CompanySchema,
		uniqueFields: ["domain"] as const,
		relationships: {
			users: {
				type: "inverse" as const,
				target: "users" as const,
				foreignKey: "companyId",
			},
		},
	},
	categories: {
		schema: CategorySchema,
		uniqueFields: ["slug"] as const,
		relationships: {
			products: {
				type: "inverse" as const,
				target: "products" as const,
				foreignKey: "categoryId",
			},
		},
	},
} as const;

describe("CRUD Upsert Operations (Effect-based)", () => {
	let db: GenerateDatabase<typeof config>;
	let now: string;

	beforeEach(async () => {
		now = new Date().toISOString();
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [
					{
						id: "user1",
						email: "john@example.com",
						username: "johndoe",
						name: "John Doe",
						age: 30,
						loginCount: 5,
						lastLoginAt: yesterday,
						bio: "Software developer",
						tags: ["developer"],
						companyId: "comp1",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "user2",
						email: "jane@example.com",
						username: "janesmith",
						name: "Jane Smith",
						age: 25,
						loginCount: 3,
						tags: ["designer"],
						companyId: "comp2",
						createdAt: now,
						updatedAt: now,
					},
				],
				products: [
					{
						id: "prod1",
						sku: "LAPTOP-001",
						name: "Laptop Pro",
						description: "High-end laptop",
						price: 1999.99,
						stock: 10,
						lastRestocked: yesterday,
						categoryId: "cat1",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "prod2",
						sku: "MOUSE-001",
						name: "Wireless Mouse",
						description: "Ergonomic mouse",
						price: 49.99,
						stock: 100,
						categoryId: "cat2",
						createdAt: now,
						updatedAt: now,
					},
				],
				settings: [
					{
						id: "set1",
						userId: "user1",
						settingKey: "theme",
						value: "dark",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "set2",
						userId: "user1",
						settingKey: "language",
						value: "en",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "set3",
						userId: "user2",
						settingKey: "theme",
						value: "light",
						createdAt: now,
						updatedAt: now,
					},
				],
				companies: [
					{
						id: "comp1",
						name: "TechCorp",
						domain: "techcorp.com",
						employeeCount: 100,
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "comp2",
						name: "DataInc",
						domain: "datainc.io",
						employeeCount: 50,
						createdAt: now,
						updatedAt: now,
					},
				],
				categories: [
					{
						id: "cat1",
						name: "Computers",
						slug: "computers",
						description: "Computer products",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "cat2",
						name: "Accessories",
						slug: "accessories",
						description: "Computer accessories",
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
	});

	describe("upsert method (single entity)", () => {
		describe("upsert by ID", () => {
			it("should create new entity when ID not found", async () => {
				const result = await db.users.upsert({
					where: { id: "user3" },
					create: {
						email: "bob@example.com",
						username: "bobsmith",
						name: "Bob Smith",
						age: 35,
						companyId: "comp1",
						loginCount: 0,
					},
					update: {
						loginCount: { $increment: 1 },
						lastLoginAt: new Date().toISOString(),
					},
				}).runPromise;

				expect(result.__action).toBe("created");
				expect(result.id).toBe("user3");
				expect(result.name).toBe("Bob Smith");
				expect(result.loginCount).toBe(0);

				const users = await db.users.query().runPromise;
				expect(users).toHaveLength(3);
			});

			it("should update existing entity when ID found", async () => {
				const loginTime = new Date().toISOString();

				const result = await db.users.upsert({
					where: { id: "user1" },
					create: {
						email: "new@example.com",
						username: "newuser",
						name: "New User",
						age: 40,
						companyId: "comp1",
					},
					update: { loginCount: { $increment: 1 }, lastLoginAt: loginTime },
				}).runPromise;

				expect(result.__action).toBe("updated");
				expect(result.id).toBe("user1");
				expect(result.name).toBe("John Doe");
				expect(result.loginCount).toBe(6);
				expect(result.lastLoginAt).toBe(loginTime);
			});
		});

		describe("upsert by unique field", () => {
			it("should create by unique email when not found", async () => {
				const result = await db.users.upsert({
					where: { email: "newuser@example.com" },
					create: {
						email: "newuser@example.com",
						username: "newuser",
						name: "New User",
						age: 28,
						companyId: "comp2",
					},
					update: { loginCount: { $increment: 1 } },
				}).runPromise;

				expect(result.__action).toBe("created");
				expect(result.email).toBe("newuser@example.com");
			});

			it("should update by unique email when found", async () => {
				const result = await db.users.upsert({
					where: { email: "john@example.com" },
					create: {
						email: "john@example.com",
						username: "johnnew",
						name: "John New",
						age: 31,
						companyId: "comp1",
					},
					update: {
						age: 31,
						bio: "Senior developer",
						tags: { $append: "senior" },
					},
				}).runPromise;

				expect(result.__action).toBe("updated");
				expect(result.id).toBe("user1");
				expect(result.age).toBe(31);
				expect(result.bio).toBe("Senior developer");
				expect(result.tags).toContain("senior");
			});

			it("should upsert by SKU for products", async () => {
				const result1 = await db.products.upsert({
					where: { sku: "LAPTOP-001" },
					create: {
						sku: "LAPTOP-001",
						name: "New Laptop",
						description: "Brand new",
						price: 2499.99,
						stock: 5,
						categoryId: "cat1",
					},
					update: {
						price: 1799.99,
						stock: { $increment: 5 },
						lastRestocked: new Date().toISOString(),
					},
				}).runPromise;

				expect(result1.__action).toBe("updated");
				expect(result1.price).toBe(1799.99);
				expect(result1.stock).toBe(15);

				const result2 = await db.products.upsert({
					where: { sku: "LAPTOP-002" },
					create: {
						sku: "LAPTOP-002",
						name: "Laptop Air",
						description: "Lightweight",
						price: 1299.99,
						stock: 20,
						categoryId: "cat1",
					},
					update: { price: 1199.99 },
				}).runPromise;

				expect(result2.__action).toBe("created");
				expect(result2.price).toBe(1299.99);
			});
		});

		describe("upsert with validation", () => {
			it("should validate foreign keys in create", async () => {
				const error = await Effect.runPromise(
					db.users
						.upsert({
							where: { email: "newuser@example.com" },
							create: {
								email: "newuser@example.com",
								username: "newuser",
								name: "New User",
								age: 30,
								companyId: "invalid-company",
							},
							update: { loginCount: { $increment: 1 } },
						})
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});

			it("should validate foreign keys in update", async () => {
				const error = await Effect.runPromise(
					db.products
						.upsert({
							where: { id: "prod1" },
							create: {
								sku: "NEW-001",
								name: "New Product",
								description: "New",
								price: 99.99,
								stock: 10,
								categoryId: "cat1",
							},
							update: { categoryId: "invalid-category" },
						})
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});
		});

		describe("upsert edge cases", () => {
			it("should handle create and update with different shapes", async () => {
				const result = await db.categories.upsert({
					where: { slug: "new-category" },
					create: {
						name: "New Category",
						slug: "new-category",
						description: "A brand new category",
					},
					update: { description: "Updated description" },
				}).runPromise;

				expect(result.__action).toBe("created");
				expect(result.description).toBe("A brand new category");
			});

			it("should preserve timestamps correctly", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));

				const result = await db.users.upsert({
					where: { id: "user1" },
					create: {
						email: "new@example.com",
						username: "newuser",
						name: "New User",
						age: 30,
						companyId: "comp1",
					},
					update: { bio: "Updated bio" },
				}).runPromise;

				expect(result.__action).toBe("updated");
				expect(result.createdAt).toBe(now);
				expect(result.updatedAt).not.toBe(now);
			});
		});
	});

	describe("upsertMany method (batch upsert)", () => {
		describe("basic batch upsert", () => {
			it("should handle mixed create and update operations", async () => {
				const result = await db.products.upsertMany([
					{
						where: { sku: "LAPTOP-001" },
						create: {
							sku: "LAPTOP-001",
							name: "Laptop Pro",
							description: "High-end",
							price: 2499.99,
							stock: 0,
							categoryId: "cat1",
						},
						update: { price: 1899.99, stock: { $increment: 10 } },
					},
					{
						where: { sku: "TABLET-001" },
						create: {
							sku: "TABLET-001",
							name: "Tablet Pro",
							description: "Professional tablet",
							price: 999.99,
							stock: 15,
							categoryId: "cat1",
						},
						update: { price: 899.99 },
					},
					{
						where: { sku: "MOUSE-001" },
						create: {
							sku: "MOUSE-001",
							name: "Basic Mouse",
							description: "Basic",
							price: 29.99,
							stock: 0,
							categoryId: "cat2",
						},
						update: { stock: { $decrement: 5 } },
					},
				]).runPromise;

				expect(result.created).toHaveLength(1);
				expect(result.updated).toHaveLength(2);

				const laptop = result.updated.find((p) => p.sku === "LAPTOP-001");
				expect(laptop?.price).toBe(1899.99);
				expect(laptop?.stock).toBe(20);

				expect(result.created[0].sku).toBe("TABLET-001");
				expect(result.created[0].price).toBe(999.99);

				const mouse = result.updated.find((p) => p.sku === "MOUSE-001");
				expect(mouse?.stock).toBe(95);
			});

			it("should handle all creates", async () => {
				const result = await db.categories.upsertMany([
					{
						where: { slug: "electronics" },
						create: {
							name: "Electronics",
							slug: "electronics",
							description: "Electronic devices",
						},
						update: { description: "Updated" },
					},
					{
						where: { slug: "software" },
						create: {
							name: "Software",
							slug: "software",
							description: "Software products",
						},
						update: { description: "Updated" },
					},
				]).runPromise;

				expect(result.created).toHaveLength(2);
				expect(result.updated).toHaveLength(0);

				const categories = await db.categories.query().runPromise;
				expect(categories).toHaveLength(4);
			});

			it("should handle all updates", async () => {
				const loginTime = new Date().toISOString();

				const result = await db.users.upsertMany([
					{
						where: { email: "john@example.com" },
						create: {
							email: "john@example.com",
							username: "john",
							name: "John",
							age: 30,
							companyId: "comp1",
						},
						update: { loginCount: { $increment: 1 }, lastLoginAt: loginTime },
					},
					{
						where: { email: "jane@example.com" },
						create: {
							email: "jane@example.com",
							username: "jane",
							name: "Jane",
							age: 25,
							companyId: "comp2",
						},
						update: { loginCount: { $increment: 1 }, lastLoginAt: loginTime },
					},
				]).runPromise;

				expect(result.created).toHaveLength(0);
				expect(result.updated).toHaveLength(2);
				expect(result.updated[0].loginCount).toBe(6);
				expect(result.updated[1].loginCount).toBe(4);
			});

			it("should detect unchanged entities", async () => {
				const result = await db.companies.upsertMany([
					{
						where: { domain: "techcorp.com" },
						create: {
							name: "TechCorp",
							domain: "techcorp.com",
							employeeCount: 100,
						},
						update: { employeeCount: 100 },
					},
					{
						where: { domain: "datainc.io" },
						create: {
							name: "DataInc",
							domain: "datainc.io",
							employeeCount: 50,
						},
						update: { employeeCount: 55 },
					},
				]).runPromise;

				expect(result.created).toHaveLength(0);
				expect(result.updated).toHaveLength(1);
				expect(result.unchanged).toHaveLength(1);
			});
		});

		describe("batch upsert error handling", () => {
			it("should validate all entities", async () => {
				const error = await Effect.runPromise(
					db.users
						.upsertMany([
							{
								where: { email: "valid@example.com" },
								create: {
									email: "valid@example.com",
									username: "validuser",
									name: "Valid User",
									age: 30,
									companyId: "comp1",
								},
								update: { age: 31 },
							},
							{
								where: { email: "invalid@example.com" },
								create: {
									email: 12345 as unknown as string,
									username: "invaliduser",
									name: "Invalid User",
									age: 25,
									companyId: "comp1",
								},
								update: { age: 26 },
							},
						])
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ValidationError");

				const users = await db.users.query().runPromise;
				expect(users).toHaveLength(2);
			});

			it("should handle foreign key validation", async () => {
				const error = await Effect.runPromise(
					db.products
						.upsertMany([
							{
								where: { sku: "VALID-001" },
								create: {
									sku: "VALID-001",
									name: "Valid",
									description: "V",
									price: 99.99,
									stock: 10,
									categoryId: "cat1",
								},
								update: { stock: 15 },
							},
							{
								where: { sku: "INVALID-001" },
								create: {
									sku: "INVALID-001",
									name: "Invalid",
									description: "I",
									price: 99.99,
									stock: 10,
									categoryId: "invalid-cat",
								},
								update: { stock: 15 },
							},
						])
						.pipe(Effect.flip),
				);

				expect(error._tag).toBe("ForeignKeyError");
			});

			it("should handle empty batch", async () => {
				const result = await db.users.upsertMany([]).runPromise;

				expect(result.created).toHaveLength(0);
				expect(result.updated).toHaveLength(0);
				expect(result.unchanged).toHaveLength(0);
			});
		});

		describe("batch upsert advanced scenarios", () => {
			it("should handle complex update operators in batch", async () => {
				const result = await db.users.upsertMany([
					{
						where: { username: "johndoe" },
						create: {
							email: "john@example.com",
							username: "johndoe",
							name: "John Doe",
							age: 30,
							companyId: "comp1",
						},
						update: {
							loginCount: { $increment: 1 },
							tags: { $append: ["active", "verified"] },
							bio: { $set: "Updated bio" },
						},
					},
					{
						where: { username: "newuser" },
						create: {
							email: "new@example.com",
							username: "newuser",
							name: "New User",
							age: 22,
							tags: ["new"],
							companyId: "comp2",
						},
						update: {
							loginCount: { $increment: 1 },
							tags: { $append: "active" },
						},
					},
				]).runPromise;

				expect(result.created).toHaveLength(1);
				expect(result.updated).toHaveLength(1);

				const john = result.updated[0];
				expect(john.loginCount).toBe(6);
				expect(john.tags).toContain("active");
				expect(john.tags).toContain("verified");
				expect(john.bio).toBe("Updated bio");

				const newUser = result.created[0];
				expect(newUser.tags).toEqual(["new"]);
			});
		});
	});
});
