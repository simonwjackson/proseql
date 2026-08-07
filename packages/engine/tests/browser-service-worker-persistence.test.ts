import { describe, expect, it } from "vitest";
import {
	createIndexedDBEngineStorageHost,
	createServiceWorkerIndexedDBEngineStorageHost,
} from "../src/browser-storage-host.js";

type PendingTransaction = {
	readonly mode: IDBTransactionMode;
	complete(): void;
	abort(error?: DOMException): void;
};

const makeControlledIndexedDb = () => {
	const values = new Map<string, string>();
	const pendingWrites: PendingTransaction[] = [];
	let closeCount = 0;
	const database = {
		name: "worker-test",
		version: 1,
		objectStoreNames: { contains: () => true },
		onversionchange: null,
		onclose: null,
		close() {
			closeCount += 1;
		},
		transaction(_storeName: string, mode: IDBTransactionMode) {
			let staged: { key: string; value: string } | undefined;
			const transaction = {
				db: database,
				mode,
				error: null as DOMException | null,
				oncomplete: null as (() => void) | null,
				onabort: null as (() => void) | null,
				onerror: null as (() => void) | null,
				objectStore() {
					return {
						get(key: string) {
							const request = {
								result: undefined as string | undefined,
								error: null,
								onsuccess: null as (() => void) | null,
								onerror: null as (() => void) | null,
							};
							queueMicrotask(() => {
								request.result = values.get(key);
								request.onsuccess?.();
								queueMicrotask(() => transaction.oncomplete?.());
							});
							return request;
						},
						put(value: string, key: string) {
							const request = {
								result: key,
								error: null,
								onsuccess: null as (() => void) | null,
								onerror: null as (() => void) | null,
							};
							staged = { key, value };
							queueMicrotask(() => request.onsuccess?.());
							return request;
						},
					};
				},
			};
			if (mode === "readwrite") {
				pendingWrites.push({
					mode,
					complete() {
						if (staged) values.set(staged.key, staged.value);
						transaction.oncomplete?.();
					},
					abort(error = new DOMException("quota", "QuotaExceededError")) {
						transaction.error = error;
						transaction.onabort?.();
					},
				});
			}
			return transaction;
		},
	};
	const factory = {
		open() {
			const request = {
				result: database,
				error: null,
				onsuccess: null as (() => void) | null,
				onerror: null as (() => void) | null,
				onblocked: null as (() => void) | null,
				onupgradeneeded: null as (() => void) | null,
			};
			queueMicrotask(() => request.onsuccess?.());
			return request;
		},
	};
	return {
		factory: factory as unknown as IDBFactory,
		values,
		pendingWrites,
		get closeCount() {
			return closeCount;
		},
	};
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("worker IndexedDB durability", () => {
	it("does not resolve a write at request success before transaction completion", async () => {
		const controlled = makeControlledIndexedDb();
		const host = createIndexedDBEngineStorageHost({
			indexedDB: controlled.factory,
			databaseName: "worker-complete",
		});
		let settled = false;
		const write = host.write("books.json", "durable").then(() => {
			settled = true;
		});
		await tick();
		expect(controlled.pendingWrites).toHaveLength(1);
		expect(settled).toBe(false);
		expect(controlled.values.size).toBe(0);
		controlled.pendingWrites[0]?.complete();
		await write;
		expect(controlled.values.get("proseql:books.json")).toBe("durable");
	});

	it("rejects blocked worker opens with a typed error and permits a clean retry host", async () => {
		const blockedFactory = {
			open() {
				const request = {
					result: undefined,
					error: null,
					onsucceed: null,
					onsuccess: null,
					onerror: null,
					onblocked: null as (() => void) | null,
					onupgradeneeded: null,
				};
				queueMicrotask(() => request.onblocked?.());
				return request;
			},
		} as unknown as IDBFactory;
		const host = createServiceWorkerIndexedDBEngineStorageHost({
			databaseName: "worker-blocked",
			storeName: "collections",
			version: 1,
			keyPrefix: "worker-blocked:",
			channelName: "worker-blocked-channel",
			originId: "worker-blocked-owner",
			indexedDB: blockedFactory,
		});

		await expect(host.read("books.json")).rejects.toMatchObject({
			_tag: "StorageError",
			message: expect.stringContaining("blocked"),
		});
	});

	it("requires explicit stable worker storage identity", () => {
		expect(() =>
			createServiceWorkerIndexedDBEngineStorageHost({
				databaseName: "",
				storeName: "collections",
				version: 1,
				keyPrefix: "worker:",
				channelName: "worker-channel",
				originId: "worker-owner",
			}),
		).toThrow("databaseName");
	});

	it("surfaces transaction abort and close waits for in-flight work", async () => {
		const controlled = makeControlledIndexedDb();
		const host = createIndexedDBEngineStorageHost({
			indexedDB: controlled.factory,
			databaseName: "worker-abort",
		});
		const write = host.write("books.json", "not-durable");
		await tick();
		let closeSettled = false;
		const closing = host.close?.().then(() => {
			closeSettled = true;
		});
		await tick();
		expect(closeSettled).toBe(false);
		controlled.pendingWrites[0]?.abort();
		await expect(write).rejects.toMatchObject({ _tag: "StorageError" });
		await closing;
		expect(controlled.values.size).toBe(0);
		expect(controlled.closeCount).toBe(1);
		await expect(host.read("books.json")).rejects.toMatchObject({
			_tag: "StorageError",
		});
	});
});
