import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CommandResult,
	type CommandRunner,
	type ConsumerVerification,
	createCommandRunner,
	NpmRegistry,
	publishPackages,
	type Registry,
	type RegistryVersion,
} from "./publish-packages.js";
import {
	computeBumpType,
	finalizeRelease,
	incrementVersion,
	prepareReleaseVersion,
	type ReleaseFinalizationServices,
	type ReleaseVersionPreparationServices,
	updateWorkspaceForRelease,
} from "./release.js";
import {
	COORDINATED_PACKAGE_NAMES,
	createPreparedRelease,
	PROMOTION_ORDER,
	type PreparedArtifact,
	type PreparedRelease,
	PUBLISH_ORDER,
	validateDependencyOrder,
} from "./release-manifest.js";

const VERSION = "0.16.0";
const TAG = "proseql-candidate-0-16-0";

const packageManifest = (
	packageName: (typeof COORDINATED_PACKAGE_NAMES)[number],
	dependencies: Readonly<Record<string, string>> = {},
) => ({
	name: `@proseql/${packageName}`,
	version: VERSION,
	type: "module",
	dependencies,
	peerDependencies: { effect: "4.0.0-beta.103" },
});

const workspaceLock = (version: string): string =>
	`${COORDINATED_PACKAGE_NAMES.map(
		(name) =>
			`"packages/${name}": { "name": "@proseql/${name}", "version": "${version}" },`,
	).join(
		"\n",
	)}\n"packages/ai": { "name": "@proseql/ai", "version": "0.5.0" },\n`;

const workspaceFiles = (
	version: string,
	options: { readonly releaseEntry?: boolean } = {},
): Map<string, string> => {
	const files = new Map<string, string>();
	for (const name of COORDINATED_PACKAGE_NAMES) {
		files.set(
			`packages/${name}/package.json`,
			`${JSON.stringify({ ...packageManifest(name), version })}\n`,
		);
	}
	files.set(
		"packages/ai/package.json",
		'{"name":"@proseql/ai","version":"0.5.0"}\n',
	);
	files.set("packages/cli/src/main.ts", `const VERSION = "${version}";\n`);
	files.set("bun.lock", workspaceLock(version));
	files.set(
		"CHANGELOG.md",
		options.releaseEntry
			? `# Changelog\n\n## v${version} (2026-08-05)\n`
			: "# Changelog\n",
	);
	return files;
};

const artifact = (
	packageName: (typeof COORDINATED_PACKAGE_NAMES)[number],
): PreparedArtifact => {
	const bytes = Buffer.from(`tarball:${packageName}`);
	return {
		packageName,
		name: `@proseql/${packageName}`,
		version: VERSION,
		tarball: `tarballs/proseql-${packageName}-${VERSION}.tgz`,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		sizeBytes: bytes.byteLength,
		manifest: packageManifest(packageName),
	};
};

const preparedRelease = (): PreparedRelease =>
	createPreparedRelease({
		version: VERSION,
		commit: "0123456789abcdef0123456789abcdef01234567",
		preparedAt: "2026-08-05T12:00:00.000Z",
		artifacts: COORDINATED_PACKAGE_NAMES.map(artifact),
	});

class RecordingRegistry implements Registry {
	readonly calls: string[] = [];
	readonly versions = new Map<string, RegistryVersion>();
	readonly tags = new Map<string, string>();
	credentialError: Error | undefined;
	artifactVerificationError: Error | undefined;
	publishErrorAt: string | undefined;
	visibilityFailures = new Map<string, number>();

	key(name: string, version: string): string {
		return `${name}@${version}`;
	}

	async verifyPreparedArtifacts(): Promise<void> {
		this.calls.push("verify-artifacts");
		if (this.artifactVerificationError) throw this.artifactVerificationError;
	}

	seed(release: PreparedRelease, packageName: string): void {
		const candidate = release.artifacts.find(
			(item) => item.packageName === packageName,
		);
		if (!candidate) throw new Error(`missing fixture ${packageName}`);
		this.versions.set(this.key(candidate.name, candidate.version), {
			manifest: candidate.manifest,
			integrity: candidate.integrity,
		});
		this.tags.set(
			`${candidate.name}:${release.candidateTag}`,
			candidate.version,
		);
	}

