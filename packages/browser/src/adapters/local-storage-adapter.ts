/**
 * LocalStorage adapter for browser environments.
 *
 * Provides persistent storage that survives browser restarts and is shared
 * across tabs on the same origin. Supports cross-tab sync via the "storage" event.
 */

import {
	StorageAdapterService as StorageAdapter,
	type StorageAdapterShape,
	StorageError,
} from "@proseql/core";
import { Effect, Layer } from "effect";
import {
	makeWebStorageAdapter,
	type WatchImplementation,
	type WebStorageConfig,
} from "./web-storage-adapter.js";

// ============================================================================
// Watch Implementation
// ============================================================================

/**
 * Creates a watch function for localStorage that listens to the "storage" event.
 *
 * The "storage" event fires when another tab modifies localStorage on the same origin.
 * This enables cross-tab synchronization of data.
 *
 * Note: The event does NOT fire in the tab that made the change, only in other tabs.
 */
const localStorageWatch: WatchImplementation = (
	key: string,
	onChange: () => void,
): Effect.Effect<() => void, StorageError> =>
	Effect.try({
		try: () => {
			const listener = (event: StorageEvent) => {
				// Only trigger onChange if this specific key was modified
				if (event.key === key) {
					onChange();
				}
			};

			window.addEventListener("storage", listener);

			// Return unsubscribe function
			return () => {
				window.removeEventListener("storage", listener);
			};
		},
		catch: (error) =>
			new StorageError({
				path: key,
				operation: "watch",
				message:
					error instanceof Error
						? error.message
						: "Failed to register storage event listener",
				cause: error,
			}),
	});

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Creates a localStorage-backed StorageAdapterShape.
 *
 * @param storage - The Storage instance (defaults to window.localStorage)
 * @param config - Configuration options
 * @returns A StorageAdapterShape implementation
 */
export function makeLocalStorageAdapter(
	storage: Storage = globalThis.localStorage,
	config: WebStorageConfig = {},
): StorageAdapterShape {
	return makeWebStorageAdapter(storage, config, localStorageWatch);
}

// ============================================================================
// Layer Factory
// ============================================================================

/**
 * Creates a LocalStorageLayer with custom configuration.
 *
 * @param config - Configuration options (keyPrefix, etc.)
 * @returns A Layer providing StorageAdapter backed by localStorage
 *
 * @example
 * ```ts
 * const CustomLayer = makeLocalStorageLayer({ keyPrefix: "myapp:" });
 *
 * const program = Effect.gen(function* () {
 *   const db = yield* createPersistentEffectDatabase(config, initialData);
 *   // ...
 * });
 *
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(CustomLayer), Effect.scoped)
 * );
 * ```
 */
export function makeLocalStorageLayer(
	config: WebStorageConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(
		StorageAdapter,
		makeLocalStorageAdapter(globalThis.localStorage, config),
	);
}

/**
 * Default LocalStorageLayer with standard configuration.
 *
 * Uses the default key prefix "proseql:" and window.localStorage.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const db = yield* createPersistentEffectDatabase(config, initialData);
 *   // ...
 * });
 *
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(LocalStorageLayer), Effect.scoped)
 * );
 * ```
 */
export const LocalStorageLayer: Layer.Layer<StorageAdapter> =
	makeLocalStorageLayer();

// Re-export config type for convenience
export type { WebStorageConfig } from "./web-storage-adapter.js";
