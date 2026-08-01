#!/usr/bin/env node
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const packageDir = resolve(here, "..");
const repoRoot = resolve(packageDir, "..", "..");
const cratesDir = join(repoRoot, "crates");
const wasmCrate = join(cratesDir, "proseql-wasm", "Cargo.toml");
const packageJsonPath = join(packageDir, "package.json");
const buildDir = join(packageDir, "build");
const buildReportPath = join(buildDir, "wasm-build-report.json");
const nodeOutDir = join(packageDir, "dist", "wasm");
const browserOutDir = join(packageDir, "dist", "browser-wasm");
const nodeProfileOutDir = join(buildDir, "wasm-profile");
const browserProfileOutDir = join(buildDir, "browser-wasm-profile");
const panicTestOutDir = join(buildDir, "wasm-panic-test");
const panicTestCargoTargetDir = join(buildDir, ".panic-cargo-target");
const panicTestBrowserBindgenDir = join(buildDir, ".tmp", "wasm-panic-test-browser");
const nodeProductionBindgenDir = join(buildDir, ".tmp", "wasm-production-node");
const browserProductionBindgenDir = join(buildDir, ".tmp", "wasm-production-browser");
const debugNameSentinel = "wasmruntime_create_database";

/** @type {{
 * name?: string,
 * proseqlWasmContract: {
 *   schemaVersion: string,
 *   toolchain: {
 *     rustTarget: string,
 *     productionCargoProfile: string,
 *     profileCargoProfile: string,
 *     wasmBindgenVersion: string,
 *     wasmOptVersion: string,
 *     wasmOptArgs: string[],
 *   },
 *   artifactBudgets: {
 *     browserProductionWasmGzipBaselineBytes: number,
 *     browserProductionWasmGzipMaxGrowthRatio: number,
 *   },
 *   browserBudgets: {
 *     baseline: {
 *       coldStartupMs: number,
 *       jsHeapBytes: number,
 *       wasmLinearMemoryBytes: number,
 *     },
 *     coldStartupMaxGrowthRatio: number,
 *     jsHeapMaxGrowthRatio: number,
 *     wasmLinearMemoryMaxGrowthRatio: number,
 *   },
 * },
 * }} */
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const contract = packageJson.proseqlWasmContract;
const {
	rustTarget,
	productionCargoProfile,
	profileCargoProfile,
	wasmBindgenVersion,
	wasmOptVersion,
	wasmOptArgs,
} = contract.toolchain;
const productionTargetWasm = join(
	cratesDir,
	"target",
	rustTarget,
	productionCargoProfile,
	"proseql_wasm.wasm",
);
const profileTargetWasm = join(
	cratesDir,
	"target",
	rustTarget,
	profileCargoProfile,
	"proseql_wasm.wasm",
);
const panicTestTargetWasm = join(
	panicTestCargoTargetDir,
	rustTarget,
	productionCargoProfile,
	"proseql_wasm.wasm",
);
const prebuiltArtifactsDir = process.env.PROSEQL_PREBUILT_WASM_ARTIFACTS_DIR;

if (prebuiltArtifactsDir) {
	if (hasPreparedArtifacts()) {
		process.exit(0);
	}
	restorePrebuiltArtifacts(prebuiltArtifactsDir);
	process.exit(0);
}

ensureToolingShell();

const bindgenBin = requireEnv("PROSEQL_WASM_BINDGEN_BIN");
const wasmOptBin = requireEnv("PROSEQL_WASM_OPT_BIN");
const linker = requireEnv("CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER");

assertExactVersion(bindgenBin, ["--version"], `wasm-bindgen ${wasmBindgenVersion}`);
assertVersionContains(wasmOptBin, ["--version"], wasmOptVersion);

for (const directory of [
	nodeOutDir,
	browserOutDir,
	nodeProfileOutDir,
	browserProfileOutDir,
	panicTestOutDir,
	panicTestBrowserBindgenDir,
	nodeProductionBindgenDir,
	browserProductionBindgenDir,
]) {
	cleanDirectory(directory);
}
mkdirSync(dirname(buildReportPath), { recursive: true });

