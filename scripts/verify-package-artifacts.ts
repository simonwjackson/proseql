#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
	evaluateBrowserBudget,
	validateBrowserPerformanceContract,
} from "../bench/performance-contract.js";
import {
	type CoordinatedPackageName,
	type PackedPackageJson,
	validatePackedPackage,
} from "./verify-packed-packages.js";

type PackageJson = PackedPackageJson;

type PackFile = { path: string };
type PackResult = { files: ReadonlyArray<PackFile> };

type WasmBuildContract = {
	readonly schemaVersion: string;
	readonly toolchain: {
		readonly rustTarget: string;
		readonly productionCargoProfile: string;
		readonly profileCargoProfile: string;
		readonly wasmBindgenVersion: string;
		readonly wasmOptVersion: string;
		readonly wasmOptArgs: ReadonlyArray<string>;
	};
	readonly artifactBudgets: {
		readonly browserProductionWasmGzipBaselineBytes: number;
		readonly browserProductionWasmGzipMaxGrowthRatio: number;
	};
};

type WasmBuildReport = {
	readonly schemaVersion: string;
	readonly toolchain: WasmBuildContract["toolchain"];
	readonly artifacts: Readonly<
		Record<
			string,
			{
				readonly name: string;
				readonly runtime: "node" | "browser";
				readonly cargoProfile: string;
				readonly jsPath: string;
				readonly wasmPath: string;
				readonly jsRawBytes: number;
				readonly jsGzipBytes: number;
				readonly wasmRawBytes: number;
				readonly wasmGzipBytes: number;
				readonly memoryExportPatched: boolean;
				readonly postBindgenOptimized: boolean;
				readonly debugInfoStripped: boolean;
				readonly debugNameSentinelCount: number;
			}
		>
	>;
};

const root = join(import.meta.dirname, "..");
const DEBUG_NAME_SENTINEL = Buffer.from("wasmruntime_create_database");

