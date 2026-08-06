import type { StorageAdapterShape } from "@proseql/core";
import { StorageAdapterService as StorageAdapter } from "@proseql/core";
import {
	createEngineStorageAdapter,
	createSessionStorageEngineStorageHost,
	type SessionStorageEngineStorageHostConfig,
} from "@proseql/engine/browser";
import { Layer } from "effect";

export type WebStorageConfig = SessionStorageEngineStorageHostConfig;

export function makeSessionStorageAdapter(
	storage: Storage = globalThis.sessionStorage,
	config: WebStorageConfig = {},
): StorageAdapterShape {
	return createEngineStorageAdapter(
		createSessionStorageEngineStorageHost({ ...config, storage }),
	);
}

export function makeSessionStorageLayer(
	config: WebStorageConfig = {},
): Layer.Layer<StorageAdapter> {
	return Layer.succeed(
		StorageAdapter,
		makeSessionStorageAdapter(globalThis.sessionStorage, config),
	);
}

export const SessionStorageLayer: Layer.Layer<StorageAdapter> =
	makeSessionStorageLayer();
