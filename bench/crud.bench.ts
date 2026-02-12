/**
 * CRUD Operation Throughput Benchmarks
 *
 * Measures ops/sec and latency percentiles for CRUD operations:
 * - create: Single entity insertion
 * - createMany: Batch entity insertion
 * - update: Single entity modification
 * - updateMany: Batch entity modification
 * - delete: Single entity removal
 * - deleteMany: Batch entity removal
 * - upsert: Create-or-update paths
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
 * Baseline collection size for CRUD benchmarks.
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
 * Database configuration for CRUD benchmarks.
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
export const suiteName = "crud";

/**
 * Creates and configures the CRUD benchmark suite.
 *
 * This function pre-generates test data and sets up the baseline collection.
 * Individual benchmarks are added in subsequent tasks (4.2-4.6).
 */
export async function createSuite(): Promise<Bench> {
	const bench = new Bench(defaultBenchOptions);

	// Pre-generate baseline data
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];

	// -------------------------------------------------------------------------
	// 4.2: create single-entity benchmark
	// -------------------------------------------------------------------------

	// For create benchmark, we start with the baseline collection.
	// Each iteration creates one new entity with a unique ID.
	// After benchmark completes, the collection will have grown.
	const createDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let createCounter = 0;

	bench.add("create (single)", async () => {
		// Generate a unique ID for each created entity
		// Using a counter ensures no collisions during the benchmark
		const uniqueId = `bench_user_${Date.now()}_${createCounter++}`;

		await createDb.users.create({
			id: uniqueId,
			name: "Benchmark User",
			email: `benchmark${createCounter}@test.com`,
			age: 30,
			role: "user" as const,
			createdAt: new Date().toISOString(),
		}).runPromise;
	});

	// -------------------------------------------------------------------------
	// 4.3: createMany batch benchmark
	// -------------------------------------------------------------------------

	// For createMany benchmark, we start with the baseline collection.
	// Each iteration creates a batch of 100 entities with unique IDs.
	// This tests amortized batch insertion throughput vs single creates.
	const createManyDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let createManyCounter = 0;
	const BATCH_SIZE = 100;

	bench.add("createMany (batch of 100)", async () => {
		// Generate a batch of entities with unique IDs
		const batchStartIndex = createManyCounter;
		createManyCounter += BATCH_SIZE;
		const timestamp = Date.now();

		const batch: Array<User> = [];
		for (let i = 0; i < BATCH_SIZE; i++) {
			const idx = batchStartIndex + i;
			batch.push({
				id: `batch_user_${timestamp}_${idx}`,
				name: `Batch User ${idx}`,
				email: `batch${idx}@test.com`,
				age: 25 + (idx % 50),
				role: "user" as const,
				createdAt: new Date().toISOString(),
			});
		}

		await createManyDb.users.createMany(batch).runPromise;
	});

	// -------------------------------------------------------------------------
	// 4.4: update and updateMany benchmarks
	// -------------------------------------------------------------------------

	// For update benchmark, we use the baseline collection.
	// Each iteration updates a randomly selected entity by ID.
	// This measures single-entity update throughput.
	const updateDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let updateCounter = 0;

	bench.add("update (single)", async () => {
		// Cycle through existing entity IDs to ensure updates target real entities
		// This simulates realistic update patterns where entities already exist
		const targetIndex = updateCounter % BASELINE_SIZE;
		const targetId = usersArray[targetIndex].id;
		updateCounter++;

		await updateDb.users.update(targetId, {
			name: `Updated User ${updateCounter}`,
			age: 25 + (updateCounter % 50),
		}).runPromise;
	});

	// For updateMany benchmark, we use a fresh copy of the baseline collection.
	// Each iteration updates a batch of ~100 entities matching a predicate.
	// This tests amortized batch update throughput vs single updates.
	const updateManyDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let updateManyCounter = 0;

	bench.add("updateMany (batch ~100)", async () => {
		// Target a different age range each iteration to update ~100 entities
		// With ages 18-87 across 10K users, each age value has ~140 users on average
		// We cycle through age ranges to hit different entities each time
		const targetAge = 18 + (updateManyCounter % 70);
		updateManyCounter++;

		await updateManyDb.users.updateMany(
			(user) => user.age === targetAge,
			{
				name: `Batch Updated User ${updateManyCounter}`,
			},
		).runPromise;
	});

	// Benchmarks will be added in tasks 4.5-4.6:
	// - 4.5: delete and deleteMany benchmarks
	// - 4.6: upsert benchmarks (create and update paths)

	return bench;
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("Running CRUD Operation Benchmarks\n");

	const bench = await createSuite();

	if (bench.tasks.length === 0) {
		console.log("No benchmarks configured yet. Benchmarks will be added in tasks 4.2-4.6.");
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
