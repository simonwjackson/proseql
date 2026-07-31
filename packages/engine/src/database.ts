import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import {
	CollectionNotFoundError,
	StorageAdapterService as StorageAdapter,
	SourceConfigError,
	NotFoundError,
	OperationError,
	TransactionError,
	ValidationError,
	dryRunMigrations,
	inferCodecsFromConfig,
	getCollectionConfigs,
	isSourceOrientedDatabaseConfig,
	loadCollectionsFromFile,
	loadData,
	loadDataFromDirectory,
	loadDocumentGraphSources,
	loadDocumentSources,
	makeSerializerLayer,
	mergeSerializerWithPluginCodecs,
	normalizeSourceConfig,
	SerializerRegistryService,
	removeEntityFromDirectory,
	saveCollectionsToFile,
	saveData,
	saveDocumentSource,
	saveEntityToDirectory,
	type CollectionConfig,
	type DatabaseConfig,
	type DocumentGraphDiagnostic,
	type DocumentGraphRecordProvenance,
	type DryRunResult,
	type Migration,
	type NormalizedSourceConfig,
	type PluginRegistry,
} from "@proseql/core";
import { Effect, Layer, type Schema } from "effect";
import { reconstructBoundaryError, WasmEngineDefectError } from "./errors.js";
import { loadWasmBindings, type WasmRuntimeBinding } from "./loader.js";
import { buildPluginRegistry } from "./plugin-registry.js";
import { compileDatabaseDescriptor, type CallbackRegistrar } from "./schema-compiler.js";
import {
	createNodeEngineStorageHost,
	makeEngineStorageLayer,
	makeNodeEngineStorageLayer,
	type NodeEngineStorageHost,
} from "./storage-host.js";
import type {
	EngineCollection,
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	EngineWatchConfig,
	GenerateEngineDatabase,
	GenerateEngineDatabaseWithPersistence,
	WatchSubscription,
	EngineTransactionDatabase,
} from "./types.js";

const DEFAULT_WRITE_DEBOUNCE = 100;

type BridgeOk<T> = { kind: "ok"; value: T };
type BridgeError = { kind: "error"; error: unknown };
type BridgeDefect = { kind: "defect"; message: string };
type BridgeResponse<T> = BridgeOk<T> | BridgeError | BridgeDefect;

type CollectionRuntimeConfig = {
	readonly name: string;
	readonly schema: Schema.Top;
	readonly raw: CollectionConfig;
};

type SharedFileGroup = {
	readonly file: string;
	readonly collections: ReadonlyArray<CollectionRuntimeConfig>;
};

type SourcePersistenceState = {
	readonly normalizedConfig: NormalizedSourceConfig;
	readonly writableSourceByCollection: Map<string, string>;
	readonly readOnlyCollections: Set<string>;
	readonly documentsState: {
		origins: any;
		documents: ReadonlyArray<unknown>;
	};
	readonly graphState: {
		provenance: ReadonlyMap<string, DocumentGraphRecordProvenance>;
		diagnostics: ReadonlyArray<DocumentGraphDiagnostic>;
	};
};

type LoadedCollectionsResult = {
	readonly collections: Record<string, ReadonlyArray<Record<string, unknown>>>;
	readonly sourceState?: SourcePersistenceState;
};

type PersistenceState = {
	host: NodeEngineStorageHost;
	readonly layer: Layer.Layer<any>;
	readonly collections: ReadonlyArray<CollectionRuntimeConfig>;
	readonly sharedFiles: ReadonlyArray<SharedFileGroup>;
	readonly directoryIds: Map<string, Set<string>>;
	readonly writeKeyByCollection: Map<string, string>;
	readonly saver: DebouncedSaver;
	readonly sourceState?: SourcePersistenceState;
	readonly watcherStops: Array<() => void>;
	backgroundError?: unknown;
};

type TransactionGate = {
	active: boolean;
	readonly context: AsyncLocalStorage<true>;
};

type SaveLane = {
	dirty: boolean;
	queuedAfterInflight: boolean;
	timer?: ReturnType<typeof setTimeout>;
	inflight?: Promise<void>;
	error?: unknown;
};

class DebouncedSaver {
	private readonly lanes = new Map<string, SaveLane>();

	constructor(
		private readonly delayMs: number,
		private readonly save: (key: string) => Promise<void>,
	) {}

	registerKey(key: string) {
		this.ensureLane(key);
	}

	schedule(key: string) {
		const lane = this.ensureLane(key);
		lane.dirty = true;
		if (lane.timer) clearTimeout(lane.timer);
		lane.timer = setTimeout(() => {
			lane.timer = undefined;
			void this.startSave(key, lane, false);
		}, this.delayMs);
	}

	pendingCount() {
		let count = 0;
		for (const lane of this.lanes.values()) {
			if (lane.timer) count += 1;
		}
		return count;
	}

	async flush() {
		const keys = [...this.lanes.entries()]
			.filter(([, lane]) => lane.timer || lane.dirty || lane.inflight || lane.error !== undefined)
			.map(([key]) => key);
		for (const key of keys) {
			const lane = this.lanes.get(key);
			if (lane?.timer) {
				clearTimeout(lane.timer);
				lane.timer = undefined;
			}
		}
		await Promise.all(keys.map((key) => this.flushLane(key)));
		const firstError = [...this.lanes.values()].find((lane) => lane.error !== undefined)?.error;
		if (firstError !== undefined) throw firstError;
	}

	private ensureLane(key: string): SaveLane {
		const existing = this.lanes.get(key);
		if (existing) return existing;
		const lane: SaveLane = { dirty: false, queuedAfterInflight: false };
		this.lanes.set(key, lane);
		return lane;
	}

	private async flushLane(key: string) {
		const lane = this.ensureLane(key);
		while (lane.dirty || lane.inflight) {
			await this.startSave(key, lane, true);
			if (lane.inflight) {
				await lane.inflight;
			}
		}
		if (lane.error !== undefined) throw lane.error;
	}

	private async startSave(key: string, lane: SaveLane, immediateRetry: boolean): Promise<void> {
		if (lane.inflight) {
			lane.queuedAfterInflight = true;
			await lane.inflight;
			if (immediateRetry && lane.error !== undefined) throw lane.error;
			return;
		}
		if (!lane.dirty && lane.error === undefined) return;
		lane.dirty = false;
		lane.queuedAfterInflight = false;
		lane.inflight = (async () => {
			try {
				await this.save(key);
				lane.error = undefined;
			} catch (error) {
				lane.error = error;
				lane.dirty = true;
			} finally {
				lane.inflight = undefined;
				if (lane.timer) {
					clearTimeout(lane.timer);
					lane.timer = undefined;
				}
				if (
					(lane.dirty || lane.queuedAfterInflight) &&
					!immediateRetry &&
					lane.error === undefined
				) {
					lane.timer = setTimeout(() => {
						lane.timer = undefined;
						void this.startSave(key, lane, false);
					}, this.delayMs);
				}
			}
		})();
		await lane.inflight;
		if (immediateRetry && lane.error !== undefined) throw lane.error;
	}
}

class RuntimeCallbackRegistrar implements CallbackRegistrar {
	private nextId = 1;
	private collatorRegistered = false;

