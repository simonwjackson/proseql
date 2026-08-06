/**
 * @proseql/browser - Browser-facing proseQL package
 *
 * Re-exports the Effect-first runtime from @proseql/effect, the Promise-first
 * browser-safe engine facade from @proseql/engine/browser, and browser storage
 * compatibility adapters for localStorage, sessionStorage, and IndexedDB.
 */

export * from "@proseql/effect/browser";
export {
	type BrowserEngineStorageHost,
	type BrowserStorageHostConfig,
	createEngineDatabase,
	createEngineStorageAdapter,
	createIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createPersistentEngineDatabase,
	createSessionStorageEngineStorageHost,
	createWebStorageEngineStorageHost,
	type EngineStorageHost,
	type EngineStorageWatchEvent,
	type IndexedDBEngineHostConfig,
	type LocalStorageEngineStorageHostConfig,
	makeEngineStorageLayer,
	type SessionStorageEngineStorageHostConfig,
	type WebStorageEngineHostConfig,
} from "@proseql/engine/browser";
// Browser storage adapter layers, factories, and config types
export {
	// Default browser layer alias
	BrowserStorageLayer,
	type IndexedDBConfig,
	IndexedDBStorageLayer,
	LocalStorageLayer,
	// IndexedDB
	makeIndexedDBAdapter,
	makeIndexedDBStorageLayer,
	// LocalStorage
	makeLocalStorageAdapter,
	makeLocalStorageLayer,
	// SessionStorage
	makeSessionStorageAdapter,
	makeSessionStorageLayer,
	// Shared web storage adapter
	makeWebStorageAdapter,
	SessionStorageLayer,
	type WatchImplementation,
	type WebStorageConfig,
} from "./browser-adapter-layer.js";

// Format validation utilities
export {
	getFileExtension,
	validateAllowedFormat,
} from "./format-validation.js";
// Browser-specific exports
export { DEFAULT_STORAGE_KEY_PREFIX, pathToKey } from "./path-to-key.js";
