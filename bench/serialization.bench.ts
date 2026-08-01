import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { Bench } from "tinybench";
import {
	type CollectionConfig,
	createPersistentEffectDatabase as createCorePersistentEffectDatabase,
	jsonCodec,
	makeSerializerLayer,
	type ProseQLPlugin,
	StorageAdapterService,
	type StorageAdapterShape,
} from "../packages/core/src/index.js";
import { createPersistentEffectDatabase as createWasmPersistentEffectDatabase } from "../packages/effect/src/index.js";
import {
	attachTaskMetadata,
	type BenchmarkCaseType,
	type BenchmarkCategory,
	checksumBenchmarkValue,
	createEngineTaskName,
} from "./comparison.js";
import { generateUsers, type User } from "./generators.js";
import {
	buildBenchOptions,
	closeAll,
	createTaskInstrumentation,
	formatResultsTable,
	measureAsync,
	withFrozenDate,
} from "./utils.js";

const BASELINE_SIZE = 10_000;
const MUTATION_BATCH_SIZE = 100;
const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";
const CHECKSUM_CLOCK_ISO = "2026-01-02T03:04:05.000Z";
const USERS_FILE = "./data/users.json";

const UserSchema = Schema.Struct({
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

const basicConfig = {
	users: {
		schema: UserSchema,
		file: USERS_FILE,
		relationships: {},
	},
} as const satisfies Record<string, CollectionConfig>;

const computedConfig = {
	users: {
		schema: UserSchema,
		file: USERS_FILE,
		relationships: {},
		computed: {
			displayName: (user: User) => `${user.name}:${user.role}`,
		},
	},
} as const satisfies Record<string, CollectionConfig>;

const localeCollatorConfig = {
	users: {
		schema: UserSchema,
		file: USERS_FILE,
		relationships: {},
	},
} as const satisfies Record<string, CollectionConfig>;

const createHooksConfig = (events: Array<string>) =>
	({
		users: {
			schema: UserSchema,
			file: USERS_FILE,
			relationships: {},
			hooks: {
				beforeCreate: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`beforeCreate:${ctx.data.id}`);
							return {
								...ctx.data,
								email: ctx.data.email.toLowerCase(),
							};
						}),
				],
				afterCreate: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`afterCreate:${ctx.entity.id}`);
							return undefined;
						}),
				],
				beforeUpdate: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`beforeUpdate:${ctx.id}`);
							return ctx.update;
						}),
				],
				afterUpdate: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`afterUpdate:${ctx.id}`);
							return undefined;
						}),
				],
				beforeDelete: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`beforeDelete:${ctx.id}`);
							return undefined;
						}),
				],
				afterDelete: [
					(ctx) =>
						Effect.sync(() => {
							events.push(`afterDelete:${ctx.id}`);
							return undefined;
						}),
				],
			},
		},
	}) as const satisfies Record<string, CollectionConfig>;

const prefixPlugin = {
	name: "serialization-prefix-plugin",
	operators: [
		{
			name: "$prefix",
			types: ["string"] as const,
			evaluate: (fieldValue: unknown, operand: unknown) =>
				typeof fieldValue === "string" &&
				typeof operand === "string" &&
				fieldValue.startsWith(operand),
		},
	],
} as const satisfies ProseQLPlugin;

interface CountingStorage {
	readonly layer: Layer.Layer<typeof StorageAdapterService>;
	readonly store: Map<string, string>;
	readonly writeCount: { value: number };
	resetWrites(): void;
}

