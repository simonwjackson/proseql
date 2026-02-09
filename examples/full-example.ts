import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type {
	GenerateDatabase,
	TypedPopulate,
	PopulateConfig,
	DatasetFor,
} from "../core/types/types";

// ============================================================================
// Usage Example - Everything Just Works!
// ============================================================================

// Define schemas as variables (for reusability and clarity)
const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	companyId: z.string(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	industryId: z.string(),
});

const IndustrySchema = z.object({
	id: z.string(),
	name: z.string(),
	sector: z.string(),
});

const OrderSchema = z.object({
	id: z.string(),
	userId: z.string(),
	productId: z.string(),
	quantity: z.number(),
	createdAt: z.string(),
});

const ProductSchema = z.object({
	id: z.string(),
	name: z.string(),
	price: z.number(),
	categoryId: z.string(),
});

const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
});

const ReviewSchema = z.object({
	id: z.string(),
	productId: z.string(),
	userId: z.string(),
	rating: z.number(),
	comment: z.string(),
});

const OrderItemSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	productId: z.string(),
	quantity: z.number(),
	price: z.number(),
});

const TagSchema = z.object({
	id: z.string(),
	name: z.string(),
	color: z.string(),
});

const ProductTagSchema = z.object({
	id: z.string(),
	productId: z.string(),
	tagId: z.string(),
});

// Define everything in one place using the schema variables
const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" },
			orders: { type: "inverse" as const, target: "orders" }, // hasMany
			reviews: { type: "inverse" as const, target: "reviews" }, // hasMany
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			industry: { type: "ref" as const, target: "industries" },
			employees: { type: "inverse" as const, target: "users" }, // hasMany
		},
	},
	industries: {
		schema: IndustrySchema,
		relationships: {
			companies: { type: "inverse" as const, target: "companies" }, // hasMany
		},
	},
	orders: {
		schema: OrderSchema,
		relationships: {
			user: { type: "ref" as const, target: "users" },
			items: { type: "inverse" as const, target: "orderItems" }, // hasMany
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
			reviews: { type: "inverse" as const, target: "reviews" }, // hasMany
			orderItems: { type: "inverse" as const, target: "orderItems" }, // hasMany
		},
	},
	categories: {
		schema: CategorySchema,
		relationships: {
			products: { type: "inverse" as const, target: "products" }, // hasMany
		},
	},
	reviews: {
		schema: ReviewSchema,
		relationships: {
			product: { type: "ref" as const, target: "products" },
			user: { type: "ref" as const, target: "users" },
		},
	},
	tags: {
		schema: TagSchema,
		relationships: {
			productTags: { type: "inverse" as const, target: "productTags" },
		},
	},
	productTags: {
		schema: ProductTagSchema,
		relationships: {
			product: { type: "ref" as const, target: "products" },
			tag: { type: "ref" as const, target: "tags" },
		},
	},
} as const;

// ============================================================================
// Mock Dataset
// ============================================================================

