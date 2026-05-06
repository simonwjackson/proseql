/**
 * Effect Context.Tag factory for ProseQL databases.
 *
 * Creates a typed service tag that can be used with Effect's
 * dependency injection system to provide a ProseQL database.
 */

import { Context } from "effect";
import type { DatabaseConfig } from "./types/database-config-types.js";
import type { GenerateDatabaseWithPersistence } from "./types/types.js";

/**
 * Create a typed Context.Tag for a ProseQL database.
 *
 * The returned tag is typed to `GenerateDatabaseWithPersistence<Config>`,
 * matching the output of `createNodeDatabase` and `createPersistentEffectDatabase`.
 *
 * @param id - Optional service identifier (defaults to "ProseQL")
 * @returns A Context.Tag typed to the database shape derived from Config
 *
 * @example
 * ```typescript
 * import { makeProseQLTag } from "@proseql/core"
 *
 * const dbConfig = {
 *   books: { schema: BookSchema, file: "./data/books.json", relationships: {} },
 * } as const
 *
 * const ProseQLDatabase = makeProseQLTag<typeof dbConfig>("ProseQLDatabase")
 * ```
 */
export const makeProseQLTag = <Config extends DatabaseConfig>(id?: string) =>
	Context.Service<GenerateDatabaseWithPersistence<Config>>(id ?? "ProseQL");
