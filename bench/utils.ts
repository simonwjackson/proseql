/**
 * Shared benchmark utilities for ProseQL.
 *
 * Provides database factory wrapper, result formatting, and percentile extraction.
 */

import type { EffectDatabase } from "@proseql/core";
import type { BenchOptions, Task, TaskResult } from "tinybench";
import {
	createAvailableMetric,
	createUnavailableInstrumentation,
	createUnavailableMetric,
	exactPercentile,
	type BenchmarkInstrumentation,
} from "./comparison.js";
import { type BenchSchemaConfig, typescriptBenchEngine } from "./engines.js";

export type { BenchSchemaConfig } from "./engines.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Benchmark result row for table output.
 */
export interface BenchmarkResultRow {
	readonly name: string;
	readonly opsPerSec: number;
	readonly meanMs: number;
	readonly p50Ms: number | undefined;
	readonly p95Ms: number | undefined;
	readonly p99Ms: number | undefined;
}

/**
 * Formatted benchmark result for JSON output.
 */
export interface FormattedBenchmarkResult {
	readonly name: string;
	readonly opsPerSec: number;
	readonly meanMs: number;
	readonly p50Ms: number | undefined;
	readonly p75Ms: number | undefined;
	readonly p95Ms: number | undefined;
	readonly p99Ms: number | undefined;
	readonly minMs: number;
	readonly maxMs: number;
	readonly samples: number;
}

// ============================================================================
// Database Factory Wrapper
// ============================================================================

/**
 * Create an in-memory ProseQL database for benchmarking.
 *
 * This is a simplified wrapper around `createEffectDatabase` that:
 * - Converts a simplified schema config to the full DatabaseConfig format
 * - Accepts initial data keyed by collection name
 * - Runs the Effect and returns a Promise for the database
 *
 * @param schemaConfig - Simplified schema configuration mapping collection names to schemas
 * @param initialData - Optional initial data for each collection
 * @returns Promise resolving to the Effect-based database instance
 *
 * @example
 * ```ts
 * const UserSchema = Schema.Struct({
 *   id: Schema.String,
 *   name: Schema.String,
 *   age: Schema.Number,
 * });
 *
 * const db = await createBenchDatabase(
 *   { users: { schema: UserSchema } },
 *   { users: [{ id: "1", name: "Alice", age: 30 }] }
 * );
 * ```
 */
export async function createBenchDatabase<T extends BenchSchemaConfig>(
	schemaConfig: T,
	initialData?: {
		readonly [K in keyof T]?: ReadonlyArray<Record<string, unknown>>;
	},
): Promise<EffectDatabase<ConvertToDbConfig<T>>> {
	const handle = await typescriptBenchEngine.createDatabase(
		schemaConfig,
		initialData,
	);
	return handle.db as EffectDatabase<ConvertToDbConfig<T>>;
}

/**
 * Type helper to convert BenchSchemaConfig to DatabaseConfig.
 * @internal
 */
type ConvertToDbConfig<T extends BenchSchemaConfig> = {
	readonly [K in keyof T]: {
		readonly schema: T[K]["schema"];
		readonly indexes: T[K]["indexes"];
		readonly relationships: T[K]["relationships"] extends undefined
			? Record<string, never>
			: NonNullable<T[K]["relationships"]>;
	};
};

// ============================================================================
// Percentile Extraction
// ============================================================================

/**
 * Extract percentile values from tinybench task results.
 *
 * tinybench provides p50, p75, p99, p995, p999 in the latency statistics.
 * This function extracts and converts them to a consistent format.
 *
 * @param result - The tinybench TaskResult object
 * @returns Object containing percentile values in milliseconds
 */
export function extractPercentiles(result: TaskResult): {
	readonly p50: number | undefined;
	readonly p75: number | undefined;
	readonly p95: number | undefined;
	readonly p99: number | undefined;
} {
	const samples = result.latency.samples as ReadonlyArray<number>;
	return {
		p50: exactPercentile(samples, 50),
		p75: exactPercentile(samples, 75),
		p95: exactPercentile(samples, 95),
		p99: exactPercentile(samples, 99),
	};
}

