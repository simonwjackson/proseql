/**
 * Plugin system types for extending ProseQL functionality.
 * Plugins can provide custom codecs, operators, ID generators, and global lifecycle hooks.
 */

import type { Effect } from "effect";
import type { FormatCodec } from "../serializers/format-codec.js";
import type { HooksConfig } from "../types/hook-types.js";

// ============================================================================
// Custom Operator Interface
// ============================================================================

/**
 * A custom query operator that extends the filter system.
 * Operators must start with `$` prefix (e.g., `$regex`, `$fuzzy`).
 */
export interface CustomOperator {
	/** Operator name, must start with $ (e.g., "$regex", "$fuzzy") */
	readonly name: string;
	/** Field types this operator works with */
	readonly types: ReadonlyArray<"string" | "number" | "boolean" | "array">;
	/** Evaluates whether the field value matches the operand */
	readonly evaluate: (fieldValue: unknown, operand: unknown) => boolean;
}

// ============================================================================
// Custom ID Generator Interface
// ============================================================================

/**
 * A custom ID generator that can be referenced by collections.
 * Generators are named and referenced by string in collection config.
 */
export interface CustomIdGenerator {
	/** Generator name (e.g., "snowflake", "uuid-v7") */
	readonly name: string;
	/** Generates a unique ID string */
	readonly generate: () => string;
}

// ============================================================================
// Global Hooks Config
// ============================================================================

/**
 * Global hooks configuration that applies to all collections.
 * Uses untyped Record<string, unknown> since global hooks span all collections.
 */
export type GlobalHooksConfig = HooksConfig<Record<string, unknown>>;

// ============================================================================
// ProseQL Plugin Interface
// ============================================================================

/**
 * A plugin that extends ProseQL functionality.
 *
 * Plugins can contribute:
 * - Custom format codecs (serialization formats)
 * - Custom query operators (filter extensions)
 * - Custom ID generators (referenced by name in collection config)
 * - Global lifecycle hooks (run before/after collection hooks)
 *
 * @example
 * ```ts
 * const myPlugin: ProseQLPlugin = {
 *   name: "my-plugin",
 *   version: "1.0.0",
 *   operators: [{
 *     name: "$regex",
 *     types: ["string"],
 *     evaluate: (value, pattern) =>
 *       typeof value === "string" && new RegExp(pattern as string).test(value)
 *   }],
 *   hooks: {
 *     beforeCreate: [(ctx) => Effect.succeed(ctx.data)]
 *   }
 * }
 * ```
 */
export interface ProseQLPlugin {
	/** Plugin name (required, must be non-empty) */
	readonly name: string;
	/** Plugin version (optional, for informational purposes) */
	readonly version?: string;
	/** Custom format codecs for serialization */
	readonly codecs?: ReadonlyArray<FormatCodec>;
	/** Custom query operators */
	readonly operators?: ReadonlyArray<CustomOperator>;
	/** Custom ID generators */
	readonly idGenerators?: ReadonlyArray<CustomIdGenerator>;
	/** Global lifecycle hooks */
	readonly hooks?: GlobalHooksConfig;
	/** Plugin dependencies (names of plugins that must be loaded first) */
	readonly dependencies?: ReadonlyArray<string>;
	/** Initialization Effect (runs once during database creation, after validation) */
	readonly initialize?: () => Effect.Effect<void>;
	/** Shutdown Effect (runs during scope finalization) */
	readonly shutdown?: () => Effect.Effect<void>;
}

// ============================================================================
// Plugin Registry (Internal Resolved State)
// ============================================================================

/**
 * Resolved internal state holding merged plugin contributions.
 * Built by `buildPluginRegistry` after validation.
 */
export interface PluginRegistry {
	/** All codecs from plugins (in registration order) */
	readonly codecs: ReadonlyArray<FormatCodec>;
	/** Custom operators by name (for O(1) lookup) */
	readonly operators: Map<string, CustomOperator>;
	/** ID generators by name (for O(1) lookup) */
	readonly idGenerators: Map<string, CustomIdGenerator>;
	/** Merged global hooks from all plugins */
	readonly globalHooks: GlobalHooksConfig;
}
