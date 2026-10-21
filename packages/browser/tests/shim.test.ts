import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as replacement from "@proseql/effect/browser";
import * as shim from "../src/index.js";

// Namespace imports also check every inherited core and Effect export.
test("the deprecated browser entry preserves every export by identity", () => {
	expect(Object.keys(shim).sort()).toEqual(Object.keys(replacement).sort());
	for (const name of Object.keys(shim) as Array<keyof typeof shim>) {
		expect(shim[name]).toBe(replacement[name]);
	}
	for (const name of [
		"BrowserStorageLayer",
		"IndexedDBStorageLayer",
		"LocalStorageLayer",
		"makeIndexedDBAdapter",
		"makeIndexedDBStorageLayer",
		"makeLocalStorageAdapter",
		"makeLocalStorageLayer",
		"makeSessionStorageAdapter",
		"makeSessionStorageLayer",
		"makeWebStorageAdapter",
		"SessionStorageLayer",
		"getFileExtension",
		"validateAllowedFormat",
		"DEFAULT_STORAGE_KEY_PREFIX",
		"pathToKey",
		"createEngineDatabase",
		"createEngineStorageAdapter",
		"createIndexedDBEngineStorageHost",
		"createLocalStorageEngineStorageHost",
		"createPersistentEngineDatabase",
		"createSessionStorageEngineStorageHost",
		"createWebStorageEngineStorageHost",
		"makeEngineStorageLayer",
		"createEffectDatabase",
		"createPersistentEffectDatabase",
		"WasmEngineDefectError",
	] as const) {
		expect(shim[name]).toBeDefined();
	}
});

test("the deprecated worker entry preserves every export by identity", () => {
	// Use the shim's package self-reference, not optional root workspace links.
	// Node also loads the built worker glue rather than Bun's source-only aliases.
	execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			`
  import assert from "node:assert/strict";
  import { realpathSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import * as replacement from "@proseql/effect/browser/worker";
  import * as shim from "@proseql/browser/worker";
  assert.equal(fileURLToPath(import.meta.resolve("@proseql/browser")), realpathSync("dist/index.js"));
  assert.equal(fileURLToPath(import.meta.resolve("@proseql/effect")), realpathSync("../effect/dist/index.js"));
  assert.deepEqual(Object.keys(shim), Object.keys(replacement));
  for (const name of Object.keys(shim)) assert.equal(shim[name], replacement[name]);
 `,
		],
		{ cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" },
	);
});
