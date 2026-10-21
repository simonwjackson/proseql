import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
			throw new Error(
				`Unable to locate proseql repo root from ${importMetaUrl}`,
			);
		}
		current = parent;
	}
};

export const ensureBuiltEngineWasm = (repoRoot) => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
};
