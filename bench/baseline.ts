import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BenchmarkInstrumentation, NumericMetric } from "./comparison.js";
import type { BenchmarkJsonOutput } from "./runner.js";

const repoRoot = resolve(import.meta.dir, "..");
const outputPath = resolve(repoRoot, "bench/baselines/browser-wasm.json");
const rawOutputPath = resolve(
	repoRoot,
	"bench/generated/browser-wasm.raw.json",
);

export const isBaselineBlockingFailure = (message: string) =>
	message.includes("execution failure") ||
	message.includes("missing from the full benchmark report") ||
	message.includes("missing engine result") ||
	message.includes("missing a decoded-value checksum") ||
	message.includes("produced a checksum mismatch between paired engines") ||
	message.includes("not present in the fixed workload manifest") ||
	message.includes("belongs to suite");

export const getBaselineBlockingFailures = (report: BenchmarkJsonOutput) =>
	report.contract.failures.filter((failure) =>
		isBaselineBlockingFailure(failure.message),
	);

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
	schemaVersion: "bench.baseline.v1alpha4",
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
