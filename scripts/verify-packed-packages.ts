#!/usr/bin/env -S nix develop .#tooling --command bun

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

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
	const sourceWithoutComments = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
	const patterns = [
		/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
		/import\s*\(\s*["']([^"']+)["']\s*\)/g,
	] as const;
	for (const pattern of patterns) {
		for (const match of sourceWithoutComments.matchAll(pattern)) {
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

type PackedPackage = {
	readonly packageName: CoordinatedPackageName;
	readonly manifest: PackedPackageJson;
	readonly tarballPath: string;
	readonly sha256: string;
	readonly sizeBytes: number;
};

const repoRoot = resolve(dirname(import.meta.path), "..");

export function runPackedPackageVerification(options?: {
	readonly skipBuild?: boolean;
	readonly skipConsumers?: boolean;
	readonly outputDirectory?: string;
}): ReadonlyArray<PackedPackage> {
	if (!options?.skipBuild) buildFromCleanSource();
	run("bun", ["run", "scripts/verify-package-artifacts.ts"]);
	const ownsOutputDirectory = options?.outputDirectory === undefined;
	const outputDirectory = options?.outputDirectory
		? resolve(options.outputDirectory)
		: mkdtempSync(join(tmpdir(), "proseql-packed-"));
	mkdirSync(outputDirectory, { recursive: true });
	const tarballDirectory = join(outputDirectory, "tarballs");
	const extractedDirectory = join(outputDirectory, "extracted");
	mkdirSync(tarballDirectory, { recursive: true });
	mkdirSync(extractedDirectory, { recursive: true });

	try {
		const packed = packAndInspect(tarballDirectory, extractedDirectory);
		if (!options?.skipConsumers) {
			verifyClientOnlyRpc(packed, outputDirectory);
			verifyCoordinatedNodeConsumer(packed, outputDirectory);
			verifyStrictEffectPeers(packed, outputDirectory);
			verifyBrowserConsumer(packed, outputDirectory);
		}
		for (const artifact of packed) {
			console.log(
				`✓ ${artifact.manifest.name}: ${artifact.sizeBytes} bytes sha256:${artifact.sha256}`,
			);
		}
		return packed;
	} finally {
		if (ownsOutputDirectory)
			rmSync(outputDirectory, { recursive: true, force: true });
	}
}

function buildFromCleanSource(): void {
	run("bun", ["run", "clean"]);
	run("bun", ["run", "copy-license"]);
	run("bun", ["run", "--cwd", "packages/engine", "build:wasm"]);
	run("bunx", ["tsc", "--build"]);
	run("bunx", ["tsc", "--build", "packages/rpc"]);
	chmodSync(join(repoRoot, "packages/cli/dist/main.js"), 0o755);
}

function packAndInspect(
	tarballDirectory: string,
	extractedDirectory: string,
): ReadonlyArray<PackedPackage> {
	const coordinatedVersion = readPackageJson(
		join(repoRoot, "packages/core/package.json"),
	).version;
	assert(
		typeof coordinatedVersion === "string",
		"@proseql/core is missing a coordinated version",
	);
	return COORDINATED_PACKAGE_NAMES.map((packageName) => {
		const filename = `proseql-${packageName}-${coordinatedVersion}.tgz`;
		run(
			"bun",
			[
				"pm",
				"pack",
				"--ignore-scripts",
				"--quiet",
				"--destination",
				tarballDirectory,
			],
			join(repoRoot, "packages", packageName),
		);
		const tarballPath = join(tarballDirectory, filename);
		assert(existsSync(tarballPath), `missing packed tarball ${tarballPath}`);
		const packageDirectory = join(extractedDirectory, packageName);
		mkdirSync(packageDirectory, { recursive: true });
		run("tar", [
			"-xzf",
			tarballPath,
			"--strip-components=1",
			"-C",
			packageDirectory,
		]);
		const files = readExtractedPackageFiles(packageDirectory);
		const manifestBytes = files.get("package.json");
		assert(
			manifestBytes !== undefined,
			`@proseql/${packageName}: missing package.json`,
		);
		const manifest = JSON.parse(
			typeof manifestBytes === "string"
				? manifestBytes
				: new TextDecoder().decode(manifestBytes),
		) as PackedPackageJson;
		validatePackedPackage({
			packageName,
			manifest,
			files,
			coordinatedVersion,
		});
		const bytes = readFileSync(tarballPath);
		return {
			packageName,
			manifest,
			tarballPath,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			sizeBytes: bytes.byteLength,
		};
	});
}

function readExtractedPackageFiles(
	packageDirectory: string,
): ReadonlyMap<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			assert(
				!entry.isSymbolicLink(),
				`packed package contains symlink ${path}`,
			);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				files.set(relative(packageDirectory, path), readFileSync(path));
			}
		}
	};
	visit(packageDirectory);
	return files;
}

