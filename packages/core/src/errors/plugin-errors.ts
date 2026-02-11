import { Data } from "effect";

// ============================================================================
// Plugin System Errors
// ============================================================================

/**
 * Error thrown when a plugin fails validation or causes a conflict.
 * Used for init-time plugin configuration problems.
 */
export class PluginError extends Data.TaggedError("PluginError")<{
	readonly plugin: string;
	readonly reason: string;
	readonly message: string;
}> {}
