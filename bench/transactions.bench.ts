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

import { Effect, Schema } from "effect";
import { Bench } from "tinybench";
import { generateUsers } from "./generators.js";
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

	// -------------------------------------------------------------------------
	// 7.3: Transactional multi-operation benchmark (with $transaction wrapper)
	// -------------------------------------------------------------------------

	// For transactional execution, we run the same sequence of create, update, delete
	// operations inside a $transaction wrapper. This measures the overhead of
	// transaction semantics: snapshot creation, mutation tracking, and commit.
	const txDb = await createBenchDatabase(dbConfig, { users: usersArray });
	let txCounter = 0;

	bench.add("transactional (create + update + delete)", async () => {
		// Use a counter to generate unique IDs for each iteration
		const uniqueId = `tx_bench_${Date.now()}_${txCounter++}`;

		// Run the same operations inside a transaction
		await Effect.runPromise(
			txDb.$transaction((ctx) =>
				Effect.gen(function* () {
					// 1. Create a new user
					const created = yield* ctx.users.create({
						id: uniqueId,
						name: `Tx User ${txCounter}`,
						email: `tx${txCounter}@test.com`,
						age: 25 + (txCounter % 50),
						role: "user" as const,
						createdAt: new Date().toISOString(),
					});

					// 2. Update the user we just created
					yield* ctx.users.update(created.id, {
						name: `Updated Tx User ${txCounter}`,
						age: 30 + (txCounter % 40),
					});

					// 3. Delete the user to keep collection size stable
					yield* ctx.users.delete(created.id);

					return created;
				}),
			),
		);
	});

	// Task 7.4: Overhead delta reporting

	return bench;
}

// ============================================================================
// Overhead Delta Calculation (Task 7.4)
// ============================================================================

/**
 * Overhead delta result structure for JSON output.
 */
export interface TransactionOverheadDelta {
	readonly throughputOverhead: number; // Percentage decrease in ops/sec
	readonly latencyOverhead: number; // Percentage increase in mean latency
	readonly absoluteLatencyDelta: number; // Absolute difference in ms
	readonly directOpsPerSec: number;
	readonly directMeanMs: number;
	readonly txOpsPerSec: number;
	readonly txMeanMs: number;
}

/**
 * Calculate and format the overhead delta between transactional and direct execution.
 *
 * This compares:
 * - ops/sec: Higher is better (direct should be higher)
 * - mean latency: Lower is better (direct should be lower)
 *
 * Reports the transaction overhead as a percentage increase in latency
 * and percentage decrease in throughput.
 */
export function calculateOverheadDelta(
	directOpsPerSec: number,
	directMeanMs: number,
	txOpsPerSec: number,
	txMeanMs: number,
): TransactionOverheadDelta {
	// Throughput overhead: how much slower is transactional?
	// (direct - tx) / direct * 100 = percentage decrease
	const throughputOverhead =
		((directOpsPerSec - txOpsPerSec) / directOpsPerSec) * 100;

	// Latency overhead: how much longer does transactional take?
	// (tx - direct) / direct * 100 = percentage increase
	const latencyOverhead = ((txMeanMs - directMeanMs) / directMeanMs) * 100;

	// Absolute latency delta
	const absoluteLatencyDelta = txMeanMs - directMeanMs;

	return {
		throughputOverhead,
		latencyOverhead,
		absoluteLatencyDelta,
		directOpsPerSec,
		directMeanMs,
		txOpsPerSec,
		txMeanMs,
	};
}

/**
 * Extract overhead delta from benchmark results.
 * Returns null if the required tasks are not found or haven't run.
 *
 * @param bench - The completed benchmark suite
 * @returns Overhead delta data or null if not available
 */
export function getOverheadDelta(
	bench: Bench,
): TransactionOverheadDelta | null {
	const directTask = bench.tasks.find((t) => t.name.startsWith("direct"));
	const txTask = bench.tasks.find((t) => t.name.startsWith("transactional"));

	if (!directTask?.result || !txTask?.result) {
		return null;
	}

	return calculateOverheadDelta(
		directTask.result.throughput.mean,
		directTask.result.latency.mean,
		txTask.result.throughput.mean,
		txTask.result.latency.mean,
	);
}

/**
 * Format a number as a percentage with sign.
 */
function formatPercent(value: number): string {
	const sign = value >= 0 ? "+" : "";
	return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format the overhead delta report for terminal output.
 */
function formatOverheadReport(
	directOpsPerSec: number,
	directMeanMs: number,
	txOpsPerSec: number,
	txMeanMs: number,
): string {
	const delta = calculateOverheadDelta(
		directOpsPerSec,
		directMeanMs,
		txOpsPerSec,
		txMeanMs,
	);

	const lines: string[] = [
		"Transaction Overhead Analysis",
		"─".repeat(50),
		"",
		`Direct execution:       ${directOpsPerSec.toFixed(2)} ops/sec (${directMeanMs.toFixed(3)}ms mean)`,
		`Transactional execution: ${txOpsPerSec.toFixed(2)} ops/sec (${txMeanMs.toFixed(3)}ms mean)`,
		"",
		"Overhead:",
		`  Throughput:  ${formatPercent(-delta.throughputOverhead)} (${delta.throughputOverhead >= 0 ? "slower" : "faster"})`,
		`  Latency:     ${formatPercent(delta.latencyOverhead)} (${delta.absoluteLatencyDelta >= 0 ? "+" : ""}${delta.absoluteLatencyDelta.toFixed(3)}ms)`,
		"",
	];

	// Add interpretation
	if (delta.latencyOverhead > 0) {
		lines.push(
			`Interpretation: Transactions add ~${delta.latencyOverhead.toFixed(1)}% overhead`,
			"for snapshot creation and commit operations.",
		);
	} else {
		lines.push(
			"Interpretation: Transactional execution shows no overhead penalty.",
			"This may indicate that snapshot and commit costs are negligible at this scale.",
		);
	}

	return lines.join("\n");
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("Running Transaction Overhead Benchmarks\n");

	const bench = await createSuite();

	if (bench.tasks.length === 0) {
		console.log(
			"No benchmarks configured yet. Benchmarks will be added in tasks 7.2-7.4.",
		);
		return;
	}

	await bench.run();

	console.log("\nResults:\n");
	console.log(formatResultsTable(bench.tasks));

	// Task 7.4: Report overhead delta between transactional and direct execution
	const directTask = bench.tasks.find((t) => t.name.startsWith("direct"));
	const txTask = bench.tasks.find((t) => t.name.startsWith("transactional"));

	if (directTask?.result && txTask?.result) {
		console.log("\n");
		console.log(
			formatOverheadReport(
				directTask.result.throughput.mean,
				directTask.result.latency.mean,
				txTask.result.throughput.mean,
				txTask.result.latency.mean,
			),
		);
	}
}

// Run when executed directly
if (import.meta.main) {
	run();
}
