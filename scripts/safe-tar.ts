import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const TAR_COMMAND_TIMEOUT_MS = 30_000;

export type TarInspectionOptions = {
	readonly timeoutMs?: number;
	/** Override only for hermetic tests or controlled tooling environments. */
	readonly tarExecutable?: string;
};

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function prepareExtractionDirectory(destinationDirectory: string): string {
	const root = resolve(destinationDirectory);
	const parent = dirname(root);
	assert(
		root !== parent,
		`${root}: extraction root cannot be a filesystem root`,
	);
	mkdirSync(parent, { recursive: true });
	const parentEntry = lstatSync(parent);
	assert(
		parentEntry.isDirectory() && !parentEntry.isSymbolicLink(),
		`${parent}: extraction parent must be a real directory`,
	);

	if (existsSync(root)) {
		const rootEntry = lstatSync(root);
		assert(
			rootEntry.isDirectory() && !rootEntry.isSymbolicLink(),
			`${root}: extraction root must be a real directory`,
		);
		rmSync(root, { recursive: true, force: false });
	}
	mkdirSync(root);

	const realParent = realpathSync(parent);
	const realRoot = realpathSync(root);
	const expectedRoot = join(realParent, basename(root));
	assert(
		realRoot === expectedRoot && realRoot.startsWith(`${realParent}${sep}`),
		`${root}: extraction root resolves outside its parent`,
	);
	return realRoot;
}

function runBoundedTar(
	tarExecutable: string,
	args: ReadonlyArray<string>,
	timeoutMs: number,
	phase: "listing" | "extraction",
	stdio: "inherit" | ["ignore", "pipe", "pipe"],
): string {
	try {
		const output = execFileSync(tarExecutable, args, {
			encoding: "utf8",
			stdio,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		return typeof output === "string" ? output : "";
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ETIMEDOUT"
		) {
			throw new Error(`tar ${phase} timed out after ${timeoutMs}ms`, {
				cause: error,
			});
		}
		throw error;
	}
}

export function inspectAndExtractTarball(
	tarballPath: string,
	destinationDirectory: string,
	options: TarInspectionOptions = {},
): void {
	const timeoutMs = options.timeoutMs ?? TAR_COMMAND_TIMEOUT_MS;
	assert(
		Number.isInteger(timeoutMs) && timeoutMs > 0,
		"tar command timeout must be a positive integer",
	);
	const tarExecutable = options.tarExecutable ?? "tar";
	assert(tarExecutable.length > 0, "tar executable must not be empty");

	const list = (verbose: boolean): ReadonlyArray<string> => {
		const output = runBoundedTar(
			tarExecutable,
			[
				verbose ? "-tvzf" : "-tzf",
				tarballPath,
				"--quoting-style=escape",
				...(verbose ? ["--numeric-owner"] : []),
			],
			timeoutMs,
			"listing",
			["ignore", "pipe", "pipe"],
		);
		return output.split("\n").filter((line) => line.length > 0);
	};

	const names = list(false);
	const verbose = list(true);
	assert(names.length > 0, `${tarballPath}: empty tarball`);
	assert(
		names.length === verbose.length,
		`${tarballPath}: inconsistent tar member listing`,
	);
	const root = resolve(destinationDirectory);
	const seen = new Set<string>();
	for (let index = 0; index < names.length; index += 1) {
		const name = names[index];
		assert(name !== undefined, `${tarballPath}: missing tar member name`);
		assert(
			!name.includes("\\"),
			`${tarballPath}: escaped or platform-specific tar member ${name}`,
		);
		assert(!isAbsolute(name), `${tarballPath}: absolute tar member ${name}`);
		const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
		const parts = withoutTrailingSlash.split("/");
		assert(
			parts[0] === "package",
			`${tarballPath}: tar member must be rooted at package/: ${name}`,
		);
		assert(
			parts.every((part) => part !== "." && part !== ".." && part.length > 0),
			`${tarballPath}: traversal tar member ${name}`,
		);
		const relativeParts = parts.slice(1);
		const outputPath = resolve(root, ...relativeParts);
		assert(
			outputPath === root || outputPath.startsWith(`${root}${sep}`),
			`${tarballPath}: tar member resolves outside extraction root: ${name}`,
		);
		assert(
			!seen.has(outputPath),
			`${tarballPath}: duplicate tar member ${name}`,
		);
		seen.add(outputPath);
		const type = verbose[index]?.[0];
		assert(
			type === "-" || type === "d",
			`${tarballPath}: unsupported tar member type ${String(type)} for ${name}`,
		);
		if (relativeParts.length === 0) {
			assert(type === "d", `${tarballPath}: package root must be a directory`);
		}
	}

	const preparedRoot = prepareExtractionDirectory(root);
	runBoundedTar(
		tarExecutable,
		[
			"-xzf",
			tarballPath,
			"--strip-components=1",
			"--no-same-owner",
			"--no-same-permissions",
			"--delay-directory-restore",
			"--no-overwrite-dir",
			"-C",
			preparedRoot,
		],
		timeoutMs,
		"extraction",
		"inherit",
	);
}
