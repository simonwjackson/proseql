/**
 * @proseql/browser - Browser storage adapters for ProseQL
 *
 * Re-exports everything from @proseql/core plus browser storage adapters
 * (localStorage, sessionStorage, IndexedDB).
 */

// Re-export everything from core
export * from "@proseql/core";
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
