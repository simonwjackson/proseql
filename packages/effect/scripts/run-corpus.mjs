#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	ensureBuiltEngineWasm,
	normalizeOutput,
	parseJUnitCounts,
	repoRootFromImportMetaUrl,
	resolveFromRepo,
	safeRead,
} from "./_parity-helpers.mjs";

const repoRoot = repoRootFromImportMetaUrl(import.meta.url);
const coreTestsDir = resolveFromRepo(repoRoot, "packages/core/tests");
const coreSrcDir = resolveFromRepo(repoRoot, "packages/core/src").replaceAll("\\", "/");
const effectIndex = resolveFromRepo(repoRoot, "packages/effect/src/index.ts").replaceAll("\\", "/");
const reportDir = resolveFromRepo(repoRoot, "packages/effect/reports");
const reportPath = join(reportDir, "corpus-report.json");

const runnableFiles = new Set([
	"cursor-pagination.test.ts",
	"database-document-graph.test.ts",
	"database-effect.test.ts",
	"database-source-config.test.ts",
	"error-model.test.ts",
	"filtering.test.ts",
	"full-text-search.test.ts",
	"lifecycle-hooks.test.ts",
	"transactions.test.ts",
	"watch-query-pipeline.test.ts",
]);

const expectedXfails = new Map();
const explicitSkips = new Map([
	[
		"reactive-queries.test.ts",
		{
			category: "non-applicable",
			owner: "core",
			reason:
				"The current worktree copy is syntactically malformed (`[0] _as ...`) before adapter swapping. Keep explicitly skipped until the upstream test file is repaired.",
		},
	],
]);

mkdirSync(reportDir, { recursive: true });
ensureBuiltEngineWasm(repoRoot);

const workspace = resolveFromRepo(repoRoot, "packages/effect/.tmp/corpus");
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

const allFiles = [...new Bun.Glob("*.test.ts").scanSync(coreTestsDir)].sort();
const results = [];
let totalAssertions = 0;
let totalPassedAssertions = 0;
let totalFailedAssertions = 0;

try {
	for (const file of allFiles) {
		if (runnableFiles.has(file)) {
			results.push(await runRunnableFile(file, "pass"));
			const latest = results[results.length - 1];
			totalAssertions += latest.tests ?? 0;
			totalPassedAssertions += latest.passedTests ?? 0;
			totalFailedAssertions += latest.failedTests ?? 0;
			continue;
		}
		if (expectedXfails.has(file)) {
			results.push(await runRunnableFile(file, "xfail", expectedXfails.get(file)));
			const latest = results[results.length - 1];
			totalAssertions += latest.tests ?? 0;
			totalPassedAssertions += latest.passedTests ?? 0;
			totalFailedAssertions += latest.failedTests ?? 0;
			continue;
		}
		results.push(classifySkip(file));
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
const xfailedResults = xfailResults.filter((result) => result.status === "xfailed");

const report = {
	phase: "phase-2-slice",
	generatedAt: new Date().toISOString(),
	summary: {
		totalFiles: allFiles.length,
		executedFiles: runnableResults.length + xfailResults.length,
		runnableFiles: runnableResults.length,
		skippedFiles: skippedResults.length,
		xfailedFiles: xfailedResults.length,
		xpassedFiles: xpassedResults.length,
		passedFiles: passedResults.length,
		failedFiles: failedResults.length,
		coverageRate: allFiles.length === 0 ? 0 : (runnableResults.length + xfailResults.length) / allFiles.length,
		executedFraction: allFiles.length === 0 ? 0 : (runnableResults.length + xfailResults.length) / allFiles.length,
		slicePassRate: runnableResults.length === 0 ? 0 : passedResults.length / runnableResults.length,
		totalAssertions,
		passedAssertions: totalPassedAssertions,
		failedAssertions: totalFailedAssertions,
	},
	results,
	failures: failedResults.concat(xpassedResults).map(({ test, category, reason }) => ({
		test,
		category,
		reason: reason ?? "failed",
	})),
	xfails: xfailResults.map(({ test, category, owner, reason, status }) => ({
		test,
		category,
		owner,
		reason,
		status,
	})),
	skipList: skippedResults.map(({ test, category, owner, reason }) => ({
		test,
		category,
		owner,
		reason,
	})),
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`Corpus phase-2 slice: ${passedResults.length}/${runnableResults.length} runnable files passed (${(
		report.summary.slicePassRate * 100
	).toFixed(2)}%), coverage ${(report.summary.coverageRate * 100).toFixed(2)}%`,
);
console.log(`Assertions: ${totalPassedAssertions}/${totalAssertions}`);
console.log(`Wrote ${reportPath}`);
if (failedResults.length > 0 || xpassedResults.length > 0) {
	process.exitCode = 1;
}

async function runRunnableFile(file, expectation, expected = undefined) {
	const sourcePath = join(coreTestsDir, file);
	const transformedPath = join(workspace, file);
	writeFileSync(transformedPath, transformCoreTest(readFileSync(sourcePath, "utf8")));
	const junitPath = join(workspace, `${file}.xml`);
	const run = spawnSync(
		"bun",
		["test", transformedPath, "--reporter=junit", `--reporter-outfile=${junitPath}`],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				CI: process.env.CI ?? "1",
			},
		},
	);
	const counts = parseJUnitCounts(safeRead(junitPath));
	const passedTests = counts.tests - counts.failures - counts.errors;
	const failedTests = counts.failures + counts.errors;
	const output = {
		stdout: normalizeOutput(run.stdout ?? "", repoRoot),
		stderr: normalizeOutput(run.stderr ?? "", repoRoot),
	};
	const passed = run.status === 0;
	return {
		test: file,
		expectation,
		status:
			expectation === "xfail"
				? passed
					? "xpassed"
					: "xfailed"
				: passed
					? "passed"
					: "failed",
			category: expectation === "xfail" ? expected?.category ?? "known-failure" : passed ? undefined : "engine-bug",
			owner: expected?.owner ?? "effect-adapter",
			reason:
				expectation === "xfail"
					? expected?.reason
					: passed
						? undefined
						: summarizeFailure(output),
			exitCode: run.status ?? -1,
			tests: counts.tests,
			passedTests,
			failedTests,
			stdout: output.stdout,
			stderr: output.stderr,
		};
}

