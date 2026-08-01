import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { BenchmarkInstrumentation, NumericMetric } from "./comparison.js";
import type { BenchmarkJsonOutput } from "./runner.js";
import { WORKLOAD_MANIFEST } from "./workloads.js";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(moduleDir, "..");
const outputPath = resolve(repoRoot, "bench/baselines/browser-wasm.json");
const rawOutputPath = resolve(
	repoRoot,
	"bench/generated/browser-wasm.raw.json",
);

const STRICT_PARITY_FAILURE =
	/^.+ throughput ratio \S+ is below the required 1\.000000$/;

export const isBaselineBlockingFailure = (message: string) =>
	!STRICT_PARITY_FAILURE.test(message);

export const getBaselineBlockingFailures = (report: BenchmarkJsonOutput) =>
	report.contract.failures.filter((failure) =>
		isBaselineBlockingFailure(failure.message),
	);

export interface BaselineParityFailure {
	readonly suite: string;
	readonly caseName: string;
	readonly throughputRatio: number;
	readonly message: string;
}

const requireRecord = (
	value: unknown,
	label: string,
): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
};

export const collectBaselineParityFailures = (
	baseline: unknown,
): ReadonlyArray<BaselineParityFailure> => {
	const baselineRecord = requireRecord(baseline, "baseline");
	if (!Array.isArray(baselineRecord.suites)) {
		throw new Error("baseline suites must be an array");
	}

	const ratiosByCase = new Map<string, number>();
	const manifestByName = new Map(
		WORKLOAD_MANIFEST.map((entry) => [entry.name, entry] as const),
	);
	for (const [suiteIndex, suiteValue] of baselineRecord.suites.entries()) {
		const suite = requireRecord(suiteValue, `baseline suite ${suiteIndex}`);
		if (typeof suite.suite !== "string") {
			throw new Error(`baseline suite ${suiteIndex} must include a suite name`);
		}
		if (!Array.isArray(suite.cases)) {
			throw new Error(`baseline suite ${suiteIndex} cases must be an array`);
		}
		for (const [caseIndex, caseValue] of suite.cases.entries()) {
			const baselineCase = requireRecord(
				caseValue,
				`baseline suite ${suiteIndex} case ${caseIndex}`,
			);
			if (
				typeof baselineCase.name !== "string" ||
				typeof baselineCase.throughputRatio !== "number" ||
				!Number.isFinite(baselineCase.throughputRatio)
			) {
				throw new Error(
					`baseline suite ${suiteIndex} case ${caseIndex} must include a name and finite throughputRatio`,
				);
			}
			const manifestEntry = manifestByName.get(baselineCase.name);
			if (!manifestEntry) {
				throw new Error(
					`${baselineCase.name} is not present in the fixed workload manifest`,
				);
			}
			if (manifestEntry.suite !== suite.suite) {
				throw new Error(
					`${baselineCase.name} belongs to suite ${manifestEntry.suite}, not ${suite.suite}`,
				);
			}
			if (ratiosByCase.has(baselineCase.name)) {
				throw new Error(
					`${baselineCase.name} appears more than once in the checked-in complete baseline`,
				);
			}
			ratiosByCase.set(baselineCase.name, baselineCase.throughputRatio);
		}
	}

	return WORKLOAD_MANIFEST.flatMap((entry) => {
		if (entry.caseType !== "required") {
			return [];
		}
		const throughputRatio = ratiosByCase.get(entry.name);
		if (throughputRatio === undefined) {
			throw new Error(
				`${entry.name} is missing from the checked-in complete baseline`,
			);
		}
		if (throughputRatio >= 1) {
			return [];
		}
		return [
			{
				suite: entry.suite,
				caseName: entry.name,
				throughputRatio,
				message: `${entry.name} throughput ratio ${String(throughputRatio)} is below the required 1.000000`,
			},
		];
	});
};

export const assertBaselineReportIsCapturable = (
	report: BenchmarkJsonOutput,
): void => {
	const executionFailures = report.executionFailures.map((failure) => ({
		...failure,
		message: `execution failure: ${failure.message}`,
	}));
	const parityFailures = getBaselineBlockingFailures(report);
	if (executionFailures.length === 0 && parityFailures.length === 0) {
		return;
	}
	throw new Error(
		JSON.stringify(
			{
				executionFailures,
				parityFailures,
			},
			null,
			2,
		),
	);
};

const metricValue = (metric: NumericMetric): number | undefined =>
	metric.status === "available" ? metric.value : undefined;

