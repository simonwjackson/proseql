import {
	createIndexedDBEngineStorageHost,
	createLocalStorageEngineStorageHost,
	createPersistentEngineDatabase,
} from "@proseql/browser";
import { createEffectDatabase } from "@proseql/effect/browser";
import { Effect, Schema } from "effect";
import {
	BROWSER_WORKLOAD_BASELINE_COUNT,
	BROWSER_WORKLOAD_EXPECTATIONS,
	BROWSER_WORKLOAD_NAMES,
	type BrowserPerformanceWorkloadState,
	type BrowserWorkloadName,
} from "../../../../../bench/workloads.js";
import initBrowserWasm from "../../../../engine/dist/browser-wasm/proseql_wasm.js";

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

type EngineDb = Awaited<
	ReturnType<typeof createPersistentEngineDatabase<typeof config>>
>;
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
		request.onerror = () =>
			reject(request.error ?? new Error("failed to delete indexeddb database"));
		request.onblocked = () => reject(new Error("indexeddb delete blocked"));
	});

const withLocalDb = async (prefix: string) =>
	createPersistentEngineDatabase(
		config,
		{ books: [] },
		{
			writeDebounce: 5,
			storageHost: createLocalStorageEngineStorageHost({ keyPrefix: prefix }),
		},
	);

const withIndexedDb = async (databaseName: string, prefix: string) =>
	createPersistentEngineDatabase(
		config,
		{ books: [] },
		{
			writeDebounce: 5,
			storageHost: createIndexedDBEngineStorageHost({
				databaseName,
				keyPrefix: prefix,
			}),
		},
	);

const scopeKey = (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) =>
	kind === "local"
		? `local:${prefix}`
		: `indexeddb:${databaseName ?? "default"}:${prefix}`;

const openDb = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) =>
	kind === "local"
		? withLocalDb(prefix)
		: withIndexedDb(databaseName ?? "proseql", prefix);

const resetBackend = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) => {
	if (kind === "local") {
		clearLocalStoragePrefix(prefix);
		return;
	}
	await deleteIndexedDb(databaseName ?? "proseql").catch(() => undefined);
};

const startWatch = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) => {
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
			state.emissions.push(
				toPlainBooks(value as Array<Record<string, unknown>>),
			);
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
			throw new Error(
				`Expected ${expectedIds.join(",")} but saw ${JSON.stringify(latest)}`,
			);
		}
	}, timeoutMs);
	return (
		watchStates
			.get(key)
			?.emissions.map((rows) => rows.map((row) => ({ ...row }))) ?? []
	);
};