// Type the dataset to match the schemas
const mockData: DatasetFor<typeof dbConfig> = {
	industries: [
		{ id: "i1", name: "Technology", sector: "Technology" },
		{ id: "i2", name: "Healthcare", sector: "Healthcare" },
		{ id: "i3", name: "Finance", sector: "Finance" },
	],

	companies: [
		{ id: "c1", name: "TechCorp", industryId: "i1" },
		{ id: "c2", name: "HealthPlus", industryId: "i2" },
		{ id: "c3", name: "TechStart", industryId: "i1" },
		{ id: "c4", name: "FinanceFirst", industryId: "i3" },
	],

	users: [
		{
			id: "u1",
			name: "John Smith",
			email: "john@example.com",
			companyId: "c1",
		},
		{ id: "u2", name: "Jane Doe", email: "jane@example.com", companyId: "c1" },
		{
			id: "u3",
			name: "Johnny Test",
			email: "johnny@test.com",
			companyId: "c2",
		},
		{ id: "u4", name: "Bob Wilson", email: "bob@finance.com", companyId: "c4" },
		{
			id: "u5",
			name: "John Adams",
			email: "jadams@startup.com",
			companyId: "c3",
		},
	],

	categories: [
		{ id: "cat1", name: "Electronics" },
		{ id: "cat2", name: "Books" },
		{ id: "cat3", name: "Clothing" },
		{ id: "cat4", name: "Home & Garden" },
	],

	products: [
		{ id: "p1", name: "Electronics Widget", price: 99.99, categoryId: "cat1" },
		{ id: "p2", name: "Programming Book", price: 45.0, categoryId: "cat2" },
		{ id: "p3", name: "Smart Phone", price: 599.99, categoryId: "cat1" },
		{ id: "p4", name: "T-Shirt", price: 25.99, categoryId: "cat3" },
		{ id: "p5", name: "Electronics Gadget", price: 150.0, categoryId: "cat1" },
		{ id: "p6", name: "Garden Tool", price: 75.5, categoryId: "cat4" },
	],

	orders: [
		{
			id: "o1",
			userId: "u1",
			productId: "p1",
			quantity: 2,
			createdAt: "2024-01-01",
		},
		{
			id: "o2",
			userId: "u1",
			productId: "p3",
			quantity: 1,
			createdAt: "2024-01-15",
		},
		{
			id: "o3",
			userId: "u2",
			productId: "p2",
			quantity: 3,
			createdAt: "2024-02-01",
		},
		{
			id: "o4",
			userId: "u3",
			productId: "p4",
			quantity: 2,
			createdAt: "2024-02-10",
		},
		{
			id: "o5",
			userId: "u5",
			productId: "p5",
			quantity: 1,
			createdAt: "2024-01-20",
		},
		{
			id: "o6",
			userId: "u1",
			productId: "p6",
			quantity: 1,
			createdAt: "2024-03-01",
		},
	],

	orderItems: [
		{ id: "oi1", orderId: "o1", productId: "p1", quantity: 2, price: 99.99 },
		{ id: "oi2", orderId: "o2", productId: "p3", quantity: 1, price: 599.99 },
		{ id: "oi3", orderId: "o3", productId: "p2", quantity: 3, price: 45.0 },
		{ id: "oi4", orderId: "o4", productId: "p4", quantity: 2, price: 25.99 },
		{ id: "oi5", orderId: "o5", productId: "p5", quantity: 1, price: 150.0 },
		{ id: "oi6", orderId: "o6", productId: "p6", quantity: 1, price: 75.5 },
	],

	reviews: [
		{
			id: "r1",
			productId: "p1",
			userId: "u1",
			rating: 5,
			comment: "Great product!",
		},
		{
			id: "r2",
			productId: "p1",
			userId: "u2",
			rating: 4,
			comment: "Very good quality",
		},
		{
			id: "r3",
			productId: "p3",
			userId: "u3",
			rating: 5,
			comment: "Love this phone!",
		},
		{
			id: "r4",
			productId: "p2",
			userId: "u4",
			rating: 3,
			comment: "Good book but expensive",
		},
		{
			id: "r5",
			productId: "p5",
			userId: "u5",
			rating: 4,
			comment: "Nice electronics gadget",
		},
	],

	tags: [
		{ id: "t1", name: "premium", color: "gold" },
		{ id: "t2", name: "mobile", color: "blue" },
		{ id: "t3", name: "educational", color: "green" },
		{ id: "t4", name: "fashion", color: "pink" },
		{ id: "t5", name: "outdoor", color: "brown" },
	],

	productTags: [
		{ id: "pt1", productId: "p1", tagId: "t1" }, // Electronics Widget -> premium
		{ id: "pt2", productId: "p2", tagId: "t3" }, // Programming Book -> educational
		{ id: "pt3", productId: "p3", tagId: "t1" }, // Smart Phone -> premium
		{ id: "pt4", productId: "p3", tagId: "t2" }, // Smart Phone -> mobile
		{ id: "pt5", productId: "p4", tagId: "t4" }, // T-Shirt -> fashion
		{ id: "pt6", productId: "p5", tagId: "t1" }, // Electronics Gadget -> premium
		{ id: "pt7", productId: "p6", tagId: "t5" }, // Garden Tool -> outdoor
	],
};

// THE RESULT: Database type automatically generated from single config!

