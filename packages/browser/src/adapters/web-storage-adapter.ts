/**
 * Shared web storage adapter factory for localStorage and sessionStorage.
 *
 * Both localStorage and sessionStorage implement the same Web Storage API,
 * so this factory creates a StorageAdapterShape implementation that works
 * with either storage backend.
 */

import {
	StorageError,
	UnsupportedFormatError,
	type StorageAdapterShape,
} from "@proseql/core";
import { Effect } from "effect";
import { pathToKey, DEFAULT_STORAGE_KEY_PREFIX } from "../path-to-key.js";
import { getFileExtension, validateAllowedFormat } from "../format-validation.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for web storage adapters (localStorage/sessionStorage).
 */
export interface WebStorageConfig {
	/**
	 * Prefix for storage keys. Default: "proseql:"
	 */
	readonly keyPrefix?: string;

	/**
	 * Optional list of allowed file extensions (without dots).
	 * When provided, read/write operations will fail with UnsupportedFormatError
	 * if the path has an extension not in this list.
	 *
	 * @example
	 * ```ts
	 * // Only allow JSON and YAML files
	 * const layer = makeLocalStorageLayer({
	 *   allowedFormats: ["json", "yaml", "yml"]
	 * });
	 * ```
	 */
	readonly allowedFormats?: ReadonlyArray<string>;
}

/**
 * Resolved configuration with all required fields filled in.
 * Note: allowedFormats remains optional (undefined means all formats allowed).
 */
interface ResolvedWebStorageConfig {
	readonly keyPrefix: string;
	readonly allowedFormats?: ReadonlyArray<string>;
}

const defaultConfig: ResolvedWebStorageConfig = {
	keyPrefix: DEFAULT_STORAGE_KEY_PREFIX,
};

// ============================================================================
// Types
// ============================================================================

/**
 * Watch implementation function type.
 * Different storage backends may have different watch capabilities:
 * - localStorage: can watch via "storage" events (cross-tab)
 * - sessionStorage: no cross-tab events (returns no-op)
 */
export type WatchImplementation = (
	key: string,
	onChange: () => void,
) => Effect.Effect<() => void, StorageError>;

// ============================================================================
// Helper Functions
// ============================================================================

const toStorageError = (
	path: string,
	operation: StorageError["operation"],
	error: unknown,
): StorageError =>
	new StorageError({
		path,
		operation,
		message:
			error instanceof Error ? error.message : `Unknown ${operation} error`,
		cause: error,
	});

// ============================================================================
// Storage Operations
// ============================================================================

const makeRead =
	(storage: Storage, config: ResolvedWebStorageConfig) =>
	(path: string): Effect.Effect<string, StorageError | UnsupportedFormatError> => {
		const key = pathToKey(path, config.keyPrefix);
		return Effect.gen(function* () {
			// Validate format if restrictions are configured
			yield* validateAllowedFormat(path, config.allowedFormats);

			const value = storage.getItem(key);
			if (value === null) {
				return yield* Effect.fail(
					new StorageError({
						path,
						operation: "read",
						message: `Key not found: ${key}`,
					}),
				);
			}
			return value;
		});
	};

const makeWrite =
	(storage: Storage, config: ResolvedWebStorageConfig) =>
	(path: string, data: string): Effect.Effect<void, StorageError | UnsupportedFormatError> => {
		const key = pathToKey(path, config.keyPrefix);
		return Effect.gen(function* () {
			// Validate format if restrictions are configured
			yield* validateAllowedFormat(path, config.allowedFormats);

			yield* Effect.try({
				try: () => storage.setItem(key, data),
				catch: (error) => {
					// Check for QuotaExceededError
					if (
						error instanceof DOMException &&
						error.name === "QuotaExceededError"
					) {
						return new StorageError({
							path,
							operation: "write",
							message: `Storage quota exceeded while writing key: ${key}. Consider clearing old data or using IndexedDB for larger datasets.`,
							cause: error,
						});
					}
					return toStorageError(path, "write", error);
				},
			});
		});
	};

const makeExists =
	(storage: Storage, config: ResolvedWebStorageConfig) =>
	(path: string): Effect.Effect<boolean, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);
		return Effect.sync(() => storage.getItem(key) !== null);
	};

const makeRemove =
	(storage: Storage, config: ResolvedWebStorageConfig) =>
	(path: string): Effect.Effect<void, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);
		return Effect.sync(() => storage.removeItem(key));
	};

const makeEnsureDir =
	(_storage: Storage, _config: ResolvedWebStorageConfig) =>
	(_path: string): Effect.Effect<void, StorageError> => {
		// Browser storage is flat (no directories), so this is a no-op
		return Effect.void;
	};

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a StorageAdapterShape implementation backed by a Web Storage instance.
 *
 * @param storage - The Storage instance (localStorage or sessionStorage)
 * @param config - Configuration options
 * @param watchImpl - Watch implementation (differs between localStorage and sessionStorage)
 * @returns A StorageAdapterShape implementation
 *
 * @example
 * ```ts
 * const adapter = makeWebStorageAdapter(
 *   window.localStorage,
 *   { keyPrefix: "myapp:" },
 *   localStorageWatch
 * );
 * ```
 */
export function makeWebStorageAdapter(
	storage: Storage,
	config: WebStorageConfig = {},
	watchImpl: WatchImplementation,
): StorageAdapterShape {
	const resolved = { ...defaultConfig, ...config };

	return {
		read: makeRead(storage, resolved),
		write: makeWrite(storage, resolved),
		exists: makeExists(storage, resolved),
		remove: makeRemove(storage, resolved),
		ensureDir: makeEnsureDir(storage, resolved),
		watch: (path: string, onChange: () => void) => {
			const key = pathToKey(path, resolved.keyPrefix);
			return watchImpl(key, onChange);
		},
	};
}