for (const cargoProfile of [productionCargoProfile, profileCargoProfile]) {
	run("cargo", [
		"build",
		"--manifest-path",
		wasmCrate,
		"-p",
		"proseql-wasm",
		"--target",
		rustTarget,
		"--profile",
		cargoProfile,
	], {
		env: {
			...process.env,
			CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER: linker,
		},
	});
}

assertExists(productionTargetWasm, "compiled production wasm artifact");
assertExists(profileTargetWasm, "compiled profile wasm artifact");

bindgen({
	bindgenBin,
	targetWasm: productionTargetWasm,
	nodeOutDir: nodeProductionBindgenDir,
	browserOutDir: browserProductionBindgenDir,
});
bindgen({
	bindgenBin,
	targetWasm: profileTargetWasm,
	nodeOutDir: nodeProfileOutDir,
	browserOutDir: browserProfileOutDir,
});

for (const jsPath of [
	join(nodeProductionBindgenDir, "proseql_wasm.js"),
	join(browserProductionBindgenDir, "proseql_wasm.js"),
	join(nodeProfileOutDir, "proseql_wasm.js"),
	join(browserProfileOutDir, "proseql_wasm.js"),
]) {
	patchGeneratedBindings(jsPath);
}

copyArtifactDirectory(nodeProductionBindgenDir, nodeOutDir);
copyArtifactDirectory(browserProductionBindgenDir, browserOutDir);
optimizeProductionWasm(wasmOptBin, join(nodeOutDir, "proseql_wasm_bg.wasm"));
optimizeProductionWasm(wasmOptBin, join(browserOutDir, "proseql_wasm_bg.wasm"));

run("cargo", [
	"build",
	"--manifest-path",
	wasmCrate,
	"-p",
	"proseql-wasm",
	"--target",
	rustTarget,
	"--profile",
	productionCargoProfile,
	"--features",
	"panic-integration-test",
], {
	env: {
		...process.env,
		CARGO_TARGET_DIR: panicTestCargoTargetDir,
		CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER: linker,
	},
});
bindgen({
	bindgenBin,
	targetWasm: panicTestTargetWasm,
	nodeOutDir: panicTestOutDir,
	browserOutDir: panicTestBrowserBindgenDir,
});
patchGeneratedBindings(join(panicTestOutDir, "proseql_wasm.js"));
optimizeProductionWasm(wasmOptBin, join(panicTestOutDir, "proseql_wasm_bg.wasm"));
rmSync(join(buildDir, ".tmp"), { recursive: true, force: true });

const report = buildArtifactsReport();
assertBrowserProductionBudget(report.artifacts.browserProduction);
writeFileSync(buildReportPath, `${JSON.stringify(report, null, 2)}\n`);

function hasPreparedArtifacts() {
	return [
		join(nodeOutDir, "proseql_wasm.js"),
		join(nodeOutDir, "proseql_wasm_bg.wasm"),
		join(browserOutDir, "proseql_wasm.js"),
		join(browserOutDir, "proseql_wasm_bg.wasm"),
		join(nodeProfileOutDir, "proseql_wasm.js"),
		join(browserProfileOutDir, "proseql_wasm.js"),
		join(panicTestOutDir, "proseql_wasm.js"),
		join(panicTestOutDir, "proseql_wasm_bg.wasm"),
		buildReportPath,
	].every((path) => existsSync(path));
}

function restorePrebuiltArtifacts(prebuiltDir) {
	for (const directory of [
		nodeOutDir,
		browserOutDir,
		nodeProfileOutDir,
		browserProfileOutDir,
		panicTestOutDir,
	]) {
		cleanDirectory(directory);
	}
	copyArtifactDirectory(join(prebuiltDir, "dist", "wasm"), nodeOutDir);
	copyArtifactDirectory(join(prebuiltDir, "dist", "browser-wasm"), browserOutDir);
	copyArtifactDirectory(join(prebuiltDir, "build", "wasm-profile"), nodeProfileOutDir);
	copyArtifactDirectory(join(prebuiltDir, "build", "browser-wasm-profile"), browserProfileOutDir);
	copyArtifactDirectory(join(prebuiltDir, "build", "wasm-panic-test"), panicTestOutDir);
	mkdirSync(dirname(buildReportPath), { recursive: true });
	cpSync(join(prebuiltDir, "build", "wasm-build-report.json"), buildReportPath);
}

