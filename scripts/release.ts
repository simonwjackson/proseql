#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const explicitBump = process.argv[2] as "patch" | "minor" | "major" | undefined;
if (explicitBump && !["patch", "minor", "major"].includes(explicitBump)) {
	console.error(
		"Usage: bun run scripts/release.ts [patch|minor|major]\n       (omit argument to auto-detect from commits)",
	);
	process.exit(1);
}

// --- Read current version from core ---

const corePkgPath = join(root, "packages/core/package.json");
const corePkg = JSON.parse(readFileSync(corePkgPath, "utf-8"));
const current = corePkg.version as string;
const [currentMajor, currentMinor, currentPatch] = current
	.split(".")
	.map(Number);

// --- Find last version tag ---

let lastTag: string | null = null;
try {
	lastTag = execSync("git describe --tags --abbrev=0 2>/dev/null", {
		encoding: "utf-8",
		cwd: root,
	}).trim();
} catch {
	// No tags yet
}

const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const logCmd = `git log --oneline --no-decorate ${range}`;
const rawLog = execSync(logCmd, { encoding: "utf-8", cwd: root }).trim();
const commits = rawLog
	.split("\n")
	.filter((line) => line.length > 0)
	.filter((line) => !line.match(/^[a-f0-9]+ chore: release/));

const features: string[] = [];
const fixes: string[] = [];
const other: string[] = [];

let hasBreaking = false;
let hasFeature = false;

for (const line of commits) {
	const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
	if (!match) continue;
	const [, hash, message] = match;
	const short = hash.slice(0, 7);

	// Check for breaking change indicator in subject (e.g. "feat!:", "fix!:")
	if (message.match(/^[a-z]+(\([^)]*\))?!:/)) {
		hasBreaking = true;
	}

	if (message.startsWith("feat")) {
		hasFeature = true;
		const clean = message.replace(/^feat(\([^)]*\))?!?:\s*/, "");
		features.push(`- ${capitalize(clean)} (${short})`);
	} else if (message.startsWith("fix")) {
		const clean = message.replace(/^fix(\([^)]*\))?!?:\s*/, "");
		fixes.push(`- ${capitalize(clean)} (${short})`);
	} else {
		const clean = message.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "");
		other.push(`- ${capitalize(clean)} (${short})`);
	}
}

// Check full commit bodies for BREAKING CHANGE footer
if (!hasBreaking) {
	const fullLogCmd = `git log --format=%B ${range}`;
	const fullLog = execSync(fullLogCmd, {
		encoding: "utf-8",
		cwd: root,
	}).trim();
	if (fullLog.match(/^BREAKING CHANGE[:\s]/m)) {
		hasBreaking = true;
	}
}

// Determine bump type: explicit override > auto-detect
const bumpType: "patch" | "minor" | "major" = explicitBump
	? explicitBump
	: hasBreaking
		? "major"
		: hasFeature
			? "minor"
			: "patch";

if (explicitBump) {
	console.log(`Bump type: ${bumpType} (explicit)`);
} else {
	console.log(`Bump type: ${bumpType} (auto-detected from commits)`);
}

// --- Compute next version ---

const next =
	bumpType === "major"
		? `${currentMajor + 1}.0.0`
		: bumpType === "minor"
			? `${currentMajor}.${currentMinor + 1}.0`
			: `${currentMajor}.${currentMinor}.${currentPatch + 1}`;

console.log(`Bumping ${current} -> ${next}`);

// --- Update all package.json files ---

const packages = ["core", "node", "browser", "cli", "rest", "rpc"];
for (const pkg of packages) {
	const pkgPath = join(root, `packages/${pkg}/package.json`);
	const content = readFileSync(pkgPath, "utf-8");
	const json = JSON.parse(content);
	json.version = next;
	writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
	console.log(`  Updated packages/${pkg}/package.json`);
}

// --- Generate changelog ---

const today = new Date().toISOString().split("T")[0];
let entry = `## v${next} (${today})\n`;

if (features.length > 0) {
	entry += `\n### Features\n${features.join("\n")}\n`;
}
if (fixes.length > 0) {
	entry += `\n### Fixes\n${fixes.join("\n")}\n`;
}
if (other.length > 0) {
	entry += `\n### Other\n${other.join("\n")}\n`;
}

const changelogPath = join(root, "CHANGELOG.md");
let existing = "";
if (existsSync(changelogPath)) {
	existing = readFileSync(changelogPath, "utf-8");
}

if (existing.startsWith("# Changelog\n")) {
	// Insert after the header
	const rest = existing.slice("# Changelog\n".length);
	writeFileSync(changelogPath, `# Changelog\n\n${entry}\n${rest}`);
} else {
	writeFileSync(changelogPath, `# Changelog\n\n${entry}\n${existing}`);
}

console.log("  Updated CHANGELOG.md");

// --- Git commit and tag ---

const filesToStage = [
	"CHANGELOG.md",
	...packages.map((p) => `packages/${p}/package.json`),
];
execSync(`git add ${filesToStage.join(" ")}`, { cwd: root, stdio: "inherit" });
execSync(`git commit -m "chore: release v${next}"`, {
	cwd: root,
	stdio: "inherit",
});
execSync(`git tag v${next}`, { cwd: root, stdio: "inherit" });
execSync("git push && git push --tags", { cwd: root, stdio: "inherit" });

// --- Create GitHub Release ---
const notesFile = join(root, ".release-notes.tmp");
writeFileSync(notesFile, entry);
try {
	execSync(
		`gh release create v${next} --title "v${next}" --notes-file "${notesFile}"`,
		{ cwd: root, stdio: "inherit" },
	);
} finally {
	if (existsSync(notesFile)) unlinkSync(notesFile);
}

console.log(`\nReleased v${next}`);
console.log(`  Commit: chore: release v${next}`);
console.log(`  Tag: v${next}`);
console.log("  Pushed to origin");
console.log("  GitHub Release created");

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