	constructor(private readonly runtime: WasmRuntimeBinding) {}

	registerDefault(callback: () => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_default(id, () => JSON.stringify(callback()));
		return id;
	}

	registerComputed(callback: (entity: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_computed(id, (payloadJson) => {
			const payload = JSON.parse(payloadJson);
			return JSON.stringify(callback(payload));
		});
		return id;
	}

	registerBeforeCreateHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_create_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerBeforeUpdateHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_update_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerBeforeDeleteHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_delete_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerAfterCreateHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_create_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerAfterUpdateHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_update_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerAfterDeleteHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_delete_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerOnChangeHook(callback: (ctx: unknown) => unknown, prefix: string): string {
		const id = this.makeId(prefix);
		this.runtime.register_on_change_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(JSON.parse(payloadJson))),
		);
		return id;
	}

	registerMigration(
		callback: (data: Record<string, unknown>) => Record<string, unknown>,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_migration(id, (payloadJson) => {
			const payload = JSON.parse(payloadJson) as Record<string, unknown>;
			return JSON.stringify(callback(payload));
		});
		return id;
	}

	registerIdGenerator(name: string, generate: () => string): void {
		this.runtime.register_id_generator(name, () => generate());
	}

	async registerCustomOperator(
		name: string,
		supportedTypes: ReadonlyArray<string>,
		evaluate: (field: unknown, operand: unknown) => boolean,
	): Promise<void> {
		const response = this.runtime.register_custom_operator(
			name,
			JSON.stringify([...supportedTypes]),
			(fieldJson, operandJson) => evaluate(JSON.parse(fieldJson), JSON.parse(operandJson)),
		);
		parseBridgeResponse(response);
	}

	registerCollator(callback: (left: string, right: string) => number): void {
		if (this.collatorRegistered) return;
		this.collatorRegistered = true;
		this.runtime.register_collator(callback);
	}

	private makeId(prefix: string) {
		return `${prefix}:${this.nextId++}`;
	}
}

class AsyncQueue<T> implements WatchSubscription<T> {
	private readonly values: T[] = [];
	private readonly resolvers: Array<(value: IteratorResult<T>) => void> = [];
	private active = true;
	private unsubscribePromise: Promise<void> | undefined;

	constructor(private readonly stop: () => Promise<void>) {}

	push(value: T) {
		if (!this.active) return;
		const next = this.resolvers.shift();
		if (next) next({ value, done: false });
		else this.values.push(value);
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0) {
			return Promise.resolve({ value: this.values.shift() as T, done: false });
		}
		if (!this.active) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise((resolve) => this.resolvers.push(resolve));
	}

	async return(): Promise<IteratorResult<T>> {
		await this.unsubscribe();
		return { value: undefined, done: true };
	}

	unsubscribe(): Promise<void> {
		if (!this.unsubscribePromise) {
			this.active = false;
			for (const resolve of this.resolvers.splice(0)) {
				resolve({ value: undefined, done: true });
			}
			this.values.length = 0;
			this.unsubscribePromise = this.stop();
		}
		return this.unsubscribePromise;
	}
}

class EngineRuntime {
	readonly runtime: WasmRuntimeBinding;
	readonly handle: number;
	readonly createInput: {
		descriptor: Record<string, unknown>;
		initialCollections: Record<string, ReadonlyArray<Record<string, unknown>>>;
	};

	private constructor(
		runtime: WasmRuntimeBinding,
		handle: number,
		createInput: {
			descriptor: Record<string, unknown>;
			initialCollections: Record<string, ReadonlyArray<Record<string, unknown>>>;
		},
	) {
		this.runtime = runtime;
		this.handle = handle;
		this.createInput = createInput;
	}

	static async create(
		config: DatabaseConfig,
		initialData: EngineInitialData<DatabaseConfig> | undefined,
		options: EngineDatabaseOptions | undefined,
		registryOverride?: PluginRegistry,
	): Promise<{ runtime: EngineRuntime; registry: PluginRegistry; collections: ReadonlyArray<CollectionRuntimeConfig> }> {
		const registry = registryOverride ?? (await buildPluginRegistry(options?.plugins));
		const bindings = await loadWasmBindings();
		const runtime = new bindings.WasmRuntime(globalThis.setTimeout, globalThis.clearTimeout);
		const registrar = new RuntimeCallbackRegistrar(runtime);
		const compiled = await compileDatabaseDescriptor(config, registry, registrar);
		const collections = Object.entries((config as any).collections ?? config).map(([name, raw]) => ({
			name,
			schema: (raw as CollectionConfig).schema,
			raw: raw as CollectionConfig,
		}));
		const createPayload = {
			descriptor: compiled.descriptor as Record<string, unknown>,
			initialCollections: (initialData ?? {}) as Record<
				string,
				ReadonlyArray<Record<string, unknown>>
			>,
		};
		const handle = parseBridgeResponse<number>(runtime.create_database(JSON.stringify(createPayload)));
		return { runtime: new EngineRuntime(runtime, handle, createPayload), registry, collections };
	}

	dispatch<T>(method: string, payload?: unknown): T {
		return parseBridgeResponse(
			this.runtime.dispatch(
				this.handle,
				method,
				payload === undefined ? undefined : JSON.stringify(payload),
			),
		);
	}

	invoke<T>(method: string, payload?: unknown): Promise<T> {
		return Promise.resolve().then(() => this.dispatch<T>(method, payload));
	}

	async createTemporaryTransactionRuntime(): Promise<EngineRuntime> {
		const snapshot = await this.invoke<Record<string, ReadonlyArray<Record<string, unknown>>>>(
			"dumpAll",
		);
		const createPayload = {
			descriptor: this.createInput.descriptor,
			initialCollections: snapshot,
		};
		const handle = parseBridgeResponse<number>(
			this.runtime.create_database(JSON.stringify(createPayload)),
		);
		return new EngineRuntime(this.runtime, handle, createPayload);
	}

	drop(): Promise<void> {
		return Promise.resolve().then(() => {
			parseBridgeResponse(this.runtime.drop_database(this.handle));
		});
	}

	watch<T>(collection: string, config: EngineWatchConfig<T, unknown, unknown> | undefined): WatchSubscription<ReadonlyArray<T>> {
		const queue = new AsyncQueue<ReadonlyArray<T>>(() =>
			Promise.resolve().then(() => {
				if (subscriptionId === undefined) return;
				parseBridgeResponse(this.runtime.unsubscribe(this.handle, subscriptionId));
			}),
		);
		let subscriptionId: number | undefined;
		subscriptionId = parseBridgeResponse<number>(
			this.runtime.subscribe_watch(
				this.handle,
				JSON.stringify({ collection, config }),
				(payloadJson) => queue.push(JSON.parse(payloadJson) as ReadonlyArray<T>),
			),
		);
		return queue;
	}

	watchById<T>(collection: string, id: string, debounceMs?: number): WatchSubscription<T | null> {
		const queue = new AsyncQueue<T | null>(() =>
			Promise.resolve().then(() => {
				if (subscriptionId === undefined) return;
				parseBridgeResponse(this.runtime.unsubscribe(this.handle, subscriptionId));
			}),
		);
		let subscriptionId: number | undefined;
		subscriptionId = parseBridgeResponse<number>(
			this.runtime.subscribe_watch_by_id(
				this.handle,
				JSON.stringify({ collection, id, debounceMs }),
				(payloadJson) => queue.push(JSON.parse(payloadJson) as T | null),
			),
		);
		return queue;
	}
}

