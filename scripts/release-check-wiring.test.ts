import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const readRootFile = (path: string): string =>
	readFileSync(resolve(root, path), "utf8");

describe("release readiness wiring", () => {
	it("keeps RPC in the root TypeScript build graph", () => {
		const config = JSON.parse(readRootFile("tsconfig.json")) as {
			readonly references: ReadonlyArray<{ readonly path: string }>;
		};
		expect(config.references.map(({ path }) => path)).toContain(
			"./packages/rpc",
		);
	});

	it("pins the compiler and never delegates TypeScript selection to bunx", () => {
		const manifest = JSON.parse(readRootFile("package.json")) as {
			readonly devDependencies: Readonly<Record<string, string>>;
		};
		expect(manifest.devDependencies.typescript).toBe("7.0.2");
		for (const path of [
			"package.json",
			"justfile",
			...[
				"ai",
				"browser",
				"cli",
				"core",
				"effect",
				"engine",
				"node",
				"rest",
				"rpc",
			].map((name) => `packages/${name}/package.json`),
		]) {
			expect(readRootFile(path)).not.toContain("bunx tsc");
		}
	});

	it("runs first-release behavior and package contracts in the normal test gate", () => {
		const justfile = readRootFile("justfile");
		for (const path of [
			"packages/engine/tests/boundary-values.test.ts",
			"packages/engine/tests/browser-entry.test.ts",
			"packages/engine/tests/browser-persistence-concurrency.test.ts",
			"packages/engine/tests/engine-u8.test.ts",
			"packages/engine/tests/engine.test.ts",
			"packages/engine/tests/loader.test.ts",
			"packages/engine/tests/materialized-projection.test.ts",
			"packages/effect/tests/effect.test.ts",
			"packages/browser/tests/browser-entry.test.ts",
			"packages/rpc/tests/rpc-group.test.ts",
			"packages/rpc/tests/rpc-handlers.test.ts",
			"packages/rpc/tests/rpc-streaming.test.ts",
			"scripts/verify-package-artifacts.test.ts",
			"scripts/verify-packed-packages.test.ts",
		]) {
			expect(justfile).toContain(path);
		}
	});

	it("composes the clean release gate without destructive release commands", () => {
		const justfile = readRootFile("justfile");
		const releaseCheck = justfile.slice(justfile.indexOf("release-check:"));
		for (const required of [
			"bun install --frozen-lockfile --ignore-scripts",
			"just build-release-artifacts",
			"just test",
			"just rust-format-check",
			"just rust-check",
			"just rust-test",
			"just rust-lint",
			"just rust-wasm-check",
			"just parity-gate",
			"verify-packed-packages.ts --skip-build",
			"just browser-smoke",
			"just browser-budget",
		]) {
			expect(releaseCheck).toContain(required);
		}
		for (const forbidden of [
			"npm publish",
			"bun publish",
			"git push",
			"git tag",
			"gh release",
		]) {
			expect(releaseCheck).not.toContain(forbidden);
		}
	});

	it("keeps CI evidence gates isolated and publication-free", () => {
		const workflow = readRootFile(".github/workflows/ci.yml");
		for (const job of [
			"quality:",
			"tests:",
			"rust:",
			"parity:",
			"wasm-packages:",
			"browser:",
		]) {
			expect(workflow).toContain(`  ${job}`);
		}
		expect(workflow).toContain("packages/effect/reports/corpus-report.json");
		expect(workflow).toContain("packages/engine/build/wasm-build-report.json");
		expect(workflow).toContain(".artifacts/packages/tarballs/*.tgz");
		expect(workflow).toContain("just browser-budget");
		expect(workflow).toContain(".artifacts/browser/current.json");
		expect(workflow).toContain(".artifacts/browser/evidence.json");
		expect(workflow).not.toMatch(
			/uses:\s+[^\n]+@(?![0-9a-f]{40}(?:\s+#|\s*$))/,
		);
		for (const job of [
			"quality",
			"tests",
			"rust",
			"parity",
			"wasm-packages",
			"browser",
		]) {
			const jobStart = workflow.indexOf(`  ${job}:`);
			const nextJobMatch = /\n {2}[a-z-]+:\n/g;
			nextJobMatch.lastIndex = jobStart + 3;
			const nextJob = nextJobMatch.exec(workflow)?.index ?? -1;
			const body = workflow.slice(jobStart, nextJob < 0 ? undefined : nextJob);
			expect(body).toMatch(/timeout-minutes:\s+\d+/);
		}
		expect(workflow).not.toMatch(/(?:npm|bun) publish|git push|git tag/);
	});
});
