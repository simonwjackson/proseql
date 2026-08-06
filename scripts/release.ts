#!/usr/bin/env -S nix develop .#tooling --command bun

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	COORDINATED_PACKAGE_NAMES,
	createPreparedRelease,
	type PreparedArtifact,
	type PreparedRelease,
	type ReleasePackageManifest,
} from "./release-manifest.js";

export type BumpType = "patch" | "minor" | "major";

export type ReleaseCommit = {
	readonly hash: string;
	readonly subject: string;
	readonly body?: string;
};

export type GitHistory = {
	readonly commit: string;
	readonly commits: ReadonlyArray<ReleaseCommit>;
};

export type ReleaseVersionPreparationServices = {
	readonly readWorkspace: () => Promise<ReadonlyMap<string, string>>;
	readonly writeWorkspace: (
		files: ReadonlyMap<string, string>,
	) => Promise<void>;
	readonly readGitHistory: () => Promise<GitHistory>;
	readonly now: () => Date;
};

export type ReleaseFinalizationServices = {
	readonly readWorkspace: () => Promise<ReadonlyMap<string, string>>;
	readonly readGitHistory: () => Promise<GitHistory>;
	readonly assertCleanTree: () => Promise<void>;
	readonly checkVersionAvailable: (
		name: string,
		version: string,
	) => Promise<void>;
	readonly runPreflight: () => Promise<void>;
	readonly prepareArtifacts: (
		version: string,
	) => Promise<ReadonlyArray<PreparedArtifact>>;
	readonly writePreparedRelease: (release: PreparedRelease) => Promise<void>;
	readonly now: () => Date;
};

export type PreparedVersion = {
	readonly version: string;
	readonly date: string;
};

export function computeBumpType(
	subjects: ReadonlyArray<string>,
	bodies: string,
): BumpType {
	if (
		subjects.some((subject) => /^[a-z]+(?:\([^)]*\))?!:/.test(subject)) ||
		/^BREAKING CHANGE[:\s]/m.test(bodies)
	) {
		return "major";
	}
	return subjects.some((subject) => subject.startsWith("feat"))
		? "minor"
		: "patch";
}

export function incrementVersion(version: string, bump: BumpType): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid current version ${version}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

export function updateWorkspaceForRelease(input: {
	readonly files: ReadonlyMap<string, string>;
	readonly nextVersion: string;
	readonly date: string;
	readonly commits: ReadonlyArray<ReleaseCommit>;
}): ReadonlyMap<string, string> {
	const updated = new Map(input.files);
	for (const packageName of COORDINATED_PACKAGE_NAMES) {
		const path = `packages/${packageName}/package.json`;
		const source = requiredFile(input.files, path);
		const manifest = parseObject(source, path);
		manifest.version = input.nextVersion;
		updated.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	const lockPath = "bun.lock";
	let lock = requiredFile(input.files, lockPath);
	for (const packageName of COORDINATED_PACKAGE_NAMES) {
		const pattern = new RegExp(
			`("packages/${packageName}":\\s*\\{[\\s\\S]*?"name":\\s*"@proseql/${packageName}",\\s*"version":\\s*")[^"]+(")`,
		);
		assert(
			pattern.test(lock),
			`${lockPath}: missing ${packageName} workspace version`,
		);
		lock = lock.replace(pattern, `$1${input.nextVersion}$2`);
	}
	updated.set(lockPath, lock);

	const aiPath = "packages/ai/package.json";
	const aiSource = requiredFile(input.files, aiPath);
	const aiVersion = parseObject(aiSource, aiPath).version;
	assert(
		typeof aiVersion === "string",
		"packages/ai/package.json is missing its independent version",
	);
	updated.set(aiPath, aiSource);

	const cliPath = "packages/cli/src/main.ts";
	const cliSource = requiredFile(input.files, cliPath);
	const cliVersionPattern = /const VERSION = "[^"]+";/;
	assert(
		cliVersionPattern.test(cliSource),
		`${cliPath}: VERSION constant missing`,
	);
	updated.set(
		cliPath,
		cliSource.replace(
			cliVersionPattern,
			`const VERSION = "${input.nextVersion}";`,
		),
	);

	const changelogPath = "CHANGELOG.md";
	const changelog = requiredFile(input.files, changelogPath);
	const entry = createChangelogEntry(
		input.nextVersion,
		input.date,
		input.commits,
	);
	updated.set(
		changelogPath,
		changelog.startsWith("# Changelog\n")
			? `# Changelog\n\n${entry}\n${changelog.slice("# Changelog\n".length).replace(/^\n+/, "")}`
			: `# Changelog\n\n${entry}\n${changelog}`,
	);
	return updated;
}