export const createEngineDatabase = async <Config extends DatabaseConfig>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabase<Config>> => {
	const { runtime, collections } = await EngineRuntime.create(
		config,
		initialData as EngineInitialData<DatabaseConfig> | undefined,
		options,
	);
	return buildDatabaseFacade(runtime, collections, undefined, config) as unknown as GenerateEngineDatabase<Config>;
};

export const createPersistentEngineDatabase = async <Config extends DatabaseConfig>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	persistenceOptions?: EnginePersistenceOptions,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabaseWithPersistence<Config>> => {
	const host = persistenceOptions?.storageHost ?? createNodeEngineStorageHost();
	const storageLayer = persistenceOptions?.storageLayer ?? makeEngineStorageLayer(host);
	const pluginRegistry = await buildPluginRegistry(options?.plugins);
	const serializerLayer = persistenceOptions?.serializerRegistry
		? Layer.succeed(
				SerializerRegistryService,
				mergeSerializerWithPluginCodecs(
					persistenceOptions.serializerRegistry,
					pluginRegistry.codecs,
				),
			)
		: makeSerializerLayer(inferCodecsFromConfig(config), pluginRegistry.codecs);
	const layer = Layer.merge(storageLayer, serializerLayer) as any;
	const collections = Object.entries(getCollectionConfigs(config)).map(([name, raw]) => ({
		name,
		schema: raw.schema,
		raw,
	}));
	const loaded = isSourceOrientedDatabaseConfig(config)
		? await loadSourceOrientedCollections(config, collections, initialData, host, layer)
		: await loadLegacyCollections(collections, initialData, host, layer);
	const { runtime } = await EngineRuntime.create(
		config,
		loaded.collections as EngineInitialData<DatabaseConfig>,
		options,
		pluginRegistry,
	);
	const persistence = createPersistenceState(
		runtime,
		collections,
		host,
		layer,
		persistenceOptions?.writeDebounce ?? DEFAULT_WRITE_DEBOUNCE,
		loaded.sourceState,
	);
	if (!persistenceOptions?._suppressInitialWrites) {
		for (const [collectionName, value] of Object.entries(initialData ?? {})) {
			if (value === undefined) continue;
			const key = persistence.writeKeyByCollection.get(collectionName);
			if (key) persistence.saver.schedule(key);
		}
	}
	await registerExternalReloadWatchers(runtime, persistence);
	return buildDatabaseFacade(runtime, collections, persistence, config) as unknown as GenerateEngineDatabaseWithPersistence<Config>;
};

function buildDatabaseFacade(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	persistence: PersistenceState | undefined,
	config: DatabaseConfig,
) {
	const transactionGate: TransactionGate = {
		active: false,
		context: new AsyncLocalStorage<true>(),
	};
	const db: Record<string, unknown> = {};
	for (const collection of collections) {
		db[collection.name] = buildCollectionFacade(runtime, collection, persistence) as EngineCollection<any>;
	}
	const documentGraph = {
		getRecordProvenance: async (collection: string, id: string) =>
			persistence?.sourceState?.graphState.provenance.get(`${collection}\u0000${id}`),
		getDiagnostics: async () => persistence?.sourceState?.graphState.diagnostics ?? [],
	};
	const transactional = {
		$transaction: <A>(fn: (ctx: EngineTransactionDatabase<any>) => Promise<A>) =>
			runTransaction(runtime, collections, persistence, fn, transactionGate),
		close: async () => {
			if (persistence) {
				await stopWatchers(persistence);
				try {
					await persistence.saver.flush();
					if (persistence.backgroundError !== undefined) {
						throw persistence.backgroundError;
					}
				} finally {
					await runtime.drop();
				}
				return;
			}
			await runtime.drop();
		},
	};
	if (!persistence) {
		return { ...db, ...transactional, $documentGraph: documentGraph };
	}
	return {
		...db,
		...transactional,
		$documentGraph: documentGraph,
		flush: async () => {
			await persistence.saver.flush();
			if (persistence.backgroundError !== undefined) {
				throw persistence.backgroundError;
			}
		},
		pendingCount: () => persistence.saver.pendingCount(),
		$dryRunMigrations: () => runDryRunMigrations(config, hostFromPersistence(persistence), persistence.layer),
	};
}

function validateCursorConfig(cursor: { readonly limit: number }) {
	if (!Number.isInteger(cursor.limit) || cursor.limit <= 0) {
		throw new ValidationError({
			message: "Invalid cursor configuration",
			issues: [
				{
					field: "cursor.limit",
					message: "limit must be a positive integer",
				},
			],
		});
	}
}