async function demonstrateUsage(db: GenerateDatabase<typeof dbConfig>) {
	console.log("=== TYPE-SAFE POPULATE EXAMPLES ===");

	// The PopulateConfig type provides type-safe populate configurations:
	type UserPopulateConfig = TypedPopulate<typeof db, "users">;
	// Valid configs: { company: true } | { orders: true } | { company: { industry: true } } | etc...

	type OrderPopulateConfig = TypedPopulate<typeof db, "orders">;
	// Valid configs: { user: true } | { items: true } | { user: { company: true } } | etc...

	// You can use these types for validation in your own code:
	const validUserConfig1: UserPopulateConfig = { company: true }; // ✅ Valid
	const validUserConfig2: UserPopulateConfig = { orders: true }; // ✅ Valid
	const validOrderConfig1: OrderPopulateConfig = { user: true }; // ✅ Valid
	const validOrderConfig2: OrderPopulateConfig = { items: true }; // ✅ Valid
	// Complex nested configs are also fully type-safe
	const validNestedConfig: UserPopulateConfig = {
		company: { industry: true },
		orders: { items: { product: true } },
	}; // ✅ Valid

	console.log("=== FILTERING EXAMPLES ===");

	console.log("\n=== Basic Field Filtering ===");
	// Filter by exact match
	for await (const user of db.users.query({
		where: {
			name: "John Smith",
		},
	})) {
		console.log(`Found user: ${user.name}`);
	}

	// Filter with operators
	for await (const user of db.users.query({
		where: {
			name: { $startsWith: "John" },
			email: { $contains: "@example.com" },
		},
	})) {
		console.log(`User matching filter: ${user.name} (${user.email})`);
	}

	console.log("\n=== Filtering on Related Entities (ref) ===");
	// Filter on populated company
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			company: {
				name: { $startsWith: "Tech" },
			},
		},
	})) {
		if (user.company) {
			console.log(`${user.name} works at ${user.company.name}`);
		}
	}

	console.log("\n=== Filtering on hasMany Relationships ===");
	// Filter users who have some orders matching criteria
	for await (const user of db.users.query({
		populate: { orders: true },
		where: {
			orders: {
				$some: {
					quantity: { $gte: 2 },
				},
			},
		},
	})) {
		console.log(`${user.name} has orders with quantity >= 2`);
		for (const order of user.orders) {
			console.log(`  Order ${order.id}: quantity ${order.quantity}`);
		}
	}

	console.log("\n=== Deep Nested Filtering ===");
	// The example from the requirements - showing type safety with where clause structure
	for await (const order of db.orders.query({
		populate: {
			user: {
				company: true,
			},
			items: {
				product: {
					category: true,
				},
			},
		},
		where: {
			user: {
				name: { $startsWith: "John" },
				orders: {
					$some: {
						quantity: { $gte: 1 },
						items: {
							$some: {
								product: {
									category: {
										name: { $startsWith: "Electronics" },
									},
								},
							},
						},
					},
				},
			},
		},
	})) {
		// Populated fields are properly typed
		console.log(`Order ${order.id} with nested data`);
		if (order.user?.company) {
			console.log(`  User company industry: ${order.user.company.industryId}`);
		}
		if (order.items) {
			order.items.forEach((item) => {
				if (item.product?.category) {
					console.log(`  Item category: ${item.product.category.name}`);
				}
			});
		}
	}

	console.log("\n=== Multiple Filter Operators ===");
	// Numeric comparisons
	for await (const product of db.products.query({
		where: {
			price: { $gte: 50, $lte: 200 },
			name: { $contains: "Widget" },
		},
	})) {
		console.log(`${product.name}: $${product.price}`);
	}

	// Array operators
	for await (const product of db.products.query({
		where: {
			categoryId: { $in: ["cat1", "cat2", "cat3"] },
		},
	})) {
		console.log(`Product in selected categories: ${product.name}`);
	}

	console.log("\n=== Explicit Foreign Key Examples ===");
	// The system automatically infers foreign keys, but you can also be explicit
	// Foreign key relationships are referenced by the field ending in "Id"

	// Example 1: Users -> Companies (foreign key: companyId)
	for await (const user of db.users.query({
		populate: { company: true },
		where: {
			// Filter users by their company's properties
			company: {
				name: { $startsWith: "Tech" },
			},
		},
	})) {
		if (user.company) {
			console.log(
				`${user.name} works at ${user.company.name} (via companyId: ${user.companyId})`,
			);
		}
	}

	// Example 2: Orders -> Users (foreign key: userId)
	for await (const order of db.orders.query({
		populate: { user: true },
		where: {
			user: {
				email: { $contains: "@example.com" },
			},
		},
	})) {
		if (order.user) {
			console.log(
				`Order ${order.id} belongs to ${order.user.name} (via userId: ${order.userId})`,
			);
		}
	}

	// Example 3: Many-to-Many via Junction Table (ProductTags)
	// Products have tags through the productTags junction table
	for await (const product of db.products.query({
		populate: {
			// First get the junction records
			// Note: This would need to be implemented as orderItems are to orders
		},
	})) {
		console.log(`Product: ${product.name}`);
		// In a real implementation, you'd navigate: product -> productTags -> tags
	}

	console.log("\n=== All Supported Filter Operators ===");

	// String operators
	console.log("String operators:");
	for await (const user of db.users.query({
		where: {
			name: { $startsWith: "John" }, // Starts with
			email: { $endsWith: ".com" }, // Ends with
			// name: { $contains: "oh" },       // Contains substring
		},
	})) {
		console.log(`  ${user.name} - ${user.email}`);
	}

	// Numeric operators
	console.log("Numeric operators:");
	for await (const product of db.products.query({
		where: {
			price: {
				$gt: 50, // Greater than
				$lte: 200, // Less than or equal
			},
		},
	})) {
		console.log(`  ${product.name}: $${product.price}`);
	}

	// Array operators
	console.log("Array operators:");
	for await (const product of db.products.query({
		where: {
			categoryId: { $in: ["cat1", "cat3"] }, // Value in array
			// categoryId: { $nin: ["cat2"] },        // Value not in array
		},
	})) {
		console.log(`  ${product.name} in selected categories`);
	}

	// Equality operators (work with all types)
	console.log("Equality operators:");
	for await (const order of db.orders.query({
		where: {
			quantity: { $eq: 1 }, // Explicit equality
			// quantity: { $ne: 2 },     // Not equal
		},
	})) {
		console.log(`  Order ${order.id} with quantity ${order.quantity}`);
	}

	console.log("\n=== Complex Nested Query with All Features ===");
	// Combining population and complex filtering
	for await (const company of db.companies.query({
		populate: {
			employees: {
				orders: {
					items: {
						product: true,
					},
				},
			},
		},
		where: {
			industry: {
				sector: { $eq: "Technology" },
			},
			employees: {
				$some: {
					name: { $startsWith: "J" },
					orders: {
						$some: {
							createdAt: { $contains: "2024" },
							items: {
								$some: {
									quantity: { $gte: 2 },
									product: {
										price: { $lte: 100 },
									},
								},
							},
						},
					},
				},
			},
		},
	})) {
		console.log(`Company ${company.name} matching complex filters`);
		// The populated data would be available based on the populate path
		// In this case: employees.orders.items.product
		// Real implementation would have the nested data properly typed and accessible
	}

	console.log("\n=== ORIGINAL EXAMPLES (Still Working) ===");
	console.log("=== Single Field Population (ref) ===");
	// Type-safe queries with full IntelliSense
	for await (const user of db.users.query({ populate: { company: true } })) {
		if (user.company) {
			console.log(`${user.name} works at ${user.company.name}`);
		}
	}

	console.log("\n=== Single Field Population (hasMany/inverse) ===");
	// Populating hasMany relationships returns arrays
	for await (const user of db.users.query({ populate: { orders: true } })) {
		console.log(`${user.name} has ${user.orders.length} orders`);
		// user.orders is Order[] - fully typed!
	}

	console.log("\n=== Multiple hasMany Relationships ===");
	for await (const product of db.products.query({
		populate: { reviews: true, orderItems: true },
	})) {
		console.log(`${product.name}`);
		// Populated arrays would be available in real implementation
	}

	console.log("\n=== Nested Population with hasMany ===");
	// Nested paths through hasMany relationships
	for await (const category of db.categories.query({
		populate: { products: { reviews: true } },
	})) {
		console.log(`Category: ${category.name}`);
		// Nested populated data would be typed correctly
	}

	console.log("\n=== Complex Mixed Relationships ===");
	for await (const order of db.orders.query({
		populate: {
			user: { company: true },
			items: { product: { category: true } },
		},
	})) {
		console.log(`Order ${order.id} with populated nested data`);
		// Populated data would be properly typed in real implementation
	}

	console.log("\n=== Deep Nesting Through Multiple hasMany ===");
	for await (const company of db.companies.query({
		populate: { employees: { orders: { items: true } } },
	})) {
		console.log(`${company.name} with deeply nested populated data`);
		// Nested arrays would be available in real implementation
	}
}

