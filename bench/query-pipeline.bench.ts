/**
 * Query Pipeline Stage Benchmarks
 *
 * Measures ops/sec and latency percentiles for query pipeline stages:
 * - filter: Simple equality, range ($gt, $lt), compound (multiple conditions)
 * - sort: Single-field, multi-field
 * - population: Single ref, inverse, nested (multi-collection relationships)
 * - select: Field projection
 * - paginate: Skip/take on large result sets
 * - combined: Full pipeline (filter + sort + populate + select + paginate)
 *
 * Uses a 10K-entity collection for consistent measurements.
 * Multi-collection setup with relationships for population benchmarks.
 */

import { Schema } from "effect";
import { Bench } from "tinybench";
import {
	generateUsers,
	generateProducts,
	type User,
	type Product,
} from "./generators.js";
import {
	createBenchDatabase,
	defaultBenchOptions,
	formatResultsTable,
} from "./utils.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Baseline collection size for query pipeline benchmarks.
 * 10K entities provides a realistic working set while keeping benchmark time reasonable.
 */
const BASELINE_SIZE = 10_000;

// ============================================================================
// Schemas
// ============================================================================

/**
 * User schema for benchmarking.
 * Matches the User type from generators.
 */
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	role: Schema.Union(
		Schema.Literal("admin"),
		Schema.Literal("moderator"),
		Schema.Literal("user"),
	),
	createdAt: Schema.String,
});

/**
 * Product schema for benchmarking.
 * Matches the Product type from generators.
 */
const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.Union(
		Schema.Literal("electronics"),
		Schema.Literal("clothing"),
		Schema.Literal("books"),
		Schema.Literal("home"),
		Schema.Literal("sports"),
		Schema.Literal("toys"),
	),
	stock: Schema.Number,
	supplierId: Schema.String,
});

/**
 * Order schema for relationship benchmarks.
 * References a user via userId.
 */
const OrderSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	productId: Schema.String,
	quantity: Schema.Number,
	total: Schema.Number,
	status: Schema.Union(
		Schema.Literal("pending"),
		Schema.Literal("completed"),
		Schema.Literal("cancelled"),
	),
	createdAt: Schema.String,
});

/**
 * Supplier schema for nested relationship benchmarks.
 */
const SupplierSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	country: Schema.String,
});

// ============================================================================
// Database Configuration
// ============================================================================

/**
 * Basic database configuration for filter, sort, select, paginate benchmarks.
 * Single collection without relationships.
 */
const basicDbConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role", "age"] as ReadonlyArray<string>,
		relationships: {},
	},
} as const;

/**
 * Multi-collection database configuration for population benchmarks.
 * Includes users, products, orders, and suppliers with relationships.
 */
const relationshipDbConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role"] as ReadonlyArray<string>,
		relationships: {
			orders: {
				type: "inverse" as const,
				target: "orders" as const,
			},
		},
	},
	products: {
		schema: ProductSchema,
		indexes: ["category"] as ReadonlyArray<string>,
		relationships: {
			supplier: {
				type: "ref" as const,
				target: "suppliers" as const,
				foreignKey: "supplierId",
			},
		},
	},
	orders: {
		schema: OrderSchema,
		relationships: {
			user: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "userId",
			},
			product: {
				type: "ref" as const,
				target: "products" as const,
				foreignKey: "productId",
			},
		},
	},
	suppliers: {
		schema: SupplierSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Data Generation Helpers
// ============================================================================

/**
 * Generate supplier entities for relationship benchmarks.
 * Creates a fixed set of suppliers that products reference.
 */
function generateSuppliers(count: number): ReadonlyArray<{
	readonly id: string;
	readonly name: string;
	readonly country: string;
}> {
	const countries = ["USA", "China", "Germany", "Japan", "UK", "France"];
	const suppliers: Array<{
		readonly id: string;
		readonly name: string;
		readonly country: string;
	}> = [];

	for (let i = 0; i < count; i++) {
		suppliers.push({
			id: `supplier_${String(i + 1).padStart(4, "0")}`,
			name: `Supplier ${i + 1}`,
			country: countries[i % countries.length],
		});
	}

	return suppliers;
}

/**
 * Generate order entities linking users to products.
 * Creates orders that reference existing users and products for relationship testing.
 */
function generateOrders(
	users: ReadonlyArray<User>,
	products: ReadonlyArray<Product>,
	ordersPerUser: number,
): ReadonlyArray<{
	readonly id: string;
	readonly userId: string;
	readonly productId: string;
	readonly quantity: number;
	readonly total: number;
	readonly status: "pending" | "completed" | "cancelled";
	readonly createdAt: string;
}> {
	const statuses = ["pending", "completed", "cancelled"] as const;
	const orders: Array<{
		readonly id: string;
		readonly userId: string;
		readonly productId: string;
		readonly quantity: number;
		readonly total: number;
		readonly status: "pending" | "completed" | "cancelled";
		readonly createdAt: string;
	}> = [];

	let orderIndex = 0;
	for (const user of users) {
		for (let i = 0; i < ordersPerUser; i++) {
			const product = products[orderIndex % products.length];
			const quantity = (orderIndex % 5) + 1;
			orders.push({
				id: `order_${String(orderIndex + 1).padStart(6, "0")}`,
				userId: user.id,
				productId: product.id,
				quantity,
				total: product.price * quantity,
				status: statuses[orderIndex % statuses.length],
				createdAt: new Date(2024, 0, 1 + (orderIndex % 365)).toISOString(),
			});
			orderIndex++;
		}
	}

	return orders;
}

// ============================================================================
// Benchmark Suite Export
// ============================================================================

/**
 * Benchmark suite name for identification in runner output.
 */
export const suiteName = "query-pipeline";

/**
 * Creates and configures the query pipeline benchmark suite.
 *
 * This function pre-generates test data and sets up the baseline collections.
 * Individual benchmarks are added in subsequent tasks (5.2-5.7).
 */
export async function createSuite(): Promise<Bench> {
	const bench = new Bench(defaultBenchOptions);

	// Pre-generate baseline data for basic benchmarks
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];

	// Pre-generate data for relationship benchmarks
	// Use smaller counts to keep benchmark time reasonable
	const relationshipUsers = generateUsers(1000);
	const relationshipProducts = generateProducts(500);
	const suppliers = generateSuppliers(50);
	const orders = generateOrders(
		relationshipUsers,
		relationshipProducts,
		3, // 3 orders per user = 3000 orders
	);

	// Create database instances for different benchmark categories
	// These will be used by the benchmark implementations in tasks 5.2-5.7

	// Database for filter benchmarks (10K users)
	const _filterDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	// Database for sort benchmarks (10K users)
	const _sortDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	// Database for select benchmarks (10K users)
	const _selectDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	// Database for paginate benchmarks (10K users)
	const _paginateDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	// Database for population benchmarks (multi-collection with relationships)
	const _populateDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	// Database for combined pipeline benchmarks (10K users)
	const _combinedDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	// -------------------------------------------------------------------------
	// Task 5.2: Filter benchmarks will be added here
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Task 5.3: Sort benchmarks will be added here
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Task 5.4: Population benchmarks will be added here
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Task 5.5: Select benchmark will be added here
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Task 5.6: Paginate benchmark will be added here
	// -------------------------------------------------------------------------

	// -------------------------------------------------------------------------
	// Task 5.7: Combined pipeline benchmark will be added here
	// -------------------------------------------------------------------------

	return bench;
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("Running Query Pipeline Benchmarks\n");

	const bench = await createSuite();

	if (bench.tasks.length === 0) {
		console.log(
			"No benchmarks configured yet. Benchmarks will be added in tasks 5.2-5.7.",
		);
		return;
	}

	await bench.run();

	console.log("\nResults:\n");
	console.log(formatResultsTable(bench.tasks));
}

// Run when executed directly
if (import.meta.main) {
	run();
}
