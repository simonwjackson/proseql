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
import { generateUsers, type User } from "./generators.js";
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
	const createManyDb = await createBenchDatabase(dbConfig, {
		users: usersArray,
	});
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
	const updateManyDb = await createBenchDatabase(dbConfig, {
		users: usersArray,
	});
	let updateManyCounter = 0;

	bench.add("updateMany (batch ~100)", async () => {
		// Target a different age range each iteration to update ~100 entities
		// With ages 18-87 across 10K users, each age value has ~140 users on average
		// We cycle through age ranges to hit different entities each time
		const targetAge = 18 + (updateManyCounter % 70);
		updateManyCounter++;

		await updateManyDb.users.updateMany((user) => user.age === targetAge, {
			name: `Batch Updated User ${updateManyCounter}`,
		}).runPromise;
	});

	// -------------------------------------------------------------------------
	// 4.5: delete and deleteMany benchmarks
	// -------------------------------------------------------------------------

	// For delete benchmark, we use a separate database instance.
	// Each iteration deletes an entity then recreates it to maintain collection size.
	// This measures the delete operation throughput while keeping the benchmark sustainable.
	const deleteDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let deleteCounter = 0;

	bench.add("delete (single)", async () => {
		// Cycle through existing entity IDs
		const targetIndex = deleteCounter % BASELINE_SIZE;
		const targetUser = usersArray[targetIndex];
		deleteCounter++;

		// Delete the entity
		await deleteDb.users.delete(targetUser.id).runPromise;

		// Recreate the entity to maintain collection size for subsequent iterations
		// This ensures we're always deleting a real entity
		await deleteDb.users.create(targetUser).runPromise;
	});

	// For deleteMany benchmark, we use a fresh database instance.
	// Each iteration deletes entities matching a predicate then recreates them.
	// This measures batch delete throughput with ~100 entities per batch.
	const deleteManyDb = await createBenchDatabase(dbConfig, {
		users: usersArray,
	});
	let deleteManyCounter = 0;

	bench.add("deleteMany (batch ~100)", async () => {
		// Target a different age value each iteration to delete ~140 users on average
		// With ages 18-87 across 10K users, each age value has ~140 users
		const targetAge = 18 + (deleteManyCounter % 70);
		deleteManyCounter++;

		// Find entities that will be deleted (for recreation)
		const toDelete = usersArray.filter((user) => user.age === targetAge);

		// Delete matching entities
		await deleteManyDb.users.deleteMany((user) => user.age === targetAge)
			.runPromise;

		// Recreate deleted entities to maintain collection size
		if (toDelete.length > 0) {
			await deleteManyDb.users.createMany(toDelete).runPromise;
		}
	});

	// -------------------------------------------------------------------------
	// 4.6: upsert benchmarks (create and update paths)
	// -------------------------------------------------------------------------

	// Upsert benchmark (create path): upsert entities that don't exist.
	// Each iteration upserts a new entity that doesn't exist in the collection.
	// This measures the "create" path of upsert (when the entity is not found).
	const upsertCreateDb = await createBenchDatabase(dbConfig, {
		users: usersArray,
	});
	let upsertCreateCounter = 0;

	bench.add("upsert (create path)", async () => {
		// Generate a unique ID that doesn't exist in the baseline collection
		// This ensures upsert takes the "create" path every time
		const uniqueId = `upsert_new_${Date.now()}_${upsertCreateCounter++}`;

		await upsertCreateDb.users.upsert({
			where: { id: uniqueId },
			create: {
				id: uniqueId,
				name: `Upserted User ${upsertCreateCounter}`,
				email: `upsert_create${upsertCreateCounter}@test.com`,
				age: 30,
				role: "user" as const,
				createdAt: new Date().toISOString(),
			},
			update: {
				name: `Should Not Be Used ${upsertCreateCounter}`,
			},
		}).runPromise;
	});

	// Upsert benchmark (update path): upsert entities that already exist.
	// Each iteration upserts an existing entity from the baseline collection.
	// This measures the "update" path of upsert (when the entity is found).
	const upsertUpdateDb = await createBenchDatabase(dbConfig, {
		users: usersArray,
	});
	let upsertUpdateCounter = 0;

	bench.add("upsert (update path)", async () => {
		// Cycle through existing entity IDs to ensure upsert takes the "update" path
		const targetIndex = upsertUpdateCounter % BASELINE_SIZE;
		const targetId = usersArray[targetIndex].id;
		upsertUpdateCounter++;

		await upsertUpdateDb.users.upsert({
			where: { id: targetId },
			create: {
				id: targetId,
				name: `Should Not Be Used ${upsertUpdateCounter}`,
				email: `should_not_be_used${upsertUpdateCounter}@test.com`,
				age: 25,
				role: "user" as const,
				createdAt: new Date().toISOString(),
			},
			update: {
				name: `Upserted Update ${upsertUpdateCounter}`,
				age: 25 + (upsertUpdateCounter % 50),
			},
		}).runPromise;
	});

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
		console.log(
			"No benchmarks configured yet. Benchmarks will be added in tasks 4.2-4.6.",
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