// Create database with single line!
const db = createDatabase(dbConfig, mockData);

// ============================================================================
// The Beauty of This Approach
// ============================================================================

console.log(`
SINGLE SOURCE OF TRUTH BENEFITS:

✅ Define everything in ONE place (dbConfig)
✅ Schemas and relationships together
✅ Database type automatically generated
✅ No manual type mapping anywhere
✅ Full type safety and IntelliSense
✅ Relationships use string references (easier to maintain)

FILTERING FEATURES:

✅ Basic field filtering with exact match or operators
✅ String operators: $eq, $ne, $startsWith, $endsWith, $contains, $in, $nin
✅ Number operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin
✅ Boolean operators: $eq, $ne
✅ Filtering on populated relationships (both ref and inverse)
✅ Array relationship operators: $some, $every, $none
✅ Deep nested filtering through multiple relationships
✅ Combining filtering with population
✅ Full type safety - IntelliSense knows valid fields and operators

POPULATE PATH VALIDATION:

✅ Type-safe populate paths with IntelliSense
✅ ValidPopulatePath generates all valid relationship paths
✅ Compile-time checking for invalid populate strings
✅ Helper types for extracting valid paths for any collection

The user only needs to:
1. Define the dbConfig object with schemas and relationships
2. Call createDatabase(dbConfig)
3. Use query() with where clauses for filtering
4. Use populate with type-safe path validation

That's it! The type system handles everything else.

Compare to the previous approach:
- Before: Define schemas, types, relationships, AND database type separately
- Now: Just define dbConfig - everything else is automatic!
`);

