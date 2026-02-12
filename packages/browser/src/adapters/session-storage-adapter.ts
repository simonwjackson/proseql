/**
 * SessionStorage adapter for browser environments.
 *
 * Provides session-scoped storage that is cleared when the browser tab closes.
 * Data is NOT shared across tabs (each tab has its own sessionStorage).
 *
 * Unlike localStorage, sessionStorage does not fire "storage" events across tabs,
 * so the watch function is a no-op.
 */

import {
	StorageAdapterService as StorageAdapter,
	type StorageAdapterShape,
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
 * No-op watch implementation for sessionStorage.
 *
 * SessionStorage does not fire "storage" events across tabs (since each tab
 * has its own isolated sessionStorage), so watching is not supported.
 *
 * Returns an empty unsubscribe function.
 */
const sessionStorageWatch: WatchImplementation = (
	_key: string,
	_onChange: () => void,
): Effect.Effect<() => void> =>
	// Return a no-op unsubscribe function
	Effect.succeed(() => {});

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Creates a sessionStorage-backed StorageAdapterShape.
 *
 * @param storage - The Storage instance (defaults to window.sessionStorage)
 * @param config - Configuration options
 * @returns A StorageAdapterShape implementation
 */
export function makeSessionStorageAdapter(
	storage: Storage = globalThis.sessionStorage,
	config: WebStorageConfig = {},
): StorageAdapterShape {
	return makeWebStorageAdapter(storage, config, sessionStorageWatch);
}

// ============================================================================
// Layer Factory
// ============================================================================

/**
 * Creates a SessionStorageLayer with custom configuration.
 *
 * @param config - Configuration options (keyPrefix, etc.)
 * @returns A Layer providing StorageAdapter backed by sessionStorage
 *
 * @example
 * ```ts
 * const CustomLayer = makeSessionStorageLayer({ keyPrefix: "myapp:" });
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
export function makeSessionStorageLayer(
	config: WebStorageConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(
		StorageAdapter,
		makeSessionStorageAdapter(globalThis.sessionStorage, config),
	);
}

/**
 * Default SessionStorageLayer with standard configuration.
 *
 * Uses the default key prefix "proseql:" and window.sessionStorage.
 *
 * Note: Unlike localStorage, sessionStorage data is NOT persisted across
 * browser sessions and is NOT shared across tabs.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const db = yield* createPersistentEffectDatabase(config, initialData);
 *   // ...
 * });
 *
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(SessionStorageLayer), Effect.scoped)
 * );
 * ```
 */
export const SessionStorageLayer: Layer.Layer<StorageAdapter> =
	makeSessionStorageLayer();

// Re-export config type for convenience
export type { WebStorageConfig } from "./web-storage-adapter.js";