function transformCoreTest(source) {
	return source
		.replace(/(["'])\.\.\/src\/([^"']+?)(?:\.js)?\1/g, (_match, quote, subpath) => {
			if (subpath === "factories/database-effect" || subpath === "index" || subpath === "errors/index") {
				return `${quote}${effectIndex}${quote}`;
			}
			return `${quote}${coreSrcDir}/${subpath}.ts${quote}`;
		})
		.replace(/const (\w+) =\s*\n\s*([A-Za-z0-9_]+),\s*\n\s*\[0\]\s*(?:_as|as)\s*([^;]+);/g, "const $1 = $2[0] as $3;")
		.replace(/\b_as ([^;]+);/g, "as $1;")
		.replace(/([A-Za-z0-9_]+)\.pipe\(\s*\(chunk\) => Array\.from\(chunk\)\[0\],\s*\)/g, "Array.from($1)[0]")
		.replace(/Effect\.timeoutFail\(\{\s*duration:\s*"([^"]+)",\s*onTimeout:\s*\(\) => new Error\("[^"]*"\),\s*\}\)/g, 'Effect.timeout("$1")')
		.replaceAll("Effect.either", "Effect.result")
		.replaceAll("Effect.forkChildIn", "Effect.forkIn")
		.replaceAll('toBe("Left")', 'toBe("Failure")')
		.replace(/\bEffect\.fork\b/g, "Effect.forkChild");
}

function classifySkip(file) {
	const explicit = explicitSkips.get(file);
	if (explicit) {
		return {
			test: file,
			expectation: "skip",
			status: "skipped",
			category: explicit.category,
			owner: explicit.owner,
			reason: explicit.reason,
		};
	}

	const typeOnly = /(?:-types|type-safety|query-config-types|crud-methods-types)\.test\.ts$/.test(file);
	if (typeOnly) {
		return {
			test: file,
			expectation: "skip",
			status: "skipped",
			category: "compile-time-only",
			owner: "effect-adapter",
			reason: "Type-only or compile-time assertion suite; covered separately by the adapter's dedicated typecheck gate.",
		};
	}

	const internalPrimitive = /(array-operators|cursor-stream|debounced-writer|deep-merge|derived-id|document-source|evaluate-query|file-watcher|filter-stream|filter\.test|format-codec|glob-match|in-memory-storage|json-serializer|jsonc-comments|nested-path|paginate-stream|populate-stream|preset-layers|prose-|relevance-sort|search-index|select-stream|select\.test|serializer-service|sort-stream|source-config|state\.test|storage-services|toml-nulls|transforms|watch-by-id|watch-deduplication|yaml-serializer)\.test\.ts$/.test(file);
	if (internalPrimitive) {
		return {
			test: file,
			expectation: "skip",
			status: "skipped",
			category: "non-applicable",
			owner: "effect-adapter",
			reason: "Targets internal core primitives or helper modules rather than the factory-swappable adapter surface exercised by the U9 parity slice.",
		};
	}

	return {
		test: file,
		expectation: "skip",
		status: "skipped",
		category: "slice-not-yet-adapted",
		owner: "effect-adapter",
		reason: "Adapter-facing suite not yet transformed into this phase-2 slice inventory. Keep explicitly tracked until the parity slice expands further.",
	};
}

function summarizeFailure(output) {
	return [
		`stdout:\n${output.stdout}`,
		`stderr:\n${output.stderr}`,
	].join("\n\n").slice(0, 8000);
}