/**
 * Convert a tinybench Task to a formatted benchmark result.
 *
 * @param task - The tinybench Task object
 * @returns Formatted benchmark result or null if no result available
 */
export function formatTaskResult(task: Task): FormattedBenchmarkResult | null {
	const result = task.result;
	if (!result) {
		return null;
	}

	const percentiles = extractPercentiles(result);

	return {
		name: task.name,
		opsPerSec: result.throughput.mean,
		meanMs: result.latency.mean,
		p50Ms: percentiles.p50,
		p75Ms: percentiles.p75,
		p95Ms: percentiles.p95,
		p99Ms: percentiles.p99,
		minMs: result.latency.min,
		maxMs: result.latency.max,
		samples: result.latency.samples.length,
	};
}

// ============================================================================
// Table Formatting
// ============================================================================

/**
 * Format benchmark results as an aligned terminal table.
 *
 * Columns: Name | ops/sec | mean | p50 | p95 | p99
 *
 * @param tasks - Array of tinybench Task objects
 * @returns Formatted table string for terminal output
 */
export function formatResultsTable(tasks: ReadonlyArray<Task>): string {
	const rows: BenchmarkResultRow[] = [];

	for (const task of tasks) {
		const result = task.result;
		if (!result) continue;

		const percentiles = extractPercentiles(result);
		rows.push({
			name: task.name,
			opsPerSec: result.throughput.mean,
			meanMs: result.latency.mean,
			p50Ms: percentiles.p50,
			p95Ms: percentiles.p95,
			p99Ms: percentiles.p99,
		});
	}

	if (rows.length === 0) {
		return "No benchmark results available.";
	}

	// Calculate column widths
	const headers = ["Name", "ops/sec", "mean", "p50", "p95", "p99"];
	const colWidths = headers.map((h) => h.length);

	// Format numbers for width calculation
	const formattedRows = rows.map((row) => [
		row.name,
		formatOpsPerSec(row.opsPerSec),
		formatMs(row.meanMs),
		formatMs(row.p50Ms),
		formatMs(row.p95Ms),
		formatMs(row.p99Ms),
	]);

	// Update column widths based on data
	for (const row of formattedRows) {
		for (let i = 0; i < row.length; i++) {
			colWidths[i] = Math.max(colWidths[i], row[i].length);
		}
	}

	// Build table
	const lines: string[] = [];

	// Header
	const headerLine = headers
		.map((h, i) =>
			i === 0 ? h.padEnd(colWidths[i]) : h.padStart(colWidths[i]),
		)
		.join("  ");
	lines.push(headerLine);

	// Separator
	const separator = colWidths.map((w) => "-".repeat(w)).join("  ");
	lines.push(separator);

	// Data rows
	for (const row of formattedRows) {
		const line = row
			.map((cell, i) =>
				i === 0 ? cell.padEnd(colWidths[i]) : cell.padStart(colWidths[i]),
			)
			.join("  ");
		lines.push(line);
	}

	return lines.join("\n");
}

/**
 * Format ops/sec with appropriate precision.
 * - >= 1M: show as "1.23M"
 * - >= 1K: show as "1.23K"
 * - Otherwise: show with 2 decimal places
 */
function formatOpsPerSec(ops: number): string {
	if (ops >= 1_000_000) {
		return `${(ops / 1_000_000).toFixed(2)}M`;
	}
	if (ops >= 1_000) {
		return `${(ops / 1_000).toFixed(2)}K`;
	}
	return ops.toFixed(2);
}

/**
 * Format milliseconds with appropriate precision.
 * - >= 1000ms: show as "1.23s"
 * - >= 1ms: show as "1.23ms"
 * - Otherwise: show as "0.123ms" (3 decimal places)
 */
