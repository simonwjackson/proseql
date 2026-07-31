#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	ensureBuiltEngineWasm,
	normalizeOutput,
	repoRootFromImportMetaUrl,
	resolveFromRepo,
} from "./_parity-helpers.mjs";

const repoRoot = repoRootFromImportMetaUrl(import.meta.url);
const examplesDir = resolveFromRepo(repoRoot, "examples");
const effectIndex = resolveFromRepo(repoRoot, "packages/effect/src/index.ts").replaceAll("\\", "/");
const reportDir = resolveFromRepo(repoRoot, "packages/effect/reports");
const reportPath = join(reportDir, "examples-report.json");

const inventory = [
	{ test: "01-basic-crud", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "02-filtering-and-selection", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "03-update-operators", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "04-nested-data", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "05-cursor-pagination", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "06-aggregation", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "07-computed-fields", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{ test: "08-full-text-search", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{
		test: "09-query-with-population",
		entry: "index.ts",
		expectation: "xfail",
		owner: "core",
		category: "upstream-example-bug",
		reason:
			"Fails unchanged under @proseql/core because the example misuses Stream.runCollect on an Effect-returning query. Keep excluded from the runnable slice until upstream is fixed.",
	},
	{ test: "10-lifecycle-hooks", entry: "index.ts", expectation: "pass", owner: "effect-adapter" },
	{
		test: "11-persistence-setup",
		expectation: "skip",
		owner: "effect-adapter",
		category: "non-applicable",
		reason:
			"Targets @proseql/node convenience APIs rather than the U9 Effect adapter surface.",
	},
	{
		test: "12-file-persistence",
		expectation: "skip",
		owner: "effect-adapter",
		category: "non-applicable",
		reason:
			"Targets @proseql/node convenience APIs rather than the U9 Effect adapter surface.",
	},
	{
		test: "13-prose-format",
		expectation: "skip",
		owner: "effect-adapter",
		category: "non-applicable",
		reason:
			"Targets @proseql/node convenience APIs rather than the U9 Effect adapter surface.",
	},
	{
		test: "14-append-only-jsonl",
		expectation: "skip",
		owner: "effect-adapter",
		category: "non-applicable",
		reason:
			"Targets @proseql/node convenience APIs rather than the U9 Effect adapter surface.",
	},
	{
		test: "15-reactive-queries",
		entry: "index.ts",
		expectation: "xfail",
		owner: "core",
		category: "upstream-example-bug",
		reason:
			"Fails unchanged under @proseql/core because the example still uses Effect 4-incompatible Effect.fork pipe syntax. Keep excluded until the upstream example is repaired.",
	},
	{
		test: "16-advanced-features",
		entry: "index.ts",
		expectation: "xfail",
		owner: "core",
		category: "upstream-example-bug",
		reason:
			"Fails unchanged under @proseql/core because the example still uses Effect 4-incompatible Effect.catchAll. Keep excluded until the upstream example is repaired.",
	},
];

mkdirSync(reportDir, { recursive: true });
ensureBuiltEngineWasm(repoRoot);

const workspace = resolveFromRepo(repoRoot, "packages/effect/.tmp/examples");
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

const results = [];

try {
	for (const entry of inventory) {
		if (entry.expectation === "skip") {
			results.push({
				test: entry.test,
				expectation: entry.expectation,
				status: "skipped",
				category: entry.category,
				owner: entry.owner,
				reason: entry.reason,
			});
			continue;
		}

		const sourcePath = join(examplesDir, entry.test, entry.entry);
		const targetPath = join(workspace, `${entry.test}.ts`);
		writeFileSync(targetPath, transformExample(readFileSync(sourcePath, "utf8")));

		const coreRun = runExample(sourcePath);
		const effectRun = runExample(targetPath);
		const coreOutput = normalizeExampleIo(coreRun, repoRoot);
		const effectOutput = normalizeExampleIo(effectRun, repoRoot);
		const outputsMatch =
			coreOutput.stdout === effectOutput.stdout && coreOutput.stderr === effectOutput.stderr;

		if (entry.expectation === "xfail") {
			const xfailed = hasFailureSignal(coreRun, coreOutput) && hasFailureSignal(effectRun, effectOutput) && outputsMatch;
			results.push({
				test: entry.test,
				expectation: entry.expectation,
				status: xfailed ? "xfailed" : "xpassed",
				category: entry.category,
				owner: entry.owner,
				reason: entry.reason,
				core: describeRun(coreRun, coreOutput),
				effect: describeRun(effectRun, effectOutput),
				outputsMatch,
			});
			continue;
		}

		const passed = coreRun.status === 0 && effectRun.status === 0 && outputsMatch;
		results.push({
			test: entry.test,
			expectation: entry.expectation,
			status: passed ? "passed" : "failed",
			category:
				coreRun.status !== 0
					? "upstream-example-bug"
					: effectRun.status !== 0
						? "engine-bug"
						: "parity-mismatch",
			owner: entry.owner,
			reason: passed
				? undefined
				: summarizeDifference(coreOutput, effectOutput, coreRun.status, effectRun.status),
			core: describeRun(coreRun, coreOutput),
			effect: describeRun(effectRun, effectOutput),
			outputsMatch,
		});
	}
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

const runnableResults = results.filter((result) => result.expectation === "pass");
const xfailResults = results.filter((result) => result.expectation === "xfail");
const skippedResults = results.filter((result) => result.expectation === "skip");
const passedResults = runnableResults.filter((result) => result.status === "passed");
const failedResults = runnableResults.filter((result) => result.status === "failed");
const xpassedResults = xfailResults.filter((result) => result.status === "xpassed");

const report = {
	phase: "phase-2-slice",
	generatedAt: new Date().toISOString(),
	summary: {
		totalExamples: inventory.length,
		executedExamples: runnableResults.length + xfailResults.length,
		runnableExamples: runnableResults.length,
		skippedExamples: skippedResults.length,
		xfailedExamples: xfailResults.filter((result) => result.status === "xfailed").length,
		xpassedExamples: xpassedResults.length,
		passedExamples: passedResults.length,
		failedExamples: failedResults.length,
		coverageRate: inventory.length === 0 ? 0 : (runnableResults.length + xfailResults.length) / inventory.length,
		slicePassRate: runnableResults.length === 0 ? 0 : passedResults.length / runnableResults.length,
	},
	results,
	failures: failedResults.concat(xpassedResults).map(({ test, category, reason }) => ({
		test,
		category,
		reason: reason ?? "failed",
	})),
	xfails: xfailResults.map(({ test, category, reason, status }) => ({
		test,
		category,
		reason,
		status,
	})),
	skipList: skippedResults.map(({ test, category, reason, owner }) => ({
		test,
		category,
		reason,
		owner,
	})),
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`Examples phase-2 slice: ${passedResults.length}/${runnableResults.length} runnable passed (${(
		report.summary.slicePassRate * 100
	).toFixed(2)}%), coverage ${(report.summary.coverageRate * 100).toFixed(2)}%`,
);
console.log(`Wrote ${reportPath}`);
if (failedResults.length > 0 || xpassedResults.length > 0) {
	process.exitCode = 1;
}

function runExample(path) {
	return spawnSync("bun", ["run", path], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			CI: process.env.CI ?? "1",
		},
	});
}

function transformExample(source) {
	return source
		.replace(/from\s+["']@proseql\/core["']/g, `from "${effectIndex}"`)
		.replace(/\.catch\(console\.error\)/g, ".catch((error) => { console.error(error); process.exitCode = 1; })");
}

function normalizeExampleIo(run, repoRoot) {
	return {
		stdout: normalizeOutput(run.stdout ?? "", repoRoot),
		stderr: normalizeFailureOutput(normalizeOutput(run.stderr ?? "", repoRoot)),
	};
}

function describeRun(run, normalized) {
	return {
		exitCode: run.status ?? -1,
		stdout: normalized.stdout,
		stderr: normalized.stderr,
	};
}

function hasFailureSignal(run, output) {
	return (run.status ?? 0) !== 0 || output.stderr.length > 0;
}

function normalizeFailureOutput(stderr) {
	const marker = stderr.match(/(?:^|\n)([A-Za-z]+Error:.*|TypeError:.*|ReferenceError:.*|SyntaxError:.*)/);
	if (!marker) return stderr;
	return marker[1] ?? stderr;
}

function summarizeDifference(coreOutput, effectOutput, coreExitCode, effectExitCode) {
	return [
		`core exit=${coreExitCode}`,
		`effect exit=${effectExitCode}`,
		`core stdout:\n${coreOutput.stdout}`,
		`effect stdout:\n${effectOutput.stdout}`,
		`core stderr:\n${coreOutput.stderr}`,
		`effect stderr:\n${effectOutput.stderr}`,
	].join("\n\n").slice(0, 8000);
}