	async authenticate(): Promise<string> {
		this.calls.push("authenticate");
		if (this.credentialError) throw this.credentialError;
		return "release-operator";
	}

	async getVersion(name: string, version: string) {
		this.calls.push(`read:${name}@${version}`);
		const key = this.key(name, version);
		const failures = this.visibilityFailures.get(key) ?? 0;
		if (failures > 0) {
			this.visibilityFailures.set(key, failures - 1);
			return undefined;
		}
		return this.versions.get(key);
	}

	async publishCandidate(candidate: PreparedArtifact, tag: string) {
		this.calls.push(`publish:${candidate.packageName}:${tag}`);
		if (this.publishErrorAt === candidate.packageName) {
			throw new Error("registry rejected upload");
		}
		this.versions.set(this.key(candidate.name, candidate.version), {
			manifest: candidate.manifest,
			integrity: candidate.integrity,
		});
		this.tags.set(`${candidate.name}:${tag}`, candidate.version);
	}

	async getTag(name: string, tag: string) {
		this.calls.push(`tag-read:${name}:${tag}`);
		return this.tags.get(`${name}:${tag}`);
	}

	async setTag(name: string, version: string, tag: string) {
		this.calls.push(`tag-set:${name}:${tag}`);
		this.tags.set(`${name}:${tag}`, version);
	}

	async removeTag(name: string, tag: string) {
		this.calls.push(`tag-remove:${name}:${tag}`);
		this.tags.delete(`${name}:${tag}`);
	}
}

const verificationFor = (release: PreparedRelease): ConsumerVerification => ({
	schemaVersion: 1,
	releaseId: release.releaseId,
	version: release.version,
	candidateTag: release.candidateTag,
	verifiedAt: "2026-08-05T13:00:00.000Z",
	artifacts: release.artifacts.map(({ name, integrity }) => ({
		name,
		integrity,
	})),
});

describe("coordinated release manifest", () => {
	it("is the single dependency-safe package order and reverses latest promotion", () => {
		expect(COORDINATED_PACKAGE_NAMES).toEqual([
			"core",
			"engine",
			"node",
			"rest",
			"effect",
			"cli",
			"browser",
			"rpc",
		]);
		expect(PUBLISH_ORDER).toEqual(COORDINATED_PACKAGE_NAMES);
		expect(PROMOTION_ORDER).toEqual([
			"rpc",
			"browser",
			"cli",
			"effect",
			"rest",
			"node",
			"engine",
			"core",
		]);
		const manifests = new Map(
			COORDINATED_PACKAGE_NAMES.map((name) => [name, packageManifest(name)]),
		);
		manifests.set(
			"effect",
			packageManifest("effect", { "@proseql/engine": VERSION }),
		);
		manifests.set(
			"rpc",
			packageManifest("rpc", { "@proseql/effect": VERSION }),
		);
		expect(() => validateDependencyOrder(manifests)).not.toThrow();
	});

	it("rejects missing packages, forward dependencies, and inconsistent artifacts", () => {
		const missing = new Map(
			COORDINATED_PACKAGE_NAMES.slice(1).map((name) => [
				name,
				packageManifest(name),
			]),
		);
		expect(() => validateDependencyOrder(missing)).toThrow(/missing.*core/i);
		const forward = new Map(
			COORDINATED_PACKAGE_NAMES.map((name) => [name, packageManifest(name)]),
		);
		forward.set("core", packageManifest("core", { "@proseql/rpc": VERSION }));
		expect(() => validateDependencyOrder(forward)).toThrow(
			/before its dependency/i,
		);
		const artifacts = COORDINATED_PACKAGE_NAMES.map(artifact);
		expect(() =>
			createPreparedRelease({
				version: VERSION,
				commit: "bad",
				preparedAt: "2026-08-05T12:00:00.000Z",
				artifacts: artifacts.slice(1),
			}),
		).toThrow(/artifact order/i);
	});
});

