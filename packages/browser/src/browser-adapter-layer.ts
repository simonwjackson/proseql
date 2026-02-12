/**
 * Browser storage adapter layer exports.
 *
 * This module re-exports all browser storage layer factories and convenience
 * aliases from the individual adapter files.
 */

// ============================================================================
// LocalStorage
// ============================================================================

export {
	makeLocalStorageAdapter,
	makeLocalStorageLayer,
	LocalStorageLayer,
	type WebStorageConfig,
} from "./adapters/local-storage-adapter.js";

// ============================================================================
// SessionStorage
// ============================================================================

export {
	makeSessionStorageAdapter,
	makeSessionStorageLayer,
	SessionStorageLayer,
} from "./adapters/session-storage-adapter.js";

// ============================================================================
// IndexedDB
// ============================================================================

export {
	makeIndexedDBAdapter,
	makeIndexedDBStorageLayer,
	IndexedDBStorageLayer,
	type IndexedDBConfig,
} from "./adapters/indexeddb-adapter.js";

// ============================================================================
// Web Storage Shared
// ============================================================================

export {
	makeWebStorageAdapter,
	type WatchImplementation,
} from "./adapters/web-storage-adapter.js";
