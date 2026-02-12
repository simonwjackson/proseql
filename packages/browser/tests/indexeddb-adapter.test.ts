import { Effect, Layer } from "effect";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { StorageAdapterService as StorageAdapter, StorageError } from "@proseql/core";
import { makeIndexedDBAdapter, makeIndexedDBStorageLayer } from "../src/adapters/indexeddb-adapter.js";

// ============================================================================
// Mock IndexedDB Implementation
// ============================================================================

/**
 * A minimal mock implementation of IndexedDB for testing.
 * Simulates the callback-based IndexedDB API with an in-memory store.
 */

class MockIDBRequest<T> implements IDBRequest<T> {
	result!: T;
	error: DOMException | null = null;
	source: IDBObjectStore | IDBIndex | IDBCursor | null = null;
	transaction: IDBTransaction | null = null;
	readyState: IDBRequestReadyState = "pending";
	onsuccess: ((this: IDBRequest<T>, ev: Event) => void) | null = null;
	onerror: ((this: IDBRequest<T>, ev: Event) => void) | null = null;

	// EventTarget interface stubs
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}
}

class MockIDBObjectStore implements IDBObjectStore {
	name: string;
	keyPath: string | string[];
	indexNames: DOMStringList = {
		length: 0,
		contains: () => false,
		item: () => null,
		[Symbol.iterator]: function* () {},
	};
	autoIncrement: boolean = false;
	transaction!: IDBTransaction;

	private store: Map<string, string>;

	constructor(name: string, store: Map<string, string>) {
		this.name = name;
		this.keyPath = "";
		this.store = store;
	}

	get(key: IDBValidKey): IDBRequest<string | undefined> {
		const request = new MockIDBRequest<string | undefined>();
		queueMicrotask(() => {
			request.result = this.store.get(key as string);
			request.readyState = "done";
			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});
		return request;
	}

	put(value: string, key?: IDBValidKey): IDBRequest<IDBValidKey> {
		const request = new MockIDBRequest<IDBValidKey>();
		queueMicrotask(() => {
			this.store.set(key as string, value);
			request.result = key as IDBValidKey;
			request.readyState = "done";
			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});
		return request;
	}

	delete(key: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
		const request = new MockIDBRequest<undefined>();
		queueMicrotask(() => {
			this.store.delete(key as string);
			request.result = undefined;
			request.readyState = "done";
			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});
		return request;
	}

	count(key?: IDBValidKey | IDBKeyRange): IDBRequest<number> {
		const request = new MockIDBRequest<number>();
		queueMicrotask(() => {
			request.result = this.store.has(key as string) ? 1 : 0;
			request.readyState = "done";
			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});
		return request;
	}

	// Stubs for other methods
	add(): IDBRequest<IDBValidKey> {
		throw new Error("Not implemented");
	}
	clear(): IDBRequest<undefined> {
		throw new Error("Not implemented");
	}
	getKey(): IDBRequest<IDBValidKey | undefined> {
		throw new Error("Not implemented");
	}
	getAll(): IDBRequest<unknown[]> {
		throw new Error("Not implemented");
	}
	getAllKeys(): IDBRequest<IDBValidKey[]> {
		throw new Error("Not implemented");
	}
	createIndex(): IDBIndex {
		throw new Error("Not implemented");
	}
	deleteIndex(): void {
		throw new Error("Not implemented");
	}
	index(): IDBIndex {
		throw new Error("Not implemented");
	}
	openCursor(): IDBRequest<IDBCursorWithValue | null> {
		throw new Error("Not implemented");
	}
	openKeyCursor(): IDBRequest<IDBCursor | null> {
		throw new Error("Not implemented");
	}
}

class MockIDBTransaction implements IDBTransaction {
	objectStoreNames: DOMStringList = {
		length: 1,
		contains: () => true,
		item: () => "collections",
		[Symbol.iterator]: function* () {
			yield "collections";
		},
	};
	mode: IDBTransactionMode = "readwrite";
	durability: IDBTransactionDurability = "default";
	db!: IDBDatabase;
	error: DOMException | null = null;
	onabort: ((this: IDBTransaction, ev: Event) => void) | null = null;
	oncomplete: ((this: IDBTransaction, ev: Event) => void) | null = null;
	onerror: ((this: IDBTransaction, ev: Event) => void) | null = null;

