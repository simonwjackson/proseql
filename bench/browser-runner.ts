import { type Browser, chromium, type Page } from "playwright";
import { createServer as createViteServer } from "vite";
import { validateBrowserPerformanceContract } from "./performance-contract.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createUnavailableMetric,
	type NumericMetric,
	exactPercentile,
} from "./comparison.js";
import {
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_INTERACTION_NAMES,
	type BrowserPerformanceWorkloadState,
	type BrowserWorkloadName,
} from "./workloads.js";
export { BROWSER_WORKLOAD_INTERACTION_NAMES } from "./workloads.js";

const parsedBrowserReportTimeoutMs = Number.parseInt(
	process.env.PROSEQL_BENCH_BROWSER_TIMEOUT_MS ?? "300000",
	10,
);
const DEFAULT_BROWSER_REPORT_TIMEOUT_MS = Number.isFinite(
	parsedBrowserReportTimeoutMs,
)
	? parsedBrowserReportTimeoutMs
	: 300_000;
const DEFAULT_BROWSER_SAMPLE_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_SETUP_TIMEOUT_MS = 60_000;
const DEFAULT_BROWSER_MEMORY_TIMEOUT_MS = 15_000;
const DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS = 15_000;
const PROGRESS_ENABLED = process.env.PROSEQL_BENCH_PROGRESS === "1";

export interface BrowserInteractionReport {
	readonly name: string;
	readonly samples: ReadonlyArray<number>;
	readonly p50Ms: number | undefined;
	readonly p95Ms: number | undefined;
	readonly p99Ms: number | undefined;
	readonly meanMs: number;
	readonly observedCleanupCount: number | undefined;
}

export interface BrowserPerformanceReport {
	readonly coldStartupMs: number;
	readonly interactions: ReadonlyArray<BrowserInteractionReport>;
	readonly jsHeapBytes: NumericMetric;
	readonly wasmLinearMemoryBytes: NumericMetric;
}