const ensureWriter = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) => {
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

const roundTrip = async (
	kind: "local" | "indexeddb",
	prefix: string,
	databaseName?: string,
) => {
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
		for await (const rows of watchA)
			emissionsA.push(toPlainBooks(rows as Array<Record<string, unknown>>));
	})();
	void (async () => {
		for await (const rows of watchB)
			emissionsB.push(toPlainBooks(rows as Array<Record<string, unknown>>));
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
			throw new Error(
				`Expected converged rows, saw ${aRows.length}/${bRows.length}`,
			);
		}
		const watchIdsA = emissionsA
			.at(-1)
			?.map((row) => String(row.id))
			.sort();
		const watchIdsB = emissionsB
			.at(-1)
			?.map((row) => String(row.id))
			.sort();
		if (
			JSON.stringify(watchIdsA) !== JSON.stringify(["a", "b"]) ||
			JSON.stringify(watchIdsB) !== JSON.stringify(["a", "b"])
		) {
			throw new Error(
				`Watchers did not converge: ${JSON.stringify(watchIdsA)} / ${JSON.stringify(watchIdsB)}`,
			);
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
	waitForLocalWatchRows(
		prefix: string,
		expectedIds: ReadonlyArray<string>,
		timeoutMs = 5_000,
	) {
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
		return waitForWatchRows(
			"indexeddb",
			prefix,
			expectedIds,
			databaseName,
			timeoutMs,
		);
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

const PerfUserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	role: Schema.Union([
		Schema.Literal("admin"),
		Schema.Literal("moderator"),
		Schema.Literal("user"),
	]),
	createdAt: Schema.String,
});

const perfConfig = {
	users: {
		schema: PerfUserSchema,
		relationships: {},
	},
} as const;

const buildPerfUsers = () =>
	Array.from({ length: 10_000 }, (_, index) => ({
		id: `perf-user-${String(index + 1).padStart(5, "0")}`,
		name: `User ${index + 1}`,
		email: `user${index + 1}@example.com`,
		age: 18 + (index % 70),
		role: index % 10 === 0 ? "admin" : index % 5 === 0 ? "moderator" : "user",
		createdAt: new Date(Date.UTC(2024, 0, 1 + (index % 365))).toISOString(),
	}));

type PerfUser = {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly age: number;
	readonly role: "admin" | "moderator" | "user";
	readonly createdAt: string;
};

type PerfDb = {
	readonly users: {
		readonly findById: (id: string) => {
			readonly runPromise: Promise<PerfUser | undefined>;
		};
		readonly exists: (id: string) => { readonly runPromise: Promise<boolean> };
		readonly query: (query?: Record<string, unknown>) => {
			readonly runPromise: Promise<ReadonlyArray<PerfUser>>;
		};
		readonly create: (user: PerfUser) => {
			readonly runPromise: Promise<PerfUser>;
		};
		readonly update: (
			id: string,
			updates: Record<string, unknown>,
		) => { readonly runPromise: Promise<PerfUser> };
		readonly updateMany: (
			selector: ((user: PerfUser) => boolean) | Record<string, unknown>,
			updates: Record<string, unknown>,
		) => { readonly runPromise: Promise<unknown> };
		readonly delete: (id: string) => { readonly runPromise: Promise<PerfUser> };
		readonly deleteMany: (
			selector: ((user: PerfUser) => boolean) | Record<string, unknown>,
			options?: Record<string, unknown>,
		) => { readonly runPromise: Promise<unknown> };
	};
	readonly $transaction: <A>(
		fn: (ctx: {
			readonly users: {
				readonly create: (user: PerfUser) => Effect.Effect<PerfUser>;
				readonly update: (
					id: string,
					updates: Record<string, unknown>,
				) => Effect.Effect<PerfUser>;
				readonly delete: (id: string) => Effect.Effect<PerfUser>;
			};
		}) => Effect.Effect<A>,
	) => Effect.Effect<A>;
	readonly close?: () => Promise<void>;
};

const PERF_BULK_COHORT_SIZE = 100;
const PERF_BULK_DECLARATIVE_EMAIL = "browser-bulk-declarative@example.com";
const PERF_BULK_PREDICATE_EMAIL = "browser-bulk-predicate@example.com";
const PERF_BULK_DECLARATIVE_NAME = "Browser Declarative Fixture";
const PERF_BULK_PREDICATE_NAME = "Browser Predicate Fixture";
const PERF_BULK_DECLARATIVE_UPDATED_NAME = "Browser Declarative Updated";
const PERF_BULK_PREDICATE_UPDATED_NAME = "Browser Predicate Updated";

let perfUsers = buildPerfUsers().map((user, index, users) => {
	if (index >= users.length - PERF_BULK_COHORT_SIZE) {
		return {
			...user,
			name: PERF_BULK_DECLARATIVE_NAME,
			email: PERF_BULK_DECLARATIVE_EMAIL,
			age: 30,
			role: "user" as const,
			createdAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
		};
	}
	if (index >= users.length - PERF_BULK_COHORT_SIZE * 2) {
		return {
			...user,
			name: PERF_BULK_PREDICATE_NAME,
			email: PERF_BULK_PREDICATE_EMAIL,
			age: 31,
			role: "user" as const,
			createdAt: new Date(Date.UTC(2024, 0, 2)).toISOString(),
		};
	}
	return user;
});
const perfFindTarget = perfUsers[5_000];
if (!perfFindTarget) throw new Error("Missing fixed 10K browser find target");
const perfTargetId = perfFindTarget.id;
const perfUpdateTarget = perfUsers[0]!;
const perfDeleteTarget = perfUsers[1_234] ?? perfUsers[0]!;
let perfDeleteTargetState = perfDeleteTarget;
let perfCreateCounter = 0;
let perfTransactionCounter = 0;
let browserWasmInitPromise: Promise<void> | undefined;
let perfDbState:
	| Promise<{ readonly db: PerfDb; readonly baselineCount: number }>
	| undefined;

const assertPerf = (condition: unknown, message: string): asserts condition => {
	if (!condition) {
		throw new Error(message);
	}
};

const assertPerfEqual = <T>(actual: T, expected: T, message: string) => {
	if (!Object.is(actual, expected)) {
		throw new Error(
			`${message}: expected ${String(expected)}, received ${String(actual)}`,
		);
	}
};

const samePerfUser = (left: PerfUser, right: PerfUser) =>
	left.id === right.id &&
	left.name === right.name &&
	left.email === right.email &&
	left.age === right.age &&
	left.role === right.role &&
	left.createdAt === right.createdAt;

const assertPerfUserMatches = (
	actual: PerfUser | undefined,
	expected: PerfUser,
	message: string,
) => {
	assertPerf(
		actual !== undefined,
		`${message}: expected ${expected.id} to exist`,
	);
	assertPerf(
		samePerfUser(actual, expected),
		`${message}: expected ${expected.id} to match the fixture (${JSON.stringify(actual)} !== ${JSON.stringify(expected)})`,
	);
};

const assertPerfRowsMatch = (
	rows: ReadonlyArray<PerfUser>,
	expectedRows: ReadonlyArray<PerfUser>,
	message: string,
) => {
	const byId = new Map(rows.map((row) => [row.id, row] as const));
	assertPerfEqual(rows.length, expectedRows.length, `${message} count`);
	for (const expected of expectedRows) {
		const actual = byId.get(expected.id);
		assertPerfUserMatches(actual, expected, `${message} row ${expected.id}`);
	}
};

const declarativePerfUsers = perfUsers.filter(
	(user) => user.email === PERF_BULK_DECLARATIVE_EMAIL,
);
const predicatePerfUsers = perfUsers.filter(
	(user) => user.email === PERF_BULK_PREDICATE_EMAIL,
);
const withPerfUserName = (
	users: ReadonlyArray<PerfUser>,
	name: string,
): ReadonlyArray<PerfUser> => users.map((user) => ({ ...user, name }));

const ensureBrowserWasmLoaded = () => {
	browserWasmInitPromise ??= initBrowserWasm(
		new URL(
			"../../../../engine/dist/browser-wasm/proseql_wasm_bg.wasm",
			import.meta.url,
		),
	).then((wasmExports) => {
		window.__PROSEQL_WASM_MEMORY__ = wasmExports.memory;
	});
	return browserWasmInitPromise;
};

const createPerfDb = async (): Promise<PerfDb> => {
	await ensureBrowserWasmLoaded();
	const initialUsers = perfUsers;
	try {
		return await Effect.runPromise(
			createEffectDatabase(perfConfig, {
				users: initialUsers,
			}),
		);
	} finally {
		// The materialized projection owns the canonical host rows after bootstrap.
		// Do not retain the 10K source fixture as a second full-row collection.
		perfUsers = [];
	}
};

const getPerfDbState = () => {
	perfDbState ??= (async () => {
		const db = await createPerfDb();
		const baselineCount = (await db.users.query().runPromise).length;
		assertPerfEqual(
			baselineCount,
			BROWSER_WORKLOAD_BASELINE_COUNT,
			"browser workload baseline count",
		);
		return { db, baselineCount };
	})();
	return perfDbState;
};

const closePerfDb = async (db: PerfDb) => {
	await db.close?.();
};

const closeAllPerfDbs = async () => {
	const statePromise = perfDbState;
	perfDbState = undefined;
	perfDeleteTargetState = perfDeleteTarget;
	const state = await statePromise?.catch(() => undefined);
	if (state) {
		await closePerfDb(state.db);
	}
};

const findPerfUser = async (db: PerfDb, id: string) => {
	try {
		return await db.users.findById(id).runPromise;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "NotFoundError"
		) {
			return undefined;
		}
		throw error;
	}
};
const queryPerfUsersByEmail = (db: PerfDb, email: string) =>
	db.users.query({ where: { email } }).runPromise;

