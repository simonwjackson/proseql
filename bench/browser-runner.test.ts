import { describe, expect, it, vi } from "vitest";
import {
	aggregateBrowserPerformanceTrials,
	BROWSER_PERFORMANCE_MIN_SAMPLES_PER_TRIAL,
} from "./browser-aggregation.js";
import type { BrowserPerformanceReport } from "./browser-runner.js";
import {
	closeBrowserPerformancePage,
	validateBrowserWorkloadState,
} from "./browser-runner.js";
import {
	evaluateBrowserBudget,
	type WasmBuildBrowserBudgetContract,
} from "./performance-contract.js";
import {
	BROWSER_WORKLOAD_BASELINE_COUNT,
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_INTERACTION_NAMES,
	BROWSER_WORKLOAD_NAMES,
	type BrowserPerformanceWorkloadState,
} from "./workloads.js";

const BROWSER_BUDGET_CONTRACT: WasmBuildBrowserBudgetContract = {
	schemaVersion: "test",
	artifactBudgets: {
		browserProductionWasmGzipBaselineBytes: 540_028,
		browserProductionWasmGzipMaxGrowthRatio: 1.05,
	},
	browserBudgets: {
		baseline: {
			coldStartupMs: 1024.016123,
			jsHeapBytes: 11_739_108,
			wasmLinearMemoryBytes: 54_525_952,
		},
		coldStartupMaxGrowthRatio: 1.1,
		jsHeapMaximumBytes: 50_000_000,
		wasmLinearMemoryMaxGrowthRatio: 1.05,
	},
};

const makeBrowserReport = (options: {
	readonly coldStartupMs: number;
	readonly jsHeapBytes?: number;
	readonly wasmLinearMemoryBytes?: number;
	readonly samples?: ReadonlyArray<number>;
}): BrowserPerformanceReport => {
	const samples = options.samples ?? Array.from({ length: 30 }, () => 10);
	return {
		coldStartupMs: options.coldStartupMs,
		interactions: BROWSER_WORKLOAD_INTERACTION_NAMES.map((name) => ({
			name,
			samples,
			p50Ms: 10,
			p95Ms: 10,
			p99Ms: 10,
			meanMs: 10,
			observedCleanupCount: 10_000,
		})),
		jsHeapBytes:
			options.jsHeapBytes === undefined
				? { status: "unavailable", reason: "synthetic missing heap" }
				: { status: "available", value: options.jsHeapBytes },
		wasmLinearMemoryBytes:
			options.wasmLinearMemoryBytes === undefined
				? { status: "unavailable", reason: "synthetic missing memory" }
				: { status: "available", value: options.wasmLinearMemoryBytes },
	};
};

const evaluateAggregate = (report: BrowserPerformanceReport) =>
	evaluateBrowserBudget({
		contract: BROWSER_BUDGET_CONTRACT,
		report,
		currentArtifactGzipBytes: 540_028,
	});

const makeState = (
	workload: keyof typeof BROWSER_WORKLOAD_NAMES,
	overrides: Partial<BrowserPerformanceWorkloadState> = {},
): BrowserPerformanceWorkloadState => {
	const name = BROWSER_WORKLOAD_NAMES[workload];
	const expectation = BROWSER_WORKLOAD_EXPECTATIONS[name];
	return {
		workload: name,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		resultCount: expectation.resultCount,
		restorationVerified: true,
		...(expectation.targetExistsAfterCleanup === undefined
			? {}
			: { targetExistsAfterCleanup: expectation.targetExistsAfterCleanup }),
		...overrides,
	};
};

