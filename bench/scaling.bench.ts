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

import { Effect, Schema } from "effect";
import { Bench } from "tinybench";
import { getLoadedWasmMemoryByteLength } from "../packages/engine/src/loader.js";
import {
	attachTaskMetadata,
	checksumBenchmarkValue,
	createAvailableMetric,
	createEngineTaskName,
	createUnavailableMetric,
} from "./comparison.js";
import { selectBenchEngines } from "./engines.js";
import { generateUsers, STANDARD_SIZES } from "./generators.js";
import {
	type BenchSchemaConfig,
	buildBenchOptions,
	closeAll,
	createTaskInstrumentation,
	formatResultsTable,
	measureAsync,
	withFrozenDate,
} from "./utils.js";

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

const unindexedConfig = {
	users: {
		schema: UserSchema,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

const indexedConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role"] as ReadonlyArray<string>,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

export const suiteName = "scaling";

const requireLastTask = (bench: Bench) => {
	const task = bench.tasks[bench.tasks.length - 1];
	if (!task) {
		throw new Error("Expected benchmark task to exist");
	}
	return task;
};

const createStressMemoryTracker = (engineId: "typescript" | "wasm") => {
	let maxJsHeapBytes = 0;
	let maxWasmLinearMemoryBytes = 0;
	let repeatedJsHeapBaselineBytes: number | undefined;
	let maxRepeatedJsHeapBytes = 0;
	let repeatedWasmLinearMemoryBaselineBytes: number | undefined;
	return {
		record: async (
			stage: "beforeInitialization" | "afterInitialization" | "afterIteration",
		) => {
			const heapBytes = process.memoryUsage().heapUsed;
			if (heapBytes > maxJsHeapBytes) {
				maxJsHeapBytes = heapBytes;
			}
			const wasmBytes =
				engineId === "wasm" ? await getLoadedWasmMemoryByteLength() : undefined;
			if (
				typeof wasmBytes === "number" &&
				wasmBytes > maxWasmLinearMemoryBytes
			) {
				maxWasmLinearMemoryBytes = wasmBytes;
			}
			if (stage === "afterIteration") {
				Bun.gc(true);
				const retainedHeapBytes = process.memoryUsage().heapUsed;
				repeatedJsHeapBaselineBytes ??= retainedHeapBytes;
				maxRepeatedJsHeapBytes = Math.max(
					maxRepeatedJsHeapBytes,
					retainedHeapBytes,
				);
				if (typeof wasmBytes === "number") {
					repeatedWasmLinearMemoryBaselineBytes ??= maxWasmLinearMemoryBytes;
				}
			}
		},
		toMetrics: () => ({
			jsHeapBytes: createAvailableMetric(maxJsHeapBytes),
			wasmLinearMemoryBytes:
				engineId === "wasm" && maxWasmLinearMemoryBytes > 0
					? createAvailableMetric(maxWasmLinearMemoryBytes)
					: createUnavailableMetric("WASM linear memory unavailable"),
			repeatedGrowthBytes:
				engineId === "wasm"
					? createAvailableMetric(
							Math.max(
								0,
								maxWasmLinearMemoryBytes -
									(repeatedWasmLinearMemoryBaselineBytes ??
										maxWasmLinearMemoryBytes),
							),
						)
					: createAvailableMetric(
							Math.max(
								0,
								maxRepeatedJsHeapBytes -
									(repeatedJsHeapBaselineBytes ?? maxRepeatedJsHeapBytes),
							),
						),
		}),
	};
};

export async function createSuite(options?: {
	readonly includeStress?: boolean;
	readonly benchOptions?: Parameters<typeof buildBenchOptions>[0];
	readonly engines?: ReadonlyArray<"typescript" | "wasm">;
	readonly caseName?: string;
}): Promise<{
	readonly bench: Bench;
	readonly teardown: () => Promise<void>;
}> {
	const bench = new Bench(buildBenchOptions(options?.benchOptions));
	const requestedSize =
		options?.caseName === undefined
			? undefined
			: options.caseName.includes("@ 100K")
				? 100_000
				: options.caseName.includes("@ 10K")
					? 10_000
					: options.caseName.includes("@ 1K")
						? 1_000
						: options.caseName.includes("@ 100")
							? 100
							: undefined;
	const sizes = (
		options?.includeStress
			? STANDARD_SIZES
			: STANDARD_SIZES.filter((size) => size !== 100_000)
	).filter((size) => requestedSize === undefined || size === requestedSize);
	const usersBySize = new Map<
		number,
		ReadonlyArray<ReturnType<typeof generateUsers>[number]>
	>();
	const getUsersForSize = (size: number) => {
		const cached = usersBySize.get(size);
		if (cached) {
			return cached;
		}
		const generated = generateUsers(size);
		usersBySize.set(size, generated);
		return generated;
	};
	const matchesCase = (name: string) =>
		options?.caseName === undefined || options.caseName === name;
	let matchedCase = options?.caseName === undefined;
	const closers: Array<() => Promise<void>> = [];

	try {
		for (const size of sizes) {
			const usersArray = [...getUsersForSize(size)];
			const requireUserId = (index: number): string => {
				const user = usersArray[index];
				if (!user) {
					throw new Error(`Missing user at index ${index} for size ${size}`);
				}
				return user.id;
			};
			const testIds = [
				requireUserId(0),
				requireUserId(Math.floor(usersArray.length / 4)),
				requireUserId(Math.floor(usersArray.length / 2)),
				requireUserId(Math.floor((usersArray.length * 3) / 4)),
				requireUserId(usersArray.length - 1),
			];
			const sizeLabel = size >= 1000 ? `${size / 1000}K` : String(size);
			const caseType = size === 100_000 ? "stress" : "required";

			for (const engine of selectBenchEngines(options?.engines)) {
				let idIndex = 0;
				const getNextId = (): string => {
					const id = testIds[idIndex % testIds.length];
					if (id === undefined) {
						throw new Error(`Missing test id for size ${size}`);
					}
					idIndex++;
					return id;
				};

				const findByIdBenchmarkName = `findById @ ${sizeLabel}`;
				if (matchesCase(findByIdBenchmarkName)) {
					matchedCase = true;
					const findByIdTracker =
						size === 100_000 ? createStressMemoryTracker(engine.id) : undefined;
					await findByIdTracker?.record("beforeInitialization");
					const {
						value: findByIdHandle,
						durationMs: findByIdInitializationMs,
					} = await measureAsync(() =>
						engine.createDatabase(unindexedConfig, {
							users: usersArray,
						}),
					);
					await findByIdTracker?.record("afterInitialization");
					closers.push(findByIdHandle.close);
					const findByIdResult = await findByIdHandle.db.users.findById(
						testIds[0]!,
					).runPromise;
					const findByIdChecksum = checksumBenchmarkValue(findByIdResult);
					const findByIdInstrumentation = {
						...createTaskInstrumentation({
							initializationMs: findByIdInitializationMs,
							commandPayload: { id: testIds[0] },
							resultPayload: findByIdResult,
							projectionMaterialization:
								findByIdHandle.projectionMaterialization,
						}),
					};
					bench.add(
						createEngineTaskName(engine.id, findByIdBenchmarkName),
						async () => {
							await findByIdHandle.db.users.findById(getNextId()).runPromise;
						},
						findByIdTracker
							? {
									afterEach: async () => {
										await findByIdTracker.record("afterIteration");
										const metrics = findByIdTracker.toMetrics();
										findByIdInstrumentation.jsHeapBytes = metrics.jsHeapBytes;
										findByIdInstrumentation.wasmLinearMemoryHighWaterBytes =
											metrics.wasmLinearMemoryBytes;
										findByIdInstrumentation.repeatedHighWaterGrowthBytes =
											metrics.repeatedGrowthBytes;
									},
								}
							: undefined,
					);
					attachTaskMetadata(requireLastTask(bench), {
						benchmarkName: findByIdBenchmarkName,
						engineId: engine.id,
						category: "read-query",
						caseType,
						datasetSize: size,
						operationCount: 1,
						normalInteraction: size === 10_000,
						checksum: findByIdChecksum,
						checksumProbe: async () =>
							checksumBenchmarkValue(
								await findByIdHandle.db.users.findById(testIds[0]!).runPromise,
							),
						instrumentation: findByIdInstrumentation,
					});
				}

				const unindexedBenchmarkName = `unindexed filter @ ${sizeLabel}`;
				if (matchesCase(unindexedBenchmarkName)) {
					matchedCase = true;
					const unindexedTracker =
						size === 100_000 ? createStressMemoryTracker(engine.id) : undefined;
					await unindexedTracker?.record("beforeInitialization");
					const {
						value: unindexedHandle,
						durationMs: unindexedInitializationMs,
					} = await measureAsync(() =>
						engine.createDatabase(unindexedConfig, {
							users: usersArray,
						}),
					);
					await unindexedTracker?.record("afterInitialization");
					closers.push(unindexedHandle.close);
					const unindexedQuery = { where: { age: { $gte: 25, $lte: 35 } } };
					const unindexedResult =
						await unindexedHandle.db.users.query(unindexedQuery).runPromise;
					const unindexedChecksum = checksumBenchmarkValue(unindexedResult);
					const unindexedInstrumentation = {
						...createTaskInstrumentation({
							initializationMs: unindexedInitializationMs,
							commandPayload: unindexedQuery,
							resultPayload: unindexedResult,
							projectionMaterialization:
								unindexedHandle.projectionMaterialization,
						}),
					};
					bench.add(
						createEngineTaskName(engine.id, unindexedBenchmarkName),
						async () => {
							await unindexedHandle.db.users.query(unindexedQuery).runPromise;
						},
						unindexedTracker
							? {
									afterEach: async () => {
										await unindexedTracker.record("afterIteration");
										const metrics = unindexedTracker.toMetrics();
										unindexedInstrumentation.jsHeapBytes = metrics.jsHeapBytes;
										unindexedInstrumentation.wasmLinearMemoryHighWaterBytes =
											metrics.wasmLinearMemoryBytes;
										unindexedInstrumentation.repeatedHighWaterGrowthBytes =
											metrics.repeatedGrowthBytes;
									},
								}
							: undefined,
					);
					attachTaskMetadata(requireLastTask(bench), {
						benchmarkName: unindexedBenchmarkName,
						engineId: engine.id,
						category: "read-query",
						caseType,
						datasetSize: size,
						operationCount: 1,
						normalInteraction: false,
						checksum: unindexedChecksum,
						checksumProbe: async () =>
							checksumBenchmarkValue(
								await unindexedHandle.db.users.query(unindexedQuery).runPromise,
							),
						instrumentation: unindexedInstrumentation,
					});
				}

				const indexedBenchmarkName = `indexed filter @ ${sizeLabel}`;
				if (matchesCase(indexedBenchmarkName)) {
					matchedCase = true;
					const indexedTracker =
						size === 100_000 ? createStressMemoryTracker(engine.id) : undefined;
					await indexedTracker?.record("beforeInitialization");
					const { value: indexedHandle, durationMs: indexedInitializationMs } =
						await measureAsync(() =>
							engine.createDatabase(indexedConfig, {
								users: usersArray,
							}),
						);
					await indexedTracker?.record("afterInitialization");
					closers.push(indexedHandle.close);
					const indexedQuery = { where: { role: "admin" } };
					const indexedResult =
						await indexedHandle.db.users.query(indexedQuery).runPromise;
					const indexedChecksum = checksumBenchmarkValue(indexedResult);
					const indexedInstrumentation = {
						...createTaskInstrumentation({
							initializationMs: indexedInitializationMs,
							commandPayload: indexedQuery,
							resultPayload: indexedResult,
							projectionMaterialization:
								indexedHandle.projectionMaterialization,
						}),
					};
					bench.add(
						createEngineTaskName(engine.id, indexedBenchmarkName),
						async () => {
							await indexedHandle.db.users.query(indexedQuery).runPromise;
						},
						indexedTracker
							? {
									afterEach: async () => {
										await indexedTracker.record("afterIteration");
										const metrics = indexedTracker.toMetrics();
										indexedInstrumentation.jsHeapBytes = metrics.jsHeapBytes;
										indexedInstrumentation.wasmLinearMemoryHighWaterBytes =
											metrics.wasmLinearMemoryBytes;
										indexedInstrumentation.repeatedHighWaterGrowthBytes =
											metrics.repeatedGrowthBytes;
									},
								}
							: undefined,
					);
					attachTaskMetadata(requireLastTask(bench), {
						benchmarkName: indexedBenchmarkName,
						engineId: engine.id,
						category: "read-query",
						caseType,
						datasetSize: size,
						operationCount: 1,
						normalInteraction: false,
						checksum: indexedChecksum,
						checksumProbe: async () =>
							checksumBenchmarkValue(
								await indexedHandle.db.users.query(indexedQuery).runPromise,
							),
						instrumentation: indexedInstrumentation,
					});
				}

				if (size === 100_000) {
					const createBenchmarkName = "create (single) @ 100K";
					if (matchesCase(createBenchmarkName)) {
						matchedCase = true;
						const createTracker = createStressMemoryTracker(engine.id);
						await createTracker.record("beforeInitialization");
						const { value: createHandle, durationMs: createInitializationMs } =
							await measureAsync(() =>
								engine.createDatabase(unindexedConfig, {
									users: usersArray,
								}),
							);
						await createTracker.record("afterInitialization");
						closers.push(createHandle.close);
						const stressCreateId = "stress_create_checksum";
						const createResult = await withFrozenDate(
							"2026-01-02T03:04:05.000Z",
							async () => {
								await createHandle.db.users.create({
									id: stressCreateId,
									name: "Stress Create",
									email: "stress-create-checksum@example.com",
									age: 40,
									role: "user",
									createdAt: "2026-01-01T00:00:00.000Z",
								}).runPromise;
								return await createHandle.db.users.findById(stressCreateId)
									.runPromise;
							},
						);
						const createChecksum = checksumBenchmarkValue(createResult);
						await createHandle.db.users.delete(stressCreateId).runPromise;
						let createCounter = 0;
						let lastCreateId: string | undefined;
						const createInstrumentation = {
							...createTaskInstrumentation({
								initializationMs: createInitializationMs,
								commandPayload: {
									id: stressCreateId,
									name: "Stress Create",
								},
								resultPayload: createResult,
							}),
						};
						bench.add(
							createEngineTaskName(engine.id, createBenchmarkName),
							async () => {
								const id = `stress_create_${createCounter++}`;
								lastCreateId = id;
								await createHandle.db.users.create({
									id,
									name: "Stress Create",
									email: `${id}@example.com`,
									age: 40,
									role: "user",
									createdAt: "2026-01-01T00:00:00.000Z",
								}).runPromise;
							},
							{
								afterEach: async () => {
									if (!lastCreateId) return;
									await createHandle.db.users.delete(lastCreateId).runPromise;
									lastCreateId = undefined;
									await createTracker.record("afterIteration");
									const metrics = createTracker.toMetrics();
									createInstrumentation.jsHeapBytes = metrics.jsHeapBytes;
									createInstrumentation.wasmLinearMemoryHighWaterBytes =
										metrics.wasmLinearMemoryBytes;
									createInstrumentation.repeatedHighWaterGrowthBytes =
										metrics.repeatedGrowthBytes;
								},
							},
						);
						attachTaskMetadata(requireLastTask(bench), {
							benchmarkName: createBenchmarkName,
							engineId: engine.id,
							category: "write-transaction",
							caseType: "stress",
							datasetSize: size,
							operationCount: 1,
							normalInteraction: false,
							checksum: createChecksum,
							instrumentation: createInstrumentation,
						});
					}

					const txBenchmarkName =
						"transactional (create + update + delete) @ 100K";
					if (matchesCase(txBenchmarkName)) {
						matchedCase = true;
						const txTracker = createStressMemoryTracker(engine.id);
						await txTracker.record("beforeInitialization");
						const { value: txHandle, durationMs: txInitializationMs } =
							await measureAsync(() =>
								engine.createDatabase(unindexedConfig, {
									users: usersArray,
								}),
							);
						await txTracker.record("afterInitialization");
						closers.push(txHandle.close);
						const txId = `stress_tx_${engine.id}`;
						await Effect.runPromise(
							txHandle.db.$transaction((ctx) =>
								Effect.gen(function* () {
									const created = yield* ctx.users.create({
										id: txId,
										name: "Stress Tx",
										email: `stress-tx-${engine.id}@example.com`,
										age: 32,
										role: "user",
										createdAt: "2026-01-01T00:00:00.000Z",
									});
									yield* ctx.users.update(created.id, {
										name: "Stress Tx Updated",
									});
									yield* ctx.users.delete(created.id);
								}),
							),
						);
						const txResult = await txHandle.db.users.exists(txId).runPromise;
						const txChecksum = checksumBenchmarkValue(txResult);
						let txCounter = 0;
						const txInstrumentation = {
							...createTaskInstrumentation({
								initializationMs: txInitializationMs,
								commandPayload: {
									id: txId,
									transaction: "create-update-delete",
								},
								resultPayload: txResult,
							}),
						};
						bench.add(
							createEngineTaskName(engine.id, txBenchmarkName),
							async () => {
								const id = `stress_tx_${txCounter++}`;
								await Effect.runPromise(
									txHandle.db.$transaction((ctx) =>
										Effect.gen(function* () {
											const created = yield* ctx.users.create({
												id,
												name: "Stress Tx",
												email: `${id}@example.com`,
												age: 32,
												role: "user",
												createdAt: "2026-01-01T00:00:00.000Z",
											});
											yield* ctx.users.update(created.id, {
												name: "Stress Tx Updated",
											});
											yield* ctx.users.delete(created.id);
										}),
									),
								);
							},
							{
								afterEach: async () => {
									await txTracker.record("afterIteration");
									const metrics = txTracker.toMetrics();
									txInstrumentation.jsHeapBytes = metrics.jsHeapBytes;
									txInstrumentation.wasmLinearMemoryHighWaterBytes =
										metrics.wasmLinearMemoryBytes;
									txInstrumentation.repeatedHighWaterGrowthBytes =
										metrics.repeatedGrowthBytes;
								},
							},
						);
						attachTaskMetadata(requireLastTask(bench), {
							benchmarkName: txBenchmarkName,
							engineId: engine.id,
							category: "write-transaction",
							caseType: "stress",
							datasetSize: size,
							operationCount: 3,
							normalInteraction: false,
							checksum: txChecksum,
							instrumentation: txInstrumentation,
						});
					}
				}
			}
		}

		if (!matchedCase) {
			throw new Error(
				`No scaling benchmark matches case filter: ${options?.caseName}`,
			);
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

export async function run(): Promise<void> {
	console.log("🚀 Running Collection Scaling Benchmarks\n");

	const { bench, teardown } = await createSuite({ includeStress: true });
	try {
		await bench.run();
		console.log("\nResults:\n");
		console.log(formatResultsTable(bench.tasks));
	} finally {
		await teardown();
	}
}

if (import.meta.main) {
	run();
}