const compactInstrumentation = (instrumentation: BenchmarkInstrumentation) => {
	const metrics = {
		initializationMs: metricValue(instrumentation.initializationMs),
		coldStartMs: metricValue(instrumentation.coldStartMs),
		encodedCommandBytes: metricValue(instrumentation.encodedCommandBytes),
		encodedResultBytes: metricValue(instrumentation.encodedResultBytes),
		compressedArtifactBytes: metricValue(
			instrumentation.compressedArtifactBytes,
		),
		callbackCount: metricValue(instrumentation.callbackCount),
		jsHeapBytes: metricValue(instrumentation.jsHeapBytes),
		wasmLinearMemoryHighWaterBytes: metricValue(
			instrumentation.wasmLinearMemoryHighWaterBytes,
		),
		repeatedHighWaterGrowthBytes: metricValue(
			instrumentation.repeatedHighWaterGrowthBytes,
		),
		boundaryEncodeMs: metricValue(instrumentation.boundary.encodeMs),
		boundaryTransferMs: metricValue(instrumentation.boundary.transferMs),
		engineMs: metricValue(instrumentation.boundary.engineMs),
		boundaryDecodeMs: metricValue(instrumentation.boundary.decodeMs),
		callbackMs: metricValue(instrumentation.boundary.callbackMs),
	};
	return Object.fromEntries(
		Object.entries(metrics).filter((entry) => entry[1] !== undefined),
	);
};

const measureWasmArtifact = async () => {
	const path = resolve(
		repoRoot,
		"packages/engine/dist/browser-wasm/proseql_wasm_bg.wasm",
	);
	try {
		const bytes = await readFile(path);
		return {
			status: "available" as const,
			path: "packages/engine/dist/browser-wasm/proseql_wasm_bg.wasm",
			rawBytes: bytes.byteLength,
			gzipBytes: gzipSync(bytes).byteLength,
		};
	} catch (error) {
		return {
			status: "unavailable" as const,
			reason:
				error instanceof Error ? error.message : "unable to read WASM artifact",
		};
	}
};

const summarizeBaselineReport = async (report: BenchmarkJsonOutput) => ({
	schemaVersion: "bench.baseline.v1alpha5",
	capturedAt: report.timestamp,
	runtime: "bun",
	coverage: {
		kind: "full",
		includeStress: false,
	},
	generatedBy: {
		command: "bun run bench/runner.ts --json",
		harness: "bench/runner.ts",
		rawReportPath: "bench/generated/browser-wasm.raw.json",
	},
	browser: {
		status: "unavailable",
		reason:
			"Run `bun run bench:browser-report` to capture the real Chromium contract report.",
	},
	artifact: await measureWasmArtifact(),
	suites: report.suites.map((suite) => ({
		suite: suite.suite,
		cases: suite.comparisons.map((comparison) => ({
			name: comparison.name,
			category: comparison.category,
			caseType: comparison.caseType,
			datasetSize: comparison.datasetSize,
			operationCount: comparison.operationCount,
			normalInteraction: comparison.normalInteraction,
			throughputRatio: comparison.throughputRatio,
			latencyRatio: comparison.latencyRatio,
			checksum: comparison.checksum,
			checksumMatch: comparison.checksumMatch,
			engines: {
				typescript: comparison.engines.typescript
					? {
							opsPerSec: comparison.engines.typescript.opsPerSec,
							p95Ms: comparison.engines.typescript.p95Ms,
							checksum: comparison.engines.typescript.checksum,
							instrumentation: compactInstrumentation(
								comparison.engines.typescript.instrumentation,
							),
						}
					: undefined,
				wasm: comparison.engines.wasm
					? {
							opsPerSec: comparison.engines.wasm.opsPerSec,
							p95Ms: comparison.engines.wasm.p95Ms,
							checksum: comparison.engines.wasm.checksum,
							instrumentation: compactInstrumentation(
								comparison.engines.wasm.instrumentation,
							),
						}
					: undefined,
			},
			contractFailures: suite.contract.failures
				.filter((failure) => failure.caseName === comparison.name)
				.map((failure) => failure.message),
		})),
	})),
	contractFailures: report.contract.failures,
	executionFailures: report.executionFailures,
});

export const describeBenchmarkRunnerFailure = (
	exitCode: number,
	stdout: string,
	stderr: string,
): string => {
	try {
		const report = JSON.parse(stdout) as Partial<BenchmarkJsonOutput>;
		if (
			Array.isArray(report.executionFailures) &&
			report.executionFailures.length > 0
		) {
			return [
				`Benchmark runner exited with code ${exitCode}:`,
				...report.executionFailures.map(
					(failure) => `${failure.suiteName}: ${failure.message}`,
				),
			].join("\n");
		}
	} catch {
		// Fall through to the child diagnostic when stdout is not a JSON report.
	}

	return stderr || `Benchmark runner exited with code ${exitCode}`;
};

export const captureBaseline = async (): Promise<void> => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, resolve(repoRoot, "bench/runner.ts"), "--json"],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});

	if (result.exitCode !== 0) {
		throw new Error(
			describeBenchmarkRunnerFailure(
				result.exitCode,
				result.stdout.toString(),
				result.stderr.toString(),
			),
		);
	}

	const report = JSON.parse(result.stdout.toString()) as BenchmarkJsonOutput;
	assertBaselineReportIsCapturable(report);

	const baseline = await summarizeBaselineReport(report);
	await mkdir(resolve(repoRoot, "bench/generated"), { recursive: true });
	await writeFile(rawOutputPath, `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
	console.log(`Wrote baseline to ${outputPath}`);
};

if (import.meta.main) {
	await captureBaseline();
}
