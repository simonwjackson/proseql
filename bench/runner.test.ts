import { describe, expect, it, vi } from "vitest";
import { discoverBenchmarks, filterBenchmarks, executeAllSuites } from "./runner.js";

/**
 * Tests for the benchmark runner.
 *
 * Verifies that the runner:
 * - Discovers all .bench.ts files in the bench/ directory
 * - Can filter benchmarks by suite name
 * - Executes discovered benchmarks correctly
 */

// The expected benchmark files in the bench/ directory
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

describe("Benchmark Discovery", () => {
	it("discovers all .bench.ts files in the bench/ directory", async () => {
		const benchmarks = await discoverBenchmarks();

		// Should find all expected benchmark files
		expect(benchmarks.length).toBe(EXPECTED_BENCHMARK_FILES.length);

		// Extract file names from paths
		const discoveredFiles = benchmarks.map((b) => {
			const pathParts = b.path.split("/");
			return pathParts[pathParts.length - 1];
		});

		// All expected files should be discovered
		for (const expectedFile of EXPECTED_BENCHMARK_FILES) {
			expect(discoveredFiles).toContain(expectedFile);
		}
	});

	it("discovers files sorted alphabetically for consistent ordering", async () => {
		const benchmarks = await discoverBenchmarks();

		const discoveredFiles = benchmarks.map((b) => {
			const pathParts = b.path.split("/");
			return pathParts[pathParts.length - 1];
		});

		// Files should be sorted alphabetically
		const sortedFiles = [...discoveredFiles].sort();
		expect(discoveredFiles).toEqual(sortedFiles);
	});

	it("loads valid benchmark modules with required exports", async () => {
		const benchmarks = await discoverBenchmarks();

		for (const benchmark of benchmarks) {
			// Each module should have suiteName as a string
			expect(typeof benchmark.module.suiteName).toBe("string");
			expect(benchmark.module.suiteName.length).toBeGreaterThan(0);

			// Each module should have createSuite as a function
			expect(typeof benchmark.module.createSuite).toBe("function");
		}
	});

	it("loads all expected suite names", async () => {
		const benchmarks = await discoverBenchmarks();

		const suiteNames = benchmarks.map((b) => b.module.suiteName);

		// All expected suite names should be present
		for (const expectedName of EXPECTED_SUITE_NAMES) {
			expect(suiteNames).toContain(expectedName);
		}
	});
});

describe("Benchmark Filtering", () => {
	it("filters benchmarks by suite name (exact match)", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "crud");

		expect(filtered.length).toBe(1);
		expect(filtered[0].module.suiteName).toBe("crud");
	});

	it("filters benchmarks by partial name (case-insensitive)", async () => {
		const benchmarks = await discoverBenchmarks();

		// Partial match
		const filtered = filterBenchmarks(benchmarks, "serial");
		expect(filtered.length).toBe(1);
		expect(filtered[0].module.suiteName).toBe("serialization");

		// Case-insensitive
		const filteredUpper = filterBenchmarks(benchmarks, "CRUD");
		expect(filteredUpper.length).toBe(1);
		expect(filteredUpper[0].module.suiteName).toBe("crud");
	});

	it("returns empty array for non-matching filter", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "nonexistent-suite-name");

		expect(filtered.length).toBe(0);
	});

	it("returns all benchmarks with empty filter", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "");

		// Empty string should match all (since every string includes empty string)
		expect(filtered.length).toBe(benchmarks.length);
	});
});

describe("Benchmark Execution", () => {
	it("executes all discovered benchmarks and returns results", async () => {
		const benchmarks = await discoverBenchmarks();

		// Execute with verbose off to avoid console spam in tests
		const results = await executeAllSuites(benchmarks, { verbose: false });

		// Should have results for all suites
		expect(results.length).toBe(benchmarks.length);

		// Each result should have required fields
		for (const result of results) {
			expect(typeof result.suiteName).toBe("string");
			expect(result.suiteName.length).toBeGreaterThan(0);

			// Should have a bench instance with tasks
			expect(result.bench).toBeDefined();
			expect(result.bench.tasks).toBeDefined();
			expect(Array.isArray(result.bench.tasks)).toBe(true);
			expect(result.bench.tasks.length).toBeGreaterThan(0);

			// Should have timing information
			expect(typeof result.durationMs).toBe("number");
			expect(result.durationMs).toBeGreaterThan(0);
		}
	}, 120_000); // Long timeout for running all benchmarks

	it("executes a single filtered suite", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "transactions");

		expect(filtered.length).toBe(1);

		const results = await executeAllSuites(filtered, { verbose: false });

		expect(results.length).toBe(1);
		expect(results[0].suiteName).toBe("transactions");
		expect(results[0].bench.tasks.length).toBeGreaterThan(0);
	}, 60_000);

	it("returns results in the same order as input benchmarks", async () => {
		const benchmarks = await discoverBenchmarks();
		const results = await executeAllSuites(benchmarks, { verbose: false });

		// Results should be in the same order as input
		for (let i = 0; i < benchmarks.length; i++) {
			expect(results[i].suiteName).toBe(benchmarks[i].module.suiteName);
		}
	}, 120_000);
});
