import { expect, test } from "bun:test";
import * as replacement from "@proseql/effect/node";
import * as shim from "../src/index.js";

// Namespace imports cover every inherited contract export as well as Node helpers.
test("the deprecated Node entry preserves every export by identity", () => {
	expect(Object.keys(shim).sort()).toEqual(Object.keys(replacement).sort());
	for (const name of Object.keys(shim) as Array<keyof typeof shim>) {
		expect(shim[name]).toBe(replacement[name]);
	}
	for (const name of [
		"createNodeDatabase",
		"makeNodePersistenceLayer",
		"makeProseQLLayer",
		"NodeStorageLayer",
		"makeNodeStorageLayer",
	] as const) {
		expect(shim[name]).toBeDefined();
	}
});
