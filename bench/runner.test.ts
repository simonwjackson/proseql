import { describe, expect, it, vi } from "vitest";
import { discoverBenchmarks, filterBenchmarks, executeAllSuites } from "./runner.js";
import { formatResultsJson, formatResultsTable } from "./utils.js";

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

	it("produces valid JSON output with expected structure", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "transactions");

		expect(filtered.length).toBe(1);

		const results = await executeAllSuites(filtered, { verbose: false });

		// Build JSON output structure matching what runner.ts produces
		const output = {
			timestamp: new Date().toISOString(),
			suites: results.map((r) => formatResultsJson(r.suiteName, r.bench.tasks)),
		};

		// Verify it's valid JSON (can be serialized and parsed)
		const jsonString = JSON.stringify(output);
		expect(() => JSON.parse(jsonString)).not.toThrow();

		// Verify parsed output has expected top-level keys
		const parsed = JSON.parse(jsonString) as Record<string, unknown>;
		expect(parsed).toHaveProperty("timestamp");
		expect(parsed).toHaveProperty("suites");
		expect(typeof parsed.timestamp).toBe("string");
		expect(Array.isArray(parsed.suites)).toBe(true);

		// Verify timestamp is a valid ISO date string
		expect(new Date(parsed.timestamp as string).toISOString()).toBe(parsed.timestamp);

		// Verify suites array has expected structure
		const suites = parsed.suites as Array<Record<string, unknown>>;
		expect(suites.length).toBeGreaterThan(0);

		for (const suite of suites) {
			// Each suite should have required keys
			expect(suite).toHaveProperty("suite");
			expect(suite).toHaveProperty("results");
			expect(suite).toHaveProperty("timestamp");

			expect(typeof suite.suite).toBe("string");
			expect(Array.isArray(suite.results)).toBe(true);
			expect(typeof suite.timestamp).toBe("string");

			// Verify results array has expected benchmark result structure
			const suiteResults = suite.results as Array<Record<string, unknown>>;
			expect(suiteResults.length).toBeGreaterThan(0);

			for (const benchResult of suiteResults) {
				// Each benchmark result should have required keys
				expect(benchResult).toHaveProperty("name");
				expect(benchResult).toHaveProperty("opsPerSec");
				expect(benchResult).toHaveProperty("meanMs");
				expect(benchResult).toHaveProperty("samples");
				expect(benchResult).toHaveProperty("minMs");
				expect(benchResult).toHaveProperty("maxMs");

				// Verify types
				expect(typeof benchResult.name).toBe("string");
				expect(typeof benchResult.opsPerSec).toBe("number");
				expect(typeof benchResult.meanMs).toBe("number");
				expect(typeof benchResult.samples).toBe("number");
				expect(typeof benchResult.minMs).toBe("number");
				expect(typeof benchResult.maxMs).toBe("number");

				// Verify numeric values are positive
				expect(benchResult.opsPerSec).toBeGreaterThan(0);
				expect(benchResult.meanMs).toBeGreaterThan(0);
				expect(benchResult.samples).toBeGreaterThan(0);

				// Optional percentile fields can be number or undefined
				if (benchResult.p50Ms !== undefined) {
					expect(typeof benchResult.p50Ms).toBe("number");
				}
				if (benchResult.p75Ms !== undefined) {
					expect(typeof benchResult.p75Ms).toBe("number");
				}
				if (benchResult.p95Ms !== undefined) {
					expect(typeof benchResult.p95Ms).toBe("number");
				}
				if (benchResult.p99Ms !== undefined) {
					expect(typeof benchResult.p99Ms).toBe("number");
				}
			}
		}
	}, 60_000);

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

describe("Table Output", () => {
	it("renders table output without errors", async () => {
		const benchmarks = await discoverBenchmarks();
		// Use a small filtered suite for faster test execution
		const filtered = filterBenchmarks(benchmarks, "transactions");

		expect(filtered.length).toBe(1);

		const results = await executeAllSuites(filtered, { verbose: false });

		// Verify we have results to format
		expect(results.length).toBe(1);
		expect(results[0].bench.tasks.length).toBeGreaterThan(0);

		// formatResultsTable should not throw
		const tableOutput = formatResultsTable(results[0].bench.tasks);

		// Verify it returns a non-empty string
		expect(typeof tableOutput).toBe("string");
		expect(tableOutput.length).toBeGreaterThan(0);

		// Verify table has the expected structure (header line, separator, data rows)
		const lines = tableOutput.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3); // header + separator + at least one data row

		// Verify header contains expected column names
		const headerLine = lines[0];
		expect(headerLine).toContain("Name");
		expect(headerLine).toContain("ops/sec");
		expect(headerLine).toContain("mean");
		expect(headerLine).toContain("p50");
		expect(headerLine).toContain("p95");
		expect(headerLine).toContain("p99");

		// Verify separator line contains dashes
		const separatorLine = lines[1];
		expect(separatorLine).toMatch(/^[-\s]+$/);

		// Verify data rows exist and contain benchmark names
		const dataRows = lines.slice(2);
		expect(dataRows.length).toBeGreaterThan(0);

		// Each data row should have some content (not just whitespace)
		for (const row of dataRows) {
			expect(row.trim().length).toBeGreaterThan(0);
		}
	}, 60_000);

	it("renders empty results message when no tasks available", () => {
		// Test with empty task array
		const tableOutput = formatResultsTable([]);

		expect(typeof tableOutput).toBe("string");
		expect(tableOutput).toBe("No benchmark results available.");
	});

	it("formats numbers correctly in table output", async () => {
		const benchmarks = await discoverBenchmarks();
		const filtered = filterBenchmarks(benchmarks, "transactions");

		const results = await executeAllSuites(filtered, { verbose: false });
		const tableOutput = formatResultsTable(results[0].bench.tasks);

		// Table should contain formatted numbers (K/M suffixes or decimal values)
		// The output should match patterns like "1.23K", "1.23M", "1.23ms", "0.123ms", "1.23s", or "-"
		const lines = tableOutput.split("\n");
		const dataRows = lines.slice(2);

		for (const row of dataRows) {
			// Split row into columns (they're separated by 2 spaces)
			const columns = row.split(/\s{2,}/);

			// Skip the name column (index 0), check numeric columns
			for (let i = 1; i < columns.length; i++) {
				const value = columns[i].trim();
				// Should match: number with K/M suffix, ms/s suffix, or "-" for undefined
				expect(value).toMatch(/^(\d+\.?\d*(K|M|ms|s)?|-)$/);
			}
		}
	}, 60_000);
});