function verifyClientOnlyRpc(
	packed: ReadonlyArray<PackedPackage>,
	outputDirectory: string,
): void {
	const consumer = createConsumer(outputDirectory, "rpc-client", packed, [
		"core",
		"rpc",
	]);
	installConsumer(consumer);
	assert(
		!existsSync(join(consumer, "node_modules/@proseql/effect")) &&
			!existsSync(join(consumer, "node_modules/@proseql/engine")),
		"definition-only RPC consumer installed the optional server peer or engine",
	);
	writeFileSync(
		join(consumer, "smoke.mjs"),
		`import { Schema } from "effect";
import { makeRpcGroup } from "@proseql/rpc";
const group = makeRpcGroup({ books: { schema: Schema.Struct({ id: Schema.String }), relationships: {} } });
if (!group) throw new Error("RPC definitions were not created");
`,
	);
	run("node", ["smoke.mjs"], consumer);
	assertInstalledPackagesAreCopies(consumer, ["core", "rpc"]);
}

function verifyCoordinatedNodeConsumer(
	packed: ReadonlyArray<PackedPackage>,
	outputDirectory: string,
): void {
	const consumer = createConsumer(
		outputDirectory,
		"node-consumer",
		packed,
		COORDINATED_PACKAGE_NAMES,
	);
	installConsumer(consumer);
	writeFileSync(join(consumer, "smoke.mjs"), nodeConsumerSmokeSource());
	run("node", ["smoke.mjs"], consumer);
	assertInstalledPackagesAreCopies(consumer, COORDINATED_PACKAGE_NAMES);
	const effectInstallations = findInstalledEffectPackages(
		join(consumer, "node_modules"),
	);
	assert(
		effectInstallations.length === 1,
		`expected one Effect installation, found ${effectInstallations.join(", ")}`,
	);
	const effectManifest = readPackageJson(
		join(effectInstallations[0] ?? "", "package.json"),
	);
	assert(
		effectManifest.version === EFFECT_VERSION,
		`resolved Effect ${String(effectManifest.version)} instead of ${EFFECT_VERSION}`,
	);
}

function verifyStrictEffectPeers(
	packed: ReadonlyArray<PackedPackage>,
	outputDirectory: string,
): void {
	for (const rejectedVersion of ["4.0.0-beta.60", "4.0.0-beta.102"]) {
		const consumer = createConsumer(
			outputDirectory,
			`effect-${rejectedVersion}`,
			packed,
			["core", "node"],
			rejectedVersion,
		);
		const result = spawnSync(
			"npm",
			[
				"install",
				"--strict-peer-deps",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
			],
			{ cwd: consumer, encoding: "utf8" },
		);
		assert(
			result.status !== 0,
			`strict install unexpectedly accepted effect@${rejectedVersion}`,
		);
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		assert(
			output.includes("ERESOLVE") || output.includes("peer effect"),
			`effect@${rejectedVersion} failed for an unexpected reason: ${output}`,
		);
	}
}

function verifyBrowserConsumer(
	packed: ReadonlyArray<PackedPackage>,
	outputDirectory: string,
): void {
	const consumer = createConsumer(outputDirectory, "browser-consumer", packed, [
		"core",
		"engine",
		"effect",
		"browser",
	]);
	const manifest = readPackageJson(join(consumer, "package.json"));
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
		'<div id="app"></div><script type="module" src="/main.js"></script>\n',
	);
	writeFileSync(join(consumer, "main.js"), browserConsumerSource());
	writeFileSync(join(consumer, "browser-smoke.mjs"), browserRunnerSource());
	run("node", ["browser-smoke.mjs"], consumer);
	assertInstalledPackagesAreCopies(consumer, [
		"core",
		"engine",
		"effect",
		"browser",
	]);
}

