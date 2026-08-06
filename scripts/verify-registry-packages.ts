#!/usr/bin/env -S nix develop .#tooling --command bun

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type ConsumerVerification,
	createCommandRunner,
	loadPreparedRelease,
	NpmRegistry,
	type Registry,
} from "./publish-packages.js";
import {
	manifestContractDiff,
	type PreparedRelease,
} from "./release-manifest.js";
import {
	browserConsumerSource,
	browserRunnerSource,
	EFFECT_VERSION,
	nodeConsumerSmokeSource,
} from "./verify-packed-packages.js";

const registryTimeoutMs = 60_000;
const commandTimeoutMs = 10 * 60_000;

export async function verifyRegistryCandidates(
	release: PreparedRelease,
	registry: Pick<Registry, "getVersion" | "getLatestVersion">,
	now: () => Date = () => new Date(),
): Promise<ConsumerVerification> {
	for (const artifact of release.artifacts) {
		const live = await registry.getVersion(artifact.name, artifact.version);
		assert(
			live !== undefined,
			`${artifact.name}@${artifact.version} is missing`,
		);
		const differences = manifestContractDiff(artifact.manifest, live.manifest);
		assert(
			live.integrity === artifact.integrity && differences.length === 0,
			`${artifact.name}@${artifact.version} does not match prepared integrity and manifest`,
		);
		const latestVersion = await registry.getLatestVersion(artifact.name);
		assert(
			latestVersion === artifact.version,
			`${artifact.name} latest tag points to ${String(latestVersion)}, expected ${artifact.version}`,
		);
	}
	return {
		schemaVersion: 1,
		releaseId: release.releaseId,
		version: release.version,
		verifiedAt: now().toISOString(),
		artifacts: release.artifacts.map(({ name, integrity }) => ({
			name,
			integrity,
		})),
	};
}

export async function runRegistryConsumerVerification(options: {
	readonly manifestPath: string;
	readonly outputPath: string;
}): Promise<ConsumerVerification> {
	const release = loadPreparedRelease(resolve(options.manifestPath));
	const registry = new NpmRegistry(
		createCommandRunner(registryTimeoutMs),
		dirname(resolve(options.manifestPath)),
	);
	const verification = await verifyRegistryCandidates(release, registry);
	const root = mkdtempSync(join(tmpdir(), "proseql-registry-consumer-"));
	try {
		verifyNodeConsumer(release, root);
		verifyBrowserConsumer(release, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	mkdirSync(dirname(resolve(options.outputPath)), { recursive: true });
	writeFileSync(
		resolve(options.outputPath),
		`${JSON.stringify(verification, null, 2)}\n`,
	);
	return verification;
}

function verifyNodeConsumer(release: PreparedRelease, root: string): void {
	const consumer = createRegistryConsumer(
		join(root, "node"),
		release,
		release.artifacts.map(({ packageName }) => packageName),
	);
	installConsumer(consumer);
	writeFileSync(
		join(consumer, "smoke.mjs"),
		nodeConsumerSmokeSource(release.version),
	);
	run("node", ["smoke.mjs"], consumer);
	assertInstalledRelease(consumer, release);
	const effectInstallations = findInstalledEffectPackages(
		join(consumer, "node_modules"),
	);
	assert(
		effectInstallations.length === 1,
		`expected one Effect installation, found ${effectInstallations.join(", ")}`,
	);
	const effect = readJson(join(effectInstallations[0] ?? "", "package.json"));
	assert(
		effect.version === EFFECT_VERSION,
		`resolved Effect ${String(effect.version)} instead of ${EFFECT_VERSION}`,
	);
}

function verifyBrowserConsumer(release: PreparedRelease, root: string): void {
	const consumer = createRegistryConsumer(join(root, "browser"), release, [
		"core",
		"engine",
		"effect",
		"browser",
	]);
	const manifest = readJson(join(consumer, "package.json"));
	writeFileSync(
		join(consumer, "package.json"),
		`${JSON.stringify(
			{
				...manifest,
				devDependencies: { playwright: "1.55.0", vite: "5.4.20" },
			},
			null,
			2,
		)}\n`,
	);
	installConsumer(consumer);
	writeFileSync(
		join(consumer, "index.html"),
		'<link rel="icon" href="data:,"><div id="app"></div><script type="module" src="/main.js"></script>\n',
	);
	writeFileSync(join(consumer, "main.js"), browserConsumerSource());
	writeFileSync(join(consumer, "browser-smoke.mjs"), browserRunnerSource());
	run("node", ["browser-smoke.mjs"], consumer);
	assertInstalledRelease(consumer, release, [
		"core",
		"engine",
		"effect",
		"browser",
	]);
}

function createRegistryConsumer(
	directory: string,
	release: PreparedRelease,
	packageNames: ReadonlyArray<string>,
): string {
	mkdirSync(directory, { recursive: true });
	const dependencies: Record<string, string> = { effect: EFFECT_VERSION };
	for (const packageName of packageNames) {
		dependencies[`@proseql/${packageName}`] = release.version;
	}
	writeFileSync(
		join(directory, "package.json"),
		`${JSON.stringify(
			{
				name: "proseql-registry-consumer",
				private: true,
				type: "module",
				dependencies,
			},
			null,
			2,
		)}\n`,
	);
	return directory;
}

function installConsumer(directory: string): void {
	run(
		"npm",
		[
			"install",
			"--strict-peer-deps",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
		],
		directory,
	);
}

function assertInstalledRelease(
	consumer: string,
	release: PreparedRelease,
	packageNames: ReadonlyArray<string> = release.artifacts.map(
		({ packageName }) => packageName,
	),
): void {
	for (const packageName of packageNames) {
		const path = join(consumer, "node_modules", "@proseql", packageName);
		assert(!lstatSync(path).isSymbolicLink(), `${path} is a symlink`);
		assert(
			realpathSync(path).startsWith(realpathSync(consumer)),
			`${path} resolves outside the consumer`,
		);
		const manifest = readJson(join(path, "package.json"));
		assert(
			manifest.version === release.version,
			`${packageName} installed ${String(manifest.version)} instead of ${release.version}`,
		);
	}
}

function findInstalledEffectPackages(
	nodeModules: string,
): ReadonlyArray<string> {
	const found: string[] = [];
	const visit = (directory: string): void => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === ".bin") continue;
			const path = join(directory, entry.name);
			if (entry.name === "effect" && existsSync(join(path, "package.json"))) {
				found.push(path);
			}
			if (entry.name.startsWith("@")) {
				for (const scoped of readdirSync(path, { withFileTypes: true })) {
					if (scoped.isDirectory()) {
						visit(join(path, scoped.name, "node_modules"));
					}
				}
			} else {
				visit(join(path, "node_modules"));
			}
		}
	};
	visit(nodeModules);
	return found;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function run(command: string, args: ReadonlyArray<string>, cwd: string): void {
	execFileSync(command, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
		timeout: commandTimeoutMs,
		killSignal: "SIGKILL",
	});
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		const manifestIndex = args.indexOf("--manifest");
		const outputIndex = args.indexOf("--output");
		const manifestPath = args[manifestIndex + 1];
		const outputPath = args[outputIndex + 1];
		assert(
			manifestIndex >= 0 && manifestPath !== undefined,
			"--manifest is required",
		);
		assert(
			outputIndex >= 0 && outputPath !== undefined,
			"--output is required",
		);
		assert(args.length === 4, "only --manifest and --output are accepted");
		const verification = await runRegistryConsumerVerification({
			manifestPath,
			outputPath,
		});
		console.log(
			`Registry consumer verification passed for ${verification.version} (${verification.releaseId}).`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
