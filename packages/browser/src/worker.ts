/// <reference lib="webworker" />

/**
 * Service-worker-safe ProseQL entry point.
 *
 * This entry statically includes the matching WASM glue. Call
 * `initializeWorkerWasmBindings()` during the worker event lifetime before
 * opening the database; no dynamic import or Node builtin is used.
 */
export {
	createServiceWorkerEngineDatabase,
	createServiceWorkerIndexedDBEngineStorageHost,
	getLoadedWasmMemoryByteLength,
	initializeWorkerWasmBindings,
	type ServiceWorkerIndexedDBEngineHostConfig,
	WasmInitializationError,
	WorkerWasmInitializationError,
	workerWasmUrl,
} from "@proseql/engine/worker";
