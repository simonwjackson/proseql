import {
	createPersistentEffectDatabase,
	jsonCodec,
	makeSerializerLayer,
	StorageAdapterService as StorageAdapter,
	yamlCodec,
} from "@proseql/core";
import { Chunk, Effect, Layer, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeIndexedDBAdapter,
	makeLocalStorageAdapter,
} from "../src/browser-adapter-layer.js";

// ============================================================================
// Mock Storage Implementations
// ============================================================================

/**
 * A mock implementation of the Web Storage API (localStorage/sessionStorage).
 */
class MockStorage implements Storage {
	private store = new Map<string, string>();

	get length(): number {
		return this.store.size;
	}

	key(index: number): string | null {
		const keys = Array.from(this.store.keys());
		return keys[index] ?? null;
	}

	getItem(key: string): string | null {
		return this.store.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value);
	}

	removeItem(key: string): void {
		this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	getStore(): Map<string, string> {
		return this.store;
	}
}

// ============================================================================
// Mock IndexedDB Implementation
// ============================================================================

class MockIDBRequest<T> implements IDBRequest<T> {
	result!: T;
	error: DOMException | null = null;
	source: IDBObjectStore | IDBIndex | IDBCursor | null = null;
	transaction: IDBTransaction | null = null;
	readyState: IDBRequestReadyState = "pending";
	onsuccess: ((this: IDBRequest<T>, ev: Event) => void) | null = null;
	onerror: ((this: IDBRequest<T>, ev: Event) => void) | null = null;

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

	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}

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

	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}
}

class MockIDBFactory implements IDBFactory {
	private _databases: Map<string, MockIDBDatabase> = new Map();
	private globalStore: Map<string, string>;

	constructor(store: Map<string, string>) {
		this.globalStore = store;
	}

	open(name: string, _version?: number): IDBOpenDBRequest {
		const request = new MockIDBOpenDBRequest();

		queueMicrotask(() => {
			let db = this._databases.get(name);
			const isNew = !db;

			if (!db) {
				db = new MockIDBDatabase(name, this.globalStore);
				this._databases.set(name, db);
			}

			request.result = db;
			request.readyState = "done";

			if (isNew && request.onupgradeneeded) {
				request.onupgradeneeded.call(
					request,
					new Event("upgradeneeded") as IDBVersionChangeEvent,
				);
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
			this._databases.delete(name);
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
			Array.from(this._databases.keys()).map((name) => ({ name, version: 1 })),
		);
	}
}

// ============================================================================
// Test Schemas
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	nationality: Schema.optional(Schema.String),
});

// ============================================================================
// Test Helpers
// ============================================================================

let testCounter = 0;
const getUniquePrefix = () => `test${testCounter++}:`;

// ============================================================================
// Tests
// ============================================================================

