/// <reference lib="webworker" />

import type { DatabaseConfig } from "@proseql/core";
import { createPersistentEngineDatabase } from "./browser.js";
// @ts-expect-error generated at build time by packages/engine/scripts/build-wasm.mjs
import initBrowserWasm, * as browserWasm from "./browser-wasm/proseql_wasm.js";
import { preloadBrowserWasmBindings } from "./loader.js";
import type {
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	GenerateEngineDatabaseWithPersistence,
} from "./types.js";

export {
	createServiceWorkerIndexedDBEngineStorageHost,
	type ServiceWorkerIndexedDBEngineHostConfig,
} from "./browser-storage-host.js";
export {
	getLoadedWasmMemoryByteLength,
	WasmInitializationError,
	WorkerWasmInitializationError,
} from "./loader.js";

let workerInitialization: Promise<unknown> | undefined;

export const workerWasmUrl = new URL(
	"./browser-wasm/proseql_wasm_bg.wasm",
	import.meta.url,
);

/** Initialize the statically imported worker-safe WASM binding.
 *
 * Dynamic import() is forbidden by ServiceWorkerGlobalScope, so worker users
 * must call this before opening a database. The matching `.wasm` URL remains
 * relative to the package artifact and is therefore precacheable.
 */
export const initializeWorkerWasmBindings = (
	wasmInput:
		| RequestInfo
		| URL
		| Response
		| BufferSource
		| WebAssembly.Module = workerWasmUrl,
): Promise<unknown> => {
	workerInitialization ??= preloadBrowserWasmBindings(
		{ ...browserWasm, default: initBrowserWasm },
		wasmInput,
	);
	return workerInitialization;
};

const MUTATION_METHODS = new Set([
	"create",
	"createMany",
	"update",
	"updateMany",
	"delete",
	"deleteMany",
	"upsert",
	"upsertMany",
	"createWithRelationships",
	"updateWithRelationships",
	"deleteWithRelationships",
	"deleteManyWithRelationships",
]);

/**
 * Open a worker-owned persistent database whose entire public operation stream
 * is FIFO serialized. Mutations are acknowledged only after `flush()` has
 * completed. A persistence failure closes and quarantines this facade; callers
 * must construct a fresh facade, which reloads the last durable IndexedDB state.
 */
export const createServiceWorkerEngineDatabase = async <
	Config extends DatabaseConfig,
>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	persistenceOptions?: EnginePersistenceOptions,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabaseWithPersistence<Config>> => {
	await initializeWorkerWasmBindings();
	const database = await createPersistentEngineDatabase(
		config,
		initialData,
		persistenceOptions,
		options,
	);
	const abortPersistence = () =>
		(
			database as unknown as {
				readonly __proseqlAbortPersistence?: () => Promise<void>;
			}
		)
			.__proseqlAbortPersistence?.()
			.catch(() => undefined);
	try {
		await database.flush();
	} catch (error) {
		await abortPersistence();
		throw error;
	}

	let tail: Promise<void> = Promise.resolve();
	let quarantined: unknown;
	let closed = false;

	const assertUsable = () => {
		if (quarantined !== undefined) {
			throw new Error(
				"The worker database is quarantined after a durable persistence failure; reopen it before further access.",
				{ cause: quarantined },
			);
		}
		if (closed) throw new Error("The worker database is closed");
	};

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(async () => {
			assertUsable();
			return operation();
		});
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const quarantine = async (error: unknown): Promise<never> => {
		quarantined = error;
		await abortPersistence();
		throw error;
	};

	const wrapCollection = (collection: Record<string, unknown>) =>
		new Proxy(collection, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof property !== "string" || typeof value !== "function") {
					return value;
				}
				if (property === "watch" || property === "watchById") {
					return () => {
						assertUsable();
						throw new Error(
							"Worker-owned durable facades do not expose pre-commit watches; publish application messages only after the mutating request resolves.",
						);
					};
				}
				return (...args: unknown[]) =>
					enqueue(async () => {
						const result = await Reflect.apply(value, target, args);
						if (MUTATION_METHODS.has(property)) {
							try {
								await database.flush();
							} catch (error) {
								return quarantine(error);
							}
						}
						return result;
					});
			},
		});

	const root = database as unknown as Record<string, unknown>;
	return new Proxy(root, {
		get(target, property, receiver) {
			if (property === "close") {
				return () => {
					const result = tail.then(async () => {
						if (closed) return;
						closed = true;
						await database.close();
					});
					tail = result.then(
						() => undefined,
						() => undefined,
					);
					return result;
				};
			}
			if (property === "flush") {
				return () => enqueue(() => database.flush());
			}
			if (property === "$transaction") {
				const transaction = Reflect.get(target, property, receiver);
				return (...args: unknown[]) =>
					enqueue(async () => {
						const result = await Reflect.apply(
							transaction as (...parameters: unknown[]) => unknown,
							target,
							args,
						);
						try {
							await database.flush();
						} catch (error) {
							return quarantine(error);
						}
						return result;
					});
			}
			const value = Reflect.get(target, property, receiver);
			if (
				typeof value === "object" &&
				value !== null &&
				typeof property === "string"
			) {
				return wrapCollection(value as Record<string, unknown>);
			}
			return value;
		},
	}) as GenerateEngineDatabaseWithPersistence<Config>;
};
