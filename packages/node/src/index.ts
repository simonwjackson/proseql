/**
 * @proseql/node - Node.js adapter for ProseQL
 *
 * Re-exports everything from @proseql/core plus Node.js filesystem storage.
 */

// Re-export everything from core
export * from "@proseql/core"

// Export Node.js storage adapter
export {
	NodeStorageLayer,
	makeNodeStorageLayer,
} from "./node-adapter-layer.js"

export type { NodeAdapterConfig } from "./node-adapter-layer.js"