describe("Browser Storage Integration", () => {
	describe("LocalStorageLayer", () => {
		let mockStorage: MockStorage;

		beforeEach(() => {
			mockStorage = new MockStorage();
			testCounter++;
		});

		// ====================================================================
		// 15.2: Full database lifecycle with LocalStorageLayer
		// ====================================================================
		it("creates persistent database, inserts records, reloads from storage, verifies data", async () => {
			const keyPrefix = getUniquePrefix();

			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const initialBooks = [
				{
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
			];

			// Phase 1: Create database and insert records
			const adapter = makeLocalStorageAdapter(mockStorage, { keyPrefix });
			const storageLayer = Layer.succeed(StorageAdapter, adapter);
			const serializerLayer = makeSerializerLayer([jsonCodec()]);
			const layer = Layer.merge(storageLayer, serializerLayer);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: initialBooks },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						// Insert a new book
						yield* db.books.create({
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							genre: "sci-fi",
						});

						// Flush to ensure write completes
						yield* Effect.promise(() => db.flush());

						// Verify we have 2 books
						const allBooks = yield* Stream.runCollect(db.books.query());
						expect(Chunk.toArray(allBooks)).toHaveLength(2);
					}),
				),
			);

			// Verify data was persisted to storage
			const storedData = mockStorage.getItem(`${keyPrefix}data/books.json`);
			expect(storedData).toBeDefined();
			const parsed = JSON.parse(storedData ?? "");
			expect(Object.keys(parsed)).toHaveLength(2);

			// Phase 2: Reload from storage with fresh database instance
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						// Data should be loaded from storage
						const allBooks = yield* Stream.runCollect(db.books.query());
						const books = Chunk.toArray(allBooks);
						expect(books).toHaveLength(2);

						// Verify specific records
						const dune = books.find(
							(b) => (b as Record<string, unknown>).title === "Dune",
						);
						const neuromancer = books.find(
							(b) => (b as Record<string, unknown>).title === "Neuromancer",
						);
						expect(dune).toBeDefined();
						expect(neuromancer).toBeDefined();
					}),
				),
			);
		});

		it("supports multiple collections with different files", async () => {
			const keyPrefix = getUniquePrefix();

			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
				authors: {
					schema: AuthorSchema,
					file: "./data/authors.json",
					relationships: {},
				},
			} as const;

			const adapter = makeLocalStorageAdapter(mockStorage, { keyPrefix });
			const storageLayer = Layer.succeed(StorageAdapter, adapter);
			const serializerLayer = makeSerializerLayer([jsonCodec()]);
			const layer = Layer.merge(storageLayer, serializerLayer);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{
									books: [],
									authors: [],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Create records in both collections
						yield* db.books.create({
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
						});

						yield* db.authors.create({
							name: "Frank Herbert",
							nationality: "American",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify both files exist
			expect(mockStorage.getItem(`${keyPrefix}data/books.json`)).toBeDefined();
			expect(
				mockStorage.getItem(`${keyPrefix}data/authors.json`),
			).toBeDefined();

			// Verify each has one record
			const booksData = JSON.parse(
				mockStorage.getItem(`${keyPrefix}data/books.json`) ?? "",
			);
			const authorsData = JSON.parse(
				mockStorage.getItem(`${keyPrefix}data/authors.json`) ?? "",
			);
			expect(Object.keys(booksData)).toHaveLength(1);
			expect(Object.keys(authorsData)).toHaveLength(1);
		});

		it("supports YAML format", async () => {
			const keyPrefix = getUniquePrefix();

			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.yaml",
					relationships: {},
				},
			} as const;

			const adapter = makeLocalStorageAdapter(mockStorage, { keyPrefix });
			const storageLayer = Layer.succeed(StorageAdapter, adapter);
			const serializerLayer = makeSerializerLayer([yamlCodec()]);
			const layer = Layer.merge(storageLayer, serializerLayer);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						yield* db.books.create({
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify YAML format was used
			const storedData = mockStorage.getItem(`${keyPrefix}data/books.yaml`);
			expect(storedData).toBeDefined();
			// YAML doesn't start with { like JSON
			expect(storedData?.startsWith("{")).toBe(false);
			// Should contain the book title
			expect(storedData ?? "").toContain("Dune");
		});
	});

	describe("IndexedDBStorageLayer", () => {
		let mockStore: Map<string, string>;
		let originalIndexedDB: IDBFactory;
		let mockFactory: MockIDBFactory;

		beforeEach(() => {
			mockStore = new Map<string, string>();
			originalIndexedDB = globalThis.indexedDB;
			mockFactory = new MockIDBFactory(mockStore);
			Object.defineProperty(globalThis, "indexedDB", {
				value: mockFactory,
				writable: true,
				configurable: true,
			});
			testCounter++;
		});

		afterEach(() => {
			Object.defineProperty(globalThis, "indexedDB", {
				value: originalIndexedDB,
				writable: true,
				configurable: true,
			});
		});

		// ====================================================================
		// 15.3: Full database lifecycle with IndexedDBStorageLayer
		// ====================================================================
		it("creates persistent database with larger dataset, reloads from storage", async () => {
			const keyPrefix = getUniquePrefix();
			// Use unique database name to avoid cache conflicts
			const dbName = `testdb_integration_${testCounter}_${Date.now()}`;

			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			// Create a larger dataset
			const initialBooks = Array.from({ length: 100 }, (_, i) => ({
				id: `book-${i}`,
				title: `Book ${i}`,
				author: `Author ${i % 10}`,
				year: 1950 + i,
				genre: i % 2 === 0 ? "sci-fi" : "fantasy",
			}));

			const adapter = makeIndexedDBAdapter({ keyPrefix, databaseName: dbName });
			const storageLayer = Layer.succeed(StorageAdapter, adapter);
			const serializerLayer = makeSerializerLayer([jsonCodec()]);
			const layer = Layer.merge(storageLayer, serializerLayer);

			// Phase 1: Create database and load initial data
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: initialBooks },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						// Add more books
						yield* db.books.create({
							title: "Extra Book 1",
							author: "New Author",
							year: 2024,
							genre: "sci-fi",
						});

						yield* db.books.create({
							title: "Extra Book 2",
							author: "New Author",
							year: 2024,
							genre: "fantasy",
						});

						yield* Effect.promise(() => db.flush());

						// Verify count
						const allBooks = yield* Stream.runCollect(db.books.query());
						expect(Chunk.toArray(allBooks)).toHaveLength(102);
					}),
				),
			);

			// Phase 2: Reload from IndexedDB (using same adapter - same database and store)
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						const allBooks = yield* Stream.runCollect(db.books.query());
						expect(Chunk.toArray(allBooks)).toHaveLength(102);

						// Query with filter
						const sciFiBooks = yield* Stream.runCollect(
							db.books.query({ where: { genre: "sci-fi" } }),
						);
						expect(Chunk.toArray(sciFiBooks).length).toBeGreaterThan(0);
					}),
				),
			);
		});

		it("handles CRUD operations correctly", async () => {
			const keyPrefix = getUniquePrefix();

			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const adapter = makeIndexedDBAdapter({
				keyPrefix,
				databaseName: `testdb_${testCounter}`,
			});
			const storageLayer = Layer.succeed(StorageAdapter, adapter);
			const serializerLayer = makeSerializerLayer([jsonCodec()]);
			const layer = Layer.merge(storageLayer, serializerLayer);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							layer,
						);

						// Create
						const dune = yield* db.books.create({
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
						});
						expect(dune.title).toBe("Dune");

						// Read
						const found = yield* db.books.findById(dune.id);
						expect(found.title).toBe("Dune");

						// Update
						const updated = yield* db.books.update(dune.id, {
							genre: "classic",
						});
						expect(updated.genre).toBe("classic");

						// Delete
						const deleted = yield* db.books.delete(dune.id);
						expect(deleted.id).toBe(dune.id);

						// Verify deletion
						const allBooks = yield* Stream.runCollect(db.books.query());
						expect(Chunk.toArray(allBooks)).toHaveLength(0);

						yield* Effect.promise(() => db.flush());
					}),
				),
			);
		});
	});

	// ========================================================================
	// 15.4: Switching between localStorage and IndexedDB layers
	// ========================================================================
	describe("Layer switching", () => {
		let mockLocalStorage: MockStorage;
		let mockIndexedDBStore: Map<string, string>;
		let originalIndexedDB: IDBFactory;

		beforeEach(() => {
			mockLocalStorage = new MockStorage();
			mockIndexedDBStore = new Map<string, string>();
			originalIndexedDB = globalThis.indexedDB;
			Object.defineProperty(globalThis, "indexedDB", {
				value: new MockIDBFactory(mockIndexedDBStore),
				writable: true,
				configurable: true,
			});
			testCounter++;
		});

		afterEach(() => {
			Object.defineProperty(globalThis, "indexedDB", {
				value: originalIndexedDB,
				writable: true,
				configurable: true,
			});
		});

		it("same database config works with both localStorage and IndexedDB", async () => {
			const config = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const initialBooks = [
				{
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
			];

			const serializerLayer = makeSerializerLayer([jsonCodec()]);

			// Test with localStorage - create database, add a record, flush, reload
			const localStorageKeyPrefix = "localStorage:";
			const localStorageAdapter = makeLocalStorageAdapter(mockLocalStorage, {
				keyPrefix: localStorageKeyPrefix,
			});
			const localStorageLayer = Layer.merge(
				Layer.succeed(StorageAdapter, localStorageAdapter),
				serializerLayer,
			);

			// Phase 1: Create and flush with localStorage
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: initialBooks },
								{
									writeDebounce: 10,
								},
							),
							localStorageLayer,
						);

						yield* db.books.create({
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							genre: "sci-fi",
						});

						yield* Effect.promise(() => db.flush());

						const allBooks = yield* Stream.runCollect(db.books.query());
						expect(Chunk.toArray(allBooks)).toHaveLength(2);
					}),
				),
			);

			// Verify localStorage has the data
			expect(
				mockLocalStorage.getItem(`${localStorageKeyPrefix}data/books.json`),
			).toBeDefined();
			const localStorageData = JSON.parse(
				mockLocalStorage.getItem(`${localStorageKeyPrefix}data/books.json`) ??
					"",
			);
			expect(Object.keys(localStorageData)).toHaveLength(2);

			// Phase 2: Reload from localStorage to verify persistence
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							localStorageLayer,
						);

						const allBooks = yield* Stream.runCollect(db.books.query());
						const books = Chunk.toArray(allBooks) as Array<
							Record<string, unknown>
						>;
						expect(books).toHaveLength(2);

						// Should contain Dune (initial) and Neuromancer (created)
						const titles = books.map((b) => b.title);
						expect(titles).toContain("Dune");
						expect(titles).toContain("Neuromancer");
					}),
				),
			);

			// Test with IndexedDB - use unique database name to avoid cache conflicts
			const indexedDBKeyPrefix = "indexedDB:";
			const dbName = `testdb_switching_${testCounter}_${Date.now()}`;
			const indexedDBAdapter = makeIndexedDBAdapter({
				keyPrefix: indexedDBKeyPrefix,
				databaseName: dbName,
			});
			const indexedDBLayer = Layer.merge(
				Layer.succeed(StorageAdapter, indexedDBAdapter),
				serializerLayer,
			);

			// Phase 3: Create with IndexedDB with different additional book
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: initialBooks },
								{
									writeDebounce: 10,
								},
							),
							indexedDBLayer,
						);

						yield* db.books.create({
							title: "Snow Crash",
							author: "Neal Stephenson",
							year: 1992,
							genre: "sci-fi",
						});

						yield* Effect.promise(() => db.flush());

						const allBooks = yield* Stream.runCollect(db.books.query());
						const books = Chunk.toArray(allBooks) as Array<
							Record<string, unknown>
						>;
						expect(books).toHaveLength(2);

						// Should contain Dune (initial) and Snow Crash (created)
						const titles = books.map((b) => b.title);
						expect(titles).toContain("Dune");
						expect(titles).toContain("Snow Crash");
						// Should NOT contain Neuromancer (that's in localStorage only)
						expect(titles).not.toContain("Neuromancer");
					}),
				),
			);

			// Phase 4: Reload from IndexedDB to verify persistence
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								config,
								{ books: [] },
								{
									writeDebounce: 10,
								},
							),
							indexedDBLayer,
						);

						const allBooks = yield* Stream.runCollect(db.books.query());
						const books = Chunk.toArray(allBooks) as Array<
							Record<string, unknown>
						>;
						expect(books).toHaveLength(2);

						// Should still have Dune and Snow Crash (persisted)
						const titles = books.map((b) => b.title);
						expect(titles).toContain("Dune");
						expect(titles).toContain("Snow Crash");
					}),
				),
			);

			// Verify localStorage still has its separate data (localStorage wasn't affected by IndexedDB operations)
			const finalLocalStorageData = JSON.parse(
				mockLocalStorage.getItem(`${localStorageKeyPrefix}data/books.json`) ??
					"",
			);
			const localStorageTitles = Object.values(finalLocalStorageData).map(
				(b) => (b as Record<string, unknown>).title,
			);
			expect(localStorageTitles).toContain("Neuromancer");
			expect(localStorageTitles).not.toContain("Snow Crash");
		});
	});
});
