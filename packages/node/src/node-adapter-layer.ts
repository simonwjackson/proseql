/** Compatibility names for the engine's single Node.js storage host. */
export type { NodeEngineStorageHostConfig as NodeAdapterConfig } from "@proseql/engine";
export { makeNodeEngineStorageLayer as makeNodeStorageLayer } from "@proseql/engine";

import { makeNodeEngineStorageLayer } from "@proseql/engine";

export const NodeStorageLayer = makeNodeEngineStorageLayer();
