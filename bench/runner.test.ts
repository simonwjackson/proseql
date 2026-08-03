import { Bench } from "tinybench";
import { describe, expect, it, vi } from "vitest";
import { attachTaskMetadata, buildComparisons } from "./comparison.js";
import { createSuite as createQueryPipelineSuite } from "./query-pipeline.bench.js";
import type {
	BenchmarkJsonOutput,
	BenchmarkSuiteJsonOutput,
	DiscoveredBenchmark,
} from "./runner.js";
import {
	BenchmarkExecutionError,
	buildBenchmarkJsonOutput,
	buildIsolatedSuiteChildProcessOptions,
	discoverBenchmarks,
	executeAllSuites,
	executeIsolatedBenchmarkProcess,
	filterBenchmarks,
	isolatedSuiteWatchdogMs,
	mergeIsolatedStressSuiteOutputs,
	normalizeAttemptTimeoutMs,
	parseBenchmarkRunnerArgs,
	shouldRunInIsolatedStressChild,
	shouldRunInIsolatedSuiteChild,
} from "./runner.js";
import { defaultBenchOptions } from "./utils.js";

const EXPECTED_BENCHMARK_FILES = [
	"crud.bench.ts",
	"query-pipeline.bench.ts",
	"scaling.bench.ts",
	"serialization.bench.ts",
	"transactions.bench.ts",
] as const;

const EXPECTED_SUITE_NAMES = [
	"crud",
	"query-pipeline",
	"scaling",
	"serialization",
	"transactions",
] as const;

const requireTask = (
	tasks: ReadonlyArray<Bench["tasks"][number]>,
	index: number,
) => {
	const task = tasks[index];
	if (!task) {
		throw new Error(`Missing synthetic task at index ${index}`);
	}
	return task;
};

const createSyntheticBenchmark = (options: {
	readonly suiteName: string;
	readonly taskName?: string;
	readonly shouldFail?: boolean;
	readonly delayMs?: number;
	readonly setupDelayMs?: number;
	readonly checksumProbeDelayMs?: number;
	readonly onChecksumProbe?: () => void;
	readonly onCreateSuite?: () => void;
	readonly teardown?: () => Promise<void> | void;
	readonly iterations?: (requested: number) => number;
}): DiscoveredBenchmark => ({
	path: `/synthetic/${options.suiteName}.bench.ts`,
	module: {
		suiteName: options.suiteName,
		createSuite: async (suiteOptions) => {
			options.onCreateSuite?.();
			if (options.setupDelayMs !== undefined) {
				await Bun.sleep(options.setupDelayMs);
			}
			const requestedIterations = suiteOptions?.benchOptions?.iterations ?? 1;
			const bench = new Bench({
				iterations:
					options.iterations?.(requestedIterations) ?? requestedIterations,
				time: suiteOptions?.benchOptions?.time ?? 0,
				warmup: false,
				signal: suiteOptions?.benchOptions?.signal,
			});
			bench.add(options.taskName ?? "[typescript] synthetic case", async () => {
				if (options.shouldFail) {
					throw new Error("synthetic failure");
				}
				await Bun.sleep(options.delayMs ?? 1);
			});
			attachTaskMetadata(requireTask(bench.tasks, 0), {
				benchmarkName: "synthetic case",
				engineId: "typescript",
				category: "read-query",
				caseType: "required",
				operationCount: 1,
				normalInteraction: false,
				checksum: "checksum:synthetic",
				checksumProbe:
					options.checksumProbeDelayMs === undefined
						? undefined
						: async () => {
								await Bun.sleep(options.checksumProbeDelayMs);
								options.onChecksumProbe?.();
								return "checksum:synthetic";
							},
			});
			return {
				bench,
				teardown: options.teardown,
			};
		},
		run: undefined,
	},
});