export async function prepareReleaseVersion(
	options: { readonly bump?: BumpType },
	services: ReleaseVersionPreparationServices,
): Promise<PreparedVersion> {
	const [files, history] = await Promise.all([
		services.readWorkspace(),
		services.readGitHistory(),
	]);
	const currentVersion = coordinatedWorkspaceVersion(files, false);
	const commits = history.commits.filter(
		({ subject }) => !subject.startsWith("chore: release"),
	);
	const bump =
		options.bump ??
		computeBumpType(
			commits.map(({ subject }) => subject),
			commits.map(({ body }) => body ?? "").join("\n"),
		);
	const nextVersion = incrementVersion(currentVersion, bump);
	const date = services.now().toISOString().slice(0, 10);
	const updated = updateWorkspaceForRelease({
		files,
		nextVersion,
		date,
		commits,
	});
	try {
		await services.writeWorkspace(updated);
	} catch (writeError) {
		try {
			await services.writeWorkspace(files);
		} catch (rollbackError) {
			throw new AggregateError(
				[writeError, rollbackError],
				"release version preparation failed and source rollback also failed",
			);
		}
		throw writeError;
	}
	return { version: nextVersion, date };
}

export async function finalizeRelease(
	services: ReleaseFinalizationServices,
): Promise<PreparedRelease> {
	await services.assertCleanTree();
	const [files, history] = await Promise.all([
		services.readWorkspace(),
		services.readGitHistory(),
	]);
	const version = coordinatedWorkspaceVersion(files, true);
	for (const packageName of COORDINATED_PACKAGE_NAMES) {
		await services.checkVersionAvailable(`@proseql/${packageName}`, version);
	}
	await services.runPreflight();
	await services.assertCleanTree();
	const postflightHistory = await services.readGitHistory();
	assert(
		postflightHistory.commit === history.commit,
		`HEAD changed during finalization from ${history.commit} to ${postflightHistory.commit}`,
	);
	const artifacts = await services.prepareArtifacts(version);
	await services.assertCleanTree();
	const finalHistory = await services.readGitHistory();
	assert(
		finalHistory.commit === history.commit,
		`HEAD changed while copying release artifacts from ${history.commit} to ${finalHistory.commit}`,
	);
	const release = createPreparedRelease({
		version,
		commit: finalHistory.commit,
		preparedAt: services.now().toISOString(),
		artifacts,
	});
	await services.writePreparedRelease(release);
	return release;
}

