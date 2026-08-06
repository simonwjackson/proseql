#!/usr/bin/env -S nix develop .#tooling --command bun

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	createPreparedRelease,
	manifestContractDiff,
	manifestsMatch,
	type PreparedArtifact,
	type PreparedRelease,
	type ReleasePackageManifest,
} from "./release-manifest.js";
import { inspectAndExtractTarball } from "./verify-packed-packages.js";

export type CommandResult = {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type CommandRunner = (
	command: string,
	args: ReadonlyArray<string>,
) => Promise<CommandResult>;

export type RegistryVersion = {
	readonly manifest: ReleasePackageManifest;
	readonly integrity: string;
};

export interface Registry {
	verifyPreparedArtifacts(release: PreparedRelease): Promise<void>;
	authenticate(): Promise<string>;
	getVersion(
		name: string,
		version: string,
	): Promise<RegistryVersion | undefined>;
	publishCandidate(candidate: PreparedArtifact, tag: string): Promise<void>;
	getTag(name: string, tag: string): Promise<string | undefined>;
	setTag(name: string, version: string, tag: string): Promise<void>;
	removeTag(name: string, tag: string): Promise<void>;
}

export type ConsumerVerification = {
	readonly schemaVersion: 1;
	readonly releaseId: string;
	readonly version: string;
	readonly candidateTag: string;
	readonly verifiedAt: string;
	readonly artifacts: ReadonlyArray<{
		readonly name: string;
		readonly integrity: string;
	}>;
};

export type PublishOptions = {
	readonly mode: "dry-run" | "candidate" | "promote";
	readonly approval?: string;
	readonly consumerVerification?: ConsumerVerification;
	readonly visibility?: {
		readonly attempts: number;
		readonly delayMs: number;
	};
};

const defaultVisibility = { attempts: 12, delayMs: 5_000 } as const;

export class NpmRegistry implements Registry {
	constructor(
		private readonly run: CommandRunner,
		private readonly preparedRoot: string,
	) {}

	async verifyPreparedArtifacts(release: PreparedRelease): Promise<void> {
		const extractionParent = mkdtempSync(
			join(tmpdir(), "proseql-publish-inspect-"),
		);
		try {
			for (const candidate of release.artifacts) {
				const tarball = isAbsolute(candidate.tarball)
					? candidate.tarball
					: join(this.preparedRoot, candidate.tarball);
				const bytes = readFileSync(tarball);
				assert(
					bytes.byteLength === candidate.sizeBytes,
					`${candidate.name}: prepared tarball size mismatch`,
				);
				assert(
					createHash("sha256").update(bytes).digest("hex") === candidate.sha256,
					`${candidate.name}: prepared tarball sha256 mismatch`,
				);
				assert(
					`sha512-${createHash("sha512").update(bytes).digest("base64")}` ===
						candidate.integrity,
					`${candidate.name}: prepared tarball integrity mismatch`,
				);
				const extracted = join(extractionParent, candidate.packageName);
				inspectAndExtractTarball(tarball, extracted);
				const embedded = parseJsonObject(
					readFileSync(join(extracted, "package.json"), "utf8"),
					`${candidate.name} embedded package.json`,
				);
				assert(
					manifestsMatch(candidate.manifest, embedded),
					`${candidate.name}: embedded package.json does not match prepared manifest (${formatManifestDiff(candidate.manifest, embedded)})`,
				);
			}
		} finally {
			rmSync(extractionParent, { recursive: true, force: true });
		}
	}

	async authenticate(): Promise<string> {
		const result = await this.run("npm", ["whoami"]);
		assertCommand(result, "npm credential check failed");
		const identity = result.stdout.trim();
		assert(identity.length > 0, "npm credential check returned no identity");
		return identity;
	}

	async getVersion(
		name: string,
		version: string,
	): Promise<RegistryVersion | undefined> {
		const result = await this.run("npm", [
			"view",
			`${name}@${version}`,
			"--json",
		]);
		if (isNotFound(result)) return undefined;
		assertCommand(result, `could not read ${name}@${version}`);
		const value = parseJsonObject(result.stdout, `${name}@${version}`);
		const dist = value.dist;
		assert(
			typeof dist === "object" && dist !== null && !Array.isArray(dist),
			`${name}@${version}: registry response is missing dist metadata`,
		);
		const integrity = (dist as Readonly<Record<string, unknown>>).integrity;
		assert(
			typeof integrity === "string",
			`${name}@${version}: registry response is missing integrity`,
		);
		const { dist: _dist, ...manifest } = value;
		return { manifest, integrity };
	}

	async publishCandidate(
		candidate: PreparedArtifact,
		tag: string,
	): Promise<void> {
		const tarball = isAbsolute(candidate.tarball)
			? candidate.tarball
			: join(this.preparedRoot, candidate.tarball);
		const result = await this.run("npm", [
			"publish",
			tarball,
			"--ignore-scripts",
			"--access",
			"public",
			"--tag",
			tag,
		]);
		assertCommand(result, `candidate upload failed for ${candidate.name}`);
	}

	async getTag(name: string, tag: string): Promise<string | undefined> {
		const result = await this.run("npm", [
			"view",
			name,
			`dist-tags.${tag}`,
			"--json",
		]);
		if (isNotFound(result)) return undefined;
		assertCommand(result, `could not read ${name} dist-tag ${tag}`);
		const output = result.stdout.trim();
		if (output.length === 0) return undefined;
		const value = JSON.parse(output) as unknown;
		return typeof value === "string" ? value : undefined;
	}

	async setTag(name: string, version: string, tag: string): Promise<void> {
		const result = await this.run("npm", [
			"dist-tag",
			"add",
			`${name}@${version}`,
			tag,
		]);
		assertCommand(result, `could not set ${name} dist-tag ${tag}`);
	}

	async removeTag(name: string, tag: string): Promise<void> {
		const result = await this.run("npm", ["dist-tag", "rm", name, tag]);
		assertCommand(result, `could not remove ${name} dist-tag ${tag}`);
	}
}

export async function publishPackages(
	release: PreparedRelease,
	registry: Registry,
	options: PublishOptions,
): Promise<void> {
	validatePreparedRelease(release);
	const mode = options.mode as string;
	switch (mode) {
		case "dry-run":
		case "candidate":
		case "promote":
			break;
		default:
			throw new Error(`unknown publication mode ${JSON.stringify(mode)}`);
	}
	const visibility = options.visibility ?? defaultVisibility;
	assert(
		Number.isInteger(visibility.attempts) && visibility.attempts > 0,
		"registry visibility attempts must be positive",
	);
	assert(
		visibility.delayMs >= 0,
		"registry visibility delay must be non-negative",
	);

	if (mode === "dry-run") {
		for (const candidate of release.artifacts) {
			const live = await registry.getVersion(candidate.name, candidate.version);
			if (live) assertMatchingCandidate(candidate, live);
			await registry.getTag(candidate.name, release.candidateTag);
		}
		return;
	}

	assert(
		options.approval === release.releaseId,
		`destructive publication requires approval ${release.releaseId}`,
	);
	if (mode === "promote") {
		assertConsumerVerification(release, options.consumerVerification);
	} else {
		await registry.verifyPreparedArtifacts(release);
	}
	await registry.authenticate();

	if (mode === "candidate") {
		await publishCandidates(release, registry, visibility);
		return;
	}
	await promoteLatest(release, registry, visibility);
}

async function publishCandidates(
	release: PreparedRelease,
	registry: Registry,
	visibility: { readonly attempts: number; readonly delayMs: number },
): Promise<void> {
	for (const candidate of release.artifacts) {
		const live = await registry.getVersion(candidate.name, candidate.version);
		if (live) {
			assertMatchingCandidate(candidate, live);
			const tag = await registry.getTag(candidate.name, release.candidateTag);
			if (tag === candidate.version) continue;
			assert(
				tag === undefined,
				`${candidate.name}: candidate tag points to ${tag}, expected ${candidate.version}`,
			);
			await registry.setTag(
				candidate.name,
				candidate.version,
				release.candidateTag,
			);
		} else {
			await registry.publishCandidate(candidate, release.candidateTag);
		}
		await waitFor(
			async () => {
				const visible = await registry.getVersion(
					candidate.name,
					candidate.version,
				);
				if (!visible) return false;
				assertMatchingCandidate(candidate, visible);
				return (
					(await registry.getTag(candidate.name, release.candidateTag)) ===
					candidate.version
				);
			},
			visibility,
			`${candidate.name}@${candidate.version} candidate visibility`,
		);
	}
}

async function promoteLatest(
	release: PreparedRelease,
	registry: Registry,
	visibility: { readonly attempts: number; readonly delayMs: number },
): Promise<void> {
	for (const candidate of release.artifacts) {
		const live = await registry.getVersion(candidate.name, candidate.version);
		assert(
			live !== undefined,
			`${candidate.name}@${candidate.version} is missing; candidate set is incomplete`,
		);
		assertMatchingCandidate(candidate, live);
	}
	const latestBefore = new Map<string, string | undefined>();
	for (const candidate of release.artifacts) {
		latestBefore.set(
			candidate.name,
			await registry.getTag(candidate.name, "latest"),
		);
	}
	const allLatestAlreadyVerified = release.artifacts.every(
		(candidate) => latestBefore.get(candidate.name) === candidate.version,
	);
	for (const candidate of release.artifacts) {
		const candidateTag = await registry.getTag(
			candidate.name,
			release.candidateTag,
		);
		assert(
			candidateTag === candidate.version ||
				(allLatestAlreadyVerified && candidateTag === undefined),
			`${candidate.name}: candidate tag is missing or does not match ${candidate.version}`,
		);
	}

	for (const packageName of release.promotionOrder) {
		const candidate = requiredArtifact(release, packageName);
		if (
			(await registry.getTag(candidate.name, "latest")) === candidate.version
		) {
			continue;
		}
		await registry.setTag(candidate.name, candidate.version, "latest");
		await waitFor(
			async () =>
				(await registry.getTag(candidate.name, "latest")) === candidate.version,
			visibility,
			`${candidate.name} latest promotion`,
		);
	}

	for (const candidate of release.artifacts) {
		assert(
			(await registry.getTag(candidate.name, "latest")) === candidate.version,
			`${candidate.name}: latest did not verify at ${candidate.version}`,
		);
	}

	for (const candidate of release.artifacts) {
		const candidateTag = await registry.getTag(
			candidate.name,
			release.candidateTag,
		);
		if (candidateTag === undefined) continue;
		assert(
			candidateTag === candidate.version,
			`${candidate.name}: candidate tag changed before cleanup`,
		);
		await registry.removeTag(candidate.name, release.candidateTag);
		await waitFor(
			async () =>
				(await registry.getTag(candidate.name, release.candidateTag)) ===
				undefined,
			visibility,
			`${candidate.name} candidate tag removal`,
		);
	}
}

function assertConsumerVerification(
	release: PreparedRelease,
	verification: ConsumerVerification | undefined,
): void {
	assert(
		verification !== undefined,
		"latest promotion requires consumer verification",
	);
	assert(
		verification.schemaVersion === 1 &&
			verification.releaseId === release.releaseId &&
			verification.version === release.version &&
			verification.candidateTag === release.candidateTag,
		"consumer verification does not match the prepared release",
	);
	const expected = release.artifacts.map(({ name, integrity }) => ({
		name,
		integrity,
	}));
	assert(
		JSON.stringify(verification.artifacts) === JSON.stringify(expected),
		"consumer verification artifacts do not match the prepared release",
	);
	assert(
		!Number.isNaN(Date.parse(verification.verifiedAt)),
		"consumer verification timestamp is invalid",
	);
}

function assertMatchingCandidate(
	candidate: PreparedArtifact,
	live: RegistryVersion,
): void {
	const differences = manifestContractDiff(candidate.manifest, live.manifest);
	const integrityDifference =
		live.integrity === candidate.integrity
			? []
			: [
					`integrity: expected ${candidate.integrity}, actual ${live.integrity}`,
				];
	const allDifferences = [...integrityDifference, ...differences];
	assert(
		allDifferences.length === 0,
		`${candidate.name}@${candidate.version} does not match the prepared manifest and integrity (${allDifferences.slice(0, 4).join("; ")}); deprecate the bad version and prepare a new coordinated version`,
	);
}

function formatManifestDiff(
	expected: ReleasePackageManifest,
	actual: ReleasePackageManifest,
): string {
	return manifestContractDiff(expected, actual).slice(0, 4).join("; ");
}

function validatePreparedRelease(release: PreparedRelease): void {
	const rebuilt = createPreparedRelease({
		version: release.version,
		commit: release.commit,
		preparedAt: release.preparedAt,
		artifacts: release.artifacts,
	});
	assert(
		rebuilt.releaseId === release.releaseId &&
			rebuilt.candidateTag === release.candidateTag &&
			JSON.stringify(rebuilt.publishOrder) ===
				JSON.stringify(release.publishOrder) &&
			JSON.stringify(rebuilt.promotionOrder) ===
				JSON.stringify(release.promotionOrder),
		"prepared release manifest is inconsistent or has been modified",
	);
}

function requiredArtifact(
	release: PreparedRelease,
	packageName: string,
): PreparedArtifact {
	const artifact = release.artifacts.find(
		(candidate) => candidate.packageName === packageName,
	);
	assert(artifact !== undefined, `prepared release is missing ${packageName}`);
	return artifact;
}

async function waitFor(
	check: () => Promise<boolean>,
	options: { readonly attempts: number; readonly delayMs: number },
	description: string,
): Promise<void> {
	for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
		if (await check()) return;
		if (attempt < options.attempts && options.delayMs > 0) {
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, options.delayMs),
			);
		}
	}
	throw new Error(
		`${description} timed out after ${options.attempts} registry reads`,
	);
}

