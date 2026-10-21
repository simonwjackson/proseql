import type { StorageAdapterShape } from "@proseql/core";
import {
	createEngineStorageAdapter,
	createWebStorageEngineStorageHost,
	DEFAULT_STORAGE_KEY_PREFIX,
	type EngineStorageHost,
	type WebStorageEngineHostConfig,
} from "@proseql/engine/browser";

export type WebStorageConfig = WebStorageEngineHostConfig;

export type WatchImplementation = (
	key: string,
	onChange: () => void,
) => Promise<() => void>;

export function makeWebStorageAdapter(
	storage: Storage,
	config: WebStorageConfig = {},
	watchImpl?: WatchImplementation,
): StorageAdapterShape {
	const host = createWebStorageEngineStorageHost({
		...config,
		storage,
		kind: config.kind,
	});
	const prefix = config.keyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX;
	const wrappedHost: EngineStorageHost =
		watchImpl === undefined
			? host
			: {
					...host,
					watch: (path, onChange) =>
						watchImpl(
							`${prefix}${path.replace(/\\/g, "/").replace(/^\.\//, "")}`,
							onChange,
						),
				};
	return createEngineStorageAdapter(wrappedHost);
}

export const makeWebStorageHost = (
	storage: Storage,
	config: WebStorageConfig = {},
): EngineStorageHost =>
	createWebStorageEngineStorageHost({
		...config,
		storage,
		kind: config.kind,
	});