function coordinatedWorkspaceVersion(
	files: ReadonlyMap<string, string>,
	requireReleaseEntry: boolean,
): string {
	let coordinatedVersion: string | undefined;
	for (const packageName of COORDINATED_PACKAGE_NAMES) {
		const path = `packages/${packageName}/package.json`;
		const version = parseObject(requiredFile(files, path), path).version;
		assert(typeof version === "string", `${path}: version is missing`);
		assert(
			/^\d+\.\d+\.\d+$/.test(version),
			`${path}: invalid version ${version}`,
		);
		coordinatedVersion ??= version;
		assert(
			version === coordinatedVersion,
			`${path}: version ${version} does not match coordinated version ${coordinatedVersion}`,
		);
	}
	assert(
		coordinatedVersion !== undefined,
		"coordinated release has no packages",
	);
	const cliPath = "packages/cli/src/main.ts";
	assert(
		requiredFile(files, cliPath).includes(
			`const VERSION = "${coordinatedVersion}";`,
		),
		`${cliPath}: VERSION must be ${coordinatedVersion}`,
	);
	const lock = requiredFile(files, "bun.lock");
	for (const packageName of COORDINATED_PACKAGE_NAMES) {
		const pattern = new RegExp(
			`"packages/${packageName}":\\s*\\{[\\s\\S]*?"name":\\s*"@proseql/${packageName}",\\s*"version":\\s*"${escapeRegExp(coordinatedVersion)}"`,
		);
		assert(
			pattern.test(lock),
			`bun.lock: ${packageName} workspace version must be ${coordinatedVersion}`,
		);
	}
	if (requireReleaseEntry) {
		assert(
			requiredFile(files, "CHANGELOG.md").includes(
				`## v${coordinatedVersion} (`,
			),
			`CHANGELOG.md: missing v${coordinatedVersion} release entry`,
		);
	}
	return coordinatedVersion;
}

function createChangelogEntry(
	version: string,
	date: string,
	commits: ReadonlyArray<ReleaseCommit>,
): string {
	const sections = new Map<string, string[]>([
		["Features", []],
		["Fixes", []],
		["Other", []],
	]);
	for (const { hash, subject } of commits) {
		const section = subject.startsWith("feat")
			? "Features"
			: subject.startsWith("fix")
				? "Fixes"
				: "Other";
		const clean = subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, "");
		sections.get(section)?.push(`- ${capitalize(clean)} (${hash.slice(0, 7)})`);
	}
	const content = [...sections]
		.filter(([, lines]) => lines.length > 0)
		.map(([heading, lines]) => `\n### ${heading}\n${lines.join("\n")}\n`)
		.join("");
	return `## v${version} (${date})\n${content}`;
}

