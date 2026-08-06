#!/usr/bin/env -S nix develop .#tooling --command bun

import { builtinModules } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

export const EFFECT_VERSION = "4.0.0-beta.103";
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

export type PackedPackageJson = {
	readonly name?: string;
	readonly version?: string;
	readonly description?: string;
	readonly type?: string;
	readonly main?: string;
	readonly types?: string;
	readonly bin?: string | Readonly<Record<string, string>>;
	readonly exports?: unknown;
	readonly files?: ReadonlyArray<string>;
	readonly license?: string;
	readonly repository?:
		| string
		| {
				readonly type?: string;
				readonly url?: string;
				readonly directory?: string;
		  };
	readonly publishConfig?: { readonly access?: string };
	readonly engines?: Readonly<Record<string, string>>;
	readonly sideEffects?: boolean;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
};

export type PackedPackageContract = {
	readonly packageName: CoordinatedPackageName;
	readonly manifest: PackedPackageJson;
	readonly files: ReadonlyMap<string, string | Uint8Array>;
	readonly coordinatedVersion: string;
};

const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"devDependencies",
] as const;
const runtimeDependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;
const nodeBuiltins = new Set([
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
]);

export function validatePackedPackage({
	packageName,
	manifest,
	files,
	coordinatedVersion,
}: PackedPackageContract): void {
	const expectedName = `@proseql/${packageName}`;
	assert(manifest.name === expectedName, `${expectedName}: wrong package name`);
	assert(
		manifest.version === coordinatedVersion,
		`${expectedName}: expected coordinated version ${coordinatedVersion}, found ${String(manifest.version)}`,
	);
	assert(
		typeof manifest.description === "string" && manifest.description.length > 0,
		`${expectedName}: missing description`,
	);
	assert(manifest.type === "module", `${expectedName}: package must be ESM`);
	assert(manifest.license === "MIT", `${expectedName}: missing MIT license`);
	assert(
		manifest.publishConfig?.access === "public",
		`${expectedName}: missing public access`,
	);
	assert(
		manifest.engines?.node === ">=18",
		`${expectedName}: missing supported Node runtime`,
	);
	assert(
		manifest.sideEffects === false,
		`${expectedName}: sideEffects must be false`,
	);
	validateRepository(packageName, manifest.repository);
	validatePackageFiles(expectedName, manifest.files, files);
	validatePublicEntries(expectedName, manifest, files);
	validateDependencyDeclarations(manifest, coordinatedVersion);
	validateRuntimeImports(expectedName, manifest, files);
}

function validateRepository(
	packageName: CoordinatedPackageName,
	repository: PackedPackageJson["repository"],
): void {
	assert(
		typeof repository === "object" && repository !== null,
		`@proseql/${packageName}: missing repository metadata`,
	);
	if (typeof repository !== "object" || repository === null) return;
	assert(
		repository.type === "git" &&
			repository.url?.replace(/^git\+/, "") ===
				"https://github.com/simonwjackson/proseql.git" &&
			repository.directory === `packages/${packageName}`,
		`@proseql/${packageName}: incorrect repository metadata`,
	);
}

function validatePackageFiles(
	displayName: string,
	declaredFiles: PackedPackageJson["files"],
	files: ReadonlyMap<string, string | Uint8Array>,
): void {
	for (const required of ["dist", "LICENSE", "README.md"]) {
		assert(
			declaredFiles?.includes(required) === true,
			`${displayName}: package files must include ${required}`,
		);
	}
	for (const path of files.keys()) {
		assert(
			path === "package.json" ||
				path === "LICENSE" ||
				path === "README.md" ||
				path.startsWith("dist/"),
			`${displayName}: unexpected packed file ${path}`,
		);
	}
}