function formatMs(ms: number | undefined): string {
	if (ms === undefined) {
		return "-";
	}
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(2)}s`;
	}
	if (ms >= 1) {
		return `${ms.toFixed(2)}ms`;
	}
	return `${ms.toFixed(3)}ms`;
}

// ============================================================================
// JSON Output
// ============================================================================

/**
 * Convert benchmark tasks to a structured JSON-serializable object.
 *
 * @param suiteName - Name of the benchmark suite
 * @param tasks - Array of tinybench Task objects
 * @returns Object suitable for JSON serialization
 */
export function formatResultsJson(
	suiteName: string,
	tasks: ReadonlyArray<Task>,
): {
	readonly suite: string;
	readonly results: ReadonlyArray<FormattedBenchmarkResult>;
	readonly timestamp: string;
} {
	const results: FormattedBenchmarkResult[] = [];

	for (const task of tasks) {
		const formatted = formatTaskResult(task);
		if (formatted) {
			results.push(formatted);
		}
	}

	return {
		suite: suiteName,
		results,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// Suite Helpers
// ============================================================================

/**
 * Default benchmark options for consistent timing across suites.
 */
export const defaultBenchOptions = {
	// Fixed iteration floors keep untimed reset/verification hooks bounded. CI
	// reduces noise with interleaved trials rather than unbounded per-task loops.
	time: 0,
	iterations: 30,
	warmup: true,
	warmupIterations: 5,
	warmupTime: 0,
} as const satisfies BenchOptions;

export const buildBenchOptions = (
	overrides: Partial<BenchOptions> | undefined,
): BenchOptions => ({
	...defaultBenchOptions,
	...overrides,
});

export const closeAll = async (
	closers: ReadonlyArray<() => Promise<void>>,
): Promise<void> => {
	for (const close of [...closers].reverse()) {
		await close();
	}
};

const textEncoder = new TextEncoder();

export const jsonByteMetric = (value: unknown) => {
	try {
		const json = JSON.stringify(value);
		if (json === undefined) {
			return createUnavailableMetric("value is not JSON-serializable");
		}
		return createAvailableMetric(textEncoder.encode(json).byteLength);
	} catch (error) {
		return createUnavailableMetric(
			error instanceof Error ? error.message : "unable to serialize metric",
		);
	}
};

export const createTaskInstrumentation = (options: {
	readonly initializationMs: number;
	readonly commandPayload?: unknown;
	readonly resultPayload?: unknown;
}): BenchmarkInstrumentation => ({
	...createUnavailableInstrumentation("not reported by this workload"),
	initializationMs: createAvailableMetric(options.initializationMs),
	encodedCommandBytes:
		options.commandPayload === undefined
			? createUnavailableMetric("command payload not reported")
			: jsonByteMetric(options.commandPayload),
	encodedResultBytes:
		options.resultPayload === undefined
			? createUnavailableMetric("result payload not reported")
			: jsonByteMetric(options.resultPayload),
});

export const measureAsync = async <T>(
	operation: () => Promise<T>,
): Promise<{ readonly value: T; readonly durationMs: number }> => {
	const startedAt = performance.now();
	const value = await operation();
	return {
		value,
		durationMs: performance.now() - startedAt,
	};
};

export const withFrozenDate = async <T>(
	isoTimestamp: string,
	operation: () => Promise<T>,
): Promise<T> => {
	const RealDate = Date;
	const fixedMs = new RealDate(isoTimestamp).getTime();
	const FrozenDate = function (
		this: Date,
		...args: ReadonlyArray<unknown>
	): Date | string {
		if (new.target === undefined) {
			return new RealDate(fixedMs).toString();
		}
		const constructorArgs = args.length === 0 ? [fixedMs] : args;
		return Reflect.construct(RealDate, constructorArgs, new.target) as Date;
	} as unknown as DateConstructor;

	Object.defineProperties(FrozenDate, {
		now: {
			value: () => fixedMs,
		},
		parse: {
			value: RealDate.parse,
		},
		UTC: {
			value: RealDate.UTC,
		},
		prototype: {
			value: RealDate.prototype,
		},
	});
	Object.setPrototypeOf(FrozenDate, RealDate);

	globalThis.Date = FrozenDate;
	try {
		return await operation();
	} finally {
		globalThis.Date = RealDate;
	}
};