function buildCollectionFacade(
	runtime: EngineRuntime,
	collection: CollectionRuntimeConfig,
	persistence: PersistenceState | undefined,
): EngineCollection<any> {
	const writeKey = persistence?.writeKeyByCollection.get(collection.name);
	const ensureWritable = (operation: string) => {
		if (persistence?.sourceState?.readOnlyCollections.has(collection.name)) {
			throw new OperationError({
				operation,
				reason: "read-only-source",
				message: `Operation '${operation}' is not allowed on read-only collection '${collection.name}' (backed by a documentGraph source)`,
			});
		}
	};
	const scheduleWrite = () => {
		if (writeKey) persistence?.saver.schedule(writeKey);
	};
	return {
		query: ((config?: any) => {
			if (config?.cursor) {
				validateCursorConfig(config.cursor);
				return runtime.invoke("queryCursor", {
					collection: collection.name,
					query: {
						where: config.where,
						sort: config.sort,
						offset: config.offset,
						limit: config.limit,
						select: config.select,
					},
					cursor: config.cursor,
					populate: config.populate,
				});
			}
			return runtime.invoke("query", {
				collection: collection.name,
				query: {
					where: config?.where,
					sort: config?.sort,
					offset: config?.offset,
					limit: config?.limit,
					select: config?.select,
				},
				populate: config?.populate,
			});
		}) as any,
		aggregate: (config: any) =>
			runtime.invoke("aggregate", {
				collection: collection.name,
				where: config.where,
				config: {
					count: config.count ?? false,
					sum: normalizeAggregateFields(config.sum),
					avg: normalizeAggregateFields(config.avg),
					min: normalizeAggregateFields(config.min),
					max: normalizeAggregateFields(config.max),
					groupBy: config.groupBy,
				},
			}),
		findById: async (id: string) => {
			const results = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			if (results.length === 0) {
				throw new NotFoundError({
					collection: collection.name,
					id,
					message: `Entity with id "${id}" not found in collection "${collection.name}"`,
				});
			}
			return results[0];
		},
		exists: async (id: string) => {
			const results = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			return results.length > 0;
		},
		create: async (input: any) => {
			ensureWritable("create");
			const value = await runtime.invoke<any>("create", { collection: collection.name, data: input });
			scheduleWrite();
			return value;
		},
		createMany: async (inputs: ReadonlyArray<any>, options?: any) => {
			ensureWritable("createMany");
			const value = await runtime.invoke<any>("createMany", {
				collection: collection.name,
				items: [...inputs],
				skipDuplicates: options?.skipDuplicates ?? false,
			});
			if ((value.created ?? []).length > 0) scheduleWrite();
			return value;
		},
		update: async (id: string, updates: any) => {
			ensureWritable("update");
			const value = await runtime.invoke<any>("update", { collection: collection.name, id, data: updates });
			scheduleWrite();
			return value;
		},
		updateMany: async (where: any, updates: any) => {
			ensureWritable("updateMany");
			const value = await runtime.invoke<any>("updateMany", { collection: collection.name, where, data: updates });
			if ((value.count ?? 0) > 0) scheduleWrite();
			return value;
		},
		delete: async (id: string, options?: any) => {
			ensureWritable("delete");
			if (options?.soft) {
				const value = await runtime.invoke<any>("deleteMany", {
					collection: collection.name,
					where: { id },
					soft: true,
					limit: 1,
				});
				if (!value.deleted?.[0]) {
					throw new NotFoundError({
						collection: collection.name,
						id,
						message: `Entity with id "${id}" not found in collection "${collection.name}"`,
					});
				}
				scheduleWrite();
				return value.deleted[0];
			}
			const value = await runtime.invoke<any>("delete", { collection: collection.name, id });
			scheduleWrite();
			return value;
		},
		deleteMany: async (where: any, options?: any) => {
			ensureWritable("deleteMany");
			const value = await runtime.invoke<any>("deleteMany", {
				collection: collection.name,
				where,
				soft: options?.soft ?? false,
				limit: options?.limit,
			});
			if ((value.count ?? 0) > 0) scheduleWrite();
			return value;
		},
		upsert: async (input: any) => {
			ensureWritable("upsert");
			const value = await runtime.invoke<any>("upsert", {
				collection: collection.name,
				where: input.where,
				create: input.create,
				update: input.update,
			});
			scheduleWrite();
			return value;
		},
		upsertMany: async (inputs: ReadonlyArray<any>) => {
			ensureWritable("upsertMany");
			const value = await runtime.invoke<any>("upsertMany", {
				collection: collection.name,
				items: [...inputs],
			});
			if ((value.created?.length ?? 0) + (value.updated?.length ?? 0) > 0) scheduleWrite();
			return value;
		},
		createWithRelationships: async (input: any) => {
			ensureWritable("createWithRelationships");
			const value = await runtime.invoke<any>("createWithRelationships", { collection: collection.name, data: input });
			scheduleWrite();
			return value;
		},
		updateWithRelationships: async (id: string, input: any) => {
			ensureWritable("updateWithRelationships");
			const value = await runtime.invoke<any>("updateWithRelationships", { collection: collection.name, id, data: input });
			scheduleWrite();
			return value;
		},
		deleteWithRelationships: async (id: string, options?: any) => {
			ensureWritable("deleteWithRelationships");
			const value = await runtime.invoke<any>("deleteWithRelationships", {
				collection: collection.name,
				id,
				options,
			});
			scheduleWrite();
			return value;
		},
		deleteManyWithRelationships: async (where: any, options?: any) => {
			ensureWritable("deleteManyWithRelationships");
			const value = await runtime.invoke<any>("deleteManyWithRelationships", {
				collection: collection.name,
				where,
				options,
			});
			if ((value.count ?? 0) > 0) scheduleWrite();
			return value;
		},
		watch: (config?: any) => runtime.watch(collection.name, config),
		watchById: (id: string, options?: any) => runtime.watchById(collection.name, id, options?.debounceMs),
	};
}