function validatePublicEntries(
	displayName: string,
	manifest: PackedPackageJson,
	files: ReadonlyMap<string, string | Uint8Array>,
): void {
	assert(
		typeof manifest.exports === "object" && manifest.exports !== null,
		`${displayName}: missing public exports`,
	);
	if (typeof manifest.exports === "object" && manifest.exports !== null) {
		assert(
			"." in manifest.exports,
			`${displayName}: missing public root entry point`,
		);
	}
	const entries = new Set<string>();
	if (manifest.main) entries.add(manifest.main);
	if (manifest.types) entries.add(manifest.types);
	for (const path of collectExportPaths(manifest.exports)) entries.add(path);
	for (const path of normalizeBin(manifest.bin)) entries.add(path);
	assert(entries.size > 0, `${displayName}: no public entry points declared`);
	for (const entry of entries) {
		assert(
			files.has(entry.replace(/^\.\//, "")),
			`${displayName}: missing public entry point ${entry}`,
		);
	}
}

function validateDependencyDeclarations(
	manifest: PackedPackageJson,
	coordinatedVersion: string,
): void {
	const displayName = manifest.name ?? "packed package";
	let effectDeclarations = 0;
	for (const sectionName of dependencySections) {
		const section = manifest[sectionName] ?? {};
		for (const [name, version] of Object.entries(section)) {
			assert(
				!version.startsWith("workspace:"),
				`${displayName}: packed ${sectionName}.${name} retained ${version}`,
			);
			assert(
				name !== "@effect/rpc",
				`${displayName}: old @effect/rpc dependency is forbidden`,
			);
			if (name.startsWith("@proseql/")) {
				assert(
					version === coordinatedVersion,
					`${displayName}: ${sectionName}.${name} must be ${coordinatedVersion}, found ${version}`,
				);
			}
			if (name === "effect") {
				effectDeclarations += 1;
				assert(
					version === EFFECT_VERSION,
					`${displayName}: ${sectionName}.effect must be exactly ${EFFECT_VERSION}, found ${version}`,
				);
			}
		}
	}
	assert(
		effectDeclarations > 0,
		`${displayName}: missing exact Effect declaration`,
	);
}

function validateRuntimeImports(
	displayName: string,
	manifest: PackedPackageJson,
	files: ReadonlyMap<string, string | Uint8Array>,
): void {
	const declared = new Set<string>();
	for (const sectionName of runtimeDependencySections) {
		for (const name of Object.keys(manifest[sectionName] ?? {}))
			declared.add(name);
	}
	for (const [path, value] of files) {
		if (!path.endsWith(".js")) continue;
		const source =
			typeof value === "string" ? value : new TextDecoder().decode(value);
		for (const specifier of collectModuleSpecifiers(source)) {
			assert(
				!specifier.startsWith("@effect/rpc"),
				`${displayName}: old @effect/rpc import is forbidden in ${path}`,
			);
			if (
				specifier.startsWith(".") ||
				specifier.startsWith("/") ||
				specifier.startsWith("file:") ||
				nodeBuiltins.has(specifier)
			) {
				continue;
			}
			const dependencyName = packageNameFromSpecifier(specifier);
			assert(
				declared.has(dependencyName),
				`${displayName}: ${path} imports undeclared runtime dependency ${dependencyName}`,
			);
		}
	}
}

export function collectModuleSpecifiers(source: string): ReadonlySet<string> {
	const specifiers = new Set<string>();
	const patterns = [
		/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
		/import\s*\(\s*["']([^"']+)["']\s*\)/g,
	] as const;
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier) specifiers.add(specifier);
		}
	}
	return specifiers;
}

function packageNameFromSpecifier(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? `${parts[0]}/${parts[1]}`
		: (parts[0] ?? specifier);
}

function collectExportPaths(value: unknown): ReadonlySet<string> {
	const paths = new Set<string>();
	const visit = (nested: unknown): void => {
		if (typeof nested === "string") {
			if (!nested.endsWith("package.json")) paths.add(nested);
			return;
		}
		if (typeof nested !== "object" || nested === null) return;
		for (const child of Object.values(nested)) visit(child);
	};
	visit(value);
	return paths;
}

function normalizeBin(bin: PackedPackageJson["bin"]): ReadonlyArray<string> {
	if (typeof bin === "string") return [bin];
	return bin ? Object.values(bin) : [];
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (import.meta.main) {
	const script = basename(import.meta.path);
	const root = resolve(dirname(import.meta.path), "..");
	console.error(
		`${script}: packed consumer verification runner is not implemented yet (${join(root, "packages")})`,
	);
	process.exit(1);
}