function ensureToolingShell() {
	if (process.env.PROSEQL_NIX_TOOLING === "1") {
		return;
	}
	if (!hasExecutable("nix")) {
		throw new Error(
			"Missing pinned WASM tooling environment. Enter `nix develop .#tooling` or install nix to run the pinned build shell.",
		);
	}
	run("nix", ["develop", `${repoRoot}#tooling`, "--command", process.execPath, scriptPath], {
		stdio: "inherit",
	});
	process.exit(0);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required build environment variable: ${name}`);
	}
	return value;
}

function hasExecutable(name) {
	try {
		execFileSync("sh", ["-lc", `command -v ${name}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function cleanDirectory(path) {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
}

function assertExists(path, description) {
	if (!existsSync(path)) {
		throw new Error(`Missing ${description}: ${path}`);
	}
}

function bindgen({ bindgenBin: currentBindgenBin, targetWasm, nodeOutDir: currentNodeOutDir, browserOutDir: currentBrowserOutDir }) {
	run(currentBindgenBin, [
		"--target",
		"experimental-nodejs-module",
		"--out-dir",
		currentNodeOutDir,
		targetWasm,
	]);
	run(currentBindgenBin, [
		"--target",
		"web",
		"--out-dir",
		currentBrowserOutDir,
		targetWasm,
	]);
}

function copyArtifactDirectory(from, to) {
	rmSync(to, { recursive: true, force: true });
	cpSync(from, to, { recursive: true });
}

function optimizeProductionWasm(wasmOptExecutable, wasmPath) {
	const optimizedPath = `${wasmPath}.optimized`;
	run(wasmOptExecutable, [wasmPath, ...wasmOptArgs, "-o", optimizedPath]);
	rmSync(wasmPath, { force: true });
	cpSync(optimizedPath, wasmPath);
	rmSync(optimizedPath, { force: true });
}

function assertExactVersion(command, args, expected) {
	const version = execFileSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (version !== expected) {
		throw new Error(`Expected ${expected} but found ${version} at ${command}`);
	}
}

function assertVersionContains(command, args, expectedSubstring) {
	const version = execFileSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!version.includes(expectedSubstring)) {
		throw new Error(
			`Expected ${command} version output to include ${expectedSubstring}, got: ${version}`,
		);
	}
}

function buildArtifactsReport() {
	return {
		schemaVersion: "proseql.wasm-build-report.v2",
		toolchain: {
			rustTarget,
			productionCargoProfile,
			profileCargoProfile,
			wasmBindgenVersion,
			wasmOptVersion,
			wasmOptArgs,
		},
		artifacts: {
			nodeProduction: summarizeArtifact({
				name: "nodeProduction",
				runtime: "node",
				cargoProfile: productionCargoProfile,
				directory: nodeOutDir,
				postBindgenOptimized: true,
				debugInfoStripped: true,
			}),
			nodeProfile: summarizeArtifact({
				name: "nodeProfile",
				runtime: "node",
				cargoProfile: profileCargoProfile,
				directory: nodeProfileOutDir,
				postBindgenOptimized: false,
				debugInfoStripped: false,
			}),
			browserProduction: summarizeArtifact({
				name: "browserProduction",
				runtime: "browser",
				cargoProfile: productionCargoProfile,
				directory: browserOutDir,
				postBindgenOptimized: true,
				debugInfoStripped: true,
			}),
			browserProfile: summarizeArtifact({
				name: "browserProfile",
				runtime: "browser",
				cargoProfile: profileCargoProfile,
				directory: browserProfileOutDir,
				postBindgenOptimized: false,
				debugInfoStripped: false,
			}),
		},
	};
}

