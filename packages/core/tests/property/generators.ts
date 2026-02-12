/**
 * Shared constants and generators for property-based testing.
 *
 * This module provides:
 * - DEFAULT_NUM_RUNS: default number of test runs per property (100)
 * - getNumRuns(): reads FC_NUM_RUNS env variable or returns default
 *
 * Future tasks will add:
 * - entityArbitrary(schema): generate valid entities from Effect Schema
 * - whereClauseArbitrary(schema): generate valid where clauses
 * - sortConfigArbitrary(schema): generate valid sort configurations
 * - operationSequenceArbitrary(schema): generate CRUD operation sequences
 */

/**
 * Default number of runs per property test.
 * Balances coverage against CI speed (~10-30 seconds for all properties).
 */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Get the number of runs for property tests.
 * Reads from FC_NUM_RUNS environment variable if set, otherwise returns DEFAULT_NUM_RUNS.
 *
 * @example
 * // In shell: FC_NUM_RUNS=1000 bun test
 * // In test: fc.assert(fc.property(...), { numRuns: getNumRuns() })
 */
export const getNumRuns = (): number => {
	const envValue = process.env.FC_NUM_RUNS;
	if (envValue === undefined || envValue === "") {
		return DEFAULT_NUM_RUNS;
	}
	const parsed = Number.parseInt(envValue, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return DEFAULT_NUM_RUNS;
	}
	return parsed;
};