export interface BrowserPerformanceJsonOutput {
	readonly timestamp: string;
	readonly runtime: "chromium";
	readonly report: BrowserPerformanceReport;
	readonly contract: ReturnType<typeof validateBrowserPerformanceContract>;
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteRoot = join(repoRoot, "packages/browser/tests/fixtures/vite-app");

const logBrowserProgress = (message: string): void => {
	if (PROGRESS_ENABLED) {
		console.error(`[bench:browser] ${message}`);
	}
};

const withTimeout = async <T>(
	label: string,
	timeoutMs: number,
	operation: () => Promise<T>,
): Promise<T> => {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(),
			new Promise<T>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`${label} exceeded ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
};

export const resolveChromiumLaunchOptions = () => ({
	headless: true,
	...(process.env.CHROMIUM_EXECUTABLE_PATH
		? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
		: {}),
});

export const canLaunchBenchmarkBrowser = async (): Promise<boolean> => {
	try {
		const browser = await chromium.launch(resolveChromiumLaunchOptions());
		await browser.close();
		return true;
	} catch {
		return false;
	}
};

export const launchBenchmarkBrowser = async (): Promise<Browser> =>
	chromium.launch(resolveChromiumLaunchOptions());

export const measureBrowserInteractionSamples = async (
	_page: Page,
	options: {
		readonly name: string;
		readonly iterations: number;
		readonly minSamples?: number;
		readonly warmupIterations?: number;
		readonly sampleTimeoutMs?: number;
		readonly afterBatch?: () => Promise<number | undefined>;
		readonly evaluate: () => Promise<number>;
	},
): Promise<BrowserInteractionReport> => {
	const sampleTimeoutMs =
		options.sampleTimeoutMs ?? DEFAULT_BROWSER_SAMPLE_TIMEOUT_MS;
	for (
		let iteration = 0;
		iteration < (options.warmupIterations ?? 0);
		iteration++
	) {
		logBrowserProgress(
			`${options.name}: warmup ${iteration + 1}/${options.warmupIterations ?? 0}`,
		);
		await withTimeout(
			`${options.name} warmup ${iteration + 1}`,
			sampleTimeoutMs,
			options.evaluate,
		);
	}
	const samples: number[] = [];
	for (let iteration = 0; iteration < options.iterations; iteration++) {
		logBrowserProgress(
			`${options.name}: sample ${iteration + 1}/${options.iterations}`,
		);
		samples.push(
			await withTimeout(
				`${options.name} sample ${iteration + 1}`,
				sampleTimeoutMs,
				options.evaluate,
			),
		);
	}

	const minSamples = options.minSamples ?? 30;
	if (samples.length < minSamples) {
		throw new Error(
			`${options.name} collected insufficient samples (${samples.length}/${minSamples})`,
		);
	}

	logBrowserProgress(`${options.name}: verify cleanup`);
	const observedCleanupCount =
		options.afterBatch === undefined
			? undefined
			: await withTimeout(
					`${options.name} cleanup verification`,
					sampleTimeoutMs,
					options.afterBatch,
				);

	const meanMs =
		samples.reduce((sum, sample) => sum + sample, 0) / samples.length;

	return {
		name: options.name,
		samples,
		p50Ms: exactPercentile(samples, 50),
		p95Ms: exactPercentile(samples, 95),
		p99Ms: exactPercentile(samples, 99),
		meanMs,
		observedCleanupCount,
	};
};

export const measurePageFunctionSamples = async <
	TArgs extends ReadonlyArray<unknown>,
>(
	page: Page,
	options: {
		readonly name: string;
		readonly iterations: number;
		readonly minSamples?: number;
		readonly warmupIterations?: number;
		readonly sampleTimeoutMs?: number;
		readonly functionName: string;
		readonly args?: TArgs;
	},
): Promise<BrowserInteractionReport> =>
	measureBrowserInteractionSamples(page, {
		name: options.name,
		iterations: options.iterations,
		minSamples: options.minSamples,
		warmupIterations: options.warmupIterations,
		sampleTimeoutMs: options.sampleTimeoutMs,
		evaluate: () =>
			page.evaluate(
				({ functionName, args }) => {
					const harness = (window as Record<string, unknown>)
						.__PROSEQL_BROWSER_PERF__ as
						| Record<
								string,
								(...input: ReadonlyArray<unknown>) => Promise<number>
						  >
						| undefined;
					const fn = harness?.[functionName];
					if (typeof fn !== "function") {
						throw new Error(
							`Missing browser benchmark function: ${functionName}`,
						);
					}
					return fn(...(args ?? []));
				},
				{ functionName: options.functionName, args: options.args ?? [] },
			),
	});

export const validateBrowserWorkloadState = (
	workload: BrowserWorkloadName,
	state: BrowserPerformanceWorkloadState | null | undefined,
): void => {
	if (!state) {
		throw new Error(`${workload} did not publish browser performance state`);
	}
	if (state.workload !== workload) {
		throw new Error(`${workload} published state for ${state.workload}`);
	}
	const expected = BROWSER_WORKLOAD_EXPECTATIONS[workload];
	if (state.baselineCount !== expected.baselineCount) {
		throw new Error(
			`${workload} expected baseline count ${expected.baselineCount}, received ${state.baselineCount}`,
		);
	}
	if (state.resultCount !== expected.resultCount) {
		throw new Error(
			`${workload} expected result count ${expected.resultCount}, received ${state.resultCount}`,
		);
	}
	if (!state.restorationVerified) {
		throw new Error(`${workload} did not verify cleanup after the sample`);
	}
	if (
		expected.targetExistsAfterCleanup !== undefined &&
		state.targetExistsAfterCleanup !== expected.targetExistsAfterCleanup
	) {
		throw new Error(
			`${workload} expected targetExistsAfterCleanup ${String(expected.targetExistsAfterCleanup)}, received ${String(state.targetExistsAfterCleanup)}`,
		);
	}
};

export const collectBrowserPerformanceReport = async (
	browser: Browser,
	pageFactory: () => Promise<Page>,
	interactions: ReadonlyArray<{
		readonly name: string;
		readonly iterations: number;
		readonly minSamples?: number;
		readonly warmupIterations?: number;
		readonly sampleTimeoutMs?: number;
		readonly afterBatch?: (page: Page) => Promise<number | undefined>;
		readonly evaluate: (page: Page) => Promise<number>;
	}>,
	options: {
		readonly timeoutMs?: number;
		readonly memoryTimeoutMs?: number;
		readonly teardownTimeoutMs?: number;
	} = {},
): Promise<BrowserPerformanceReport> => {
	const startupStart = performance.now();
	logBrowserProgress("setup: open page");
	const page = await withTimeout(
		"browser page setup",
		DEFAULT_BROWSER_SETUP_TIMEOUT_MS,
		pageFactory,
	);
	const coldStartupMs = performance.now() - startupStart;

	try {
		return await withTimeout(
			"browser performance report",
			options.timeoutMs ?? DEFAULT_BROWSER_REPORT_TIMEOUT_MS,
			async () => {
				const interactionReports: BrowserInteractionReport[] = [];
				for (const interaction of interactions) {
					logBrowserProgress(`interaction: ${interaction.name}`);
					interactionReports.push(
						await measureBrowserInteractionSamples(page, {
							name: interaction.name,
							iterations: interaction.iterations,
							minSamples: interaction.minSamples,
							warmupIterations: interaction.warmupIterations,
							sampleTimeoutMs: interaction.sampleTimeoutMs,
							afterBatch:
								interaction.afterBatch === undefined
									? undefined
									: () => interaction.afterBatch!(page),
							evaluate: () => interaction.evaluate(page),
						}),
					);
				}

				logBrowserProgress("memory: collect post-GC heap and WASM memory");
				const [jsHeapBytes, wasmLinearMemoryBytes] = await Promise.all([
					withTimeout(
						"browser JS heap measurement",
						options.memoryTimeoutMs ?? DEFAULT_BROWSER_MEMORY_TIMEOUT_MS,
						() => measurePostGcJsHeapBytes(page),
					),
					withTimeout(
						"browser WASM memory measurement",
						options.memoryTimeoutMs ?? DEFAULT_BROWSER_MEMORY_TIMEOUT_MS,
						() => measureBestEffortWasmMemoryBytes(page),
					),
				]);

				return {
					coldStartupMs,
					interactions: interactionReports,
					jsHeapBytes,
					wasmLinearMemoryBytes,
				};
			},
		);
	} finally {
		await closeBrowserPerformancePage(page, {
			timeoutMs:
				options.teardownTimeoutMs ?? DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS,
		});
		void browser;
	}
};

export const buildBrowserPerformanceJsonOutput = (
	report: BrowserPerformanceReport,
): BrowserPerformanceJsonOutput => ({
	timestamp: new Date().toISOString(),
	runtime: "chromium",
	report,
	contract: validateBrowserPerformanceContract(report),
});

interface BrowserWorkloadServer {
	readonly baseUrl: string;
	readonly close: () => Promise<void>;
}

const startBrowserWorkloadServer = async (): Promise<BrowserWorkloadServer> => {
	const vite = await createViteServer({
		root: viteRoot,
		server: { host: "127.0.0.1", port: 0 },
	});
	await vite.listen();
	const baseUrl =
		vite.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ??
		"http://127.0.0.1:5173";
	return {
		baseUrl,
		close: async () => {
			const httpServer = vite.httpServer;
			await withTimeout(
				"browser workload server close",
				DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS,
				async () => {
					vite.ws.close();
					httpServer?.closeAllConnections?.();
					await Promise.all([
						vite.watcher.close(),
						httpServer === null
							? Promise.resolve()
							: new Promise<void>((resolve, reject) => {
									httpServer.close((error) => {
										if (
											error &&
											!(
												"code" in error &&
												error.code === "ERR_SERVER_NOT_RUNNING"
											)
										) {
											reject(error);
											return;
										}
										resolve();
									});
								}),
					]);
				},
			);
		},
	};
};

const evaluateBrowserWorkload = async (
	page: Page,
	workload: BrowserWorkloadName,
): Promise<number> => {
	const result = await page.evaluate((interactionName) => {
		const globals = window as Record<string, unknown>;
		const harness = globals.__PROSEQL_BROWSER_PERF__ as
			| Record<string, () => Promise<number>>
			| undefined;
		const fn = harness?.[interactionName];
		if (typeof fn !== "function") {
			throw new Error(
				`Missing browser workload interaction: ${interactionName}`,
			);
		}
		return fn().then((durationMs) => ({
			durationMs,
			state:
				(globals.__PROSEQL_BROWSER_PERF_STATE__ as
					| BrowserPerformanceWorkloadState
					| undefined) ?? null,
		}));
	}, workload);
	validateBrowserWorkloadState(workload, result.state);
	return result.durationMs;
};

const verifyBrowserWorkloadCleanup = async (
	page: Page,
	workload: BrowserWorkloadName,
): Promise<number> =>
	page.evaluate((interactionName) => {
		const verify = (window as Record<string, unknown>)
			.__PROSEQL_BROWSER_PERF_VERIFY_CLEANUP__ as
			| ((name: BrowserWorkloadName) => Promise<number>)
			| undefined;
		if (typeof verify !== "function") {
			throw new Error("Missing browser cleanup verification function");
		}
		return verify(interactionName);
	}, workload);

const createBrowserWorkloadInteractions = () =>
	BROWSER_WORKLOAD_INTERACTION_NAMES.map((name) => ({
		name,
		iterations: 30,
		minSamples: 30,
		warmupIterations: 1,
		evaluate: (page: Page) => evaluateBrowserWorkload(page, name),
		afterBatch: (page: Page) => verifyBrowserWorkloadCleanup(page, name),
	}));

export const collectBrowserWorkloadReport = async (
	browser?: Browser,
	options: {
		readonly timeoutMs?: number;
		readonly memoryTimeoutMs?: number;
		readonly teardownTimeoutMs?: number;
	} = {},
): Promise<BrowserPerformanceReport> => {
	const ownedBrowser = browser ?? (await launchBenchmarkBrowser());
	const server = await startBrowserWorkloadServer();
	let failure: unknown;
	try {
		return await collectBrowserPerformanceReport(
			ownedBrowser,
			async () => {
				const page = await ownedBrowser.newPage();
				await page.goto(server.baseUrl, { waitUntil: "networkidle" });
				await page.waitForFunction(
					() =>
						Boolean(
							(window as Record<string, unknown>)
								.__PROSEQL_BROWSER_PERF_READY__,
						),
					undefined,
					{ timeout: DEFAULT_BROWSER_SETUP_TIMEOUT_MS },
				);
				return page;
			},
			createBrowserWorkloadInteractions(),
			options,
		);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		logBrowserProgress("teardown: close workload server");
		try {
			await server.close();
		} catch (closeError) {
			if (failure === undefined) {
				throw closeError;
			}
			logBrowserProgress(
				`teardown: workload server close failed after primary error (${closeError instanceof Error ? closeError.message : String(closeError)})`,
			);
		}
		if (!browser) {
			logBrowserProgress("teardown: close owned browser");
			try {
				await withTimeout(
					"owned browser close",
					DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS,
					() => ownedBrowser.close(),
				);
			} catch (closeError) {
				if (failure === undefined) {
					throw closeError;
				}
				logBrowserProgress(
					`teardown: owned browser close failed after primary error (${closeError instanceof Error ? closeError.message : String(closeError)})`,
				);
			}
		}
	}
};

export const closeBrowserPerformancePage = async (
	page: Page,
	options: { readonly timeoutMs?: number } = {},
): Promise<void> => {
	logBrowserProgress("teardown: drain workload databases");
	try {
		await withTimeout(
			"browser workload teardown",
			options.timeoutMs ?? DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS,
			() =>
				page.evaluate(async () => {
					const closeAll = (window as Record<string, unknown>)
						.__PROSEQL_BROWSER_PERF_CLOSE_ALL__ as
						| (() => Promise<void>)
						| undefined;
					if (typeof closeAll === "function") {
						await closeAll();
					}
				}),
		);
	} catch {
		// Ignore teardown failures from already-closed pages or absent harness cleanup.
	} finally {
		logBrowserProgress("teardown: close page");
		await page.close({ runBeforeUnload: false });
	}
};

const measurePostGcJsHeapBytes = async (page: Page): Promise<NumericMetric> => {
	try {
		const session = await page.context().newCDPSession(page);
		try {
			await session.send("HeapProfiler.enable").catch(() => undefined);
			await session.send("HeapProfiler.collectGarbage");
			const usage = (await session.send("Runtime.getHeapUsage")) as {
				readonly usedSize?: number;
			};
			return typeof usage.usedSize === "number"
				? { status: "available", value: usage.usedSize }
				: createUnavailableMetric(
						"Chromium Runtime.getHeapUsage did not report usedSize",
					);
		} finally {
			await session.detach().catch(() => undefined);
		}
	} catch (error) {
		return createUnavailableMetric(
			error instanceof Error
				? error.message
				: "Chromium CDP HeapProfiler.collectGarbage is unavailable",
		);
	}
};

const measureBestEffortWasmMemoryBytes = async (
	page: Page,
): Promise<NumericMetric> => {
	try {
		const bytes = await page.evaluate(() => {
			const globals = window as Record<string, unknown>;
			const memory = globals.__PROSEQL_WASM_MEMORY__ as
				| { readonly buffer?: { readonly byteLength?: number } }
				| undefined;
			return memory?.buffer?.byteLength;
		});
		return typeof bytes === "number"
			? { status: "available", value: bytes }
			: createUnavailableMetric(
					"window.__PROSEQL_WASM_MEMORY__ is unavailable",
				);
	} catch (error) {
		return createUnavailableMetric(
			error instanceof Error ? error.message : "unable to read WASM memory",
		);
	}
};

if (import.meta.main) {
	const browser = await launchBenchmarkBrowser();
	let failure: unknown;
	try {
		const report = await collectBrowserWorkloadReport(browser);
		console.log(
			JSON.stringify(buildBrowserPerformanceJsonOutput(report), null, 2),
		);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		logBrowserProgress("teardown: close shared browser");
		try {
			await withTimeout(
				"shared browser close",
				DEFAULT_BROWSER_TEARDOWN_TIMEOUT_MS,
				() => browser.close(),
			);
		} catch (closeError) {
			if (failure === undefined) {
				throw closeError;
			}
			logBrowserProgress(
				`teardown: shared browser close failed after primary error (${closeError instanceof Error ? closeError.message : String(closeError)})`,
			);
		}
	}
}