const createCountingStorage = (): CountingStorage => {
	const store = new Map<string, string>();
	const writeCount = { value: 0 };
	const adapter: StorageAdapterShape = {
		read: (path: string) => Effect.sync(() => store.get(path) ?? "{}"),
		write: (path: string, data: string) =>
			Effect.sync(() => {
				store.set(path, data);
				writeCount.value += 1;
			}),
		append: (path: string, data: string) =>
			Effect.sync(() => {
				store.set(path, `${store.get(path) ?? ""}${data}`);
				writeCount.value += 1;
			}),
		exists: (path: string) => Effect.sync(() => store.has(path)),
		remove: (path: string) =>
			Effect.sync(() => {
				store.delete(path);
			}),
		ensureDir: (_path: string) => Effect.void,
		watch: (_path: string, _onChange: () => void) => Effect.succeed(() => {}),
	};

	return {
		layer: Layer.succeed(StorageAdapterService, adapter),
		store,
		writeCount,
		resetWrites: () => {
			writeCount.value = 0;
		},
	};
};

const serializerLayer = makeSerializerLayer([jsonCodec()]);

interface PersistentCollection<Row> {
	readonly query: (query?: Record<string, unknown>) => {
		readonly runPromise: Promise<ReadonlyArray<Row>>;
	};
	readonly findById: (id: string) => {
		readonly runPromise: Promise<Row | undefined>;
	};
	readonly exists: (id: string) => { readonly runPromise: Promise<boolean> };
	readonly create: (row: Row) => { readonly runPromise: Promise<Row> };
	readonly createMany: (rows: ReadonlyArray<Row>) => {
		readonly runPromise: Promise<unknown>;
	};
	readonly update: (
		id: string,
		updates: Record<string, unknown>,
	) => { readonly runPromise: Promise<Row> };
	readonly updateMany: (
		selector: ((row: Row) => boolean) | Record<string, unknown>,
		updates: Record<string, unknown>,
	) => { readonly runPromise: Promise<unknown> };
	readonly delete: (id: string) => { readonly runPromise: Promise<Row> };
	readonly deleteMany: (
		selector: ((row: Row) => boolean) | Record<string, unknown>,
	) => { readonly runPromise: Promise<unknown> };
}

interface PersistentDb<Row> {
	readonly users: PersistentCollection<Row>;
	readonly flush: () => Promise<void>;
	readonly pendingCount: () => number;
	readonly close: () => Promise<void>;
	readonly $transaction: <A>(
		fn: (ctx: {
			readonly users: {
				readonly create: (row: Row) => Effect.Effect<Row>;
				readonly update: (
					id: string,
					updates: Record<string, unknown>,
				) => Effect.Effect<Row>;
				readonly delete: (id: string) => Effect.Effect<Row>;
			};
		}) => Effect.Effect<A>,
	) => Effect.Effect<A>;
}

interface PersistentBenchHandle<Row> {
	readonly db: PersistentDb<Row>;
	readonly close: () => Promise<void>;
}

interface PersistentBenchEngine {
	readonly id: "typescript" | "wasm";
	createDatabase: <Config extends Record<string, CollectionConfig>>(
		config: Config,
		initialData: Record<string, ReadonlyArray<Record<string, unknown>>>,
		storage: CountingStorage,
		plugins?: ReadonlyArray<ProseQLPlugin>,
	) => Promise<PersistentBenchHandle<User>>;
}

const createPersistentHandle = async (
	factory: typeof createCorePersistentEffectDatabase,
	config: Record<string, CollectionConfig>,
	initialData: Record<string, ReadonlyArray<Record<string, unknown>>>,
	storage: CountingStorage,
	plugins?: ReadonlyArray<ProseQLPlugin>,
): Promise<PersistentBenchHandle<User>> => {
	const layer = Layer.merge(storage.layer, serializerLayer);
	const scope = await Effect.runPromise(Scope.make());
	const db = await Effect.runPromise(
		Scope.provide(scope)(
			factory(
				config,
				initialData,
				{ writeDebounce: 10 },
				plugins ? { plugins } : undefined,
			).pipe(Effect.provide(layer)),
		),
	);
	return {
		db: db as unknown as PersistentDb<User>,
		close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
	};
};