	private _objectStore: MockIDBObjectStore;

	constructor(store: MockIDBObjectStore) {
		this._objectStore = store;
		store.transaction = this;
	}

	objectStore(_name: string): IDBObjectStore {
		return this._objectStore;
	}

	abort(): void {}
	commit(): void {}

	// EventTarget interface stubs
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}
}

class MockIDBDatabase implements IDBDatabase {
	name: string;
	version: number = 1;
	objectStoreNames: DOMStringList = {
		length: 1,
		contains: () => true,
		item: () => "collections",
		[Symbol.iterator]: function* () {
			yield "collections";
		},
	};
	onabort: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onclose: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onerror: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onversionchange: ((this: IDBDatabase, ev: Event) => void) | null = null;

	private store: Map<string, string>;
	private objectStore: MockIDBObjectStore;

	constructor(name: string, store: Map<string, string>) {
		this.name = name;
		this.store = store;
		this.objectStore = new MockIDBObjectStore("collections", store);
	}

	transaction(
		_storeNames: string | string[],
		_mode?: IDBTransactionMode,
	): IDBTransaction {
		return new MockIDBTransaction(this.objectStore);
	}

	createObjectStore(name: string): IDBObjectStore {
		this.objectStoreNames = {
			length: 1,
			contains: (n: string) => n === name,
			item: () => name,
			[Symbol.iterator]: function* () {
				yield name;
			},
		};
		return this.objectStore;
	}

	deleteObjectStore(): void {}
	close(): void {}

	// EventTarget interface stubs
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}

	// Test utility
	getStore(): Map<string, string> {
		return this.store;
	}
}

class MockIDBOpenDBRequest implements IDBOpenDBRequest {
	result!: IDBDatabase;
	error: DOMException | null = null;
	source = null;
	transaction: IDBTransaction | null = null;
	readyState: IDBRequestReadyState = "pending";
	onsuccess: ((this: IDBRequest<IDBDatabase>, ev: Event) => void) | null = null;
	onerror: ((this: IDBRequest<IDBDatabase>, ev: Event) => void) | null = null;
	onblocked: ((this: IDBOpenDBRequest, ev: Event) => void) | null = null;
	onupgradeneeded:
		| ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => void)
		| null = null;

	// EventTarget interface stubs
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}
}

class MockIDBFactory implements IDBFactory {
	private databases: Map<string, MockIDBDatabase> = new Map();
	private globalStore: Map<string, string>;

	constructor(store: Map<string, string>) {
		this.globalStore = store;
	}

	open(name: string, _version?: number): IDBOpenDBRequest {
		const request = new MockIDBOpenDBRequest();

		queueMicrotask(() => {
			let db = this.databases.get(name);
			const isNew = !db;

			if (!db) {
				db = new MockIDBDatabase(name, this.globalStore);
				this.databases.set(name, db);
			}

			request.result = db;
			request.readyState = "done";

			// Fire onupgradeneeded for new databases
			if (isNew && request.onupgradeneeded) {
				request.onupgradeneeded.call(request, new Event("upgradeneeded") as IDBVersionChangeEvent);
			}

			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});

		return request;
	}

	deleteDatabase(name: string): IDBOpenDBRequest {
		const request = new MockIDBOpenDBRequest();
		queueMicrotask(() => {
			this.databases.delete(name);
			request.readyState = "done";
			if (request.onsuccess) {
				request.onsuccess.call(request, new Event("success"));
			}
		});
		return request;
	}

	cmp(): number {
		return 0;
	}

	databases(): Promise<IDBDatabaseInfo[]> {
		return Promise.resolve(
			Array.from(this.databases.keys()).map((name) => ({ name, version: 1 })),
		);
	}
}

// ============================================================================
// Test Helper
// ============================================================================

