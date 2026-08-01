import { describe, expect, it } from "vitest";
import {
	checksumBenchmarkValue,
	createUnavailableMetric,
	type PairedComparison,
} from "./comparison.js";
import {
	evaluateBrowserBudget,
	validateBrowserPerformanceContract,
	validateFullReportContract,
	validatePerformanceContract,
} from "./performance-contract.js";

const makeComparison = (
	overrides: Partial<PairedComparison> = {},
): PairedComparison => ({
	name: "create (single)",
	category: "write-transaction",
	caseType: "required",
	datasetSize: 10_000,
	normalInteraction: true,
	throughputRatio: 0.25,
	latencyRatio: 1.1,
	checksum: "checksum:ok",
	checksumMatch: true,
	engines: {
		typescript: {
			name: "create (single)",
			engineId: "typescript",
			opsPerSec: 100,
			meanMs: 10,
			p50Ms: 9,
			p75Ms: 11,
			p95Ms: 14,
			p99Ms: 15,
			minMs: 8,
			maxMs: 16,
			samples: 30,
			checksum: "checksum:ok",
			instrumentation: {
				initializationMs: { status: "unavailable", reason: "test" },
				coldStartMs: { status: "unavailable", reason: "test" },
				encodedCommandBytes: { status: "unavailable", reason: "test" },
				encodedResultBytes: { status: "unavailable", reason: "test" },
				compressedArtifactBytes: { status: "unavailable", reason: "test" },
				callbackCount: { status: "unavailable", reason: "test" },
				jsHeapBytes: { status: "unavailable", reason: "test" },
				wasmLinearMemoryHighWaterBytes: {
					status: "unavailable",
					reason: "test",
				},
				repeatedHighWaterGrowthBytes: {
					status: "unavailable",
					reason: "test",
				},
				boundary: {
					encodeMs: { status: "unavailable", reason: "test" },
					transferMs: { status: "unavailable", reason: "test" },
					engineMs: { status: "unavailable", reason: "test" },
					decodeMs: { status: "unavailable", reason: "test" },
					callbackMs: { status: "unavailable", reason: "test" },
				},
			},
		},
		wasm: {
			name: "create (single)",
			engineId: "wasm",
			opsPerSec: 25,
			meanMs: 12,
			p50Ms: 11,
			p75Ms: 12,
			p95Ms: 16,
			p99Ms: 18,
			minMs: 10,
			maxMs: 19,
			samples: 30,
			checksum: "checksum:ok",
			instrumentation: {
				initializationMs: { status: "unavailable", reason: "test" },
				coldStartMs: { status: "unavailable", reason: "test" },
				encodedCommandBytes: { status: "unavailable", reason: "test" },
				encodedResultBytes: { status: "unavailable", reason: "test" },
				compressedArtifactBytes: { status: "unavailable", reason: "test" },
				callbackCount: { status: "unavailable", reason: "test" },
				jsHeapBytes: { status: "unavailable", reason: "test" },
				wasmLinearMemoryHighWaterBytes: {
					status: "unavailable",
					reason: "test",
				},
				repeatedHighWaterGrowthBytes: {
					status: "unavailable",
					reason: "test",
				},
				boundary: {
					encodeMs: { status: "unavailable", reason: "test" },
					transferMs: { status: "unavailable", reason: "test" },
					engineMs: { status: "unavailable", reason: "test" },
					decodeMs: { status: "unavailable", reason: "test" },
					callbackMs: { status: "unavailable", reason: "test" },
				},
			},
		},
	},
	...overrides,
});