describe("Benchmark Discovery", () => {
	it("discovers all .bench.ts files in the bench/ directory", async () => {
		const benchmarks = await discoverBenchmarks();
		expect(benchmarks.length).toBe(EXPECTED_BENCHMARK_FILES.length);

		const discoveredFiles = benchmarks.map((b) => b.path.split("/").at(-1));
		for (const expectedFile of EXPECTED_BENCHMARK_FILES) {
			expect(discoveredFiles).toContain(expectedFile);
		}
	});

	it("discovers files sorted alphabetically for consistent ordering", async () => {
		const benchmarks = await discoverBenchmarks();
		const discoveredFiles = benchmarks.map((b) => b.path.split("/").at(-1));
		expect(discoveredFiles).toEqual([...discoveredFiles].sort());
	});

	it("loads valid benchmark modules with required exports", async () => {
		const benchmarks = await discoverBenchmarks();
		for (const benchmark of benchmarks) {
			expect(typeof benchmark.module.suiteName).toBe("string");
			expect(typeof benchmark.module.createSuite).toBe("function");
		}
	});

	it("loads all expected suite names", async () => {
		const benchmarks = await discoverBenchmarks();
		const suiteNames = benchmarks.map((b) => b.module.suiteName);
		for (const expectedName of EXPECTED_SUITE_NAMES) {
			expect(suiteNames).toContain(expectedName);
		}
	});
});

describe("Benchmark Filtering", () => {
	it("fails clearly when a query-pipeline case filter matches no task", async () => {
		await expect(
			createQueryPipelineSuite({ caseName: "unknown query case" }),
		).rejects.toThrow(
			"No query-pipeline benchmark matches case filter: unknown query case",
		);
	});

	it("filters benchmarks by suite name (exact match)", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "crud");
		expect(filtered.length).toBe(1);
		expect(filtered[0]?.module.suiteName).toBe("crud");
	});

	it("filters benchmarks by partial name (case-insensitive)", async () => {
		const benchmarks = await discoverBenchmarks();
		expect(filterBenchmarks(benchmarks, "serial")[0]?.module.suiteName).toBe(
			"serialization",
		);
		expect(filterBenchmarks(benchmarks, "CRUD")[0]?.module.suiteName).toBe(
			"crud",
		);
	});

	it("returns empty array for non-matching filter", async () => {
		const benchmarks = await discoverBenchmarks();
		expect(filterBenchmarks(benchmarks, "nonexistent-suite-name")).toEqual([]);
	});
});