let mockStore: Map<string, string>;
let originalIndexedDB: IDBFactory;
let testCounter = 0;

const setupMockIndexedDB = () => {
	mockStore = new Map<string, string>();
	originalIndexedDB = globalThis.indexedDB;
	Object.defineProperty(globalThis, "indexedDB", {
		value: new MockIDBFactory(mockStore),
		writable: true,
		configurable: true,
	});
	testCounter++;
};

const teardownMockIndexedDB = () => {
	Object.defineProperty(globalThis, "indexedDB", {
		value: originalIndexedDB,
		writable: true,
		configurable: true,
	});
};

// Use unique database names to avoid module-level cache issues between tests
const getUniqueDbName = () => `testdb_${testCounter}`;

const createTestAdapter = (config: Record<string, unknown> = {}) => {
	// Each test gets a unique database name to avoid cache conflicts
	const finalConfig = {
		databaseName: getUniqueDbName(),
		...config,
	};
	const adapter = makeIndexedDBAdapter(finalConfig);
	const layer = Layer.succeed(StorageAdapter, adapter);
	return {
		adapter,
		layer,
		run: <A, E>(effect: Effect.Effect<A, E, StorageAdapter>) =>
			Effect.runPromise(Effect.provide(effect, layer)),
	};
};

// ============================================================================
// Tests
// ============================================================================

