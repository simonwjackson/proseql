#!/usr/bin/env -S nix develop .#tooling --command node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proseqlModules = join(repoRoot, "node_modules", "@proseql");
const packageNames = [
	"core",
	"effect",
	"engine",
	"browser",
	"node",
	"rest",
	"cli",
];

mkdirSync(proseqlModules, { recursive: true });
for (const packageName of packageNames) {
	const packageDirectory = join(repoRoot, "packages", packageName);
	const modulePath = join(proseqlModules, packageName);
	if (existsSync(modulePath) || isSymbolicLink(modulePath)) {
		rmSync(modulePath, { recursive: true, force: true });
	}
	symlinkSync(relative(proseqlModules, packageDirectory), modulePath, "dir");
}

const smokeScript = join(
	repoRoot,
	"packages",
	"browser",
	"tests",
	"browser-smoke.mjs",
);
const inPinnedShell =
	process.env.PROSEQL_NIX_TOOLING === "1" ||
	Boolean(process.env.CHROMIUM_EXECUTABLE_PATH);
const command = inPinnedShell
	? [process.execPath, smokeScript]
	: ["nix", "develop", `${repoRoot}#tooling`, "--command", "node", smokeScript];
const result = spawnSync(command[0], command.slice(1), {
	cwd: repoRoot,
	stdio: "inherit",
	env: process.env,
});
if (result.error) {
	throw result.error;
}
process.exit(result.status ?? 1);

function isSymbolicLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
