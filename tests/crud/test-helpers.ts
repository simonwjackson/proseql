import { Effect, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../../core/factories/database-effect"
import type { DatabaseConfig } from "../../core/types/database-config-types"

/**
 * Helper to create an Effect database and run a test function against it.
 * Handles the Effect.gen + Effect.runPromise boilerplate.
 */
export const withDb = <Config extends DatabaseConfig>(
	config: Config,
	initialData: { readonly [K in keyof Config]?: ReadonlyArray<Record<string, unknown>> },
) =>
	Effect.runPromise(createEffectDatabase(config, initialData))

/**
 * Collect a RunnableStream into an array via its .runPromise convenience method.
 */
export const collectStream = <T>(
	stream: { readonly runPromise: Promise<ReadonlyArray<T>> },
): Promise<ReadonlyArray<T>> => stream.runPromise