export function createCommandRunner(timeoutMs = 60_000): CommandRunner {
	assert(
		Number.isInteger(timeoutMs) && timeoutMs > 0,
		"command timeout must be positive",
	);
	return (command, args) =>
		new Promise((resolveCommand, rejectCommand) => {
			const child = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				stderr += `\ncommand timed out after ${timeoutMs}ms`;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				rejectCommand(error);
			});
			child.on("close", (status) => {
				clearTimeout(timeout);
				resolveCommand({
					status: timedOut ? 124 : (status ?? 1),
					stdout,
					stderr,
				});
			});
		});
}

const defaultCommandRunner = createCommandRunner();

export function loadPreparedRelease(path: string): PreparedRelease {
	const release = JSON.parse(readFileSync(path, "utf8")) as PreparedRelease;
	validatePreparedRelease(release);
	const root = dirname(path);
	for (const artifact of release.artifacts) {
		const tarball = isAbsolute(artifact.tarball)
			? artifact.tarball
			: join(root, artifact.tarball);
		const bytes = readFileSync(tarball);
		assert(
			createHash("sha256").update(bytes).digest("hex") === artifact.sha256,
			`${artifact.name}: prepared tarball sha256 mismatch`,
		);
		assert(
			`sha512-${createHash("sha512").update(bytes).digest("base64")}` ===
				artifact.integrity,
			`${artifact.name}: prepared tarball integrity mismatch`,
		);
	}
	return release;
}

