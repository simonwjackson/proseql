import { describe, expect, it } from "vitest";
import {
	assertU2BrowserEvidencePasses,
	nixNpmPackDryRunArguments,
	npmPackDryRunArguments,
} from "./verify-package-artifacts.js";

describe("package artifact dry-run packing", () => {
	it("disables lifecycle scripts for direct npm packing", () => {
		expect(npmPackDryRunArguments).toContain("--ignore-scripts");
		expect(npmPackDryRunArguments).toEqual([
			"pack",
			"--dry-run",
			"--json",
			"--ignore-scripts",
		]);
	});

	it("disables lifecycle scripts for the Nix fallback", () => {
		const args = nixNpmPackDryRunArguments("/repo");
		expect(args).toContain("--ignore-scripts");
		expect(args.slice(-5)).toEqual([
			"npm",
			"pack",
			"--dry-run",
			"--json",
			"--ignore-scripts",
		]);
	});
});

const passingBrowserEvidence = {
	currentBrowserContract: { passed: true, failures: [] },
	artifact: { current: 566_791, maxAllowed: 567_029.4, passed: true },
	coldStartupMs: { current: 1_000, maxAllowed: 1_126, passed: true },
	jsHeapBytes: { current: 12_000_000, maxAllowed: 50_000_000, passed: true },
	wasmLinearMemoryBytes: {
		current: 27_000_000,
		maxAllowed: 28_000_000,
		passed: true,
	},
	interactions: [
		{
			name: "create (single)",
			currentP95Ms: 2,
			withinAbsoluteP95Budget: true,
		},
	],
	summary: {
		artifactAndRegressionBudgetsPassed: true,
		allInteractionP95Within50Ms: true,
	},
};

describe("fresh browser budget evidence", () => {
	it("accepts evidence only when every browser and artifact budget passes", () => {
		expect(() =>
			assertU2BrowserEvidencePasses(passingBrowserEvidence),
		).not.toThrow();
	});

	it.each([
		[
			"artifact",
			{
				artifact: {
					...passingBrowserEvidence.artifact,
					current: 567_030,
					passed: false,
				},
			},
		],
		[
			"startup",
			{
				coldStartupMs: {
					...passingBrowserEvidence.coldStartupMs,
					passed: false,
				},
			},
		],
		[
			"JavaScript heap",
			{
				jsHeapBytes: {
					...passingBrowserEvidence.jsHeapBytes,
					passed: false,
				},
			},
		],
		[
			"WASM memory",
			{
				wasmLinearMemoryBytes: {
					...passingBrowserEvidence.wasmLinearMemoryBytes,
					passed: false,
				},
			},
		],
		[
			"interaction",
			{
				interactions: [
					{
						name: "create (single)",
						currentP95Ms: 50,
						withinAbsoluteP95Budget: false,
					},
				],
				summary: {
					...passingBrowserEvidence.summary,
					allInteractionP95Within50Ms: false,
				},
			},
		],
	])("rejects a failed %s budget", (_label, override) => {
		expect(() =>
			assertU2BrowserEvidencePasses({ ...passingBrowserEvidence, ...override }),
		).toThrow(/browser release budget/i);
	});
});