describe("validatePerformanceContract", () => {
	it("passes when a suite reports only its own manifest cases and they meet thresholds", () => {
		const report = {
			suite: "scaling",
			comparisons: [
				makeComparison({
					name: "findById @ 10K",
					category: "read-query",
					throughputRatio: 0.5,
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							name: "findById @ 10K",
							p95Ms: 5,
						},
						wasm: {
							...makeComparison().engines.wasm,
							name: "findById @ 10K",
							opsPerSec: 50,
							p95Ms: 8,
						},
					},
				}),
			],
		};

		const validation = validatePerformanceContract(report);

		expect(validation.passed).toBe(true);
		expect(validation.failures).toEqual([]);
	});

	it("fails when a comparison belongs to a different suite manifest", () => {
		const validation = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					name: "findById @ 10K",
					category: "read-query",
				}),
			],
		});

		expect(validation.passed).toBe(false);
		expect(validation.failures[0]?.message).toContain(
			"belongs to suite scaling",
		);
	});

	it("fails when a required case is slower than its category threshold", () => {
		const validation = validatePerformanceContract({
			suite: "query-pipeline",
			comparisons: [
				makeComparison({
					name: "filter: equality (role = 'admin')",
					category: "read-query",
					throughputRatio: 0.49,
				}),
			],
		});

		expect(validation.passed).toBe(false);
		expect(validation.failures[0]?.message).toContain("0.49");
		expect(validation.failures[0]?.message).toContain("0.50");
	});

	it("fails when an engine result is missing, undersampled, or missing a checksum", () => {
		const missingEngine = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					engines: {
						typescript: makeComparison().engines.typescript,
						wasm: undefined,
					},
				}),
			],
		});
		expect(missingEngine.passed).toBe(false);
		expect(missingEngine.failures[0]?.message).toContain(
			"missing engine result",
		);

		const insufficientSamples = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							samples: 29,
						},
						wasm: makeComparison().engines.wasm,
					},
				}),
			],
		});
		expect(insufficientSamples.passed).toBe(false);
		expect(insufficientSamples.failures[0]?.message).toContain("30");

		const missingChecksum = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					checksumMatch: false,
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							checksum: undefined,
						},
						wasm: makeComparison().engines.wasm,
					},
				}),
			],
		});
		expect(missingChecksum.passed).toBe(false);
		expect(
			missingChecksum.failures.some((failure) =>
				failure.message.includes("missing a decoded-value checksum"),
			),
		).toBe(true);
	});

	it("does not treat Bun suite p95 values as the browser performance gate", () => {
		const validation = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							p95Ms: undefined,
						},
						wasm: {
							...makeComparison().engines.wasm,
							p95Ms: 51,
						},
					},
				}),
			],
		});
		expect(validation.passed).toBe(true);
		expect(validation.failures).toEqual([]);
	});

	it("fails when paired checksums differ", () => {
		const validation = validatePerformanceContract({
			suite: "crud",
			comparisons: [
				makeComparison({
					checksumMatch: false,
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							checksum: "checksum:typescript",
						},
						wasm: {
							...makeComparison().engines.wasm,
							checksum: "checksum:wasm",
						},
					},
				}),
			],
		});

		expect(validation.passed).toBe(false);
		expect(validation.failures[0]?.message).toContain("checksum");
	});

	it("fails stress cases when repeated high-water growth exceeds the safety budget", () => {
		const validation = validatePerformanceContract({
			suite: "scaling",
			comparisons: [
				makeComparison({
					name: "findById @ 100K",
					caseType: "stress",
					normalInteraction: false,
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							name: "findById @ 100K",
							instrumentation: {
								...makeComparison().engines.typescript.instrumentation,
								jsHeapBytes: { status: "available", value: 1_000 },
								repeatedHighWaterGrowthBytes: {
									status: "available",
									value: 100,
								},
							},
						},
						wasm: {
							...makeComparison().engines.wasm,
							name: "findById @ 100K",
							instrumentation: {
								...makeComparison().engines.wasm.instrumentation,
								wasmLinearMemoryHighWaterBytes: {
									status: "available",
									value: 1_000,
								},
								repeatedHighWaterGrowthBytes: {
									status: "available",
									value: 60,
								},
							},
						},
					},
				}),
			],
		});

		expect(validation.passed).toBe(false);
		expect(
			validation.failures.some((failure) =>
				failure.message.includes("repeated high-water growth"),
			),
		).toBe(true);
	});

	it("requires a real WASM linear-memory metric for wasm stress comparisons", () => {
		const validation = validatePerformanceContract({
			suite: "scaling",
			comparisons: [
				makeComparison({
					name: "findById @ 100K",
					caseType: "stress",
					normalInteraction: false,
					engines: {
						typescript: {
							...makeComparison().engines.typescript,
							name: "findById @ 100K",
							instrumentation: {
								...makeComparison().engines.typescript.instrumentation,
								jsHeapBytes: { status: "available", value: 1_000 },
								repeatedHighWaterGrowthBytes: { status: "available", value: 0 },
							},
						},
						wasm: {
							...makeComparison().engines.wasm,
							name: "findById @ 100K",
							instrumentation: {
								...makeComparison().engines.wasm.instrumentation,
								jsHeapBytes: { status: "available", value: 1_000 },
								wasmLinearMemoryHighWaterBytes: createUnavailableMetric(
									"missing wasm memory",
								),
								repeatedHighWaterGrowthBytes: { status: "available", value: 0 },
							},
						},
					},
				}),
			],
		});

		expect(validation.passed).toBe(false);
		expect(
			validation.failures.some((failure) =>
				failure.message.includes("WASM linear memory"),
			),
		).toBe(true);
	});
});

