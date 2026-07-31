import { execFileSync } from "node:child_process";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createPersistentEngineDatabase,
} from "../src/browser.js";

const WORKTREE_ROOT = "/home/simonwjackson/code/github/simonwjackson/proseql/.worktrees/refactor-rust-engine-conversion";

class MockStorage implements Storage {
	private store = new Map<string, string>();

	get length(): number {
		return this.store.size;
	}

	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
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
}

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
	keyPath: string | string[] = "";
	indexNames: DOMStringList = {
		length: 0,
		contains: () => false,
		item: () => null,
		[Symbol.iterator]: function* () {},
	};
	autoIncrement = false;
	transaction!: IDBTransaction;

	constructor(private readonly store: Map<string, string>, name = "collections") {
		this.name = name;
	}

	get(key: IDBValidKey): IDBRequest<string | undefined> {
		const request = new MockIDBRequest<string | undefined>();
		queueMicrotask(() => {
			request.result = this.store.get(String(key));
			request.readyState = "done";
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	put(value: string, key?: IDBValidKey): IDBRequest<IDBValidKey> {
		const request = new MockIDBRequest<IDBValidKey>();
		queueMicrotask(() => {
			this.store.set(String(key), value);
			request.result = key as IDBValidKey;
			request.readyState = "done";
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	delete(key: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
		const request = new MockIDBRequest<undefined>();
		queueMicrotask(() => {
			this.store.delete(String(key));
			request.result = undefined;
			request.readyState = "done";
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	count(key?: IDBValidKey | IDBKeyRange): IDBRequest<number> {
		const request = new MockIDBRequest<number>();
		queueMicrotask(() => {
			request.result = this.store.has(String(key)) ? 1 : 0;
			request.readyState = "done";
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	getAllKeys(): IDBRequest<IDBValidKey[]> {
		const request = new MockIDBRequest<IDBValidKey[]>();
		queueMicrotask(() => {
			request.result = Array.from(this.store.keys());
			request.readyState = "done";
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	add(): IDBRequest<IDBValidKey> { throw new Error("Not implemented"); }
	clear(): IDBRequest<undefined> { throw new Error("Not implemented"); }
	getKey(): IDBRequest<IDBValidKey | undefined> { throw new Error("Not implemented"); }
	getAll(): IDBRequest<unknown[]> { throw new Error("Not implemented"); }
	createIndex(): IDBIndex { throw new Error("Not implemented"); }
	deleteIndex(): void { throw new Error("Not implemented"); }
	index(): IDBIndex { throw new Error("Not implemented"); }
	openCursor(): IDBRequest<IDBCursorWithValue | null> { throw new Error("Not implemented"); }
	openKeyCursor(): IDBRequest<IDBCursor | null> { throw new Error("Not implemented"); }
}

class MockIDBTransaction implements IDBTransaction {
	objectStoreNames: DOMStringList = {
		length: 1,
		contains: () => true,
		item: () => "collections",
		[Symbol.iterator]: function* () { yield "collections"; },
	};
	mode: IDBTransactionMode = "readwrite";
	durability: IDBTransactionDurability = "default";
	db!: IDBDatabase;
	error: DOMException | null = null;
	onabort: ((this: IDBTransaction, ev: Event) => void) | null = null;
	oncomplete: ((this: IDBTransaction, ev: Event) => void) | null = null;
	onerror: ((this: IDBTransaction, ev: Event) => void) | null = null;

	constructor(private readonly objectStoreImpl: MockIDBObjectStore) {
		objectStoreImpl.transaction = this;
	}

	objectStore(): IDBObjectStore {
		return this.objectStoreImpl;
	}
	abort(): void {}
	commit(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean { return true; }
}

class MockIDBDatabase implements IDBDatabase {
	version = 1;
	objectStoreNames: DOMStringList = {
		length: 1,
		contains: () => true,
		item: () => "collections",
		[Symbol.iterator]: function* () { yield "collections"; },
	};
	onabort: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onclose: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onerror: ((this: IDBDatabase, ev: Event) => void) | null = null;
	onversionchange: ((this: IDBDatabase, ev: Event) => void) | null = null;

	constructor(public name: string, private readonly store: Map<string, string>) {}

	transaction(): IDBTransaction {
		return new MockIDBTransaction(new MockIDBObjectStore(this.store));
	}
	createObjectStore(name: string): IDBObjectStore {
		return new MockIDBObjectStore(this.store, name);
	}
	deleteObjectStore(): void {}
	close(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean { return true; }
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
	onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => void) | null = null;
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean { return true; }
}

class MockIDBFactory implements IDBFactory {
	private readonly databases = new Map<string, MockIDBDatabase>();
	constructor(private readonly store: Map<string, string>) {}

	open(name: string): IDBOpenDBRequest {
		const request = new MockIDBOpenDBRequest();
		queueMicrotask(() => {
			let db = this.databases.get(name);
			const isNew = !db;
			if (!db) {
				db = new MockIDBDatabase(name, this.store);
				this.databases.set(name, db);
			}
			request.result = db;
			request.readyState = "done";
			if (isNew) request.onupgradeneeded?.call(request, new Event("upgradeneeded") as IDBVersionChangeEvent);
			request.onsuccess?.call(request, new Event("success"));
		});
		return request;
	}

	deleteDatabase(): IDBOpenDBRequest { throw new Error("Not implemented"); }
	cmp(): number { return 0; }
	databases(): Promise<IDBDatabaseInfo[]> { return Promise.resolve([]); }
}

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const TeamSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const config = {
	books: {
		schema: BookSchema,
		file: "./data/books.json",
		relationships: {},
	},
} as const;

const directoryConfig = {
	teams: {
		schema: TeamSchema,
		directory: "./data/teams",
		format: "json",
		relationships: {},
	},
} as const;

const sharedConfig = {
	users: {
		schema: UserSchema,
		file: "./data/shared.json",
		path: "nested.users",
		relationships: {},
	},
	teams: {
		schema: TeamSchema,
		file: "./data/shared.json",
		path: "nested.teams",
		relationships: {},
	},
} as const;

const waitFor = async (check: () => Promise<void>, timeoutMs = 2_000) => {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < timeoutMs) {
		try {
			await check();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const collectRows = (
	subscription: AsyncIterableIterator<ReadonlyArray<{ id: string; title: string }>> & { unsubscribe(): Promise<void> },
	emissions: Array<ReadonlyArray<{ id: string; title: string }>>,
) => {
	void (async () => {
		for await (const rows of subscription) {
			emissions.push(rows.map((row) => ({ ...row })));
		}
	})();
};

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 60_000);

describe("browser persistence concurrency", () => {
	it(
		"merges concurrent localStorage writers so both records survive and watchers converge",
		async () => {
			const storage = new MockStorage();
			const prefix = "race-local:";
			const dbA = await createPersistentEngineDatabase(config, { books: [] }, {
				writeDebounce: 5,
				storageHost: createLocalStorageEngineStorageHost({ storage, keyPrefix: prefix }),
			});
			const dbB = await createPersistentEngineDatabase(config, { books: [] }, {
				writeDebounce: 5,
				storageHost: createLocalStorageEngineStorageHost({ storage, keyPrefix: prefix }),
			});
			const subA = dbA.books.watch({ sort: { id: "asc" } });
			const subB = dbB.books.watch({ sort: { id: "asc" } });
			const emissionsA: Array<ReadonlyArray<{ id: string; title: string }>> = [];
			const emissionsB: Array<ReadonlyArray<{ id: string; title: string }>> = [];
			collectRows(subA as never, emissionsA);
			collectRows(subB as never, emissionsB);

			await Promise.all([
				dbA.books.create({ id: "a", title: "A" }),
				dbB.books.create({ id: "b", title: "B" }),
			]);
			await Promise.all([dbA.flush(), dbB.flush()]);
			await waitFor(async () => {
				expect(emissionsA.at(-1)?.map((row) => row.id).sort()).toEqual(["a", "b"]);
				expect(emissionsB.at(-1)?.map((row) => row.id).sort()).toEqual(["a", "b"]);
				expect(await dbA.books.query({ sort: { id: "asc" } })).toEqual([
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				]);
				expect(await dbB.books.query({ sort: { id: "asc" } })).toEqual([
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				]);
			});
			await subA.unsubscribe();
			await subB.unsubscribe();
			await dbA.close();
			await dbB.close();
		},
		15_000,
	);

	it("persists initialData additions and overrides on the first browser flush for empty and existing external files", async () => {
		const emptyStorage = new MockStorage();
		const emptyPrefix = "initial-empty:";
		const emptyHost = createLocalStorageEngineStorageHost({ storage: emptyStorage, keyPrefix: emptyPrefix });
		const seeded = await createPersistentEngineDatabase(
			config,
			{
				books: [
					{ id: "seed", title: "Seeded" },
					{ id: "extra", title: "Extra" },
				],
			},
			{ writeDebounce: 5, storageHost: emptyHost },
		);
		await seeded.flush();
		await seeded.close();
		const reopenedSeeded = await createPersistentEngineDatabase(config, undefined, {
			writeDebounce: 5,
			storageHost: createLocalStorageEngineStorageHost({ storage: emptyStorage, keyPrefix: emptyPrefix }),
		});
		expect(await reopenedSeeded.books.query({ sort: { id: "asc" } })).toEqual([
			{ id: "extra", title: "Extra" },
			{ id: "seed", title: "Seeded" },
		]);
		await reopenedSeeded.close();

		const existingStorage = new MockStorage();
		const existingPrefix = "initial-existing:";
		existingStorage.setItem(
			`${existingPrefix}data/books.json`,
			JSON.stringify({
				keep: { id: "keep", title: "Keep" },
				override: { id: "override", title: "Disk" },
			}),
		);
		const merged = await createPersistentEngineDatabase(
			config,
			{
				books: [
					{ id: "override", title: "Seed Override" },
					{ id: "added", title: "Added" },
				],
			},
			{
				writeDebounce: 5,
				storageHost: createLocalStorageEngineStorageHost({ storage: existingStorage, keyPrefix: existingPrefix }),
			},
		);
		await merged.flush();
		await merged.close();
		const reopenedMerged = await createPersistentEngineDatabase(config, undefined, {
			writeDebounce: 5,
			storageHost: createLocalStorageEngineStorageHost({ storage: existingStorage, keyPrefix: existingPrefix }),
		});
		expect(await reopenedMerged.books.query({ sort: { id: "asc" } })).toEqual([
			{ id: "added", title: "Added" },
			{ id: "keep", title: "Keep" },
			{ id: "override", title: "Seed Override" },
		]);
		await reopenedMerged.close();
	});

	it("does not resurrect file or directory rows after a successful browser save clears the local dirty baseline", async () => {
		const fileStorage = new MockStorage();
		const filePrefix = "dirty-file:";
		const fileHostA = createLocalStorageEngineStorageHost({ storage: fileStorage, keyPrefix: filePrefix });
		const fileHostB = createLocalStorageEngineStorageHost({ storage: fileStorage, keyPrefix: filePrefix });
		const fileDbA = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 5, storageHost: fileHostA });
		const fileDbB = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 5, storageHost: fileHostB });
		await fileDbA.books.create({ id: "a", title: "A" });
		await fileDbA.flush();
		await waitFor(async () => {
			expect(await fileDbB.books.query({ sort: { id: "asc" } })).toEqual([{ id: "a", title: "A" }]);
		});
		await fileDbB.books.delete("a");
		await fileDbB.flush();
		await waitFor(async () => {
			expect(await fileDbA.books.query({ sort: { id: "asc" } })).toEqual([]);
		});
		await fileDbA.close();
		await fileDbB.close();

		const directoryStorage = new MockStorage();
		const directoryPrefix = "dirty-directory:";
		const directoryDbA = await createPersistentEngineDatabase(
			directoryConfig,
			{ teams: [] },
			{
				writeDebounce: 5,
				storageHost: createLocalStorageEngineStorageHost({ storage: directoryStorage, keyPrefix: directoryPrefix }),
			},
		);
		const directoryDbB = await createPersistentEngineDatabase(
			directoryConfig,
			{ teams: [] },
			{
				writeDebounce: 5,
				storageHost: createLocalStorageEngineStorageHost({ storage: directoryStorage, keyPrefix: directoryPrefix }),
			},
		);
		await directoryDbA.teams.create({ id: "t1", name: "One" });
		await directoryDbA.flush();
		await waitFor(async () => {
			expect(await directoryDbB.teams.query({ sort: { id: "asc" } })).toEqual([{ id: "t1", name: "One" }]);
		});
		await directoryDbB.teams.delete("t1");
		await directoryDbB.flush();
		await waitFor(async () => {
			expect(await directoryDbA.teams.query({ sort: { id: "asc" } })).toEqual([]);
		});
		await directoryDbA.close();
		await directoryDbB.close();
	});

	it(
		"merges concurrent IndexedDB writers so both records survive and watchers converge",
		async () => {
			const factory = new MockIDBFactory(new Map<string, string>());
			const prefix = "race-idb:";
			const databaseName = "race-idb-db";
			const dbA = await createPersistentEngineDatabase(config, { books: [] }, {
				writeDebounce: 5,
				storageHost: createIndexedDBEngineStorageHost({ indexedDB: factory, keyPrefix: prefix, databaseName }),
			});
			const dbB = await createPersistentEngineDatabase(config, { books: [] }, {
				writeDebounce: 5,
				storageHost: createIndexedDBEngineStorageHost({ indexedDB: factory, keyPrefix: prefix, databaseName }),
			});
			const subA = dbA.books.watch({ sort: { id: "asc" } });
			const subB = dbB.books.watch({ sort: { id: "asc" } });
			const emissionsA: Array<ReadonlyArray<{ id: string; title: string }>> = [];
			const emissionsB: Array<ReadonlyArray<{ id: string; title: string }>> = [];
			collectRows(subA as never, emissionsA);
			collectRows(subB as never, emissionsB);

			await Promise.all([
				dbA.books.create({ id: "a", title: "A" }),
				dbB.books.create({ id: "b", title: "B" }),
			]);
			await Promise.all([dbA.flush(), dbB.flush()]);
			await waitFor(async () => {
				expect(emissionsA.at(-1)?.map((row) => row.id).sort()).toEqual(["a", "b"]);
				expect(emissionsB.at(-1)?.map((row) => row.id).sort()).toEqual(["a", "b"]);
				expect(await dbA.books.query({ sort: { id: "asc" } })).toEqual([
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				]);
				expect(await dbB.books.query({ sort: { id: "asc" } })).toEqual([
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				]);
			});
			await subA.unsubscribe();
			await subB.unsubscribe();
			await dbA.close();
			await dbB.close();
		},
		15_000,
	);
});
