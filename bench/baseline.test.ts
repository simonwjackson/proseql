import { describe, expect, it } from "vitest";
import {
	assertBaselineReportIsCapturable,
	describeBenchmarkRunnerFailure,
	isBaselineBlockingFailure,
} from "./baseline.js";
import type { BenchmarkJsonOutput } from "./runner.js";

const makeReport = (failureMessage?: string): BenchmarkJsonOutput => ({
	timestamp: "2026-01-01T00:00:00.000Z",
	suites: [],
	contract: {
		passed: failureMessage === undefined,
		failures:
			failureMessage === undefined
				? []
				: [
						{
							suite: "crud",
							caseName: "create (single)",
							message: failureMessage,
						},
					],
	},
	executionFailures: [],
});

describe("isBaselineBlockingFailure", () => {
	it.each([
		"execution failure: synthetic crash",
		"create (single) is missing from the full benchmark report",
		"create (single) is missing engine result for wasm",
		"create (single) is missing a decoded-value checksum for wasm",
		"create (single) produced a checksum mismatch between paired engines",
		"unknown case is not present in the fixed workload manifest",
		"create (single) belongs to suite crud, not scaling",
	])("treats %s as a baseline blocker", (message) => {
		expect(isBaselineBlockingFailure(message)).toBe(true);
	});

	it("allows performance-only failures in the pre-optimization baseline", () => {
		expect(
			isBaselineBlockingFailure(
				"create (single) throughput ratio 0.19 is below the required 0.20",
			),
		).toBe(false);
	});
});

describe("describeBenchmarkRunnerFailure", () => {
	it("surfaces machine-readable execution failures from a non-zero runner", () => {
		const message = describeBenchmarkRunnerFailure(
			1,
			JSON.stringify({
				executionFailures: [
					{ suiteName: "crud", message: "attempt timed out after 300000ms" },
				],
			}),
			"",
		);

		expect(message).toContain("crud: attempt timed out after 300000ms");
	});

	it("falls back to stderr and the exit code for invalid runner output", () => {
		expect(describeBenchmarkRunnerFailure(2, "not json", "child crashed")).toBe(
			"child crashed",
		);
		expect(describeBenchmarkRunnerFailure(3, "", "")).toBe(
			"Benchmark runner exited with code 3",
		);
	});
});

describe("assertBaselineReportIsCapturable", () => {
	it("rejects checksum mismatches during baseline generation", () => {
		const report = makeReport(
			"create (single) produced a checksum mismatch between paired engines",
		);

		expect(() => assertBaselineReportIsCapturable(report)).toThrow(
			"checksum mismatch",
		);
	});

	it("rejects execution failures during baseline generation", () => {
		const report: BenchmarkJsonOutput = {
			...makeReport(),
			executionFailures: [
				{
					suiteName: "crud",
					path: "/synthetic/crud.bench.ts",
					message: "execution failure: synthetic crash",
				},
			],
		};

		expect(() => assertBaselineReportIsCapturable(report)).toThrow(
			"execution failure",
		);
	});

	it("allows performance-only contract failures to remain in the captured baseline", () => {
		const report = makeReport(
			"create (single) throughput ratio 0.19 is below the required 0.20",
		);

		expect(() => assertBaselineReportIsCapturable(report)).not.toThrow();
	});
});