function createConsumer(
	outputDirectory: string,
	name: string,
	packed: ReadonlyArray<PackedPackage>,
	packageNames: ReadonlyArray<CoordinatedPackageName>,
	effectVersion = EFFECT_VERSION,
): string {
	const directory = join(outputDirectory, "consumers", name);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const dependencies: Record<string, string> = { effect: effectVersion };
	for (const packageName of packageNames) {
		const artifact = packed.find(
			(candidate) => candidate.packageName === packageName,
		);
		assert(artifact !== undefined, `missing ${packageName} tarball`);
		dependencies[`@proseql/${packageName}`] = `file:${artifact.tarballPath}`;
	}
	writeFileSync(
		join(directory, "package.json"),
		`${JSON.stringify({ name: `proseql-${name}`, private: true, type: "module", dependencies }, null, 2)}\n`,
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

function assertInstalledPackagesAreCopies(
	consumer: string,
	packageNames: ReadonlyArray<CoordinatedPackageName>,
): void {
	for (const packageName of packageNames) {
		const path = join(consumer, "node_modules/@proseql", packageName);
		assert(
			!lstatSync(path).isSymbolicLink(),
			`${path} is a repository symlink`,
		);
		assert(
			realpathSync(path).startsWith(realpathSync(consumer)),
			`${path} resolves outside the temporary consumer`,
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
					if (scoped.isDirectory())
						visit(join(path, scoped.name, "node_modules"));
				}
			} else {
				visit(join(path, "node_modules"));
			}
		}
	};
	visit(nodeModules);
	return found;
}

function readPackageJson(path: string): PackedPackageJson {
	return JSON.parse(readFileSync(path, "utf8")) as PackedPackageJson;
}

function run(
	command: string,
	args: ReadonlyArray<string>,
	cwd = repoRoot,
): void {
	execFileSync(command, args, { cwd, env: process.env, stdio: "inherit" });
}

function nodeConsumerSmokeSource(): string {
	return `import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectDatabase } from "@proseql/core";
import { createEngineDatabase } from "@proseql/engine";
import { createEffectDatabase as createWasmEffectDatabase } from "@proseql/effect";
import { createNodeDatabase } from "@proseql/node";
import { createRestHandlers } from "@proseql/rest";
import { makeRpcGroup } from "@proseql/rpc";
import { makeRpcHandlers } from "@proseql/rpc/server";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc";

const Book = Schema.Struct({ id: Schema.String, title: Schema.String });
const config = { books: { schema: Book, relationships: {} } };
const initial = { books: [{ id: "1", title: "Dune" }] };
const core = await Effect.runPromise(createEffectDatabase(config, initial));
if ((await Effect.runPromise(Stream.runCollect(core.books.query()))).length !== 1) throw new Error("core failed");
const engine = await createEngineDatabase(config, initial);
if ((await engine.books.query()).length !== 1) throw new Error("engine failed");
await engine.close();
const wasmEffect = await Effect.runPromise(createWasmEffectDatabase(config, initial));
if ((await Effect.runPromise(Stream.runCollect(wasmEffect.books.query()))).length !== 1) throw new Error("effect failed");
const validation = await Effect.runPromise(wasmEffect.books.create({ id: "bad" }).pipe(Effect.flip));
if (validation._tag !== "ValidationError") throw new Error("typed effect failure failed");
await wasmEffect.close();
const dataDir = mkdtempSync(join(tmpdir(), "proseql-packed-node-"));
const persistentConfig = { books: { ...config.books, file: join(dataDir, "books.json") } };
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* createNodeDatabase(persistentConfig);
  yield* db.books.create({ id: "n1", title: "Node" });
})));
if (!readFileSync(join(dataDir, "books.json"), "utf8").includes("Node")) throw new Error("node persistence failed");
const restDb = await Effect.runPromise(createEffectDatabase(config, initial));
const route = createRestHandlers(config, restDb).find((candidate) => candidate.method === "GET" && candidate.path === "/books");
if (!route || (await route.handler({ params: {}, query: {} })).status !== 200) throw new Error("REST failed");
const cli = execFileSync(join(process.cwd(), "node_modules/.bin/proseql"), ["--version"], { encoding: "utf8" });
if (!cli.includes("0.15.0")) throw new Error("CLI failed");

const rpcResult = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const toServer = yield* Queue.unbounded();
  const toClient = yield* Queue.unbounded();
  const disconnects = yield* Queue.unbounded();
  const clientParser = RpcSerialization.json.makeUnsafe();
  const serverParser = RpcSerialization.json.makeUnsafe();
  const roundTrip = (parser, value) => {
    const encoded = parser.encode(value);
    if (encoded === undefined) throw new Error("RPC frame missing");
    return parser.decode(encoded)[0];
  };
  const serverProtocol = RpcServer.Protocol.of({
    run: (receive) => Effect.forever(Effect.flatMap(Queue.take(toServer), ({ clientId, message }) => receive(clientId, message))),
    disconnects,
    send: (clientId, message) => Queue.offer(toClient, { clientId, message: roundTrip(serverParser, message) }),
    end: () => Effect.void,
    initialMessage: Effect.succeed(Option.none()),
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: false,
  });
  const clientProtocol = RpcClient.Protocol.of({
    run: (clientId, receive) => Effect.forever(Effect.flatMap(Queue.take(toClient), (delivery) => delivery.clientId === clientId ? receive(delivery.message) : Effect.void)),
    send: (clientId, message) => Queue.offer(toServer, { clientId, message: roundTrip(clientParser, message) }),
    supportsAck: true,
    supportsTransferables: false,
  });
  const group = makeRpcGroup(config);
  yield* RpcServer.make(group).pipe(Effect.provide(makeRpcHandlers(config, initial)), Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.forkScoped);
  const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, clientProtocol));
  const created = yield* client["books.create"]({ data: { id: "2", title: "Snow Crash" } });
  const failure = yield* client["books.findById"]({ id: "missing" }).pipe(Effect.catchTag("NotFoundError", Effect.succeed));
  const streamed = yield* Stream.runCollect(client["books.queryStream"]({ sort: { id: "asc" } }));
  return { created, failure, streamed: Array.from(streamed) };
})));
if (rpcResult.created.id !== "2" || rpcResult.failure._tag !== "NotFoundError" || rpcResult.streamed.length !== 2) throw new Error("serialized RPC failed");
`;
}

