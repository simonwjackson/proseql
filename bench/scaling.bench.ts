/**
 * Collection Scaling Benchmarks
 *
 * Tests performance characteristics across different collection sizes:
 * - findById: Verifies O(1) constant-time lookup
 * - Unindexed filter: Verifies O(n) linear scaling
 * - Indexed filter: Verifies sub-linear improvement over unindexed
 *
 * Collection sizes: 100, 1K, 10K, 100K
 */

import { Schema } from "effect";
import { Bench } from "tinybench";
import {
	generateAtScale,
	generateUsers,
	STANDARD_SIZES,
} from "./generators.js";
import {
	createBenchDatabase,
	defaultBenchOptions,
	formatResultsTable,
} from "./utils.js";

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

// ============================================================================
// Types
// ============================================================================

/**
 * Database configuration without indexes (for unindexed benchmarks).
 */
const unindexedConfig = {
	users: {
		schema: UserSchema,
		relationships: {},
	},
} as const;

/**
 * Database configuration with index on 'role' field.
 */
const indexedConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role"] as ReadonlyArray<string>,
		relationships: {},
	},
} as const;

// ============================================================================
// Benchmark Suite Export
// ============================================================================

/**
 * Benchmark suite name for identification in runner output.
 */
export const suiteName = "scaling";

/**
 * Creates and configures the scaling benchmark suite.
 *
 * This function pre-generates all test data to ensure benchmarks
 * measure only the operation time, not data generation time.
 */
export async function createSuite(): Promise<Bench> {
	const bench = new Bench(defaultBenchOptions);

	// Pre-generate data for all sizes
	const usersBySize = generateAtScale(generateUsers);

	// Pre-create databases for each size and config type
	// We'll create databases on the fly in each benchmark because
	// tinybench runs async setup correctly.

	// For each standard size, add benchmarks
	for (const size of STANDARD_SIZES) {
		const users = usersBySize.get(size);
		if (!users) {
			throw new Error(`No users generated for size ${size}`);
		}

		// Convert ReadonlyArray to mutable array for database initialization
		const usersArray = [...users];

		// Select IDs for testing - spread evenly across the dataset
		// to avoid cache locality effects
		const testIds = [
			usersArray[0].id, // first
			usersArray[Math.floor(usersArray.length / 4)].id, // 25%
			usersArray[Math.floor(usersArray.length / 2)].id, // 50%
			usersArray[Math.floor((usersArray.length * 3) / 4)].id, // 75%
			usersArray[usersArray.length - 1].id, // last
		];

		// Cycle through test IDs to vary lookups
		let idIndex = 0;
		const getNextId = (): string => {
			const id = testIds[idIndex % testIds.length];
			idIndex++;
			return id;
		};

		// Format size for display: 100 → "100", 1000 → "1K", etc.
		const sizeLabel = size >= 1000 ? `${size / 1000}K` : String(size);

		// ---------------------------------------------------------------------
		// findById Benchmark
		// ---------------------------------------------------------------------

		// Create database for findById (no indexes needed - it uses ID map)
		const findByIdDb = await createBenchDatabase(unindexedConfig, {
			users: usersArray,
		});

		bench.add(`findById @ ${sizeLabel}`, async () => {
			await findByIdDb.users.findById(getNextId()).runPromise;
		});

		// ---------------------------------------------------------------------
		// Unindexed Filter Benchmark (filter on 'age' - not indexed)
		// ---------------------------------------------------------------------

		const unindexedDb = await createBenchDatabase(unindexedConfig, {
			users: usersArray,
		});

		// Filter for users in a specific age range
		// Using a range query ensures we scan the full collection
		bench.add(`unindexed filter @ ${sizeLabel}`, async () => {
			await unindexedDb.users.query({
				where: { age: { $gte: 25, $lte: 35 } },
			}).runPromise;
		});

		// ---------------------------------------------------------------------
		// Indexed Filter Benchmark (filter on 'role' - indexed)
		// ---------------------------------------------------------------------

		const indexedDb = await createBenchDatabase(indexedConfig, {
			users: usersArray,
		});

		// Filter for users with a specific role
		// With index, this should be sub-linear (O(matches) + O(1) lookup)
		bench.add(`indexed filter @ ${sizeLabel}`, async () => {
			await indexedDb.users.query({
				where: { role: "admin" },
			}).runPromise;
		});
	}

	return bench;
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("🚀 Running Collection Scaling Benchmarks\n");

	const bench = await createSuite();
	await bench.run();

	console.log("\nResults:\n");
	console.log(formatResultsTable(bench.tasks));
}

// Run when executed directly
if (import.meta.main) {
	run();
}