const persistentBenchEngines = [
	{
		id: "typescript",
		createDatabase: (config, initialData, storage, plugins) =>
			createPersistentHandle(
				createCorePersistentEffectDatabase,
				config,
				initialData,
				storage,
				plugins,
			),
	},
	{
		id: "wasm",
		createDatabase: (config, initialData, storage, plugins) =>
			createPersistentHandle(
				createWasmPersistentEffectDatabase,
				config,
				initialData,
				storage,
				plugins,
			),
	},
] as const satisfies ReadonlyArray<PersistentBenchEngine>;

const createBatchUsers = (prefix: string, count = MUTATION_BATCH_SIZE) =>
	Array.from({ length: count }, (_, index) => ({
		id: `${prefix}_${index}`,
		name: `Batch User ${index}`,
		email: `${prefix}_${index}@example.com`,
		age: 20 + (index % 10),
		role: "user" as const,
		createdAt: FIXED_CREATED_AT,
	}));

const createLocaleUsers = (): ReadonlyArray<User> => [
	{
		id: "locale-1",
		name: "Ångström",
		email: "angstrom@example.com",
		age: 31,
		role: "user",
		createdAt: FIXED_CREATED_AT,
	},
	{
		id: "locale-2",
		name: "Apple",
		email: "apple@example.com",
		age: 32,
		role: "user",
		createdAt: FIXED_CREATED_AT,
	},
	{
		id: "locale-3",
		name: "Äther",
		email: "aether@example.com",
		age: 33,
		role: "user",
		createdAt: FIXED_CREATED_AT,
	},
	{
		id: "locale-4",
		name: "Zebra",
		email: "zebra@example.com",
		age: 34,
		role: "user",
		createdAt: FIXED_CREATED_AT,
	},
];

const computeCaseType = (value: BenchmarkCaseType) => value;

const registerTaskMetadata = (options: {
	readonly bench: Bench;
	readonly benchmarkName: string;
	readonly engineId: "typescript" | "wasm";
	readonly category: BenchmarkCategory;
	readonly caseType: BenchmarkCaseType;
	readonly operationCount: number;
	readonly normalInteraction: boolean;
	readonly checksum: string;
	readonly initializationMs: number;
	readonly commandPayload?: unknown;
	readonly resultPayload?: unknown;
}) => {
	const task = options.bench.tasks[options.bench.tasks.length - 1];
	if (!task) {
		throw new Error(`Missing benchmark task for ${options.benchmarkName}`);
	}
	attachTaskMetadata(task, {
		benchmarkName: options.benchmarkName,
		engineId: options.engineId,
		category: options.category,
		caseType: options.caseType,
		datasetSize: BASELINE_SIZE,
		operationCount: options.operationCount,
		normalInteraction: options.normalInteraction,
		checksum: options.checksum,
		instrumentation: createTaskInstrumentation({
			initializationMs: options.initializationMs,
			commandPayload: options.commandPayload,
			resultPayload: options.resultPayload,
		}),
	});
};

export const suiteName = "serialization";