function browserConsumerSource(): string {
	return `import { createLocalStorageEngineStorageHost, createPersistentEngineDatabase } from "@proseql/browser";
import { Schema } from "effect";
const config = { books: { schema: Schema.Struct({ id: Schema.String, title: Schema.String }), file: "books.json", relationships: {} } };
const prefix = "packed-browser:";
localStorage.clear();
const first = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 1, storageHost: createLocalStorageEngineStorageHost({ keyPrefix: prefix }) });
await first.books.create({ id: "1", title: "Dune" });
await first.flush();
await first.close();
const second = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 1, storageHost: createLocalStorageEngineStorageHost({ keyPrefix: prefix }) });
const rows = await second.books.query();
await second.close();
window.__PROSEQL_PACKED_RESULT__ = rows.map((row) => ({ ...row }));
`;
}

function browserRunnerSource(): string {
	return `import { chromium } from "playwright";
import { createServer } from "vite";
const server = await createServer({ root: process.cwd(), optimizeDeps: { exclude: ["@proseql/engine"], include: ["@proseql/core", "picomatch", "hjson"] }, server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("[packed-browser-pageerror]", error));
  page.on("console", (message) => console.error("[packed-browser-console:" + message.type() + "]", message.text()));
  page.on("response", (response) => { if (response.status() >= 400) console.error("[packed-browser-response]", response.status(), response.url()); });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Array.isArray(window.__PROSEQL_PACKED_RESULT__));
  const result = await page.evaluate(() => window.__PROSEQL_PACKED_RESULT__);
  if (result.length !== 1 || result[0].title !== "Dune") throw new Error("packed browser behavior failed");
} finally {
  await browser.close();
  await server.close();
}
`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const outputIndex = args.indexOf("--output");
	runPackedPackageVerification({
		skipBuild: args.includes("--skip-build"),
		skipConsumers: args.includes("--skip-consumers"),
		outputDirectory:
			outputIndex >= 0 && args[outputIndex + 1]
				? args[outputIndex + 1]
				: undefined,
	});
	console.log(
		`${basename(import.meta.path)}: packed package verification passed`,
	);
}