const measurePerf = async <T>(run: () => Promise<T>) => {
	const startedAt = performance.now();
	const value = await run();
	return {
		value,
		durationMs: performance.now() - startedAt,
	};
};

const setPerfState = (state: BrowserPerformanceWorkloadState) => {
	window.__PROSEQL_BROWSER_PERF_STATE__ = state;
};

const verifyPerfWorkloadCleanup = async (
	workload: BrowserWorkloadName,
): Promise<number> => {
	const expectation = BROWSER_WORKLOAD_EXPECTATIONS[workload];
	const { db, baselineCount } = await getPerfDbState();
	assertPerfEqual(
		baselineCount,
		expectation.baselineCount,
		`${workload} cached baseline count`,
	);
	const cleanupCount = (await db.users.query().runPromise).length;
	assertPerfEqual(
		cleanupCount,
		expectation.cleanupCount,
		`${workload} cleanup count`,
	);
	return cleanupCount;
};

const runPerfWorkload = async (
	workload: BrowserWorkloadName,
	run: (db: PerfDb) => Promise<{
		readonly durationMs: number;
		readonly resultCount: number;
		readonly targetExistsAfterCleanup?: boolean;
	}>,
) => {
	const expectation = BROWSER_WORKLOAD_EXPECTATIONS[workload];
	const { db, baselineCount } = await getPerfDbState();
	assertPerfEqual(
		baselineCount,
		expectation.baselineCount,
		`${workload} cached baseline count`,
	);
	const { durationMs, resultCount, targetExistsAfterCleanup } = await run(db);
	assertPerfEqual(
		resultCount,
		expectation.resultCount,
		`${workload} result count`,
	);
	// Each workload performs targeted full-value restoration checks per sample.
	// The one full 10K-row cardinality scan runs only after the 30-sample batch,
	// before the next workload begins its discarded warmup.
	if (expectation.targetExistsAfterCleanup !== undefined) {
		assertPerfEqual(
			targetExistsAfterCleanup,
			expectation.targetExistsAfterCleanup,
			`${workload} targetExistsAfterCleanup`,
		);
	}
	setPerfState({
		workload,
		baselineCount,
		resultCount,
		restorationVerified: true,
		...(targetExistsAfterCleanup === undefined
			? {}
			: { targetExistsAfterCleanup }),
	});
	return durationMs;
};

