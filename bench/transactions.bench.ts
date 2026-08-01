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
import {
	attachTaskMetadata,
	checksumBenchmarkValue,
	createEngineTaskName,
} from "./comparison.js";
import { selectBenchEngines, type BenchEngine } from "./engines.js";
import { generateUsers } from "./generators.js";
import {
	type BenchSchemaConfig,
	buildBenchOptions,
	closeAll,
	createTaskInstrumentation,
	formatResultsTable,
	measureAsync,
} from "./utils.js";

const BASELINE_SIZE = 10_000;

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	role: Schema.Union([
		Schema.Literal("admin"),
		Schema.Literal("moderator"),
		Schema.Literal("user"),
	]),
	createdAt: Schema.String,
});

const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

export const suiteName = "transactions";

const computeTransactionChecksum = async (
	engine: BenchEngine,
	caseName:
		| "direct (create + update + delete)"
		| "transactional (create + update + delete)",
	users: ReturnType<typeof generateUsers>,
): Promise<string> => {
	const handle = await engine.createDatabase(dbConfig, {
		users: [...users],
	});
	try {
		const id = `checksum_${caseName.startsWith("direct") ? "direct" : "tx"}`;
		if (caseName === "direct (create + update + delete)") {
			const created = await handle.db.users.create({
				id,
				name: "Checksum Direct",
				email: "checksum-direct@example.com",
				age: 31,
				role: "user",
				createdAt: "2026-01-01T00:00:00.000Z",
			}).runPromise;
			await handle.db.users.update(created.id, {
				name: "Checksum Direct Updated",
				age: 41,
			}).runPromise;
			await handle.db.users.delete(created.id).runPromise;
		} else {
			await Effect.runPromise(
				handle.db.$transaction((ctx) =>
					Effect.gen(function* () {
						const created = yield* ctx.users.create({
							id,
							name: "Checksum Tx",
							email: "checksum-tx@example.com",
							age: 31,
							role: "user",
							createdAt: "2026-01-01T00:00:00.000Z",
						});
						yield* ctx.users.update(created.id, {
							name: "Checksum Tx Updated",
							age: 41,
						});
						yield* ctx.users.delete(created.id);
					}),
				),
			);
		}
		return checksumBenchmarkValue({
			exists: await handle.db.users.exists(id).runPromise,
			count: (await handle.db.users.query().runPromise).length,
		});
	} finally {
		await handle.close();
	}
};

