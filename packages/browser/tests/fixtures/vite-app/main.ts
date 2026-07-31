import {
	createIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createPersistentEngineDatabase,
} from "@proseql/browser";
import { Schema } from "effect";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
});

const config = {
	books: {
		schema: BookSchema,
		file: "./data/books.json",
		relationships: {},
	},
} as const;

type EngineDb = Awaited<ReturnType<typeof createPersistentEngineDatabase<typeof config>>>;
type WatchRows = ReadonlyArray<Record<string, unknown>>;

type WatchState = {
	db: EngineDb;
	subscription: ReturnType<EngineDb["books"]["watch"]>;
	emissions: Array<WatchRows>;
	closed: boolean;
};

const watchStates = new Map<string, WatchState>();
const writerDbs = new Map<string, EngineDb>();

const nextId = (() => {
	let value = 1;
	return () => `book-${value++}`;
})();

const toPlainBooks = (rows: ReadonlyArray<Record<string, unknown>>) =>
	rows.map((row) => ({ ...row }));

const waitFor = async (check: () => Promise<void>, timeoutMs = 5_000) => {
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

const clearLocalStoragePrefix = (prefix: string) => {
	const toDelete: string[] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key?.startsWith(prefix)) toDelete.push(key);
	}
	for (const key of toDelete) localStorage.removeItem(key);
};

const deleteIndexedDb = async (databaseName: string) =>
	new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error("failed to delete indexeddb database"));
		request.onblocked = () => reject(new Error("indexeddb delete blocked"));
	});

const withLocalDb = async (prefix: string) =>
	createPersistentEngineDatabase(config, { books: [] }, {
		writeDebounce: 5,
		storageHost: createLocalStorageEngineStorageHost({ keyPrefix: prefix }),
	});

const withIndexedDb = async (databaseName: string, prefix: string) =>
	createPersistentEngineDatabase(config, { books: [] }, {
		writeDebounce: 5,
		storageHost: createIndexedDBEngineStorageHost({ databaseName, keyPrefix: prefix }),
	});

const scopeKey = (kind: "local" | "indexeddb", prefix: string, databaseName?: string) =>
	kind === "local" ? `local:${prefix}` : `indexeddb:${databaseName ?? "default"}:${prefix}`;

const openDb = async (kind: "local" | "indexeddb", prefix: string, databaseName?: string) =>
	kind === "local" ? withLocalDb(prefix) : withIndexedDb(databaseName ?? "proseql", prefix);

const resetBackend = async (kind: "local" | "indexeddb", prefix: string, databaseName?: string) => {
	if (kind === "local") {
		clearLocalStoragePrefix(prefix);
		return;
	}
	await deleteIndexedDb(databaseName ?? "proseql").catch(() => undefined);
};

const startWatch = async (kind: "local" | "indexeddb", prefix: string, databaseName?: string) => {
	const key = scopeKey(kind, prefix, databaseName);
	if (watchStates.has(key)) return;
	const db = await openDb(kind, prefix, databaseName);
	const subscription = db.books.watch({ sort: { id: "asc" } });
	const state: WatchState = {
		db,
		subscription,
		emissions: [],
		closed: false,
	};
	watchStates.set(key, state);
	void (async () => {
		for await (const value of subscription) {
			state.emissions.push(toPlainBooks(value as Array<Record<string, unknown>>));
			if (state.closed) break;
		}
	})();
};

const waitForWatchRows = async (
	kind: "local" | "indexeddb",
	prefix: string,
	expectedIds: ReadonlyArray<string>,
	databaseName?: string,
	timeoutMs = 5_000,
) => {
	const key = scopeKey(kind, prefix, databaseName);
	await waitFor(async () => {
		const latest = watchStates
			.get(key)
			?.emissions.at(-1)
			?.map((row) => String(row.id))
			.sort();
		if (JSON.stringify(latest) !== JSON.stringify([...expectedIds].sort())) {
			throw new Error(`Expected ${expectedIds.join(",")} but saw ${JSON.stringify(latest)}`);
		}
	}, timeoutMs);
	return watchStates
		.get(key)
		?.emissions.map((rows) => rows.map((row) => ({ ...row }))) ?? [];
};

const ensureWriter = async (kind: "local" | "indexeddb", prefix: string, databaseName?: string) => {
	const key = scopeKey(kind, prefix, databaseName);
	const existing = writerDbs.get(key);
	if (existing) return existing;
	const db = await openDb(kind, prefix, databaseName);
	writerDbs.set(key, db);
	return db;
};

const createRecord = async (
	kind: "local" | "indexeddb",
	prefix: string,
	title: string,
	databaseName?: string,
) => {
	const db = await ensureWriter(kind, prefix, databaseName);
	const created = await db.books.create({
		id: nextId(),
		title,
		author: kind === "local" ? "Local Watcher" : "IndexedDB Watcher",
		year: 2000,
	});
	await db.flush();
	return { ...created };
};

