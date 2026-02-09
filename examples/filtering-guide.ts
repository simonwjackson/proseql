import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type { GenerateDatabase, TypedPopulate } from "../core/types/types";

// ============================================================================
// Complete Filtering Guide - Database v2
// ============================================================================

/**
 * This guide demonstrates all filtering capabilities of the Database v2 system.
 * Features include:
 * - Type-safe filtering with full IntelliSense support
 * - All operator types: string, numeric, boolean, array
 * - Relationship filtering (ref and inverse types)
 * - Array operators for hasMany relationships ($some, $every, $none)
 * - Complex nested filtering through multiple relationship levels
 * - Combining filtering with population
 */

// ============================================================================
// Sample Schema - E-commerce System
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	age: z.number(),
	isActive: z.boolean(),
	companyId: z.string(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	industry: z.string(),
	revenue: z.number(),
	foundedYear: z.number(),
	isPublic: z.boolean(),
});

const ProductSchema = z.object({
	id: z.string(),
	name: z.string(),
	price: z.number(),
	categoryId: z.string(),
	inStock: z.boolean(),
	tags: z.array(z.string()),
});

const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
});

const OrderSchema = z.object({
	id: z.string(),
	userId: z.string(),
	status: z.string(),
	total: z.number(),
	createdAt: z.string(),
});

const OrderItemSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	productId: z.string(),
	quantity: z.number(),
	unitPrice: z.number(),
});

// Database configuration with relationships
const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" },
			orders: { type: "inverse" as const, target: "orders" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users" },
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
} as const;

// Sample data
const data = {
	companies: [
		{
			id: "c1",
			name: "TechCorp",
			industry: "Technology",
			revenue: 10000000,
			foundedYear: 2010,
			isPublic: true,
		},
		{
			id: "c2",
			name: "StartupLab",
			industry: "Technology",
			revenue: 1000000,
			foundedYear: 2020,
			isPublic: false,
		},
		{
			id: "c3",
			name: "FinanceFirst",
			industry: "Finance",
			revenue: 50000000,
			foundedYear: 2005,
			isPublic: true,
		},
		{
			id: "c4",
			name: "HealthPlus",
			industry: "Healthcare",
			revenue: 25000000,
			foundedYear: 2015,
			isPublic: false,
		},
	],
	users: [
		{
			id: "u1",
			name: "Alice Johnson",
			email: "alice@techcorp.com",
			age: 30,
			isActive: true,
			companyId: "c1",
		},
		{
			id: "u2",
			name: "Bob Smith",
			email: "bob@startuplab.com",
			age: 25,
			isActive: true,
			companyId: "c2",
		},
		{
			id: "u3",
			name: "Charlie Brown",
			email: "charlie@finance.com",
			age: 45,
			isActive: false,
			companyId: "c3",
		},
		{
			id: "u4",
			name: "Diana Prince",
			email: "diana@health.com",
			age: 35,
			isActive: true,
			companyId: "c4",
		},
		{
			id: "u5",
			name: "Alex Turner",
			email: "alex@techcorp.com",
			age: 28,
			isActive: true,
			companyId: "c1",
		},
	],
	categories: [
		{
			id: "cat1",
			name: "Electronics",
			description: "Electronic devices and gadgets",
		},
		{ id: "cat2", name: "Books", description: "Physical and digital books" },
		{ id: "cat3", name: "Clothing" },
		{ id: "cat4", name: "Sports", description: "Sports and fitness equipment" },
	],
	products: [
		{
			id: "p1",
			name: "Smartphone Pro",
			price: 999.99,
			categoryId: "cat1",
			inStock: true,
			tags: ["premium", "mobile"],
		},
		{
			id: "p2",
			name: "TypeScript Guide",
			price: 49.99,
			categoryId: "cat2",
			inStock: true,
			tags: ["programming", "education"],
		},
		{
			id: "p3",
			name: "Wireless Headphones",
			price: 199.99,
			categoryId: "cat1",
			inStock: false,
			tags: ["audio", "wireless"],
		},
		{
			id: "p4",
			name: "Running Shoes",
			price: 129.99,
			categoryId: "cat4",
			inStock: true,
			tags: ["footwear", "running"],
		},
		{
			id: "p5",
			name: "Gaming Mouse",
			price: 79.99,
			categoryId: "cat1",
			inStock: true,
			tags: ["gaming", "peripheral"],
		},
		{
			id: "p6",
			name: "Cotton T-Shirt",
			price: 24.99,
			categoryId: "cat3",
			inStock: true,
			tags: ["casual", "cotton"],
		},
	],
	orders: [
		{
			id: "o1",
			userId: "u1",
			status: "completed",
			total: 1199.98,
			createdAt: "2024-01-15",
		},
		{
			id: "o2",
			userId: "u2",
			status: "pending",
			total: 49.99,
			createdAt: "2024-02-01",
		},
		{
			id: "o3",
			userId: "u1",
			status: "shipped",
			total: 279.98,
			createdAt: "2024-02-10",
		},
		{
			id: "o4",
			userId: "u3",
			status: "completed",
			total: 129.99,
			createdAt: "2024-01-20",
		},
		{
			id: "o5",
			userId: "u4",
			status: "pending",
			total: 104.98,
			createdAt: "2024-02-15",
		},
	],
	orderItems: [
		{
			id: "oi1",
			orderId: "o1",
			productId: "p1",
			quantity: 1,
			unitPrice: 999.99,
		},
		{
			id: "oi2",
			orderId: "o1",
			productId: "p3",
			quantity: 1,
			unitPrice: 199.99,
		},
		{
			id: "oi3",
			orderId: "o2",
			productId: "p2",
			quantity: 1,
			unitPrice: 49.99,
		},
		{
			id: "oi4",
			orderId: "o3",
			productId: "p5",
			quantity: 2,
			unitPrice: 79.99,
		},
		{
			id: "oi5",
			orderId: "o3",
			productId: "p4",
			quantity: 1,
			unitPrice: 129.99,
		},
		{
			id: "oi6",
			orderId: "o4",
			productId: "p4",
			quantity: 1,
			unitPrice: 129.99,
		},
		{
			id: "oi7",
			orderId: "o5",
			productId: "p5",
			quantity: 1,
			unitPrice: 79.99,
		},
		{
			id: "oi8",
			orderId: "o5",
			productId: "p6",
			quantity: 1,
			unitPrice: 24.99,
		},
	],
};