describe("reversible release preparation", () => {
	it("computes conventional bumps", () => {
		expect(computeBumpType(["fix: repair loader"], "")).toBe("patch");
		expect(computeBumpType(["feat: add RPC"], "")).toBe("minor");
		expect(computeBumpType(["feat!: replace API"], "")).toBe("major");
		expect(
			computeBumpType(["fix: repair"], "BREAKING CHANGE: wire format"),
		).toBe("major");
		expect(incrementVersion("0.15.0", "minor")).toBe(VERSION);
	});

	it("updates all eight versions, changelog, and CLI while retaining AI's version", () => {
		const files = new Map<string, string>();
		for (const name of COORDINATED_PACKAGE_NAMES) {
			files.set(
				`packages/${name}/package.json`,
				`${JSON.stringify(packageManifest(name))}\n`,
			);
		}
		files.set(
			"packages/ai/package.json",
			`${JSON.stringify({ name: "@proseql/ai", version: "0.5.0" })}\n`,
		);
		files.set("packages/cli/src/main.ts", 'const VERSION = "0.15.0";\n');
		files.set("bun.lock", workspaceLock("0.15.0"));
		files.set("CHANGELOG.md", "# Changelog\n\nold\n");
		const updated = updateWorkspaceForRelease({
			files,
			nextVersion: VERSION,
			date: "2026-08-05",
			commits: [{ hash: "1234567890", subject: "feat: safe publishing" }],
		});
		for (const name of COORDINATED_PACKAGE_NAMES) {
			expect(
				JSON.parse(updated.get(`packages/${name}/package.json`) ?? "").version,
			).toBe(VERSION);
		}
		expect(
			JSON.parse(updated.get("packages/ai/package.json") ?? "").version,
		).toBe("0.5.0");
		expect(updated.get("packages/cli/src/main.ts")).toContain(
			`VERSION = "${VERSION}"`,
		);
		expect(updated.get("bun.lock")).toContain(
			`"packages/rpc": { "name": "@proseql/rpc", "version": "${VERSION}" }`,
		);
		expect(updated.get("bun.lock")).toContain(
			'"packages/ai": { "name": "@proseql/ai", "version": "0.5.0" }',
		);
		expect(updated.get("CHANGELOG.md")).toContain(
			`## v${VERSION} (2026-08-05)`,
		);
	});

	it("prepares source edits only and rolls partial writes back before retry", async () => {
		let files = workspaceFiles("0.15.0");
		let failWrite = true;
		const writes: string[] = [];
		const services: ReleaseVersionPreparationServices = {
			readWorkspace: async () => new Map(files),
			writeWorkspace: async (next) => {
				files = new Map(next);
				writes.push(
					JSON.parse(next.get("packages/core/package.json") ?? "").version,
				);
				if (failWrite) {
					failWrite = false;
					throw new Error("partial write failed");
				}
			},
			readGitHistory: async () => ({
				commit: "0123456789abcdef0123456789abcdef01234567",
				commits: [
					{ hash: "abc1234", subject: "feat: publish packages", body: "" },
				],
			}),
			now: () => new Date("2026-08-05T12:00:00.000Z"),
		};
		await expect(
			prepareReleaseVersion({ bump: "minor" }, services),
		).rejects.toThrow(/partial write failed/);
		expect(writes).toEqual([VERSION, "0.15.0"]);
		expect(
			JSON.parse(files.get("packages/core/package.json") ?? "").version,
		).toBe("0.15.0");
		const retry = await prepareReleaseVersion({ bump: "minor" }, services);
		expect(retry.version).toBe(VERSION);
		expect(
			JSON.parse(files.get("packages/core/package.json") ?? "").version,
		).toBe(VERSION);
	});

	it("finalizes a clean coordinated commit and records the exact HEAD after all gates", async () => {
		const events: string[] = [];
		const commit = "fedcba9876543210fedcba9876543210fedcba98";
		const services: ReleaseFinalizationServices = {
			readWorkspace: async () =>
				workspaceFiles(VERSION, { releaseEntry: true }),
			readGitHistory: async () => ({ commit, commits: [] }),
			assertCleanTree: async () => {
				events.push("clean");
			},
			checkVersionAvailable: async (name, version) => {
				events.push(`available:${name}@${version}`);
			},
			runPreflight: async () => {
				events.push("preflight");
			},
			prepareArtifacts: async () => {
				events.push("artifacts");
				return preparedRelease().artifacts;
			},
			writePreparedRelease: async () => {
				events.push("manifest");
			},
			now: () => new Date("2026-08-05T12:00:00.000Z"),
		};
		const release = await finalizeRelease(services);
		expect(release.version).toBe(VERSION);
		expect(release.commit).toBe(commit);
		expect(
			events.filter((event) => event.startsWith("available:")),
		).toHaveLength(8);
		expect(events.filter((event) => event === "clean")).toHaveLength(3);
		expect(events.indexOf("preflight")).toBeGreaterThan(
			events.lastIndexOf(`available:@proseql/rpc@${VERSION}`),
		);
		const cleanEvents = events
			.map((event, index) => (event === "clean" ? index : -1))
			.filter((index) => index >= 0);
		expect(events.indexOf("artifacts")).toBeGreaterThan(cleanEvents[1] ?? -1);
		expect(events.indexOf("artifacts")).toBeLessThan(cleanEvents[2] ?? -1);
	});

	it("fails dirty finalization before registry and artifacts", async () => {
		const events: string[] = [];
		const services: ReleaseFinalizationServices = {
			readWorkspace: async () =>
				workspaceFiles(VERSION, { releaseEntry: true }),
			readGitHistory: async () => ({ commit: "head", commits: [] }),
			assertCleanTree: async () => {
				throw new Error("dirty tree");
			},
			checkVersionAvailable: async () => {
				events.push("registry");
			},
			runPreflight: async () => {
				events.push("preflight");
			},
			prepareArtifacts: async () => {
				events.push("artifacts");
				return preparedRelease().artifacts;
			},
			writePreparedRelease: async () => {
				events.push("manifest");
			},
			now: () => new Date(),
		};
		await expect(finalizeRelease(services)).rejects.toThrow(/dirty tree/);
		expect(events).toEqual([]);
	});

	it.each([
		"manifest",
		"cli",
		"lock",
		"changelog",
	])("rejects an uncoordinated %s before registry reads", async (failure) => {
		const files = workspaceFiles(VERSION, { releaseEntry: true });
		if (failure === "manifest") {
			files.set(
				"packages/rpc/package.json",
				`${JSON.stringify({ ...packageManifest("rpc"), version: "0.15.0" })}\n`,
			);
		} else if (failure === "cli") {
			files.set("packages/cli/src/main.ts", 'const VERSION = "0.15.0";\n');
		} else if (failure === "lock") {
			files.set("bun.lock", workspaceLock("0.15.0"));
		} else {
			files.set("CHANGELOG.md", "# Changelog\n");
		}
		let registryReads = 0;
		const services: ReleaseFinalizationServices = {
			readWorkspace: async () => files,
			readGitHistory: async () => ({ commit: "head", commits: [] }),
			assertCleanTree: async () => {},
			checkVersionAvailable: async () => {
				registryReads += 1;
			},
			runPreflight: async () => {},
			prepareArtifacts: async () => preparedRelease().artifacts,
			writePreparedRelease: async () => {},
			now: () => new Date(),
		};
		await expect(finalizeRelease(services)).rejects.toThrow();
		expect(registryReads).toBe(0);
	});

	it("retries failed finalization at the same version without another bump", async () => {
		let attempts = 0;
		const versions: string[] = [];
		const services: ReleaseFinalizationServices = {
			readWorkspace: async () =>
				workspaceFiles(VERSION, { releaseEntry: true }),
			readGitHistory: async () => ({
				commit: "0123456789abcdef0123456789abcdef01234567",
				commits: [],
			}),
			assertCleanTree: async () => {},
			checkVersionAvailable: async (_name, version) => {
				versions.push(version);
			},
			runPreflight: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("gate failed");
			},
			prepareArtifacts: async () => preparedRelease().artifacts,
			writePreparedRelease: async () => {},
			now: () => new Date("2026-08-05T12:00:00.000Z"),
		};
		await expect(finalizeRelease(services)).rejects.toThrow(/gate failed/);
		const release = await finalizeRelease(services);
		expect(release.version).toBe(VERSION);
		expect(new Set(versions)).toEqual(new Set([VERSION]));
	});
});

