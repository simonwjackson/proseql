import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertBaselineReportIsCapturable,
	collectBaselineParityFailures,
	describeBenchmarkRunnerFailure,
	isBaselineBlockingFailure,
} from "./baseline.js";
import type { BenchmarkJsonOutput } from "./runner.js";

const EXPECTED_BASELINE_PARITY_FAILURES = [
	"create (single)",
	"createMany (batch of 100)",
	"update (single)",
	"updateMany (declarative batch ~100)",
	"updateMany (predicate batch ~100)",
	"delete (single)",
	"deleteMany (declarative batch ~100)",
	"deleteMany (predicate batch ~100)",
	"upsert (create path)",
	"upsert (update path)",
	"filter: equality (role = 'admin')",
	"filter: range (age > 30 AND age < 50)",
	"filter: compound ($and with 3 conditions)",
	"sort: single-field (age asc)",
	"sort: single-field (age desc)",
	"sort: multi-field (role asc, age desc)",
	"sort: multi-field (role asc, age desc, name asc)",
	"populate: single ref (order → user)",
	"populate: inverse (user → orders)",
	"populate: nested 2-level (order → user → orders)",
	"populate: multiple refs (order → user, product)",
	"populate: nested 3-level (order → product → supplier)",
	"select: single field (name)",
	"select: two fields (id, name)",
	"select: three fields (id, name, email)",
	"select: most fields (id, name, email, age, role)",
	"select: no projection (all fields)",
	"select: with filter (name, email WHERE role='admin')",
	"paginate: limit 10 from beginning",
	"paginate: limit 10, offset 5000 (middle)",
	"paginate: limit 10, offset 9990 (end)",
	"paginate: limit 100, offset 500",
	"paginate: limit 10, offset 1000 with sort",
	"paginate: limit 10, offset 500 with filter",
	"combined: filter + sort + select + paginate (no populate)",
	"combined: filter + sort + populate + select + paginate",
	"combined: filter + nested populate + sort + paginate",
	"combined: complex filter + multi-populate + sort + select + paginate",
	"findById @ 100",
	"findById @ 1K",
	"findById @ 10K",
	"unindexed filter @ 100",
	"unindexed filter @ 1K",
	"unindexed filter @ 10K",
	"indexed filter @ 100",
	"indexed filter @ 1K",
	"indexed filter @ 10K",
	"direct (create + update + delete)",
	"transactional (create + update + delete)",
	"persistence: debounced coalescing (100 mutations)",
	"persistence: explicit flush",
] as const;

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
		"create (single) must use dataset size 10000; received 100",
		"create (single) collected 29 samples for wasm; expected at least 30",
		"create (single) must report engineId wasm; received typescript",
		"create (single) must report a finite paired throughput ratio",
		"findById @ 100K repeated high-water growth for wasm exceeded 5%",
	])("treats %s as a baseline blocker", (message) => {
		expect(isBaselineBlockingFailure(message)).toBe(true);
	});

	it("allows performance-only failures in the pre-optimization baseline", () => {
		expect(
			isBaselineBlockingFailure(
				"create (single) throughput ratio 0.190000 is below the required 1.000000",
			),
		).toBe(false);
	});

	it("rejects every sub-parity required case in the checked-in complete baseline", () => {
		const moduleDir = fileURLToPath(new URL(".", import.meta.url));
		const baseline = JSON.parse(
			readFileSync(resolve(moduleDir, "baselines/browser-wasm.json"), "utf8"),
		) as {
			readonly suites: ReadonlyArray<{
				readonly cases: ReadonlyArray<{
					readonly name: string;
					readonly throughputRatio: number;
				}>;
			}>;
		};

		const failures = collectBaselineParityFailures(baseline);

		expect(failures.map((failure) => failure.caseName)).toEqual(
			EXPECTED_BASELINE_PARITY_FAILURES,
		);
		expect(failures.map((failure) => failure.caseName)).toContain(
			"create (single)",
		);
		expect(
			failures.every(
				(failure) =>
					failure.throughputRatio < 1 && failure.message.includes("1.000000"),
			),
		).toBe(true);
	});

	it("rejects duplicate and wrong-suite cases in compact baseline evidence", () => {
		expect(() =>
			collectBaselineParityFailures({
				suites: [
					{
						suite: "crud",
						cases: [
							{ name: "create (single)", throughputRatio: 0.5 },
							{ name: "create (single)", throughputRatio: 1.1 },
						],
					},
				],
			}),
		).toThrow("appears more than once");

		expect(() =>
			collectBaselineParityFailures({
				suites: [
					{
						suite: "scaling",
						cases: [{ name: "create (single)", throughputRatio: 0.5 }],
					},
				],
			}),
		).toThrow("belongs to suite crud");
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
			"create (single) throughput ratio 0.190000 is below the required 1.000000",
		);

		expect(() => assertBaselineReportIsCapturable(report)).not.toThrow();
	});
});