// Create the database instance
const db = createDatabase(config, data);

// ============================================================================
// FILTERING GUIDE EXAMPLES
// ============================================================================

export async function demonstrateBasicFiltering() {
	console.log("=== BASIC FIELD FILTERING ===\n");

	// 1. Exact Match (Implicit $eq)
	console.log("1. Exact Match:");
	for await (const user of db.users.query({
		where: {
			name: "Alice Johnson",
		},
	})) {
		console.log(`   Found: ${user.name} (${user.email})`);
	}

	// 2. Boolean Filtering
	console.log("\n2. Boolean Filtering:");
	for await (const user of db.users.query({
		where: {
			isActive: true,
		},
	})) {
		console.log(`   Active user: ${user.name}`);
	}

	// 3. Multiple Field Filtering (AND logic)
	console.log("\n3. Multiple Field Filtering (AND logic):");
	for await (const user of db.users.query({
		where: {
			isActive: true,
			age: { $gte: 30 },
		},
	})) {
		console.log(`   Active user 30+: ${user.name} (age ${user.age})`);
	}
}

export async function demonstrateStringOperators() {
	console.log("=== STRING OPERATORS ===\n");

	// 1. $startsWith
	console.log("1. $startsWith:");
	for await (const user of db.users.query({
		where: {
			name: { $startsWith: "A" },
		},
	})) {
		console.log(`   Name starts with 'A': ${user.name}`);
	}

	// 2. $endsWith
	console.log("\n2. $endsWith:");
	for await (const user of db.users.query({
		where: {
			email: { $endsWith: ".com" },
		},
	})) {
		console.log(`   Email ends with '.com': ${user.email}`);
	}

	// 3. $contains
	console.log("\n3. $contains:");
	for await (const user of db.users.query({
		where: {
			email: { $contains: "techcorp" },
		},
	})) {
		console.log(`   Email contains 'techcorp': ${user.email}`);
	}

	// 4. $eq and $ne
	console.log("\n4. $eq and $ne:");
	for await (const user of db.users.query({
		where: {
			name: { $ne: "Alice Johnson" },
		},
	})) {
		console.log(`   Not Alice: ${user.name}`);
	}
}

export async function demonstrateNumericOperators() {
	console.log("=== NUMERIC OPERATORS ===\n");

	// 1. Comparison operators
	console.log("1. Greater than ($gt):");
	for await (const product of db.products.query({
		where: {
			price: { $gt: 100 },
		},
	})) {
		console.log(`   Expensive product: ${product.name} ($${product.price})`);
	}

	console.log("\n2. Range filtering ($gte and $lte):");
	for await (const product of db.products.query({
		where: {
			price: {
				$gte: 50,
				$lte: 200,
			},
		},
	})) {
		console.log(`   Mid-range product: ${product.name} ($${product.price})`);
	}

	console.log("\n3. Less than ($lt):");
	for await (const user of db.users.query({
		where: {
			age: { $lt: 30 },
		},
	})) {
		console.log(`   Young user: ${user.name} (age ${user.age})`);
	}
}