const browserPerfHarness = {
	async [BROWSER_WORKLOAD_NAMES.findById10K]() {
		return runPerfWorkload(BROWSER_WORKLOAD_NAMES.findById10K, async (db) => {
			const { value, durationMs } = await measurePerf(() =>
				findPerfUser(db, perfTargetId),
			);
			assertPerfUserMatches(value, perfFindTarget, "findById verification");
			return {
				durationMs,
				resultCount: value ? 1 : 0,
				targetExistsAfterCleanup: value !== undefined,
			};
		});
	},
	async [BROWSER_WORKLOAD_NAMES.paginateLimit100Offset500]() {
		return runPerfWorkload(
			BROWSER_WORKLOAD_NAMES.paginateLimit100Offset500,
			async (db) => {
				const { value, durationMs } = await measurePerf(
					() => db.users.query({ offset: 500, limit: 100 }).runPromise,
				);
				assertPerfEqual(value.length, 100, "pagination verification count");
				return { durationMs, resultCount: value.length };
			},
		);
	},
	async [BROWSER_WORKLOAD_NAMES.createSingle]() {
		return runPerfWorkload(BROWSER_WORKLOAD_NAMES.createSingle, async (db) => {
			const id = `perf-create-${perfCreateCounter++}`;
			const createdUser: PerfUser = {
				id,
				name: "Browser Create",
				email: `${id}@example.com`,
				age: 27,
				role: "user",
				createdAt: new Date(Date.UTC(2024, 0, 3)).toISOString(),
			};
			const { value, durationMs } = await measurePerf(
				() => db.users.create(createdUser).runPromise,
			);
			assertPerf(
				value.id === createdUser.id,
				"create verification: created id mismatch",
			);
			const persisted = await findPerfUser(db, id);
			assertPerf(
				persisted?.id === createdUser.id &&
					persisted.name === createdUser.name &&
					persisted.email === createdUser.email &&
					persisted.age === createdUser.age &&
					persisted.role === createdUser.role,
				"create persisted verification: created record fields were not observable",
			);
			await db.users.deleteMany({ id }).runPromise;
			assertPerf(
				(await findPerfUser(db, id)) === undefined,
				"create cleanup verification: created record should be removed",
			);
			return {
				durationMs,
				resultCount: 1,
				targetExistsAfterCleanup: false,
			};
		});
	},
	async [BROWSER_WORKLOAD_NAMES.updateSingle]() {
		return runPerfWorkload(BROWSER_WORKLOAD_NAMES.updateSingle, async (db) => {
			assertPerfUserMatches(
				await findPerfUser(db, perfUpdateTarget.id),
				perfUpdateTarget,
				"update precondition",
			);
			const { value, durationMs } = await measurePerf(
				() =>
					db.users.update(perfUpdateTarget.id, {
						name: "Updated Browser User",
						age: 29,
					}).runPromise,
			);
			assertPerf(
				value.name === "Updated Browser User" && value.age === 29,
				"update verification: updated record did not change",
			);
			assertPerf(
				(await findPerfUser(db, perfUpdateTarget.id))?.name ===
					"Updated Browser User",
				"update verification: updated value was not observable",
			);
			await db.users.update(perfUpdateTarget.id, {
				name: perfUpdateTarget.name,
				age: perfUpdateTarget.age,
			}).runPromise;
			assertPerfUserMatches(
				await findPerfUser(db, perfUpdateTarget.id),
				perfUpdateTarget,
				"update cleanup verification",
			);
			return {
				durationMs,
				resultCount: 1,
				targetExistsAfterCleanup: true,
			};
		});
	},
	async [BROWSER_WORKLOAD_NAMES.deleteSingle]() {
		return runPerfWorkload(BROWSER_WORKLOAD_NAMES.deleteSingle, async (db) => {
			const deleteTarget = perfDeleteTargetState;
			assertPerfUserMatches(
				await findPerfUser(db, deleteTarget.id),
				deleteTarget,
				"delete precondition",
			);
			const { value, durationMs } = await measurePerf(
				() => db.users.delete(deleteTarget.id).runPromise,
			);
			assertPerfUserMatches(value, deleteTarget, "delete verification");
			assertPerf(
				(await findPerfUser(db, deleteTarget.id)) === undefined,
				"delete verification: target should be absent after delete",
			);
			const restoredTarget = await db.users.create(deleteTarget).runPromise;
			perfDeleteTargetState = restoredTarget;
			assertPerfUserMatches(
				await findPerfUser(db, deleteTarget.id),
				restoredTarget,
				"delete cleanup verification",
			);
			return {
				durationMs,
				resultCount: 1,
				targetExistsAfterCleanup: true,
			};
		});
	},
	async [BROWSER_WORKLOAD_NAMES.updateManyDeclarative]() {
		return runPerfWorkload(
			BROWSER_WORKLOAD_NAMES.updateManyDeclarative,
			async (db) => {
				assertPerfRowsMatch(
					await queryPerfUsersByEmail(db, PERF_BULK_DECLARATIVE_EMAIL),
					declarativePerfUsers,
					"declarative bulk precondition",
				);
				const { durationMs } = await measurePerf(async () => {
					await db.users.updateMany(
						{ email: PERF_BULK_DECLARATIVE_EMAIL },
						{ name: PERF_BULK_DECLARATIVE_UPDATED_NAME },
					).runPromise;
				});
				const updatedRows = await queryPerfUsersByEmail(
					db,
					PERF_BULK_DECLARATIVE_EMAIL,
				);
				assertPerfRowsMatch(
					updatedRows,
					withPerfUserName(
						declarativePerfUsers,
						PERF_BULK_DECLARATIVE_UPDATED_NAME,
					),
					"declarative bulk verification",
				);
				await db.users.updateMany(
					{ email: PERF_BULK_DECLARATIVE_EMAIL },
					{ name: PERF_BULK_DECLARATIVE_NAME },
				).runPromise;
				assertPerfRowsMatch(
					await queryPerfUsersByEmail(db, PERF_BULK_DECLARATIVE_EMAIL),
					declarativePerfUsers,
					"declarative bulk cleanup verification",
				);
				return {
					durationMs,
					resultCount: updatedRows.length,
					targetExistsAfterCleanup: true,
				};
			},
		);
	},
	async [BROWSER_WORKLOAD_NAMES.updateManyPredicate]() {
		return runPerfWorkload(
			BROWSER_WORKLOAD_NAMES.updateManyPredicate,
			async (db) => {
				assertPerfRowsMatch(
					await queryPerfUsersByEmail(db, PERF_BULK_PREDICATE_EMAIL),
					predicatePerfUsers,
					"predicate bulk precondition",
				);
				const { durationMs } = await measurePerf(async () => {
					await db.users.updateMany(
						(user) => user.email === PERF_BULK_PREDICATE_EMAIL,
						{ name: PERF_BULK_PREDICATE_UPDATED_NAME },
					).runPromise;
				});
				const updatedRows = await queryPerfUsersByEmail(
					db,
					PERF_BULK_PREDICATE_EMAIL,
				);
				assertPerfRowsMatch(
					updatedRows,
					withPerfUserName(
						predicatePerfUsers,
						PERF_BULK_PREDICATE_UPDATED_NAME,
					),
					"predicate bulk verification",
				);
				await db.users.updateMany(
					(user) => user.email === PERF_BULK_PREDICATE_EMAIL,
					{ name: PERF_BULK_PREDICATE_NAME },
				).runPromise;
				assertPerfRowsMatch(
					await queryPerfUsersByEmail(db, PERF_BULK_PREDICATE_EMAIL),
					predicatePerfUsers,
					"predicate bulk cleanup verification",
				);
				return {
					durationMs,
					resultCount: updatedRows.length,
					targetExistsAfterCleanup: true,
				};
			},
		);
	},
	async [BROWSER_WORKLOAD_NAMES.transactionalCreateUpdateDelete]() {
		return runPerfWorkload(
			BROWSER_WORKLOAD_NAMES.transactionalCreateUpdateDelete,
			async (db) => {
				const id = `perf-transaction-${perfTransactionCounter++}`;
				const { durationMs } = await measurePerf(async () => {
					await Effect.runPromise(
						db.$transaction((ctx) =>
							Effect.gen(function* () {
								const created = yield* ctx.users.create({
									id,
									name: "Browser Transaction",
									email: `${id}@example.com`,
									age: 26,
									role: "user",
									createdAt: new Date(Date.UTC(2024, 0, 4)).toISOString(),
								});
								yield* ctx.users.update(created.id, {
									name: "Browser Transaction Updated",
								});
								yield* ctx.users.delete(created.id);
							}),
						),
					);
				});
				assertPerf(
					(await findPerfUser(db, id)) === undefined,
					"transaction cleanup verification: transactional record should be absent",
				);
				return {
					durationMs,
					resultCount: 1,
					targetExistsAfterCleanup: false,
				};
			},
		);
	},
};