describe("aggregateBrowserPerformanceTrials", () => {
	it("uses median cold start, maximum memory, and all 90 interaction samples", () => {
		const aggregate = aggregateBrowserPerformanceTrials([
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 10_000_000,
				wasmLinearMemoryBytes: 54_000_000,
			}),
			makeBrowserReport({
				coldStartupMs: 1200,
				jsHeapBytes: 30_000_000,
				wasmLinearMemoryBytes: 56_000_000,
			}),
			makeBrowserReport({
				coldStartupMs: 1100,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 55_000_000,
			}),
		]);
		expect(aggregate.coldStartupMs).toBe(1100);
		expect(aggregate.jsHeapBytes).toEqual({
			status: "available",
			value: 30_000_000,
		});
		expect(aggregate.wasmLinearMemoryBytes).toEqual({
			status: "available",
			value: 56_000_000,
		});
		for (const interaction of aggregate.interactions) {
			expect(interaction.samples).toHaveLength(
				BROWSER_PERFORMANCE_MIN_SAMPLES_PER_TRIAL * 3,
			);
		}
	});

	it("fails the unchanged cold-start budget when the median exceeds 1126.42ms", () => {
		const aggregate = aggregateBrowserPerformanceTrials(
			[1100, 1127, 1200].map((coldStartupMs) =>
				makeBrowserReport({
					coldStartupMs,
					jsHeapBytes: 20_000_000,
					wasmLinearMemoryBytes: 54_525_952,
				}),
			),
		);
		const budget = evaluateAggregate(aggregate);
		expect(budget.coldStartup.maxAllowed).toBeCloseTo(1126.4177353);
		expect(budget.coldStartup.current).toBe(1127);
		expect(budget.coldStartup.passed).toBe(false);
	});

	it("uses the conservative memory maxima and fails unchanged memory budgets", () => {
		const aggregate = aggregateBrowserPerformanceTrials([
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 50_000_001,
				wasmLinearMemoryBytes: 57_252_250,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 30_000_000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
		]);
		const budget = evaluateAggregate(aggregate);
		expect(budget.jsHeap.current).toBe(50_000_001);
		expect(budget.jsHeap.passed).toBe(false);
		expect(budget.wasmLinearMemory.current).toBe(57_252_250);
		expect(budget.wasmLinearMemory.passed).toBe(false);
	});

	it("uses the slowest per-trial p95 so fast trials cannot dilute a regression", () => {
		const slowSamples = [
			...Array.from({ length: 26 }, () => 10),
			...Array.from({ length: 4 }, () => 50),
		];
		const aggregate = aggregateBrowserPerformanceTrials([
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
				samples: slowSamples,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
		]);
		const budget = evaluateAggregate(aggregate);
		// Only 4/90 combined samples are slow, so a pooled p95 would be 10ms.
		expect(aggregate.interactions[0]?.p95Ms).toBe(50);
		expect(
			budget.interactions.every(
				(interaction) => !interaction.withinAbsoluteP95Budget,
			),
		).toBe(true);
	});

	it("preserves unavailable metrics so the release memory gates fail", () => {
		const aggregate = aggregateBrowserPerformanceTrials([
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				wasmLinearMemoryBytes: 54_525_952,
			}),
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
			}),
		]);
		const budget = evaluateAggregate(aggregate);
		expect(aggregate.jsHeapBytes.status).toBe("unavailable");
		expect(aggregate.wasmLinearMemoryBytes.status).toBe("unavailable");
		expect(budget.jsHeap.passed).toBe(false);
		expect(budget.wasmLinearMemory.passed).toBe(false);
	});

	it("rejects any trial with fewer than 30 samples", () => {
		const reports = [
			makeBrowserReport({
				coldStartupMs: 1000,
				jsHeapBytes: 20_000_000,
				wasmLinearMemoryBytes: 54_525_952,
				samples: Array.from({ length: 29 }, () => 10),
			}),
			...Array.from({ length: 2 }, () =>
				makeBrowserReport({
					coldStartupMs: 1000,
					jsHeapBytes: 20_000_000,
					wasmLinearMemoryBytes: 54_525_952,
				}),
			),
		];
		expect(() => aggregateBrowserPerformanceTrials(reports)).toThrow(
			/collected 29 samples; expected at least 30/i,
		);
	});
});

describe("closeBrowserPerformancePage", () => {
	it("drains workload databases before closing the page", async () => {
		const calls: string[] = [];
		const page = {
			evaluate: vi.fn(async () => {
				calls.push("drain");
			}),
			close: vi.fn(async () => {
				calls.push("close");
			}),
		};

		await closeBrowserPerformancePage(page as never);

		expect(calls).toEqual(["drain", "close"]);
	});
});

describe("validateBrowserWorkloadState", () => {
	it("accepts the exported state when it matches the fixed workload expectation", () => {
		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.updateManyDeclarative,
				makeState("updateManyDeclarative"),
			),
		).not.toThrow();
	});

	it("rejects missing state, mismatched counts, and unverified cleanup", () => {
		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.findById10K,
				undefined,
			),
		).toThrow(/did not publish browser performance state/i);

		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.findById10K,
				makeState("findById10K", { resultCount: 0 }),
			),
		).toThrow(/expected result count 1/i);

		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.transactionalCreateUpdateDelete,
				makeState("transactionalCreateUpdateDelete", {
					restorationVerified: false,
				}),
			),
		).toThrow(/did not verify cleanup/i);
	});

	it("rejects workload mismatches and wrong cleanup target presence", () => {
		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.deleteSingle,
				makeState("createSingle"),
			),
		).toThrow(/published state for create \(single\)/i);

		expect(() =>
			validateBrowserWorkloadState(
				BROWSER_WORKLOAD_NAMES.deleteSingle,
				makeState("deleteSingle", { targetExistsAfterCleanup: false }),
			),
		).toThrow(/expected targetExistsAfterCleanup true/i);
	});
});
