import type { BrowserPerformanceReport } from "./browser-runner.js";
import type { PairedComparison } from "./comparison.js";
import {
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_INTERACTION_NAMES,
	WORKLOAD_MANIFEST,
	type WorkloadManifestEntry,
} from "./workloads.js";

export interface SuiteComparisonReport {
	readonly suite: string;
	readonly comparisons: ReadonlyArray<PairedComparison>;
}

export interface FullReportComparisonReport {
	readonly suites: ReadonlyArray<SuiteComparisonReport>;
	readonly includeStress: boolean;
}

export interface PerformanceContractFailure {
	readonly suite: string;
	readonly caseName: string;
	readonly message: string;
}

export interface PerformanceContractValidation {
	readonly passed: boolean;
	readonly failures: ReadonlyArray<PerformanceContractFailure>;
}

export interface WasmBuildBrowserBudgetContract {
	readonly schemaVersion: string;
	readonly artifactBudgets: {
		readonly browserProductionWasmGzipBaselineBytes: number;
		readonly browserProductionWasmGzipMaxGrowthRatio: number;
	};
	readonly browserBudgets: {
		readonly baseline: {
			readonly coldStartupMs: number;
			readonly jsHeapBytes: number;
			readonly wasmLinearMemoryBytes: number;
		};
		readonly coldStartupMaxGrowthRatio: number;
		readonly jsHeapMaxGrowthRatio: number;
		readonly wasmLinearMemoryMaxGrowthRatio: number;
	};
}

export interface BrowserBudgetMetricGate {
	readonly baseline: number;
	readonly current: number | undefined;
	readonly maxAllowed: number;
	readonly passed: boolean;
	readonly reason?: string;
}

export interface BrowserBudgetInteractionDelta {
	readonly name: string;
	readonly currentP95Ms: number | undefined;
	readonly withinAbsoluteP95Budget: boolean;
}

export interface BrowserBudgetEvaluation {
	readonly artifact: BrowserBudgetMetricGate;
	readonly coldStartup: BrowserBudgetMetricGate;
	readonly jsHeap: BrowserBudgetMetricGate;
	readonly wasmLinearMemory: BrowserBudgetMetricGate;
	readonly interactions: ReadonlyArray<BrowserBudgetInteractionDelta>;
	readonly summary: {
		readonly artifactAndRegressionBudgetsPassed: boolean;
		readonly allInteractionP95Within50Ms: boolean;
	};
}

const REQUIRED_THROUGHPUT_RATIO = 1;
const formatThroughputRatio = (ratio: number) => String(ratio);
const MIN_SAMPLES_PER_ENGINE = 30;
const NORMAL_INTERACTION_P95_BUDGET_MS = 50;
const STRESS_REPEATED_GROWTH_LIMIT = 0.05;

const MANIFEST_BY_NAME = new Map(
	WORKLOAD_MANIFEST.map((entry) => [entry.name, entry] as const),
);

const validateStressGrowth = (
	report: SuiteComparisonReport,
	comparison: PairedComparison,
	engineName: "typescript" | "wasm",
	engineResult: NonNullable<PairedComparison["engines"]["typescript"]>,
): ReadonlyArray<PerformanceContractFailure> => {
	const growthMetric =
		engineResult.instrumentation.repeatedHighWaterGrowthBytes.status ===
		"available"
			? engineResult.instrumentation.repeatedHighWaterGrowthBytes
			: undefined;
	const highWaterMetric =
		engineName === "wasm"
			? engineResult.instrumentation.wasmLinearMemoryHighWaterBytes.status ===
				"available"
				? engineResult.instrumentation.wasmLinearMemoryHighWaterBytes
				: undefined
			: engineResult.instrumentation.jsHeapBytes.status === "available"
				? engineResult.instrumentation.jsHeapBytes
				: undefined;

	if (engineName === "wasm" && !highWaterMetric) {
		return [
			{
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} must report WASM linear memory for stress case ${engineName}`,
			},
		];
	}

	if (!growthMetric || !highWaterMetric || highWaterMetric.value === 0) {
		return [];
	}

	const growthRatio = growthMetric.value / highWaterMetric.value;
	if (growthRatio <= STRESS_REPEATED_GROWTH_LIMIT) {
		return [];
	}

	return [
		{
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} repeated high-water growth for ${engineName} exceeded ${(STRESS_REPEATED_GROWTH_LIMIT * 100).toFixed(0)}% (${(growthRatio * 100).toFixed(2)}%)`,
		},
	];
};

