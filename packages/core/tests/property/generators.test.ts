/**
 * Unit tests for the property-based testing generators module.
 * Task 2.1: Verify shared constants and getNumRuns helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_NUM_RUNS, getNumRuns } from "./generators";

describe("generators module", () => {
	describe("DEFAULT_NUM_RUNS", () => {
		it("should be 100", () => {
			expect(DEFAULT_NUM_RUNS).toBe(100);
		});
	});

	describe("getNumRuns", () => {
		const originalEnv = process.env.FC_NUM_RUNS;

		beforeEach(() => {
			// Clear the env variable before each test
			delete process.env.FC_NUM_RUNS;
		});

		afterEach(() => {
			// Restore original value after tests
			if (originalEnv !== undefined) {
				process.env.FC_NUM_RUNS = originalEnv;
			} else {
				delete process.env.FC_NUM_RUNS;
			}
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is not set", () => {
			delete process.env.FC_NUM_RUNS;
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is empty string", () => {
			process.env.FC_NUM_RUNS = "";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should parse FC_NUM_RUNS when set to a valid number", () => {
			process.env.FC_NUM_RUNS = "500";
			expect(getNumRuns()).toBe(500);
		});

		it("should parse FC_NUM_RUNS when set to 1", () => {
			process.env.FC_NUM_RUNS = "1";
			expect(getNumRuns()).toBe(1);
		});

		it("should parse FC_NUM_RUNS when set to a large number", () => {
			process.env.FC_NUM_RUNS = "10000";
			expect(getNumRuns()).toBe(10000);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is not a valid number", () => {
			process.env.FC_NUM_RUNS = "not-a-number";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is zero", () => {
			process.env.FC_NUM_RUNS = "0";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is negative", () => {
			process.env.FC_NUM_RUNS = "-10";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is a float", () => {
			// parseInt will parse "50.5" as 50, which is > 0, so it should return 50
			process.env.FC_NUM_RUNS = "50.5";
			expect(getNumRuns()).toBe(50);
		});

		it("should handle FC_NUM_RUNS with leading/trailing whitespace in the number", () => {
			// parseInt handles leading whitespace, "  100" parses to 100
			process.env.FC_NUM_RUNS = "  100";
			expect(getNumRuns()).toBe(100);
		});
	});
});
