/**
 * Aggregate types for scalar and grouped aggregations.
 *
 * Scalar aggregates compute a single result from a filtered set.
 * Grouped aggregates partition by field values and compute aggregates per group.
 */

import type { WhereClause } from "./types.js";

// ============================================================================
// Aggregate Result Types
// ============================================================================

/**
 * Result of a scalar aggregate operation.
 * Only requested aggregations appear in the result.
 */
export interface AggregateResult {
	readonly count?: number;
	readonly sum?: Record<string, number>;
	readonly avg?: Record<string, number | null>;
	readonly min?: Record<string, unknown>;
	readonly max?: Record<string, unknown>;
}

/**
 * A single group's result in a grouped aggregation.
 * Contains the grouping field values and the computed aggregates.
 */
export interface GroupResult extends AggregateResult {
	readonly group: Record<string, unknown>;
}

/**
 * Result of a grouped aggregate operation.
 * Array of group objects ordered by first-encounter.
 */
export type GroupedAggregateResult = ReadonlyArray<GroupResult>;

// ============================================================================
// Aggregate Config Types
// ============================================================================

/**
 * Base aggregate options shared by both scalar and grouped configs.
 */
interface AggregateOptions {
	readonly count?: true;
	readonly sum?: string | ReadonlyArray<string>;
	readonly avg?: string | ReadonlyArray<string>;
	readonly min?: string | ReadonlyArray<string>;
	readonly max?: string | ReadonlyArray<string>;
}

/**
 * Configuration for scalar aggregation (no grouping).
 * Generic over entity type, relations, and database for where clause typing.
 */
export interface ScalarAggregateConfig<
	T = unknown,
	Relations = unknown,
	DB = unknown,
> extends AggregateOptions {
	readonly where?: WhereClause<T, Relations, DB>;
}

/**
 * Configuration for grouped aggregation.
 * Extends scalar config with required groupBy field.
 */
export interface GroupedAggregateConfig<
	T = unknown,
	Relations = unknown,
	DB = unknown,
> extends ScalarAggregateConfig<T, Relations, DB> {
	readonly groupBy: string | ReadonlyArray<string>;
}

/**
 * Union type for aggregate configuration.
 * The presence of `groupBy` distinguishes grouped from scalar aggregation.
 */
export type AggregateConfig<T = unknown, Relations = unknown, DB = unknown> =
	| ScalarAggregateConfig<T, Relations, DB>
	| GroupedAggregateConfig<T, Relations, DB>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a config is for grouped aggregation.
 */
export const isGroupedAggregateConfig = <T, Relations, DB>(
	config: AggregateConfig<T, Relations, DB>,
): config is GroupedAggregateConfig<T, Relations, DB> =>
	"groupBy" in config && config.groupBy !== undefined;

// ============================================================================
// Return Type Inference
// ============================================================================

/**
 * Infer the return type based on config.
 * - With groupBy → GroupedAggregateResult (array of group objects)
 * - Without groupBy → AggregateResult (single object)
 */
export type InferAggregateResult<Config extends AggregateConfig> =
	Config extends { readonly groupBy: string | ReadonlyArray<string> }
		? GroupedAggregateResult
		: AggregateResult;
