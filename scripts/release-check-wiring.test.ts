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

	it("builds and coordinates the AI package at 1.0.0", () => {
		const config = JSON.parse(readRootFile("tsconfig.json")) as {
			readonly references: ReadonlyArray<{ readonly path: string }>;
		};
		expect(config.references.map(({ path }) => path)).toContain(
			"./packages/ai",
		);
		const manifest = JSON.parse(readRootFile("packages/ai/package.json")) as {
			readonly version: string;
		};
		expect(manifest.version).toBe("1.0.0");
		expect(readRootFile("scripts/release-manifest.ts")).toContain('"ai"');
	});

	it("pins the compiler and never delegates TypeScript selection to bunx", () => {
		const manifest = JSON.parse(readRootFile("package.json")) as {
			readonly devDependencies: Readonly<Record<string, string>>;
		};
		expect(manifest.devDependencies.typescript).toBe("7.0.2");
		for (const path of [
			"package.json",
			"flake.nix",
			"scripts/verify-packed-packages.ts",
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
		const flake = readRootFile("flake.nix");
		for (const path of [
			"packages/core/tests/",
			"packages/engine/tests/",
			"packages/effect/tests/",
			"packages/browser/tests/",
			"packages/rpc/tests/",
			"./scripts/",
		])
			expect(flake).toContain(path);
		expect(flake).not.toContain("run-corpus.mjs");
		expect(flake).toContain("packages/core/tsconfig.tests.json");
	});

	it("builds WASM before running every engine-backed integration suite", () => {
		const flake = readRootFile("flake.nix");
		const start = flake.indexOf("task_test() {");
		const end = flake.indexOf("\n            }", start);
		const task = flake.slice(start, end);
		expect(
			task.indexOf("bun run --cwd packages/engine build:wasm"),
		).toBeLessThan(task.indexOf("bun test"));
		for (const name of ["node", "cli", "rest", "ai"]) {
			expect(task).toContain(`packages/${name}/tests/`);
			expect(flake).toContain(
				`task_test_${name}() { bun run --cwd packages/engine build:wasm; bun test packages/${name}/tests/`,
			);
		}
		expect(readRootFile(".github/workflows/ci.yml")).toContain(
			"run: nix run .#test",
		);
	});

	it("bounds Rust test concurrency while preserving explicit overrides", () => {
		const flake = readRootFile("flake.nix");
		// flake.nix escapes shell `${` as `''${` inside Nix strings.
		const boundedRustTest =
			`CARGO_BUILD_JOBS="''$` +
			`{CARGO_BUILD_JOBS:-1}" RUST_TEST_THREADS="''$` +
			`{RUST_TEST_THREADS:-1}" cargo test --manifest-path crates/Cargo.toml`;
		expect(flake).toContain(boundedRustTest);
	});

	it("composes the clean release gate without destructive release commands", () => {
		const flake = readRootFile("flake.nix");
		const start = flake.indexOf("task_release_check() {");
		expect(start).toBeGreaterThan(-1);
		// Keep the newline before the closing brace so every call ends in "\n".
		const end = flake.indexOf("\n            }\n", start);
		expect(end).toBeGreaterThan(start);
		const releaseCheck = flake.slice(start, end + 1);
		for (const required of [
			"bun install --frozen-lockfile --ignore-scripts",
			"task_build_release_artifacts\n",
			"task_test\n",
			"task_rust_format_check\n",
			"task_rust_check\n",
			"task_rust_test\n",
			"task_rust_lint\n",
			"task_rust_wasm_check\n",
			"task_parity_gate\n",
			"verify-packed-packages.ts --skip-build",
			"task_browser_smoke\n",
			"task_browser_budget\n",
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
		expect(workflow).not.toContain("corpus-report.json");
		expect(workflow).toContain("nix run .#parity-gate");
		expect(workflow).toContain("packages/engine/build/wasm-build-report.json");
		expect(workflow).toContain(".artifacts/packages/tarballs/*.tgz");
		expect(workflow).toContain("nix run .#browser-budget");
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
