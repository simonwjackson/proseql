import { Glob } from "bun";
import { fileURLToPath } from "node:url";
import type { Bench, BenchOptions } from "tinybench";
import {
	buildComparisons,
	getTaskMetadata,
	type EngineId,
	type PairedComparison,
	updateTaskMetadata,
} from "./comparison.js";
import {
	type PerformanceContractValidation,
	validateFullReportContract,
	validatePerformanceContract,
} from "./performance-contract.js";
import { WORKLOAD_MANIFEST } from "./workloads.js";
import {
	type FormattedBenchmarkResult,
	formatResultsJson,
	formatResultsTable,
} from "./utils.js";

const DEFAULT_MIN_SAMPLES_PER_TASK = 30;
const DEFAULT_MAX_ADAPTIVE_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 900_000;
const DEFAULT_ADAPTIVE_TIME_MULTIPLIER = 2;
const STRESS_CHILD_ENV = "PROSEQL_BENCH_STRESS_CHILD";
const RUNNER_PATH = fileURLToPath(import.meta.url);

export interface BenchmarkSuiteOptions {
	readonly includeStress?: boolean;
	readonly benchOptions?: Partial<BenchOptions>;
	readonly engines?: ReadonlyArray<EngineId>;
	readonly caseName?: string;
}

interface BenchmarkSuiteDefinition {
	readonly bench: Bench;
	readonly teardown?: () => Promise<void> | void;
}

interface BenchmarkModule {
	readonly suiteName: string;
	readonly createSuite: (
		options?: BenchmarkSuiteOptions,
	) => Promise<Bench | BenchmarkSuiteDefinition>;
	readonly run?: () => Promise<void>;
}

export interface DiscoveredBenchmark {
	readonly path: string;
	readonly module: BenchmarkModule;
}

export interface SuiteExecutionFailure {
	readonly suiteName: string;
	readonly path: string;
	readonly caseName?: string;
	readonly message: string;
	readonly timedOut?: boolean;
}

export interface BenchmarkSuiteJsonOutput {
	readonly suite: string;
	readonly results: ReadonlyArray<FormattedBenchmarkResult>;
	readonly comparisons: ReadonlyArray<PairedComparison>;
	readonly contract: PerformanceContractValidation;
	readonly timestamp: string;
}

export interface BenchmarkJsonOutput {
	readonly timestamp: string;
	readonly suites: ReadonlyArray<BenchmarkSuiteJsonOutput>;
	readonly contract: PerformanceContractValidation;
	readonly executionFailures: ReadonlyArray<SuiteExecutionFailure>;
}

async function discoverBenchFiles(): Promise<ReadonlyArray<string>> {
	const benchDir = import.meta.dir;
	const glob = new Glob("*.bench.ts");
	const files: string[] = [];
	for await (const file of glob.scan({ cwd: benchDir, absolute: true })) {
		files.push(file);
	}
	files.sort();
	return files;
}

async function importBenchModule(filePath: string): Promise<BenchmarkModule> {
	const module = (await import(filePath)) as Record<string, unknown>;

	if (typeof module.suiteName !== "string") {
		throw new Error(
			`Benchmark module ${filePath} must export 'suiteName: string'`,
		);
	}

	if (typeof module.createSuite !== "function") {
		throw new Error(
			`Benchmark module ${filePath} must export 'createSuite: (options?: BenchmarkSuiteOptions) => Promise<Bench>'`,
		);
	}

	return {
		suiteName: module.suiteName,
		createSuite: module.createSuite as BenchmarkModule["createSuite"],
		run:
			typeof module.run === "function"
				? (module.run as () => Promise<void>)
				: undefined,
	};
}

export async function discoverBenchmarks(): Promise<
	ReadonlyArray<DiscoveredBenchmark>
> {
	const files = await discoverBenchFiles();
	const benchmarks: DiscoveredBenchmark[] = [];

	for (const filePath of files) {
		try {
			const module = await importBenchModule(filePath);
			benchmarks.push({ path: filePath, module });
		} catch (error) {
			console.error(`Failed to load benchmark: ${filePath}`);
			if (error instanceof Error) {
				console.error(`  ${error.message}`);
			}
		}
	}

	return benchmarks;
}