const roundTrip = async (kind: "local" | "indexeddb", prefix: string, databaseName?: string) => {
	await resetBackend(kind, prefix, databaseName);
	const first = await openDb(kind, prefix, databaseName);
	await first.books.create({
		id: nextId(),
		title: kind === "local" ? "Dune" : "Neuromancer",
		author: kind === "local" ? "Frank Herbert" : "William Gibson",
		year: kind === "local" ? 1965 : 1984,
	});
	const queried = await first.books.query({ sort: { id: "asc" } });
	await first.flush();
	await first.close();
	const second = await openDb(kind, prefix, databaseName);
	const reloaded = await second.books.query({ sort: { id: "asc" } });
	await second.close();
	return {
		queried: toPlainBooks(queried as Array<Record<string, unknown>>),
		reloaded: toPlainBooks(reloaded as Array<Record<string, unknown>>),
	};
};

const runConcurrentRace = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) => {
	await resetBackend(kind, prefix, databaseName);
	const dbA = await openDb(kind, prefix, databaseName);
	const dbB = await openDb(kind, prefix, databaseName);
	const watchA = dbA.books.watch({ sort: { id: "asc" } });
	const watchB = dbB.books.watch({ sort: { id: "asc" } });
	const emissionsA: Array<WatchRows> = [];
	const emissionsB: Array<WatchRows> = [];
	void (async () => {
		for await (const rows of watchA) emissionsA.push(toPlainBooks(rows as Array<Record<string, unknown>>));
	})();
	void (async () => {
		for await (const rows of watchB) emissionsB.push(toPlainBooks(rows as Array<Record<string, unknown>>));
	})();
	await Promise.all([
		dbA.books.create({ id: "a", title: "Alpha", author: "A", year: 2001 }),
		dbB.books.create({ id: "b", title: "Beta", author: "B", year: 2002 }),
	]);
	await Promise.all([dbA.flush(), dbB.flush()]);
	await waitFor(async () => {
		const aRows = await dbA.books.query({ sort: { id: "asc" } });
		const bRows = await dbB.books.query({ sort: { id: "asc" } });
		if (aRows.length !== 2 || bRows.length !== 2) {
			throw new Error(`Expected converged rows, saw ${aRows.length}/${bRows.length}`);
		}
		const watchIdsA = emissionsA.at(-1)?.map((row) => String(row.id)).sort();
		const watchIdsB = emissionsB.at(-1)?.map((row) => String(row.id)).sort();
		if (
			JSON.stringify(watchIdsA) !== JSON.stringify(["a", "b"]) ||
			JSON.stringify(watchIdsB) !== JSON.stringify(["a", "b"])
		) {
			throw new Error(`Watchers did not converge: ${JSON.stringify(watchIdsA)} / ${JSON.stringify(watchIdsB)}`);
		}
	});
	const queriedA = await dbA.books.query({ sort: { id: "asc" } });
	const queriedB = await dbB.books.query({ sort: { id: "asc" } });
	await watchA.unsubscribe();
	await watchB.unsubscribe();
	await dbA.close();
	await dbB.close();
	const reopened = await openDb(kind, prefix, databaseName);
	const reloaded = await reopened.books.query({ sort: { id: "asc" } });
	await reopened.close();
	return {
		queriedA: toPlainBooks(queriedA as Array<Record<string, unknown>>),
		queriedB: toPlainBooks(queriedB as Array<Record<string, unknown>>),
		reloaded: toPlainBooks(reloaded as Array<Record<string, unknown>>),
		emissionsA: emissionsA.map((rows) => rows.map((row) => ({ ...row }))),
		emissionsB: emissionsB.map((rows) => rows.map((row) => ({ ...row }))),
	};
};

const harness = {
	localRoundTrip(prefix: string) {
		return roundTrip("local", prefix);
	},
	indexedDbRoundTrip(databaseName: string, prefix: string) {
		return roundTrip("indexeddb", prefix, databaseName);
	},
	openLocalWriter(prefix: string) {
		return ensureWriter("local", prefix);
	},
	createLocalRecord(prefix: string, title: string) {
		return createRecord("local", prefix, title);
	},
	startLocalWatch(prefix: string) {
		return startWatch("local", prefix);
	},
	waitForLocalWatchRows(prefix: string, expectedIds: ReadonlyArray<string>, timeoutMs = 5_000) {
		return waitForWatchRows("local", prefix, expectedIds, undefined, timeoutMs);
	},
	startIndexedDbWatch(databaseName: string, prefix: string) {
		return startWatch("indexeddb", prefix, databaseName);
	},
	createIndexedDbRecord(databaseName: string, prefix: string, title: string) {
		return createRecord("indexeddb", prefix, title, databaseName);
	},
	waitForIndexedDbWatchRows(
		databaseName: string,
		prefix: string,
		expectedIds: ReadonlyArray<string>,
		timeoutMs = 5_000,
	) {
		return waitForWatchRows("indexeddb", prefix, expectedIds, databaseName, timeoutMs);
	},
	localConcurrentRace(prefix: string) {
		return runConcurrentRace("local", prefix);
	},
	indexedDbConcurrentRace(databaseName: string, prefix: string) {
		return runConcurrentRace("indexeddb", prefix, databaseName);
	},
	async closeAll() {
		for (const state of watchStates.values()) {
			state.closed = true;
			await state.subscription.unsubscribe();
			await state.db.close();
		}
		watchStates.clear();
		for (const db of writerDbs.values()) {
			await db.close();
		}
		writerDbs.clear();
	},
};

declare global {
	interface Window {
		__PROSEQL_BROWSER_HARNESS__: typeof harness;
	}
}

window.__PROSEQL_BROWSER_HARNESS__ = harness;