export async function createSuite(options?: {
	readonly includeStress?: boolean;
	readonly benchOptions?: Parameters<typeof buildBenchOptions>[0];
	readonly engines?: ReadonlyArray<"typescript" | "wasm">;
}): Promise<{
	readonly bench: Bench;
	readonly teardown: () => Promise<void>;
}> {
	const bench = new Bench(buildBenchOptions(options?.benchOptions));
	const baselineUsers = [...generateUsers(BASELINE_SIZE)];
	const closers: Array<() => Promise<void>> = [];

	try {
		for (const engine of persistentBenchEngines.filter((engine) =>
			options?.engines === undefined
				? true
				: options.engines.includes(engine.id),
		)) {
			const coalescingStorage = createCountingStorage();
			const coalescingChecksumBatch = createBatchUsers("checksum_coalescing");
			const { value: coalescingChecksumHandle } = await measureAsync(() =>
				engine.createDatabase(basicConfig, { users: [] }, coalescingStorage),
			);
			const coalescingResultPayload = await withFrozenDate(
				CHECKSUM_CLOCK_ISO,
				async () => {
					await coalescingChecksumHandle.db.users.createMany(
						coalescingChecksumBatch,
					).runPromise;
					await coalescingChecksumHandle.db.flush();
					const coalescingChecksumReload = await engine.createDatabase(
						basicConfig,
						{},
						coalescingStorage,
					);
					try {
						return {
							writeCount: coalescingStorage.writeCount.value,
							reloaded: await coalescingChecksumReload.db.users.query({
								sort: { id: "asc" },
							}).runPromise,
						};
					} finally {
						await coalescingChecksumReload.close();
					}
				},
			);
			const coalescingChecksum = checksumBenchmarkValue(
				coalescingResultPayload,
			);
			await coalescingChecksumHandle.close();

			const coalescingStorageForBench = createCountingStorage();
			const {
				value: coalescingHandle,
				durationMs: coalescingInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(
					basicConfig,
					{ users: [] },
					coalescingStorageForBench,
				),
			);
			closers.push(coalescingHandle.close);
			let coalescingCounter = 0;
			let lastCoalescingIds: ReadonlyArray<string> = [];
			bench.add(
				createEngineTaskName(
					engine.id,
					"persistence: debounced coalescing (100 mutations)",
				),
				async () => {
					coalescingStorageForBench.resetWrites();
					const batch = createBatchUsers(
						`bench_coalescing_${coalescingCounter++}`,
					);
					lastCoalescingIds = batch.map((user) => user.id);
					for (const user of batch) {
						await coalescingHandle.db.users.create(user).runPromise;
					}
					await coalescingHandle.db.flush();
				},
				{
					afterEach: async () => {
						if (lastCoalescingIds.length === 0) {
							return;
						}
						await coalescingHandle.db.users.deleteMany((user) =>
							lastCoalescingIds.includes(user.id),
						).runPromise;
						await coalescingHandle.db.flush();
						lastCoalescingIds = [];
						coalescingStorageForBench.resetWrites();
					},
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "persistence: debounced coalescing (100 mutations)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: computeCaseType("required"),
				operationCount: 100,
				normalInteraction: false,
				checksum: coalescingChecksum,
				initializationMs: coalescingInitializationMs,
				commandPayload: createBatchUsers("bench_coalescing_payload"),
				resultPayload: coalescingResultPayload,
			});

			const explicitFlushStorage = createCountingStorage();
			const { value: explicitFlushChecksumHandle } = await measureAsync(() =>
				engine.createDatabase(basicConfig, { users: [] }, explicitFlushStorage),
			);
			const explicitFlushUser = {
				id: "checksum_explicit_flush",
				name: "Checksum Flush",
				email: "checksum-flush@example.com",
				age: 28,
				role: "user" as const,
				createdAt: FIXED_CREATED_AT,
			};
			const explicitFlushResultPayload = await withFrozenDate(
				CHECKSUM_CLOCK_ISO,
				async () => {
					await explicitFlushChecksumHandle.db.users.create(explicitFlushUser)
						.runPromise;
					await explicitFlushChecksumHandle.db.flush();
					const explicitFlushReload = await engine.createDatabase(
						basicConfig,
						{},
						explicitFlushStorage,
					);
					try {
						return {
							writeCount: explicitFlushStorage.writeCount.value,
							reloaded: await explicitFlushReload.db.users.findById(
								explicitFlushUser.id,
							).runPromise,
						};
					} finally {
						await explicitFlushReload.close();
					}
				},
			);
			const explicitFlushChecksum = checksumBenchmarkValue(
				explicitFlushResultPayload,
			);
			await explicitFlushChecksumHandle.close();

			const explicitFlushStorageForBench = createCountingStorage();
			const {
				value: explicitFlushHandle,
				durationMs: explicitFlushInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(
					basicConfig,
					{ users: [] },
					explicitFlushStorageForBench,
				),
			);
			closers.push(explicitFlushHandle.close);
			let explicitFlushCounter = 0;
			let lastExplicitFlushId: string | undefined;
			bench.add(
				createEngineTaskName(engine.id, "persistence: explicit flush"),
				async () => {
					explicitFlushStorageForBench.resetWrites();
					lastExplicitFlushId = `bench_explicit_flush_${explicitFlushCounter++}`;
					await explicitFlushHandle.db.users.create({
						id: lastExplicitFlushId,
						name: "Benchmark Flush",
						email: `${lastExplicitFlushId}@example.com`,
						age: 29,
						role: "user",
						createdAt: FIXED_CREATED_AT,
					}).runPromise;
					await explicitFlushHandle.db.flush();
				},
				{
					afterEach: async () => {
						if (!lastExplicitFlushId) {
							return;
						}
						await explicitFlushHandle.db.users.delete(lastExplicitFlushId)
							.runPromise;
						await explicitFlushHandle.db.flush();
						lastExplicitFlushId = undefined;
						explicitFlushStorageForBench.resetWrites();
					},
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "persistence: explicit flush",
				engineId: engine.id,
				category: "write-transaction",
				caseType: computeCaseType("required"),
				operationCount: 1,
				normalInteraction: false,
				checksum: explicitFlushChecksum,
				initializationMs: explicitFlushInitializationMs,
				commandPayload: explicitFlushUser,
				resultPayload: explicitFlushResultPayload,
			});

			const computedStorage = createCountingStorage();
			const { value: computedHandle, durationMs: computedInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(
						computedConfig,
						{ users: baselineUsers },
						computedStorage,
					),
				);
			closers.push(computedHandle.close);
			const computedQuery = {
				where: { displayName: { $contains: "User 1" } },
				select: ["id", "displayName"],
				sort: { id: "asc" },
				limit: 25,
			};
			const computedResultPayload =
				await computedHandle.db.users.query(computedQuery).runPromise;
			const computedChecksum = checksumBenchmarkValue(computedResultPayload);
			bench.add(
				createEngineTaskName(engine.id, "callback: computed field"),
				async () => {
					await computedHandle.db.users.query(computedQuery).runPromise;
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "callback: computed field",
				engineId: engine.id,
				category: "read-query",
				caseType: computeCaseType("characterization"),
				operationCount: 1,
				normalInteraction: false,
				checksum: computedChecksum,
				initializationMs: computedInitializationMs,
				commandPayload: computedQuery,
				resultPayload: computedResultPayload,
			});

			const operatorStorage = createCountingStorage();
			const { value: operatorHandle, durationMs: operatorInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(
						basicConfig,
						{ users: baselineUsers },
						operatorStorage,
						[prefixPlugin],
					),
				);
			closers.push(operatorHandle.close);
			const operatorQuery = {
				where: { name: { $prefix: "User 1" } },
				select: ["id", "name"],
				sort: { id: "asc" },
				limit: 25,
			};
			const operatorResultPayload =
				await operatorHandle.db.users.query(operatorQuery).runPromise;
			const operatorChecksum = checksumBenchmarkValue(operatorResultPayload);
			bench.add(
				createEngineTaskName(engine.id, "callback: custom operator"),
				async () => {
					await operatorHandle.db.users.query(operatorQuery).runPromise;
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "callback: custom operator",
				engineId: engine.id,
				category: "read-query",
				caseType: computeCaseType("characterization"),
				operationCount: 1,
				normalInteraction: false,
				checksum: operatorChecksum,
				initializationMs: operatorInitializationMs,
				commandPayload: operatorQuery,
				resultPayload: operatorResultPayload,
			});

			const localeStorage = createCountingStorage();
			const localeUsers = createLocaleUsers();
			const { value: localeHandle, durationMs: localeInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(
						localeCollatorConfig,
						{ users: [...localeUsers] },
						localeStorage,
					),
				);
			closers.push(localeHandle.close);
			const localeQuery = { sort: { name: "asc" }, select: ["id", "name"] };
			const localeResultPayload =
				await localeHandle.db.users.query(localeQuery).runPromise;
			const localeChecksum = checksumBenchmarkValue(localeResultPayload);
			bench.add(
				createEngineTaskName(engine.id, "callback: locale collator"),
				async () => {
					await localeHandle.db.users.query(localeQuery).runPromise;
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "callback: locale collator",
				engineId: engine.id,
				category: "read-query",
				caseType: computeCaseType("characterization"),
				operationCount: 1,
				normalInteraction: false,
				checksum: localeChecksum,
				initializationMs: localeInitializationMs,
				commandPayload: localeQuery,
				resultPayload: localeResultPayload,
			});

			const hookEventsForChecksum: Array<string> = [];
			const hookStorage = createCountingStorage();
			const { value: hookChecksumHandle } = await measureAsync(() =>
				engine.createDatabase(
					createHooksConfig(hookEventsForChecksum),
					{ users: [] },
					hookStorage,
				),
			);
			const hookUserId = "checksum_hooks";
			await hookChecksumHandle.db.users.create({
				id: hookUserId,
				name: "Hook User",
				email: "HOOK@EXAMPLE.COM",
				age: 35,
				role: "user",
				createdAt: FIXED_CREATED_AT,
			}).runPromise;
			await hookChecksumHandle.db.users.update(hookUserId, {
				name: "Hook User Updated",
			}).runPromise;
			await hookChecksumHandle.db.users.delete(hookUserId).runPromise;
			const hookResultPayload = {
				events: [...hookEventsForChecksum],
				existsAfterDelete:
					await hookChecksumHandle.db.users.exists(hookUserId).runPromise,
			};
			const hookChecksum = checksumBenchmarkValue(hookResultPayload);
			await hookChecksumHandle.close();

			const hookEvents: Array<string> = [];
			const hookStorageForBench = createCountingStorage();
			const { value: hookHandle, durationMs: hookInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(
						createHooksConfig(hookEvents),
						{ users: [] },
						hookStorageForBench,
					),
				);
			closers.push(hookHandle.close);
			let hookCounter = 0;
			bench.add(
				createEngineTaskName(engine.id, "callback: before/after hooks"),
				async () => {
					hookEvents.length = 0;
					const id = `bench_hooks_${hookCounter++}`;
					await hookHandle.db.users.create({
						id,
						name: "Hook Bench User",
						email: "HOOK-BENCH@EXAMPLE.COM",
						age: 36,
						role: "user",
						createdAt: FIXED_CREATED_AT,
					}).runPromise;
					await hookHandle.db.users.update(id, {
						name: "Hook Bench User Updated",
					}).runPromise;
					await hookHandle.db.users.delete(id).runPromise;
				},
			);
			registerTaskMetadata({
				bench,
				benchmarkName: "callback: before/after hooks",
				engineId: engine.id,
				category: "write-transaction",
				caseType: computeCaseType("characterization"),
				operationCount: 3,
				normalInteraction: false,
				checksum: hookChecksum,
				initializationMs: hookInitializationMs,
				commandPayload: {
					create: {
						name: "Hook Bench User",
						email: "HOOK-BENCH@EXAMPLE.COM",
					},
					update: { name: "Hook Bench User Updated" },
				},
				resultPayload: hookResultPayload,
			});
		}

		return {
			bench,
			teardown: async () => {
				await closeAll(closers);
			},
		};
	} catch (error) {
		await closeAll(closers);
		throw error;
	}
}

export async function run(): Promise<void> {
	console.log("Running Persistence and Callback Benchmarks\n");

	const { bench, teardown } = await createSuite();
	try {
		await bench.run();
		console.log("\nResults:\n");
		console.log(formatResultsTable(bench.tasks));
	} finally {
		await teardown();
	}
}

if (import.meta.main) {
	run();
}