describe("safe candidate publication", () => {
	it("is read-only by default and models credential-free dry runs", async () => {
		const registry = new RecordingRegistry();
		await publishPackages(preparedRelease(), registry, { mode: "dry-run" });
		expect(
			registry.calls.every(
				(call) => call.startsWith("read:") || call.startsWith("tag-read:"),
			),
		).toBe(true);
		expect(registry.calls).not.toContain("authenticate");
	});

	it("requires protected approval before a destructive candidate upload", async () => {
		const registry = new RecordingRegistry();
		await expect(
			publishPackages(preparedRelease(), registry, {
				mode: "candidate",
				approval: undefined,
			}),
		).rejects.toThrow(/approval/i);
		expect(registry.calls).toEqual([]);
	});

	it("rejects unknown runtime modes before authentication or registry access", async () => {
		const registry = new RecordingRegistry();
		await expect(
			publishPackages(preparedRelease(), registry, {
				mode: "unexpected" as "candidate",
				approval: preparedRelease().releaseId,
			}),
		).rejects.toThrow(/unknown publication mode/i);
		expect(registry.calls).toEqual([]);
	});

	it("re-inspects artifacts before authentication or registry access", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		registry.artifactVerificationError = new Error(
			"embedded manifest mismatch",
		);
		await expect(
			publishPackages(release, registry, {
				mode: "candidate",
				approval: release.releaseId,
			}),
		).rejects.toThrow(/embedded manifest mismatch/);
		expect(registry.calls).toEqual(["verify-artifacts"]);
	});

	it("uses npm --tag semantics for a brand-new package without creating latest", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		await publishPackages(release, registry, {
			mode: "candidate",
			approval: release.releaseId,
		});
		for (const candidate of release.artifacts) {
			expect(
				registry.tags.get(`${candidate.name}:${release.candidateTag}`),
			).toBe(VERSION);
			expect(registry.tags.get(`${candidate.name}:latest`)).toBeUndefined();
		}
	});

	it("publishes exact tarballs sequentially, waits boundedly, and fails fast", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		registry.visibilityFailures.set("@proseql/core@0.16.0", 2);
		registry.publishErrorAt = "rest";
		await expect(
			publishPackages(release, registry, {
				mode: "candidate",
				approval: release.releaseId,
				visibility: { attempts: 3, delayMs: 0 },
			}),
		).rejects.toThrow(/registry rejected upload/);
		expect(
			registry.calls.filter((call) => call.startsWith("publish:")),
		).toEqual([
			`publish:core:${TAG}`,
			`publish:engine:${TAG}`,
			`publish:node:${TAG}`,
			`publish:rest:${TAG}`,
		]);
		expect(
			registry.calls.some(
				(call) => call.startsWith("tag-set:") && call.endsWith(":latest"),
			),
		).toBe(false);
	});

	it("resumes only matching candidates and refuses manifest or integrity mismatches", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		registry.seed(release, "core");
		registry.seed(release, "engine");
		await publishPackages(release, registry, {
			mode: "candidate",
			approval: release.releaseId,
		});
		expect(
			registry.calls.filter((call) => call.startsWith("publish:"))[0],
		).toBe(`publish:node:${TAG}`);

		const registryMetadata = new RecordingRegistry();
		for (const name of COORDINATED_PACKAGE_NAMES) {
			registryMetadata.seed(release, name);
			const candidate = release.artifacts.find(
				(artifact) => artifact.packageName === name,
			);
			if (!candidate) throw new Error(`missing ${name}`);
			registryMetadata.versions.set(`${candidate.name}@${VERSION}`, {
				manifest: {
					...candidate.manifest,
					_id: `${candidate.name}@${VERSION}`,
				},
				integrity: candidate.integrity,
			});
		}
		await publishPackages(release, registryMetadata, {
			mode: "candidate",
			approval: release.releaseId,
		});
		expect(
			registryMetadata.calls.some((call) => call.startsWith("publish:")),
		).toBe(false);

		const mismatch = new RecordingRegistry();
		mismatch.seed(release, "core");
		mismatch.versions.set("@proseql/core@0.16.0", {
			manifest: packageManifest("core", { "@proseql/rpc": "0.15.0" }),
			integrity: release.artifacts[0]?.integrity ?? "",
		});
		await expect(
			publishPackages(release, mismatch, {
				mode: "candidate",
				approval: release.releaseId,
			}),
		).rejects.toThrow(
			/dependencies: expected.*deprecate.*new coordinated version/i,
		);
		expect(mismatch.calls.some((call) => call.startsWith("publish:"))).toBe(
			false,
		);
	});

	it("stops on credential failure and needs fresh approval to resume", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		registry.credentialError = new Error("token expired");
		await expect(
			publishPackages(release, registry, {
				mode: "candidate",
				approval: release.releaseId,
			}),
		).rejects.toThrow(/token expired/);
		expect(registry.calls).toEqual(["verify-artifacts", "authenticate"]);
		registry.credentialError = undefined;
		await expect(
			publishPackages(release, registry, {
				mode: "candidate",
				approval: undefined,
			}),
		).rejects.toThrow(/approval/i);
	});
});

