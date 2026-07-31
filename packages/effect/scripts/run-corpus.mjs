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
	"aggregation.test.ts",
	"append-only.test.ts",
	"codecs.test.ts",
	"computed-fields.test.ts",
	"computed-fields-zero-overhead.test.ts",
	"conditional-logic.test.ts",
	"crud-computed-field-sanitization.test.ts",
	"crud-create-effect.test.ts",
	"crud-create-with-relationships-effect.test.ts",
	"crud-delete-effect.test.ts",
	"crud-delete-with-relationships-effect.test.ts",
	"crud-update-effect.test.ts",
	"crud-update-with-relationships-effect.test.ts",
	"crud-upsert-effect.test.ts",
	"cursor-pagination.test.ts",
	"database-document-graph.test.ts",
	"database-effect.test.ts",
	"database-source-config.test.ts",
	"debounced-writer.test.ts",
	"derived-id.test.ts",
	"document-graph-config.test.ts",
	"document-graph-source.test.ts",
	"document-source.test.ts",
	"error-model.test.ts",
	"fast-check-import.test.ts",
	"field-selection.test.ts",
	"file-watcher.test.ts",
	"filter-computed-fields.test.ts",
	"filter.test.ts",
	"filtering.test.ts",
	"format-codec.test.ts",
	"full-text-search.test.ts",
	"in-memory-storage.test.ts",
	"indexing.test.ts",
	"infer-codecs.test.ts",
	"jsonc-comments.test.ts",
	"json-serializer.test.ts",
	"lenient-validation.test.ts",
	"lifecycle-hooks.test.ts",
	"multi-field-search.test.ts",
	"nested-schema.test.ts",
	"object-select.test.ts",
	"pagination.test.ts",
	"persistence-computed-exclusion.test.ts",
	"persistence-effect.test.ts",
	"persistence-format-override.test.ts",
	"persistence.test.ts",
	"plugin-system.test.ts",
	"populate.test.ts",
	"preset-layers.test.ts",
	"prose-directive-scanner.test.ts",
	"prose-headline-decoding.test.ts",
	"prose-headline-encoding.test.ts",
	"prose-integration.test.ts",
	"prose-overflow-decoding.test.ts",
	"prose-overflow-encoding.test.ts",
	"prose-round-trip.test.ts",
	"prose-template-compilation.test.ts",
	"prose-value-serialization.test.ts",
	"reactive-queries.test.ts",
	"relevance-sort.test.ts",
	"schema-migrations.test.ts",
	"schema-validation.test.ts",
	"search-index.test.ts",
	"select-computed-fields.test.ts",
	"select-integration.test.ts",
	"select.test.ts",
	"serializer-service.test.ts",
	"sort-computed-fields.test.ts",
	"sorting.test.ts",
	"source-config.test.ts",
	"state.test.ts",
	"storage-services.test.ts",
	"toml-nulls.test.ts",
	"transactions.test.ts",
	"unique-constraints.test.ts",
	"upsert-validation.test.ts",
	"watch-query-pipeline.test.ts",
	"yaml-serializer.test.ts",
]);

