#!/usr/bin/env -S nix develop .#tooling --command bun

import { runPublishCli } from "./publish-packages.js";

try {
	await runPublishCli();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