describe("validateBrowserPerformanceContract", () => {
	it("fails when a required interaction is missing, undersampled, or over budget", () => {
		const validation = validateBrowserPerformanceContract({
			coldStartupMs: 120,
			interactions: [
				{
					name: "create (single)",
					samples: Array.from({ length: 30 }, () => 10),
					p50Ms: 10,
					p95Ms: 60,
					p99Ms: 60,
					meanMs: 10,
					observedCleanupCount: 10_000,
				},
			],
			jsHeapBytes: { status: "available", value: 2_048 },
			wasmLinearMemoryBytes: { status: "available", value: 4_096 },
		});

		expect(validation.passed).toBe(false);
		expect(
			validation.failures.some((failure) =>
				failure.message.includes("missing from the browser performance report"),
			),
		).toBe(true);
		expect(
			validation.failures.some((failure) => failure.message.includes("50ms")),
		).toBe(true);
	});

	it("passes when all required interactions meet the Chromium browser budget", () => {
		const validation = validateBrowserPerformanceContract({
			coldStartupMs: 100,
			interactions: [
				...[
					"findById @ 10K",
					"paginate: limit 100, offset 500",
					"create (single)",
					"update (single)",
					"delete (single)",
					"updateMany (declarative batch ~100)",
					"updateMany (predicate batch ~100)",
					"transactional (create + update + delete)",
				].map((name) => ({
					name,
					samples: Array.from({ length: 30 }, () => 10),
					p50Ms: 10,
					p95Ms: 20,
					p99Ms: 25,
					meanMs: 10,
					observedCleanupCount: 10_000,
				})),
			],
			jsHeapBytes: createUnavailableMetric("cdp unavailable"),
			wasmLinearMemoryBytes: { status: "available", value: 4_096 },
		});

		expect(validation.passed).toBe(true);
		expect(validation.failures).toEqual([]);
	});

	it("fails when a browser interaction omits the observed cleanup count or WASM memory", () => {
		const validation = validateBrowserPerformanceContract({
			coldStartupMs: 100,
			interactions: [
				...[
					"findById @ 10K",
					"paginate: limit 100, offset 500",
					"create (single)",
					"update (single)",
					"delete (single)",
					"updateMany (declarative batch ~100)",
					"updateMany (predicate batch ~100)",
					"transactional (create + update + delete)",
				].map((name, index) => ({
					name,
					samples: Array.from({ length: 30 }, () => 10),
					p50Ms: 10,
					p95Ms: 20,
					p99Ms: 25,
					meanMs: 10,
					observedCleanupCount: index === 0 ? undefined : 10_000,
				})),
			],
			jsHeapBytes: createUnavailableMetric("cdp unavailable"),
			wasmLinearMemoryBytes: createUnavailableMetric("missing wasm memory"),
		});

		expect(validation.passed).toBe(false);
		expect(
			validation.failures.some((failure) =>
				failure.message.includes("observed cleanup count"),
			),
		).toBe(true);
		expect(
			validation.failures.some((failure) =>
				failure.message.includes("WASM linear-memory metric"),
			),
		).toBe(true);
	});
});

