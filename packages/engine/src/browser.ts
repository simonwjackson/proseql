export * from "@proseql/core";

import { OperationError } from "@proseql/core";
import {
	type BrowserEngineStorageHost,
	type BrowserStorageHostConfig,
	createIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createServiceWorkerIndexedDBEngineStorageHost,
	createSessionStorageEngineStorageHost,
	createWebStorageEngineStorageHost,
	DEFAULT_STORAGE_KEY_PREFIX,
	type IndexedDBEngineHostConfig,
	type LocalStorageEngineStorageHostConfig,
	type ServiceWorkerIndexedDBEngineHostConfig,
	type SessionStorageEngineStorageHostConfig,
	type WebStorageEngineHostConfig,
} from "./browser-storage-host.js";
import {
	createEngineDatabase as createBaseEngineDatabase,
	createPersistentEngineDatabase as createBasePersistentEngineDatabase,
} from "./database.js";
import { WasmEngineDefectError } from "./errors.js";
import {
	createEngineStorageAdapter,
	type EngineStorageHost,
	makeEngineStorageLayer,
} from "./storage-host-shared.js";
import type {
	EngineCollection,
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	EngineQueryReturnType,
	EngineWatchConfig,
	GenerateEngineDatabase,
	GenerateEngineDatabaseWithPersistence,
	WatchSubscription,
} from "./types.js";

export { WasmEngineDefectError };
export {
	createIndexedDBEngineStorageHost,
	createServiceWorkerIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createSessionStorageEngineStorageHost,
	createWebStorageEngineStorageHost,
	DEFAULT_STORAGE_KEY_PREFIX,
	type BrowserEngineStorageHost,
	type BrowserStorageHostConfig,
	type IndexedDBEngineHostConfig,
	type ServiceWorkerIndexedDBEngineHostConfig,
	type LocalStorageEngineStorageHostConfig,
	type SessionStorageEngineStorageHostConfig,
	type WebStorageEngineHostConfig,
};
export { createEngineStorageAdapter, makeEngineStorageLayer };
export type {
	EngineStorageHost,
	EngineStorageWatchEvent,
} from "./storage-host-shared.js";
export type {
	EngineCollection,
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	EngineQueryReturnType,
	EngineWatchConfig,
	GenerateEngineDatabase,
	GenerateEngineDatabaseWithPersistence,
	WatchSubscription,
};

export const createEngineDatabase = createBaseEngineDatabase;

const defaultBrowserStorageHost = (): EngineStorageHost => {
	if (typeof globalThis.localStorage !== "undefined") {
		return createLocalStorageEngineStorageHost();
	}
	throw new OperationError({
		operation: "database",
		reason: "browser-storage-host-unavailable",
		message:
			"No browser storage host is available. Provide persistenceOptions.storageHost explicitly or run in an environment with localStorage.",
	});
};

export const createPersistentEngineDatabase = async <
	Config extends Record<string, any>,
>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	persistenceOptions?: EnginePersistenceOptions,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabaseWithPersistence<Config>> =>
	createBasePersistentEngineDatabase(
		config,
		initialData,
		{
			...persistenceOptions,
			storageHost:
				persistenceOptions?.storageHost ?? defaultBrowserStorageHost(),
		},
		options,
	) as Promise<GenerateEngineDatabaseWithPersistence<Config>>;