window.__PROSEQL_BROWSER_PERF_CLOSE_ALL__ = closeAllPerfDbs;
window.__PROSEQL_BROWSER_PERF_VERIFY_CLEANUP__ = verifyPerfWorkloadCleanup;
window.addEventListener(
	"pagehide",
	() => {
		void closeAllPerfDbs().catch(() => undefined);
	},
	{ once: true },
);

void ensureBrowserWasmLoaded().then(() => {
	window.__PROSEQL_BROWSER_PERF_READY__ = true;
	window.__PROSEQL_BROWSER_PERF__ = browserPerfHarness;
});

declare global {
	interface Window {
		__PROSEQL_BROWSER_HARNESS__: typeof harness;
		__PROSEQL_BROWSER_PERF__: typeof browserPerfHarness;
		__PROSEQL_BROWSER_PERF_CLOSE_ALL__?: () => Promise<void>;
		__PROSEQL_BROWSER_PERF_VERIFY_CLEANUP__?: (
			name: BrowserWorkloadName,
		) => Promise<number>;
		__PROSEQL_BROWSER_PERF_READY__?: boolean;
		__PROSEQL_BROWSER_PERF_STATE__?: BrowserPerformanceWorkloadState;
		__PROSEQL_WASM_MEMORY__?: WebAssembly.Memory;
	}
}

window.__PROSEQL_BROWSER_HARNESS__ = harness;
