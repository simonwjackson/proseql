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

	it("runs first-release behavior and package contracts in the normal test gate", () => {
		const justfile = readRootFile("justfile");
		for (const path of [
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
		expect(workflow).not.toMatch(/(?:npm|bun) publish|git push|git tag/);
	});
});