describe("verified latest promotion", () => {
	it("requires a matching full consumer verification signal", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		for (const name of COORDINATED_PACKAGE_NAMES) registry.seed(release, name);
		await expect(
			publishPackages(release, registry, {
				mode: "promote",
				approval: release.releaseId,
			}),
		).rejects.toThrow(/consumer verification/i);
		const wrong = { ...verificationFor(release), releaseId: "wrong" };
		await expect(
			publishPackages(release, registry, {
				mode: "promote",
				approval: release.releaseId,
				consumerVerification: wrong,
			}),
		).rejects.toThrow(/does not match/i);
	});

	it("promotes in reverse order and retains candidate tags until every latest verifies", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		for (const name of COORDINATED_PACKAGE_NAMES) registry.seed(release, name);
		await publishPackages(release, registry, {
			mode: "promote",
			approval: release.releaseId,
			consumerVerification: verificationFor(release),
		});
		expect(
			registry.calls
				.filter((call) => call.startsWith("tag-set:"))
				.map((call) => call.split(":")[1]),
		).toEqual(PROMOTION_ORDER.map((name) => `@proseql/${name}`));
		const lastLatestRead = registry.calls.reduce(
			(found, call, index) => (call.includes(":latest") ? index : found),
			-1,
		);
		const firstRemove = registry.calls.findIndex((call) =>
			call.startsWith("tag-remove:"),
		);
		expect(firstRemove).toBeGreaterThan(lastLatestRead);
		expect(
			registry.calls.filter((call) => call.startsWith("tag-remove:")),
		).toHaveLength(8);
	});

	it("safely resumes an interrupted promotion without reuploading tarballs", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		for (const name of COORDINATED_PACKAGE_NAMES) registry.seed(release, name);
		for (const name of ["rpc", "browser", "cli"] as const) {
			registry.tags.set(`@proseql/${name}:latest`, VERSION);
		}
		await publishPackages(release, registry, {
			mode: "promote",
			approval: release.releaseId,
			consumerVerification: verificationFor(release),
		});
		expect(registry.calls.some((call) => call.startsWith("publish:"))).toBe(
			false,
		);
		expect(
			registry.calls
				.filter((call) => call.startsWith("tag-set:"))
				.map((call) => call.split(":")[1]),
		).toEqual(PROMOTION_ORDER.slice(3).map((name) => `@proseql/${name}`));
	});

	it("resumes temporary-tag cleanup after every latest tag already verified", async () => {
		const release = preparedRelease();
		const registry = new RecordingRegistry();
		for (const name of COORDINATED_PACKAGE_NAMES) {
			registry.seed(release, name);
			registry.tags.set(`@proseql/${name}:latest`, VERSION);
		}
		for (const name of COORDINATED_PACKAGE_NAMES.slice(0, 3)) {
			registry.tags.delete(`@proseql/${name}:${TAG}`);
		}
		await publishPackages(release, registry, {
			mode: "promote",
			approval: release.releaseId,
			consumerVerification: verificationFor(release),
		});
		expect(
			registry.calls.filter((call) => call.startsWith("tag-remove:")),
		).toHaveLength(5);
	});
});

