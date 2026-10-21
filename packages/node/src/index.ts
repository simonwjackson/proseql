/**
 * @proseql/node - Node.js adapter for ProseQL
 *
 * Re-exports everything from @proseql/effect plus Node.js filesystem storage.
 */

// Re-export the engine-backed Effect API
export * from "@proseql/effect";
// Convenience wrappers (config-driven, no manual layer wiring)
export {
	createNodeDatabase,
	makeNodePersistenceLayer,
	makeProseQLLayer,
} from "./convenience.js";
export type { NodeAdapterConfig } from "./node-adapter-layer.js";
// Export Node.js storage adapter
export {
	makeNodeStorageLayer,
	NodeStorageLayer,
} from "./node-adapter-layer.js";