export async function demonstrateArrayOperators() {
	console.log("=== ARRAY OPERATORS ===\n");

	// 1. $in operator
	console.log("1. Value in array ($in):");
	for await (const order of db.orders.query({
		where: {
			status: { $in: ["pending", "shipped"] },
		},
	})) {
		console.log(`   Order ${order.id}: ${order.status}`);
	}

	// 2. $nin operator
	console.log("\n2. Value not in array ($nin):");
	for await (const order of db.orders.query({
		where: {
			status: { $nin: ["completed"] },
		},
	})) {
		console.log(`   Non-completed order ${order.id}: ${order.status}`);
	}

	// 3. Multiple values
	console.log("\n3. Multiple category filtering:");
	for await (const product of db.products.query({
		where: {
			categoryId: { $in: ["cat1", "cat4"] },
		},
	})) {
		console.log(`   Electronics/Sports: ${product.name}`);
	}
}

export async function demonstrateRelationshipFiltering() {
	console.log("=== RELATIONSHIP FILTERING ===\n");

	// 1. Filter by ref relationship (belongsTo)
	console.log("1. Filter by company (ref relationship):");
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			company: {
				industry: "Technology",
			},
		},
	})) {
		if (user.company) {
			console.log(`   Tech employee: ${user.name} at ${user.company.name}`);
		}
	}

	// 2. Filter by nested ref relationship
	console.log("\n2. Filter by nested relationships:");
	for await (const orderItem of db.orderItems.query({
		populate: {
			product: {
				category: true,
			},
		},
		where: {
			product: {
				category: {
					name: "Electronics",
				},
			},
		},
	})) {
		if (orderItem.product?.category) {
			console.log(
				`   Electronics order item: ${orderItem.product.name} in ${orderItem.product.category.name}`,
			);
		}
	}

	// 3. Complex ref filtering with operators
	console.log("\n3. Complex ref filtering:");
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			company: {
				revenue: { $gt: 5000000 },
				foundedYear: { $gte: 2010 },
			},
		},
	})) {
		if (user.company) {
			console.log(
				`   Employee at large recent company: ${user.name} at ${user.company.name}`,
			);
		}
	}
}

export async function demonstrateInverseRelationshipFiltering() {
	console.log("=== INVERSE RELATIONSHIP FILTERING (Array Operators) ===\n");

	// 1. $some - At least one related item matches
	console.log("1. $some - Users with at least one completed order:");
	for await (const user of db.users.query({
		populate: { orders: true },
		where: {
			orders: {
				$some: {
					status: "completed",
				},
			},
		},
	})) {
		const completedOrders = user.orders.filter((o) => o.status === "completed");
		console.log(
			`   ${user.name} has ${completedOrders.length} completed order(s)`,
		);
	}

	// 2. $some with complex conditions
	console.log(
		"\n2. $some with complex conditions - Users with high-value orders:",
	);
	for await (const user of db.users.query({
		populate: { orders: true },
		where: {
			orders: {
				$some: {
					total: { $gt: 200 },
					status: { $ne: "pending" },
				},
			},
		},
	})) {
		const highValueOrders = user.orders.filter(
			(o) => o.total > 200 && o.status !== "pending",
		);
		console.log(
			`   ${user.name} has ${highValueOrders.length} high-value non-pending order(s)`,
		);
	}

	// 3. $every - All related items match
	console.log(
		"\n3. $every - Products where all order items have quantity > 0:",
	);
	for await (const product of db.products.query({
		populate: { orderItems: true },
		where: {
			orderItems: {
				$every: {
					quantity: { $gt: 0 },
				},
			},
		},
	})) {
		console.log(`   ${product.name} - all orders have positive quantity`);
	}

	// 4. $none - No related items match
	console.log("\n4. $none - Companies with no employees aged under 30:");
	for await (const company of db.companies.query({
		populate: { employees: true },
		where: {
			employees: {
				$none: {
					age: { $lt: 30 },
				},
			},
		},
	})) {
		console.log(`   ${company.name} has no employees under 30`);
	}
}

