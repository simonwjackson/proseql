/**
 * Benchmark Runner and Reporter
 *
 * Discovers and executes all `.bench.ts` files in the bench/ directory.
 * Outputs results as formatted tables (default) or JSON (--json flag).
 *
 * Usage:
 *   bun run bench              # Run all benchmarks, table output
 *   bun run bench --json       # Run all benchmarks, JSON output
 *   bun run bench scaling      # Run only the scaling benchmark suite
 */

import { Glob } from "bun";
import type { Bench } from "tinybench";
import { formatResultsTable, formatResultsJson, type FormattedBenchmarkResult } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Shape of a benchmark module's exports.
 * Each .bench.ts file must export these.
 */
interface BenchmarkModule {
	readonly suiteName: string;
	readonly createSuite: () => Promise<Bench>;
	readonly run?: () => Promise<void>;
}

/**
 * Discovered benchmark file with its module exports.
 */
interface DiscoveredBenchmark {
	readonly path: string;
	readonly module: BenchmarkModule;
}

/**
 * Complete JSON output structure for all benchmark suites.
 */
interface BenchmarkJsonOutput {
	readonly timestamp: string;
	readonly suites: ReadonlyArray<{
		readonly suite: string;
		readonly results: ReadonlyArray<FormattedBenchmarkResult>;
		readonly timestamp: string;
	}>;
}

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Discover all .bench.ts files in the bench/ directory.
 *
 * Uses Bun's Glob to find all matching files, excluding:
 * - The runner itself (runner.ts)
 * - Test files (*.test.ts)
 * - Utility files (utils.ts, generators.ts)
 *
 * @returns Array of absolute paths to benchmark files
 */
async function discoverBenchFiles(): Promise<ReadonlyArray<string>> {
	const benchDir = import.meta.dir;
	const glob = new Glob("*.bench.ts");

	const files: string[] = [];
	for await (const file of glob.scan({ cwd: benchDir, absolute: true })) {
		files.push(file);
	}

	// Sort for consistent ordering
	files.sort();

	return files;
}

/**
 * Import a benchmark module from a file path.
 *
 * Validates that the module has the required exports:
 * - suiteName: string
 * - createSuite: () => Promise<Bench>
 *
 * @param filePath - Absolute path to the .bench.ts file
 * @returns The imported and validated module
 * @throws Error if the module doesn't have required exports
 */
async function importBenchModule(filePath: string): Promise<BenchmarkModule> {
	const module = await import(filePath) as Record<string, unknown>;

	if (typeof module.suiteName !== "string") {
		throw new Error(`Benchmark module ${filePath} must export 'suiteName: string'`);
	}

	if (typeof module.createSuite !== "function") {
		throw new Error(`Benchmark module ${filePath} must export 'createSuite: () => Promise<Bench>'`);
	}

	return {
		suiteName: module.suiteName,
		createSuite: module.createSuite as () => Promise<Bench>,
		run: typeof module.run === "function" ? module.run as () => Promise<void> : undefined,
	};
}

/**
 * Discover and import all benchmark modules.
 *
 * @returns Array of discovered benchmarks with their modules
 */
export async function discoverBenchmarks(): Promise<ReadonlyArray<DiscoveredBenchmark>> {
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

/**
 * Filter benchmarks by suite name pattern.
 *
 * @param benchmarks - All discovered benchmarks
 * @param filter - Suite name filter (case-insensitive partial match)
 * @returns Filtered benchmarks matching the pattern
 */
export function filterBenchmarks(
	benchmarks: ReadonlyArray<DiscoveredBenchmark>,
	filter: string,
): ReadonlyArray<DiscoveredBenchmark> {
	const lowerFilter = filter.toLowerCase();
	return benchmarks.filter((b) =>
		b.module.suiteName.toLowerCase().includes(lowerFilter),
	);
}

// ============================================================================
// Suite Execution (Task 8.2)
// ============================================================================

// Placeholder for task 8.2: Sequential suite execution with warm-up

// ============================================================================
// Table Output (Task 8.3)
// ============================================================================

// Placeholder for task 8.3: Table output formatting

// ============================================================================
// JSON Output (Task 8.4)
// ============================================================================

// Placeholder for task 8.4: JSON output with --json flag

// ============================================================================
// Suite Filtering (Task 8.5)
// ============================================================================

// Placeholder for task 8.5: Suite filtering via command line argument

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Parse command line arguments.
 *
 * @returns Parsed CLI options
 */
function parseArgs(): {
	readonly json: boolean;
	readonly filter: string | null;
} {
	const args = process.argv.slice(2);
	const json = args.includes("--json");

	// Find filter argument (first non-flag argument)
	const filter = args.find((arg) => !arg.startsWith("--")) ?? null;

	return { json, filter };
}

/**
 * Main runner function.
 * Discovers benchmarks, executes them, and outputs results.
 */
async function main(): Promise<void> {
	const { json, filter } = parseArgs();

	// Discover all benchmarks
	let benchmarks = await discoverBenchmarks();

	if (benchmarks.length === 0) {
		console.error("No benchmark files found in bench/ directory");
		process.exit(1);
	}

	// Apply filter if provided
	if (filter) {
		benchmarks = filterBenchmarks(benchmarks, filter);
		if (benchmarks.length === 0) {
			console.error(`No benchmarks match filter: ${filter}`);
			console.error("Available suites:");
			const all = await discoverBenchmarks();
			for (const b of all) {
				console.error(`  - ${b.module.suiteName}`);
			}
			process.exit(1);
		}
	}

	// For now, just list discovered benchmarks
	// Full execution will be implemented in task 8.2
	if (!json) {
		console.log(`Discovered ${benchmarks.length} benchmark suite(s):\n`);
		for (const b of benchmarks) {
			console.log(`  - ${b.module.suiteName}`);
		}
		console.log("\nNote: Full execution will be implemented in task 8.2");
	} else {
		// Placeholder JSON output
		const output: BenchmarkJsonOutput = {
			timestamp: new Date().toISOString(),
			suites: benchmarks.map((b) => ({
				suite: b.module.suiteName,
				results: [],
				timestamp: new Date().toISOString(),
			})),
		};
		console.log(JSON.stringify(output, null, 2));
	}
}

// Run when executed directly
if (import.meta.main) {
	main().catch((error) => {
		console.error("Benchmark runner failed:", error);
		process.exit(1);
	});
}