function parseJsonObject(
	source: string,
	description: string,
): Record<string, unknown> {
	const value = JSON.parse(source) as unknown;
	assert(
		typeof value === "object" && value !== null && !Array.isArray(value),
		`${description}: expected a JSON object`,
	);
	return value as Record<string, unknown>;
}

function isNotFound(result: CommandResult): boolean {
	return (
		result.status !== 0 &&
		/E404|404 Not Found|code E404/i.test(`${result.stdout}\n${result.stderr}`)
	);
}

function assertCommand(result: CommandResult, description: string): void {
	if (result.status === 0) return;
	throw new Error(
		`${description}: ${`${result.stdout}\n${result.stderr}`.trim() || `exit ${result.status}`}`,
	);
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function parseCli(args: ReadonlyArray<string>): {
	readonly manifestPath: string;
	readonly mode: PublishOptions["mode"];
	readonly verificationPath?: string;
} {
	let manifestPath = ".artifacts/release/prepared-release.json";
	let mode: PublishOptions["mode"] = "dry-run";
	let verificationPath: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--manifest") {
			const value = args[index + 1];
			assert(value !== undefined, "--manifest requires a path");
			manifestPath = value;
			index += 1;
		} else if (argument === "--approve-candidate-upload") {
			assert(
				mode === "dry-run",
				"choose only one destructive publication mode",
			);
			mode = "candidate";
		} else if (argument === "--approve-latest-promotion") {
			assert(
				mode === "dry-run",
				"choose only one destructive publication mode",
			);
			mode = "promote";
		} else if (argument === "--consumer-verification") {
			const value = args[index + 1];
			assert(value !== undefined, "--consumer-verification requires a path");
			verificationPath = value;
			index += 1;
		} else {
			throw new Error(`unknown argument ${String(argument)}`);
		}
	}
	return { manifestPath: resolve(manifestPath), mode, verificationPath };
}

if (import.meta.main) {
	try {
		const cli = parseCli(process.argv.slice(2));
		const release = loadPreparedRelease(cli.manifestPath);
		const approval =
			cli.mode === "dry-run" ? undefined : process.env.PROSEQL_PUBLISH_APPROVAL;
		const consumerVerification = cli.verificationPath
			? (JSON.parse(
					readFileSync(resolve(cli.verificationPath), "utf8"),
				) as ConsumerVerification)
			: undefined;
		const registry = new NpmRegistry(
			defaultCommandRunner,
			dirname(cli.manifestPath),
		);
		await publishPackages(release, registry, {
			mode: cli.mode,
			approval,
			consumerVerification,
		});
		if (cli.mode === "dry-run") {
			console.log(
				`Dry run complete for ${release.version}; no credentials or registry writes were used.`,
			);
		} else {
			console.log(`${cli.mode} phase completed for ${release.version}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
