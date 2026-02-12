/**
 * IndexedDB adapter for browser environments.
 *
 * Provides persistent storage backed by IndexedDB, suitable for larger datasets
 * than localStorage/sessionStorage. IndexedDB has no practical storage limit
 * beyond available disk space.
 *
 * Operations are wrapped in Effect.async to handle IndexedDB's callback-based API.
 */

import {
	StorageAdapterService as StorageAdapter,
	StorageError,
	type StorageAdapterShape,
} from "@proseql/core";
import { Effect, Layer } from "effect";
import { pathToKey, DEFAULT_STORAGE_KEY_PREFIX } from "../path-to-key.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for IndexedDB adapter.
 */
export interface IndexedDBConfig {
	/**
	 * Prefix for storage keys. Default: "proseql:"
	 */
	readonly keyPrefix?: string;

	/**
	 * IndexedDB database name. Default: "proseql"
	 */
	readonly databaseName?: string;

	/**
	 * IndexedDB object store name. Default: "collections"
	 */
	readonly storeName?: string;

	/**
	 * IndexedDB database version. Default: 1
	 */
	readonly version?: number;
}

const defaultConfig: Required<IndexedDBConfig> = {
	keyPrefix: DEFAULT_STORAGE_KEY_PREFIX,
	databaseName: "proseql",
	storeName: "collections",
	version: 1,
};

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
// Database Management
// ============================================================================

/**
 * Opens or creates an IndexedDB database.
 *
 * Creates the object store on first access (onupgradeneeded).
 * Caches the IDBDatabase handle for subsequent operations.
 */
const openDatabase = (
	config: Required<IndexedDBConfig>,
): Effect.Effect<IDBDatabase, StorageError> =>
	Effect.async<IDBDatabase, StorageError>((resume) => {
		const request = indexedDB.open(config.databaseName, config.version);

		request.onupgradeneeded = () => {
			const db = request.result;
			// Create object store if it doesn't exist
			if (!db.objectStoreNames.contains(config.storeName)) {
				db.createObjectStore(config.storeName);
			}
		};

		request.onsuccess = () => {
			resume(Effect.succeed(request.result));
		};

		request.onerror = () => {
			resume(
				Effect.fail(
					new StorageError({
						path: config.databaseName,
						operation: "read",
						message: `Failed to open IndexedDB database: ${request.error?.message ?? "Unknown error"}`,
						cause: request.error,
					}),
				),
			);
		};

		request.onblocked = () => {
			resume(
				Effect.fail(
					new StorageError({
						path: config.databaseName,
						operation: "read",
						message:
							"IndexedDB database is blocked. Close other tabs using this database.",
					}),
				),
			);
		};
	});

// Cached database connection per config
const databaseCache = new Map<string, IDBDatabase>();

const getCacheKey = (config: Required<IndexedDBConfig>): string =>
	`${config.databaseName}:${config.version}`;

const getDatabase = (
	config: Required<IndexedDBConfig>,
): Effect.Effect<IDBDatabase, StorageError> => {
	const cacheKey = getCacheKey(config);
	const cached = databaseCache.get(cacheKey);

	if (cached) {
		return Effect.succeed(cached);
	}

	return openDatabase(config).pipe(
		Effect.tap((db) =>
			Effect.sync(() => {
				databaseCache.set(cacheKey, db);
			}),
		),
	);
};

// ============================================================================
// Storage Operations
// ============================================================================

const makeRead =
	(config: Required<IndexedDBConfig>) =>
	(path: string): Effect.Effect<string, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);

		return Effect.gen(function* () {
			const db = yield* getDatabase(config);

			return yield* Effect.async<string, StorageError>((resume) => {
				try {
					const transaction = db.transaction(config.storeName, "readonly");
					const store = transaction.objectStore(config.storeName);
					const request = store.get(key);

					request.onsuccess = () => {
						if (request.result === undefined) {
							resume(
								Effect.fail(
									new StorageError({
										path,
										operation: "read",
										message: `Key not found: ${key}`,
									}),
								),
							);
						} else {
							resume(Effect.succeed(request.result as string));
						}
					};

					request.onerror = () => {
						resume(Effect.fail(toStorageError(path, "read", request.error)));
					};
				} catch (error) {
					resume(Effect.fail(toStorageError(path, "read", error)));
				}
			});
		});
	};