function runPackageArtifactVerification(): void {
	const requestedPackageNames = process.env.PROSEQL_VERIFY_PACKAGE_NAMES?.split(
		",",
	)
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const packageNames =
		requestedPackageNames && requestedPackageNames.length > 0
			? requestedPackageNames
			: ["core", "engine", "node", "rest", "effect", "cli", "browser", "rpc"];

	let failed = false;

	for (const packageName of packageNames) {
		const packageDir = join(root, "packages", packageName);
		const packageJsonPath = join(packageDir, "package.json");

		if (!existsSync(packageJsonPath)) continue;

		const packageJson = JSON.parse(
			readFileSync(packageJsonPath, "utf-8"),
		) as PackageJson;
		const displayName = packageJson.name ?? `packages/${packageName}`;
		const requiredArtifacts = requiredPackageArtifacts(packageJson);

		if (requiredArtifacts.length === 0) {
			console.log(`✓ ${displayName}: no built package artifacts declared`);
			continue;
		}

		let packageFailed = false;
		const missingOnDisk = requiredArtifacts.filter(
			(artifact) => !existsSync(join(packageDir, artifact)),
		);
		if (missingOnDisk.length > 0) {
			failed = true;
			packageFailed = true;
			console.error(
				`✗ ${displayName}: missing required built files on disk: ${missingOnDisk.join(", ")}`,
			);
			continue;
		}

		const packFiles = dryRunPack(packageDir).files.map((file) => file.path);
		const packedFileSet = new Set(packFiles);
		const missingFromPack = requiredArtifacts.filter(
			(artifact) => !packedFileSet.has(artifact),
		);

		if (missingFromPack.length > 0) {
			failed = true;
			packageFailed = true;
			console.error(
				`✗ ${displayName}: npm package would omit required files: ${missingFromPack.join(", ")}`,
			);
			continue;
		}

		const binTargets = normalizeBinTargets(packageJson.bin);
		for (const binTarget of binTargets) {
			const mode = statSync(join(packageDir, binTarget)).mode;
			if ((mode & 0o111) === 0) {
				failed = true;
				packageFailed = true;
				console.error(
					`✗ ${displayName}: bin target is not executable: ${binTarget}`,
				);
			}
		}

		if (!packageFailed) {
			try {
				const packedManifest = rewriteWorkspaceVersions(packageJson);
				validatePackedPackage({
					packageName: packageName as CoordinatedPackageName,
					manifest: packedManifest,
					files: new Map(
						packFiles.map((path) => [
							path,
							readFileSync(join(packageDir, path)),
						]),
					),
					coordinatedVersion: packageJson.version ?? "",
				});
				verifyPackageConformance(packageJson, packageDir, packedFileSet);
				console.log(`✓ ${displayName}: package artifacts verified`);
			} catch (error) {
				failed = true;
				console.error(
					`✗ ${displayName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	if (failed) process.exit(1);
}

function rewriteWorkspaceVersions(packageJson: PackageJson): PackedPackageJson {
	const version = packageJson.version ?? "";
	const rewrite = (
		dependencies: Readonly<Record<string, string>> | undefined,
	): Readonly<Record<string, string>> | undefined =>
		dependencies
			? Object.fromEntries(
					Object.entries(dependencies).map(([name, declaration]) => [
						name,
						declaration.startsWith("workspace:") ? version : declaration,
					]),
				)
			: undefined;
	return {
		...packageJson,
		dependencies: rewrite(packageJson.dependencies),
		optionalDependencies: rewrite(packageJson.optionalDependencies),
		peerDependencies: rewrite(packageJson.peerDependencies),
		devDependencies: rewrite(packageJson.devDependencies),
	};
}

function requiredPackageArtifacts(packageJson: PackageJson): string[] {
	const required = new Set<string>();

	if (packageJson.files?.includes("dist")) {
		if (packageJson.main) required.add(packageJson.main);
		if (packageJson.types) required.add(packageJson.types);
		for (const exportPath of collectExportArtifacts(packageJson.exports)) {
			required.add(exportPath);
		}
	}

	if (packageJson.name === "@proseql/engine") {
		for (const artifact of [
			"dist/wasm/proseql_wasm.js",
			"dist/wasm/proseql_wasm_bg.wasm",
			"dist/browser-wasm/proseql_wasm.js",
			"dist/browser-wasm/proseql_wasm_bg.wasm",
		]) {
			required.add(artifact);
		}
	}

	for (const binTarget of normalizeBinTargets(packageJson.bin)) {
		required.add(binTarget);
	}

	return [...required];
}

function collectExportArtifacts(exportsField: unknown): string[] {
	const results = new Set<string>();
	const visit = (value: unknown) => {
		if (typeof value === "string") {
			results.add(value);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const nested of Object.values(value as Record<string, unknown>)) {
			visit(nested);
		}
	};
	visit(exportsField);
	return [...results]
		.filter((path) => !path.endsWith("/package.json"))
		.map((path) => path.replace(/^\.\//, ""));
}

function normalizeBinTargets(bin: PackageJson["bin"]): string[] {
	if (!bin) return [];
	if (typeof bin === "string") return [bin];
	return Object.values(bin);
}

function dryRunPack(packageDir: string): PackResult {
	const output = runPackCommand(packageDir);
	const parsed = JSON.parse(output) as ReadonlyArray<PackResult>;
	const result = parsed[0];
	if (!result) {
		throw new Error(
			`npm pack --dry-run produced no package result for ${packageDir}`,
		);
	}
	return result;
}

export const npmPackDryRunArguments = [
	"pack",
	"--dry-run",
	"--json",
	"--ignore-scripts",
] as const;

export const nixNpmPackDryRunArguments = (repositoryRoot: string) => [
	"develop",
	`${repositoryRoot}#tooling`,
	"--command",
	"npm",
	...npmPackDryRunArguments,
];

function runPackCommand(packageDir: string): string {
	try {
		return execFileSync("npm", npmPackDryRunArguments, {
			cwd: packageDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (!isMissingExecutable(error)) throw error;
		return execFileSync("nix", nixNpmPackDryRunArguments(root), {
			cwd: packageDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
}

function isMissingExecutable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function verifyPackageConformance(
	packageJson: PackageJson,
	packageDir: string,
	packedFileSet: ReadonlySet<string>,
): void {
	if (packageJson.name !== "@proseql/engine") {
		return;
	}
	verifyEngineArtifacts(packageDir, packedFileSet);
}

function verifyEngineArtifacts(
	packageDir: string,
	packedFileSet: ReadonlySet<string>,
): void {
	const packageJsonPath = join(packageDir, "package.json");
	const reportPath = join(packageDir, "build", "wasm-build-report.json");
	const contract = (
		JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			readonly proseqlWasmContract: WasmBuildContract;
		}
	).proseqlWasmContract;
	const report = JSON.parse(
		readFileSync(reportPath, "utf8"),
	) as WasmBuildReport;
	if (contract.schemaVersion !== "proseql.wasm-build-contract.v1") {
		throw new Error(
			`unexpected engine wasm contract schema: ${contract.schemaVersion}`,
		);
	}
	if (report.schemaVersion !== "proseql.wasm-build-report.v2") {
		throw new Error(
			`unexpected engine wasm report schema: ${report.schemaVersion}`,
		);
	}
	if (JSON.stringify(report.toolchain) !== JSON.stringify(contract.toolchain)) {
		throw new Error(
			"engine wasm build report drifted from the checked-in contract",
		);
	}

	for (const [name, artifact] of Object.entries(report.artifacts)) {
		const jsPath = join(packageDir, artifact.jsPath);
		const wasmPath = join(packageDir, artifact.wasmPath);
		const jsSource = readFileSync(jsPath, "utf8");
		const wasmBytes = readFileSync(wasmPath);
		const actual = {
			jsRawBytes: statSync(jsPath).size,
			jsGzipBytes: measureGzipBytes(jsSource),
			wasmRawBytes: wasmBytes.byteLength,
			wasmGzipBytes: measureGzipBytes(wasmBytes),
			memoryExportPatched: jsSource.includes(
				"export function __proseql_wasm_memory()",
			),
			debugNameSentinelCount: countBufferOccurrences(
				wasmBytes,
				DEBUG_NAME_SENTINEL,
			),
		};
		for (const [key, expected] of Object.entries({
			jsRawBytes: artifact.jsRawBytes,
			jsGzipBytes: artifact.jsGzipBytes,
			wasmRawBytes: artifact.wasmRawBytes,
			wasmGzipBytes: artifact.wasmGzipBytes,
			memoryExportPatched: artifact.memoryExportPatched,
			debugNameSentinelCount: artifact.debugNameSentinelCount,
		})) {
			if (actual[key as keyof typeof actual] !== expected) {
				throw new Error(`${name} ${key} drifted from the built artifact`);
			}
		}
		if (name.endsWith("Production")) {
			if (jsSource.includes("__proseql_test_panic_bridge")) {
				throw new Error(
					`${name} unexpectedly exposes the panic integration test bridge`,
				);
			}
			if (!artifact.postBindgenOptimized || !artifact.debugInfoStripped) {
				throw new Error(
					`${name} must be marked post-bindgen optimized and debug-info stripped`,
				);
			}
			if (
				!artifact.jsPath.startsWith("dist/") ||
				!artifact.wasmPath.startsWith("dist/")
			) {
				throw new Error(`${name} must ship from dist/`);
			}
		} else {
			if (artifact.postBindgenOptimized || artifact.debugInfoStripped) {
				throw new Error(`${name} must remain readable local build evidence`);
			}
			if (
				!artifact.jsPath.startsWith("build/") ||
				!artifact.wasmPath.startsWith("build/")
			) {
				throw new Error(`${name} must stay outside dist/`);
			}
		}
	}

	assertProductionSmallerThanProfile(report, "nodeProduction", "nodeProfile");
	assertProductionSmallerThanProfile(
		report,
		"browserProduction",
		"browserProfile",
	);
	assertProfileKeepsMoreDebugNames(report, "nodeProduction", "nodeProfile");
	assertProfileKeepsMoreDebugNames(
		report,
		"browserProduction",
		"browserProfile",
	);

	const browserProduction = report.artifacts.browserProduction;
	if (!browserProduction) {
		throw new Error("missing browserProduction artifact in engine wasm report");
	}
	const maxBrowserGzipBytes = Math.floor(
		contract.artifactBudgets.browserProductionWasmGzipBaselineBytes *
			contract.artifactBudgets.browserProductionWasmGzipMaxGrowthRatio,
	);
	if (browserProduction.wasmGzipBytes > maxBrowserGzipBytes) {
		throw new Error(
			`browser production wasm gzip ${browserProduction.wasmGzipBytes} exceeded ${maxBrowserGzipBytes}`,
		);
	}

	for (const forbiddenPath of [
		"build/wasm-profile/proseql_wasm.js",
		"build/wasm-profile/proseql_wasm_bg.wasm",
		"build/browser-wasm-profile/proseql_wasm.js",
		"build/browser-wasm-profile/proseql_wasm_bg.wasm",
		"build/wasm-panic-test/proseql_wasm.js",
		"build/wasm-panic-test/proseql_wasm_bg.wasm",
		"build/wasm-build-report.json",
	]) {
		if (packedFileSet.has(forbiddenPath)) {
			throw new Error(
				`npm package unexpectedly included local build evidence: ${forbiddenPath}`,
			);
		}
	}
}

function assertProductionSmallerThanProfile(
	report: WasmBuildReport,
	productionKey: string,
	profileKey: string,
): void {
	const production = report.artifacts[productionKey];
	const profile = report.artifacts[profileKey];
	if (!production || !profile) {
		throw new Error(
			`missing engine artifact pair: ${productionKey}/${profileKey}`,
		);
	}
	if (production.wasmRawBytes >= profile.wasmRawBytes) {
		throw new Error(`${productionKey} was not smaller than ${profileKey}`);
	}
}

function assertProfileKeepsMoreDebugNames(
	report: WasmBuildReport,
	productionKey: string,
	profileKey: string,
): void {
	const production = report.artifacts[productionKey];
	const profile = report.artifacts[profileKey];
	if (!production || !profile) {
		throw new Error(
			`missing engine artifact pair: ${productionKey}/${profileKey}`,
		);
	}
	if (production.debugNameSentinelCount >= profile.debugNameSentinelCount) {
		throw new Error(
			`${profileKey} did not retain more readable debug names than ${productionKey}`,
		);
	}
}

function measureGzipBytes(value: string | Buffer): number {
	return gzipSync(value, { level: 9, mtime: 0 }).byteLength;
}

function countBufferOccurrences(buffer: Buffer, needle: Buffer): number {
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

type BrowserPerformanceJsonOutput = {
	readonly report: Parameters<typeof evaluateBrowserBudget>[0]["report"];
	readonly contract: ReturnType<typeof validateBrowserPerformanceContract>;
};

type U2BrowserEvidenceOptions = {
	readonly currentBrowserReportPath?: string;
	readonly outputPath?: string;
	readonly buildReportPath?: string;
	readonly contractPath?: string;
};

const DEFAULT_CURRENT_BROWSER_REPORT_PATH =
	"bench/reports/u2-browser-current.json";
const DEFAULT_EVIDENCE_OUTPUT_PATH = "bench/reports/u2-browser-evidence.json";
const DEFAULT_BUILD_REPORT_PATH =
	"packages/engine/build/wasm-build-report.json";
const DEFAULT_CONTRACT_PATH = "packages/engine/package.json";
const DEFAULT_EVIDENCE_COMMAND = "bun run generate:u2-browser-evidence";
const DEFAULT_BROWSER_REPORT_COMMAND =
	"bun run bench:browser-report > bench/reports/u2-browser-current.json";
const DEFAULT_BUILD_REPORT_COMMAND = "bun run --cwd packages/engine build:wasm";
const ABSOLUTE_INTERACTION_P95_BUDGET_MS = 50;

function readArgValue(
	args: ReadonlyArray<string>,
	flag: string,
): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function readJsonFromRoot<T>(path: string): T {
	return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}

function assertEmbeddedBrowserContractIsCurrent(
	report: BrowserPerformanceJsonOutput,
): ReturnType<typeof validateBrowserPerformanceContract> {
	const validation = validateBrowserPerformanceContract(report.report);
	if (JSON.stringify(validation) !== JSON.stringify(report.contract)) {
		throw new Error(
			"Current browser report contract drifted from validateBrowserPerformanceContract(report)",
		);
	}
	return validation;
}

function generateU2BrowserEvidence(options: U2BrowserEvidenceOptions = {}) {
	const currentBrowserReportPath =
		options.currentBrowserReportPath ?? DEFAULT_CURRENT_BROWSER_REPORT_PATH;
	const outputPath = options.outputPath ?? DEFAULT_EVIDENCE_OUTPUT_PATH;
	const buildReportPath = options.buildReportPath ?? DEFAULT_BUILD_REPORT_PATH;
	const contractPath = options.contractPath ?? DEFAULT_CONTRACT_PATH;
	const currentBrowserReport = readJsonFromRoot<BrowserPerformanceJsonOutput>(
		currentBrowserReportPath,
	);
	const currentBrowserContract =
		assertEmbeddedBrowserContractIsCurrent(currentBrowserReport);
	const buildReport = readJsonFromRoot<WasmBuildReport>(buildReportPath);
	const contract = (
		readJsonFromRoot(contractPath) as {
			readonly proseqlWasmContract: WasmBuildContract;
		}
	).proseqlWasmContract;
	const browserProductionArtifact = buildReport.artifacts.browserProduction;
	if (!browserProductionArtifact) {
		throw new Error("Missing browserProduction artifact in WASM build report");
	}
	const evaluation = evaluateBrowserBudget({
		contract,
		report: currentBrowserReport.report,
		currentArtifactGzipBytes: browserProductionArtifact.wasmGzipBytes,
	});
	return {
		schemaVersion: "proseql.u2-browser-evidence.v2",
		sources: {
			contract: {
				path: contractPath,
				jsonPointer: "/proseqlWasmContract",
			},
			buildReport: {
				path: buildReportPath,
				command: DEFAULT_BUILD_REPORT_COMMAND,
			},
			currentBrowserReport: {
				path: currentBrowserReportPath,
				command: DEFAULT_BROWSER_REPORT_COMMAND,
			},
			evidence: {
				path: outputPath,
				command: DEFAULT_EVIDENCE_COMMAND,
			},
		},
		browserProductionArtifact: {
			wasmPath: browserProductionArtifact.wasmPath,
			gzipBytes: browserProductionArtifact.wasmGzipBytes,
		},
		currentBrowserContract,
		artifact: {
			...evaluation.artifact,
			deltaBytes:
				typeof evaluation.artifact.current === "number"
					? evaluation.artifact.current - evaluation.artifact.baseline
					: undefined,
			deltaRatio:
				typeof evaluation.artifact.current === "number" &&
				evaluation.artifact.baseline !== 0
					? (evaluation.artifact.current - evaluation.artifact.baseline) /
						evaluation.artifact.baseline
					: undefined,
		},
		coldStartupMs: {
			...evaluation.coldStartup,
			deltaMs:
				typeof evaluation.coldStartup.current === "number"
					? evaluation.coldStartup.current - evaluation.coldStartup.baseline
					: undefined,
			deltaRatio:
				typeof evaluation.coldStartup.current === "number" &&
				evaluation.coldStartup.baseline !== 0
					? (evaluation.coldStartup.current - evaluation.coldStartup.baseline) /
						evaluation.coldStartup.baseline
					: undefined,
		},
		jsHeapBytes: {
			...evaluation.jsHeap,
			deltaBytes:
				typeof evaluation.jsHeap.current === "number"
					? evaluation.jsHeap.current - evaluation.jsHeap.baseline
					: undefined,
			deltaRatio:
				typeof evaluation.jsHeap.current === "number" &&
				evaluation.jsHeap.baseline !== 0
					? (evaluation.jsHeap.current - evaluation.jsHeap.baseline) /
						evaluation.jsHeap.baseline
					: undefined,
		},
		wasmLinearMemoryBytes: {
			...evaluation.wasmLinearMemory,
			deltaBytes:
				typeof evaluation.wasmLinearMemory.current === "number"
					? evaluation.wasmLinearMemory.current -
						evaluation.wasmLinearMemory.baseline
					: undefined,
			deltaRatio:
				typeof evaluation.wasmLinearMemory.current === "number" &&
				evaluation.wasmLinearMemory.baseline !== 0
					? (evaluation.wasmLinearMemory.current -
							evaluation.wasmLinearMemory.baseline) /
						evaluation.wasmLinearMemory.baseline
					: undefined,
		},
		interactions: evaluation.interactions.map((interaction) => ({
			...interaction,
			absoluteP95BudgetMs: ABSOLUTE_INTERACTION_P95_BUDGET_MS,
		})),
		summary: evaluation.summary,
	};
}

function renderU2BrowserEvidence(evidence: unknown): string {
	return `${JSON.stringify(evidence, null, 2)}\n`;
}

function writeCheckedInU2BrowserEvidence(
	options: U2BrowserEvidenceOptions = {},
): void {
	const outputPath = options.outputPath ?? DEFAULT_EVIDENCE_OUTPUT_PATH;
	writeFileSync(
		resolve(root, outputPath),
		renderU2BrowserEvidence(generateU2BrowserEvidence(options)),
	);
}

function validateCheckedInU2BrowserEvidence(
	options: U2BrowserEvidenceOptions = {},
): void {
	const outputPath = options.outputPath ?? DEFAULT_EVIDENCE_OUTPUT_PATH;
	const expected = renderU2BrowserEvidence(generateU2BrowserEvidence(options));
	const actual = readFileSync(resolve(root, outputPath), "utf8");
	if (actual !== expected) {
		throw new Error(
			`Checked-in U2 browser evidence drifted from generated output: ${outputPath}`,
		);
	}
}

if (import.meta.main) {
	const cliArgs = process.argv.slice(2);
	if (
		cliArgs.includes("--u2-browser-evidence-write") ||
		cliArgs.includes("--u2-browser-evidence-check")
	) {
		const evidenceOptions = {
			currentBrowserReportPath: readArgValue(cliArgs, "--current-report"),
			outputPath: readArgValue(cliArgs, "--output"),
			buildReportPath: readArgValue(cliArgs, "--build-report"),
			contractPath: readArgValue(cliArgs, "--contract"),
		};
		if (cliArgs.includes("--u2-browser-evidence-write")) {
			writeCheckedInU2BrowserEvidence(evidenceOptions);
			console.log(
				`Wrote ${evidenceOptions.outputPath ?? DEFAULT_EVIDENCE_OUTPUT_PATH}`,
			);
		} else {
			validateCheckedInU2BrowserEvidence(evidenceOptions);
			console.log(
				`Verified ${evidenceOptions.outputPath ?? DEFAULT_EVIDENCE_OUTPUT_PATH}`,
			);
		}
		process.exit(0);
	}

	runPackageArtifactVerification();
}
