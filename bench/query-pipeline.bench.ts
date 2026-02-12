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
	// Task 5.2: Filter benchmarks
	// -------------------------------------------------------------------------

	// Filter benchmark: Simple equality filter
	// Tests filtering on a single field with exact match.
	// Uses an indexed field (role) for realistic performance.
	const filterEqualityDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("filter: equality (role = 'admin')", async () => {
		await filterEqualityDb.users.query({
			where: { role: "admin" },
		}).runPromise;
	});

	// Filter benchmark: Range filter ($gt, $lt)
	// Tests filtering on a numeric field with range operators.
	// Uses an indexed field (age) for realistic performance.
	const filterRangeDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("filter: range (age > 30 AND age < 50)", async () => {
		await filterRangeDb.users.query({
			where: { age: { $gt: 30, $lt: 50 } },
		}).runPromise;
	});

	// Filter benchmark: Compound filter (multiple conditions)
	// Tests filtering with multiple conditions combined using $and.
	// This exercises more complex predicate evaluation.
	const filterCompoundDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("filter: compound ($and with 3 conditions)", async () => {
		await filterCompoundDb.users.query({
			where: {
				$and: [
					{ role: { $in: ["admin", "moderator"] } },
					{ age: { $gte: 25, $lte: 60 } },
					{ name: { $contains: "a" } },
				],
			},
		}).runPromise;
	});

	// -------------------------------------------------------------------------
	// Task 5.3: Sort benchmarks
	// -------------------------------------------------------------------------

	// Sort benchmark: Single-field sort
	// Tests sorting on a single field in ascending order.
	// This exercises the sort stage of the query pipeline.
	const sortSingleDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("sort: single-field (age asc)", async () => {
		await sortSingleDb.users.query({
			sort: { age: "asc" },
		}).runPromise;
	});

	// Sort benchmark: Single-field sort descending
	// Tests sorting on a single field in descending order.
	const sortSingleDescDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("sort: single-field (age desc)", async () => {
		await sortSingleDescDb.users.query({
			sort: { age: "desc" },
		}).runPromise;
	});

	// Sort benchmark: Multi-field sort
	// Tests sorting on multiple fields (primary and secondary sort keys).
	// This exercises more complex comparison logic in the sort stage.
	const sortMultiDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("sort: multi-field (role asc, age desc)", async () => {
		await sortMultiDb.users.query({
			sort: { role: "asc", age: "desc" },
		}).runPromise;
	});

	// Sort benchmark: Multi-field sort with 3 keys
	// Tests sorting with three sort keys to measure cost of additional sort dimensions.
	const sortTripleDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("sort: multi-field (role asc, age desc, name asc)", async () => {
		await sortTripleDb.users.query({
			sort: { role: "asc", age: "desc", name: "asc" },
		}).runPromise;
	})

	// -------------------------------------------------------------------------
	// Task 5.4: Population benchmarks
	// -------------------------------------------------------------------------

	// Population benchmark: Single ref population
	// Tests populating a single ref relationship (order → user).
	// This measures the overhead of joining entities via foreign key lookup.
	const populateSingleRefDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	bench.add("populate: single ref (order → user)", async () => {
		await populateSingleRefDb.orders.query({
			where: { status: "completed" },
			populate: { user: true },
		}).runPromise;
	});

	// Population benchmark: Inverse population
	// Tests populating an inverse relationship (user → orders).
	// Inverse relationships require scanning the related collection for matching foreign keys.
	const populateInverseDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	bench.add("populate: inverse (user → orders)", async () => {
		await populateInverseDb.users.query({
			where: { role: "admin" },
			populate: { orders: true },
		}).runPromise;
	});

	// Population benchmark: Nested population (2 levels)
	// Tests populating nested relationships (order → user → orders).
	// This measures the cost of recursive population through multiple relationship hops.
	const populateNestedDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	bench.add("populate: nested 2-level (order → user → orders)", async () => {
		await populateNestedDb.orders.query({
			where: { status: "completed" },
			populate: {
				user: {
					orders: true,
				},
			},
		}).runPromise;
	});

	// Population benchmark: Multiple relationships
	// Tests populating multiple relationships in a single query (order → user + order → product).
	// This measures the overhead of parallel relationship resolution.
	const populateMultipleDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	bench.add("populate: multiple refs (order → user, product)", async () => {
		await populateMultipleDb.orders.query({
			where: { status: "completed" },
			populate: {
				user: true,
				product: true,
			},
		}).runPromise;
	});

	// Population benchmark: Nested with ref chain (3 levels)
	// Tests populating through a chain of ref relationships (order → product → supplier).
	// This exercises deep nested population through refs.
	const populateDeepRefDb = await createBenchDatabase(relationshipDbConfig, {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	});

	bench.add("populate: nested 3-level (order → product → supplier)", async () => {
		await populateDeepRefDb.orders.query({
			where: { status: "pending" },
			populate: {
				product: {
					supplier: true,
				},
			},
		}).runPromise;
	});

	// -------------------------------------------------------------------------
	// Task 5.5: Select benchmarks
	// -------------------------------------------------------------------------

	// Select benchmark: Single field projection
	// Tests selecting just one field from entities.
	// Measures the overhead of field projection vs returning full entities.
	const selectSingleDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: single field (name)", async () => {
		await selectSingleDb.users.query({
			select: ["name"],
		}).runPromise;
	});

	// Select benchmark: Few fields projection
	// Tests selecting a small subset of fields (2 fields).
	// Typical use case for list views that only need display fields.
	const selectFewDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: few fields (id, name)", async () => {
		await selectFewDb.users.query({
			select: ["id", "name"],
		}).runPromise;
	});

	// Select benchmark: Multiple fields projection
	// Tests selecting about half the available fields (3 of 6 fields).
	// Common pattern for partial entity loading.
	const selectMultipleDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: multiple fields (id, name, email)", async () => {
		await selectMultipleDb.users.query({
			select: ["id", "name", "email"],
		}).runPromise;
	});

	// Select benchmark: Most fields projection
	// Tests selecting most fields (5 of 6 fields).
	// Measures when projection cost approaches full entity retrieval.
	const selectMostDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: most fields (id, name, email, age, role)", async () => {
		await selectMostDb.users.query({
			select: ["id", "name", "email", "age", "role"],
		}).runPromise;
	});

	// Select benchmark: No projection (baseline)
	// Returns full entities without field projection.
	// This is the baseline to compare projection overhead against.
	const selectNoneDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: no projection (all fields)", async () => {
		await selectNoneDb.users.query({}).runPromise;
	});

	// Select benchmark: With filter (combined operation)
	// Tests field projection combined with filtering.
	// Measures whether projection adds significant overhead to filtered queries.
	const selectWithFilterDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("select: with filter (name, email WHERE role='admin')", async () => {
		await selectWithFilterDb.users.query({
			where: { role: "admin" },
			select: ["name", "email"],
		}).runPromise;
	});

	// -------------------------------------------------------------------------
	// Task 5.6: Paginate benchmarks
	// -------------------------------------------------------------------------

	// Paginate benchmark: Small limit from beginning
	// Tests taking a small slice from the start of the result set.
	// This is the common case for first-page retrieval.
	const paginateSmallBeginDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 10 from beginning", async () => {
		await paginateSmallBeginDb.users.query({
			limit: 10,
		}).runPromise;
	});

	// Paginate benchmark: Small limit from middle
	// Tests taking a small slice from the middle of a large result set.
	// Common for paginating through results (e.g., page 500 of 1000).
	const paginateSmallMiddleDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 10, offset 5000 (middle)", async () => {
		await paginateSmallMiddleDb.users.query({
			offset: 5000,
			limit: 10,
		}).runPromise;
	});

	// Paginate benchmark: Small limit from end
	// Tests taking a small slice from near the end of the result set.
	// This exercises the worst-case offset scenario.
	const paginateSmallEndDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 10, offset 9990 (end)", async () => {
		await paginateSmallEndDb.users.query({
			offset: 9990,
			limit: 10,
		}).runPromise;
	});

	// Paginate benchmark: Larger page size
	// Tests taking a larger slice (100 items).
	// Measures the cost of extracting more items per page.
	const paginateLargerPageDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 100, offset 500", async () => {
		await paginateLargerPageDb.users.query({
			offset: 500,
			limit: 100,
		}).runPromise;
	});

	// Paginate benchmark: With sort (realistic scenario)
	// Tests pagination combined with sorting.
	// This is the typical pagination use case - sorted results with skip/take.
	const paginateSortedDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 10, offset 1000 with sort", async () => {
		await paginateSortedDb.users.query({
			sort: { age: "desc" },
			offset: 1000,
			limit: 10,
		}).runPromise;
	});

	// Paginate benchmark: With filter (filtered pagination)
	// Tests pagination on a filtered subset.
	// Offset/limit apply after filtering, so this tests skipping over filtered results.
	const paginateFilteredDb = await createBenchDatabase(basicDbConfig, {
		users: usersArray,
	});

	bench.add("paginate: limit 10, offset 500 with filter", async () => {
		await paginateFilteredDb.users.query({
			where: { role: "admin" },
			offset: 500,
			limit: 10,
		}).runPromise;
	});

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
