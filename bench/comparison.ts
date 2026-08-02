import type { Task, TaskResult } from "tinybench";
import type { FormattedBenchmarkResult } from "./utils.js";

export type EngineId = "typescript" | "wasm";
export type BenchmarkCategory = "read-query" | "write-transaction";
export type BenchmarkCaseType = "required" | "stress" | "characterization";

export interface UnavailableMetric {
	readonly status: "unavailable";
	readonly reason: string;
}

export interface AvailableMetric {
	readonly status: "available";
	readonly value: number;
}

export type NumericMetric = AvailableMetric | UnavailableMetric;

export interface BenchmarkBoundaryStageMetrics {
	readonly encodeMs: NumericMetric;
	readonly transferMs: NumericMetric;
	readonly engineMs: NumericMetric;
	readonly decodeMs: NumericMetric;
	readonly callbackMs: NumericMetric;
}

export interface ProjectionMaterializationInstrumentation {
	readonly descriptors: number;
	readonly descriptorBytes: number;
	readonly cacheHits: number;
	readonly cacheMisses: number;
	readonly resynchronizations: number;
	readonly fullValueBytesAvoided: number;
	readonly materializationMilliseconds: number;
	readonly materializedRows: number;
	readonly trackedProxies: number;
	readonly peakMaterializedRows: number;
	readonly peakTrackedProxies: number;
}

export interface BenchmarkInstrumentation {
	readonly initializationMs: NumericMetric;
	readonly coldStartMs: NumericMetric;
	readonly encodedCommandBytes: NumericMetric;
	readonly encodedResultBytes: NumericMetric;
	readonly compressedArtifactBytes: NumericMetric;
	readonly callbackCount: NumericMetric;
	readonly jsHeapBytes: NumericMetric;
	readonly wasmLinearMemoryHighWaterBytes: NumericMetric;
	readonly repeatedHighWaterGrowthBytes: NumericMetric;
	readonly projectionMaterialization?: ProjectionMaterializationInstrumentation;
	readonly boundary: BenchmarkBoundaryStageMetrics;
}

export interface BenchTaskMetadata {
	readonly benchmarkName: string;
	readonly engineId: EngineId;
	readonly category: BenchmarkCategory;
	readonly caseType: BenchmarkCaseType;
	readonly datasetSize?: number;
	readonly operationCount: number;
	readonly normalInteraction: boolean;
	readonly checksum?: string;
	readonly checksumProbe?: () => Promise<string>;
	readonly instrumentation?: BenchmarkInstrumentation;
}

export interface EngineBenchmarkResult extends FormattedBenchmarkResult {
	readonly engineId: EngineId;
	readonly checksum?: string;
	readonly instrumentation: BenchmarkInstrumentation;
}

export interface PairedComparison {
	readonly name: string;
	readonly category: BenchmarkCategory;
	readonly caseType: BenchmarkCaseType;
	readonly datasetSize?: number;
	readonly operationCount: number;
	readonly normalInteraction: boolean;
	readonly throughputRatio: number | undefined;
	readonly latencyRatio: number | undefined;
	readonly checksum: string | undefined;
	readonly checksumMatch: boolean;
	readonly engines: {
		readonly typescript: EngineBenchmarkResult | undefined;
		readonly wasm: EngineBenchmarkResult | undefined;
	};
}

const taskMetadata = new WeakMap<Task, BenchTaskMetadata>();

export const createUnavailableMetric = (reason: string): UnavailableMetric => ({
	status: "unavailable",
	reason,
});

export const createAvailableMetric = (value: number): AvailableMetric => ({
	status: "available",
	value,
});

export const createUnavailableInstrumentation = (
	reason = "not instrumented by this runtime",
): BenchmarkInstrumentation => ({
	initializationMs: createUnavailableMetric(reason),
	coldStartMs: createUnavailableMetric(reason),
	encodedCommandBytes: createUnavailableMetric(reason),
	encodedResultBytes: createUnavailableMetric(reason),
	compressedArtifactBytes: createUnavailableMetric(reason),
	callbackCount: createUnavailableMetric(reason),
	jsHeapBytes: createUnavailableMetric(reason),
	wasmLinearMemoryHighWaterBytes: createUnavailableMetric(reason),
	repeatedHighWaterGrowthBytes: createUnavailableMetric(reason),
	boundary: {
		encodeMs: createUnavailableMetric(reason),
		transferMs: createUnavailableMetric(reason),
		engineMs: createUnavailableMetric(reason),
		decodeMs: createUnavailableMetric(reason),
		callbackMs: createUnavailableMetric(reason),
	},
});

export const createEngineTaskName = (
	engineId: EngineId,
	benchmarkName: string,
): string => `[${engineId}] ${benchmarkName}`;

export const attachTaskMetadata = (
	task: Task,
	metadata: BenchTaskMetadata,
): void => {
	taskMetadata.set(task, metadata);
};

export const getTaskMetadata = (task: Task): BenchTaskMetadata | undefined =>
	taskMetadata.get(task);

export const updateTaskMetadata = (
	task: Task,
	update: (metadata: BenchTaskMetadata) => BenchTaskMetadata,
): void => {
	const current = taskMetadata.get(task);
	if (!current) {
		throw new Error(`Missing benchmark metadata for task ${task.name}`);
	}
	taskMetadata.set(task, update(current));
};

export const parseEngineTaskName = (
	taskName: string,
):
	| { readonly engineId: EngineId; readonly benchmarkName: string }
	| undefined => {
	const match = /^\[(typescript|wasm)\]\s+(.+)$/.exec(taskName);
	if (!match) {
		return undefined;
	}
	return {
		engineId: match[1] as EngineId,
		benchmarkName: match[2],
	};
};

