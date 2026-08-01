import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	BROWSER_WORKLOAD_INTERACTION_NAMES,
	buildBrowserPerformanceJsonOutput,
	canLaunchBenchmarkBrowser,
	collectBrowserPerformanceReport,
	collectBrowserWorkloadReport,
	launchBenchmarkBrowser,
	measureBrowserInteractionSamples,
} from "../../../bench/browser-runner.js";

let browser: Awaited<ReturnType<typeof launchBenchmarkBrowser>> | undefined;
let chromiumAvailable = false;

beforeAll(async () => {
	chromiumAvailable = await canLaunchBenchmarkBrowser();
}, 30_000);

afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

describe("browser performance runner", () => {
	it("enumerates the exact named normal browser interactions", () => {
		expect(BROWSER_WORKLOAD_INTERACTION_NAMES).toEqual([
			"findById @ 10K",
			"paginate: limit 100, offset 500",
			"create (single)",
			"update (single)",
			"delete (single)",
			"updateMany (declarative batch ~100)",
			"updateMany (predicate batch ~100)",
			"transactional (create + update + delete)",
		]);
	});

	it.skipIf(!chromiumAvailable)(
		"collects the real Chromium workload report for all named browser interactions",
		async () => {
			browser = await launchBenchmarkBrowser();
			const report = await collectBrowserWorkloadReport(browser);

			expect(report.coldStartupMs).toBeGreaterThanOrEqual(0);
			expect(
				report.interactions.map((interaction) => interaction.name),
			).toEqual([...BROWSER_WORKLOAD_INTERACTION_NAMES]);
			for (const interaction of report.interactions) {
				expect(interaction.samples).toHaveLength(30);
				expect(interaction.p95Ms).toBeDefined();
				expect(interaction.observedCleanupCount).toBe(10_000);
			}
			expect(report.jsHeapBytes.status).toBeDefined();
			expect(report.wasmLinearMemoryBytes.status).toBeDefined();
		},
		60_000,
	);

	it.skipIf(!chromiumAvailable)(
		"collects browser interaction, cold startup, and best-effort memory metrics from Chromium",
		async () => {
			browser = await launchBenchmarkBrowser();
			const report =
				await collectBrowserPerformanceReport(browser, async () => {
					const page = await browser!.newPage();
					await page.setContent(`
						<!doctype html>
						<html>
							<body>
								<script>
									window.__PROSEQL_WASM_MEMORY__ = { buffer: { byteLength: 4096 } };
									window.__PROSEQL_BROWSER_PERF__ = {
										async interaction(delayMs) {
											const start = performance.now();
											await new Promise((resolve) => setTimeout(resolve, delayMs));
											return performance.now() - start;
										}
									};
									window.__PROSEQL_BROWSER_PERF_READY__ = true;
								</script>
							</body>
						</html>
					`);
					return page;
				}, [
					{
						name: "synthetic-browser-interaction",
						iterations: 30,
						minSamples: 30,
						evaluate: (page) =>
							page.evaluate(() =>
								(
									window as Record<
										string,
										{ interaction: (delayMs: number) => Promise<number> }
									>
								).__PROSEQL_BROWSER_PERF__.interaction(1),
							),
					},
				]);

			expect(report.coldStartupMs).toBeGreaterThanOrEqual(0);
			expect(report.interactions).toHaveLength(1);
			expect(report.interactions[0]?.p95Ms).toBeDefined();
			expect(report.jsHeapBytes.status).toBeDefined();
			expect(report.wasmLinearMemoryBytes).toEqual({
				status: "available",
				value: 4096,
			});
		},
		30_000,
	);

	it("builds machine-readable Chromium output with the browser contract", () => {
		const output = buildBrowserPerformanceJsonOutput({
			coldStartupMs: 100,
			interactions: BROWSER_WORKLOAD_INTERACTION_NAMES.map((name) => ({
				name,
				samples: Array.from({ length: 30 }, () => 10),
				p50Ms: 10,
				p95Ms: 20,
				p99Ms: 25,
				meanMs: 10,
				observedCleanupCount: 10_000,
			})),
			jsHeapBytes: { status: "available", value: 2048 },
			wasmLinearMemoryBytes: { status: "available", value: 4096 },
		});

		expect(output.runtime).toBe("chromium");
		expect(output.contract.passed).toBe(true);
	});

	it("computes latency percentiles and enforces the minimum sample floor", async () => {
		let current = 0;
		const samples = Array.from({ length: 30 }, (_, index) => index + 1);
		const report = await measureBrowserInteractionSamples({} as never, {
			name: "synthetic-samples",
			iterations: samples.length,
			minSamples: 30,
			evaluate: async () => {
				const sample = samples[current++];
				if (sample === undefined) {
					throw new Error("Missing synthetic sample");
				}
				return sample;
			},
		});
		expect(report.samples).toEqual(samples);
		expect(report.p95Ms).toBe(29);
		expect(report.p99Ms).toBe(30);
		expect(report.observedCleanupCount).toBeUndefined();

		await expect(
			measureBrowserInteractionSamples({} as never, {
				name: "insufficient-samples",
				iterations: 3,
				minSamples: 30,
				evaluate: async () => 1,
			}),
		).rejects.toThrow(/insufficient samples/i);
	});
});