export async function demonstrateComplexNestedFiltering() {
	console.log("=== COMPLEX NESTED FILTERING ===\n");

	// 1. Deep nested filtering through multiple relationships
	console.log("1. Deep nested filtering - Orders from tech company employees:");
	for await (const order of db.orders.query({
		populate: {
			user: {
				company: true,
			},
		},
		where: {
			user: {
				company: {
					industry: "Technology",
				},
				isActive: true,
			},
		},
	})) {
		if (order.user?.company) {
			console.log(
				`   Order ${order.id} from ${order.user.name} at ${order.user.company.name}`,
			);
		}
	}

	// 2. Combining multiple relationship levels with array operators
	console.log(
		"\n2. Complex array + ref filtering - Companies with employees who have pending orders:",
	);
	for await (const company of db.companies.query({
		populate: { employees: true },
		where: {
			employees: {
				$some: {
					orders: {
						$some: {
							status: "pending",
						},
					},
				},
			},
		},
	})) {
		console.log(`   ${company.name} has employees with pending orders`);
	}

	// 3. Multi-level filtering with operators
	console.log(
		"\n3. Multi-level with operators - Young employees at profitable companies:",
	);
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			age: { $lt: 35 },
			company: {
				revenue: { $gt: 10000000 },
				isPublic: true,
			},
		},
	})) {
		if (user.company) {
			console.log(
				`   ${user.name} (${user.age}) at profitable public company ${user.company.name}`,
			);
		}
	}
}

export async function demonstrateTypeIntelliSense() {
	console.log("=== TYPE SAFETY & INTELLISENSE DEMO ===\n");

	// The TypeScript compiler ensures these are all valid:

	// 1. Field names are validated
	const validQuery1 = db.users.query({
		where: {
			name: "Alice", // ✅ Valid - 'name' exists on User
			email: { $contains: "@" }, // ✅ Valid - 'email' exists and supports string ops
			age: { $gt: 25 }, // ✅ Valid - 'age' exists and supports numeric ops
		},
	});

	// 2. Operators are type-appropriate
	const validQuery2 = db.products.query({
		where: {
			price: { $gte: 100 }, // ✅ Valid - numeric operator on number field
			inStock: { $eq: true }, // ✅ Valid - boolean operator on boolean field
			name: { $startsWith: "A" }, // ✅ Valid - string operator on string field
		},
	});

	// 3. Relationship paths are validated
	const validQuery3 = db.users.query({
		populate: { company: true }, // ✅ Valid relationship
		where: {
			company: {
				// ✅ Valid - can filter by company fields
				industry: "Technology", // ✅ Valid - 'industry' exists on Company
			},
		},
	});

	// 4. Array operators only work on inverse relationships
	const validQuery4 = db.companies.query({
		where: {
			employees: {
				// ✅ Valid - inverse relationship (hasMany)
				$some: {
					// ✅ Valid - array operator on hasMany
					isActive: true, // ✅ Valid - field exists on User
				},
			},
		},
	});

	// The following would cause TypeScript compilation errors:
	/*
	db.users.query({ 
		where: { 
			invalidField: "value"    // ❌ Error - field doesn't exist
		} 
	});
	
	db.users.query({ 
		where: { 
			age: { $startsWith: "2" } // ❌ Error - string operator on number field
		} 
	});
	
	db.users.query({ 
		where: { 
			company: {               // ❌ Error - trying array operator on ref relationship
				$some: { ... }
			} 
		} 
	});
	*/

	console.log("✅ All type checks passed! IntelliSense provides:");
	console.log("   • Field name completion");
	console.log("   • Operator validation per field type");
	console.log("   • Relationship path validation");
	console.log("   • Populate configuration assistance");
}

export async function demonstrateCommonPatterns() {
	console.log("=== COMMON QUERY PATTERNS ===\n");

	// Pattern 1: Search with pagination-ready filtering
	console.log("1. Search Pattern - Products under $200 with stock:");
	for await (const product of db.products.query({
		where: {
			price: { $lte: 200 },
			inStock: true,
			name: { $contains: "" }, // Search term would go here
		},
	})) {
		console.log(`   ${product.name}: $${product.price} (in stock)`);
	}

	// Pattern 2: Dashboard analytics queries
	console.log("\n2. Analytics Pattern - Recent high-value orders:");
	for await (const order of db.orders.query({
		populate: { user: true },
		where: {
			total: { $gte: 200 },
			createdAt: { $contains: "2024-02" }, // Would use proper date comparison
			status: { $ne: "cancelled" },
		},
	})) {
		if (order.user) {
			console.log(
				`   $${order.total} order by ${order.user.name} on ${order.createdAt}`,
			);
		}
	}

	// Pattern 3: User permission filtering
	console.log("\n3. Permission Pattern - Active users in specific companies:");
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			isActive: true,
			company: {
				industry: { $in: ["Technology", "Healthcare"] },
			},
		},
	})) {
		if (user.company) {
			console.log(`   ${user.name} (${user.company.industry})`);
		}
	}

	// Pattern 4: Inventory management
	console.log("\n4. Inventory Pattern - Low stock electronics:");
	for await (const product of db.products.query({
		populate: { category: true },
		where: {
			inStock: false,
			category: {
				name: "Electronics",
			},
		},
	})) {
		if (product.category) {
			console.log(
				`   Out of stock: ${product.name} in ${product.category.name}`,
			);
		}
	}

	// Pattern 5: Customer segmentation
	console.log("\n5. Segmentation Pattern - High-value customers:");
	for await (const user of db.users.query({
		populate: { orders: true },
		where: {
			orders: {
				$some: {
					total: { $gt: 500 },
				},
			},
		},
	})) {
		const highValueOrders = user.orders.filter((o) => o.total > 500);
		console.log(
			`   VIP customer: ${user.name} (${highValueOrders.length} high-value orders)`,
		);
	}
}

