import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect, map, first, count } from "../core/utils/async-iterable.js";

describe("Database v2 - Object-based Populate Syntax", () => {
	// ============================================================================
	// Test Schemas and Configuration
	// ============================================================================

	// Industry Schema
	const IndustrySchema = z.object({
		id: z.string(),
		name: z.string(),
		sector: z.string(),
	});

	// Company Schema
	const CompanySchema = z.object({
		id: z.string(),
		name: z.string(),
		industryId: z.string(),
		foundedYear: z.number(),
	});

	// User Schema
	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		companyId: z.string(),
		age: z.number(),
	});

	// Order Schema
	const OrderSchema = z.object({
		id: z.string(),
		orderNumber: z.string(),
		userId: z.string(),
		total: z.number(),
		status: z.string(),
	});

	// OrderItem Schema
	const OrderItemSchema = z.object({
		id: z.string(),
		orderId: z.string(),
		productId: z.string(),
		quantity: z.number(),
		price: z.number(),
	});

	// Product Schema
	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		price: z.number(),
		categoryId: z.string(),
	});

	// Category Schema
	const CategorySchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
	});

	// Configuration with relationships
	const config = {
		industries: {
			schema: IndustrySchema,
			relationships: {
				companies: { type: "inverse" as const, target: "companies" as const },
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				industry: { type: "ref" as const, target: "industries" as const },
				users: { type: "inverse" as const, target: "users" as const },
			},
		},
		users: {
			schema: UserSchema,
			relationships: {
				company: { type: "ref" as const, target: "companies" as const },
				orders: { type: "inverse" as const, target: "orders" as const },
			},
		},
		orders: {
			schema: OrderSchema,
			relationships: {
				user: { type: "ref" as const, target: "users" as const },
				items: { type: "inverse" as const, target: "orderItems" as const },
			},
		},
		orderItems: {
			schema: OrderItemSchema,
			relationships: {
				order: { type: "ref" as const, target: "orders" as const },
				product: { type: "ref" as const, target: "products" as const },
			},
		},
		products: {
			schema: ProductSchema,
			relationships: {
				category: { type: "ref" as const, target: "categories" as const },
				orderItems: { type: "inverse" as const, target: "orderItems" as const },
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
	const testData = {
		industries: [
			{ id: "ind1", name: "Technology", sector: "Information Technology" },
			{ id: "ind2", name: "Healthcare", sector: "Medical Services" },
			{ id: "ind3", name: "Finance", sector: "Financial Services" },
		],
		companies: [
			{ id: "comp1", name: "TechCorp", industryId: "ind1", foundedYear: 2010 },
			{
				id: "comp2",
				name: "HealthPlus",
				industryId: "ind2",
				foundedYear: 2015,
			},
			{
				id: "comp3",
				name: "FinanceHub",
				industryId: "ind3",
				foundedYear: 2008,
			},
		],
		users: [
			{
				id: "u1",
				name: "Alice",
				email: "alice@techcorp.com",
				companyId: "comp1",
				age: 30,
			},
			{
				id: "u2",
				name: "Bob",
				email: "bob@techcorp.com",
				companyId: "comp1",
				age: 28,
			},
			{
				id: "u3",
				name: "Charlie",
				email: "charlie@healthplus.com",
				companyId: "comp2",
				age: 35,
			},
			{
				id: "u4",
				name: "David",
				email: "david@financehub.com",
				companyId: "comp3",
				age: 40,
			},
		],
		orders: [
			{
				id: "ord1",
				orderNumber: "ORD-001",
				userId: "u1",
				total: 299.99,
				status: "completed",
			},
			{
				id: "ord2",
				orderNumber: "ORD-002",
				userId: "u1",
				total: 599.99,
				status: "pending",
			},
			{
				id: "ord3",
				orderNumber: "ORD-003",
				userId: "u2",
				total: 149.99,
				status: "completed",
			},
			{
				id: "ord4",
				orderNumber: "ORD-004",
				userId: "u3",
				total: 89.99,
				status: "completed",
			},
		],
		orderItems: [
			{
				id: "item1",
				orderId: "ord1",
				productId: "prod1",
				quantity: 1,
				price: 299.99,
			},
			{
				id: "item2",
				orderId: "ord2",
				productId: "prod2",
				quantity: 2,
				price: 299.99,
			},
			{
				id: "item3",
				orderId: "ord3",
				productId: "prod3",
				quantity: 1,
				price: 149.99,
			},
			{
				id: "item4",
				orderId: "ord4",
				productId: "prod1",
				quantity: 1,
				price: 89.99,
			},
		],
		products: [
			{ id: "prod1", name: "Laptop", price: 299.99, categoryId: "cat1" },
			{ id: "prod2", name: "Monitor", price: 299.99, categoryId: "cat1" },
			{ id: "prod3", name: "Keyboard", price: 149.99, categoryId: "cat1" },
		],
		categories: [
			{
				id: "cat1",
				name: "Electronics",
				description: "Electronic devices and accessories",
			},
			{
				id: "cat2",
				name: "Office Supplies",
				description: "Office equipment and supplies",
			},
		],
	};

	// ============================================================================
	// Test 1: Basic Object Populate Syntax
	// ============================================================================

	describe("Basic Object Populate Syntax", () => {
		it("should populate a single ref relationship", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: { company: true },
					where: { id: "u1" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeDefined();
			expect(users[0].company).toEqual({
				id: "comp1",
				name: "TechCorp",
				industryId: "ind1",
				foundedYear: 2010,
			});
		});

		it("should populate multiple relationships", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: {
						company: true,
						orders: true,
					},
					where: { id: "u1" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeDefined();
			expect(users[0].company?.name).toBe("TechCorp");
			expect(users[0].orders).toBeDefined();
			expect(users[0].orders).toHaveLength(2);
			expect(users[0].orders?.map((o) => o.orderNumber)).toEqual([
				"ORD-001",
				"ORD-002",
			]);
		});

		it("should work without populate (returns base entity)", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(db.users.query({ where: { id: "u1" } }));

			expect(users).toHaveLength(1);
			expect(users[0]).not.toHaveProperty("company");
			expect(users[0]).not.toHaveProperty("orders");
			expect(users[0]).toEqual({
				id: "u1",
				name: "Alice",
				email: "alice@techcorp.com",
				companyId: "comp1",
				age: 30,
			});
		});
	});

	// ============================================================================
	// Test 2: Nested Populate
	// ============================================================================

	describe("Nested Populate", () => {
		it("should populate two levels deep", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: {
						company: {
							industry: true,
						},
					},
					where: { id: "u1" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeDefined();
			expect(users[0].company?.industry).toBeDefined();
			expect(users[0].company?.industry).toEqual({
				id: "ind1",
				name: "Technology",
				sector: "Information Technology",
			});
		});

		it("should populate three levels deep", async () => {
			const db = createDatabase(config, testData);
			const orders = await collect(
				db.orders.query({
					populate: {
						user: {
							company: {
								industry: true,
							},
						},
					},
					where: { id: "ord1" },
				}),
			);

			expect(orders).toHaveLength(1);
			expect(orders[0].user).toBeDefined();
			expect(orders[0].user?.company).toBeDefined();
			expect(orders[0].user?.company?.industry).toBeDefined();
			expect(orders[0].user?.company?.industry?.name).toBe("Technology");
		});

		it("should handle mixed nested and flat populate", async () => {
			const db = createDatabase(config, testData);
			const orders = await collect(
				db.orders.query({
					populate: {
						user: {
							company: {
								industry: true,
							},
						},
						items: true,
					},
					where: { id: "ord1" },
				}),
			);

			expect(orders).toHaveLength(1);
			// Check nested populate
			expect(orders[0].user?.company?.industry?.name).toBe("Technology");
			// Check flat populate
			expect(orders[0].items).toHaveLength(1);
			expect(orders[0].items?.[0].productId).toBe("prod1");
		});

		it("should populate nested inverse relationships", async () => {
			const db = createDatabase(config, testData);
			const companies = await collect(
				db.companies.query({
					populate: {
						industry: true,
						users: {
							orders: true,
						},
					},
					where: { id: "comp1" },
				}),
			);

			expect(companies).toHaveLength(1);
			expect(companies[0].users).toHaveLength(2);
			expect(companies[0].users?.[0].orders).toBeDefined();
			expect(companies[0].users?.[0].orders?.length).toBeGreaterThan(0);
		});
	});

	// ============================================================================
	// Test 3: Custom Foreign Key Support
	// ============================================================================

	describe("Custom Foreign Key Support", () => {
		// Schema with custom foreign key
		const OrganizationSchema = z.object({
			id: z.string(),
			name: z.string(),
			type: z.string(),
		});

		const EmployeeSchema = z.object({
			id: z.string(),
			name: z.string(),
			organizationKey: z.string(), // Custom foreign key name
		});

		const customConfig = {
			organizations: {
				schema: OrganizationSchema,
				relationships: {
					employees: { type: "inverse" as const, target: "employees" as const },
				},
			},
			employees: {
				schema: EmployeeSchema,
				relationships: {
					organization: {
						type: "ref" as const,
						target: "organizations" as const,
						foreignKey: "organizationKey", // Specify custom foreign key
					},
				},
			},
		} as const;

		const customData = {
			organizations: [
				{ id: "org1", name: "Acme Corp", type: "corporation" },
				{ id: "org2", name: "Startup Inc", type: "startup" },
			],
			employees: [
				{ id: "emp1", name: "John", organizationKey: "org1" },
				{ id: "emp2", name: "Jane", organizationKey: "org1" },
				{ id: "emp3", name: "Jim", organizationKey: "org2" },
			],
		};

		it("should populate using custom foreign key for ref relationship", async () => {
			const db = createDatabase(customConfig, customData);
			const employees = await collect(
				db.employees.query({
					populate: { organization: true },
					where: { id: "emp1" },
				}),
			);

			expect(employees).toHaveLength(1);
			expect(employees[0].organization).toBeDefined();
			expect(employees[0].organization?.name).toBe("Acme Corp");
		});

		it("should populate inverse relationship with custom foreign key", async () => {
			const db = createDatabase(customConfig, customData);
			const organizations = await collect(
				db.organizations.query({
					populate: { employees: true },
					where: { id: "org1" },
				}),
			);

			expect(organizations).toHaveLength(1);
			expect(organizations[0].employees).toHaveLength(2);
			expect(organizations[0].employees?.map((e) => e.name)).toEqual([
				"John",
				"Jane",
			]);
		});
	});

	// ============================================================================
	// Test 4: Inverse Relationships (hasMany)
	// ============================================================================

	describe("Inverse Relationships (hasMany)", () => {
		it("should populate arrays of related items", async () => {
			const db = createDatabase(config, testData);
			const companies = await collect(
				db.companies.query({
					populate: { users: true },
					where: { id: "comp1" },
				}),
			);

			expect(companies).toHaveLength(1);
			expect(companies[0].users).toBeDefined();
			expect(Array.isArray(companies[0].users)).toBe(true);
			expect(companies[0].users).toHaveLength(2);
			expect(companies[0].users?.map((u) => u.name)).toEqual(["Alice", "Bob"]);
		});

		it("should handle nested populate through inverse relationships", async () => {
			const db = createDatabase(config, testData);
			const industries = await collect(
				db.industries.query({
					populate: {
						companies: {
							users: true,
						},
					},
					where: { id: "ind1" },
				}),
			);

			expect(industries).toHaveLength(1);
			expect(industries[0].companies).toHaveLength(1);
			expect(industries[0].companies?.[0].users).toHaveLength(2);
			expect(industries[0].companies?.[0].users?.[0].name).toBe("Alice");
		});

		it("should return empty array for inverse relationship with no matches", async () => {
			const db = createDatabase(config, testData);
			const categories = await collect(
				db.categories.query({
					populate: { products: true },
					where: { id: "cat2" }, // No products in this category
				}),
			);

			expect(categories).toHaveLength(1);
			expect(categories[0].products).toBeDefined();
			expect(Array.isArray(categories[0].products)).toBe(true);
			expect(categories[0].products).toHaveLength(0);
		});
	});

	// ============================================================================
	// Test 5: Edge Cases
	// ============================================================================

	describe("Edge Cases", () => {
		it("should ignore non-existent relationships in populate config", async () => {
			const db = createDatabase(config, testData);
			// Test with valid field
			const validQuery = db.users.query({
				populate: {
					company: true,
				},
				where: { id: "u1" },
			});

			// This should cause a type error if uncommented:
			// const invalidQuery = db.users.query({
			// 	populate: {
			// 		company: true,
			// 		nonExistentField: true // Type error: 'nonExistentField' does not exist
			// 	},
			// 	where: { id: "u1" }
			// });

			const users = await collect(validQuery);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeDefined();
			expect(users[0]).not.toHaveProperty("nonExistentField");
		});

		it("should handle populate with empty data", async () => {
			const emptyData = {
				...testData,
				companies: [], // No companies
			};
			const db = createDatabase(config, emptyData);
			const users = await collect(
				db.users.query({
					populate: { company: true },
					where: { id: "u1" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeUndefined();
		});

		it("should handle populate with no matching foreign keys", async () => {
			const modifiedData = {
				...testData,
				users: [
					{
						id: "u5",
						name: "Eve",
						email: "eve@test.com",
						companyId: "comp999",
						age: 25,
					}, // Non-existent company
				],
			};
			const db = createDatabase(config, modifiedData);
			const users = await collect(
				db.users.query({
					populate: { company: true },
					where: { id: "u5" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeUndefined();
		});

		it("should handle circular references gracefully", async () => {
			// Create a schema with potential circular reference
			const DepartmentSchema = z.object({
				id: z.string(),
				name: z.string(),
				managerId: z.string().optional(),
			});

			const PersonSchema = z.object({
				id: z.string(),
				name: z.string(),
				departmentId: z.string(),
			});

			const circularConfig = {
				departments: {
					schema: DepartmentSchema,
					relationships: {
						manager: {
							type: "ref" as const,
							target: "people" as const,
							foreignKey: "managerId",
						},
						people: { type: "inverse" as const, target: "people" as const },
					},
				},
				people: {
					schema: PersonSchema,
					relationships: {
						department: {
							type: "ref" as const,
							target: "departments" as const,
						},
						managedDepartments: {
							type: "inverse" as const,
							target: "departments" as const,
							foreignKey: "managerId",
						},
					},
				},
			} as const;

			const circularData = {
				departments: [
					{ id: "dept1", name: "Engineering", managerId: "person1" },
				],
				people: [
					{ id: "person1", name: "Alice", departmentId: "dept1" },
					{ id: "person2", name: "Bob", departmentId: "dept1" },
				],
			};

			const db = createDatabase(circularConfig, circularData);

			// Test that we can populate through the circular reference
			const departments = await collect(
				db.departments.query({
					populate: {
						manager: {
							department: true, // This creates a cycle
						},
					},
				}),
			);

			expect(departments).toHaveLength(1);
			expect(departments[0].manager).toBeDefined();
			expect(departments[0].manager?.department).toBeDefined();
			expect(departments[0].manager?.department?.id).toBe("dept1");
		});
	});

	// ============================================================================
	// Test 6: Type Safety
	// ============================================================================

	describe("Type Safety", () => {
		it("should have correct types for populated ref fields", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: { company: true },
					where: { id: "u1" },
				}),
			);

			const user = users[0];
			// TypeScript should infer that company is CompanySchema | undefined
			if (user.company) {
				expect(typeof user.company.name).toBe("string");
				expect(typeof user.company.foundedYear).toBe("number");
			}
		});

		it("should have correct types for populated inverse fields", async () => {
			const db = createDatabase(config, testData);
			const companies = await collect(
				db.companies.query({
					populate: { users: true },
					where: { id: "comp1" },
				}),
			);

			const company = companies[0];
			// TypeScript should infer that users is UserSchema[]
			expect(Array.isArray(company.users)).toBe(true);
			if (company.users && company.users.length > 0) {
				expect(typeof company.users[0].name).toBe("string");
				expect(typeof company.users[0].age).toBe("number");
			}
		});

		it("should return undefined for ref relationships when no match found", async () => {
			const modifiedData = {
				...testData,
				users: [
					{
						id: "u6",
						name: "Frank",
						email: "frank@test.com",
						companyId: "nonexistent",
						age: 30,
					},
				],
			};
			const db = createDatabase(config, modifiedData);
			const users = await collect(
				db.users.query({
					populate: { company: true },
					where: { id: "u6" },
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].company).toBeUndefined();
		});

		it("should return empty arrays for inverse relationships when no matches", async () => {
			const modifiedData = {
				...testData,
				users: [], // No users
			};
			const db = createDatabase(config, modifiedData);
			const companies = await collect(
				db.companies.query({
					populate: { users: true },
					where: { id: "comp1" },
				}),
			);

			expect(companies).toHaveLength(1);
			expect(companies[0].users).toBeDefined();
			expect(Array.isArray(companies[0].users)).toBe(true);
			expect(companies[0].users).toHaveLength(0);
		});
	});

	// ============================================================================
	// Test 7: Complex Scenarios
	// ============================================================================

	describe("Complex Scenarios", () => {
		it("should handle multiple levels of mixed populate types", async () => {
			const db = createDatabase(config, testData);
			const orderItems = await collect(
				db.orderItems.query({
					populate: {
						order: {
							user: {
								company: {
									industry: true,
									users: true,
								},
							},
						},
						product: {
							category: {
								products: true,
							},
						},
					},
					where: { id: "item1" },
				}),
			);

			expect(orderItems).toHaveLength(1);
			const item = orderItems[0];

			// Check order -> user -> company -> industry path
			expect(item.order?.user?.company?.industry?.name).toBe("Technology");

			// Check order -> user -> company -> users (inverse)
			expect(item.order?.user?.company?.users).toHaveLength(2);

			// Check product -> category path
			expect(item.product?.category?.name).toBe("Electronics");

			// Check product -> category -> products (inverse)
			expect(item.product?.category?.products).toHaveLength(3);
		});

		it("should work with filtering and populate together", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: {
						company: {
							industry: true,
						},
						orders: true,
					},
					where: {
						age: { $gte: 30 },
						company: {
							industry: {
								sector: "Information Technology",
							},
						},
					},
				}),
			);

			expect(users).toHaveLength(1);
			expect(users[0].name).toBe("Alice");
			expect(users[0].company?.industry?.sector).toBe("Information Technology");
			expect(users[0].orders).toHaveLength(2);
		});

		it("should handle populate with multiple items", async () => {
			const db = createDatabase(config, testData);
			const users = await collect(
				db.users.query({
					populate: {
						company: true,
						orders: {
							items: {
								product: true,
							},
						},
					},
				}),
			);

			expect(users.length).toBeGreaterThan(0);

			// Check that each user has properly populated data
			for (const user of users) {
				if (user.company) {
					expect(user.company).toHaveProperty("id");
					expect(user.company).toHaveProperty("name");
				}

				if (user.orders && user.orders.length > 0) {
					for (const order of user.orders) {
						expect(order).toHaveProperty("id");
						if (order.items && order.items.length > 0) {
							for (const item of order.items) {
								expect(item).toHaveProperty("id");
								if (item.product) {
									expect(item.product).toHaveProperty("name");
									expect(item.product).toHaveProperty("price");
								}
							}
						}
					}
				}
			}
		});
	});
});
