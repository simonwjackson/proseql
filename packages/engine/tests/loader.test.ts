import { describe, expect, it } from "vitest";
import {
	assertWasmBindingsAbi,
	initializeBrowserWasmBindings,
	WASM_RUNTIME_ABI_METHODS,
	WasmBindingsAbiError,
} from "../src/loader.js";

const syntheticBindings = (missing: ReadonlyArray<string> = []) => {
	class WasmRuntime {}
	const prototype = WasmRuntime.prototype as unknown as Record<string, unknown>;
	for (const method of WASM_RUNTIME_ABI_METHODS) {
		if (!missing.includes(method)) prototype[method] = () => undefined;
	}
	return { WasmRuntime };
};

describe("generated WASM binding ABI guard", () => {
	it("accepts bindings with the complete EngineRuntime ABI", () => {
		const bindings = syntheticBindings();
		expect(() => assertWasmBindingsAbi(bindings)).not.toThrow();
	});

	it("reports every missing method and the exact rebuild command", () => {
		const bindings = syntheticBindings([
			"projection_handles",
			"fast_selected_primitive_query",
		]);
		let thrown: unknown;
		try {
			assertWasmBindingsAbi(bindings);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WasmBindingsAbiError);
		expect(thrown).toMatchObject({
			missingMethods: ["fast_selected_primitive_query", "projection_handles"],
		});
		expect((thrown as Error).message).toContain(
			"bun run --cwd packages/engine build:wasm",
		);
	});

	it("distinguishes a missing WasmRuntime constructor", () => {
		expect(() => assertWasmBindingsAbi({})).toThrowError(
			/Stale or incompatible proseql-wasm bindings: missing WasmRuntime method\(s\): WasmRuntime constructor/,
		);
	});

	it("rejects stale browser bindings before invoking their WASM initializer", async () => {
		let initialized = false;
		const staleBindings = {
			...syntheticBindings(["projection_handles"]),
			default: async () => {
				initialized = true;
				throw new Error("stale initializer must not run");
			},
		};

		await expect(
			initializeBrowserWasmBindings(
				staleBindings,
				new URL("file:///synthetic/proseql_wasm_bg.wasm"),
			),
		).rejects.toBeInstanceOf(WasmBindingsAbiError);
		expect(initialized).toBe(false);
	});
});
