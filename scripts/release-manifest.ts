#!/usr/bin/env -S nix develop .#tooling --command bun

import { createHash } from "node:crypto";

export const COORDINATED_PACKAGE_NAMES = [
	"core",
	"engine",
	"node",
	"rest",
	"effect",
	"cli",
	"browser",
	"rpc",
] as const;

export type CoordinatedPackageName = (typeof COORDINATED_PACKAGE_NAMES)[number];

export const PUBLISH_ORDER: ReadonlyArray<CoordinatedPackageName> =
	COORDINATED_PACKAGE_NAMES;
export const PROMOTION_ORDER: ReadonlyArray<CoordinatedPackageName> = [
	...COORDINATED_PACKAGE_NAMES,
].reverse();

export type ReleasePackageManifest = Readonly<Record<string, unknown>> & {
	readonly name?: string;
	readonly version?: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
};

export type PreparedArtifact = {
	readonly packageName: CoordinatedPackageName;
	readonly name: `@proseql/${CoordinatedPackageName}`;
	readonly version: string;
	readonly tarball: string;
	readonly sha256: string;
	readonly integrity: `sha512-${string}`;
	readonly sizeBytes: number;
	readonly manifest: ReleasePackageManifest;
};

export type PreparedRelease = {
	readonly schemaVersion: 1;
	readonly releaseId: string;
	readonly version: string;
	readonly candidateTag: string;
	readonly commit: string;
	readonly preparedAt: string;
	readonly publishOrder: ReadonlyArray<CoordinatedPackageName>;
	readonly promotionOrder: ReadonlyArray<CoordinatedPackageName>;
	readonly artifacts: ReadonlyArray<PreparedArtifact>;
};

export function candidateTagFor(version: string): string {
	assertSemver(version);
	return `proseql-candidate-${version.replaceAll(".", "-")}`;
}

export function validateDependencyOrder(
	manifests: ReadonlyMap<CoordinatedPackageName, ReleasePackageManifest>,
): void {
	const positions = new Map(
		PUBLISH_ORDER.map((packageName, index) => [packageName, index]),
	);
	for (const packageName of PUBLISH_ORDER) {
		const manifest = manifests.get(packageName);
		assert(
			manifest !== undefined,
			`missing coordinated package ${packageName}`,
		);
		const sections = [
			manifest.dependencies ?? {},
			manifest.optionalDependencies ?? {},
			manifest.peerDependencies ?? {},
		];
		for (const section of sections) {
			for (const dependency of Object.keys(section)) {
				if (!dependency.startsWith("@proseql/")) continue;
				const dependencyName = dependency.slice(
					"@proseql/".length,
				) as CoordinatedPackageName;
				const dependencyPosition = positions.get(dependencyName);
				assert(
					dependencyPosition !== undefined,
					`${manifest.name ?? packageName} depends on non-coordinated package ${dependency}`,
				);
				assert(
					(dependencyPosition ?? Number.POSITIVE_INFINITY) <
						(positions.get(packageName) ?? -1),
					`${manifest.name ?? packageName} would publish before its dependency ${dependency}`,
				);
			}
		}
	}
}

