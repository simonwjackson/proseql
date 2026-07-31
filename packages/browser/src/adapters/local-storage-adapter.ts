import { StorageAdapterService as StorageAdapter } from "@proseql/core";
import { Layer } from "effect";
import {
	createEngineStorageAdapter,
	createLocalStorageEngineStorageHost,
	type LocalStorageEngineStorageHostConfig,
} from "@proseql/engine/browser";
import type { StorageAdapterShape } from "@proseql/core";

export type WebStorageConfig = LocalStorageEngineStorageHostConfig;

export function makeLocalStorageAdapter(
	storage: Storage = globalThis.localStorage,
	config: WebStorageConfig = {},
): StorageAdapterShape {
	return createEngineStorageAdapter(
		createLocalStorageEngineStorageHost({ ...config, storage }),
	);
}

export function makeLocalStorageLayer(
	config: WebStorageConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(
		StorageAdapter,
		makeLocalStorageAdapter(globalThis.localStorage, config),
	);
}

export const LocalStorageLayer: Layer.Layer<StorageAdapter> =
	makeLocalStorageLayer();
