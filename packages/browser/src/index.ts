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