describe("IndexedDBAdapter", () => {
	beforeEach(() => {
		setupMockIndexedDB();
	});

	afterEach(() => {
		teardownMockIndexedDB();
	});

	// ========================================================================
	// 13.2: Test write then read round-trip
	// ========================================================================
	describe("write/read round-trip", () => {
		it("stores data and retrieves it correctly", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
					return yield* adapter.read("./data/books.yaml");
				}),
			);

			expect(result).toBe('{"title":"Dune"}');
		});

		it("stores data with the correct key prefix", async () => {
			const { run } = createTestAdapter();

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
				}),
			);

			// Default prefix is "proseql:"
			expect(mockStore.has("proseql:data/books.yaml")).toBe(true);
		});

		it("uses custom key prefix when configured", async () => {
			const { run } = createTestAdapter({ keyPrefix: "myapp:" });

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
				}),
			);

			expect(mockStore.has("myapp:data/books.yaml")).toBe(true);
		});

		it("overwrites existing data on subsequent writes", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./file.txt", "first");
					yield* adapter.write("./file.txt", "second");
					return yield* adapter.read("./file.txt");
				}),
			);

			expect(result).toBe("second");
		});
	});

	// ========================================================================
	// 13.3: Test exists returns false for missing key, true after write
	// ========================================================================
	describe("exists", () => {
		it("returns false for missing key", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.exists("./nonexistent.json");
				}),
			);

			expect(result).toBe(false);
		});

		it("returns true after write", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					const before = yield* adapter.exists("./file.txt");
					yield* adapter.write("./file.txt", "hello");
					const after = yield* adapter.exists("./file.txt");
					return { before, after };
				}),
			);

			expect(result.before).toBe(false);
			expect(result.after).toBe(true);
		});
	});

	// ========================================================================
	// 13.4: Test remove deletes the entry
	// ========================================================================
	describe("remove", () => {
		it("deletes an existing entry", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./file.txt", "data");
					yield* adapter.remove("./file.txt");
					return yield* adapter.exists("./file.txt");
				}),
			);

			expect(result).toBe(false);
		});

		it("succeeds silently for non-existent keys", async () => {
			const { run } = createTestAdapter();

			// Should not throw
			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.remove("./nonexistent.txt");
				}),
			);
		});
	});

	// ========================================================================
	// 13.5: Test read on missing key fails with StorageError
	// ========================================================================
	describe("read missing key", () => {
		it("fails with StorageError when key does not exist", async () => {
			const { layer } = createTestAdapter();

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const adapter = yield* StorageAdapter;
						return yield* adapter.read("./missing.json").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					layer,
				),
			);

			expect(result._tag).toBe("StorageError");
			if (result._tag === "StorageError") {
				expect(result.operation).toBe("read");
				expect(result.message).toContain("Key not found");
			}
		});
	});

	// ========================================================================
	// 13.6: Test database and object store are created on first access
	// ========================================================================
	describe("database creation", () => {
		it("creates database and object store on first access", async () => {
			const { run } = createTestAdapter({
				databaseName: "testdb",
				storeName: "teststore",
			});

			// Access the adapter which should trigger database creation
			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./test.txt", "data");
				}),
			);

			// Verify the data was stored
			expect(mockStore.has("proseql:test.txt")).toBe(true);
		});
	});

	// ========================================================================
	// 13.7: Test multiple collections can coexist with different keys
	// ========================================================================
	describe("multiple collections", () => {
		it("stores multiple collections with different keys", async () => {
			const { run } = createTestAdapter();

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./books.json", '{"type":"books"}');
					yield* adapter.write("./authors.json", '{"type":"authors"}');
					yield* adapter.write("./publishers.yaml", '{"type":"publishers"}');
				}),
			);

			expect(mockStore.has("proseql:books.json")).toBe(true);
			expect(mockStore.has("proseql:authors.json")).toBe(true);
			expect(mockStore.has("proseql:publishers.yaml")).toBe(true);
		});

		it("reads each collection independently", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./books.json", '{"type":"books"}');
					yield* adapter.write("./authors.json", '{"type":"authors"}');

					const books = yield* adapter.read("./books.json");
					const authors = yield* adapter.read("./authors.json");

					return { books, authors };
				}),
			);

			expect(result.books).toBe('{"type":"books"}');
			expect(result.authors).toBe('{"type":"authors"}');
		});

		it("removes one collection without affecting others", async () => {
			const { run } = createTestAdapter();

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./books.json", '{"type":"books"}');
					yield* adapter.write("./authors.json", '{"type":"authors"}');

					// Remove books but keep authors
					yield* adapter.remove("./books.json");

					const booksExist = yield* adapter.exists("./books.json");
					const authorsExist = yield* adapter.exists("./authors.json");

					return { booksExist, authorsExist };
				}),
			);

			expect(result.booksExist).toBe(false);
			expect(result.authorsExist).toBe(true);
		});
	});

	// ========================================================================
	// ensureDir is a no-op
	// ========================================================================
	describe("ensureDir", () => {
		it("succeeds without side effects (no-op)", async () => {
			const { run } = createTestAdapter();
			const initialSize = mockStore.size;

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.ensureDir("./some/deep/path");
				}),
			);

			// No new entries should be created
			expect(mockStore.size).toBe(initialSize);
		});
	});

	// ========================================================================
	// watch returns a no-op
	// ========================================================================
	describe("watch (no-op)", () => {
		it("returns a no-op unsubscribe function", async () => {
			const { run } = createTestAdapter();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./file.txt", () => {
						// IndexedDB has no native change notification
					});
				}),
			);

			// The unsubscribe function should exist and be callable
			expect(typeof unsubscribe).toBe("function");

			// Calling unsubscribe should not throw
			expect(() => unsubscribe()).not.toThrow();
		});
	});

	// ========================================================================
	// Layer factory tests
	// ========================================================================
	describe("makeIndexedDBStorageLayer", () => {
		it("creates a Layer that provides StorageAdapter", async () => {
			const layer = makeIndexedDBStorageLayer({ keyPrefix: "test:" });

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const adapter = yield* StorageAdapter;
						yield* adapter.write("./file.txt", "content");
					}),
					layer,
				),
			);

			expect(mockStore.has("test:file.txt")).toBe(true);
		});

		it("allows custom database configuration", async () => {
			const layer = makeIndexedDBStorageLayer({
				databaseName: "customdb",
				storeName: "customstore",
				version: 2,
			});

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const adapter = yield* StorageAdapter;
						yield* adapter.write("./data.json", '{"test":true}');
					}),
					layer,
				),
			);

			// The data should still be stored correctly
			expect(mockStore.has("proseql:data.json")).toBe(true);
		});
	});
});
