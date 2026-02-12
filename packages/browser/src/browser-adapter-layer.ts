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
	LocalStorageLayer,
	makeLocalStorageAdapter,
	makeLocalStorageLayer,
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
	type IndexedDBConfig,
	IndexedDBStorageLayer,
	makeIndexedDBAdapter,
	makeIndexedDBStorageLayer,
} from "./adapters/indexeddb-adapter.js";

// ============================================================================
// Web Storage Shared
// ============================================================================

export {
	makeWebStorageAdapter,
	type WatchImplementation,
} from "./adapters/web-storage-adapter.js";

// ============================================================================
// Default Browser Layer
// ============================================================================

/**
 * Default browser storage layer alias.
 *
 * This is an alias for LocalStorageLayer, which is the sensible default for
 * most browser applications. LocalStorage provides:
 * - Persistence across browser restarts
 * - Cross-tab synchronization via the "storage" event
 * - Simple key-value API
 *
 * For applications requiring more storage capacity or non-blocking writes,
 * consider using IndexedDBStorageLayer instead.
 */
export { LocalStorageLayer as BrowserStorageLayer } from "./adapters/local-storage-adapter.js";