describe("evaluateBrowserBudget", () => {
	it("separates artifact and regression budgets from the absolute p95 interaction budget", () => {
		const evaluation = evaluateBrowserBudget({
			contract: {
				schemaVersion: "proseql.wasm-build-contract.v1",
				artifactBudgets: {
					browserProductionWasmGzipBaselineBytes: 540_028,
					browserProductionWasmGzipMaxGrowthRatio: 1.05,
				},
				browserBudgets: {
					baseline: {
						coldStartupMs: 1_000,
						jsHeapBytes: 10_000,
						wasmLinearMemoryBytes: 20_000,
					},
					coldStartupMaxGrowthRatio: 1.1,
					jsHeapMaxGrowthRatio: 1.05,
					wasmLinearMemoryMaxGrowthRatio: 1.05,
				},
			},
			currentArtifactGzipBytes: 540_028,
			report: {
				coldStartupMs: 1_100,
				interactions: [
					{
						name: "findById @ 10K",
						samples: Array.from({ length: 30 }, () => 10),
						p50Ms: 10,
						p95Ms: 10,
						p99Ms: 20,
						meanMs: 10,
						observedCleanupCount: 10_000,
					},
					{
						name: "updateMany (predicate batch ~100)",
						samples: Array.from({ length: 30 }, () => 75),
						p50Ms: 75,
						p95Ms: 75,
						p99Ms: 80,
						meanMs: 75,
						observedCleanupCount: 10_000,
					},
				],
				jsHeapBytes: { status: "available", value: 11_000 },
				wasmLinearMemoryBytes: { status: "available", value: 24_000 },
			},
		});

		expect(evaluation.summary.artifactAndRegressionBudgetsPassed).toBe(false);
		expect(evaluation.coldStartup.passed).toBe(true);
		expect(evaluation.jsHeap.passed).toBe(false);
		expect(evaluation.wasmLinearMemory.passed).toBe(false);
		expect(evaluation.summary.allInteractionP95Within50Ms).toBe(false);
		expect(evaluation.artifact.maxAllowed).toBeCloseTo(567_029.4);
		expect(evaluation.interactions[0]).toMatchObject({
			name: "findById @ 10K",
			currentP95Ms: 10,
			withinAbsoluteP95Budget: true,
		});
		expect(evaluation.interactions[1]).toMatchObject({
			name: "updateMany (predicate batch ~100)",
			withinAbsoluteP95Budget: false,
		});
	});

	it("fails a regression gate when the current metric is unavailable", () => {
		const evaluation = evaluateBrowserBudget({
			contract: {
				schemaVersion: "proseql.wasm-build-contract.v1",
				artifactBudgets: {
					browserProductionWasmGzipBaselineBytes: 540_028,
					browserProductionWasmGzipMaxGrowthRatio: 1.05,
				},
				browserBudgets: {
					baseline: {
						coldStartupMs: 1_000,
						jsHeapBytes: 10_000,
						wasmLinearMemoryBytes: 20_000,
					},
					coldStartupMaxGrowthRatio: 1.1,
					jsHeapMaxGrowthRatio: 1.05,
					wasmLinearMemoryMaxGrowthRatio: 1.05,
				},
			},
			currentArtifactGzipBytes: 600_000,
			report: {
				coldStartupMs: 1_500,
				interactions: [],
				jsHeapBytes: createUnavailableMetric("missing"),
				wasmLinearMemoryBytes: { status: "available", value: 30_000 },
			},
		});

		expect(evaluation.summary.artifactAndRegressionBudgetsPassed).toBe(false);
		expect(evaluation.artifact.passed).toBe(false);
		expect(evaluation.jsHeap.passed).toBe(false);
		expect(evaluation.jsHeap.reason).toBe("missing current metric");
	});
});

describe("validateFullReportContract", () => {
	it("fails when manifest entries are absent from the full report", () => {
		const validation = validateFullReportContract({
			suites: [
				{
					suite: "crud",
					comparisons: [makeComparison()],
				},
			],
			includeStress: false,
		});

		expect(validation.passed).toBe(false);
		expect(
			validation.failures.some(
				(failure) => failure.caseName === "findById @ 10K",
			),
		).toBe(true);
		expect(
			validation.failures.some(
				(failure) => failure.caseName === "findById @ 100K",
			),
		).toBe(false);
	});
});

describe("checksumBenchmarkValue", () => {
	it("distinguishes missing keys, undefined, null, array holes, and sentinel-shaped objects", () => {
		const missing = checksumBenchmarkValue({});
		const explicitUndefined = checksumBenchmarkValue({ value: undefined });
		const explicitNull = checksumBenchmarkValue({ value: null });
		const arrayWithHole = checksumBenchmarkValue([, 1]);
		const arrayWithUndefined = checksumBenchmarkValue([undefined, 1]);
		const sentinelShape = checksumBenchmarkValue({
			__proseql: { kind: "undefined" },
		});

		expect(missing).not.toBe(explicitUndefined);
		expect(explicitUndefined).not.toBe(explicitNull);
		expect(arrayWithHole).not.toBe(arrayWithUndefined);
		expect(sentinelShape).not.toBe(explicitUndefined);
	});
});
