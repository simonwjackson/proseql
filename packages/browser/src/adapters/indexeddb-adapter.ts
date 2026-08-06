import type { StorageAdapterShape } from "@proseql/core";
import { StorageAdapterService as StorageAdapter } from "@proseql/core";
import {
	createEngineStorageAdapter,
	createIndexedDBEngineStorageHost,
	type IndexedDBEngineHostConfig,
} from "@proseql/engine/browser";
import { Layer } from "effect";

export type IndexedDBConfig = IndexedDBEngineHostConfig;

export function makeIndexedDBAdapter(
	config: IndexedDBConfig = {},
): StorageAdapterShape {
	return createEngineStorageAdapter(createIndexedDBEngineStorageHost(config));
}

export function makeIndexedDBStorageLayer(
	config: IndexedDBConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(StorageAdapter, makeIndexedDBAdapter(config));
}

export const IndexedDBStorageLayer: Layer.Layer<StorageAdapter> =
	makeIndexedDBStorageLayer();