function summarizeArtifact({
	name,
	runtime,
	cargoProfile,
	directory,
	postBindgenOptimized,
	debugInfoStripped,
}) {
	const jsPath = join(directory, "proseql_wasm.js");
	const wasmPath = join(directory, "proseql_wasm_bg.wasm");
	const jsSource = readFileSync(jsPath, "utf8");
	const wasmBytes = readFileSync(wasmPath);
	return {
		name,
		runtime,
		cargoProfile,
		jsPath: relative(packageDir, jsPath),
		wasmPath: relative(packageDir, wasmPath),
		jsRawBytes: statSync(jsPath).size,
		jsGzipBytes: measureGzipBytes(jsSource),
		wasmRawBytes: wasmBytes.byteLength,
		wasmGzipBytes: measureGzipBytes(wasmBytes),
		memoryExportPatched: jsSource.includes("export function __proseql_wasm_memory()"),
		postBindgenOptimized,
		debugInfoStripped,
		debugNameSentinelCount: countBufferOccurrences(
			wasmBytes,
			Buffer.from(debugNameSentinel),
		),
	};
}

function assertBrowserProductionBudget(browserProductionArtifact) {
	const baselineBytes = contract.artifactBudgets.browserProductionWasmGzipBaselineBytes;
	const maxBytes = Math.floor(
		baselineBytes * contract.artifactBudgets.browserProductionWasmGzipMaxGrowthRatio,
	);
	if (browserProductionArtifact.wasmGzipBytes > maxBytes) {
		throw new Error(
			`browser production wasm gzip ${browserProductionArtifact.wasmGzipBytes} exceeded budget ${maxBytes} bytes (baseline ${baselineBytes})`,
		);
	}
}

function measureGzipBytes(value) {
	return gzipSync(value, { level: 9, mtime: 0 }).byteLength;
}

function countBufferOccurrences(buffer, needle) {
	let count = 0;
	let offset = 0;
	while (offset <= buffer.length - needle.length) {
		const index = buffer.indexOf(needle, offset);
		if (index === -1) {
			break;
		}
		count += 1;
		offset = index + needle.length;
	}
	return count;
}

function patchGeneratedBindings(path) {
	const source = readFileSync(path, "utf8");
	if (source.includes("const __proseql_wasm_defect_response =")) {
		return;
	}
	let patched = source;
	if (patched.includes("export function __proseql_test_panic_bridge() {")) {
		patched = patched.replace(
			"export function __proseql_test_panic_bridge() {",
			"function __proseql_test_panic_bridge_raw() {",
		);
	}
	writeFileSync(
		path,
		`${patched}\nconst __proseql_wasm_defect_response = (error) => JSON.stringify({ kind: \"defect\", message: \"unexpected defect: \" + (error instanceof Error ? error.message : String(error)) });\nconst __proseql_wasm_wrap_string_method = (prototype, name) => {\n    const original = prototype?.[name];\n    if (typeof original !== \"function\") {\n        return;\n    }\n    prototype[name] = function (...args) {\n        try {\n            return original.apply(this, args);\n        } catch (error) {\n            return __proseql_wasm_defect_response(error);\n        }\n    };\n};\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"create_database\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"dispatch\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"drop_database\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"dry_run_migrations\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"register_custom_operator\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"subscribe_watch\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"subscribe_watch_by_id\");\n__proseql_wasm_wrap_string_method(WasmRuntime.prototype, \"unsubscribe\");\nexport function __proseql_wasm_memory() {\n    return wasm?.memory;\n}\n${patched.includes("function __proseql_test_panic_bridge_raw() {") ? "export function __proseql_test_panic_bridge() {\n    try {\n        return __proseql_test_panic_bridge_raw();\n    } catch (_error) {\n        return JSON.stringify({ kind: \"defect\", message: \"unexpected defect: proseql wasm panic integration\" });\n    }\n}\n" : ""}`,
	);
}

function run(command, args, options = {}) {
	execFileSync(command, args, {
		cwd: repoRoot,
		stdio: options.stdio ?? "inherit",
		env: options.env ?? { ...process.env },
	});
}
