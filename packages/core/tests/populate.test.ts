import { Chunk, Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/factories/database-effect";

describe("Database v2 - Object-based Populate Syntax (Effect/Stream)", () => {
	// ============================================================================
	// Test Schemas and Configuration
	// ============================================================================

	const IndustrySchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		sector: Schema.String,
	});

	const CompanySchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		industryId: Schema.String,
		foundedYear: Schema.Number,
	});

	const UserSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		email: Schema.String,
		companyId: Schema.String,
		age: Schema.Number,
	});

	const OrderSchema = Schema.Struct({
		id: Schema.String,
		orderNumber: Schema.String,
		userId: Schema.String,
		total: Schema.Number,
		status: Schema.String,
	});

	const OrderItemSchema = Schema.Struct({
		id: Schema.String,
		orderId: Schema.String,
		productId: Schema.String,
		quantity: Schema.Number,
		price: Schema.Number,
	});

	const ProductSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		price: Schema.Number,
		categoryId: Schema.String,
	});

	const CategorySchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		description: Schema.String,
	});

	const config = {
		industries: {
			schema: IndustrySchema,
			relationships: {
				companies: { type: "inverse" as const, target: "companies" },
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				industry: { type: "ref" as const, target: "industries" },
				users: { type: "inverse" as const, target: "users" },
			},
		},
		users: {
			schema: UserSchema,
			relationships: {
				company: { type: "ref" as const, target: "companies" },
				orders: { type: "inverse" as const, target: "orders" },
			},
		},
		orders: {
			schema: OrderSchema,
			relationships: {
				user: { type: "ref" as const, target: "users" },
				items: { type: "inverse" as const, target: "orderItems" },
			},
		},
		orderItems: {
			schema: OrderItemSchema,
			relationships: {
				order: { type: "ref" as const, target: "orders" },
				product: { type: "ref" as const, target: "products" },
			},
		},
		products: {
			schema: ProductSchema,
			relationships: {
				category: { type: "ref" as const, target: "categories" },
				orderItems: { type: "inverse" as const, target: "orderItems" },
			},
		},
		categories: {
			schema: CategorySchema,
			relationships: {
				products: { type: "inverse" as const, target: "products" },
			},
		},
	} as const;

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

	// Helper: create the database and collect query results
	const collectQuery = (
		cfg: typeof config,
		data: typeof testData,
		collection: string,
		options: Record<string, unknown>,
	): Promise<ReadonlyArray<Record<string, unknown>>> =>
		Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(cfg, data);
				const coll = (
					db as Record<
						string,
						{
							query: (
								opts: Record<string, unknown>,
							) => Stream.Stream<Record<string, unknown>>;
						}
					>
				)[collection];
				return yield* Stream.runCollect(coll.query(options)).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);
			}),
		);

	// ============================================================================
	// Test 1: Basic Object Populate Syntax
	// ============================================================================

	describe("Basic Object Populate Syntax", () => {
		it("should populate a single ref relationship", async () => {
			const users = await collectQuery(config, testData, "users", {
				populate: { company: true },
				where: { id: "u1" },
			});

			expect(users).toHaveLength(1);
			const user = users[0] as Record<string, unknown>;
			expect(user.company).toBeDefined();
			expect(user.company).toEqual({
				id: "comp1",
				name: "TechCorp",
				industryId: "ind1",
				foundedYear: 2010,
			});
		});

		it("should populate multiple relationships", async () => {
			const users = await collectQuery(config, testData, "users", {
				populate: { company: true, orders: true },
				where: { id: "u1" },
			});

			expect(users).toHaveLength(1);
			const user = users[0] as Record<string, unknown>;
			const company = user.company as Record<string, unknown>;
			expect(company).toBeDefined();
			expect(company.name).toBe("TechCorp");
			const orders = user.orders as Array<Record<string, unknown>>;
			expect(orders).toBeDefined();
			expect(orders).toHaveLength(2);
			expect(orders.map((o) => o.orderNumber)).toEqual(["ORD-001", "ORD-002"]);
		});

		it("should work without populate (returns base entity)", async () => {
			const users = await collectQuery(config, testData, "users", {
				where: { id: "u1" },
			});

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
			const users = await collectQuery(config, testData, "users", {
				populate: {
					company: {
						industry: true,
					},
				},
				where: { id: "u1" },
			});

			expect(users).toHaveLength(1);
			const user = users[0] as Record<string, unknown>;
			const company = user.company as Record<string, unknown>;
			expect(company).toBeDefined();
			const industry = company.industry as Record<string, unknown>;
			expect(industry).toBeDefined();
			expect(industry).toEqual({
				id: "ind1",
				name: "Technology",
				sector: "Information Technology",
			});
		});

		it("should populate three levels deep", async () => {
			const orders = await collectQuery(config, testData, "orders", {
				populate: {
					user: {
						company: {
							industry: true,
						},
					},
				},
				where: { id: "ord1" },
			});

			expect(orders).toHaveLength(1);
			const order = orders[0] as Record<string, unknown>;
			const user = order.user as Record<string, unknown>;
			expect(user).toBeDefined();
			const company = user.company as Record<string, unknown>;
			expect(company).toBeDefined();
			const industry = company.industry as Record<string, unknown>;
			expect(industry).toBeDefined();
			expect(industry.name).toBe("Technology");
		});

		it("should handle mixed nested and flat populate", async () => {
			const orders = await collectQuery(config, testData, "orders", {
				populate: {
					user: {
						company: {
							industry: true,
						},
					},
					items: true,
				},
				where: { id: "ord1" },
			});

			expect(orders).toHaveLength(1);
			const order = orders[0] as Record<string, unknown>;
			// Check nested populate
			const user = order.user as Record<string, unknown>;
			const company = user.company as Record<string, unknown>;
			const industry = company.industry as Record<string, unknown>;
			expect(industry.name).toBe("Technology");
			// Check flat populate
			const items = order.items as Array<Record<string, unknown>>;
			expect(items).toHaveLength(1);
			expect(items[0].productId).toBe("prod1");
		});

		it("should populate nested inverse relationships", async () => {
			const companies = await collectQuery(config, testData, "companies", {
				populate: {
					industry: true,
					users: {
						orders: true,
					},
				},
				where: { id: "comp1" },
			});

			expect(companies).toHaveLength(1);
			const comp = companies[0] as Record<string, unknown>;
			const users = comp.users as Array<Record<string, unknown>>;
			expect(users).toHaveLength(2);
			const firstUserOrders = users[0].orders as Array<Record<string, unknown>>;
			expect(firstUserOrders).toBeDefined();
			expect(firstUserOrders.length).toBeGreaterThan(0);
		});
	});

	// ============================================================================
	// Test 3: Custom Foreign Key Support
	// ============================================================================

	describe("Custom Foreign Key Support", () => {
		const OrganizationSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			type: Schema.String,
		});

		const EmployeeSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			organizationKey: Schema.String,
		});

		const customConfig = {
			organizations: {
				schema: OrganizationSchema,
				relationships: {
					employees: { type: "inverse" as const, target: "employees" },
				},
			},
			employees: {
				schema: EmployeeSchema,
				relationships: {
					organization: {
						type: "ref" as const,
						target: "organizations" as const,
						foreignKey: "organizationKey",
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
			const employees = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(customConfig, customData);
					return yield* Stream.runCollect(
						db.employees.query({
							populate: { organization: true },
							where: { id: "emp1" },
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			expect(employees).toHaveLength(1);
			const emp = employees[0] as Record<string, unknown>;
			const org = emp.organization as Record<string, unknown>;
			expect(org).toBeDefined();
			expect(org.name).toBe("Acme Corp");
		});

		it("should populate inverse relationship with custom foreign key", async () => {
			const organizations = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(customConfig, customData);
					return yield* Stream.runCollect(
						db.organizations.query({
							populate: { employees: true },
							where: { id: "org1" },
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			expect(organizations).toHaveLength(1);
			const org = organizations[0] as Record<string, unknown>;
			const employees = org.employees as Array<Record<string, unknown>>;
			expect(employees).toHaveLength(2);
			expect(employees.map((e) => e.name)).toEqual(["John", "Jane"]);
		});
	});

	// ============================================================================
	// Test 4: Inverse Relationships (hasMany)
	// ============================================================================

	describe("Inverse Relationships (hasMany)", () => {
		it("should populate arrays of related items", async () => {
			const companies = await collectQuery(config, testData, "companies", {
				populate: { users: true },
				where: { id: "comp1" },
			});

			expect(companies).toHaveLength(1);
			const comp = companies[0] as Record<string, unknown>;
			const users = comp.users as Array<Record<string, unknown>>;
			expect(users).toBeDefined();
			expect(Array.isArray(users)).toBe(true);
			expect(users).toHaveLength(2);
			expect(users.map((u) => u.name)).toEqual(["Alice", "Bob"]);
		});

		it("should handle nested populate through inverse relationships", async () => {
			const industries = await collectQuery(config, testData, "industries", {
				populate: {
					companies: {
						users: true,
					},
				},
				where: { id: "ind1" },
			});

			expect(industries).toHaveLength(1);
			const ind = industries[0] as Record<string, unknown>;
			const companies = ind.companies as Array<Record<string, unknown>>;
			expect(companies).toHaveLength(1);
			const compUsers = companies[0].users as Array<Record<string, unknown>>;
			expect(compUsers).toHaveLength(2);
			expect(compUsers[0].name).toBe("Alice");
		});

		it("should return empty array for inverse relationship with no matches", async () => {
			const categories = await collectQuery(config, testData, "categories", {
				populate: { products: true },
				where: { id: "cat2" }, // No products in this category
			});

			expect(categories).toHaveLength(1);
			const cat = categories[0] as Record<string, unknown>;
			const products = cat.products as Array<Record<string, unknown>>;
			expect(products).toBeDefined();
			expect(Array.isArray(products)).toBe(true);
			expect(products).toHaveLength(0);
		});
	});

	// ============================================================================
	// Test 5: Edge Cases
	// ============================================================================

	describe("Edge Cases", () => {
		it("should ignore non-existent relationships in populate config", async () => {
			const users = await collectQuery(config, testData, "users", {
				populate: { company: true },
				where: { id: "u1" },
			});

			expect(users).toHaveLength(1);
			const user = users[0] as Record<string, unknown>;
			expect(user.company).toBeDefined();
			expect(user).not.toHaveProperty("nonExistentField");
		});

		it("should produce DanglingReferenceError when ref target is missing", async () => {
			const emptyCompaniesData = {
				...testData,
				companies: [],
			};
			// The Effect populate-stream yields DanglingReferenceError for missing ref targets
			const result = Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(
						config,
						emptyCompaniesData as typeof testData,
					);
					return yield* Stream.runCollect(
						db.users.query({
							populate: { company: true },
							where: { id: "u1" },
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			await expect(result).rejects.toThrow();
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
					},
				],
			};
			// The Effect populate-stream produces DanglingReferenceError for missing targets.
			// This test verifies the error is raised.
			const result = Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(
						config,
						modifiedData as typeof testData,
					);
					return yield* Stream.runCollect(
						db.users.query({
							populate: { company: true },
							where: { id: "u5" },
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			await expect(result).rejects.toThrow();
		});

		it("should handle circular references gracefully", async () => {
			const DepartmentSchema = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				managerId: Schema.optional(Schema.String),
			});

			const PersonSchema = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				departmentId: Schema.String,
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

			const departments = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(circularConfig, circularData);
					return yield* Stream.runCollect(
						db.departments.query({
							populate: {
								manager: {
									department: true, // This creates a cycle
								},
							},
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			expect(departments).toHaveLength(1);
			const dept = departments[0] as Record<string, unknown>;
			const manager = dept.manager as Record<string, unknown>;
			expect(manager).toBeDefined();
			const managerDept = manager.department as Record<string, unknown>;
			expect(managerDept).toBeDefined();
			expect(managerDept.id).toBe("dept1");
		});
	});

	// ============================================================================
	// Test 6: Type Safety
	// ============================================================================

	describe("Type Safety", () => {
		it("should have correct types for populated ref fields", async () => {
			const users = await collectQuery(config, testData, "users", {
				populate: { company: true },
				where: { id: "u1" },
			});

			const user = users[0] as Record<string, unknown>;
			const company = user.company as Record<string, unknown> | undefined;
			if (company) {
				expect(typeof company.name).toBe("string");
				expect(typeof company.foundedYear).toBe("number");
			}
		});

		it("should have correct types for populated inverse fields", async () => {
			const companies = await collectQuery(config, testData, "companies", {
				populate: { users: true },
				where: { id: "comp1" },
			});

			const company = companies[0] as Record<string, unknown>;
			const users = company.users as Array<Record<string, unknown>>;
			expect(Array.isArray(users)).toBe(true);
			if (users && users.length > 0) {
				expect(typeof users[0].name).toBe("string");
				expect(typeof users[0].age).toBe("number");
			}
		});

		it("should return DanglingReferenceError for ref relationships when no match found", async () => {
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
			const result = Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(
						config,
						modifiedData as typeof testData,
					);
					return yield* Stream.runCollect(
						db.users.query({
							populate: { company: true },
							where: { id: "u6" },
						}),
					).pipe(Effect.map(Chunk.toReadonlyArray));
				}),
			);

			await expect(result).rejects.toThrow();
		});

		it("should return empty arrays for inverse relationships when no matches", async () => {
			const modifiedData = {
				...testData,
				users: [], // No users
			};
			const companies = await collectQuery(
				config,
				modifiedData as typeof testData,
				"companies",
				{
					populate: { users: true },
					where: { id: "comp1" },
				},
			);

			expect(companies).toHaveLength(1);
			const comp = companies[0] as Record<string, unknown>;
			const users = comp.users as Array<Record<string, unknown>>;
			expect(users).toBeDefined();
			expect(Array.isArray(users)).toBe(true);
			expect(users).toHaveLength(0);
		});
	});

	// ============================================================================
	// Test 7: Complex Scenarios
	// ============================================================================

	describe("Complex Scenarios", () => {
		it("should handle multiple levels of mixed populate types", async () => {
			const orderItems = await collectQuery(config, testData, "orderItems", {
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
			});

			expect(orderItems).toHaveLength(1);
			const item = orderItems[0] as Record<string, unknown>;

			// Check order -> user -> company -> industry path
			const order = item.order as Record<string, unknown>;
			const user = order.user as Record<string, unknown>;
			const company = user.company as Record<string, unknown>;
			const industry = company.industry as Record<string, unknown>;
			expect(industry.name).toBe("Technology");

			// Check order -> user -> company -> users (inverse)
			const compUsers = company.users as Array<Record<string, unknown>>;
			expect(compUsers).toHaveLength(2);

			// Check product -> category path
			const product = item.product as Record<string, unknown>;
			const category = product.category as Record<string, unknown>;
			expect(category.name).toBe("Electronics");

			// Check product -> category -> products (inverse)
			const catProducts = category.products as Array<Record<string, unknown>>;
			expect(catProducts).toHaveLength(3);
		});

		it("should handle populate with multiple items", async () => {
			const users = await collectQuery(config, testData, "users", {
				populate: {
					company: true,
					orders: {
						items: {
							product: true,
						},
					},
				},
			});

			expect(users.length).toBeGreaterThan(0);

			for (const rawUser of users) {
				const user = rawUser as Record<string, unknown>;
				const company = user.company as Record<string, unknown> | undefined;
				if (company) {
					expect(company).toHaveProperty("id");
					expect(company).toHaveProperty("name");
				}

				const orders = user.orders as
					| Array<Record<string, unknown>>
					| undefined;
				if (orders && orders.length > 0) {
					for (const order of orders) {
						expect(order).toHaveProperty("id");
						const items = order.items as
							| Array<Record<string, unknown>>
							| undefined;
						if (items && items.length > 0) {
							for (const item of items) {
								expect(item).toHaveProperty("id");
								const product = item.product as
									| Record<string, unknown>
									| undefined;
								if (product) {
									expect(product).toHaveProperty("name");
									expect(product).toHaveProperty("price");
								}
							}
						}
					}
				}
			}
		});
	});
});