export function filterBenchmarks(
	benchmarks: ReadonlyArray<DiscoveredBenchmark>,
	filter: string,
): ReadonlyArray<DiscoveredBenchmark> {
	const lowerFilter = filter.toLowerCase();
	return benchmarks.filter((b) =>
		b.module.suiteName.toLowerCase().includes(lowerFilter),
	);
}

export interface SuiteExecutionResult {
	readonly suiteName: string;
	readonly bench?: Bench;
	readonly suiteOutput?: BenchmarkSuiteJsonOutput;
	readonly durationMs: number;
}

export class BenchmarkExecutionError extends Error {
	readonly results: ReadonlyArray<SuiteExecutionResult>;
	readonly failures: ReadonlyArray<SuiteExecutionFailure>;

	constructor(options: {
		readonly results: ReadonlyArray<SuiteExecutionResult>;
		readonly failures: ReadonlyArray<SuiteExecutionFailure>;
	}) {
		super(
			options.failures.length === 1
				? (options.failures[0]?.message ?? "Benchmark suite failed")
				: `${options.failures.length} benchmark suites failed`,
		);
		this.name = "BenchmarkExecutionError";
		this.results = options.results;
		this.failures = options.failures;
	}
}

const normalizeSuiteDefinition = (
	definition: Bench | BenchmarkSuiteDefinition,
): BenchmarkSuiteDefinition => {
	if ("bench" in definition) {
		return definition;
	}
	return { bench: definition };
};

export const normalizeAttemptTimeoutMs = (
	timeoutMs: number | null | undefined,
): number | undefined =>
	timeoutMs === null ? undefined : (timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS);

export class BenchmarkAttemptTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(message: string, timeoutMs: number) {
		super(message);
		this.name = "BenchmarkAttemptTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

const createAttemptSignal = (timeoutMs: number) => {
	const controller = new AbortController();
	let rejectTimeout: ((error: Error) => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const timeoutId = setTimeout(() => {
		const error = new BenchmarkAttemptTimeoutError(
			`Benchmark suite attempt exceeded ${timeoutMs}ms`,
			timeoutMs,
		);
		controller.abort(error);
		rejectTimeout?.(error);
	}, timeoutMs);
	return {
		signal: controller.signal,
		timeout,
		dispose: () => clearTimeout(timeoutId),
	};
};

const getTaskSampleCount = (bench: Bench, taskName: string): number => {
	const task = bench.tasks.find((candidate) => candidate.name === taskName);
	return task?.result?.latency.samples.length ?? 0;
};

const summarizeInsufficientTasks = (
	bench: Bench,
	minSamplesPerTask: number,
): ReadonlyArray<string> =>
	bench.tasks
		.filter(
			(task) => (task.result?.latency.samples.length ?? 0) < minSamplesPerTask,
		)
		.map(
			(task) =>
				`${task.name} (${getTaskSampleCount(bench, task.name)}/${minSamplesPerTask} samples)`,
		);

export const shouldRunInIsolatedStressChild = (options: {
	readonly suiteName: string;
	readonly includeStress: boolean;
	readonly env?: Record<string, string | undefined>;
}): boolean => {
	const env = options.env ?? process.env;
	return (
		options.includeStress &&
		options.suiteName === "scaling" &&
		env[STRESS_CHILD_ENV] !== "1"
	);
};

const SCALING_STRESS_CASE_NAMES = WORKLOAD_MANIFEST.filter(
	(entry) => entry.suite === "scaling" && entry.caseType === "stress",
).map((entry) => entry.name);

export interface IsolatedProcessResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export const executeIsolatedBenchmarkProcess = async (options: {
	readonly cmd: ReadonlyArray<string>;
	readonly env?: Record<string, string | undefined>;
	readonly timeoutMs?: number;
}): Promise<IsolatedProcessResult> => {
	const child = Bun.spawn({
		cmd: [...options.cmd],
		env: {
			...process.env,
			...options.env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs !== undefined) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// Ignore kill failures from already-exited children.
			}
		}, options.timeoutMs);
	}
	const exited = child.exited.then((exitCode) => {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		return exitCode;
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		exited,
	]);
	return {
		exitCode: timedOut ? null : exitCode,
		stdout,
		stderr,
		timedOut,
	};
};