const expectedXfails = new Map();
const explicitSkips = new Map();

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
		if (expectedXfails.has(file)) {
			results.push(await runRunnableFile(file, "xfail", expectedXfails.get(file)));
			const latest = results[results.length - 1];
			totalAssertions += latest.tests ?? 0;
			totalPassedAssertions += latest.passedTests ?? 0;
			totalFailedAssertions += latest.failedTests ?? 0;
			continue;
		}
		if (runnableFiles.has(file)) {
			results.push(await runRunnableFile(file, "pass"));
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
	phase: "phase-2-gate",
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
	`Corpus phase-2 gate: ${passedResults.length}/${runnableResults.length} runnable files passed (${(
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
	writeFileSync(transformedPath, transformCoreTest(readFileSync(sourcePath, "utf8"), file));
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
			...(passed
				? {}
				: {
						stdout: output.stdout,
						stderr: output.stderr,
					}),
		};
}

function transformCoreTest(source, fileName = "") {
	let transformed = source
		.replace(/(["'])\.\.\/src\/([^"']+?)(?:\.js)?\1/g, (_match, quote, subpath) => {
			if (subpath === "factories/database-effect" || subpath === "index" || subpath === "errors/index") {
				return `${quote}${effectIndex}${quote}`;
			}
			return `${quote}${coreSrcDir}/${subpath}.ts${quote}`;
		})
		.replace(/const (\w+) =\s*\n\s*([A-Za-z0-9_]+),\s*\n\s*\[0\]\s*(?:_as|as)\s*([^;]+);/g, "const $1 = $2[0] as $3;")
		.replace(/const (\w+) =\s*\n\s*([A-Za-z0-9_]+),\s*\n\s*(?:_as|as)\s*([^;]+);/g, "const $1 = $2 as $3;")
		.replace(/\b_as ([^;]+);/g, "as $1;")
		.replace(/([A-Za-z0-9_]+)\.pipe\(\s*\(chunk\) => Array\.from\(chunk\)\[0\],\s*\)/g, "Array.from($1)[0]")
		.replace(/Effect\.timeoutFail\(\{\s*duration:\s*"([^"]+)",\s*onTimeout:\s*\(\) => new Error\("[^"]*"\),\s*\}\)/g, 'Effect.timeout("$1")')
		.replace(/([A-Za-z0-9_]*Scope)\.fork\(([^)]+)\)/g, 'Scope.fork($1, $2)')
		.replaceAll("ExecutionStrategy.sequential", "({ _tag: \"Sequential\" } as any)")
		.replace(/ExecutionStrategy,\s*/g, "")
		.replaceAll("Effect.either", "Effect.result")
		.replaceAll("Effect.forkChildIn", "Effect.forkIn")
		.replaceAll('toBe("Left")', 'toBe("Failure")')
		.replace(/\bEffect\.fork\b/g, "Effect.forkChild");

	transformed = transformed.replace(
		/createPersistentEffectDatabase\(([\s\S]*?)\)\.pipe\(\s*Effect\.provide\(([^)]+)\),\s*Effect\.scoped,\s*\)/g,
		"createPersistentEffectDatabase($1).pipe(Effect.provide($2))",
	);
	transformed = transformed.replace(
		/const (\w+) = await Effect\.runPromise\(\s*(createPersistentEffectDatabase\([\s\S]*?\)\.pipe\(\s*Effect\.provide\([^)]+\)\s*,?\s*\))\s*,?\s*\);/g,
		"const $1 = await openPersistentDatabase($2);",
	);
	transformed = transformed.replace(
		/const (\w+) = await Effect\.runPromise\(\s*Effect\.provide\(\s*Effect\.scoped\(\s*Effect\.gen\(function\* \(\) \{\s*const database = yield\* createPersistentEffectDatabase\(([\s\S]*?)\);\s*return database;\s*\}\),\s*\),\s*([^,]+),\s*\),\s*\);/g,
		"const $1 = await openPersistentDatabase(Effect.provide(createPersistentEffectDatabase($2), $3));",
	);
	transformed = transformed.replace(
		/openPersistentDatabase\(createPersistentEffectDatabase\(([\s\S]*?)\)\.pipe\(Effect\.provide\((\w+)\),\s*Effect\.scoped\),\s*\);/g,
		"openPersistentDatabase(createPersistentEffectDatabase($1).pipe(Effect.provide($2)));",
	);
	transformed = transformed.replace(
		/const (\w+) = await Effect\.runPromise\(\s*createPersistentEffectDatabase\(([\s\S]*?)\)\.pipe\(Effect\.provide\((\w+)\),\s*Effect\.scoped\),\s*\);/g,
		"const $1 = await openPersistentDatabase(createPersistentEffectDatabase($2).pipe(Effect.provide($3)));",
	);

	if (fileName === "append-only.test.ts") {
		transformed = transformed.replace(
			/const db = await Effect\.runPromise\(\s*createPersistentEffectDatabase\(config,([\s\S]*?)\)\.pipe\(Effect\.provide\(layer\), Effect\.scoped\),\s*\);/g,
			"const db = await openPersistentDatabase(createPersistentEffectDatabase(config,$1).pipe(Effect.provide(layer)));",
		);
		transformed = transformed.replace(
			`const db = await Effect.runPromise(\n\t\t\t\tcreatePersistentEffectDatabase(config, { events: [] }).pipe(\n\t\t\t\t\tEffect.provide(layer),\n\t\t\t\t\tEffect.scoped,\n\t\t\t\t),\n\t\t\t);`,
			`const db = await openPersistentDatabase(createPersistentEffectDatabase(config, { events: [] }).pipe(Effect.provide(layer)));`,
		);
		transformed = transformed.replace(
			/const db = await Effect\.runPromise\(\s*createPersistentEffectDatabase\(config, \{ events: \[\] \}\)\.pipe\(Effect\.provide\(layer\)\)\);/g,
			"const db = await openPersistentDatabase(createPersistentEffectDatabase(config, { events: [] }).pipe(Effect.provide(layer)));",
		);
	}
	if (fileName === "lenient-validation.test.ts") {
		transformed = transformed.replace(
			/const db = await Effect\.runPromise\(\s*createPersistentEffectDatabase\(config\)\.pipe\(\s*Effect\.provide\(layer\),\s*Effect\.scoped,\s*\),\s*\);/g,
			"const db = await openPersistentDatabase(createPersistentEffectDatabase(config).pipe(Effect.provide(layer)));",
		);
	}
	if (fileName === "plugin-system.test.ts") {
		transformed = transformed.replace(
			/const (db\d*) = await Effect\.runPromise\(\s*Effect\.provide\(\s*Effect\.scoped\(\s*Effect\.gen\(function\* \(\) \{\s*const database = yield\* createPersistentEffectDatabase\(([\s\S]*?)\);\s*return database;\s*\}\),\s*\),\s*baseLayer,\s*\),\s*\);/g,
			"const $1 = await openPersistentDatabase(Effect.provide(createPersistentEffectDatabase($2), baseLayer));",
		);
		transformed = transformed.replace(
			`const db = await Effect.runPromise(\n\t\t\t\tEffect.provide(\n\t\t\t\t\tEffect.scoped(\n\t\t\t\t\t\tEffect.gen(function* () {\n\t\t\t\t\t\t\tconst database = yield* createPersistentEffectDatabase(\n\t\t\t\t\t\t\t\tpersistentConfig,\n\t\t\t\t\t\t\t\tpersistentInitialData,\n\t\t\t\t\t\t\t\t{ writeDebounce: 10 },\n\t\t\t\t\t\t\t\t{ plugins: [csvPlugin] },\n\t\t\t\t\t\t\t);\n\t\t\t\t\t\t\treturn database;\n\t\t\t\t\t\t}),\n\t\t\t\t\t),\n\t\t\t\t\tbaseLayer,\n\t\t\t\t),\n\t\t\t);`,
			`const db = await openPersistentDatabase(Effect.provide(createPersistentEffectDatabase(\n\t\t\t\tpersistentConfig,\n\t\t\t\tpersistentInitialData,\n\t\t\t\t{ writeDebounce: 10 },\n\t\t\t\t{ plugins: [csvPlugin] },\n\t\t\t), baseLayer));`,
		);
		transformed = transformed.replace(
			`const db2 = await Effect.runPromise(\n\t\t\t\tEffect.provide(\n\t\t\t\t\tEffect.scoped(\n\t\t\t\t\t\tEffect.gen(function* () {\n\t\t\t\t\t\t\t// Don't provide initial data - load from file\n\t\t\t\t\t\t\tconst database = yield* createPersistentEffectDatabase(\n\t\t\t\t\t\t\t\tpersistentConfig,\n\t\t\t\t\t\t\t\t{}, // No initial data - load from CSV file\n\t\t\t\t\t\t\t\t{ writeDebounce: 10 },\n\t\t\t\t\t\t\t\t{ plugins: [csvPlugin] },\n\t\t\t\t\t\t\t);\n\t\t\t\t\t\t\treturn database;\n\t\t\t\t\t\t}),\n\t\t\t\t\t),\n\t\t\t\t\tbaseLayer,\n\t\t\t\t),\n\t\t\t);`,
			`const db2 = await openPersistentDatabase(Effect.provide(createPersistentEffectDatabase(\n\t\t\t\tpersistentConfig,\n\t\t\t\t{}, // No initial data - load from CSV file\n\t\t\t\t{ writeDebounce: 10 },\n\t\t\t\t{ plugins: [csvPlugin] },\n\t\t\t), baseLayer));`,
		);
	}

	if (transformed.includes("openPersistentDatabase(")) {
		transformed = transformed.replace(
			/import \{([^}]*)\} from "effect";/,
			(_match, imports) => `import {${ensureNamedImport(imports, ["Exit", "Scope"])} } from "effect";`,
		);
		transformed = transformed.replace(
			/import \{([^}]*)\} from "vitest";/,
			(_match, imports) => `import {${ensureNamedImport(imports, ["afterAll"])} } from "vitest";`,
		);
		transformed = `${transformed}\n\nconst persistentDatabaseScopes = new Set();\n\nconst openPersistentDatabase = async (effect) => {\n\tconst scope = await Effect.runPromise(Scope.make());\n\ttry {\n\t\tconst db = await Effect.runPromise(Scope.provide(effect, scope));\n\t\tpersistentDatabaseScopes.add(scope);\n\t\treturn db;\n\t} catch (error) {\n\t\tawait Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);\n\t\tthrow error;\n\t}\n};\n\nafterAll(async () => {\n\tfor (const scope of persistentDatabaseScopes) {\n\t\tawait Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);\n\t}\n\tpersistentDatabaseScopes.clear();\n});\n`;
	}

	return transformed;
}

function ensureNamedImport(imports, required) {
	const names = imports
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	for (const name of required) {
		if (!names.includes(name)) names.push(name);
	}
	return ` ${names.join(", ")} `;
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
