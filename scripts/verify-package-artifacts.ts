#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type PackageJson = {
	name?: string;
	main?: string;
	types?: string;
	bin?: string | Record<string, string>;
	files?: string[];
};

type PackFile = { path: string };
type PackResult = { files: PackFile[] };

const root = join(import.meta.dirname, "..");
const packageNames = ["core", "engine", "effect", "node", "rest", "cli"];

let failed = false;

for (const packageName of packageNames) {
	const packageDir = join(root, "packages", packageName);
	const packageJsonPath = join(packageDir, "package.json");

	if (!existsSync(packageJsonPath)) continue;

	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf-8"),
	) as PackageJson;
	const displayName = packageJson.name ?? `packages/${packageName}`;
	const requiredArtifacts = requiredPackageArtifacts(packageJson);

	if (requiredArtifacts.length === 0) {
		console.log(`✓ ${displayName}: no built package artifacts declared`);
		continue;
	}

	let packageFailed = false;
	const missingOnDisk = requiredArtifacts.filter(
		(artifact) => !existsSync(join(packageDir, artifact)),
	);
	if (missingOnDisk.length > 0) {
		failed = true;
		packageFailed = true;
		console.error(
			`✗ ${displayName}: missing required built files on disk: ${missingOnDisk.join(", ")}`,
		);
		continue;
	}

	const packFiles = dryRunPack(packageDir).files.map((file) => file.path);
	const packedFileSet = new Set(packFiles);
	const missingFromPack = requiredArtifacts.filter(
		(artifact) => !packedFileSet.has(artifact),
	);

	if (missingFromPack.length > 0) {
		failed = true;
		packageFailed = true;
		console.error(
			`✗ ${displayName}: npm package would omit required files: ${missingFromPack.join(", ")}`,
		);
		continue;
	}

	const binTargets = normalizeBinTargets(packageJson.bin);
	for (const binTarget of binTargets) {
		const mode = statSync(join(packageDir, binTarget)).mode;
		if ((mode & 0o111) === 0) {
			failed = true;
			packageFailed = true;
			console.error(
				`✗ ${displayName}: bin target is not executable: ${binTarget}`,
			);
		}
	}

	if (!packageFailed) {
		console.log(`✓ ${displayName}: package artifacts verified`);
	}
}

if (failed) process.exit(1);

function requiredPackageArtifacts(packageJson: PackageJson): string[] {
	const required = new Set<string>();

	if (packageJson.files?.includes("dist")) {
		if (packageJson.main) required.add(packageJson.main);
		if (packageJson.types) required.add(packageJson.types);
	}

	for (const binTarget of normalizeBinTargets(packageJson.bin)) {
		required.add(binTarget);
	}

	return [...required];
}

function normalizeBinTargets(bin: PackageJson["bin"]): string[] {
	if (!bin) return [];
	if (typeof bin === "string") return [bin];
	return Object.values(bin);
}

function dryRunPack(packageDir: string): PackResult {
	const output = runPackCommand(packageDir);


	const parsed = JSON.parse(output) as PackResult[];
	const result = parsed[0];
	if (!result) {
		throw new Error(
			`npm pack --dry-run produced no package result for ${packageDir}`,
		);
	}

	return result;
}

function runPackCommand(packageDir: string): string {
	try {
		return execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: packageDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (!isMissingExecutable(error)) throw error;
		return execFileSync(
			"nix",
			["shell", "nixpkgs#nodejs", "-c", "npm", "pack", "--dry-run", "--json"],
			{
				cwd: packageDir,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	}
}

function isMissingExecutable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
