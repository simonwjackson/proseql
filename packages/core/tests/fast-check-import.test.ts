/**
 * Trivial test to verify fast-check imports resolve correctly.
 * This is task 1.2 of the property-based-testing change.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("fast-check import verification", () => {
	it("should import fc.string arbitrary", () => {
		expect(typeof fc.string).toBe("function");
	});

	it("should import fc.integer arbitrary", () => {
		expect(typeof fc.integer).toBe("function");
	});

	it("should import fc.boolean arbitrary", () => {
		expect(typeof fc.boolean).toBe("function");
	});

	it("should import fc.array arbitrary", () => {
		expect(typeof fc.array).toBe("function");
	});

	it("should import fc.record arbitrary", () => {
		expect(typeof fc.record).toBe("function");
	});

	it("should import fc.assert function", () => {
		expect(typeof fc.assert).toBe("function");
	});

	it("should import fc.property function", () => {
		expect(typeof fc.property).toBe("function");
	});

	it("should run a trivial property test", () => {
		fc.assert(
			fc.property(fc.integer(), (n) => {
				return typeof n === "number";
			}),
			{ numRuns: 10 },
		);
	});

	it("should run a property test with string arbitrary", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				return typeof s === "string";
			}),
			{ numRuns: 10 },
		);
	});

	it("should run a property test with array arbitrary", () => {
		fc.assert(
			fc.property(fc.array(fc.integer()), (arr) => {
				return Array.isArray(arr) && arr.every((x) => typeof x === "number");
			}),
			{ numRuns: 10 },
		);
	});

	it("should run a property test with record arbitrary", () => {
		fc.assert(
			fc.property(
				fc.record({
					id: fc.string(),
					value: fc.integer(),
				}),
				(obj) => {
					return typeof obj.id === "string" && typeof obj.value === "number";
				},
			),
			{ numRuns: 10 },
		);
	});
});
