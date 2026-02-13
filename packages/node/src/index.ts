/**
 * @proseql/node - Node.js adapter for ProseQL
 *
 * Re-exports everything from @proseql/core plus Node.js filesystem storage.
 */

// Re-export everything from core
export * from "@proseql/core";
// Convenience wrappers (config-driven, no manual layer wiring)
export {
	createNodeDatabase,
	makeNodePersistenceLayer,
} from "./convenience.js";
export type { NodeAdapterConfig } from "./node-adapter-layer.js";
// Export Node.js storage adapter
export {
	makeNodeStorageLayer,
	NodeStorageLayer,
} from "./node-adapter-layer.js";
