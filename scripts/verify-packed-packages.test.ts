import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	COORDINATED_PACKAGE_NAMES,
	type CoordinatedPackageName,
	EFFECT_VERSION,
	type PackedPackageContract,
	type PackedPackageJson,
	validatePackedPackage,
} from "./verify-packed-packages.js";

const root = resolve(import.meta.dirname, "..");
const coordinatedVersion = "0.15.0";

const dependenciesWithPackedVersions = (
	dependencies: Readonly<Record<string, string>> | undefined,
) =>
	dependencies
		? Object.fromEntries(
				Object.entries(dependencies).map(([name, version]) => [
					name,
					version.startsWith("workspace:") ? coordinatedVersion : version,
				]),
			)
		: undefined;

const readPackedEquivalentManifest = (
	packageName: CoordinatedPackageName,
): PackedPackageJson => {
	const source = JSON.parse(
		readFileSync(join(root, "packages", packageName, "package.json"), "utf8"),
	) as PackedPackageJson;
	return {
		...source,
		dependencies: dependenciesWithPackedVersions(source.dependencies),
		optionalDependencies: dependenciesWithPackedVersions(
			source.optionalDependencies,
		),
		peerDependencies: dependenciesWithPackedVersions(source.peerDependencies),
		devDependencies: dependenciesWithPackedVersions(source.devDependencies),
	};
};

const collectPaths = (
	value: unknown,
	paths = new Set<string>(),
): Set<string> => {
	if (typeof value === "string") {
		if (!value.endsWith("package.json")) paths.add(value.replace(/^\.\//, ""));
		return paths;
	}
	if (typeof value !== "object" || value === null) return paths;
	for (const nested of Object.values(value)) collectPaths(nested, paths);
	return paths;
};

const filesForManifest = (
	manifest: PackedPackageJson,
): Map<string, string | Uint8Array> => {
	const files = new Map<string, string | Uint8Array>([
		["package.json", JSON.stringify(manifest)],
		["LICENSE", "MIT"],
		["README.md", "package"],
	]);
	for (const path of [
		...(manifest.main ? [manifest.main] : []),
		...(manifest.types ? [manifest.types] : []),
		...collectPaths(manifest.exports),
		...(typeof manifest.bin === "string"
			? [manifest.bin]
			: Object.values(manifest.bin ?? {})),
	]) {
		files.set(path, path.endsWith(".js") ? "export {};" : "");
	}
	return files;
};

const validContract = (
	packageName: CoordinatedPackageName = "rpc",
): PackedPackageContract => {
	const manifest: PackedPackageJson = {
		name: `@proseql/${packageName}`,
		version: coordinatedVersion,
		description: `${packageName} package`,
		type: "module",
		main: "dist/index.js",
		types: "dist/index.d.ts",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
		},
		files: ["dist", "LICENSE", "README.md"],
		license: "MIT",
		repository: {
			type: "git",
			url: "https://github.com/simonwjackson/proseql.git",
			directory: `packages/${packageName}`,
		},
		publishConfig: { access: "public" },
		engines: { node: ">=18" },
		sideEffects: false,
		dependencies: { "@proseql/core": coordinatedVersion },
		peerDependencies: { effect: EFFECT_VERSION },
	};
	return {
		packageName,
		manifest,
		files: filesForManifest(manifest),
		coordinatedVersion,
	};
};

const mutate = (
	contract: PackedPackageContract,
	manifest: PackedPackageJson,
	files = contract.files,
): PackedPackageContract => ({ ...contract, manifest, files });

describe("packed package contract", () => {
	it("accepts normalized public package manifests for the coordinated set", () => {
		for (const packageName of COORDINATED_PACKAGE_NAMES) {
			const manifest = readPackedEquivalentManifest(packageName);
			expect(() =>
				validatePackedPackage({
					packageName,
					manifest,
					files: filesForManifest(manifest),
					coordinatedVersion,
				}),
			).not.toThrow();
		}
	});

	it.each([
		[
			"workspace references",
			{ dependencies: { "@proseql/core": "workspace:*" } },
			/workspace/,
		],
		[
			"wrong internal versions",
			{ dependencies: { "@proseql/core": "0.14.0" } },
			/must be 0\.15\.0/,
		],
		[
			"old RPC package",
			{ dependencies: { "@effect/rpc": "^0.50.0" } },
			/old @effect\/rpc/,
		],
		[
			"Effect ranges",
			{ peerDependencies: { effect: "^4.0.0-beta.103" } },
			/must be exactly/,
		],
		[
			"old Effect",
			{ peerDependencies: { effect: "4.0.0-beta.60" } },
			/must be exactly/,
		],
		[
			"neighbor Effect",
			{ peerDependencies: { effect: "4.0.0-beta.102" } },
			/must be exactly/,
		],
		[
			"missing public access",
			{ publishConfig: undefined },
			/missing public access/,
		],
	] as const)("rejects %s", (_label, replacement, message) => {
		const contract = validContract();
		const manifest = { ...contract.manifest, ...replacement };
		expect(() => validatePackedPackage(mutate(contract, manifest))).toThrow(
			message,
		);
	});

	it("rejects missing public entry point files", () => {
		const contract = validContract();
		const files = new Map(contract.files);
		files.delete("dist/index.js");
		expect(() =>
			validatePackedPackage(mutate(contract, contract.manifest, files)),
		).toThrow(/missing public entry point dist\/index\.js/);
	});

	it("rejects undeclared runtime dependencies and deep old RPC imports", () => {
		const contract = validContract();
		const undeclaredFiles = new Map(contract.files).set(
			"dist/index.js",
			'import { Effect } from "effect"; export { thing } from "missing-runtime/subpath";',
		);
		expect(() =>
			validatePackedPackage(
				mutate(contract, contract.manifest, undeclaredFiles),
			),
		).toThrow(/undeclared runtime dependency missing-runtime/);

		const oldRpcFiles = new Map(contract.files).set(
			"dist/index.js",
			'import { Rpc } from "@effect/rpc/Rpc";',
		);
		expect(() =>
			validatePackedPackage(mutate(contract, contract.manifest, oldRpcFiles)),
		).toThrow(/old @effect\/rpc import/);
	});

	it("rejects files outside the public package boundary", () => {
		const contract = validContract();
		const files = new Map(contract.files).set("src/index.ts", "export {};");
		expect(() =>
			validatePackedPackage(mutate(contract, contract.manifest, files)),
		).toThrow(/unexpected packed file src\/index\.ts/);
	});
});