// ============================================================================
// TYPE HELPER EXAMPLES
// ============================================================================

export function demonstrateTypeHelpers() {
	console.log("=== TYPE HELPER UTILITIES ===\n");

	// 1. TypedPopulate for specific collections
	type UserPopulateOptions = TypedPopulate<typeof db, "users">;
	// This generates: { company?: true | CompanyPopulateConfig, orders?: true | OrderPopulateConfig }

	type ProductPopulateOptions = TypedPopulate<typeof db, "products">;
	// This generates: { category?: true | CategoryPopulateConfig, orderItems?: true | OrderItemPopulateConfig }

	// 2. Using these in functions for better type safety
	async function getPopulatedUsers<T extends UserPopulateOptions>(
		populateConfig: T,
	) {
		const results = [];
		for await (const user of db.users.query({ populate: populateConfig })) {
			results.push(user);
		}
		return results;
	}

	// Usage examples:
	const usersWithCompany = getPopulatedUsers({ company: true });
	const usersWithOrders = getPopulatedUsers({ orders: true });
	const usersWithBoth = getPopulatedUsers({ company: true, orders: true });

	console.log("✅ Type helpers provide:");
	console.log("   • TypedPopulate for collection-specific populate options");
	console.log("   • Compile-time validation of populate configurations");
	console.log("   • Better IntelliSense for complex populate patterns");
	console.log("   • Reusable type definitions for functions");
}

// ============================================================================
// PERFORMANCE CONSIDERATIONS
// ============================================================================

export function demonstratePerformanceConsiderations() {
	console.log("=== PERFORMANCE BEST PRACTICES ===\n");

	console.log("✅ RECOMMENDED Patterns:");
	console.log("   • Filter on indexed fields (usually id, foreign keys)");
	console.log("   • Use specific operators instead of broad searches");
	console.log("   • Combine filters to reduce result sets early");
	console.log("   • Populate only required relationships");
	console.log("   • Use $in/$nin for multiple value matching");

	console.log("\n⚠️  CONSIDER Carefully:");
	console.log("   • Deep nested filtering (multiple relationship levels)");
	console.log("   • $contains on large text fields");
	console.log("   • $some/$every/$none on large arrays");
	console.log("   • Complex multi-condition filters");

	console.log("\n🔧 OPTIMIZATION Tips:");
	console.log("   • Structure relationships to minimize deep nesting");
	console.log("   • Use explicit foreign keys for clearer relationships");
	console.log("   • Consider caching for frequently accessed data");
	console.log("   • Profile queries in development");
}

// ============================================================================
// RUN ALL EXAMPLES
// ============================================================================

export async function runAllFilteringExamples() {
	console.log("🎯 DATABASE v2 COMPLETE FILTERING GUIDE\n");
	console.log(
		"This demonstrates all filtering capabilities with type safety.\n",
	);

	await demonstrateBasicFiltering();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateStringOperators();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateNumericOperators();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateArrayOperators();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateRelationshipFiltering();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateInverseRelationshipFiltering();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateComplexNestedFiltering();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateTypeIntelliSense();
	console.log("\n" + "=".repeat(60) + "\n");

	await demonstrateCommonPatterns();
	console.log("\n" + "=".repeat(60) + "\n");

	demonstrateTypeHelpers();
	console.log("\n" + "=".repeat(60) + "\n");

	demonstratePerformanceConsiderations();

	console.log(
		"\n🎉 COMPLETE! Database v2 filtering system ready for production use.",
	);
}

// Run examples if this file is executed directly
// Uncomment the line below to run examples:
// runAllFilteringExamples().catch(console.error);

// ============================================================================
// EXPORT FOR TESTING
// ============================================================================

export { db, config, data };