describe("Benchmark Execution", () => {
	it("rejects duplicate tasks for the same engine and manifest case", async () => {
		const bench = new Bench({ iterations: 1, time: 0, warmup: false });
		for (let index = 0; index < 2; index++) {
			bench.add(`[typescript] create (single) duplicate ${index}`, () => {});
			attachTaskMetadata(requireTask(bench.tasks, index), {
				benchmarkName: "create (single)",
				engineId: "typescript",
				category: "write-transaction",
				caseType: "required",
				datasetSize: 10_000,
				operationCount: 1,
				normalInteraction: true,
				checksum: "checksum:duplicate",
			});
		}
		await bench.run();

		expect(() => buildComparisons(bench.tasks)).toThrow(
			"Duplicate benchmark task for typescript create (single)",
		);
	});

	it("executes synthetic suites and preserves input order", async () => {
		const first = createSyntheticBenchmark({ suiteName: "alpha" });
		const second = createSyntheticBenchmark({ suiteName: "beta" });

		const results = await executeAllSuites([first, second], {
			verbose: false,
		});

		expect(results.map((result) => result.suiteName)).toEqual([
			"alpha",
			"beta",
		]);
		expect(results[0]?.bench.tasks).toHaveLength(1);
		expect(results[0]?.durationMs).toBeGreaterThan(0);
	});

	it("runs teardown after a successful suite", async () => {
		const teardown = vi.fn(async () => {});
		await executeAllSuites(
			[createSyntheticBenchmark({ suiteName: "teardown-success", teardown })],
			{ verbose: false },
		);
		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it("runs teardown after a failing suite and rejects with execution details", async () => {
		const teardown = vi.fn(async () => {});

		await expect(
			executeAllSuites(
				[
					createSyntheticBenchmark({
						suiteName: "teardown-failure",
						shouldFail: true,
						teardown,
					}),
				],
				{ verbose: false },
			),
		).rejects.toMatchObject({
			name: "BenchmarkExecutionError",
			failures: [
				{
					suiteName: "teardown-failure",
					message: "synthetic failure",
				},
			],
		});

		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it("bounds setup and checksum probes with the suite attempt timeout", async () => {
		const startedAt = performance.now();
		for (const benchmark of [
			createSyntheticBenchmark({
				suiteName: "setup-timeout-suite",
				setupDelayMs: 100,
			}),
			createSyntheticBenchmark({
				suiteName: "probe-timeout-suite",
				checksumProbeDelayMs: 100,
			}),
		]) {
			await expect(
				executeAllSuites([benchmark], {
					verbose: false,
					attemptTimeoutMs: 10,
				}),
			).rejects.toBeInstanceOf(BenchmarkExecutionError);
		}
		expect(performance.now() - startedAt).toBeLessThan(100);
	});

	it("fails with a deterministic timeout path", async () => {
		const teardown = vi.fn(async () => {});

		await expect(
			executeAllSuites(
				[
					createSyntheticBenchmark({
						suiteName: "timeout-suite",
						delayMs: 100,
						teardown,
					}),
				],
				{
					verbose: false,
					attemptTimeoutMs: 10,
				},
			),
		).rejects.toMatchObject({
			name: "BenchmarkExecutionError",
			failures: [
				{
					suiteName: "timeout-suite",
					timedOut: true,
					message: "Benchmark suite attempt exceeded 10ms",
				},
			],
		});
		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it("aborts executeAllSuites immediately after a timeout and does not start later suites", async () => {
		const laterSuiteStarted = vi.fn();

		await expect(
			executeAllSuites(
				[
					createSyntheticBenchmark({
						suiteName: "timeout-first",
						delayMs: 100,
					}),
					createSyntheticBenchmark({
						suiteName: "later-suite",
						onCreateSuite: laterSuiteStarted,
					}),
				],
				{
					verbose: false,
					attemptTimeoutMs: 10,
				},
			),
		).rejects.toMatchObject({
			failures: [
				{
					suiteName: "timeout-first",
					timedOut: true,
				},
			],
		});

		expect(laterSuiteStarted).not.toHaveBeenCalled();
	});

	it("adapts iterations until the minimum sample floor succeeds", async () => {
		const teardown = vi.fn(async () => {});
		const checksumProbe = vi.fn();
		const results = await executeAllSuites(
			[
				createSyntheticBenchmark({
					suiteName: "adaptive-success",
					iterations: (requested) => Math.max(1, Math.floor(requested / 2)),
					checksumProbeDelayMs: 0,
					onChecksumProbe: checksumProbe,
					teardown,
				}),
			],
			{
				verbose: false,
				minSamplesPerTask: 30,
				maxAdaptiveAttempts: 3,
			},
		);

		expect(results[0]?.bench?.tasks[0]?.result?.latency.samples.length).toBe(
			30,
		);
		expect(checksumProbe).toHaveBeenCalledTimes(2);
		expect(teardown).toHaveBeenCalledTimes(2);
	});

	it("surfaces an exhausted adaptive retry failure when the sample floor never recovers", async () => {
		await expect(
			executeAllSuites(
				[
					createSyntheticBenchmark({
						suiteName: "adaptive-failure",
						iterations: () => 1,
					}),
				],
				{
					verbose: false,
					minSamplesPerTask: 30,
					maxAdaptiveAttempts: 2,
				},
			),
		).rejects.toMatchObject({
			failures: [
				{
					message: expect.stringContaining(
						"Unable to collect 30 samples after 2 attempt(s)",
					),
				},
			],
		});
	});

	it("builds JSON output with suite comparisons, failures, and full-report contract results", async () => {
		const bench = new Bench({ iterations: 30, time: 0, warmup: false });
		bench.add("[typescript] findById @ 10K", async () => {
			await Bun.sleep(1);
		});
		bench.add("[wasm] findById @ 10K", async () => {
			await Bun.sleep(2);
		});
		attachTaskMetadata(requireTask(bench.tasks, 0), {
			benchmarkName: "findById @ 10K",
			engineId: "typescript",
			category: "read-query",
			caseType: "required",
			operationCount: 1,
			normalInteraction: true,
			checksum: "checksum:ok",
		});
		attachTaskMetadata(requireTask(bench.tasks, 1), {
			benchmarkName: "findById @ 10K",
			engineId: "wasm",
			category: "read-query",
			caseType: "required",
			operationCount: 1,
			normalInteraction: true,
			checksum: "checksum:ok",
		});
		await bench.run();

		const output = buildBenchmarkJsonOutput(
			[
				{
					suiteName: "scaling",
					bench,
					durationMs: 10,
				},
			],
			{
				executionFailures: [
					{
						suiteName: "crud",
						path: "/synthetic/crud.bench.ts",
						message: "synthetic failure",
					},
				],
			},
		);

		expect(output.suites).toHaveLength(1);
		expect(output.suites[0]?.comparisons).toHaveLength(1);
		expect(output.suites[0]?.contract).toBeDefined();
		expect(output.suites[0]?.comparisons[0]?.name).toBe("findById @ 10K");
		expect(output.executionFailures).toHaveLength(1);
		expect(output.contract.passed).toBe(false);
		expect(
			output.contract.failures.some(
				(failure) => failure.caseName === "create (single)",
			),
		).toBe(true);
	});

	it("preserves exact percentile values in JSON output", () => {
		const output = buildBenchmarkJsonOutput([
			{
				suiteName: "crud",
				bench: {
					tasks: [
						{
							name: "[typescript] create (single)",
							result: {
								throughput: { mean: 100 },
								latency: {
									mean: 10,
									min: 1,
									max: 30,
									samples: Array.from({ length: 30 }, (_, index) => index + 1),
								},
							} as never,
						},
					] as never,
				} as Bench,
				durationMs: 1,
			},
		]);

		expect(output.suites[0]?.results[0]).toMatchObject({
			p50Ms: 15,
			p75Ms: 23,
			p95Ms: 29,
			p99Ms: 30,
		});
	});
});

describe("benchmark measurement defaults", () => {
	it("collects a bounded fixed sample floor instead of time-amplifying cleanup hooks", () => {
		expect(defaultBenchOptions).toMatchObject({
			time: 0,
			iterations: 30,
			warmup: true,
			warmupIterations: 5,
			warmupTime: 0,
		});
	});
});

describe("runner timeout normalization", () => {
	it("enforces the default bounded timeout unless no-timeout is explicitly requested", () => {
		expect(normalizeAttemptTimeoutMs(undefined)).toBe(900_000);
		expect(normalizeAttemptTimeoutMs(null)).toBeUndefined();
		expect(normalizeAttemptTimeoutMs(10)).toBe(10);
	});
});

const makeIsolatedOutput = (
	overrides: Partial<BenchmarkJsonOutput> = {},
): BenchmarkJsonOutput => ({
	timestamp: "2026-01-01T00:00:00.000Z",
	suites: [],
	contract: { passed: true, failures: [] },
	executionFailures: [],
	...overrides,
});

describe("isolated full-suite execution", () => {
	const suiteOutput = (suite: string): BenchmarkSuiteJsonOutput => ({
		suite,
		results: [],
		comparisons: [],
		contract: { passed: true, failures: [] },
		timestamp: "2026-01-01T00:00:00.000Z",
	});

	it("calculates an overflow-safe parent watchdog across every adaptive attempt", () => {
		expect(isolatedSuiteWatchdogMs(900_000, 3)).toBe(2_730_000);
		expect(isolatedSuiteWatchdogMs(25, 4)).toBe(30_100);
		expect(isolatedSuiteWatchdogMs(undefined, 3)).toBeUndefined();
		expect(isolatedSuiteWatchdogMs(Number.MAX_SAFE_INTEGER, 3)).toBe(
			2_147_483_647,
		);
	});

	it("parses the adaptive controls propagated through the child CLI", () => {
		expect(
			parseBenchmarkRunnerArgs([
				"query-pipeline",
				"--json",
				"--min-samples-per-task",
				"41",
				"--max-adaptive-attempts",
				"4",
				"--attempt-timeout-ms",
				"125",
				"--adaptive-time-multiplier",
				"2.5",
			]),
		).toMatchObject({
			filter: "query-pipeline",
			json: true,
			minSamplesPerTask: 41,
			maxAdaptiveAttempts: 4,
			attemptTimeoutMs: 125,
			adaptiveTimeMultiplier: 2.5,
		});
	});

	it("builds child arguments with adaptive controls and distinct timeout budgets", () => {
		const child = buildIsolatedSuiteChildProcessOptions({
			suiteName: "query-pipeline",
			includeStress: false,
			minSamplesPerTask: 41,
			maxAdaptiveAttempts: 4,
			attemptTimeoutMs: 125,
			adaptiveTimeMultiplier: 2.5,
			engines: ["wasm"],
			caseName: "filter equality @ 10K",
		});

		expect(child.env).toEqual({ PROSEQL_BENCH_SUITE_CHILD: "1" });
		expect(child.timeoutMs).toBe(30_500);
		expect(child.cmd).toEqual(
			expect.arrayContaining([
				"query-pipeline",
				"--json",
				"--engine",
				"wasm",
				"--case",
				"filter equality @ 10K",
				"--min-samples-per-task",
				"41",
				"--max-adaptive-attempts",
				"4",
				"--adaptive-time-multiplier",
				"2.5",
				"--attempt-timeout-ms",
				"125",
			]),
		);
	});

	it("isolates full-report suites while single-suite and guarded children stay in-process", () => {
		expect(
			shouldRunInIsolatedSuiteChild({
				isolateSuites: true,
				suiteName: "query-pipeline",
				includeStress: false,
				env: {},
			}),
		).toBe(true);
		expect(
			shouldRunInIsolatedSuiteChild({
				isolateSuites: false,
				suiteName: "query-pipeline",
				includeStress: false,
				env: {},
			}),
		).toBe(false);
		expect(
			shouldRunInIsolatedSuiteChild({
				isolateSuites: true,
				suiteName: "query-pipeline",
				includeStress: false,
				env: { PROSEQL_BENCH_SUITE_CHILD: "1" },
			}),
		).toBe(false);
		expect(
			shouldRunInIsolatedSuiteChild({
				isolateSuites: true,
				suiteName: "scaling",
				includeStress: true,
				env: {},
			}),
		).toBe(false);
	});

	it("merges exact suite JSON from a fresh child for every full-report suite", async () => {
		const executeProcess = vi.fn(
			async ({ cmd }: { cmd: ReadonlyArray<string> }) => {
				const suite = cmd[2] ?? "";
				return {
					exitCode: 0,
					stdout: JSON.stringify(
						makeIsolatedOutput({ suites: [suiteOutput(suite)] }),
					),
					stderr: "",
					timedOut: false,
				};
			},
		);
		const results = await executeAllSuites(
			[
				createSyntheticBenchmark({ suiteName: "serialization" }),
				createSyntheticBenchmark({ suiteName: "query-pipeline" }),
			],
			{
				verbose: false,
				isolateSuites: true,
				isolatedProcessExecutor: executeProcess,
			},
		);

		expect(results.map((result) => result.suiteOutput?.suite)).toEqual([
			"serialization",
			"query-pipeline",
		]);
		expect(executeProcess).toHaveBeenCalledTimes(2);
		for (const [call] of executeProcess.mock.calls) {
			expect(call.env).toEqual({ PROSEQL_BENCH_SUITE_CHILD: "1" });
			expect(call.timeoutMs).toBe(2_730_000);
			expect(call.cmd).toContain("--json");
			expect(call.cmd).toContain("--min-samples-per-task");
			expect(call.cmd).toContain("30");
			expect(call.cmd).toContain("--max-adaptive-attempts");
			expect(call.cmd).toContain("3");
			expect(call.cmd).toContain("--adaptive-time-multiplier");
			expect(call.cmd).toContain("2");
			expect(call.cmd).toContain("--attempt-timeout-ms");
			expect(call.cmd).toContain("900000");
		}
	});

	it("attributes isolated child process failures to their suite", async () => {
		await expect(
			executeAllSuites(
				[createSyntheticBenchmark({ suiteName: "query-pipeline" })],
				{
					verbose: false,
					isolateSuites: true,
					isolatedProcessExecutor: async () => ({
						exitCode: 2,
						stdout: JSON.stringify(
							makeIsolatedOutput({
								executionFailures: [
									{
										suiteName: "query-pipeline",
										path: "/bench/query-pipeline.bench.ts",
										message: "callback state failed",
									},
								],
							}),
						),
						stderr: "",
						timedOut: false,
					}),
				},
			),
		).rejects.toMatchObject({
			failures: [
				{
					suiteName: "query-pipeline",
					message: "callback state failed",
					timedOut: false,
				},
			],
		});
	});

	it("reports and stops after an isolated suite timeout", async () => {
		const executeProcess = vi.fn(async () => ({
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: true,
		}));
		await expect(
			executeAllSuites(
				[
					createSyntheticBenchmark({ suiteName: "serialization" }),
					createSyntheticBenchmark({ suiteName: "query-pipeline" }),
				],
				{
					verbose: false,
					attemptTimeoutMs: 25,
					isolateSuites: true,
					isolatedProcessExecutor: executeProcess,
				},
			),
		).rejects.toMatchObject({
			failures: [
				{
					suiteName: "serialization",
					timedOut: true,
					message:
						"Parent watchdog timed out after 30075ms for isolated serialization suite; each child attempt remains bounded to 25ms",
				},
			],
		});
		expect(executeProcess).toHaveBeenCalledTimes(1);
	});
});

describe("isolated stress execution", () => {
	it("propagates adaptive controls and the aggregate watchdog to stress children", async () => {
		const executeProcess = vi.fn(
			async ({ cmd }: { cmd: ReadonlyArray<string> }) => ({
				exitCode: 0,
				stdout: JSON.stringify(
					makeIsolatedOutput({
						suites: [
							{
								suite: "scaling",
								results: [],
								comparisons: [],
								contract: { passed: true, failures: [] },
								timestamp: "2026-01-01T00:00:00.000Z",
							},
						],
					}),
				),
				stderr: "",
				timedOut: false,
				cmd,
			}),
		);

		await executeAllSuites(
			[createSyntheticBenchmark({ suiteName: "scaling" })],
			{
				verbose: false,
				includeStress: true,
				caseName: "findById @ 100K",
				minSamplesPerTask: 41,
				maxAdaptiveAttempts: 4,
				attemptTimeoutMs: 125,
				adaptiveTimeMultiplier: 2.5,
				isolatedProcessExecutor: executeProcess,
			},
		);

		expect(executeProcess).toHaveBeenCalledTimes(2);
		for (const [call] of executeProcess.mock.calls) {
			expect(call.env).toEqual({ PROSEQL_BENCH_STRESS_CHILD: "1" });
			expect(call.timeoutMs).toBe(30_500);
			expect(call.cmd).toEqual(
				expect.arrayContaining([
					"--min-samples-per-task",
					"41",
					"--max-adaptive-attempts",
					"4",
					"--adaptive-time-multiplier",
					"2.5",
					"--attempt-timeout-ms",
					"125",
				]),
			);
		}
	});

	it("detects when scaling stress should run in a fresh child process without recursion", () => {
		expect(
			shouldRunInIsolatedStressChild({
				suiteName: "scaling",
				includeStress: true,
				env: {},
			}),
		).toBe(true);
		expect(
			shouldRunInIsolatedStressChild({
				suiteName: "scaling",
				includeStress: true,
				env: { PROSEQL_BENCH_STRESS_CHILD: "1" },
			}),
		).toBe(false);
		expect(
			shouldRunInIsolatedStressChild({
				suiteName: "crud",
				includeStress: true,
				env: {},
			}),
		).toBe(false);
	});

	it("merges per-engine isolated child JSON and keeps memory instrumentation intact", () => {
		const merged = mergeIsolatedStressSuiteOutputs({
			suiteName: "scaling",
			outputs: [
				{
					engineId: "typescript",
					output: {
						timestamp: "2026-01-01T00:00:00.000Z",
						suites: [
							{
								suite: "scaling",
								results: [],
								comparisons: [
									{
										name: "findById @ 100K",
										category: "read-query",
										caseType: "stress",
										datasetSize: 100_000,
										operationCount: 1,
										normalInteraction: false,
										throughputRatio: undefined,
										latencyRatio: undefined,
										checksum: "checksum:ok",
										checksumMatch: false,
										engines: {
											typescript: {
												name: "findById @ 100K",
												engineId: "typescript",
												opsPerSec: 100,
												meanMs: 10,
												p50Ms: 10,
												p75Ms: 10,
												p95Ms: 10,
												p99Ms: 10,
												minMs: 10,
												maxMs: 10,
												samples: 30,
												checksum: "checksum:ok",
												instrumentation: {
													initializationMs: {
														status: "unavailable",
														reason: "test",
													},
													coldStartMs: {
														status: "unavailable",
														reason: "test",
													},
													encodedCommandBytes: {
														status: "unavailable",
														reason: "test",
													},
													encodedResultBytes: {
														status: "unavailable",
														reason: "test",
													},
													compressedArtifactBytes: {
														status: "unavailable",
														reason: "test",
													},
													callbackCount: {
														status: "unavailable",
														reason: "test",
													},
													jsHeapBytes: { status: "available", value: 512 },
													wasmLinearMemoryHighWaterBytes: {
														status: "unavailable",
														reason: "test",
													},
													repeatedHighWaterGrowthBytes: {
														status: "available",
														value: 0,
													},
													boundary: {
														encodeMs: { status: "unavailable", reason: "test" },
														transferMs: {
															status: "unavailable",
															reason: "test",
														},
														engineMs: { status: "unavailable", reason: "test" },
														decodeMs: { status: "unavailable", reason: "test" },
														callbackMs: {
															status: "unavailable",
															reason: "test",
														},
													},
												},
											},
											wasm: undefined,
										},
									},
								],
								contract: { passed: true, failures: [] },
								timestamp: "2026-01-01T00:00:00.000Z",
							},
						],
						contract: { passed: true, failures: [] },
						executionFailures: [],
					},
				},
				{
					engineId: "wasm",
					output: {
						timestamp: "2026-01-01T00:00:00.000Z",
						suites: [
							{
								suite: "scaling",
								results: [],
								comparisons: [
									{
										name: "findById @ 100K",
										category: "read-query",
										caseType: "stress",
										datasetSize: 100_000,
										operationCount: 1,
										normalInteraction: false,
										throughputRatio: undefined,
										latencyRatio: undefined,
										checksum: "checksum:ok",
										checksumMatch: false,
										engines: {
											typescript: undefined,
											wasm: {
												name: "findById @ 100K",
												engineId: "wasm",
												opsPerSec: 50,
												meanMs: 20,
												p50Ms: 20,
												p75Ms: 20,
												p95Ms: 20,
												p99Ms: 20,
												minMs: 20,
												maxMs: 20,
												samples: 30,
												checksum: "checksum:ok",
												instrumentation: {
													initializationMs: {
														status: "unavailable",
														reason: "test",
													},
													coldStartMs: {
														status: "unavailable",
														reason: "test",
													},
													encodedCommandBytes: {
														status: "unavailable",
														reason: "test",
													},
													encodedResultBytes: {
														status: "unavailable",
														reason: "test",
													},
													compressedArtifactBytes: {
														status: "unavailable",
														reason: "test",
													},
													callbackCount: {
														status: "unavailable",
														reason: "test",
													},
													jsHeapBytes: { status: "available", value: 1_024 },
													wasmLinearMemoryHighWaterBytes: {
														status: "available",
														value: 2_048,
													},
													repeatedHighWaterGrowthBytes: {
														status: "available",
														value: 0,
													},
													boundary: {
														encodeMs: { status: "unavailable", reason: "test" },
														transferMs: {
															status: "unavailable",
															reason: "test",
														},
														engineMs: { status: "unavailable", reason: "test" },
														decodeMs: { status: "unavailable", reason: "test" },
														callbackMs: {
															status: "unavailable",
															reason: "test",
														},
													},
												},
											},
										},
									},
								],
								contract: { passed: true, failures: [] },
								timestamp: "2026-01-01T00:00:00.000Z",
							},
						],
						contract: { passed: true, failures: [] },
						executionFailures: [],
					},
				},
			],
		});

		expect(merged.comparisons[0]?.throughputRatio).toBe(0.5);
		expect(merged.comparisons[0]?.operationCount).toBe(1);
		expect(merged.contract.passed).toBe(true);
		expect(
			merged.comparisons[0]?.engines.wasm?.instrumentation
				.wasmLinearMemoryHighWaterBytes,
		).toEqual({ status: "available", value: 2_048 });
	});

	it("rejects missing suite output and child-reported execution failures", () => {
		expect(() =>
			mergeIsolatedStressSuiteOutputs({
				suiteName: "scaling",
				outputs: [{ engineId: "typescript", output: makeIsolatedOutput() }],
			}),
		).toThrow(/did not report suite scaling/i);

		expect(() =>
			mergeIsolatedStressSuiteOutputs({
				suiteName: "scaling",
				outputs: [
					{
						engineId: "wasm",
						output: makeIsolatedOutput({
							suites: [
								{
									suite: "scaling",
									results: [],
									comparisons: [],
									contract: { passed: false, failures: [] },
									timestamp: "2026-01-01T00:00:00.000Z",
								},
							],
							executionFailures: [
								{
									suiteName: "scaling",
									path: "/synthetic/scaling.bench.ts",
									message: "child failed",
								},
							],
						}),
					},
				],
			}),
		).toThrow("child failed");
	});

	it("captures non-zero exits and machine-readable stdout from isolated child processes", async () => {
		const failed = await executeIsolatedBenchmarkProcess({
			cmd: [
				process.execPath,
				"-e",
				"console.error('child failed'); process.exit(7)",
			],
		});
		expect(failed.exitCode).toBe(7);
		expect(failed.timedOut).toBe(false);
		expect(failed.stderr).toContain("child failed");

		const result = await executeIsolatedBenchmarkProcess({
			cmd: [
				process.execPath,
				"-e",
				"console.log(JSON.stringify({ ok: true, isolated: process.env.TEST_ISOLATED === '1' }))",
			],
			env: { TEST_ISOLATED: "1" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(JSON.parse(result.stdout)).toEqual({
			ok: true,
			isolated: true,
		});
		expect(result.stderr).toBe("");
	});

	it("kills isolated child processes that exceed the parent timeout", async () => {
		const result = await executeIsolatedBenchmarkProcess({
			cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			timeoutMs: 10,
		});

		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
	});
});