// Test it
demonstrateUsage(db).catch(console.error);

// ============================================================================
// Type Safety Demonstration
// ============================================================================

// The PopulateConfig type provides IntelliSense for all valid configurations:
type AllEntities = ExtractEntityTypes<typeof dbConfig>;
type ExampleConfigs = {
	// All valid user populate configs
	userConfigs: PopulateConfig<
		ResolveRelationships<typeof dbConfig.users.relationships, AllEntities>,
		GenerateDatabase<typeof dbConfig>
	>;
	// Examples: { company: true } | { orders: true } | { company: { industry: true } } | etc...

	// All valid order populate configs
	orderConfigs: PopulateConfig<
		ResolveRelationships<typeof dbConfig.orders.relationships, AllEntities>,
		GenerateDatabase<typeof dbConfig>
	>;
	// Examples: { user: true } | { items: true } | { user: { company: true } } | etc...

	// All valid product populate configs
	productConfigs: PopulateConfig<
		ResolveRelationships<typeof dbConfig.products.relationships, AllEntities>,
		GenerateDatabase<typeof dbConfig>
	>;
	// Examples: { category: true } | { reviews: true } | { reviews: { user: true } } | etc...
};

// You can use these types in your application for type-safe populate configs:
import { ResolveRelationships, ExtractEntityTypes } from "../core/types/types";
type UserRelations = ResolveRelationships<
	typeof dbConfig.users.relationships,
	ExtractEntityTypes<typeof dbConfig>
>;
function getPopulatedUser<
	P extends PopulateConfig<UserRelations, GenerateDatabase<typeof dbConfig>>,
>(config: P) {
	return db.users.query({ populate: config });
}

// Examples of valid usage:
getPopulatedUser({ company: true }); // ✅ Valid
getPopulatedUser({ orders: true }); // ✅ Valid
getPopulatedUser({ reviews: true }); // ✅ Valid
getPopulatedUser({ company: { industry: true }, orders: { items: true } }); // ✅ Valid nested config
// All configurations are fully type-safe with proper IntelliSense support
