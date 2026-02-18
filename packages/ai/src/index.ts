/**
 * @proseql/ai — AI tool definitions and executor for ProseQL databases.
 *
 * Generates OpenAI function-calling compatible tool definitions and a dispatch
 * executor directly from a live database instance + config.
 */

export type {
	CollectionDescription,
	JsonSchemaProperty,
	ProseQLToolKit,
	SchemaDescription,
	ToolDefinition,
} from "./types.js";
export { describeCollection, describeConfig } from "./introspect.js";
export {
	buildFullDefinitions,
	buildReadOnlyDefinitions,
} from "./definitions.js";

import type { DatabaseConfig } from "@proseql/core";
import { buildFullDefinitions, buildReadOnlyDefinitions } from "./definitions.js";
import { makeExecutor } from "./executor.js";
import type { ProseQLToolKit } from "./types.js";

/**
 * Create read-only AI tools: describe, query, and find_by_id.
 */
export const makeReadOnlyTools = <Config extends DatabaseConfig>(
	db: unknown,
	config: Config,
): ProseQLToolKit => ({
	definitions: buildReadOnlyDefinitions(),
	execute: makeExecutor(db as Parameters<typeof makeExecutor>[0], config, {
		readOnly: true,
	}),
});

/**
 * Create full CRUD AI tools: describe, query, find_by_id, create, update, delete.
 */
export const makeTools = <Config extends DatabaseConfig>(
	db: unknown,
	config: Config,
): ProseQLToolKit => ({
	definitions: buildFullDefinitions(),
	execute: makeExecutor(db as Parameters<typeof makeExecutor>[0], config, {
		readOnly: false,
	}),
});
