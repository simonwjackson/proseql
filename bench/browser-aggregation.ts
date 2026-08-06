import type {
	BrowserInteractionReport,
	BrowserPerformanceReport,
} from "./browser-runner.js";
import {
	createUnavailableMetric,
	exactPercentile,
	type NumericMetric,
} from "./comparison.js";
import {
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_INTERACTION_NAMES,
} from "./workloads.js";

export const BROWSER_PERFORMANCE_TRIAL_COUNT = 3;
export const BROWSER_PERFORMANCE_MIN_SAMPLES_PER_TRIAL = 30;

const assert = (condition: boolean, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const aggregateMemoryMetric = (
	name: string,
	trials: ReadonlyArray<BrowserPerformanceReport>,
	select: (report: BrowserPerformanceReport) => NumericMetric,
): NumericMetric => {
	const values: number[] = [];
	for (const [index, trial] of trials.entries()) {
		const metric = select(trial);
		if (metric.status !== "available") {
			return createUnavailableMetric(
				`${name} was unavailable in browser trial ${index + 1}: ${metric.reason}`,
			);
		}
		if (!Number.isFinite(metric.value) || metric.value < 0) {
			return createUnavailableMetric(
				`${name} was invalid in browser trial ${index + 1}`,
			);
		}
		values.push(metric.value);
	}
	return { status: "available", value: Math.max(...values) };
};

const aggregateInteraction = (
	name: (typeof BROWSER_WORKLOAD_INTERACTION_NAMES)[number],
	trials: ReadonlyArray<BrowserPerformanceReport>,
): BrowserInteractionReport => {
	const samples: number[] = [];
	const trialP95s: number[] = [];
	for (const [trialIndex, trial] of trials.entries()) {
		const matching = trial.interactions.filter(
			(interaction) => interaction.name === name,
		);
		assert(
			matching.length === 1,
			`browser trial ${trialIndex + 1} must contain ${name} exactly once`,
		);
		const interaction = matching[0];
		assert(interaction !== undefined, `${name} is missing from browser trial`);
		assert(
			interaction.samples.length >= BROWSER_PERFORMANCE_MIN_SAMPLES_PER_TRIAL,
			`${name} browser trial ${trialIndex + 1} collected ${interaction.samples.length} samples; expected at least ${BROWSER_PERFORMANCE_MIN_SAMPLES_PER_TRIAL}`,
		);
		assert(
			interaction.observedCleanupCount ===
				BROWSER_WORKLOAD_EXPECTATIONS[name].cleanupCount,
			`${name} browser trial ${trialIndex + 1} observed cleanup count ${String(interaction.observedCleanupCount)}; expected ${BROWSER_WORKLOAD_EXPECTATIONS[name].cleanupCount}`,
		);
		for (const sample of interaction.samples) {
			assert(
				Number.isFinite(sample) && sample >= 0,
				`${name} browser trial ${trialIndex + 1} contains an invalid sample`,
			);
			samples.push(sample);
		}
		const trialP95 = exactPercentile(interaction.samples, 95);
		assert(trialP95 !== undefined, `${name} browser trial has no p95 sample`);
		trialP95s.push(trialP95);
	}
	const meanMs =
		samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
	return {
		name,
		samples,
		p50Ms: exactPercentile(samples, 50),
		// Do not let two fast trials dilute a slow trial below the release budget.
		p95Ms: Math.max(...trialP95s),
		p99Ms: exactPercentile(samples, 99),
		meanMs,
		observedCleanupCount: BROWSER_WORKLOAD_EXPECTATIONS[name].cleanupCount,
	};
};

export const aggregateBrowserPerformanceTrials = (
	trials: ReadonlyArray<BrowserPerformanceReport>,
): BrowserPerformanceReport => {
	assert(
		trials.length === BROWSER_PERFORMANCE_TRIAL_COUNT,
		`browser performance evidence requires exactly ${BROWSER_PERFORMANCE_TRIAL_COUNT} independent trials; received ${trials.length}`,
	);
	for (const [index, trial] of trials.entries()) {
		assert(
			Number.isFinite(trial.coldStartupMs) && trial.coldStartupMs >= 0,
			`browser trial ${index + 1} has an invalid cold-start measurement`,
		);
		assert(
			trial.interactions.length === BROWSER_WORKLOAD_INTERACTION_NAMES.length,
			`browser trial ${index + 1} must contain exactly ${BROWSER_WORKLOAD_INTERACTION_NAMES.length} interactions`,
		);
	}
	const coldStarts = trials
		.map((trial) => trial.coldStartupMs)
		.sort((left, right) => left - right);
	const medianColdStartupMs = coldStarts[1];
	assert(medianColdStartupMs !== undefined, "median cold start is missing");
	return {
		coldStartupMs: medianColdStartupMs,
		interactions: BROWSER_WORKLOAD_INTERACTION_NAMES.map((name) =>
			aggregateInteraction(name, trials),
		),
		jsHeapBytes: aggregateMemoryMetric(
			"JavaScript heap",
			trials,
			(report) => report.jsHeapBytes,
		),
		wasmLinearMemoryBytes: aggregateMemoryMetric(
			"WASM linear memory",
			trials,
			(report) => report.wasmLinearMemoryBytes,
		),
	};
};
