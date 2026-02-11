/**
 * Types for indexing functionality.
 *
 * Indexes accelerate equality queries by maintaining a reverse mapping
 * from field values to entity IDs.
 */

import type { Ref } from "effect";

/**
 * An index mapping field values to sets of entity IDs.
 *
 * For single-field indexes, the key is the field value directly.
 * For compound indexes, the key is a JSON.stringify'd array of field values.
 *
 * The Set<string> contains entity IDs that have that particular value combination.
 */
export type IndexMap = Map<unknown, Set<string>>;

/**
 * A reference to an index that can be updated atomically.
 * Used to maintain consistency between data mutations and index updates.
 */
export type IndexRef = Ref.Ref<IndexMap>;

/**
 * All indexes for a collection, keyed by the normalized index name.
 *
 * The key is a JSON.stringify'd array of field names for consistency:
 * - Single field "email" -> key is '["email"]'
 * - Compound ["userId", "category"] -> key is '["userId","category"]'
 */
export type CollectionIndexes = Map<string, IndexRef>;

/**
 * An index definition normalized to array form.
 *
 * User input can be:
 * - "email" (single field)
 * - ["userId", "category"] (compound)
 *
 * Both normalize to ReadonlyArray<string>:
 * - "email" -> ["email"]
 * - ["userId", "category"] -> ["userId", "category"]
 */
export type NormalizedIndex = ReadonlyArray<string>;
