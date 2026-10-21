export * from "@proseql/core";
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
	WasmEngineDefectError,
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
} from "./browser/browser-adapter-layer.js";
// Format validation utilities
export { validateAllowedFormat } from "./browser/format-validation.js";
// Browser-specific exports
export {
	DEFAULT_STORAGE_KEY_PREFIX,
	pathToKey,
} from "./browser/path-to-key.js";
export {
	createBrowserEffectDatabase as createEffectDatabase,
	createBrowserPersistentEffectDatabase as createPersistentEffectDatabase,
} from "./database.js";
