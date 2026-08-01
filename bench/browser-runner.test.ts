import { describe, expect, it, vi } from "vitest";
import {
	closeBrowserPerformancePage,
	validateBrowserWorkloadState,
} from "./browser-runner.js";
import {
	BROWSER_WORKLOAD_BASELINE_COUNT,
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_NAMES,
	type BrowserPerformanceWorkloadState,
} from "./workloads.js";

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
