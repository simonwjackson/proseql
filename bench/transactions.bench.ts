/**
 * Transaction Overhead Benchmarks
 *
 * Measures the overhead of running operations inside vs outside transactions:
 * - Direct execution: Run create/update/delete without transaction wrapper
 * - Transactional execution: Same operations inside a $transaction
 * - Overhead delta: Compare the two to quantify transaction cost
 *
 * Uses a 10K-entity baseline collection for consistent measurements.
 */

import { Schema } from "effect";
import { Bench } from "tinybench";
import {
	generateUsers,
	type User,
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
 * Baseline collection size for transaction benchmarks.
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

// ============================================================================
// Database Configuration
// ============================================================================

/**
 * Database configuration for transaction benchmarks.
 */
const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Benchmark Suite Export
// ============================================================================

/**
 * Benchmark suite name for identification in runner output.
 */
export const suiteName = "transactions";

/**
 * Creates and configures the transaction benchmark suite.
 *
 * This function pre-generates test data and sets up the baseline collection.
 * Benchmarks compare direct execution vs transactional execution of the same
 * operation sequences.
 */
export async function createSuite(): Promise<Bench> {
	const bench = new Bench(defaultBenchOptions);

	// Pre-generate baseline data
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];

	// -------------------------------------------------------------------------
	// 7.2: Direct multi-operation benchmark (no transaction wrapper)
	// -------------------------------------------------------------------------

	// For direct execution, we run a sequence of create, update, delete operations
	// directly against the database without any transaction wrapper.
	// This measures the baseline throughput without transaction overhead.
	const directDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let directCounter = 0;

	bench.add("direct (create + update + delete)", async () => {
		// Use a counter to generate unique IDs for each iteration
		const uniqueId = `direct_bench_${Date.now()}_${directCounter++}`;

		// 1. Create a new user
		const created = await directDb.users.create({
			id: uniqueId,
			name: `Direct User ${directCounter}`,
			email: `direct${directCounter}@test.com`,
			age: 25 + (directCounter % 50),
			role: "user" as const,
			createdAt: new Date().toISOString(),
		}).runPromise;

		// 2. Update the user we just created
		await directDb.users.update(created.id, {
			name: `Updated Direct User ${directCounter}`,
			age: 30 + (directCounter % 40),
		}).runPromise;

		// 3. Delete the user to keep collection size stable
		await directDb.users.delete(created.id).runPromise;
	});

	// Task 7.3: Transactional multi-operation benchmark (with $transaction)
	// Task 7.4: Overhead delta reporting

	return bench;
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("Running Transaction Overhead Benchmarks\n");

	const bench = await createSuite();

	if (bench.tasks.length === 0) {
		console.log("No benchmarks configured yet. Benchmarks will be added in tasks 7.2-7.4.");
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
