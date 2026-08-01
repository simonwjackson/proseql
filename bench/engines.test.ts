import { describe, expect, it } from "vitest";
import {
	compileEqualityCriterionForTests,
	selectBenchEngines,
	wasmBenchEngine,
	typescriptBenchEngine,
} from "./engines.js";

describe("benchmark engine helpers", () => {
	it("compiles declarative scalar equality to a direct core predicate without a pre-query", () => {
		const predicate = compileEqualityCriterionForTests({
			age: 30,
			role: "admin",
		});

		expect(predicate({ age: 30, role: "admin" })).toBe(true);
		expect(predicate({ age: 31, role: "admin" })).toBe(false);
		expect(predicate({ age: 30, role: "user" })).toBe(false);
	});

	it("filters the paired benchmark engine set when an isolated child selects one engine", () => {
		expect(selectBenchEngines(undefined)).toEqual([
			typescriptBenchEngine,
			wasmBenchEngine,
		]);
		expect(selectBenchEngines(["wasm"])).toEqual([wasmBenchEngine]);
		expect(selectBenchEngines(["typescript"])).toEqual([typescriptBenchEngine]);
	});
});