const validateComparisonAgainstManifest = (
	report: SuiteComparisonReport,
	comparison: PairedComparison,
	manifestEntry: WorkloadManifestEntry,
): ReadonlyArray<PerformanceContractFailure> => {
	const failures: PerformanceContractFailure[] = [];
	const metadataChecks = [
		{
			matches: comparison.category === manifestEntry.category,
			message: `${comparison.name} must use category ${manifestEntry.category}; received ${comparison.category}`,
		},
		{
			matches: comparison.caseType === manifestEntry.caseType,
			message: `${comparison.name} must use case type ${manifestEntry.caseType}; received ${comparison.caseType}`,
		},
		{
			matches: comparison.datasetSize === manifestEntry.datasetSize,
			message: `${comparison.name} must use dataset size ${manifestEntry.datasetSize}; received ${comparison.datasetSize}`,
		},
		{
			matches: comparison.operationCount === manifestEntry.operationCount,
			message: `${comparison.name} must use operation count ${manifestEntry.operationCount}; received ${comparison.operationCount}`,
		},
		{
			matches: comparison.normalInteraction === manifestEntry.normalInteraction,
			message: `${comparison.name} must use normalInteraction ${String(manifestEntry.normalInteraction)}; received ${String(comparison.normalInteraction)}`,
		},
	];
	for (const check of metadataChecks) {
		if (!check.matches) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: check.message,
			});
		}
	}

	for (const [engineName, engineResult] of Object.entries(
		comparison.engines,
	) as ReadonlyArray<
		readonly ["typescript" | "wasm", typeof comparison.engines.typescript]
	>) {
		if (!engineResult) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} is missing engine result for ${engineName}`,
			});
			continue;
		}
		if (engineResult.engineId !== engineName) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} must report engineId ${engineName}; received ${engineResult.engineId}`,
			});
		}
		if (engineResult.name !== comparison.name) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} engine result for ${engineName} must use the same case name; received ${engineResult.name}`,
			});
		}
		if (engineResult.samples < MIN_SAMPLES_PER_ENGINE) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} collected ${engineResult.samples} samples for ${engineName}; expected at least ${MIN_SAMPLES_PER_ENGINE}`,
			});
		}
		if (engineResult.checksum === undefined) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} is missing a decoded-value checksum for ${engineName}`,
			});
		}
		if (manifestEntry.caseType === "stress") {
			failures.push(
				...validateStressGrowth(report, comparison, engineName, engineResult),
			);
		}
	}

	if (!comparison.checksumMatch) {
		failures.push({
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} produced a checksum mismatch between paired engines`,
		});
	}

	if (manifestEntry.caseType !== "required") {
		return failures;
	}

	if (
		comparison.throughputRatio === undefined ||
		!Number.isFinite(comparison.throughputRatio)
	) {
		failures.push({
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} must report a finite paired throughput ratio`,
		});
		return failures;
	}

	const typescriptOpsPerSec = comparison.engines.typescript?.opsPerSec;
	const wasmOpsPerSec = comparison.engines.wasm?.opsPerSec;
	if (
		typescriptOpsPerSec === undefined ||
		wasmOpsPerSec === undefined ||
		!Number.isFinite(typescriptOpsPerSec) ||
		!Number.isFinite(wasmOpsPerSec) ||
		typescriptOpsPerSec <= 0 ||
		wasmOpsPerSec <= 0
	) {
		failures.push({
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} must report finite positive throughput for both paired engines`,
		});
		return failures;
	}

	const pairedThroughputRatio = wasmOpsPerSec / typescriptOpsPerSec;
	if (comparison.throughputRatio !== pairedThroughputRatio) {
		failures.push({
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} supplied throughput ratio ${formatThroughputRatio(comparison.throughputRatio)} does not match paired engine throughput ${formatThroughputRatio(pairedThroughputRatio)}`,
		});
	}

	if (pairedThroughputRatio < REQUIRED_THROUGHPUT_RATIO) {
		failures.push({
			suite: report.suite,
			caseName: comparison.name,
			message: `${comparison.name} throughput ratio ${formatThroughputRatio(pairedThroughputRatio)} is below the required ${REQUIRED_THROUGHPUT_RATIO.toFixed(6)}`,
		});
	}

	return failures;
};

export const validatePerformanceContract = (
	report: SuiteComparisonReport,
): PerformanceContractValidation => {
	const failures: PerformanceContractFailure[] = [];
	const seenCaseNames = new Set<string>();

	for (const comparison of report.comparisons) {
		if (seenCaseNames.has(comparison.name)) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} appears more than once in suite ${report.suite}`,
			});
		} else {
			seenCaseNames.add(comparison.name);
		}
		const manifestEntry = MANIFEST_BY_NAME.get(comparison.name);
		if (!manifestEntry) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} is not present in the fixed workload manifest`,
			});
			continue;
		}
		if (manifestEntry.suite !== report.suite) {
			failures.push({
				suite: report.suite,
				caseName: comparison.name,
				message: `${comparison.name} belongs to suite ${manifestEntry.suite}, not ${report.suite}`,
			});
			continue;
		}
		failures.push(
			...validateComparisonAgainstManifest(report, comparison, manifestEntry),
		);
	}

	return {
		passed: failures.length === 0,
		failures,
	};
};

export const validateBrowserPerformanceContract = (
	report: BrowserPerformanceReport,
): PerformanceContractValidation => {
	const failures: PerformanceContractFailure[] = [];
	const interactionsByName = new Map(
		report.interactions.map(
			(interaction) => [interaction.name, interaction] as const,
		),
	);

	for (const name of BROWSER_WORKLOAD_INTERACTION_NAMES) {
		const interaction = interactionsByName.get(name);
		if (!interaction) {
			failures.push({
				suite: "browser",
				caseName: name,
				message: `${name} is missing from the browser performance report`,
			});
			continue;
		}
		if (interaction.samples.length < MIN_SAMPLES_PER_ENGINE) {
			failures.push({
				suite: "browser",
				caseName: name,
				message: `${name} collected ${interaction.samples.length} browser samples; expected at least ${MIN_SAMPLES_PER_ENGINE}`,
			});
		}
		if (interaction.p95Ms === undefined) {
			failures.push({
				suite: "browser",
				caseName: name,
				message: `${name} must report a Chromium p95 latency`,
			});
			continue;
		}
		if (interaction.p95Ms > NORMAL_INTERACTION_P95_BUDGET_MS) {
			failures.push({
				suite: "browser",
				caseName: name,
				message: `${name} exceeded the ${NORMAL_INTERACTION_P95_BUDGET_MS}ms Chromium p95 budget (${interaction.p95Ms.toFixed(2)}ms)`,
			});
		}
		const expected = BROWSER_WORKLOAD_EXPECTATIONS[name];
		if (interaction.observedCleanupCount !== expected.cleanupCount) {
			failures.push({
				suite: "browser",
				caseName: name,
				message: `${name} observed cleanup count ${String(interaction.observedCleanupCount)}; expected ${expected.cleanupCount}`,
			});
		}
	}

	if (report.wasmLinearMemoryBytes.status !== "available") {
		failures.push({
			suite: "browser",
			caseName: "wasmLinearMemoryBytes",
			message: `browser report must include a real WASM linear-memory metric (${report.wasmLinearMemoryBytes.reason})`,
		});
	}

	return {
		passed: failures.length === 0,
		failures,
	};
};

const evaluateBudgetGate = (
	baseline: number,
	current: number | undefined,
	maxGrowthRatio: number,
): BrowserBudgetMetricGate => {
	const maxAllowed = baseline * maxGrowthRatio;
	if (current === undefined) {
		return {
			baseline,
			current,
			maxAllowed,
			passed: false,
			reason: "missing current metric",
		};
	}
	return {
		baseline,
		current,
		maxAllowed,
		passed: current <= maxAllowed,
	};
};

export const evaluateBrowserBudget = (options: {
	readonly contract: WasmBuildBrowserBudgetContract;
	readonly report: BrowserPerformanceReport;
	readonly currentArtifactGzipBytes: number;
}): BrowserBudgetEvaluation => {
	const { contract, report, currentArtifactGzipBytes } = options;
	const artifact = evaluateBudgetGate(
		contract.artifactBudgets.browserProductionWasmGzipBaselineBytes,
		currentArtifactGzipBytes,
		contract.artifactBudgets.browserProductionWasmGzipMaxGrowthRatio,
	);
	const coldStartup = evaluateBudgetGate(
		contract.browserBudgets.baseline.coldStartupMs,
		report.coldStartupMs,
		contract.browserBudgets.coldStartupMaxGrowthRatio,
	);
	const jsHeap = evaluateBudgetGate(
		contract.browserBudgets.baseline.jsHeapBytes,
		report.jsHeapBytes.status === "available"
			? report.jsHeapBytes.value
			: undefined,
		contract.browserBudgets.jsHeapMaxGrowthRatio,
	);
	const wasmLinearMemory = evaluateBudgetGate(
		contract.browserBudgets.baseline.wasmLinearMemoryBytes,
		report.wasmLinearMemoryBytes.status === "available"
			? report.wasmLinearMemoryBytes.value
			: undefined,
		contract.browserBudgets.wasmLinearMemoryMaxGrowthRatio,
	);
	const interactions = report.interactions.map((interaction) => ({
		name: interaction.name,
		currentP95Ms: interaction.p95Ms,
		withinAbsoluteP95Budget:
			typeof interaction.p95Ms === "number" &&
			interaction.p95Ms <= NORMAL_INTERACTION_P95_BUDGET_MS,
	}));
	return {
		artifact,
		coldStartup,
		jsHeap,
		wasmLinearMemory,
		interactions,
		summary: {
			artifactAndRegressionBudgetsPassed:
				artifact.passed &&
				coldStartup.passed &&
				jsHeap.passed &&
				wasmLinearMemory.passed,
			allInteractionP95Within50Ms: interactions.every(
				(interaction) => interaction.withinAbsoluteP95Budget,
			),
		},
	};
};

export const validateFullReportContract = (
	report: FullReportComparisonReport,
): PerformanceContractValidation => {
	const failures: PerformanceContractFailure[] = [];
	const seenCaseNames = new Set<string>();

	for (const suite of report.suites) {
		const suiteValidation = validatePerformanceContract(suite);
		failures.push(...suiteValidation.failures);
		for (const comparison of suite.comparisons) {
			if (seenCaseNames.has(comparison.name)) {
				failures.push({
					suite: suite.suite,
					caseName: comparison.name,
					message: `${comparison.name} appears more than once in the full benchmark report`,
				});
			} else {
				seenCaseNames.add(comparison.name);
			}
		}
	}

	for (const manifestEntry of WORKLOAD_MANIFEST) {
		if (manifestEntry.caseType === "stress" && !report.includeStress) {
			continue;
		}
		if (!seenCaseNames.has(manifestEntry.name)) {
			failures.push({
				suite: manifestEntry.suite,
				caseName: manifestEntry.name,
				message: `${manifestEntry.name} is missing from the full benchmark report`,
			});
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
};
