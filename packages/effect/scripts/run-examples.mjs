#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureBuiltEngineWasm,
	repoRootFromImportMetaUrl,
} from "./_parity-helpers.mjs";

const root = repoRootFromImportMetaUrl(import.meta.url);
ensureBuiltEngineWasm(root);
const examples = readdirSync(join(root, "examples"))
	.filter((name) => /^\d\d-/.test(name))
	.sort();
let failed = 0;
for (const name of examples) {
	const workspace = mkdtempSync(join(tmpdir(), "proseql-example-"));
	try {
		// Filesystem examples edit only disposable copies of their real fixture files.
		cpSync(join(root, "examples"), join(workspace, "examples"), {
			recursive: true,
		});
		const run = spawnSync(
			"bun",
			["run", join(root, "examples", name, "index.ts")],
			{ cwd: workspace, encoding: "utf8", timeout: 30000 },
		);
		if (run.status !== 0 || run.error) {
			failed++;
			console.error(run.error ?? run.stderr);
			console.error(run.stdout);
		}
		console.log(`${run.status === 0 ? "PASS" : "FAIL"} ${name}`);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}
console.log(`${examples.length - failed}/${examples.length} examples passed`);
if (failed) process.exitCode = 1;