function createDefaultServices(
	root: string,
): ReleaseVersionPreparationServices & ReleaseFinalizationServices {
	const workspacePaths = [
		...COORDINATED_PACKAGE_NAMES.map(
			(packageName) => `packages/${packageName}/package.json`,
		),
		"packages/ai/package.json",
		"packages/cli/src/main.ts",
		"bun.lock",
		"CHANGELOG.md",
	];
	return {
		readWorkspace: async () =>
			new Map(
				workspacePaths.map((path) => [
					path,
					readFileSync(join(root, path), "utf8"),
				]),
			),
		writeWorkspace: async (files) => {
			for (const path of workspacePaths) {
				writeFileSync(join(root, path), requiredFile(files, path));
			}
		},
		readGitHistory: async () => readGitHistory(root),
		assertCleanTree: async () => assertCleanTree(root),
		checkVersionAvailable: async (name, version) =>
			checkNpmVersionAvailable(root, name, version),
		runPreflight: async () => {
			execFileSync("just", ["release-check"], { cwd: root, stdio: "inherit" });
		},
		prepareArtifacts: async (version) => prepareArtifacts(root, version),
		writePreparedRelease: async (release) => {
			const path = join(root, ".artifacts/release/prepared-release.json");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`);
		},
		now: () => new Date(),
	};
}

function readGitHistory(root: string): GitHistory {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const tagResult = spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
		cwd: root,
		encoding: "utf8",
	});
	const range =
		tagResult.status === 0 ? `${tagResult.stdout.trim()}..HEAD` : "HEAD";
	const output = execFileSync(
		"git",
		["log", "--format=%H%x1f%s%x1f%b%x1e", range],
		{ cwd: root, encoding: "utf8" },
	);
	const commits = output
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash = "", subject = "", body = ""] = record.split("\x1f");
			return { hash, subject, body };
		});
	return { commit, commits };
}

function assertCleanTree(root: string): void {
	const status = execFileSync(
		"git",
		["status", "--porcelain", "--untracked-files=all"],
		{ cwd: root, encoding: "utf8" },
	).trim();
	assert(
		status.length === 0,
		`release finalization requires a clean tree; commit or revert:\n${status}`,
	);
}

function checkNpmVersionAvailable(
	root: string,
	name: string,
	version: string,
): void {
	const result = spawnSync(
		"npm",
		["view", `${name}@${version}`, "version", "--json"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
			killSignal: "SIGTERM",
		},
	);
	if (result.error) {
		throw new Error(
			`could not prove ${name}@${version} is available within 30000ms: ${result.error.message}`,
		);
	}
	if (result.status === 0) {
		throw new Error(`${name}@${version} already exists in the registry`);
	}
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (/E404|404 Not Found|code E404/i.test(output)) return;
	throw new Error(
		`could not prove ${name}@${version} is available: ${output.trim()}`,
	);
}

function prepareArtifacts(
	root: string,
	version: string,
): ReadonlyArray<PreparedArtifact> {
	const preflight = join(root, ".artifacts/release-check");
	const output = join(root, ".artifacts/release");
	const outputTarballs = join(output, "tarballs");
	rmSync(output, { recursive: true, force: true });
	mkdirSync(outputTarballs, { recursive: true });
	return COORDINATED_PACKAGE_NAMES.map((packageName) => {
		const filename = `proseql-${packageName}-${version}.tgz`;
		const sourceTarball = join(preflight, "tarballs", filename);
		assert(existsSync(sourceTarball), `preflight did not produce ${filename}`);
		const destinationTarball = join(outputTarballs, filename);
		copyFileSync(sourceTarball, destinationTarball);
		const bytes = readFileSync(destinationTarball);
		const manifestPath = join(
			preflight,
			"extracted",
			packageName,
			"package.json",
		);
		assert(
			existsSync(manifestPath),
			`preflight did not inspect ${packageName}`,
		);
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		) as ReleasePackageManifest;
		return {
			packageName,
			name: `@proseql/${packageName}`,
			version,
			tarball: relative(output, destinationTarball),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			sizeBytes: bytes.byteLength,
			manifest,
		};
	});
}

function requiredFile(
	files: ReadonlyMap<string, string>,
	path: string,
): string {
	const content = files.get(path);
	assert(content !== undefined, `missing release file ${path}`);
	return content;
}

function parseObject(source: string, path: string): Record<string, unknown> {
	const value = JSON.parse(source) as unknown;
	assert(
		typeof value === "object" && value !== null && !Array.isArray(value),
		`${path} must contain a JSON object`,
	);
	return value as Record<string, unknown>;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function parseCli(
	args: ReadonlyArray<string>,
):
	| { readonly stage: "prepare"; readonly bump?: BumpType }
	| { readonly stage: "finalize" } {
	const [stage, bump, ...rest] = args;
	if (stage === "finalize" && bump === undefined && rest.length === 0) {
		return { stage };
	}
	if (
		stage === "prepare" &&
		rest.length === 0 &&
		(bump === undefined || ["patch", "minor", "major"].includes(bump))
	) {
		return { stage, bump: bump as BumpType | undefined };
	}
	throw new Error(
		"Usage: bun run scripts/release.ts prepare [patch|minor|major] | finalize",
	);
}

if (import.meta.main) {
	const root = resolve(dirname(import.meta.path), "..");
	try {
		const cli = parseCli(process.argv.slice(2));
		const services = createDefaultServices(root);
		if (cli.stage === "prepare") {
			const prepared = await prepareReleaseVersion(
				{ bump: cli.bump },
				services,
			);
			console.log(
				`Prepared source edits for coordinated release ${prepared.version}.`,
			);
			console.log(
				"Review and commit the version, lockfile, CLI, and changelog edits before finalization.",
			);
		} else {
			const release = await finalizeRelease(services);
			console.log(`Finalized @proseql coordinated release ${release.version}`);
			console.log(
				`Manifest: ${join(root, ".artifacts/release/prepared-release.json")}`,
			);
			console.log(`Approval id: ${release.releaseId}`);
		}
		console.log(
			"No commit, push, tag, GitHub release, or npm registry write was performed.",
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
