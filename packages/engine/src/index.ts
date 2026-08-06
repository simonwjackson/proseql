export * from "@proseql/core";

export {
	createEngineDatabase,
	createPersistentEngineDatabase,
} from "./database.js";
export { WasmEngineDefectError } from "./errors.js";
export {
	createNodeEngineStorageHost,
	makeEngineStorageLayer,
	makeNodeEngineStorageLayer,
	type NodeEngineStorageHost,
	type NodeEngineStorageHostConfig,
} from "./storage-host.js";
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
} from "./types.js";