const makeWrite =
	(config: Required<IndexedDBConfig>) =>
	(path: string, data: string): Effect.Effect<void, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);

		return Effect.gen(function* () {
			const db = yield* getDatabase(config);

			return yield* Effect.async<void, StorageError>((resume) => {
				try {
					const transaction = db.transaction(config.storeName, "readwrite");
					const store = transaction.objectStore(config.storeName);
					const request = store.put(data, key);

					request.onsuccess = () => {
						resume(Effect.succeed(undefined));
					};

					request.onerror = () => {
						// Check for QuotaExceededError
						const error = request.error;
						if (error?.name === "QuotaExceededError") {
							resume(
								Effect.fail(
									new StorageError({
										path,
										operation: "write",
										message: `Storage quota exceeded while writing key: ${key}. Consider clearing old data.`,
										cause: error,
									}),
								),
							);
						} else {
							resume(Effect.fail(toStorageError(path, "write", error)));
						}
					};
				} catch (error) {
					resume(Effect.fail(toStorageError(path, "write", error)));
				}
			});
		});
	};

const makeExists =
	(config: Required<IndexedDBConfig>) =>
	(path: string): Effect.Effect<boolean, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);

		return Effect.gen(function* () {
			const db = yield* getDatabase(config);

			return yield* Effect.async<boolean, StorageError>((resume) => {
				try {
					const transaction = db.transaction(config.storeName, "readonly");
					const store = transaction.objectStore(config.storeName);
					const request = store.count(key);

					request.onsuccess = () => {
						resume(Effect.succeed(request.result > 0));
					};

					request.onerror = () => {
						resume(Effect.fail(toStorageError(path, "read", request.error)));
					};
				} catch (error) {
					resume(Effect.fail(toStorageError(path, "read", error)));
				}
			});
		});
	};

const makeRemove =
	(config: Required<IndexedDBConfig>) =>
	(path: string): Effect.Effect<void, StorageError> => {
		const key = pathToKey(path, config.keyPrefix);

		return Effect.gen(function* () {
			const db = yield* getDatabase(config);

			return yield* Effect.async<void, StorageError>((resume) => {
				try {
					const transaction = db.transaction(config.storeName, "readwrite");
					const store = transaction.objectStore(config.storeName);
					const request = store.delete(key);

					request.onsuccess = () => {
						resume(Effect.succeed(undefined));
					};

					request.onerror = () => {
						resume(Effect.fail(toStorageError(path, "write", request.error)));
					};
				} catch (error) {
					resume(Effect.fail(toStorageError(path, "write", error)));
				}
			});
		});
	};

const makeEnsureDir =
	(_config: Required<IndexedDBConfig>) =>
	(_path: string): Effect.Effect<void, StorageError> => {
		// IndexedDB is flat (no directories), so this is a no-op
		return Effect.void;
	};

/**
 * No-op watch implementation for IndexedDB.
 *
 * IndexedDB does not have native change notification. Cross-tab sync would
 * require BroadcastChannel, which is out of scope for the initial implementation.
 *
 * Returns an empty unsubscribe function.
 */
const makeWatch =
	(_config: Required<IndexedDBConfig>) =>
	(
		_path: string,
		_onChange: () => void,
	): Effect.Effect<() => void, StorageError> =>
		// Return a no-op unsubscribe function
		Effect.succeed(() => {});

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Creates an IndexedDB-backed StorageAdapterShape.
 *
 * @param config - Configuration options
 * @returns A StorageAdapterShape implementation
 */
export function makeIndexedDBAdapter(
	config: IndexedDBConfig = {},
): StorageAdapterShape {
	const resolved = { ...defaultConfig, ...config };

	return {
		read: makeRead(resolved),
		write: makeWrite(resolved),
		exists: makeExists(resolved),
		remove: makeRemove(resolved),
		ensureDir: makeEnsureDir(resolved),
		watch: makeWatch(resolved),
	};
}

// ============================================================================
// Layer Factory
// ============================================================================

/**
 * Creates an IndexedDBStorageLayer with custom configuration.
 *
 * @param config - Configuration options (keyPrefix, databaseName, storeName, version)
 * @returns A Layer providing StorageAdapter backed by IndexedDB
 *
 * @example
 * ```ts
 * const CustomLayer = makeIndexedDBStorageLayer({
 *   databaseName: "myapp",
 *   storeName: "data",
 * });
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
export function makeIndexedDBStorageLayer(
	config: IndexedDBConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(StorageAdapter, makeIndexedDBAdapter(config));
}

/**
 * Default IndexedDBStorageLayer with standard configuration.
 *
 * Uses database name "proseql", object store "collections", version 1,
 * and key prefix "proseql:".
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const db = yield* createPersistentEffectDatabase(config, initialData);
 *   // ...
 * });
 *
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(IndexedDBStorageLayer), Effect.scoped)
 * );
 * ```
 */
export const IndexedDBStorageLayer: Layer.Layer<StorageAdapter> =
	makeIndexedDBStorageLayer();