const parseBenchmarkJsonOutput = (
	stdout: string,
	context: string,
): BenchmarkJsonOutput => {
	if (stdout.trim().length === 0) {
		throw new Error(`${context} produced no machine-readable JSON output`);
	}
	try {
		return JSON.parse(stdout) as BenchmarkJsonOutput;
	} catch (error) {
		throw new Error(
			`${context} produced invalid machine-readable JSON output: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

async function executeSuiteAttempt(
	benchmark: DiscoveredBenchmark,
	options: {
		readonly includeStress: boolean;
		readonly benchOptions: Partial<BenchOptions>;
		readonly attemptTimeoutMs: number | undefined;
		readonly engines?: ReadonlyArray<EngineId>;
		readonly caseName?: string;
	},
): Promise<SuiteExecutionResult> {
	const startTime = performance.now();
	const attemptSignal =
		options.attemptTimeoutMs === undefined
			? undefined
			: createAttemptSignal(options.attemptTimeoutMs);
	let definition: BenchmarkSuiteDefinition | undefined;
	let teardownPromise: Promise<void> | undefined;
	const teardownOnce = (): Promise<void> => {
		if (!definition) {
			return Promise.resolve();
		}
		teardownPromise ??= Promise.resolve(definition.teardown?.()).then(
			() => undefined,
		);
		return teardownPromise;
	};
	const runAttempt = async (): Promise<SuiteExecutionResult> => {
		try {
			definition = normalizeSuiteDefinition(
				await benchmark.module.createSuite({
					includeStress: options.includeStress,
					engines: options.engines,
					caseName: options.caseName,
					benchOptions: {
						...options.benchOptions,
						...(attemptSignal ? { signal: attemptSignal.signal } : {}),
					},
				}),
			);
			await definition.bench.run();
			for (const task of definition.bench.tasks) {
				const metadata = getTaskMetadata(task);
				if (metadata?.checksumProbe) {
					const checksum = await metadata.checksumProbe();
					updateTaskMetadata(task, (current) => ({
						...current,
						checksum,
					}));
				}
			}
			for (const task of definition.bench.tasks) {
				if (task.result?.error) {
					throw task.result.error;
				}
				if (!task.result) {
					throw new Error(`Benchmark task produced no result: ${task.name}`);
				}
			}

			return {
				suiteName: benchmark.module.suiteName,
				bench: definition.bench,
				durationMs: performance.now() - startTime,
			};
		} finally {
			await teardownOnce();
		}
	};

	try {
		return attemptSignal
			? await Promise.race([runAttempt(), attemptSignal.timeout])
			: await runAttempt();
	} catch (error) {
		if (attemptSignal?.signal.aborted) {
			await teardownOnce();
		}
		throw error;
	} finally {
		attemptSignal?.dispose();
	}
}

async function executeSuite(
	benchmark: DiscoveredBenchmark,
	options: {
		readonly includeStress: boolean;
		readonly minSamplesPerTask: number;
		readonly maxAdaptiveAttempts: number;
		readonly attemptTimeoutMs: number | undefined;
		readonly adaptiveTimeMultiplier: number;
		readonly engines?: ReadonlyArray<EngineId>;
		readonly caseName?: string;
	},
): Promise<SuiteExecutionResult> {
	let attempt = 0;
	let benchOptions: Partial<BenchOptions> = {
		iterations: options.minSamplesPerTask,
	};
	let lastResult: SuiteExecutionResult | undefined;

	while (attempt < options.maxAdaptiveAttempts) {
		const result = await executeSuiteAttempt(benchmark, {
			includeStress: options.includeStress,
			benchOptions,
			attemptTimeoutMs: options.attemptTimeoutMs,
			engines: options.engines,
			caseName: options.caseName,
		});
		lastResult = result;

		const currentBench = result.bench;
		if (!currentBench) {
			return result;
		}
		const insufficientTasks = summarizeInsufficientTasks(
			currentBench,
			options.minSamplesPerTask,
		);
		if (insufficientTasks.length === 0) {
			return result;
		}

		attempt += 1;
		if (attempt >= options.maxAdaptiveAttempts) {
			throw new Error(
				`Unable to collect ${options.minSamplesPerTask} samples after ${options.maxAdaptiveAttempts} attempt(s): ${insufficientTasks.join(", ")}`,
			);
		}

		benchOptions = {
			...benchOptions,
			iterations: Math.max(
				options.minSamplesPerTask,
				(benchOptions.iterations ?? options.minSamplesPerTask) * 2,
			),
			time:
				benchOptions.time === undefined
					? undefined
					: benchOptions.time * options.adaptiveTimeMultiplier,
		};
	}

	if (!lastResult) {
		throw new Error(
			`Benchmark suite did not execute: ${benchmark.module.suiteName}`,
		);
	}
	return lastResult;
}

const requireSuiteOutput = (output: BenchmarkJsonOutput, suiteName: string) => {
	const suiteOutput = output.suites.find((suite) => suite.suite === suiteName);
	if (!suiteOutput) {
		throw new Error(`Isolated stress child did not report suite ${suiteName}`);
	}
	const suiteFailure = output.executionFailures.find(
		(failure) => failure.suiteName === suiteName,
	);
	if (suiteFailure) {
		throw new Error(suiteFailure.message);
	}
	return suiteOutput;
};

export const mergeIsolatedStressSuiteOutputs = (options: {
	readonly suiteName: string;
	readonly outputs: ReadonlyArray<{
		readonly engineId: EngineId;
		readonly output: BenchmarkJsonOutput;
	}>;
}): BenchmarkSuiteJsonOutput => {
	const results = options.outputs.flatMap(
		({ output }) => requireSuiteOutput(output, options.suiteName).results,
	);
	const comparisonsByName = new Map<string, PairedComparison>();
	for (const { output } of options.outputs) {
		for (const comparison of requireSuiteOutput(output, options.suiteName)
			.comparisons) {
			const current = comparisonsByName.get(comparison.name);
			const typescript =
				comparison.engines.typescript ?? current?.engines.typescript;
			const wasm = comparison.engines.wasm ?? current?.engines.wasm;
			comparisonsByName.set(comparison.name, {
				name: comparison.name,
				category: comparison.category,
				caseType: comparison.caseType,
				datasetSize: comparison.datasetSize,
				normalInteraction: comparison.normalInteraction,
				throughputRatio:
					typescript && wasm
						? wasm.opsPerSec / typescript.opsPerSec
						: undefined,
				latencyRatio:
					typescript && wasm ? wasm.meanMs / typescript.meanMs : undefined,
				checksum: typescript?.checksum ?? wasm?.checksum,
				checksumMatch:
					typescript?.checksum !== undefined &&
					wasm?.checksum !== undefined &&
					typescript.checksum === wasm.checksum,
				engines: {
					typescript,
					wasm,
				},
			});
		}
	}
	const comparisons = [...comparisonsByName.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	return {
		suite: options.suiteName,
		results: [...results].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
		comparisons,
		contract: validatePerformanceContract({
			suite: options.suiteName,
			comparisons,
		}),
		timestamp: new Date().toISOString(),
	};
};

async function executeSuiteInIsolatedStressChild(
	benchmark: DiscoveredBenchmark,
	options: {
		readonly attemptTimeoutMs: number | undefined;
		readonly caseName?: string;
	},
): Promise<SuiteExecutionResult> {
	const startedAt = performance.now();
	const outputs: Array<{
		readonly engineId: EngineId;
		readonly output: BenchmarkJsonOutput;
	}> = [];
	const caseNames =
		options.caseName === undefined
			? SCALING_STRESS_CASE_NAMES
			: [options.caseName];
	for (const caseName of caseNames) {
		for (const engineId of [
			"typescript",
			"wasm",
		] as const satisfies ReadonlyArray<EngineId>) {
			const childDescription = `${benchmark.module.suiteName} / ${caseName} / ${engineId}`;
			const result = await executeIsolatedBenchmarkProcess({
				cmd: [
					process.execPath,
					RUNNER_PATH,
					benchmark.module.suiteName,
					"--json",
					"--stress",
					"--engine",
					engineId,
					"--case",
					caseName,
					...(options.attemptTimeoutMs === undefined
						? ["--no-attempt-timeout"]
						: ["--attempt-timeout-ms", String(options.attemptTimeoutMs)]),
				],
				env: {
					[STRESS_CHILD_ENV]: "1",
				},
				timeoutMs: options.attemptTimeoutMs,
			});
			if (result.timedOut) {
				throw new BenchmarkAttemptTimeoutError(
					`Isolated stress child timed out after ${options.attemptTimeoutMs}ms for ${childDescription}`,
					options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
				);
			}
			if (result.exitCode !== 0) {
				throw new Error(
					result.stderr.trim() ||
						`Isolated stress child exited with code ${String(result.exitCode)} for ${childDescription}`,
				);
			}
			outputs.push({
				engineId,
				output: parseBenchmarkJsonOutput(
					result.stdout,
					`Isolated stress child ${childDescription}`,
				),
			});
		}
	}
	return {
		suiteName: benchmark.module.suiteName,
		suiteOutput: mergeIsolatedStressSuiteOutputs({
			suiteName: benchmark.module.suiteName,
			outputs,
		}),
		durationMs: performance.now() - startedAt,
	};
}

export async function executeAllSuites(
	benchmarks: ReadonlyArray<DiscoveredBenchmark>,
	options: {
		readonly verbose?: boolean;
		readonly includeStress?: boolean;
		readonly minSamplesPerTask?: number;
		readonly maxAdaptiveAttempts?: number;
		readonly attemptTimeoutMs?: number | null;
		readonly adaptiveTimeMultiplier?: number;
		readonly engines?: ReadonlyArray<EngineId>;
		readonly caseName?: string;
	} = {},
): Promise<ReadonlyArray<SuiteExecutionResult>> {
	const results: SuiteExecutionResult[] = [];
	const failures: SuiteExecutionFailure[] = [];
	const {
		verbose = true,
		includeStress = false,
		minSamplesPerTask = DEFAULT_MIN_SAMPLES_PER_TASK,
		maxAdaptiveAttempts = DEFAULT_MAX_ADAPTIVE_ATTEMPTS,
		attemptTimeoutMs: rawAttemptTimeoutMs,
		adaptiveTimeMultiplier = DEFAULT_ADAPTIVE_TIME_MULTIPLIER,
		engines,
		caseName,
	} = options;
	const attemptTimeoutMs = normalizeAttemptTimeoutMs(rawAttemptTimeoutMs);

	for (let index = 0; index < benchmarks.length; index++) {
		const benchmark = benchmarks[index];
		if (verbose) {
			console.log(
				`\n[${index + 1}/${benchmarks.length}] Running suite: ${benchmark.module.suiteName}`,
			);
		}

		try {
			const result = shouldRunInIsolatedStressChild({
				suiteName: benchmark.module.suiteName,
				includeStress,
			})
				? await executeSuiteInIsolatedStressChild(benchmark, {
						attemptTimeoutMs,
						caseName,
					})
				: await executeSuite(benchmark, {
						includeStress,
						minSamplesPerTask,
						maxAdaptiveAttempts,
						attemptTimeoutMs,
						adaptiveTimeMultiplier,
						engines,
						caseName,
					});
			results.push(result);
			if (verbose) {
				const benchmarkCount =
					result.bench?.tasks.length ?? result.suiteOutput?.results.length ?? 0;
				console.log(
					`  ✓ Completed in ${(result.durationMs / 1000).toFixed(2)}s (${benchmarkCount} benchmarks)`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const timedOut = error instanceof BenchmarkAttemptTimeoutError;
			failures.push({
				suiteName: benchmark.module.suiteName,
				path: benchmark.path,
				caseName,
				message,
				timedOut,
			});
			if (verbose) {
				console.error(`  ✗ Failed: ${message}`);
			}
			if (timedOut) {
				throw new BenchmarkExecutionError({ results, failures });
			}
		}
	}

	if (failures.length > 0) {
		throw new BenchmarkExecutionError({ results, failures });
	}

	return results;
}

export const buildBenchmarkJsonOutput = (
	results: ReadonlyArray<SuiteExecutionResult>,
	options: {
		readonly includeStress?: boolean;
		readonly executionFailures?: ReadonlyArray<SuiteExecutionFailure>;
		readonly fullReport?: boolean;
	} = {},
): BenchmarkJsonOutput => {
	const suites = results.map((result) => {
		if (result.suiteOutput) {
			return result.suiteOutput;
		}
		if (!result.bench) {
			throw new Error(`Missing benchmark data for suite ${result.suiteName}`);
		}
		const comparisons = buildComparisons(result.bench.tasks);
		return {
			suite: result.suiteName,
			results: formatResultsJson(result.suiteName, result.bench.tasks).results,
			comparisons,
			contract: validatePerformanceContract({
				suite: result.suiteName,
				comparisons,
			}),
			timestamp: new Date().toISOString(),
		};
	});

	const contract =
		options.fullReport === false
			? {
					passed: suites.every((suite) => suite.contract.passed),
					failures: suites.flatMap((suite) => suite.contract.failures),
				}
			: validateFullReportContract({
					suites: suites.map((suite) => ({
						suite: suite.suite,
						comparisons: suite.comparisons,
					})),
					includeStress: options.includeStress ?? false,
				});

	return {
		timestamp: new Date().toISOString(),
		suites,
		contract,
		executionFailures: options.executionFailures ?? [],
	};
};

function parseArgs(): {
	readonly json: boolean;
	readonly filter: string | null;
	readonly includeStress: boolean;
	readonly engines: ReadonlyArray<EngineId> | undefined;
	readonly caseName: string | null;
	readonly attemptTimeoutMs: number | null | undefined;
} {
	const args = process.argv.slice(2);
	let json = false;
	let includeStress = false;
	let engineValue: EngineId | undefined;
	let caseName: string | null = null;
	let attemptTimeoutMs: number | null | undefined;
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--json":
				json = true;
				break;
			case "--stress":
				includeStress = true;
				break;
			case "--engine": {
				const value = args[index + 1];
				if (value === "typescript" || value === "wasm") {
					engineValue = value;
					index += 1;
				}
				break;
			}
			case "--case":
				caseName = args[index + 1] ?? null;
				index += 1;
				break;
			case "--attempt-timeout-ms": {
				const value = args[index + 1];
				if (value !== undefined) {
					const parsed = Number.parseInt(value, 10);
					attemptTimeoutMs = Number.isFinite(parsed) ? parsed : undefined;
					index += 1;
				}
				break;
			}
			case "--no-attempt-timeout":
				attemptTimeoutMs = null;
				break;
			default:
				if (!arg.startsWith("--")) {
					positionals.push(arg);
				}
				break;
		}
	}

	return {
		json,
		filter: positionals[0] ?? null,
		includeStress,
		engines: engineValue === undefined ? undefined : [engineValue],
		caseName,
		attemptTimeoutMs,
	};
}

async function main(): Promise<void> {
	const { json, filter, includeStress, engines, caseName, attemptTimeoutMs } =
		parseArgs();
	let benchmarks = await discoverBenchmarks();

	if (benchmarks.length === 0) {
		console.error("No benchmark files found in bench/ directory");
		process.exit(1);
	}

	if (filter) {
		benchmarks = filterBenchmarks(benchmarks, filter);
		if (benchmarks.length === 0) {
			console.error(`No benchmarks match filter: ${filter}`);
			console.error("Available suites:");
			for (const benchmark of await discoverBenchmarks()) {
				console.error(`  - ${benchmark.module.suiteName}`);
			}
			process.exit(1);
		}
	}

	if (!json) {
		console.log("ProseQL Benchmark Runner");
		console.log("========================");
		console.log(`Discovered ${benchmarks.length} benchmark suite(s)`);
	}

	let results: ReadonlyArray<SuiteExecutionResult> = [];
	let executionFailures: ReadonlyArray<SuiteExecutionFailure> = [];
	let hadExecutionFailure = false;

	try {
		results = await executeAllSuites(benchmarks, {
			verbose: !json,
			includeStress,
			engines,
			caseName: caseName ?? undefined,
			attemptTimeoutMs,
		});
	} catch (error) {
		if (error instanceof BenchmarkExecutionError) {
			results = error.results;
			executionFailures = error.failures;
			hadExecutionFailure = true;
		} else {
			throw error;
		}
	}

	const output = buildBenchmarkJsonOutput(results, {
		includeStress,
		executionFailures,
		fullReport: filter === null && caseName === null,
	});

	if (json) {
		console.log(JSON.stringify(output, null, 2));
		if (hadExecutionFailure) {
			process.exit(1);
		}
		return;
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("BENCHMARK RESULTS");
	console.log("=".repeat(60));
	for (const result of results) {
		console.log(`\n## ${result.suiteName}`);
		console.log("-".repeat(40));
		if (result.bench) {
			console.log(formatResultsTable(result.bench.tasks));
		} else if (result.suiteOutput) {
			for (const row of result.suiteOutput.results) {
				console.log(
					`  ${row.name}: ${row.opsPerSec.toFixed(2)} ops/sec (${row.meanMs.toFixed(3)}ms mean)`,
				);
			}
		}
		const suiteOutput = output.suites.find(
			(suite) => suite.suite === result.suiteName,
		);
		if (suiteOutput && suiteOutput.comparisons.length > 0) {
			console.log("\nPaired comparison:");
			for (const comparison of suiteOutput.comparisons) {
				if (comparison.throughputRatio === undefined) {
					console.log(`  - ${comparison.name}: missing paired engine result`);
					continue;
				}
				console.log(
					`  - ${comparison.name}: wasm/typescript throughput ${(comparison.throughputRatio * 100).toFixed(1)}%`,
				);
			}
			if (!suiteOutput.contract.passed) {
				console.log("\nContract failures:");
				for (const failure of suiteOutput.contract.failures) {
					console.log(`  - ${failure.message}`);
				}
			}
		}
	}

	if (output.executionFailures.length > 0) {
		console.log("\nExecution failures:");
		for (const failure of output.executionFailures) {
			console.log(`  - ${failure.suiteName}: ${failure.message}`);
		}
	}

	if (!output.contract.passed) {
		console.log("\nFull report contract failures:");
		for (const failure of output.contract.failures) {
			console.log(`  - [${failure.suite}] ${failure.message}`);
		}
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("SUMMARY");
	console.log("=".repeat(60));
	const totalDuration = results.reduce(
		(sum, result) => sum + result.durationMs,
		0,
	);
	const totalBenchmarks = results.reduce(
		(sum, result) =>
			sum +
			(result.bench?.tasks.length ?? result.suiteOutput?.results.length ?? 0),
		0,
	);
	console.log(`Total suites: ${results.length}`);
	console.log(`Total benchmarks: ${totalBenchmarks}`);
	console.log(`Total time: ${(totalDuration / 1000).toFixed(2)}s`);

	if (hadExecutionFailure) {
		process.exit(1);
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("Benchmark runner failed:", error);
		process.exit(1);
	});
}
