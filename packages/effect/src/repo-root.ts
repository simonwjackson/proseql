import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRootFromImportMetaUrl = (importMetaUrl: string): string => {
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