export function createPreparedRelease(input: {
	readonly version: string;
	readonly commit: string;
	readonly preparedAt: string;
	readonly artifacts: ReadonlyArray<PreparedArtifact>;
}): PreparedRelease {
	assertSemver(input.version);
	const artifactOrder = input.artifacts.map(({ packageName }) => packageName);
	assert(
		JSON.stringify(artifactOrder) === JSON.stringify(PUBLISH_ORDER),
		`prepared artifact order must be ${PUBLISH_ORDER.join(" -> ")}`,
	);
	const manifests = new Map<CoordinatedPackageName, ReleasePackageManifest>();
	for (const artifact of input.artifacts) {
		assert(
			artifact.name === `@proseql/${artifact.packageName}`,
			`${artifact.packageName}: artifact package name mismatch`,
		);
		assert(
			artifact.version === input.version &&
				artifact.manifest.version === input.version,
			`${artifact.name}: artifact version must be ${input.version}`,
		);
		assert(
			artifact.manifest.name === artifact.name,
			`${artifact.name}: packed manifest name mismatch`,
		);
		assert(
			artifact.tarball.startsWith("tarballs/") &&
				!artifact.tarball.includes("..") &&
				!artifact.tarball.includes("\\"),
			`${artifact.name}: tarball must stay within the prepared tarballs directory`,
		);
		assert(
			/^[a-f0-9]{64}$/.test(artifact.sha256),
			`${artifact.name}: invalid sha256`,
		);
		assert(
			artifact.integrity.startsWith("sha512-") &&
				artifact.integrity.length > "sha512-".length,
			`${artifact.name}: invalid integrity`,
		);
		assert(artifact.sizeBytes > 0, `${artifact.name}: empty tarball`);
		manifests.set(artifact.packageName, artifact.manifest);
	}
	validateDependencyOrder(manifests);
	const candidateTag = candidateTagFor(input.version);
	const releaseIdentity = stableStringify({
		version: input.version,
		commit: input.commit,
		candidateTag,
		artifacts: input.artifacts.map(
			({ name, version, tarball, sha256, integrity, sizeBytes, manifest }) => ({
				name,
				version,
				tarball,
				sha256,
				integrity,
				sizeBytes,
				manifest: registryManifestContract(manifest),
			}),
		),
	});
	return {
		schemaVersion: 1,
		releaseId: createHash("sha256").update(releaseIdentity).digest("hex"),
		version: input.version,
		candidateTag,
		commit: input.commit,
		preparedAt: input.preparedAt,
		publishOrder: PUBLISH_ORDER,
		promotionOrder: PROMOTION_ORDER,
		artifacts: input.artifacts,
	};
}

const registryManifestKeys = [
	"name",
	"version",
	"description",
	"author",
	"keywords",
	"type",
	"main",
	"types",
	"bin",
	"exports",
	"license",
	"repository",
	"publishConfig",
	"engines",
	"sideEffects",
	"scripts",
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"devDependencies",
] as const;

export function registryManifestContract(
	manifest: ReleasePackageManifest,
): Readonly<Record<string, unknown>> {
	const contract: Record<string, unknown> = {};
	for (const key of registryManifestKeys) {
		if (manifest[key] === undefined) continue;
		contract[key] =
			key === "repository" ? normalizeRepository(manifest[key]) : manifest[key];
	}
	return contract;
}

function normalizeRepository(repository: unknown): unknown {
	if (
		typeof repository !== "object" ||
		repository === null ||
		Array.isArray(repository)
	) {
		return repository;
	}
	const record = repository as Readonly<Record<string, unknown>>;
	return {
		...record,
		...(typeof record.url === "string"
			? { url: record.url.replace(/^git\+/, "") }
			: {}),
	};
}

export function manifestsMatch(
	expected: ReleasePackageManifest,
	actual: ReleasePackageManifest,
): boolean {
	return manifestContractDiff(expected, actual).length === 0;
}

export function manifestContractDiff(
	expected: ReleasePackageManifest,
	actual: ReleasePackageManifest,
): ReadonlyArray<string> {
	const expectedContract = registryManifestContract(expected);
	const actualContract = registryManifestContract(actual);
	return [
		...new Set([
			...Object.keys(expectedContract),
			...Object.keys(actualContract),
		]),
	]
		.sort()
		.filter(
			(key) =>
				stableStringify(expectedContract[key]) !==
				stableStringify(actualContract[key]),
		)
		.map(
			(key) =>
				`${key}: expected ${conciseValue(expectedContract[key])}, actual ${conciseValue(actualContract[key])}`,
		);
}

function conciseValue(value: unknown): string {
	const serialized = stableStringify(value);
	return serialized.length <= 120
		? serialized
		: `${serialized.slice(0, 117)}...`;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = value as Readonly<Record<string, unknown>>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function assertSemver(version: string): void {
	assert(/^\d+\.\d+\.\d+$/.test(version), `invalid release version ${version}`);
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