describe("npm command safety", () => {
	it("safely rejects a tarball whose embedded manifest differs before npm calls", async () => {
		const root = mkdtempSync(join(tmpdir(), "proseql-release-test-"));
		try {
			const source = join(root, "source", "package");
			const tarballs = join(root, "tarballs");
			mkdirSync(source, { recursive: true });
			mkdirSync(tarballs);
			writeFileSync(
				join(source, "package.json"),
				JSON.stringify(
					packageManifest("core", { "unexpected-dependency": "1.0.0" }),
				),
			);
			const tarball = join(tarballs, `proseql-core-${VERSION}.tgz`);
			execFileSync("tar", [
				"-czf",
				tarball,
				"-C",
				join(root, "source"),
				"package",
			]);
			const bytes = readFileSync(tarball);
			const candidate: PreparedArtifact = {
				...artifact("core"),
				tarball: `tarballs/proseql-core-${VERSION}.tgz`,
				sizeBytes: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			};
			let npmCalls = 0;
			const npm = new NpmRegistry(async () => {
				npmCalls += 1;
				return { status: 0, stdout: "", stderr: "" };
			}, root);
			await expect(
				npm.verifyPreparedArtifacts({
					...preparedRelease(),
					artifacts: [candidate],
				}),
			).rejects.toThrow(/embedded package\.json.*dependencies/i);
			expect(npmCalls).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds every npm/registry subprocess", async () => {
		const result = await createCommandRunner(10)(process.execPath, [
			"-e",
			"setTimeout(() => {}, 10000)",
		]);
		expect(result.status).toBe(124);
		expect(result.stderr).toContain("timed out after 10ms");
	});

	it("uses read commands in dry runs and lifecycle-free writes only after orchestration approval", async () => {
		const commands: Array<{ command: string; args: readonly string[] }> = [];
		const runner: CommandRunner = async (
			command,
			args,
		): Promise<CommandResult> => {
			commands.push({ command, args });
			if (
				args[0] === "view" &&
				args.some((arg) => arg.startsWith("dist-tags."))
			) {
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "view")
				return { status: 1, stdout: "", stderr: "E404 Not Found" };
			if (args[0] === "whoami")
				return { status: 0, stdout: "operator\n", stderr: "" };
			return { status: 0, stdout: "", stderr: "" };
		};
		const npm = new NpmRegistry(runner, "/prepared");
		await npm.getVersion("@proseql/core", VERSION);
		expect(await npm.getTag("@proseql/core", TAG)).toBeUndefined();
		expect(commands[0]).toEqual(
			expect.objectContaining({
				command: "npm",
				args: expect.arrayContaining(["view"]),
			}),
		);
		expect(commands[0]?.args).not.toEqual(
			expect.arrayContaining(["publish", "dist-tag"]),
		);
		await npm.publishCandidate(artifact("core"), TAG);
		const publish = commands.at(-1)?.args ?? [];
		expect(publish).toEqual(
			expect.arrayContaining(["publish", "--ignore-scripts", "--tag", TAG]),
		);
		expect(publish).not.toContain("--force");
	});
});
