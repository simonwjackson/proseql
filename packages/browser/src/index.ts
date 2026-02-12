/**
 * @proseql/browser - Browser storage adapters for ProseQL
 *
 * Re-exports everything from @proseql/core plus browser storage adapters
 * (localStorage, sessionStorage, IndexedDB).
 */

// Re-export everything from core
export * from "@proseql/core";

// Browser-specific exports
export { pathToKey, DEFAULT_STORAGE_KEY_PREFIX } from "./path-to-key.js";

// Format validation utilities
export {
	getFileExtension,
	validateAllowedFormat,
} from "./format-validation.js";

// Browser storage adapter layers, factories, and config types
export {
	// LocalStorage
	makeLocalStorageAdapter,
	makeLocalStorageLayer,
	LocalStorageLayer,
	type WebStorageConfig,
	// SessionStorage
	makeSessionStorageAdapter,
	makeSessionStorageLayer,
	SessionStorageLayer,
	// IndexedDB
	makeIndexedDBAdapter,
	makeIndexedDBStorageLayer,
	IndexedDBStorageLayer,
	type IndexedDBConfig,
	// Shared web storage adapter
	makeWebStorageAdapter,
	type WatchImplementation,
	// Default browser layer alias
	BrowserStorageLayer,
} from "./browser-adapter-layer.js";
