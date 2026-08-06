#!/usr/bin/env -S nix develop .#tooling --command bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { validatePreparedRelease } from "./publish-packages.js";
import type { PreparedRelease } from "./release-manifest.js";

export async function preparePublisherBundle(
	manifestPath: string,
): Promise<ReadonlyArray<string>> {
	const absoluteManifest = resolve(manifestPath);
	const releaseRoot = dirname(absoluteManifest);
	const release = JSON.parse(
		readFileSync(absoluteManifest, "utf8"),
	) as PreparedRelease;
	validatePreparedRelease(release);

	const publisherPath = join(releaseRoot, "publisher.mjs");
	const result = await Bun.build({
		entrypoints: [resolve(import.meta.dirname, "publisher-entry.ts")],
		target: "node",
		format: "esm",
		minify: false,
		sourcemap: "none",
	});
	if (!result.success || result.outputs.length !== 1) {
		const messages = result.logs.map((log) => log.message).join("\n");
		throw new Error(
			`publisher bundle failed${messages ? `: ${messages}` : ""}`,
		);
	}
	writeFileSync(
		publisherPath,
		Buffer.from(await result.outputs[0].arrayBuffer()),
	);

	const paths = [
		relative(releaseRoot, absoluteManifest),
		"publisher.mjs",
		...release.artifacts.map(({ tarball }) => tarball),
	];
	for (const path of paths) {
		if (!existsSync(join(releaseRoot, path))) {
			throw new Error(`prepared release is missing ${path}`);
		}
	}
	const checksumLines = paths.map((path) => {
		const digest = createHash("sha256")
			.update(readFileSync(join(releaseRoot, path)))
			.digest("hex");
		return `${digest}  ${path}`;
	});
	writeFileSync(
		join(releaseRoot, "SHA256SUMS"),
		`${checksumLines.join("\n")}\n`,
	);
	return paths;
}

if (import.meta.main) {
	try {
		const [manifestPath = ".artifacts/release/prepared-release.json", ...rest] =
			process.argv.slice(2);
		if (rest.length > 0) throw new Error("too many arguments");
		const paths = await preparePublisherBundle(manifestPath);
		console.log(
			`Prepared audited publisher bundle with ${paths.length} checksums.`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