async function loadLegacyCollections(
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	initialData: EngineInitialData<DatabaseConfig> | undefined,
	host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<LoadedCollectionsResult> {
	const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	const sharedGroups = buildSharedFileGroups(collections);
	for (const group of sharedGroups) {
		const fileExists = await host.exists(group.file);
		const loaded = fileExists
			? await Effect.runPromise(
					Effect.provide(
						loadCollectionsFromFile(
							group.file,
							group.collections.map((collection) => ({
								name: collection.name,
								schema: collection.schema as never,
								...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
								...(collection.raw.migrations ? { migrations: collection.raw.migrations as ReadonlyArray<Migration> } : {}),
							})),
						),
						layer,
					),
				)
			: undefined;
		for (const collection of group.collections) {
			result[collection.name] = mergeLoadedWithInitial(
				loaded?.[collection.name],
				initialData?.[collection.name as never],
			);
		}
	}

	for (const collection of collections) {
		if (result[collection.name]) continue;
		if (collection.raw.directory) {
			const dirExists = await host.exists(collection.raw.directory);
			const loaded = dirExists
				? await Effect.runPromise(
						Effect.provide(
							loadDataFromDirectory(
								collection.raw.directory,
								collection.schema as never,
								collection.raw.format ?? "json",
								{
									...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
									...(collection.raw.migrations ? { migrations: collection.raw.migrations as ReadonlyArray<Migration> } : {}),
									collectionName: collection.name,
								},
							),
							layer,
						),
					)
				: undefined;
			result[collection.name] = mergeLoadedWithInitial(
				loaded,
				initialData?.[collection.name as never],
			);
			continue;
		}
		if (collection.raw.file) {
			const fileExists = await host.exists(collection.raw.file);
			const loaded = fileExists
				? await Effect.runPromise(
						Effect.provide(
							loadData(collection.raw.file, collection.schema as never, {
								...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
								...(collection.raw.migrations ? { migrations: collection.raw.migrations as ReadonlyArray<Migration> } : {}),
								collectionName: collection.name,
								...(collection.raw.format ? { format: collection.raw.format } : {}),
								...(collection.raw.path ? { path: collection.raw.path } : {}),
								...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
								...(collection.raw.validation ? { validation: collection.raw.validation } : {}),
							}),
							layer,
						),
					)
				: undefined;
			result[collection.name] = mergeLoadedWithInitial(
				loaded,
				initialData?.[collection.name as never],
			);
			continue;
		}
		result[collection.name] = normalizeInitialCollection(initialData?.[collection.name as never]);
	}
	return { collections: result };
}

async function loadSourceOrientedCollections(
	config: Extract<DatabaseConfig, { readonly collections: Record<string, CollectionConfig> }>,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	initialData: EngineInitialData<DatabaseConfig> | undefined,
	host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<LoadedCollectionsResult> {
	void host;
	const normalizedConfig = normalizeSourceConfig(config);
	const loadedDocuments = normalizedConfig.sources.length
		? await Effect.runPromise(Effect.provide(loadDocumentSources(normalizedConfig), layer))
		: undefined;
	const graphOwnedCollections = new Set(
		normalizedConfig.sources
			.filter((source) => source.kind === "documentGraph")
			.flatMap((source) => source.collections),
	);
	for (const collectionName of graphOwnedCollections) {
		if ((initialData as Record<string, unknown> | undefined)?.[collectionName] !== undefined) {
			throw new SourceConfigError({
				message: `Collection '${collectionName}' is backed by a read-only documentGraph source and cannot accept initialData`,
				collection: collectionName,
			});
		}
	}
	const loadedGraph = graphOwnedCollections.size
		? await Effect.runPromise(Effect.provide(loadDocumentGraphSources(normalizedConfig), layer))
		: undefined;
	const writableSourceByCollection = new Map<string, string>();
	for (const source of normalizedConfig.sources) {
		if (source.kind !== "documents") continue;
		for (const collection of source.collections) {
			writableSourceByCollection.set(collection, source.id);
		}
	}
	const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	for (const collection of collections) {
		const loaded =
			loadedGraph?.collections[collection.name] ??
			loadedDocuments?.collections[collection.name] ??
			new Map<string, Record<string, unknown>>();
		result[collection.name] = mergeLoadedWithInitial(
			loaded,
			initialData?.[collection.name as never],
		);
	}
	return {
		collections: result,
		sourceState: {
			normalizedConfig,
			writableSourceByCollection,
			readOnlyCollections: graphOwnedCollections,
			documentsState: {
				origins: loadedDocuments?.origins ?? new Map(),
				documents: loadedDocuments?.documents ?? [],
			},
			graphState: {
				provenance: loadedGraph?.provenance ?? new Map(),
				diagnostics: loadedGraph?.diagnostics ?? [],
			},
		},
	};
}

function createPersistenceState(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
	writeDebounce: number,
	sourceState?: SourcePersistenceState,
): PersistenceState {
	const sharedFiles = buildSharedFileGroups(collections);
	const directoryIds = initializeDirectoryIds(runtime, collections);
	const writeKeyByCollection = buildWriteKeyByCollection(collections, sharedFiles, sourceState);
	const state: PersistenceState = {
		host,
		layer,
		collections,
		sharedFiles,
		directoryIds,
		writeKeyByCollection,
		sourceState,
		watcherStops: [],
		backgroundError: undefined,
		saver: new DebouncedSaver(writeDebounce, async (key) => {
			await persistCollectionState(state, runtime, key);
		}),
	};
	for (const key of new Set(writeKeyByCollection.values())) {
		state.saver.registerKey(key);
	}
	return state;
}

async function persistCollectionState(
	state: PersistenceState,
	runtime: EngineRuntime,
	key: string,
): Promise<void> {
	if (state.sourceState && key.startsWith("source:")) {
		await persistDocumentSourceState(state, runtime, key.slice("source:".length));
		return;
	}
	const sharedFile = state.sharedFiles.find((group) => `file:${group.file}` === key);
	if (sharedFile) {
		const data = await Promise.all(
			sharedFile.collections.map(async (collection) => ({
				name: collection.name,
				schema: collection.schema as never,
				data: toEntityMap(await runtime.invoke<Record<string, unknown>[]>("dumpCollection", { collection: collection.name })),
				...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
			})),
		);
		await Effect.runPromise(Effect.provide(saveCollectionsToFile(sharedFile.file, data as never), state.layer));
		return;
	}
	const fileCollections = state.collections.filter(
		(candidate) => candidate.raw.file && `file:${candidate.raw.file}` === key,
	);
	if (fileCollections.length > 0 && (fileCollections.length > 1 || fileCollections[0]?.raw.path)) {
		for (const collection of fileCollections) {
			const entities = await runtime.invoke<Record<string, unknown>[]>("dumpCollection", { collection: collection.name });
			const map = toEntityMap(entities);
			await Effect.runPromise(
				Effect.provide(
					saveData(collection.raw.file!, collection.schema as never, map as never, {
						...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
						...(collection.raw.format ? { format: collection.raw.format } : {}),
						...(collection.raw.path ? { path: collection.raw.path } : {}),
						...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
					}),
					state.layer,
				),
			);
		}
		return;
	}
	const collection = state.collections.find((candidate) => state.writeKeyByCollection.get(candidate.name) === key);
	if (!collection) {
		throw new CollectionNotFoundError({
			collection: key,
			message: `Collection '${key}' not found`,
		});
	}
	const entities = await runtime.invoke<Record<string, unknown>[]>("dumpCollection", { collection: collection.name });
	const map = toEntityMap(entities);
	if (collection.raw.directory) {
		const currentIds = new Set(map.keys());
		const previousIds = state.directoryIds.get(collection.name) ?? new Set<string>();
		for (const id of previousIds) {
			if (!currentIds.has(id)) {
				await Effect.runPromise(
					Effect.provide(
						removeEntityFromDirectory(collection.raw.directory, id, collection.raw.format ?? "json"),
						state.layer,
					),
				);
			}
		}
		for (const entity of entities) {
			await Effect.runPromise(
				Effect.provide(
					saveEntityToDirectory(
						collection.raw.directory,
						entity as never,
						collection.schema as never,
						collection.raw.format ?? "json",
					),
					state.layer,
				),
			);
		}
		state.directoryIds.set(collection.name, currentIds);
		return;
	}
	if (collection.raw.file) {
		await Effect.runPromise(
			Effect.provide(
				saveData(collection.raw.file, collection.schema as never, map as never, {
					...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
					...(collection.raw.format ? { format: collection.raw.format } : {}),
					...(collection.raw.path ? { path: collection.raw.path } : {}),
					...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
				}),
				state.layer,
			),
		);
	}
}

async function persistDocumentSourceState(
	state: PersistenceState,
	runtime: EngineRuntime,
	sourceId: string,
): Promise<void> {
	const sourceState = state.sourceState;
	if (!sourceState) return;
	const snapshot = await runtime.invoke<Record<string, ReadonlyArray<Record<string, unknown>>>>("dumpAll");
	const collections = Object.fromEntries(
		Object.entries(snapshot).map(([collection, rows]) => [collection, toEntityMap(rows)]),
	) as Record<string, ReadonlyMap<string, Record<string, unknown>>>;
	const saved = await Effect.runPromise(
		Effect.provide(
			saveDocumentSource({
				config: sourceState.normalizedConfig,
				sourceId,
				collections: collections as never,
				origins: sourceState.documentsState.origins,
				documents: sourceState.documentsState.documents as never,
			}),
			state.layer,
		),
	);
	sourceState.documentsState.origins = saved.origins;
	sourceState.documentsState.documents = saved.documents;
}

function initializeDirectoryIds(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
) {
	const ids = new Map<string, Set<string>>();
	for (const collection of collections) {
		if (!collection.raw.directory) continue;
		const rows = runtime.dispatch<Record<string, unknown>[]>("dumpCollection", {
			collection: collection.name,
		});
		ids.set(
			collection.name,
			new Set(
				rows
					.map((row) => row.id)
					.filter((id): id is string => typeof id === "string"),
			),
		);
	}
	return ids;
}

function buildWriteKeyByCollection(
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	sharedFiles: ReadonlyArray<SharedFileGroup>,
	sourceState?: SourcePersistenceState,
) {
	const keys = new Map<string, string>();
	for (const collection of collections) {
		const sourceId = sourceState?.writableSourceByCollection.get(collection.name);
		if (sourceId) {
			keys.set(collection.name, `source:${sourceId}`);
			continue;
		}
		const sharedFile = sharedFiles.find((group) =>
			group.collections.some((candidate) => candidate.name === collection.name),
		);
		if (sharedFile) {
			keys.set(collection.name, `file:${sharedFile.file}`);
			continue;
		}
		if (collection.raw.directory) {
			keys.set(collection.name, `directory:${collection.raw.directory}`);
			continue;
		}
		if (collection.raw.file) {
			keys.set(collection.name, `file:${collection.raw.file}`);
		}
	}
	return keys;
}

function mergeLoadedWithInitial(
	loaded:
		| ReadonlyMap<string, Record<string, unknown>>
		| Map<string, Record<string, unknown>>
		| undefined,
		initial: unknown,
) {
	const merged = new Map<string, Record<string, unknown>>(loaded ?? []);
	for (const item of normalizeInitialCollection(initial)) {
		const id = item.id;
		if (typeof id === "string") merged.set(id, item);
	}
	return [...merged.values()];
}

function hostFromPersistence(persistence: PersistenceState) {
	return persistence.host;
}

function recordBackgroundError(persistence: PersistenceState, error: unknown) {
	persistence.backgroundError = error;
}

function clearBackgroundError(persistence: PersistenceState) {
	persistence.backgroundError = undefined;
}

function trackWatcherStop(persistence: PersistenceState, stop: () => void) {
	persistence.watcherStops.push(() => {
		try {
			stop();
		} catch {
			// best-effort watcher cleanup
		}
	});
}

async function stopWatchers(persistence: PersistenceState) {
	for (const stop of persistence.watcherStops.splice(0)) {
		stop();
	}
}

function rowsFingerprint(rows: ReadonlyArray<Record<string, unknown>>) {
	return JSON.stringify(rows);
}

async function currentCollectionRows(runtime: EngineRuntime, collection: string) {
	return runtime.invoke<Record<string, unknown>[]>("dumpCollection", { collection });
}

async function reloadCollectionIfChanged(
	runtime: EngineRuntime,
	collection: string,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	const current = await currentCollectionRows(runtime, collection);
	if (rowsFingerprint(current) === rowsFingerprint(rows)) return false;
	await runtime.invoke("reloadCollection", { collection, records: rows });
	return true;
}

function updateDirectoryBaseline(
	persistence: PersistenceState,
	collection: CollectionRuntimeConfig,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	if (!collection.raw.directory) return;
	persistence.directoryIds.set(
		collection.name,
		new Set(
			rows
				.map((row) => row.id)
				.filter((id): id is string => typeof id === "string"),
		),
	);
}

function matchesWatchedFile(filename: string | null, file: string) {
	return filename === null || resolve(filename) === resolve(file);
}

function touchesWatchedDirectory(filename: string | null, directory: string) {
	if (filename === null) return true;
	const eventPath = resolve(filename);
	const target = resolve(directory);
	return eventPath === target || eventPath.startsWith(`${target}/`);
}

function runBackgroundReload(
	persistence: PersistenceState,
	task: () => Promise<void>,
) {
	void promiseCall(async () => {
		try {
			await persistence.saver.flush();
		} catch {
			return;
		}
		try {
			await task();
			clearBackgroundError(persistence);
		} catch (error) {
			recordBackgroundError(persistence, error);
		}
	}).catch((error) => {
		recordBackgroundError(persistence, error);
	});
}

async function loadLegacyCollectionRows(
	collection: CollectionRuntimeConfig,
	host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<ReadonlyArray<Record<string, unknown>>> {
	if (collection.raw.directory) {
		const dirExists = await host.exists(collection.raw.directory);
		if (!dirExists) return [];
		const loaded = await Effect.runPromise(
			Effect.provide(
				loadDataFromDirectory(
					collection.raw.directory,
					collection.schema as never,
					collection.raw.format ?? "json",
					{
						...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
						...(collection.raw.migrations
							? { migrations: collection.raw.migrations as ReadonlyArray<Migration> }
							: {}),
						collectionName: collection.name,
					},
				),
				layer,
			),
		);
		return [...loaded.values()];
	}
	if (collection.raw.file) {
		const fileExists = await host.exists(collection.raw.file);
		if (!fileExists) return [];
		const loaded = await Effect.runPromise(
			Effect.provide(
				loadData(collection.raw.file, collection.schema as never, {
					...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
					...(collection.raw.migrations
						? { migrations: collection.raw.migrations as ReadonlyArray<Migration> }
						: {}),
					collectionName: collection.name,
					...(collection.raw.format ? { format: collection.raw.format } : {}),
					...(collection.raw.path ? { path: collection.raw.path } : {}),
					...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
					...(collection.raw.validation ? { validation: collection.raw.validation } : {}),
				}),
				layer,
			),
		);
		return [...loaded.values()];
	}
	return [];
}

async function loadLegacyFileCollections(
	group: SharedFileGroup,
	host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
) {
	if (group.collections.length > 1 && group.collections.every((collection) => !collection.raw.path)) {
		const fileExists = await host.exists(group.file);
		if (!fileExists) {
			return Object.fromEntries(
				group.collections.map((collection) => [collection.name, []]),
			) as Record<string, ReadonlyArray<Record<string, unknown>>>;
		}
		const loaded = await Effect.runPromise(
			Effect.provide(
				loadCollectionsFromFile(
					group.file,
					group.collections.map((collection) => ({
						name: collection.name,
						schema: collection.schema as never,
						...(collection.raw.version !== undefined ? { version: collection.raw.version } : {}),
						...(collection.raw.migrations
							? { migrations: collection.raw.migrations as ReadonlyArray<Migration> }
							: {}),
					})),
				),
				layer,
			),
		);
		return Object.fromEntries(
			group.collections.map((collection) => [
				collection.name,
				[...(loaded?.[collection.name]?.values() ?? [])],
			]),
		) as Record<string, ReadonlyArray<Record<string, unknown>>>;
	}

	const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	for (const collection of group.collections) {
		result[collection.name] = await loadLegacyCollectionRows(collection, host, layer);
	}
	return result;
}

async function registerLegacyWatchers(runtime: EngineRuntime, persistence: PersistenceState) {
	const fileGroups = new Map<string, CollectionRuntimeConfig[]>();
	for (const collection of persistence.collections) {
		if (!collection.raw.file) continue;
		const group = fileGroups.get(collection.raw.file) ?? [];
		group.push(collection);
		fileGroups.set(collection.raw.file, group);
	}

	for (const [file, collections] of fileGroups) {
		const watchRoot = dirname(file);
		if (!(await persistence.host.exists(watchRoot))) continue;
		const stop = await persistence.host.watchDir(watchRoot, (event) => {
			if (!matchesWatchedFile(event.filename, file)) return;
			runBackgroundReload(persistence, async () => {
				const rowsByCollection = await loadLegacyFileCollections(
					{ file, collections },
					persistence.host,
					persistence.layer,
				);
				for (const collection of collections) {
					await reloadCollectionIfChanged(
						runtime,
						collection.name,
						rowsByCollection[collection.name] ?? [],
					);
				}
			});
		});
		trackWatcherStop(persistence, stop);
	}

	for (const collection of persistence.collections) {
		if (!collection.raw.directory) continue;
		const watchRoot = (await persistence.host.exists(collection.raw.directory))
			? collection.raw.directory
			: dirname(collection.raw.directory);
		if (!(await persistence.host.exists(watchRoot))) continue;
		const stop = await persistence.host.watchDir(watchRoot, (event) => {
			if (!touchesWatchedDirectory(event.filename, collection.raw.directory!)) return;
			runBackgroundReload(persistence, async () => {
				const rows = await loadLegacyCollectionRows(
					collection,
					persistence.host,
					persistence.layer,
				);
				if (await reloadCollectionIfChanged(runtime, collection.name, rows)) {
					updateDirectoryBaseline(persistence, collection, rows);
				}
			});
		});
		trackWatcherStop(persistence, stop);
	}
}

async function registerSourceWatchers(runtime: EngineRuntime, persistence: PersistenceState) {
	const sourceState = persistence.sourceState;
	if (!sourceState) return;
	for (const source of sourceState.normalizedConfig.sources) {
		if (source.kind === "documents") {
			const stop = await persistence.host.watchDir(source.root, () => {
				runBackgroundReload(persistence, async () => {
					const loaded = await Effect.runPromise(
						Effect.provide(loadDocumentSources(sourceState.normalizedConfig), persistence.layer),
					);
					sourceState.documentsState.origins = loaded.origins;
					sourceState.documentsState.documents = loaded.documents;
					for (const collection of source.collections) {
						const rows = [
							...(loaded.collections[collection]?.values() ?? []),
						] as ReadonlyArray<Record<string, unknown>>;
						await reloadCollectionIfChanged(runtime, collection, rows);
					}
				});
			});
			trackWatcherStop(persistence, stop);
			continue;
		}
		for (const root of source.roots) {
			const watchRoot = (await persistence.host.exists(root.root)) ? root.root : dirname(root.root);
			if (!(await persistence.host.exists(watchRoot))) continue;
			const stop = await persistence.host.watchDir(watchRoot, () => {
				runBackgroundReload(persistence, async () => {
					const loaded = await Effect.runPromise(
						Effect.provide(loadDocumentGraphSources(sourceState.normalizedConfig), persistence.layer),
					);
					sourceState.graphState.provenance = loaded.provenance;
					sourceState.graphState.diagnostics = loaded.diagnostics;
					for (const collection of source.collections) {
						const rows = [
							...(loaded.collections[collection]?.values() ?? []),
						] as ReadonlyArray<Record<string, unknown>>;
						await reloadCollectionIfChanged(runtime, collection, rows);
					}
				});
			});
			trackWatcherStop(persistence, stop);
		}
	}
}

async function registerExternalReloadWatchers(
	runtime: EngineRuntime,
	persistence: PersistenceState,
) {
	await registerLegacyWatchers(runtime, persistence);
	await registerSourceWatchers(runtime, persistence);
}

function transactionBeginError(reason: "nested transactions not supported" | "another transaction is already active") {
	return new TransactionError({
		operation: "begin",
		reason,
		message: `Cannot begin transaction: ${reason}`,
	});
}

function explicitRollbackError() {
	return new TransactionError({
		operation: "rollback",
		reason: "explicit rollback",
		message: "Transaction rolled back explicitly",
	});
}

async function runTransaction<A>(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	persistence: PersistenceState | undefined,
	fn: (ctx: EngineTransactionDatabase<any>) => Promise<A>,
	transactionGate: TransactionGate,
): Promise<A> {
	if (transactionGate.active) {
		throw transactionBeginError(
			transactionGate.context.getStore() === true
				? "nested transactions not supported"
				: "another transaction is already active",
		);
	}
	transactionGate.active = true;
	let txRuntime: EngineRuntime | undefined;
	try {
		return await transactionGate.context.run(true, async () => {
			txRuntime = await runtime.createTemporaryTransactionRuntime();
			const operations: Array<Record<string, unknown>> = [];
			const rollbackError = explicitRollbackError();
			const txFacade = buildTransactionDatabaseFacade(txRuntime, collections, persistence, operations, rollbackError);
			const result = await fn(txFacade as EngineTransactionDatabase<any>);
			const snapshot = await txRuntime.invoke<Record<string, ReadonlyArray<Record<string, unknown>>>>(
				"dumpAll",
			);
			const committed = await runtime.invoke<{ changedCollections: ReadonlyArray<string> }>(
				"commitSnapshotTransaction",
				{ collections: snapshot },
			);
			for (const collection of committed.changedCollections) {
				const key = persistence?.writeKeyByCollection.get(collection);
				if (key) persistence?.saver.schedule(key);
			}
			return result;
		});
	} finally {
		try {
			await txRuntime?.drop();
		} catch {
			// best-effort temporary runtime cleanup
		} finally {
			transactionGate.active = false;
		}
	}
}

function buildTransactionDatabaseFacade(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	persistence: PersistenceState | undefined,
	operations: Array<Record<string, unknown>>,
	rollbackError: TransactionError,
) {
	const db: Record<string, unknown> = {};
	for (const collection of collections) {
		db[collection.name] = buildTransactionCollectionFacade(runtime, collection, persistence, operations);
	}
	return Object.assign(db, {
		rollback: async () => {
			throw rollbackError;
		},
	});
}

function buildTransactionCollectionFacade(
	runtime: EngineRuntime,
	collection: CollectionRuntimeConfig,
	persistence: PersistenceState | undefined,
	operations: Array<Record<string, unknown>>,
) {
	const ensureWritable = (operation: string) => {
		if (persistence?.sourceState?.readOnlyCollections.has(collection.name)) {
			throw new OperationError({
				operation,
				reason: "read-only-source",
				message: `Operation '${operation}' is not allowed on read-only collection '${collection.name}' (backed by a documentGraph source)`,
			});
		}
	};
	const push = (operation: Record<string, unknown>) => operations.push(operation);
	return {
		query: (config?: any) =>
			config?.cursor
				? (validateCursorConfig(config.cursor), runtime.invoke("queryCursor", {
						collection: collection.name,
						query: {
							where: config.where,
							sort: config.sort,
							offset: config.offset,
							limit: config.limit,
							select: config.select,
						},
						cursor: config.cursor,
						populate: config.populate,
					}))
				: runtime.invoke("query", {
						collection: collection.name,
						query: {
							where: config?.where,
							sort: config?.sort,
							offset: config?.offset,
							limit: config?.limit,
							select: config?.select,
						},
						populate: config?.populate,
					}),
		aggregate: (config: any) =>
			runtime.invoke("aggregate", {
				collection: collection.name,
				where: config.where,
				config: {
					count: config.count ?? false,
					sum: normalizeAggregateFields(config.sum),
					avg: normalizeAggregateFields(config.avg),
					min: normalizeAggregateFields(config.min),
					max: normalizeAggregateFields(config.max),
					groupBy: config.groupBy,
				},
			}),
		findById: async (id: string) => {
			const rows = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			if (rows.length === 0) {
				throw new NotFoundError({
					collection: collection.name,
					id,
					message: `Entity with id "${id}" not found in collection "${collection.name}"`,
				});
			}
			return rows[0];
		},
		exists: async (id: string) => {
			const rows = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			return rows.length > 0;
		},
		create: async (input: any) => {
			ensureWritable("create");
			const value = await runtime.invoke<any>("create", { collection: collection.name, data: input });
			push({ kind: "create", collection: collection.name, data: input });
			return value;
		},
		createMany: async (inputs: ReadonlyArray<any>, options?: any) => {
			ensureWritable("createMany");
			const items = [...inputs];
			const value = await runtime.invoke<any>("createMany", { collection: collection.name, items, skipDuplicates: options?.skipDuplicates ?? false });
			push({ kind: "createMany", collection: collection.name, items, skipDuplicates: options?.skipDuplicates ?? false });
			return value;
		},
		update: async (id: string, data: any) => {
			ensureWritable("update");
			const value = await runtime.invoke<any>("update", { collection: collection.name, id, data });
			push({ kind: "update", collection: collection.name, id, data });
			return value;
		},
		updateMany: async (where: any, data: any) => {
			ensureWritable("updateMany");
			const value = await runtime.invoke<any>("updateMany", { collection: collection.name, where, data });
			push({ kind: "updateMany", collection: collection.name, where, data });
			return value;
		},
		delete: async (id: string, options?: any) => {
			ensureWritable("delete");
			if (options?.soft) {
				const value = await runtime.invoke<any>("deleteMany", {
					collection: collection.name,
					where: { id },
					soft: true,
					limit: 1,
				});
				if (!value.deleted?.[0]) {
					throw new NotFoundError({ collection: collection.name, id, message: `Entity with id "${id}" not found in collection "${collection.name}"` });
				}
				push({ kind: "deleteMany", collection: collection.name, where: { id }, soft: true, limit: 1 });
				return value.deleted[0];
			}
			const value = await runtime.invoke<any>("delete", { collection: collection.name, id });
			push({ kind: "delete", collection: collection.name, id });
			return value;
		},
		deleteMany: async (where: any, options?: any) => {
			ensureWritable("deleteMany");
			const value = await runtime.invoke<any>("deleteMany", { collection: collection.name, where, soft: options?.soft ?? false, limit: options?.limit });
			push({ kind: "deleteMany", collection: collection.name, where, soft: options?.soft ?? false, limit: options?.limit });
			return value;
		},
		upsert: async (input: any) => {
			ensureWritable("upsert");
			const value = await runtime.invoke<any>("upsert", { collection: collection.name, where: input.where, create: input.create, update: input.update });
			push({ kind: "upsert", collection: collection.name, where: input.where, create: input.create, update: input.update });
			return value;
		},
		upsertMany: async (inputs: ReadonlyArray<any>) => {
			ensureWritable("upsertMany");
			const items = [...inputs];
			const value = await runtime.invoke<any>("upsertMany", { collection: collection.name, items });
			push({ kind: "upsertMany", collection: collection.name, items });
			return value;
		},
		createWithRelationships: async (data: any) => {
			ensureWritable("createWithRelationships");
			const value = await runtime.invoke<any>("createWithRelationships", { collection: collection.name, data });
			push({ kind: "createWithRelationships", collection: collection.name, data });
			return value;
		},
		updateWithRelationships: async (id: string, data: any) => {
			ensureWritable("updateWithRelationships");
			const value = await runtime.invoke<any>("updateWithRelationships", { collection: collection.name, id, data });
			push({ kind: "updateWithRelationships", collection: collection.name, id, data });
			return value;
		},
		deleteWithRelationships: async (id: string, options?: any) => {
			ensureWritable("deleteWithRelationships");
			const value = await runtime.invoke<any>("deleteWithRelationships", { collection: collection.name, id, options });
			push({ kind: "deleteWithRelationships", collection: collection.name, id, options });
			return value;
		},
		deleteManyWithRelationships: async (where: any, options?: any) => {
			ensureWritable("deleteManyWithRelationships");
			const value = await runtime.invoke<any>("deleteManyWithRelationships", { collection: collection.name, where, options });
			push({ kind: "deleteManyWithRelationships", collection: collection.name, where, options });
			return value;
		},
		watch: (_config?: any) => {
			throw new OperationError({ operation: "watch", reason: "unsupported-in-transaction", message: "watch() is not supported inside $transaction callbacks" });
		},
		watchById: (_id: string) => {
			throw new OperationError({ operation: "watchById", reason: "unsupported-in-transaction", message: "watchById() is not supported inside $transaction callbacks" });
		},
	};
}

async function runDryRunMigrations(
	config: DatabaseConfig,
	_host: NodeEngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<DryRunResult> {
	return Effect.runPromise(
		Effect.provide(dryRunMigrations(config, {} as never), layer),
	);
}

function buildSharedFileGroups(collections: ReadonlyArray<CollectionRuntimeConfig>) {
	const byFile = new Map<string, CollectionRuntimeConfig[]>();
	for (const collection of collections) {
		if (!collection.raw.file) continue;
		if (collection.raw.path) continue;
		const group = byFile.get(collection.raw.file) ?? [];
		group.push(collection);
		byFile.set(collection.raw.file, group);
	}
	return [...byFile.entries()]
		.filter(([, grouped]) => grouped.length > 1)
		.map(([file, grouped]) => ({ file, collections: grouped }));
}

function toEntityMap(values: ReadonlyArray<Record<string, unknown>>) {
	const map = new Map<string, Record<string, unknown>>();
	for (const value of values) {
		const id = value.id;
		if (typeof id === "string") map.set(id, value);
	}
	return map;
}

function normalizeInitialCollection(value: unknown): ReadonlyArray<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function normalizeAggregateFields(value: unknown): ReadonlyArray<string> {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value.filter((field): field is string => typeof field === "string");
	return typeof value === "string" ? [value] : [];
}

function wrapCallbackResult(fn: () => unknown): string {
	try {
		const value = fn();
		if (isPromiseLike(value)) {
			return JSON.stringify({
				kind: "error",
				error: new OperationError({
					operation: "callback",
					reason: "async-effect-unsupported",
					message:
						"Async Effect callbacks are not supported by @proseql/engine's synchronous WASM callback boundary. Use synchronous callbacks here; async orchestration is deferred to the U9 Effect adapter.",
				}),
			});
		}
		return JSON.stringify({ kind: "ok", value });
	} catch (error) {
		if (isAsyncCallbackUnsupportedError(error)) {
			return JSON.stringify({
				kind: "error",
				error: new OperationError({
					operation: "callback",
					reason: "async-effect-unsupported",
					message:
						"Async Effect callbacks are not supported by @proseql/engine's synchronous WASM callback boundary. Use synchronous callbacks here; async orchestration is deferred to the U9 Effect adapter.",
				}),
			});
		}
		if (isTaggedError(error)) {
			return JSON.stringify({ kind: "error", error });
		}
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ kind: "defect", message });
	}
}

function isTaggedError(error: unknown): error is { readonly _tag: string } & Record<string, unknown> {
	return typeof error === "object" && error !== null && "_tag" in error && typeof (error as { _tag: unknown })._tag === "string";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}

function isAsyncCallbackUnsupportedError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Async Effect callbacks are not supported by @proseql/engine");
}

function promiseCall<T>(fn: () => Promise<T>): Promise<T> {
	return Promise.resolve().then(fn);
}

function parseBridgeResponse<T>(raw: string): T {
	const parsed = JSON.parse(raw) as BridgeResponse<T>;
	switch (parsed.kind) {
		case "ok":
			return parsed.value;
		case "error":
			throw reconstructBoundaryError(parsed.error);
		case "defect":
			throw new WasmEngineDefectError(parsed.message);
		default:
			throw new Error(`Unknown bridge response: ${raw}`);
	}
}
