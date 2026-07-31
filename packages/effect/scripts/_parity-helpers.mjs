import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRootFromImportMetaUrl = (importMetaUrl) => {
	let current = dirname(fileURLToPath(importMetaUrl));
	while (true) {
		if (
			existsSync(join(current, "package.json")) &&
			existsSync(join(current, "packages", "core", "package.json")) &&
			existsSync(join(current, "crates", "Cargo.toml"))
		) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Unable to locate proseql repo root from ${importMetaUrl}`);
		}
		current = parent;
	}
};

export const stableJson = (value) => JSON.stringify(sortJsonValue(value));

export const normalizeOutput = (text, repoRoot) => {
	const sanitized = (text ?? "")
		.replaceAll(repoRoot, "<repo>")
		.replaceAll(repoRoot.replaceAll("\\", "/"), "<repo>")
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.trim();
	if (sanitized.length === 0) return "";
	return sanitized
		.split("\n")
		.map((line) => normalizeOutputLine(line))
		.join("\n");
};

export const parseJUnitCounts = (xml) => {
	const opening = xml.match(/<testsuites[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*?(?:errors="(\d+)")?[^>]*>/) ??
		xml.match(/<testsuite[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*?(?:errors="(\d+)")?[^>]*>/);
	if (!opening) return { tests: 0, failures: 0, errors: 0 };
	return {
		tests: Number(opening[1] ?? 0),
		failures: Number(opening[2] ?? 0),
		errors: Number(opening[3] ?? 0),
	};
};

export const safeRead = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

export const ensureBuiltEngineWasm = (repoRoot) => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
};

export const resolveFromRepo = (repoRoot, ...segments) => resolve(repoRoot, ...segments);

function normalizeOutputLine(line) {
	const dynamicNormalized = line
		.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, "<iso-timestamp>")
		.replace(/^(\s*Created:\s+[^\s]+)\s+[^\s]+$/u, "$1 <generated-id>")
		.replace(/^(\s*\[afterCreate\]\s+New user:\s+"[^"]+")\s+\([^)]+\)$/u, "$1 (<generated-id>)")
		.replace(/(already exists \(id:\s+)[^)]+(\))/u, "$1<generated-id>$2")
		.replace(/^(\s*(?:UUID|NanoId|ULID|Timestamp|Prefixed|Typed):\s+).+$/u, "$1<generated-id>")
		.replace(/^(\s*(?:createdAt|updatedAt) set:\s+).+$/u, "$1<iso-timestamp>");
	const withSortedInlineJson = dynamicNormalized.replace(/\{[^{}]+\}/g, (fragment) => {
		try {
			return stableJson(JSON.parse(fragment));
		} catch {
			return fragment;
		}
	});
	const trimmed = withSortedInlineJson.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return withSortedInlineJson;
	}
	try {
		return withSortedInlineJson.replace(trimmed, stableJson(JSON.parse(trimmed)));
	} catch {
		return withSortedInlineJson;
	}
}

function sortJsonValue(value) {
	if (Array.isArray(value)) {
		return value.map(sortJsonValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, sortJsonValue(nested)]),
		);
	}
	return value;
}