export const exactPercentile = (
	samples: ReadonlyArray<number>,
	percentile: number,
): number | undefined => {
	if (samples.length === 0) {
		return undefined;
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
	return sorted[Math.min(sorted.length - 1, rank - 1)];
};

export const formatTaskResultWithMetadata = (
	task: Task,
): EngineBenchmarkResult | null => {
	const result = task.result;
	const metadata = getTaskMetadata(task);
	const parsed = metadata ?? parseEngineTaskName(task.name);
	if (!result || !parsed) {
		return null;
	}
	const samples = getLatencySamples(result);
	return {
		name: metadata?.benchmarkName ?? parsed.benchmarkName,
		engineId: metadata?.engineId ?? parsed.engineId,
		opsPerSec: result.throughput.mean,
		meanMs: result.latency.mean,
		p50Ms: exactPercentile(samples, 50),
		p75Ms: exactPercentile(samples, 75),
		p95Ms: exactPercentile(samples, 95),
		p99Ms: exactPercentile(samples, 99),
		minMs: result.latency.min,
		maxMs: result.latency.max,
		samples: samples.length,
		checksum: metadata?.checksum,
		instrumentation:
			metadata?.instrumentation ??
			createUnavailableInstrumentation("not reported by this workload"),
	};
};

export const buildComparisons = (
	tasks: ReadonlyArray<Task>,
): ReadonlyArray<PairedComparison> => {
	const byBenchmark = new Map<
		string,
		{
			readonly metadata: BenchTaskMetadata | undefined;
			typescript?: EngineBenchmarkResult;
			wasm?: EngineBenchmarkResult;
		}
	>();

	for (const task of tasks) {
		const result = formatTaskResultWithMetadata(task);
		if (!result) {
			continue;
		}
		const metadata = getTaskMetadata(task);
		const current = byBenchmark.get(result.name) ?? { metadata };
		if (current.metadata && metadata) {
			const metadataMatches =
				current.metadata.category === metadata.category &&
				current.metadata.caseType === metadata.caseType &&
				current.metadata.datasetSize === metadata.datasetSize &&
				current.metadata.operationCount === metadata.operationCount &&
				current.metadata.normalInteraction === metadata.normalInteraction;
			if (!metadataMatches) {
				throw new Error(
					`Mismatched benchmark metadata for ${result.name} between paired engine tasks`,
				);
			}
		}
		if (result.engineId === "typescript") {
			if (current.typescript) {
				throw new Error(
					`Duplicate benchmark task for typescript ${result.name}`,
				);
			}
			current.typescript = result;
		} else {
			if (current.wasm) {
				throw new Error(`Duplicate benchmark task for wasm ${result.name}`);
			}
			current.wasm = result;
		}
		byBenchmark.set(result.name, current);
	}

	return [...byBenchmark.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, entry]) => {
			const metadata = entry.metadata;
			const checksum = entry.typescript?.checksum ?? entry.wasm?.checksum;
			const checksumMatch =
				entry.typescript?.checksum !== undefined &&
				entry.wasm?.checksum !== undefined &&
				entry.typescript.checksum === entry.wasm.checksum;
			return {
				name,
				category: metadata?.category ?? "read-query",
				caseType: metadata?.caseType ?? "required",
				datasetSize: metadata?.datasetSize,
				operationCount: metadata?.operationCount ?? 0,
				normalInteraction: metadata?.normalInteraction ?? false,
				throughputRatio:
					entry.typescript && entry.wasm
						? entry.wasm.opsPerSec / entry.typescript.opsPerSec
						: undefined,
				latencyRatio:
					entry.typescript && entry.wasm
						? entry.wasm.meanMs / entry.typescript.meanMs
						: undefined,
				checksum,
				checksumMatch,
				engines: {
					typescript: entry.typescript,
					wasm: entry.wasm,
				},
			} satisfies PairedComparison;
		});
};

export const checksumBenchmarkValue = (value: unknown): string =>
	fnv1a64(stableSerialize(value));

const stableSerialize = (value: unknown): string => {
	if (value === undefined) {
		return "undefined";
	}
	if (value === null) {
		return "null";
	}
	if (typeof value === "number") {
		if (Number.isNaN(value)) {
			return "number:NaN";
		}
		if (Object.is(value, -0)) {
			return "number:-0";
		}
		if (!Number.isFinite(value)) {
			return `number:${value > 0 ? "Infinity" : "-Infinity"}`;
		}
		return `number:${value}`;
	}
	if (typeof value === "string") {
		return `string:${JSON.stringify(value)}`;
	}
	if (typeof value === "boolean") {
		return `boolean:${value}`;
	}
	if (typeof value === "bigint") {
		return `bigint:${value}`;
	}
	if (Array.isArray(value)) {
		return `array:[${Array.from({ length: value.length }, (_, index) =>
			index in value
				? `${index}:${stableSerialize(value[index])}`
				: `${index}:<hole>`,
		).join(",")}]`;
	}
	if (value instanceof Date) {
		return `date:${value.toISOString()}`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `object:{${Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
			.join(",")}}`;
	}
	if (typeof value === "symbol") {
		return `symbol:${String(value)}`;
	}
	return `${typeof value}:${String(value)}`;
};

const fnv1a64 = (input: string): string => {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let index = 0; index < input.length; index++) {
		hash ^= BigInt(input.charCodeAt(index));
		hash = (hash * prime) & 0xffffffffffffffffn;
	}
	return `checksum:${hash.toString(16).padStart(16, "0")}`;
};

const getLatencySamples = (result: TaskResult): ReadonlyArray<number> =>
	result.latency.samples as ReadonlyArray<number>;
