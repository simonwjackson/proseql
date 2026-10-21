/// <reference lib="webworker" />

import {
	createServiceWorkerEngineDatabase,
	createServiceWorkerIndexedDBEngineStorageHost,
	getLoadedWasmMemoryByteLength,
	initializeWorkerWasmBindings,
	workerWasmUrl,
} from "@proseql/effect/browser/worker";
import { Schema } from "effect";

declare const self: ServiceWorkerGlobalScope;

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const config = {
	books: {
		schema: BookSchema,
		file: "./data/worker-books.json",
		relationships: {},
	},
} as const;

const databaseName = "proseql-service-worker-smoke";
const keyPrefix = "service-worker-smoke:";
const wasmCacheName = "proseql-service-worker-smoke-wasm-v1";
const initializeFromCache = async () => {
	const cache = await caches.open(wasmCacheName);
	let response = await cache.match(workerWasmUrl);
	if (!response) {
		response = await fetch(workerWasmUrl);
		if (!response.ok) {
			throw new Error(`Unable to fetch worker WASM: ${response.status}`);
		}
		await cache.put(workerWasmUrl, response.clone());
	}
	return initializeWorkerWasmBindings(response);
};
const workerReady = initializeFromCache();
let databasePromise:
	| ReturnType<typeof createServiceWorkerEngineDatabase<typeof config>>
	| undefined;
let failNextWrite = false;

const openDatabase = () => {
	if (databasePromise) return databasePromise;
	const indexedDbHost = createServiceWorkerIndexedDBEngineStorageHost({
		databaseName,
		storeName: "collections",
		version: 1,
		keyPrefix,
		channelName: "proseql-service-worker-smoke-channel",
		originId: "proseql-service-worker-owner",
	});
	const storageHost = {
		...indexedDbHost,
		async write(path: string, data: string) {
			if (failNextWrite) {
				failNextWrite = false;
				throw new DOMException("Injected quota failure", "QuotaExceededError");
			}
			return indexedDbHost.write(path, data);
		},
	};
	databasePromise = workerReady.then(() =>
		createServiceWorkerEngineDatabase(
			config,
			{ books: [] },
			{ writeDebounce: 0, storageHost },
		),
	);
	return databasePromise;
};

self.addEventListener("install", (event) => {
	event.waitUntil(workerReady.then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
	const request = event.data as {
		readonly id: string;
		readonly command: string;
	};
	const port = event.ports[0];
	if (!port) return;
	event.waitUntil(
		(async () => {
			try {
				if (request.command === "close") {
					const database = await databasePromise;
					await database?.close();
					databasePromise = undefined;
					port.postMessage({ id: request.id, ok: true });
					return;
				}
				if (request.command === "metrics") {
					const memory = await getLoadedWasmMemoryByteLength();
					const performanceMemory = performance as Performance & {
						readonly memory?: { readonly usedJSHeapSize?: number };
					};
					port.postMessage({
						id: request.id,
						ok: true,
						value: {
							wasmLinearMemoryBytes: memory,
							jsHeapBytes: performanceMemory.memory?.usedJSHeapSize,
						},
					});
					return;
				}
				if (request.command === "reopen") {
					databasePromise = undefined;
					const database = await openDatabase();
					const value = await database.books.query({ sort: { id: "asc" } });
					port.postMessage({
						id: request.id,
						ok: true,
						value: value.map((row) => ({ ...row })),
					});
					return;
				}
				const database = await openDatabase();
				if (request.command === "create") {
					const value = await database.books.create({
						id: "worker-book",
						title: "Durable worker",
					});
					port.postMessage({ id: request.id, ok: true, value: { ...value } });
					return;
				}
				if (
					request.command === "fifo-update-first" ||
					request.command === "fifo-update-second"
				) {
					const value = await database.books.update("worker-book", {
						title:
							request.command === "fifo-update-first"
								? "FIFO first"
								: "FIFO second",
					});
					port.postMessage({ id: request.id, ok: true, value: { ...value } });
					return;
				}
				if (request.command === "fail-create") {
					failNextWrite = true;
					await database.books.create({
						id: "failed-book",
						title: "Must never be acknowledged",
					});
					throw new Error(
						"Injected persistence failure was unexpectedly acknowledged",
					);
				}
				if (request.command === "read") {
					const value = await database.books.query({ sort: { id: "asc" } });
					port.postMessage({
						id: request.id,
						ok: true,
						value: value.map((row) => ({ ...row })),
					});
					return;
				}
				throw new Error(`Unknown command: ${request.command}`);
			} catch (error) {
				port.postMessage({
					id: request.id,
					ok: false,
					error:
						error instanceof Error
							? `${error.name}: ${error.message}`
							: String(error),
				});
			}
		})(),
	);
});
