export * from "@proseql/core";

import { OperationError } from "@proseql/core";
import {
	createEngineDatabase as createBaseEngineDatabase,
	createPersistentEngineDatabase as createBasePersistentEngineDatabase,
} from "./database.js";
import {
	createLocalStorageEngineStorageHost,
	createIndexedDBEngineStorageHost,
	createSessionStorageEngineStorageHost,
	createWebStorageEngineStorageHost,
	DEFAULT_STORAGE_KEY_PREFIX,
	type BrowserEngineStorageHost,
	type BrowserStorageHostConfig,
	type IndexedDBEngineHostConfig,
	type LocalStorageEngineStorageHostConfig,
	type SessionStorageEngineStorageHostConfig,
	type WebStorageEngineHostConfig,
} from "./browser-storage-host.js";
import { WasmEngineDefectError } from "./errors.js";
import {
	createEngineStorageAdapter,
	makeEngineStorageLayer,
	type EngineStorageHost,
	type EngineStorageWatchEvent,
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
	createLocalStorageEngineStorageHost,
	createSessionStorageEngineStorageHost,
	createWebStorageEngineStorageHost,
	DEFAULT_STORAGE_KEY_PREFIX,
	type BrowserEngineStorageHost,
	type BrowserStorageHostConfig,
	type IndexedDBEngineHostConfig,
	type LocalStorageEngineStorageHostConfig,
	type SessionStorageEngineStorageHostConfig,
	type WebStorageEngineHostConfig,
};
export {
	createEngineStorageAdapter,
	makeEngineStorageLayer,
	type EngineStorageHost,
	type EngineStorageWatchEvent,
};
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

export const createPersistentEngineDatabase = async <Config extends Record<string, any>>(
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
			storageHost: persistenceOptions?.storageHost ?? defaultBrowserStorageHost(),
		},
		options,
	) as Promise<GenerateEngineDatabaseWithPersistence<Config>>;