export async function createSuite(options?: {
	readonly includeStress?: boolean;
	readonly benchOptions?: Parameters<typeof buildBenchOptions>[0];
	readonly engines?: ReadonlyArray<BenchEngine["id"]>;
}): Promise<{
	readonly bench: Bench;
	readonly teardown: () => Promise<void>;
}> {
	const bench = new Bench(buildBenchOptions(options?.benchOptions));
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];
	const closers: Array<() => Promise<void>> = [];

	try {
		for (const engine of selectBenchEngines(options?.engines)) {
			const directChecksum = await computeTransactionChecksum(
				engine,
				"direct (create + update + delete)",
				usersArray,
			);
			const { value: directHandle, durationMs: directInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(dbConfig, {
						users: usersArray,
					}),
				);
			closers.push(directHandle.close);
			let directCounter = 0;
			bench.add(
				createEngineTaskName(engine.id, "direct (create + update + delete)"),
				async () => {
					const uniqueId = `direct_bench_${directCounter++}`;
					const created = await directHandle.db.users.create({
						id: uniqueId,
						name: `Direct User ${directCounter}`,
						email: `direct${directCounter}@test.com`,
						age: 25 + (directCounter % 50),
						role: "user" as const,
						createdAt: "2026-01-01T00:00:00.000Z",
					}).runPromise;

					await directHandle.db.users.update(created.id, {
						name: `Updated Direct User ${directCounter}`,
						age: 30 + (directCounter % 40),
					}).runPromise;

					await directHandle.db.users.delete(created.id).runPromise;
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "direct (create + update + delete)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: false,
				checksum: directChecksum,
				checksumProbe: async () => {
					const id = "checksum_probe_direct";
					const created = await directHandle.db.users.create({
						id,
						name: "Checksum Direct",
						email: "checksum-direct@example.com",
						age: 31,
						role: "user",
						createdAt: "2026-01-01T00:00:00.000Z",
					}).runPromise;
					await directHandle.db.users.update(created.id, {
						name: "Checksum Direct Updated",
						age: 41,
					}).runPromise;
					await directHandle.db.users.delete(created.id).runPromise;
					return checksumBenchmarkValue({
						exists: await directHandle.db.users.exists(id).runPromise,
						count: (await directHandle.db.users.query().runPromise).length,
					});
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: directInitializationMs,
					commandPayload: {
						transaction: false,
						operations: ["create", "update", "delete"],
					},
					resultPayload: { checksum: directChecksum },
				}),
			});

			const transactionalChecksum = await computeTransactionChecksum(
				engine,
				"transactional (create + update + delete)",
				usersArray,
			);
			const { value: txHandle, durationMs: txInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(dbConfig, {
						users: usersArray,
					}),
				);
			closers.push(txHandle.close);
			let txCounter = 0;
			bench.add(
				createEngineTaskName(
					engine.id,
					"transactional (create + update + delete)",
				),
				async () => {
					const uniqueId = `tx_bench_${txCounter++}`;
					await Effect.runPromise(
						txHandle.db.$transaction((ctx) =>
							Effect.gen(function* () {
								const created = yield* ctx.users.create({
									id: uniqueId,
									name: `Tx User ${txCounter}`,
									email: `tx${txCounter}@test.com`,
									age: 25 + (txCounter % 50),
									role: "user" as const,
									createdAt: "2026-01-01T00:00:00.000Z",
								});

								yield* ctx.users.update(created.id, {
									name: `Updated Tx User ${txCounter}`,
									age: 30 + (txCounter % 40),
								});

								yield* ctx.users.delete(created.id);
							}),
						),
					);
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "transactional (create + update + delete)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: transactionalChecksum,
				checksumProbe: async () => {
					const id = "checksum_probe_tx";
					await Effect.runPromise(
						txHandle.db.$transaction((ctx) =>
							Effect.gen(function* () {
								const created = yield* ctx.users.create({
									id,
									name: "Checksum Tx",
									email: "checksum-tx@example.com",
									age: 31,
									role: "user",
									createdAt: "2026-01-01T00:00:00.000Z",
								});
								yield* ctx.users.update(created.id, {
									name: "Checksum Tx Updated",
									age: 41,
								});
								yield* ctx.users.delete(created.id);
							}),
						),
					);
					return checksumBenchmarkValue({
						exists: await txHandle.db.users.exists(id).runPromise,
						count: (await txHandle.db.users.query().runPromise).length,
					});
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: txInitializationMs,
					commandPayload: {
						transaction: true,
						operations: ["create", "update", "delete"],
					},
					resultPayload: { checksum: transactionalChecksum },
				}),
			});
		}

		return {
			bench,
			teardown: async () => {
				await closeAll(closers);
			},
		};
	} catch (error) {
		await closeAll(closers);
		throw error;
	}
}

export interface TransactionOverheadDelta {
	readonly throughputOverhead: number;
	readonly latencyOverhead: number;
	readonly absoluteLatencyDelta: number;
	readonly directOpsPerSec: number;
	readonly directMeanMs: number;
	readonly txOpsPerSec: number;
	readonly txMeanMs: number;
}

export function calculateOverheadDelta(
	directOpsPerSec: number,
	directMeanMs: number,
	txOpsPerSec: number,
	txMeanMs: number,
): TransactionOverheadDelta {
	const throughputOverhead =
		((directOpsPerSec - txOpsPerSec) / directOpsPerSec) * 100;
	const latencyOverhead = ((txMeanMs - directMeanMs) / directMeanMs) * 100;
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

export function getOverheadDelta(
	bench: Bench,
): TransactionOverheadDelta | null {
	const directTask = bench.tasks.find((t) =>
		t.name.includes("direct (create + update + delete)"),
	);
	const txTask = bench.tasks.find((t) =>
		t.name.includes("transactional (create + update + delete)"),
	);

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

function formatPercent(value: number): string {
	const sign = value >= 0 ? "+" : "";
	return `${sign}${value.toFixed(2)}%`;
}

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

export async function run(): Promise<void> {
	console.log("Running Transaction Overhead Benchmarks\n");

	const { bench, teardown } = await createSuite();
	try {
		await bench.run();
		console.log("\nResults:\n");
		console.log(formatResultsTable(bench.tasks));

		const directTask = bench.tasks.find((t) =>
			t.name.includes("direct (create + update + delete)"),
		);
		const txTask = bench.tasks.find((t) =>
			t.name.includes("transactional (create + update + delete)"),
		);

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
	} finally {
		await teardown();
	}
}

if (import.meta.main) {
	run();
}
