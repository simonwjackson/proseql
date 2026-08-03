import {
	type CollectionConfig,
	CollectionNotFoundError,
	type DatabaseConfig,
	type DocumentGraphDiagnostic,
	type DocumentGraphRecordProvenance,
	type DryRunResult,
	dryRunMigrations,
	getCollectionConfigs,
	inferCodecsFromConfig,
	isSourceOrientedDatabaseConfig,
	loadCollectionsFromFile,
	loadData,
	loadDataFromDirectory,
	loadDocumentGraphSources,
	loadDocumentSources,
	type Migration,
	makeSerializerLayer,
	mergeSerializerWithPluginCodecs,
	type NormalizedSourceConfig,
	NotFoundError,
	normalizeSourceConfig,
	OperationError,
	PluginError,
	type PluginRegistry,
	removeEntityFromDirectory,
	SerializerRegistryService,
	type SerializerRegistryShape,
	SourceConfigError,
	StorageAdapterService as StorageAdapter,
	saveCollectionsToFile,
	saveData,
	saveDocumentSource,
	saveEntityToDirectory,
	TransactionError,
	ValidationError,
} from "@proseql/core";
import { Effect, Layer, Schema } from "effect";
import {
	decodeBoundaryValueForHost,
	encodeBoundaryValueForWire,
	parseBoundaryJson,
	serializeBoundaryValue,
} from "./boundary-values.js";
import { reconstructBoundaryError, WasmEngineDefectError } from "./errors.js";
import { loadWasmBindings, type WasmRuntimeBinding } from "./loader.js";
import {
	isCompactMaterializedResultDescriptor,
	isMaterializedResultDescriptor,
	MaterializedProjection,
	type ProjectionHandles,
	type ProjectionSync,
	projectionSnapshotFromHandles,
	StaleMaterializedHandleError,
} from "./materialized-projection.js";
import {
	dirnameComparable,
	isWithinComparableDirectory,
	matchesComparableFile,
} from "./path-utils.js";
import { buildPluginRegistry } from "./plugin-registry.js";
import {
	type CallbackRegistrar,
	compileDatabaseDescriptor,
} from "./schema-compiler.js";
import {
	type EngineStorageHost,
	makeEngineStorageLayer,
	toEngineStorageError,
} from "./storage-host-shared.js";
import type {
	EngineCollection,
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	EngineTransactionDatabase,
	EngineWatchConfig,
	GenerateEngineDatabase,
	GenerateEngineDatabaseWithPersistence,
	WatchSubscription,
} from "./types.js";

const DEFAULT_WRITE_DEBOUNCE = 100;
const OBJECT_KEYED_ONLY_FORMATS = new Set([
	"json",
	"yaml",
	"yml",
	"toml",
	"json5",
	"jsonc",
	"hjson",
	"toon",
]);

type BridgeOk<T> = { kind: "ok"; value: T };
type BridgeError = { kind: "error"; error: unknown };
type BridgeDefect = { kind: "defect"; message: string };
type BridgeResponse<T> = (BridgeOk<T> | BridgeError | BridgeDefect) & {
	readonly projection?: ProjectionSync;
};

type CollectionRuntimeConfig = {
	readonly name: string;
	readonly schema: Schema.Top;
	readonly raw: CollectionConfig;
};

type SharedFileGroup = {
	readonly file: string;
	readonly collections: ReadonlyArray<CollectionRuntimeConfig>;
};

function inferCollectionFormat(
	collection: CollectionConfig,
): string | undefined {
	const explicit = collection.format?.replace(/^\./, "").toLowerCase();
	if (explicit) return explicit;
	const file = collection.file ?? collection.directory;
	if (!file) return undefined;
	const match = /\.([^./]+)$/.exec(file);
	return match?.[1]?.toLowerCase();
}

function validateCollectionRuntimeConfig(
	name: string,
	collection: CollectionConfig,
	pluginRegistry?: PluginRegistry,
) {
	if (collection.id?.kind === "derivedFromKey") {
		if (collection.id.field !== "id") {
			throw new ValidationError({
				message: `Collection '${name}' derived id field must be 'id'`,
				issues: [
					{
						field: `${name}.id.field`,
						message: "derived id field must be 'id'",
					},
				],
			});
		}
		const format = inferCollectionFormat(collection);
		if (format !== undefined && !OBJECT_KEYED_ONLY_FORMATS.has(format)) {
			throw new ValidationError({
				message: `Collection '${name}' uses derived ids and therefore requires an object-keyed format; '${format}' is array-backed`,
				issues: [
					{
						field: `${name}.file`,
						message: "derived ids require an object-keyed format",
					},
				],
			});
		}
	}
	if (
		collection.idGenerator &&
		pluginRegistry &&
		!pluginRegistry.idGenerators.has(collection.idGenerator)
	) {
		throw new PluginError({
			plugin: collection.idGenerator,
			reason: "missing_id_generator",
			message: `Collection '${name}' references idGenerator '${collection.idGenerator}' but it is not registered`,
		});
	}
}

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
	readonly baselines: Record<string, ReadonlyArray<Record<string, unknown>>>;
	readonly sourceState?: SourcePersistenceState;
};

type PersistenceLifecycle = {
	status: "open" | "closing" | "closed";
	closePromise?: Promise<void>;
};

type PersistenceMirrorState =
	| {
			readonly _tag: "valid";
			readonly rows: Map<string, Record<string, unknown>>;
	  }
	| {
			readonly _tag: "canonicalRequired";
			readonly reason: string;
	  };

type PersistenceState = {
	host: EngineStorageHost;
	readonly layer: Layer.Layer<any>;
	readonly serializerRegistry?: SerializerRegistryShape;
	readonly persistObjectFile?: (
		path: string,
		data: unknown,
		format: string,
	) => Promise<void>;
	readonly collectionMirrors: Map<string, PersistenceMirrorState>;
	readonly mirrorEligibleCollections: ReadonlySet<string>;
	readonly collections: ReadonlyArray<CollectionRuntimeConfig>;
	readonly sharedFiles: ReadonlyArray<SharedFileGroup>;
	readonly directoryIds: Map<string, Set<string>>;
	readonly writeKeyByCollection: Map<string, string>;
	readonly collectionBaselines: Map<
		string,
		ReadonlyMap<string, Record<string, unknown>>
	>;
	readonly dirtyCollections: Set<string>;
	readonly collectionsAwaitingExternalMerge: Set<string>;
	readonly saver: DebouncedSaver;
	readonly sourceState?: SourcePersistenceState;
	readonly watcherStops: Array<() => void>;
	readonly backgroundReloads: Set<Promise<void>>;
	readonly lifecycle: PersistenceLifecycle;
	backgroundError?: unknown;
};

type TransactionContext = {
	getStore(): true | undefined;
	run<T>(value: true, fn: () => Promise<T>): Promise<T>;
};

type TransactionGate = {
	active: boolean;
	depth: number;
	readonly context?: TransactionContext;
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
			.filter(
				([, lane]) =>
					lane.timer || lane.dirty || lane.inflight || lane.error !== undefined,
			)
			.map(([key]) => key);
		for (const key of keys) {
			const lane = this.lanes.get(key);
			if (lane?.timer) {
				clearTimeout(lane.timer);
				lane.timer = undefined;
			}
		}
		await Promise.all(keys.map((key) => this.flushLane(key)));
		const firstError = [...this.lanes.values()].find(
			(lane) => lane.error !== undefined,
		)?.error;
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

	private async startSave(
		key: string,
		lane: SaveLane,
		immediateRetry: boolean,
	): Promise<void> {
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
		this.runtime.register_default(id, () => serializeBoundaryValue(callback()));
		return id;
	}

	registerComputed(
		callback: (entity: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_computed(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerBeforeCreateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_create_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerBeforeUpdateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_update_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerBeforeDeleteHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_before_delete_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerAfterCreateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_create_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerAfterUpdateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_update_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerAfterDeleteHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_after_delete_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerOnChangeHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_on_change_hook(id, (payloadJson) =>
			wrapCallbackResult(() => callback(parseBoundaryJson(payloadJson))),
		);
		return id;
	}

	registerMigration(
		callback: (data: Record<string, unknown>) => Record<string, unknown>,
		prefix: string,
	): string {
		const id = this.makeId(prefix);
		this.runtime.register_migration(id, (payloadJson) => {
			const payload = parseBoundaryJson(payloadJson) as Record<string, unknown>;
			return serializeBoundaryValue(callback(payload));
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
			(fieldJson, operandJson) =>
				evaluate(parseBoundaryJson(fieldJson), parseBoundaryJson(operandJson)),
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

const cloneFailureValue = (
	value: unknown,
	seen: Map<object, unknown> = new Map(),
): unknown => {
	if (
		(typeof value !== "object" && typeof value !== "function") ||
		value === null
	) {
		return value;
	}
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	const clone: object = Array.isArray(value)
		? []
		: Object.create(Object.getPrototypeOf(value));
	seen.set(value, clone);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) continue;
		Object.defineProperty(
			clone,
			key,
			"value" in descriptor
				? { ...descriptor, value: cloneFailureValue(descriptor.value, seen) }
				: descriptor,
		);
	}
	return clone;
};

const captureTerminalFailure = (error: unknown): (() => unknown) => {
	const snapshot = cloneFailureValue(error);
	return () => cloneFailureValue(snapshot);
};

class AsyncQueue<T> implements WatchSubscription<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<{
		readonly resolve: (value: IteratorResult<T>) => void;
		readonly reject: (error: unknown) => void;
	}> = [];
	private active = true;
	private terminalFailure: (() => unknown) | undefined;
	private unsubscribePromise: Promise<void> | undefined;

	constructor(private readonly stop: () => Promise<void>) {}

	push(value: T) {
		if (!this.active) return;
		const next = this.waiters.shift();
		if (next) next.resolve({ value, done: false });
		else this.values.push(value);
	}

	fail(error: unknown) {
		if (!this.active) return;
		this.active = false;
		this.terminalFailure = captureTerminalFailure(error);
		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(this.terminalFailure());
		}
		this.unsubscribePromise = Promise.resolve()
			.then(() => this.stop())
			.catch(() => undefined);
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0) {
			return Promise.resolve({ value: this.values.shift() as T, done: false });
		}
		if (this.terminalFailure !== undefined) {
			return Promise.reject(this.terminalFailure());
		}
		if (!this.active) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise((resolve, reject) =>
			this.waiters.push({ resolve, reject }),
		);
	}

	async return(): Promise<IteratorResult<T>> {
		await this.unsubscribe();
		return { value: undefined, done: true };
	}

	unsubscribe(): Promise<void> {
		if (!this.unsubscribePromise) {
			this.active = false;
			for (const waiter of this.waiters.splice(0)) {
				waiter.resolve({ value: undefined, done: true });
			}
			this.values.length = 0;
			this.unsubscribePromise = this.stop();
		}
		return this.unsubscribePromise;
	}
}

const shouldProjectRead = (method: string, prepared: unknown) => {
	if (method === "findById") return true;
	if (method !== "query" || typeof prepared !== "object" || prepared === null)
		return false;
	const command = prepared as {
		readonly query?: { readonly select?: unknown; readonly where?: unknown };
		readonly populate?: unknown;
	};
	const where = command.query?.where;
	const hasTopLevelSearch =
		typeof where === "object" &&
		where !== null &&
		Object.hasOwn(where, "$search");
	return command.query?.select === undefined && !hasTopLevelSearch;
};
const matchesDeletionResultMethod = (method: string) =>
	method === "delete" ||
	method === "deleteMany" ||
	method === "deleteWithRelationships" ||
	method === "deleteManyWithRelationships";

const FAST_FIND_TOKEN_RADIX = 2 ** 21;
const fastFindAuthorizationToken = (
	collectionIndex: number,
	authorizationBase: number,
): number =>
	collectionIndex < 1024 && authorizationBase >= 0
		? collectionIndex * FAST_FIND_TOKEN_RADIX * FAST_FIND_TOKEN_RADIX +
			authorizationBase
		: -1;

const nativePrimitivePatch = (
	value: unknown,
): value is Readonly<Record<string, string | number | boolean | null>> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.keys(value).length > 0 &&
	Object.entries(value).every(
		([field, entry]) =>
			field !== "id" &&
			field !== "createdAt" &&
			field !== "updatedAt" &&
			(entry === null ||
				typeof entry === "string" ||
				typeof entry === "boolean" ||
				(typeof entry === "number" &&
					Number.isFinite(entry) &&
					!Object.is(entry, -0))),
	);

const inheritedPropertyDescriptor = (
	value: object,
	field: string,
): PropertyDescriptor | undefined => {
	let prototype = Object.getPrototypeOf(value);
	while (prototype !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, field);
		if (descriptor !== undefined) return descriptor;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
};

const canApplyNativePatch = (
	row: unknown,
	patch: Readonly<Record<string, unknown>>,
) => {
	if (typeof row !== "object" || row === null) return false;
	try {
		for (const field of Object.keys(patch)) {
			const descriptor = Object.getOwnPropertyDescriptor(row, field);
			if (descriptor === undefined) {
				if (
					!Object.isExtensible(row) ||
					inheritedPropertyDescriptor(row, field) !== undefined
				)
					return false;
				continue;
			}
			if (!Object.hasOwn(descriptor, "value") || descriptor.writable !== true)
				return false;
		}
		return true;
	} catch {
		// Proxy reflection or prototype traversal can itself be observable/throwing.
		// The canonical Object.assign path owns those semantics before any Rust write.
		return false;
	}
};

const identityDecodedSchema = (schema: unknown): boolean => {
	if (typeof schema !== "object" || schema === null) return false;
	const node = schema as {
		readonly kind?: unknown;
		readonly fields?: unknown;
		readonly inner?: unknown;
	};
	switch (node.kind) {
		case "str":
		case "num":
		case "bool":
		case "literal":
		case "literalUnion":
			return true;
		case "nullOr":
			return identityDecodedSchema(node.inner);
		case "optional":
			// Explicit `undefined` can be stripped or retained by the decoder; the
			// source-object reconstruction cannot prove identical ownership.
			return false;
		case "struct":
			return (
				Array.isArray(node.fields) &&
				node.fields.every(
					(field) =>
						typeof field === "object" &&
						field !== null &&
						identityDecodedSchema(
							(field as { readonly schema?: unknown }).schema,
						),
				)
			);
		default:
			// Coercions, defaults, arrays/records, unknown values, and future schema
			// nodes can change either decoded values or nested object identity.
			return false;
	}
};

const isDirectWireScalar = (value: unknown): boolean =>
	value === null ||
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" &&
		Number.isFinite(value) &&
		!Object.is(value, -0));

const compactIdentitySource = (
	value: unknown,
	fields: ReadonlySet<string> | undefined,
): value is Record<string, unknown> => {
	if (
		fields === undefined ||
		typeof value !== "object" ||
		value === null ||
		typeof Reflect.get(value, "id") !== "string" ||
		!Object.hasOwn(value, "id")
	)
		return false;
	return Reflect.ownKeys(value).every((field) => {
		if (typeof field !== "string" || !fields.has(field)) return false;
		const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
		return (
			descriptor !== undefined &&
			descriptor.enumerable === true &&
			"value" in descriptor &&
			isDirectWireScalar(descriptor.value)
		);
	});
};

const nativeBulkWhere = (where: unknown) => {
	if (typeof where !== "object" || where === null || Array.isArray(where))
		return undefined;
	const entries = Object.entries(where);
	if (entries.length !== 1) return undefined;
	const [field, operand] = entries[0]!;
	if (
		operand === null ||
		typeof operand === "string" ||
		typeof operand === "boolean" ||
		(typeof operand === "number" && Number.isFinite(operand))
	)
		return { field, ids: undefined };
	if (field !== "id" || typeof operand !== "object" || Array.isArray(operand))
		return undefined;
	const operators = Object.entries(operand as Record<string, unknown>);
	if (operators.length !== 1 || operators[0]?.[0] !== "$in") return undefined;
	const values = operators[0][1];
	return Array.isArray(values) && values.every((id) => typeof id === "string")
		? { field, ids: values as ReadonlyArray<string> }
		: undefined;
};

const PREDICATE_BULK_OPERATION = Symbol.for(
	"@proseql/engine/predicate-bulk-operation",
);

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
	"transaction",
	"reloadCollection",
	"commitSnapshotTransaction",
]);

type RuntimeTransactionSession = {
	readonly handle: number;
	readonly projection: MaterializedProjection;
};

type EngineRuntimeDiagnostics = {
	bulkMutationDispatches: number;
	queryDispatches: number;
	queryWasmCrossingMilliseconds: number;
	queryMaterializationMilliseconds: number;
	queryCommandProxyBytes: number;
	queryResponseProxyBytes: number;
	transactionBegins: number;
	transactionSteps: number;
	transactionCommits: number;
	transactionRollbacks: number;
	transactionSnapshotTransfers: number;
	temporaryTransactionRuntimes: number;
};

class EngineRuntime {
	readonly runtime: WasmRuntimeBinding;
	readonly handle: number;
	readonly createInput: { descriptor: Record<string, unknown> };
	private readonly projection: MaterializedProjection;
	private readonly collectionIndexes: ReadonlyMap<string, number>;
	private readonly canonicalQueryCollections: ReadonlySet<string>;
	private readonly compactCreateManyFields: ReadonlyMap<
		string,
		ReadonlySet<string>
	>;
	private readonly callbackFreeSortFields: ReadonlyMap<
		string,
		ReadonlySet<string>
	>;
	private readonly diagnostics: EngineRuntimeDiagnostics;

	private hotBulkIds:
		| {
				readonly collection: string;
				readonly key: string;
				readonly field: string;
				readonly ids: ReadonlyArray<string>;
		  }
		| undefined;
	private hotDeleteBulkIds:
		| {
				readonly collection: string;
				readonly key: string;
				readonly ids: ReadonlyArray<string>;
		  }
		| undefined;
	private hotIndexedQuery:
		| {
				readonly collectionIndex: number;
				readonly key: string;
				readonly revision: number;
				readonly commandBytes: number;
				readonly projected: boolean | "sort" | "selected-sort";
				readonly rows: ReadonlyArray<unknown>;
		  }
		| undefined;
	private fastFindAuthorizationWarmed = false;
	private strongStructureLeaseGeneration = 0;
	private strongStructureReleaseTimer:
		| ReturnType<typeof setTimeout>
		| undefined;
	private transactionBarrier: Promise<void> | undefined;
	private releaseTransactionBarrier: (() => void) | undefined;
	private transactionContext: TransactionContext | undefined;
	private projectionSynchronizationListener:
		| ((collections: ReadonlySet<string>) => void)
		| undefined;

	private constructor(
		runtime: WasmRuntimeBinding,
		handle: number,
		createInput: { descriptor: Record<string, unknown> },
		projection: MaterializedProjection,
		diagnostics: EngineRuntimeDiagnostics = {
			bulkMutationDispatches: 0,
			queryDispatches: 0,
			queryWasmCrossingMilliseconds: 0,
			queryMaterializationMilliseconds: 0,
			queryCommandProxyBytes: 0,
			queryResponseProxyBytes: 0,
			transactionBegins: 0,
			transactionSteps: 0,
			transactionCommits: 0,
			transactionRollbacks: 0,
			transactionSnapshotTransfers: 0,
			temporaryTransactionRuntimes: 0,
		},
	) {
		this.runtime = runtime;
		this.handle = handle;
		this.createInput = createInput;
		this.projection = projection;
		this.diagnostics = diagnostics;
		const descriptors = Array.isArray(createInput.descriptor.collections)
			? createInput.descriptor.collections
			: [];
		this.collectionIndexes = new Map(
			descriptors.flatMap((descriptor, index) => {
				if (typeof descriptor !== "object" || descriptor === null) return [];
				const name = (descriptor as { readonly name?: unknown }).name;
				return typeof name === "string" ? [[name, index] as const] : [];
			}),
		);
		this.callbackFreeSortFields = new Map(
			descriptors.flatMap((descriptor) => {
				if (typeof descriptor !== "object" || descriptor === null) return [];
				const row = descriptor as {
					readonly name?: unknown;
					readonly schema?: { readonly fields?: unknown };
				};
				if (typeof row.name !== "string" || !Array.isArray(row.schema?.fields))
					return [];
				const fields = row.schema.fields.flatMap((field) => {
					if (typeof field !== "object" || field === null) return [];
					const value = field as {
						readonly name?: unknown;
						readonly schema?: { readonly kind?: unknown };
					};
					return typeof value.name === "string" &&
						(value.schema?.kind === "num" || value.schema?.kind === "bool")
						? [value.name]
						: [];
				});
				return [[row.name, new Set(fields)] as const];
			}),
		);
		this.compactCreateManyFields = new Map(
			descriptors.flatMap((descriptor) => {
				if (typeof descriptor !== "object" || descriptor === null) return [];
				const row = descriptor as {
					readonly name?: unknown;
					readonly schema?: {
						readonly kind?: unknown;
						readonly fields?: unknown;
					};
					readonly id_strategy?: { readonly kind?: unknown };
					readonly relationships?: unknown;
					readonly before_create_hooks?: unknown;
					readonly after_create_hooks?: unknown;
					readonly computed_fields?: unknown;
				};
				if (
					typeof row.name !== "string" ||
					row.schema?.kind !== "struct" ||
					!identityDecodedSchema(row.schema) ||
					row.id_strategy?.kind !== "provided" ||
					!Array.isArray(row.relationships) ||
					row.relationships.length > 0 ||
					!Array.isArray(row.before_create_hooks) ||
					row.before_create_hooks.length > 0 ||
					!Array.isArray(row.after_create_hooks) ||
					row.after_create_hooks.length > 0 ||
					!Array.isArray(row.computed_fields) ||
					row.computed_fields.length > 0 ||
					!Array.isArray(row.schema.fields)
				)
					return [];
				const fields = row.schema.fields.flatMap((field) => {
					const name = (field as { readonly name?: unknown }).name;
					return typeof name === "string" ? [name] : [];
				});
				return fields.length === row.schema.fields.length
					? [[row.name, new Set(fields)] as const]
					: [];
			}),
		);
		this.canonicalQueryCollections = new Set(
			descriptors.flatMap((descriptor) => {
				if (typeof descriptor !== "object" || descriptor === null) return [];
				const row = descriptor as {
					readonly name?: unknown;
					readonly computed_fields?: unknown;
				};
				return typeof row.name === "string" &&
					Array.isArray(row.computed_fields) &&
					row.computed_fields.length === 0
					? [row.name]
					: [];
			}),
		);
	}

	private authorizeFastFind(
		collectionIndex: number,
		candidate: {
			readonly rustSlot: number;
			readonly authorizationBase: number;
		},
	): number {
		return this.runtime.fast_find_by_id(
			this.handle,
			candidate.rustSlot,
			fastFindAuthorizationToken(collectionIndex, candidate.authorizationBase),
		);
	}

	private warmFastFindAuthorization(
		collectionIndex: number,
		candidate: {
			readonly rustSlot: number;
			readonly authorizationBase: number;
		},
	): void {
		if (this.fastFindAuthorizationWarmed) return;
		this.fastFindAuthorizationWarmed = true;
		for (let index = 0; index < 256; index += 1) {
			this.authorizeFastFind(collectionIndex, candidate);
		}
	}

	private throwPendingFastCallbackDefect(): void {
		const message = this.runtime.take_callback_defect();
		if (message !== undefined) {
			throw new WasmEngineDefectError(`unexpected defect: ${message}`);
		}
	}

	private measureQueryCrossing<T>(_command: unknown, operation: () => T): T {
		return operation();
	}

	private clearHotIndexedQuery() {
		this.hotIndexedQuery = undefined;
	}

	private clearHotBulkSelections() {
		this.hotBulkIds = undefined;
		this.hotDeleteBulkIds = undefined;
	}

	private touchStrongStructureLease() {
		this.strongStructureLeaseGeneration += 1;
	}

	private deferStrongStructureRelease() {
		if (this.strongStructureReleaseTimer !== undefined) {
			clearTimeout(this.strongStructureReleaseTimer);
		}
		const generation = this.strongStructureLeaseGeneration;
		this.strongStructureReleaseTimer = setTimeout(() => {
			this.strongStructureReleaseTimer = undefined;
			if (this.strongStructureLeaseGeneration === generation) {
				this.clearStrongStructuresImmediately();
			}
		}, 0);
	}

	private clearStrongStructuresImmediately() {
		this.strongStructureLeaseGeneration += 1;
		if (this.strongStructureReleaseTimer !== undefined) {
			clearTimeout(this.strongStructureReleaseTimer);
			this.strongStructureReleaseTimer = undefined;
		}
		this.clearHotIndexedQuery();
		this.clearHotBulkSelections();
		this.projection.releaseAllStrongStructures();
	}

	private invalidateProjection() {
		this.clearStrongStructuresImmediately();
		this.projection.invalidate();
	}

	private authorizeCachedQuery(_commandBytes: number, operation: () => number) {
		return operation();
	}

	private measureQueryMaterialization<T>(operation: () => T): T {
		return operation();
	}

	private materializeFastSlots<T>(
		collection: string,
		slots: Uint32Array,
	): ReadonlyArray<T> | undefined {
		try {
			return this.measureQueryMaterialization(() =>
				this.projection.materializeRustSlots<T>(collection, slots),
			);
		} catch (error) {
			if (!(error instanceof StaleMaterializedHandleError)) throw error;
			this.resynchronizeProjection();
			return undefined;
		}
	}

	private tryAuthorizedBulk<T>(
		method: string,
		prepared: unknown,
	): { readonly hit: false } | { readonly hit: true; readonly value: T } {
		if (
			(method !== "updateMany" && method !== "deleteMany") ||
			typeof prepared !== "object" ||
			prepared === null
		)
			return { hit: false };
		const command = prepared as {
			readonly collection?: unknown;
			readonly where?: unknown;
			readonly data?: unknown;
			readonly soft?: unknown;
			readonly limit?: unknown;
		};
		if (
			typeof command.collection !== "string" ||
			!this.canonicalQueryCollections.has(command.collection) ||
			(method === "deleteMany" && command.soft === true) ||
			(method === "updateMany" && !nativePrimitivePatch(command.data))
		)
			return { hit: false };
		const where = nativeBulkWhere(command.where);
		const collectionIndex = this.collectionIndexes.get(command.collection);
		if (where === undefined || collectionIndex === undefined)
			return { hit: false };
		const limit =
			typeof command.limit === "number" && command.limit > 0
				? Math.trunc(command.limit)
				: undefined;
		const bulkKey =
			where.ids === undefined ? JSON.stringify(command.where) : "";
		let ids: ReadonlyArray<string> | undefined = where.ids;
		if (
			ids === undefined &&
			method === "updateMany" &&
			this.hotBulkIds?.collection === command.collection &&
			this.hotBulkIds.key === bulkKey &&
			!Object.hasOwn(command.data as object, this.hotBulkIds.field)
		) {
			ids = [...this.hotBulkIds.ids];
		}
		if (
			ids === undefined &&
			method === "deleteMany" &&
			this.hotDeleteBulkIds?.collection === command.collection &&
			this.hotDeleteBulkIds.key === bulkKey
		) {
			ids = [...this.hotDeleteBulkIds.ids];
		}
		if (limit !== undefined && ids !== undefined) ids = ids.slice(0, limit);
		let candidates =
			ids === undefined
				? undefined
				: this.projection.authorizedBulkCandidates(command.collection, ids);
		if (candidates === undefined) {
			const rows = this.dispatch<ReadonlyArray<Record<string, unknown>>>(
				"query",
				{
					collection: command.collection,
					query: {
						where: command.where,
						...(limit === undefined ? {} : { limit }),
					},
				},
			);
			ids = rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
			candidates = this.projection.authorizedBulkCandidates(
				command.collection,
				ids,
				rows,
			);
			if (
				method === "updateMany" &&
				where.ids === undefined &&
				!Object.hasOwn(command.data as object, where.field)
			) {
				this.hotBulkIds = {
					collection: command.collection,
					key: bulkKey,
					field: where.field,
					ids: [...ids],
				};
			} else if (method === "deleteMany" && where.ids === undefined) {
				this.hotDeleteBulkIds = {
					collection: command.collection,
					key: bulkKey,
					ids: [...ids],
				};
			}
		}
		if (
			candidates === undefined ||
			(method === "updateMany" &&
				candidates.rows.some(
					(row) =>
						!canApplyNativePatch(
							row.value,
							command.data as Readonly<Record<string, unknown>>,
						),
				))
		)
			return { hit: false };
		if (collectionIndex >= 1024) return { hit: false };
		const tokens = candidates.authorizationBases;
		const tokenOffset =
			collectionIndex * FAST_FIND_TOKEN_RADIX * FAST_FIND_TOKEN_RADIX;
		for (let index = 0; index < tokens.length; index += 1) {
			const authorizationBase = tokens[index]!;
			if (authorizationBase < 0) return { hit: false };
			tokens[index] = tokenOffset + authorizationBase;
		}
		const native =
			method === "updateMany"
				? this.runtime.authorized_bulk_update(
						this.handle,
						collectionIndex,
						candidates.slots,
						tokens,
						JSON.stringify(command.data),
					)
				: this.runtime.authorized_bulk_delete(
						this.handle,
						collectionIndex,
						candidates.slots,
						tokens,
						where.ids === undefined ? where.field : undefined,
						where.ids === undefined
							? JSON.stringify(
									(command.where as Record<string, unknown>)[where.field],
								)
							: undefined,
					);
		if (native === undefined) return { hit: false };
		if (typeof native === "string") {
			parseBridgeResponse(native);
			throw new Error("Authorized bulk mutation returned no native count");
		}
		if (
			typeof native !== "number" ||
			!Number.isSafeInteger(native) ||
			native < 0
		) {
			this.invalidateProjection();
			throw new Error("Authorized bulk mutation returned a malformed count");
		}
		const count = native % FAST_FIND_TOKEN_RADIX;
		const revision = Math.floor(native / FAST_FIND_TOKEN_RADIX);
		if (!Number.isSafeInteger(count) || !Number.isSafeInteger(revision)) {
			this.invalidateProjection();
			throw new Error("Authorized bulk mutation returned malformed completion");
		}
		this.clearHotIndexedQuery();
		this.diagnostics.bulkMutationDispatches += 1;
		try {
			const value =
				method === "updateMany"
					? this.projection.applyAuthorizedBulkUpdate(
							command.collection,
							candidates,
							count,
							revision,
							command.data as Readonly<Record<string, unknown>>,
						)
					: this.projection.applyAuthorizedBulkDelete(
							command.collection,
							candidates,
							ids!,
							count,
							revision,
						);
			this.projection.releaseAuthorizedBulkStructure(command.collection);
			if (method === "deleteMany" && count > 0) {
				this.clearHotBulkSelections();
			} else if (method === "updateMany") {
				// An identity-safe patch that leaves the equality field untouched keeps
				// the selected ids valid only for this event-loop lease. Rust still
				// revalidates every handle and revision before the next write.
				this.hotDeleteBulkIds = undefined;
			} else {
				this.hotBulkIds = undefined;
			}
			return { hit: true, value: value as T };
		} catch (error) {
			this.invalidateProjection();
			throw error;
		}
	}

	static async create(
		config: DatabaseConfig,
		initialData: EngineInitialData<DatabaseConfig> | undefined,
		options: EngineDatabaseOptions | undefined,
		registryOverride?: PluginRegistry,
	): Promise<{
		runtime: EngineRuntime;
		registry: PluginRegistry;
		collections: ReadonlyArray<CollectionRuntimeConfig>;
	}> {
		const registry =
			registryOverride ?? (await buildPluginRegistry(options?.plugins));
		const bindings = await loadWasmBindings();
		const runtime = new bindings.WasmRuntime(
			globalThis.setTimeout,
			globalThis.clearTimeout,
		);
		const registrar = new RuntimeCallbackRegistrar(runtime);
		const compiled = await compileDatabaseDescriptor(
			config,
			registry,
			registrar,
		);
		const collections = Object.entries(
			(config as any).collections ?? config,
		).map(([name, raw]) => ({
			name,
			schema: (raw as CollectionConfig).schema,
			raw: raw as CollectionConfig,
		}));
		const createPayload = {
			descriptor: compiled.descriptor as Record<string, unknown>,
			initialCollections: encodeBoundaryValueForWire(
				(initialData ?? {}) as Record<
					string,
					ReadonlyArray<Record<string, unknown>>
				>,
			) as Record<string, ReadonlyArray<Record<string, unknown>>>,
		};
		const handle = parseBridgeResponse<number>(
			runtime.create_database(JSON.stringify(createPayload)),
		);
		const handles = parseBridgeResponse<ProjectionHandles>(
			runtime.projection_handles(handle),
		);
		const engineRuntime = new EngineRuntime(
			runtime,
			handle,
			{ descriptor: createPayload.descriptor },
			new MaterializedProjection(projectionSnapshotFromHandles(handles)),
		);
		return { runtime: engineRuntime, registry, collections };
	}

	dispatch<T>(method: string, payload?: unknown): T {
		if (this.projection.needsResynchronization) this.resynchronizeProjection();
		if (this.projection.hasDirtyRows) this.synchronizeDirtyProjection();
		if (MUTATION_METHODS.has(method)) {
			this.clearHotIndexedQuery();
			if (method !== "updateMany") this.clearHotBulkSelections();
			else this.hotDeleteBulkIds = undefined;
		}
		let compactCreateSource: Record<string, unknown> | undefined;
		if (
			method === "create" &&
			typeof payload === "object" &&
			payload !== null &&
			"collection" in payload &&
			typeof payload.collection === "string" &&
			"data" in payload &&
			compactIdentitySource(
				payload.data,
				this.compactCreateManyFields.get(payload.collection),
			)
		) {
			compactCreateSource = payload.data;
		}
		let compactCreateManySource:
			| ReadonlyArray<Record<string, unknown>>
			| undefined;
		if (
			method === "createMany" &&
			typeof payload === "object" &&
			payload !== null &&
			"collection" in payload &&
			typeof payload.collection === "string" &&
			"items" in payload &&
			Array.isArray(payload.items) &&
			payload.items.length !== 1 &&
			!("skipDuplicates" in payload && payload.skipDuplicates === true)
		) {
			const fields = this.compactCreateManyFields.get(payload.collection);
			if (payload.items.every((item) => compactIdentitySource(item, fields))) {
				compactCreateManySource = payload.items as ReadonlyArray<
					Record<string, unknown>
				>;
			}
		}
		const prepared =
			compactCreateManySource === undefined && compactCreateSource === undefined
				? payload === undefined
					? undefined
					: prepareCommandPayload(method, payload)
				: payload;
		const authorizedBulk = this.tryAuthorizedBulk<T>(method, prepared);
		if (authorizedBulk.hit) return authorizedBulk.value;
		if (method === "updateMany" || method === "deleteMany") {
			this.clearHotBulkSelections();
		}
		if (
			method === "findById" &&
			typeof prepared === "object" &&
			prepared !== null
		) {
			const collection =
				"collection" in prepared ? prepared.collection : undefined;
			const id = "id" in prepared ? prepared.id : undefined;
			if (typeof collection === "string" && typeof id === "string") {
				const collectionIndex = this.collectionIndexes.get(collection);
				const candidate = this.projection.fastFindCandidate<T>(collection, id);
				let authorized = 0;
				if (collectionIndex !== undefined && candidate !== undefined) {
					try {
						authorized = this.authorizeFastFind(collectionIndex, candidate);
					} catch {
						// The canonical bridge below owns exact error and defect classification.
						authorized = 0;
					}
				}
				if (authorized === 1 && candidate !== undefined) {
					return this.projection.acceptAuthorizedFastFind(candidate);
				}
				this.projection.recordFastFindFallback();
			}
		}
		if (
			method === "query" &&
			typeof prepared === "object" &&
			prepared !== null
		) {
			const command = prepared as {
				readonly collection?: unknown;
				readonly query?: Record<string, unknown>;
				readonly populate?: unknown;
			};
			const query = command.query ?? {};
			const sortEntries = Array.isArray(query.sort) ? query.sort : [];
			const hasObservableSort = sortEntries.length > 0;
			const callbackFreeSort =
				hasObservableSort &&
				typeof command.collection === "string" &&
				sortEntries.every(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { readonly field?: unknown }).field === "string" &&
						this.callbackFreeSortFields
							.get(command.collection as string)
							?.has((entry as { readonly field: string }).field) === true,
				);
			const rawSelect = query.select;
			const selectedFields = Array.isArray(rawSelect)
				? [
						...new Set(
							rawSelect.filter(
								(field): field is string => typeof field === "string",
							),
						),
					]
				: undefined;
			if (
				selectedFields !== undefined &&
				selectedFields.length > 0 &&
				Array.isArray(rawSelect) &&
				selectedFields.length === rawSelect.length &&
				command.populate === undefined &&
				query.cursor === undefined &&
				typeof command.collection === "string"
			) {
				const collectionIndex = this.collectionIndexes.get(command.collection);
				const key = JSON.stringify(prepared);
				const cached = this.hotIndexedQuery;
				if (
					(!hasObservableSort || callbackFreeSort) &&
					collectionIndex !== undefined &&
					cached !== undefined &&
					(cached.projected === true || cached.projected === "selected-sort") &&
					cached.collectionIndex === collectionIndex &&
					cached.key === key &&
					this.authorizeCachedQuery(cached.commandBytes, () =>
						this.runtime.fast_index_query_revision(
							this.handle,
							collectionIndex,
							cached.revision,
						),
					) === 1
				) {
					return cached.rows.map((row) => ({
						...(row as Record<string, unknown>),
					})) as T;
				}
				const primitiveRows = this.measureQueryCrossing(prepared, () =>
					this.runtime.fast_selected_primitive_query(
						this.handle,
						JSON.stringify(prepared),
					),
				);
				this.throwPendingFastCallbackDefect();
				if (
					collectionIndex !== undefined &&
					Array.isArray(primitiveRows) &&
					typeof primitiveRows[0] === "number" &&
					primitiveRows.length === selectedFields.length + 1 &&
					primitiveRows.slice(1).every(Array.isArray)
				) {
					const revision = primitiveRows[0] as number;
					const columns = primitiveRows.slice(1).map((descriptor) => {
						if (descriptor[0] === "s") {
							const joined = descriptor[1] as string;
							const offsets = descriptor[2] as Uint32Array;
							const values = new Array<string>(offsets.length - 1);
							for (let index = 0; index < values.length; index += 1) {
								values[index] = joined.slice(
									offsets[index],
									offsets[index + 1],
								);
							}
							return values;
						}
						if (descriptor[0] === "b") {
							const bytes = descriptor[1] as Uint8Array;
							const values = new Array<boolean>(bytes.length);
							for (let index = 0; index < bytes.length; index += 1) {
								values[index] = bytes[index] !== 0;
							}
							return values;
						}
						return descriptor[1] as ArrayLike<unknown>;
					});
					const rowCount = columns[0]?.length ?? 0;
					const rows = new Array<Record<string, unknown>>(rowCount);
					const [field0, field1, field2, field3, field4] = selectedFields;
					const [column0, column1, column2, column3, column4] = columns;
					for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
						switch (selectedFields.length) {
							case 1:
								rows[rowIndex] = { [field0!]: column0![rowIndex] };
								break;
							case 2:
								rows[rowIndex] = {
									[field0!]: column0![rowIndex],
									[field1!]: column1![rowIndex],
								};
								break;
							case 3:
								rows[rowIndex] = {
									[field0!]: column0![rowIndex],
									[field1!]: column1![rowIndex],
									[field2!]: column2![rowIndex],
								};
								break;
							case 4:
								rows[rowIndex] = {
									[field0!]: column0![rowIndex],
									[field1!]: column1![rowIndex],
									[field2!]: column2![rowIndex],
									[field3!]: column3![rowIndex],
								};
								break;
							case 5:
								rows[rowIndex] = {
									[field0!]: column0![rowIndex],
									[field1!]: column1![rowIndex],
									[field2!]: column2![rowIndex],
									[field3!]: column3![rowIndex],
									[field4!]: column4![rowIndex],
								};
								break;
							default: {
								const row: Record<string, unknown> = {};
								for (
									let fieldIndex = 0;
									fieldIndex < selectedFields.length;
									fieldIndex += 1
								)
									row[selectedFields[fieldIndex]!] =
										columns[fieldIndex]![rowIndex];
								rows[rowIndex] = row;
							}
						}
					}
					selectionOrderApplied.add(rows);
					if (!hasObservableSort || callbackFreeSort) {
						const entry = {
							collectionIndex,
							key,
							revision,
							commandBytes: 0,
							projected: hasObservableSort ? ("selected-sort" as const) : true,
							rows,
						};
						this.hotIndexedQuery = entry;
						setTimeout(() => {
							if (this.hotIndexedQuery === entry)
								this.hotIndexedQuery = undefined;
						}, 0);
						return rows.map((row) => ({ ...row })) as T;
					}
					return rows as T;
				}
			}
			const scalarWhere =
				typeof query.where === "object" && query.where !== null
					? (query.where as Record<string, unknown>)
					: undefined;
			const scalarFields =
				scalarWhere === undefined ? [] : Object.keys(scalarWhere);
			if (
				scalarFields.length === 1 &&
				typeof scalarWhere![scalarFields[0]!] === "string" &&
				query.select === undefined &&
				query.sort === undefined &&
				query.cursor === undefined &&
				command.populate === undefined &&
				typeof command.collection === "string"
			) {
				const collectionIndex = this.collectionIndexes.get(command.collection);
				const offset =
					typeof query.offset === "number" && query.offset >= 0
						? Math.trunc(query.offset)
						: 0;
				const limit =
					typeof query.limit === "number" && query.limit >= 0
						? Math.min(Math.trunc(query.limit), 0xffff_ffff)
						: 0xffff_ffff;
				if (collectionIndex !== undefined) {
					const field = scalarFields[0]!;
					const value = scalarWhere![field] as string;
					const key = JSON.stringify(prepared);
					const cached = this.hotIndexedQuery;
					if (
						cached !== undefined &&
						cached.collectionIndex === collectionIndex &&
						cached.key === key &&
						this.authorizeCachedQuery(cached.commandBytes, () =>
							this.runtime.fast_index_query_revision(
								this.handle,
								collectionIndex,
								cached.revision,
							),
						) === 1
					) {
						return cached.rows.slice() as T;
					}
					const projected = this.measureQueryCrossing(prepared, () =>
						this.runtime.fast_projected_query_slots(
							this.handle,
							"",
							collectionIndex,
							field,
							value,
							offset,
							limit,
						),
					);
					if (
						Array.isArray(projected) &&
						typeof projected[0] === "number" &&
						projected[1] instanceof Uint32Array
					) {
						const rows = this.materializeFastSlots<unknown>(
							command.collection as string,
							projected[1],
						);
						if (rows !== undefined) {
							// The cached array is private structural metadata. Callers receive a
							// fresh shell every time while row identities remain shared.
							const cachedRows = rows.slice();
							const entry = {
								collectionIndex,
								key,
								revision: projected[0],
								commandBytes: 0,
								projected: false,
								rows: cachedRows,
							};
							this.hotIndexedQuery = entry;
							setTimeout(() => {
								if (this.hotIndexedQuery === entry)
									this.hotIndexedQuery = undefined;
							}, 0);
							return cachedRows.slice() as T;
						}
					}
				}
			}
			if (
				query.select === undefined &&
				(!hasObservableSort ||
					this.projection.isCollectionFullyMaterialized(
						command.collection as string,
					)) &&
				query.cursor === undefined &&
				command.populate === undefined &&
				typeof command.collection === "string" &&
				(query.where !== undefined || query.sort !== undefined)
			) {
				const collectionIndex = this.collectionIndexes.get(command.collection);
				if (collectionIndex !== undefined) {
					const key = JSON.stringify(prepared);
					const cached = this.hotIndexedQuery;
					if (
						(!hasObservableSort || callbackFreeSort) &&
						cached !== undefined &&
						cached.collectionIndex === collectionIndex &&
						cached.key === key &&
						this.authorizeCachedQuery(cached.commandBytes, () =>
							this.runtime.fast_index_query_revision(
								this.handle,
								collectionIndex,
								cached.revision,
							),
						) === 1
					) {
						return cached.rows.slice() as T;
					}
					const projected = this.measureQueryCrossing(prepared, () =>
						this.runtime.fast_projected_query_slots(
							this.handle,
							key,
							0xffff_ffff,
							"",
							"",
							0,
							0xffff_ffff,
						),
					);
					this.throwPendingFastCallbackDefect();
					if (
						Array.isArray(projected) &&
						typeof projected[0] === "number" &&
						projected[1] instanceof Uint32Array
					) {
						const rows = this.materializeFastSlots<T>(
							command.collection,
							projected[1],
						);
						if (rows !== undefined) {
							if (!hasObservableSort || callbackFreeSort) {
								const cachedRows = rows.slice();
								const entry = {
									collectionIndex,
									key,
									revision: projected[0],
									commandBytes: 0,
									projected: hasObservableSort ? ("sort" as const) : false,
									rows: cachedRows,
								};
								this.hotIndexedQuery = entry;
								setTimeout(() => {
									if (this.hotIndexedQuery === entry)
										this.hotIndexedQuery = undefined;
								}, 0);
								return cachedRows.slice() as T;
							}
							return rows as T;
						}
					}
				}
			}
			const canonical =
				command.populate === undefined &&
				query.where === undefined &&
				query.sort === undefined &&
				query.select === undefined &&
				query.cursor === undefined;
			if (canonical && typeof command.collection === "string") {
				const offset =
					typeof query.offset === "number" && query.offset >= 0
						? Math.trunc(query.offset)
						: 0;
				const limit =
					typeof query.limit === "number" && query.limit >= 0
						? Math.trunc(query.limit)
						: undefined;
				const collectionIndex = this.collectionIndexes.get(command.collection);
				const candidate = this.projection.fastCanonicalRangeCandidate<T>(
					command.collection,
					offset,
					limit,
				);
				const authorized =
					collectionIndex !== undefined &&
					candidate !== undefined &&
					candidate.revision <= 0xffff_ffff
						? this.measureQueryCrossing(prepared, () =>
								this.runtime.fast_query_range(
									this.handle,
									collectionIndex,
									candidate.revision,
									offset,
									candidate.rows.length,
								),
							)
						: 0;
				if (authorized === 1 && candidate !== undefined) {
					return this.measureQueryMaterialization(() =>
						this.projection.acceptAuthorizedFastRange(candidate.rows),
					) as T;
				}
			}
		}
		const payloadJson =
			compactCreateSource === undefined && compactCreateManySource === undefined
				? prepared === undefined
					? undefined
					: JSON.stringify(prepared)
				: undefined;
		if (
			compactCreateSource !== undefined &&
			typeof prepared === "object" &&
			prepared !== null &&
			"collection" in prepared &&
			typeof prepared.collection === "string"
		) {
			const collectionIndex = this.collectionIndexes.get(prepared.collection);
			if (collectionIndex !== undefined) {
				const native = this.runtime.compact_create_many(
					this.handle,
					collectionIndex,
					JSON.stringify([compactCreateSource]),
					true,
				);
				if (
					Array.isArray(native) &&
					native[0] instanceof Float64Array &&
					native[0].length === 3
				) {
					const packed = native[0];
					const id = compactCreateSource.id as string;
					const rustSlot = packed[0]!;
					const token = packed[1]!;
					const change: ProjectionSync["changes"][number] = {
						collection: prepared.collection,
						id,
						handle: `${rustSlot}:${Math.floor(token / 2 ** 21) % 2 ** 21}:${token % 2 ** 21}`,
						position: packed[2]!,
					};
					this.projection.apply({ changes: [change] });
					const fields = this.compactCreateManyFields.get(prepared.collection);
					const row: Record<string, unknown> = { ...compactCreateSource };
					if (fields?.has("createdAt") && typeof native[1] === "string")
						row.createdAt = native[1];
					if (fields?.has("updatedAt") && typeof native[1] === "string")
						row.updatedAt = native[1];
					this.touchStrongStructureLease();
					this.deferStrongStructureRelease();
					return (this.projection.cacheAuthoritativeValue(
						prepared.collection,
						id,
						row,
					)?.value ?? row) as T;
				}
				if (typeof native === "string") {
					const parsed = JSON.parse(native) as BridgeResponse<unknown>;
					return parseBridgeResponseValue(parsed, native) as T;
				}
			}
		}
		if (
			compactCreateManySource !== undefined &&
			typeof prepared === "object" &&
			prepared !== null &&
			"collection" in prepared &&
			typeof prepared.collection === "string"
		) {
			const collectionIndex = this.collectionIndexes.get(prepared.collection);
			if (collectionIndex !== undefined) {
				const native = this.runtime.compact_create_many(
					this.handle,
					collectionIndex,
					JSON.stringify(compactCreateManySource),
					false,
				);
				if (Array.isArray(native) && native[0] instanceof Float64Array) {
					const packed = native[0];
					if (packed.length === compactCreateManySource.length * 3) {
						const changes: ProjectionSync["changes"] =
							compactCreateManySource.map((source, index) => {
								const id = source.id as string;
								const rustSlot = packed[index * 3]!;
								const token = packed[index * 3 + 1]!;
								const position = packed[index * 3 + 2]!;
								const revision = token % 2 ** 21;
								const generation = Math.floor(token / 2 ** 21) % 2 ** 21;
								return {
									collection: prepared.collection as string,
									id,
									handle: `${rustSlot}:${generation}:${revision}`,
									position,
								};
							});
						this.projection.apply({ changes });
						const fields = this.compactCreateManyFields.get(
							prepared.collection,
						);
						const created = compactCreateManySource.map((source, index) => {
							const row: Record<string, unknown> = { ...source };
							if (fields?.has("createdAt") && typeof native[1] === "string")
								row.createdAt = native[1];
							if (fields?.has("updatedAt") && typeof native[1] === "string")
								row.updatedAt = native[1];
							return (
								this.projection.cacheAuthoritativeValue(
									prepared.collection as string,
									changes[index]!.id,
									row,
								)?.value ?? row
							);
						});
						this.touchStrongStructureLease();
						this.deferStrongStructureRelease();
						return { created, skipped: [] } as T;
					}
				}
				if (typeof native === "string") {
					const parsed = JSON.parse(native) as BridgeResponse<unknown>;
					return parseBridgeResponseValue(parsed, native) as T;
				}
			}
		}
		return this.dispatchPrepared<T>(
			method,
			prepared,
			payloadJson ??
				(prepared === undefined ? undefined : JSON.stringify(prepared)),
			true,
		);
	}

	private dispatchPrepared<T>(
		method: string,
		prepared: unknown,
		payloadJson: string | undefined,
		allowRetry: boolean,
	): T {
		const collection =
			typeof prepared === "object" &&
			prepared !== null &&
			"collection" in prepared &&
			typeof (prepared as { readonly collection?: unknown }).collection ===
				"string"
				? (prepared as { readonly collection: string }).collection
				: undefined;
		const projected =
			shouldProjectRead(method, prepared) &&
			(method !== "query" ||
				(collection !== undefined &&
					this.canonicalQueryCollections.has(collection)));
		const deletionNeedsPriorIdentity = matchesDeletionResultMethod(method);
		const priorMaterialized = new Map<string, unknown>();
		if (method === "updateMany" || method === "deleteMany") {
			this.diagnostics.bulkMutationDispatches += 1;
		} else if (method === "query" || method === "queryCursor") {
			this.diagnostics.queryDispatches += 1;
		}
		const dispatch = () =>
			projected
				? this.runtime.dispatch_projected(this.handle, method, payloadJson)
				: this.runtime.dispatch(this.handle, method, payloadJson);
		const raw =
			method === "query"
				? this.measureQueryCrossing(payloadJson, dispatch)
				: dispatch();
		const parsed = JSON.parse(raw) as BridgeResponse<unknown>;
		let mutationSync: ProjectionSync | undefined;
		if (MUTATION_METHODS.has(method)) {
			if (parsed.projection === undefined) {
				this.invalidateProjection();
				throw new Error(`Mutation response omitted projection sync: ${method}`);
			}
			mutationSync = decodeBoundaryValueForHost(parsed.projection);
			if (collection !== undefined && deletionNeedsPriorIdentity) {
				for (const change of mutationSync.changes) {
					if (change.collection !== collection || !change.deleted) continue;
					const materialized = this.projection.materializedValue(
						collection,
						change.id,
					);
					if (materialized !== undefined) {
						priorMaterialized.set(change.id, materialized);
					}
				}
			}
			this.projection.apply(mutationSync);
		} else if (parsed.kind === "defect") {
			this.invalidateProjection();
		}
		const value = parseBridgeResponseValue(parsed, raw);
		if (collection !== undefined && mutationSync !== undefined) {
			return this.materializeMutationResult<T>(
				method,
				collection,
				prepared,
				value,
				mutationSync,
				priorMaterialized,
				this.projection,
			);
		}
		if (!projected || collection === undefined) return value as T;
		try {
			if (isCompactMaterializedResultDescriptor(value)) {
				return this.projection.materializeCompact<T>(
					collection,
					value,
					raw.length,
				);
			}
			if (!isMaterializedResultDescriptor(value)) return value as T;
			return this.projection.materialize<T>(collection, value, raw.length);
		} catch (error) {
			if (!(error instanceof StaleMaterializedHandleError) || !allowRetry)
				throw error;
			this.resynchronizeProjection();
			return this.dispatchPrepared<T>(method, prepared, payloadJson, false);
		}
	}

	private materializeMutationResult<T>(
		method: string,
		collection: string,
		prepared: unknown,
		value: unknown,
		sync: ProjectionSync,
		priorMaterialized: ReadonlyMap<string, unknown>,
		projection: MaterializedProjection = this.projection,
	): T {
		if (method === "upsert") return value as T;
		const ownerChanges = sync.changes.filter(
			(change) => change.collection === collection,
		);
		if (
			method === "createMany" &&
			typeof value === "object" &&
			value !== null &&
			Array.isArray((value as { readonly created?: unknown }).created) &&
			(value as { readonly created: ReadonlyArray<unknown> }).created.length ===
				ownerChanges.length &&
			ownerChanges.every((change) => !change.deleted)
		) {
			const record = value as {
				created: ReadonlyArray<unknown>;
				skipped?: ReadonlyArray<unknown>;
			};
			const created = record.created.map((row, index) => {
				const change = ownerChanges[index]!;
				return (
					projection.cacheAuthoritativeValue(collection, change.id, row)
						?.value ?? row
				);
			});
			return { ...record, created } as T;
		}
		const claimedChanges = new Set<number>();
		const rowId = (row: unknown) =>
			typeof row === "object" &&
			row !== null &&
			"id" in row &&
			typeof (row as { readonly id?: unknown }).id === "string"
				? (row as { readonly id: string }).id
				: undefined;
		type ChangeQueue = { readonly indices: number[]; cursor: number };
		const exactQueues = new Map<string, ChangeQueue>();
		const fallbackQueues = new Map<boolean, ChangeQueue>([
			[false, { indices: [], cursor: 0 }],
			[true, { indices: [], cursor: 0 }],
		]);
		const queueKey = (deleted: boolean, id: string) =>
			`${deleted ? "deleted" : "stored"}\u0000${id}`;
		const addExact = (key: string, index: number) => {
			const queue = exactQueues.get(key);
			if (queue) queue.indices.push(index);
			else exactQueues.set(key, { indices: [index], cursor: 0 });
		};
		ownerChanges.forEach((change, index) => {
			const deleted = change.deleted === true;
			fallbackQueues.get(deleted)?.indices.push(index);
			addExact(queueKey(deleted, change.id), index);
			if (
				!deleted &&
				change.resultId !== undefined &&
				change.resultId !== change.id
			) {
				addExact(queueKey(false, change.resultId), index);
			}
		});
		const consumeQueue = (queue: ChangeQueue | undefined) => {
			if (!queue) return undefined;
			while (queue.cursor < queue.indices.length) {
				const index = queue.indices[queue.cursor++];
				if (index !== undefined && !claimedChanges.has(index)) return index;
			}
			return undefined;
		};
		const claimChange = (row: unknown, deleted: boolean) => {
			const resultId = rowId(row);
			const exact =
				resultId === undefined
					? undefined
					: consumeQueue(exactQueues.get(queueKey(deleted, resultId)));
			const index = exact ?? consumeQueue(fallbackQueues.get(deleted));
			if (index === undefined) return undefined;
			claimedChanges.add(index);
			return ownerChanges[index];
		};
		const materializeStoredRow = (
			row: unknown,
			change = claimChange(row, false),
		): unknown => {
			const id = change?.id ?? rowId(row);
			if (id === undefined) return row;
			const current = projection.materializedValue(collection, id);
			if (current !== undefined) return current;
			const cached = projection.cacheAuthoritativeValue(collection, id, row);
			if (cached === undefined) return row;
			return cached.value;
		};
		const materializeDeletedRow = (row: unknown): unknown => {
			const deletedChange = claimChange(row, true);
			if (deletedChange !== undefined) {
				return priorMaterialized.get(deletedChange.id) ?? row;
			}
			return materializeStoredRow(row);
		};
		const mapField = (
			result: Record<string, unknown>,
			field: "created" | "updated" | "unchanged" | "deleted",
		) => {
			const rows = result[field];
			if (!Array.isArray(rows)) return;
			result[field] = rows.map((row) =>
				field === "deleted"
					? materializeDeletedRow(row)
					: materializeStoredRow(row),
			);
		};

		let result = value;
		if (
			method === "create" ||
			method === "update" ||
			method === "createWithRelationships" ||
			method === "updateWithRelationships"
		) {
			const preparedId =
				typeof prepared === "object" &&
				prepared !== null &&
				"id" in prepared &&
				typeof (prepared as { readonly id?: unknown }).id === "string"
					? (prepared as { readonly id: string }).id
					: undefined;
			const change =
				ownerChanges.find(
					(candidate) =>
						!candidate.deleted &&
						(preparedId === undefined || candidate.id === preparedId),
				) ?? ownerChanges.find((candidate) => !candidate.deleted);
			result = materializeStoredRow(value, change);
		} else if (method === "delete") {
			const preparedId =
				typeof prepared === "object" &&
				prepared !== null &&
				"id" in prepared &&
				typeof (prepared as { readonly id?: unknown }).id === "string"
					? (prepared as { readonly id: string }).id
					: undefined;
			result =
				(preparedId === undefined
					? undefined
					: priorMaterialized.get(preparedId)) ?? value;
		} else if (
			typeof result === "object" &&
			result !== null &&
			(method === "createMany" ||
				method === "updateMany" ||
				method === "deleteMany" ||
				method === "upsertMany" ||
				method === "deleteManyWithRelationships")
		) {
			const record = result as Record<string, unknown>;
			for (const field of [
				"created",
				"updated",
				"unchanged",
				"deleted",
			] as const) {
				mapField(record, field);
			}
			result = record;
		} else if (
			method === "deleteWithRelationships" &&
			typeof value === "object" &&
			value !== null
		) {
			const record = value as Record<string, unknown>;
			if (Object.hasOwn(record, "deleted")) {
				record.deleted = materializeDeletedRow(record.deleted);
			}
			result = record;
		}

		return result as T;
	}

	canUseIdentityPersistence(collection: string): boolean {
		return this.compactCreateManyFields.has(collection);
	}

	setProjectionSynchronizationListener(
		listener: ((collections: ReadonlySet<string>) => void) | undefined,
	) {
		this.projectionSynchronizationListener = listener;
	}

	synchronizeForPersistence() {
		if (this.projection.needsResynchronization) this.resynchronizeProjection();
		if (this.projection.hasDirtyRows) this.synchronizeDirtyProjection();
	}

	private synchronizeDirtyProjection() {
		if (!this.projection.hasDirtyRows) return;
		this.clearHotBulkSelections();
		const rows = this.projection.dirtyRows;
		if (rows.length === 0) return;
		const payload = rows.map((row) => ({
			collection: row.collection,
			id: row.id,
			handle: row.handle,
			value: encodeBoundaryValueForWire(row.value),
		}));
		try {
			parseBridgeResponse(
				this.runtime.synchronize_projection(
					this.handle,
					JSON.stringify(payload),
				),
			);
			this.projection.markSynchronized(rows);
			this.projectionSynchronizationListener?.(
				new Set(rows.map((row) => row.collection)),
			);
		} catch (error) {
			this.invalidateProjection();
			throw error;
		}
	}

	private resynchronizeProjection() {
		this.clearHotIndexedQuery();
		this.clearHotBulkSelections();
		this.projectionSynchronizationListener?.(
			new Set(this.collectionIndexes.keys()),
		);
		const handles = parseBridgeResponse<ProjectionHandles>(
			this.projection.canPreserveValuesOnResync
				? this.runtime.projection_handles_preserving_materializations(
						this.handle,
					)
				: this.runtime.projection_handles(this.handle),
		);
		this.projection.resynchronize(projectionSnapshotFromHandles(handles));
	}

	setTransactionContext(context: TransactionContext | undefined) {
		this.transactionContext = context;
	}

	assertTransactionWaitAllowed(): void {
		// Node/Bun AsyncLocalStorage can distinguish a self-wait from a legitimate
		// outside caller. Browsers currently lack that origin signal, so they keep
		// required outside FIFO queuing rather than rejecting every root call.
		if (
			this.transactionBarrier &&
			this.transactionContext?.getStore() === true
		) {
			throw transactionBeginError(
				"transaction is active; use transaction context",
			);
		}
	}

	private dispatchFindById<T>(
		collection: string,
		id: string,
		allowRetry = true,
	): T {
		if (this.projection.needsResynchronization) this.resynchronizeProjection();
		if (this.projection.hasDirtyRows) this.synchronizeDirtyProjection();
		const collectionIndex = this.collectionIndexes.get(collection);
		const candidate = this.projection.fastFindCandidate<T>(collection, id);
		if (collectionIndex !== undefined) {
			if (candidate !== undefined) {
				const authorized = this.authorizeFastFind(collectionIndex, candidate);
				if (authorized === 1) {
					return this.projection.acceptAuthorizedFastFind(candidate);
				}
			} else {
				const encoded = this.runtime.fast_find_by_id_descriptor(
					this.handle,
					collectionIndex,
					id,
				);
				if (encoded !== undefined) {
					const descriptor = decodeBoundaryValueForHost(encoded);
					if (!isCompactMaterializedResultDescriptor(descriptor)) {
						throw new Error("Fast findById returned an invalid descriptor");
					}
					try {
						const value = this.projection.materializeCompact<T>(
							collection,
							descriptor,
							0,
						);
						const materialized = this.projection.fastFindCandidate<T>(
							collection,
							id,
						);
						if (materialized !== undefined) {
							this.warmFastFindAuthorization(collectionIndex, materialized);
						}
						return value;
					} catch (error) {
						if (!(error instanceof StaleMaterializedHandleError) || !allowRetry)
							throw error;
						this.resynchronizeProjection();
						return this.dispatchFindById<T>(collection, id, false);
					}
				}
			}
		}
		this.projection.recordFastFindFallback();
		return this.dispatch<T>("findById", { collection, id });
	}

	invokeFindById<T>(collection: string, id: string): Promise<T> {
		let operation: Promise<T>;
		if (this.transactionBarrier) {
			try {
				this.assertTransactionWaitAllowed();
			} catch (error) {
				return Promise.reject(error);
			}
			operation = this.transactionBarrier.then(() => {
				this.touchStrongStructureLease();
				return this.dispatchFindById<T>(collection, id);
			});
		} else {
			try {
				this.touchStrongStructureLease();
				operation = Promise.resolve(this.dispatchFindById<T>(collection, id));
			} catch (error) {
				operation = Promise.reject(error);
			}
		}
		return operation.finally(() => this.deferStrongStructureRelease());
	}

	invokeMapped<T, U>(
		method: string,
		payload: unknown,
		map: (value: T) => U,
	): Promise<U> {
		try {
			this.assertTransactionWaitAllowed();
		} catch (error) {
			return Promise.reject(error);
		}
		const run = () => {
			this.touchStrongStructureLease();
			try {
				return settledPromise(() => map(this.dispatch<T>(method, payload)));
			} finally {
				this.deferStrongStructureRelease();
			}
		};
		return this.transactionBarrier ? this.transactionBarrier.then(run) : run();
	}

	invoke<T>(method: string, payload?: unknown): Promise<T> {
		try {
			this.assertTransactionWaitAllowed();
		} catch (error) {
			return Promise.reject(error);
		}
		const run = () => {
			this.touchStrongStructureLease();
			try {
				return settledPromise(() => this.dispatch<T>(method, payload));
			} finally {
				this.deferStrongStructureRelease();
			}
		};
		return this.transactionBarrier ? this.transactionBarrier.then(run) : run();
	}

	invokePredicateBulk<T>(
		method: "updateMany" | "deleteMany",
		collection: string,
		selectIds: (
			rows: ReadonlyArray<Record<string, unknown>>,
		) => ReadonlyArray<string>,
		data: unknown,
		options?: { readonly soft?: boolean },
		onCommittedDirectMutation?: () => void,
		onCommittedFormalMutation?: (value: T) => void,
	): Promise<T> {
		try {
			this.assertTransactionWaitAllowed();
		} catch (error) {
			return Promise.reject(error);
		}
		const run = () => {
			this.touchStrongStructureLease();
			return settledPromise(() => {
				let rows: ReadonlyArray<Record<string, unknown>> | undefined;
				let ids: ReadonlyArray<string> | undefined;
				const synchronizePredicateMutations = () => {
					if (this.projection.needsResynchronization)
						this.resynchronizeProjection();
					if (!this.projection.hasDirtyRows) return;
					this.synchronizeDirtyProjection();
					onCommittedDirectMutation?.();
				};
				try {
					if (this.projection.needsResynchronization)
						this.resynchronizeProjection();
					rows =
						this.projection.canonicalMaterializedRows<Record<string, unknown>>(
							collection,
						) ??
						this.dispatch<ReadonlyArray<Record<string, unknown>>>("query", {
							collection,
							query: {},
						});
					try {
						ids = selectIds(rows);
					} catch (error) {
						synchronizePredicateMutations();
						throw error;
					}
					synchronizePredicateMutations();
					const command = {
						collection,
						where: { id: { $in: ids } },
						...(method === "updateMany"
							? { data }
							: { soft: options?.soft ?? false }),
					};
					// Synchronization may replace projection structure. Authorization is
					// deliberately reacquired only after all callback side effects commit.
					this.clearHotIndexedQuery();
					this.clearHotBulkSelections();
					const authorized = this.tryAuthorizedBulk<T>(method, command);
					const value = authorized.hit
						? authorized.value
						: this.dispatch<T>(method, command);
					onCommittedFormalMutation?.(value);
					return value;
				} finally {
					rows = undefined;
					ids = undefined;
				}
			});
		};
		const operation = this.transactionBarrier
			? this.transactionBarrier.then(run)
			: run();
		return operation.finally(() => this.deferStrongStructureRelease());
	}

	beginTransactionSession(): RuntimeTransactionSession {
		if (this.transactionBarrier) {
			throw transactionBeginError("another transaction is already active");
		}
		if (this.projection.needsResynchronization) this.resynchronizeProjection();
		if (this.projection.hasDirtyRows) this.synchronizeDirtyProjection();
		this.clearHotIndexedQuery();
		this.clearHotBulkSelections();
		this.transactionBarrier = new Promise<void>((resolve) => {
			this.releaseTransactionBarrier = resolve;
		});
		try {
			const begun = parseBridgeResponse<{ readonly sessionHandle: number }>(
				this.runtime.begin_transaction(this.handle),
			);
			this.diagnostics.transactionBegins += 1;
			return {
				handle: begun.sessionHandle,
				projection: new MaterializedProjection(
					{ collections: {} },
					this.projection,
				),
			};
		} catch (error) {
			this.finishTransactionSession();
			throw error;
		}
	}

	private synchronizeTransactionProjection(session: RuntimeTransactionSession) {
		if (!session.projection.hasDirtyRows) return;
		const rows = session.projection.dirtyRows;
		if (rows.length === 0) return;
		try {
			const encoded = rows.map((row) => ({
				collection: row.collection,
				id: row.id,
				handle: row.handle,
				value: encodeBoundaryValueForWire(row.value),
			}));
			parseBridgeResponse(
				this.runtime.synchronize_transaction_projection(
					session.handle,
					JSON.stringify(encoded),
				),
			);
			session.projection.markSynchronized(rows);
		} catch (error) {
			session.projection.invalidate();
			throw error;
		}
	}

	invokeTransactionStep<T>(
		session: RuntimeTransactionSession,
		method: string,
		payload?: unknown,
	): Promise<T> {
		return settledPromise(() => {
			if (session.projection.needsResynchronization) {
				const handles = parseBridgeResponse<ProjectionHandles>(
					this.runtime.transaction_projection_handles(session.handle),
				);
				session.projection.resynchronize(
					projectionSnapshotFromHandles(handles),
				);
			}
			this.synchronizeTransactionProjection(session);
			if (method === "updateMany" || method === "deleteMany") {
				this.diagnostics.bulkMutationDispatches += 1;
			} else if (method === "query" || method === "queryCursor") {
				this.diagnostics.queryDispatches += 1;
			}
			const prepared =
				payload === undefined
					? undefined
					: prepareCommandPayload(method, payload);
			const collection =
				typeof prepared === "object" &&
				prepared !== null &&
				"collection" in prepared &&
				typeof (prepared as { readonly collection?: unknown }).collection ===
					"string"
					? (prepared as { readonly collection: string }).collection
					: undefined;
			const projected =
				shouldProjectRead(method, prepared) &&
				(method !== "query" ||
					(collection !== undefined &&
						this.canonicalQueryCollections.has(collection)));
			const wirePrepared =
				projected && typeof prepared === "object" && prepared !== null
					? { ...prepared, __proseqlProjectResult: true }
					: prepared;
			const payloadJson =
				wirePrepared === undefined ? undefined : JSON.stringify(wirePrepared);
			const deletionNeedsPriorIdentity = matchesDeletionResultMethod(method);
			const priorMaterialized = new Map<string, unknown>();
			this.diagnostics.transactionSteps += 1;
			const raw = this.runtime.transaction_step(
				session.handle,
				method,
				payloadJson,
			);
			const parsed = JSON.parse(raw) as BridgeResponse<unknown>;
			let mutationSync: ProjectionSync | undefined;
			if (MUTATION_METHODS.has(method)) {
				if (parsed.projection === undefined) {
					session.projection.invalidate();
					throw new Error(
						`Transaction mutation response omitted projection sync: ${method}`,
					);
				}
				mutationSync = decodeBoundaryValueForHost(parsed.projection);
				if (collection !== undefined && deletionNeedsPriorIdentity) {
					for (const change of mutationSync.changes) {
						if (change.collection !== collection || !change.deleted) continue;
						const materialized = session.projection.materializedValue(
							collection,
							change.id,
						);
						if (materialized !== undefined)
							priorMaterialized.set(change.id, materialized);
					}
				}
				session.projection.apply(mutationSync);
			} else if (parsed.kind === "defect") {
				session.projection.invalidate();
			}
			const value = parseBridgeResponseValue(parsed, raw);
			if (collection !== undefined && mutationSync !== undefined) {
				return this.materializeMutationResult<T>(
					method,
					collection,
					prepared,
					value,
					mutationSync,
					priorMaterialized,
					session.projection,
				);
			}
			if (!projected || collection === undefined) return value as T;
			if (isCompactMaterializedResultDescriptor(value)) {
				return session.projection.materializeCompact<T>(
					collection,
					value,
					raw.length,
				);
			}
			if (!isMaterializedResultDescriptor(value)) return value as T;
			return session.projection.materialize<T>(collection, value, raw.length);
		});
	}

	commitTransactionSession(
		session: RuntimeTransactionSession,
	): ReadonlyArray<string> {
		this.synchronizeTransactionProjection(session);
		this.clearHotIndexedQuery();
		const raw = this.runtime.commit_transaction(session.handle);
		const parsed = JSON.parse(raw) as BridgeResponse<unknown>;
		if (parsed.kind === "defect") {
			this.invalidateProjection();
			parseBridgeResponseValue(parsed, raw);
		}
		if (parsed.projection === undefined) {
			this.invalidateProjection();
			parseBridgeResponseValue(parsed, raw);
			throw new Error("Transaction commit response omitted projection sync");
		}
		const sync = decodeBoundaryValueForHost(
			parsed.projection,
		) as ProjectionSync;
		this.projection.apply(sync);
		const result = parseBridgeResponseValue(parsed, raw) as {
			readonly changedCollections?: ReadonlyArray<string>;
		};
		this.diagnostics.transactionCommits += 1;
		return result.changedCollections ?? [];
	}

	rollbackTransactionSession(session: RuntimeTransactionSession): void {
		this.clearHotIndexedQuery();
		parseBridgeResponse(this.runtime.rollback_transaction(session.handle));
		this.diagnostics.transactionRollbacks += 1;
	}

	finishTransactionSession(): void {
		const release = this.releaseTransactionBarrier;
		this.releaseTransactionBarrier = undefined;
		this.transactionBarrier = undefined;
		release?.();
	}

	waitForTransaction(): Promise<void> {
		try {
			this.assertTransactionWaitAllowed();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.transactionBarrier ?? Promise.resolve();
	}

	async createTemporaryTransactionRuntime(): Promise<EngineRuntime> {
		this.diagnostics.temporaryTransactionRuntimes += 1;
		this.diagnostics.transactionSnapshotTransfers += 1;
		const snapshot =
			await this.invoke<Record<string, ReadonlyArray<Record<string, unknown>>>>(
				"dumpAll",
			);
		const createPayload = {
			descriptor: this.createInput.descriptor,
			initialCollections: encodeBoundaryValueForWire(snapshot) as Record<
				string,
				ReadonlyArray<Record<string, unknown>>
			>,
		};
		const handle = parseBridgeResponse<number>(
			this.runtime.create_database(JSON.stringify(createPayload)),
		);
		const handles = parseBridgeResponse<ProjectionHandles>(
			this.runtime.projection_handles(handle),
		);
		const projection = new MaterializedProjection(
			projectionSnapshotFromHandles(handles),
		);
		return new EngineRuntime(
			this.runtime,
			handle,
			{ descriptor: createPayload.descriptor },
			projection,
			this.diagnostics,
		);
	}

	materializationDiagnostics() {
		return {
			...this.projection.stats,
			...this.diagnostics,
			strongStructureLeaseGeneration: this.strongStructureLeaseGeneration,
			strongStructureReleaseScheduled:
				this.strongStructureReleaseTimer !== undefined,
			hotBulkIdsCached: this.hotBulkIds !== undefined,
			hotDeleteBulkIdsCached: this.hotDeleteBulkIds !== undefined,
		};
	}

	drop(): Promise<void> {
		try {
			this.assertTransactionWaitAllowed();
		} catch (error) {
			return Promise.reject(error);
		}
		this.clearStrongStructuresImmediately();
		return this.waitForTransaction().then(() => {
			this.projection.clear();
			parseBridgeResponse(this.runtime.drop_database(this.handle));
		});
	}

	watch<T>(
		collection: string,
		config: EngineWatchConfig<T, unknown, unknown> | undefined,
	): WatchSubscription<ReadonlyArray<T>> {
		this.assertTransactionWaitAllowed();
		let subscriptionId: number | undefined;
		let cancelled = false;
		const queue = new AsyncQueue<ReadonlyArray<T>>(() => {
			cancelled = true;
			return Promise.resolve().then(() => {
				if (subscriptionId === undefined) return;
				parseBridgeResponse(
					this.runtime.unsubscribe(this.handle, subscriptionId),
				);
			});
		});
		const subscribe = () => {
			if (cancelled) return;
			if (this.projection.needsResynchronization)
				this.resynchronizeProjection();
			this.synchronizeDirtyProjection();
			subscriptionId = parseBridgeResponse<number>(
				this.runtime.subscribe_watch(
					this.handle,
					JSON.stringify(
						prepareCommandPayload("subscribeWatch", { collection, config }),
					),
					(payloadJson) => {
						try {
							queue.push(parseBridgeResponse<ReadonlyArray<T>>(payloadJson));
						} catch (error) {
							queue.fail(error);
						}
					},
				),
			);
		};
		if (this.transactionBarrier) void this.transactionBarrier.then(subscribe);
		else subscribe();
		return queue;
	}

	watchById<T>(
		collection: string,
		id: string,
		debounceMs?: number,
	): WatchSubscription<T | null> {
		this.assertTransactionWaitAllowed();
		let subscriptionId: number | undefined;
		let cancelled = false;
		const queue = new AsyncQueue<T | null>(() => {
			cancelled = true;
			return Promise.resolve().then(() => {
				if (subscriptionId === undefined) return;
				parseBridgeResponse(
					this.runtime.unsubscribe(this.handle, subscriptionId),
				);
			});
		});
		const subscribe = () => {
			if (cancelled) return;
			if (this.projection.needsResynchronization)
				this.resynchronizeProjection();
			this.synchronizeDirtyProjection();
			subscriptionId = parseBridgeResponse<number>(
				this.runtime.subscribe_watch_by_id(
					this.handle,
					JSON.stringify({ collection, id, debounceMs }),
					(payloadJson) => {
						try {
							queue.push(parseBridgeResponse<T | null>(payloadJson));
						} catch (error) {
							queue.fail(error);
						}
					},
				),
			);
		};
		if (this.transactionBarrier) void this.transactionBarrier.then(subscribe);
		else subscribe();
		return queue;
	}
}

// Browsers do not expose a reliable async-context primitive. Returning
// undefined there deliberately preserves FIFO queuing for genuine outside
// callers instead of using a timeout/global flag that would misclassify them.
const createTransactionContext = (): TransactionContext | undefined => {
	const processRef = (
		globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }
	).process;
	const asyncHooks = processRef?.getBuiltinModule?.("node:async_hooks") as
		| { AsyncLocalStorage?: new <T>() => TransactionContext }
		| undefined;
	return asyncHooks?.AsyncLocalStorage
		? new asyncHooks.AsyncLocalStorage<true>()
		: undefined;
};

const importDefaultNodeStorageHost = async (): Promise<EngineStorageHost> => {
	const module = (await import(
		/* @vite-ignore */ "./storage-host.js" as string
	)) as typeof import("./storage-host.js");
	return module.createNodeEngineStorageHost();
};

export const createEngineDatabase = async <Config extends DatabaseConfig>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabase<Config>> => {
	const pluginRegistry = await buildPluginRegistry(options?.plugins);
	for (const [name, collection] of Object.entries(
		getCollectionConfigs(config),
	)) {
		validateCollectionRuntimeConfig(name, collection, pluginRegistry);
	}
	const { runtime, collections } = await EngineRuntime.create(
		config,
		initialData as EngineInitialData<DatabaseConfig> | undefined,
		options,
		pluginRegistry,
	);
	return buildDatabaseFacade(
		runtime,
		collections,
		undefined,
		config,
	) as unknown as GenerateEngineDatabase<Config>;
};

export const createPersistentEngineDatabase = async <
	Config extends DatabaseConfig,
>(
	config: Config,
	initialData?: EngineInitialData<Config>,
	persistenceOptions?: EnginePersistenceOptions,
	options?: EngineDatabaseOptions,
): Promise<GenerateEngineDatabaseWithPersistence<Config>> => {
	const host =
		persistenceOptions?.storageHost ?? (await importDefaultNodeStorageHost());
	const storageLayer =
		persistenceOptions?.storageLayer ?? makeEngineStorageLayer(host);
	const pluginRegistry = await buildPluginRegistry(options?.plugins);
	for (const [name, collection] of Object.entries(
		getCollectionConfigs(config),
	)) {
		validateCollectionRuntimeConfig(name, collection, pluginRegistry);
	}
	const configuredSerializerRegistry = persistenceOptions?.serializerRegistry
		? mergeSerializerWithPluginCodecs(
				persistenceOptions.serializerRegistry,
				pluginRegistry.codecs,
			)
		: undefined;
	const serializerLayer = configuredSerializerRegistry
		? Layer.succeed(SerializerRegistryService, configuredSerializerRegistry)
		: makeSerializerLayer(inferCodecsFromConfig(config), pluginRegistry.codecs);
	const layer = Layer.merge(storageLayer, serializerLayer) as any;
	const collections = Object.entries(getCollectionConfigs(config)).map(
		([name, raw]) => ({
			name,
			schema: raw.schema,
			raw,
		}),
	);
	const loaded = isSourceOrientedDatabaseConfig(config)
		? await loadSourceOrientedCollections(
				config,
				collections,
				initialData,
				host,
				layer,
			)
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
		loaded.collections,
		pluginRegistry.codecs.length === 0
			? configuredSerializerRegistry
			: undefined,
		pluginRegistry.codecs.length === 0
			? persistenceOptions?._persistObjectFile
			: undefined,
		persistenceOptions?.storageLayer === undefined ||
			persistenceOptions?._persistObjectFile !== undefined,
		loaded.baselines,
		loaded.sourceState,
	);
	if (!persistenceOptions?._suppressInitialWrites) {
		for (const [collectionName, value] of Object.entries(initialData ?? {})) {
			if (value === undefined) continue;
			markCollectionDirty(persistence, collectionName);
			const key = persistence.writeKeyByCollection.get(collectionName);
			if (key) persistence.saver.schedule(key);
		}
	}
	await registerExternalReloadWatchers(runtime, persistence);
	return buildDatabaseFacade(
		runtime,
		collections,
		persistence,
		config,
	) as unknown as GenerateEngineDatabaseWithPersistence<Config>;
};

function buildDatabaseFacade(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	persistence: PersistenceState | undefined,
	config: DatabaseConfig,
) {
	const transactionGate: TransactionGate = {
		active: false,
		depth: 0,
		context: createTransactionContext(),
	};
	runtime.setTransactionContext(transactionGate.context);
	const db: Record<string, unknown> = {};
	for (const collection of collections) {
		db[collection.name] = buildCollectionFacade(
			runtime,
			collection,
			persistence,
		) as EngineCollection<any>;
	}
	const documentGraph = {
		getRecordProvenance: async (collection: string, id: string) =>
			persistence?.sourceState?.graphState.provenance.get(
				`${collection}\u0000${id}`,
			),
		getDiagnostics: async () =>
			persistence?.sourceState?.graphState.diagnostics ?? [],
	};
	let transientClosePromise: Promise<void> | undefined;
	const transactional = {
		$transaction: <A>(
			fn: (ctx: EngineTransactionDatabase<any>) => Promise<A>,
		) => runTransaction(runtime, collections, persistence, fn, transactionGate),
		close: async () => {
			runtime.assertTransactionWaitAllowed();
			if (persistence) {
				if (persistence.lifecycle.closePromise) {
					return persistence.lifecycle.closePromise;
				}
				persistence.lifecycle.status = "closing";
				const closePromise = promiseCall(async () => {
					await stopWatchers(persistence);
					await runtime.waitForTransaction();
					await waitForBackgroundReloads(persistence);
					try {
						await persistence.saver.flush();
						await waitForBackgroundReloads(persistence);
						if (persistence.backgroundError !== undefined) {
							throw persistence.backgroundError;
						}
					} finally {
						try {
							await runtime.drop();
						} finally {
							persistence.lifecycle.status = "closed";
						}
					}
				});
				persistence.lifecycle.closePromise = closePromise;
				return closePromise;
			}
			if (transientClosePromise) return transientClosePromise;
			transientClosePromise = runtime.drop();
			return transientClosePromise;
		},
	};
	const withDiagnostics = <T extends object>(facade: T): T => {
		Object.defineProperty(facade, "__proseqlMaterializationDiagnostics", {
			value: () => runtime.materializationDiagnostics(),
			enumerable: false,
		});
		return facade;
	};
	if (!persistence) {
		return withDiagnostics({
			...db,
			...transactional,
			$documentGraph: documentGraph,
		});
	}
	return withDiagnostics({
		...db,
		...transactional,
		$documentGraph: documentGraph,
		flush: async () => {
			runtime.synchronizeForPersistence();
			await persistence.saver.flush();
			if (persistence.backgroundError !== undefined) {
				throw persistence.backgroundError;
			}
		},
		pendingCount: () => persistence.saver.pendingCount(),
		$dryRunMigrations: () =>
			runDryRunMigrations(
				config,
				hostFromPersistence(persistence),
				persistence.layer,
			),
	});
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

const selectionOrderApplied = new WeakSet<object>();

function applySelectionOrder<T>(value: T, select: unknown): T {
	if (
		typeof value === "object" &&
		value !== null &&
		selectionOrderApplied.delete(value)
	) {
		return value;
	}
	if (select === undefined || select === null) return value;
	if (Array.isArray(select)) {
		if (!Array.isArray(value) || select.length === 0) return value;
		return value.map((item) => reorderSelectedValue(item, select)) as T;
	}
	if (typeof select === "object" && select !== null) {
		const keys = Object.keys(select as Record<string, unknown>);
		if (keys.length === 0 || !Array.isArray(value)) return value;
		return value.map((item) =>
			reorderSelectedValue(item, select as Record<string, unknown>),
		) as T;
	}
	return value;
}

function reorderSelectedValue(
	value: unknown,
	select: ReadonlyArray<unknown> | Record<string, unknown>,
): unknown {
	if (Array.isArray(select)) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return value;
		const record = value as Record<string, unknown>;
		const ordered: Record<string, unknown> = {};
		for (const key of select) {
			if (typeof key !== "string" || !Object.hasOwn(record, key)) continue;
			Object.defineProperty(ordered, key, {
				value: record[key],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return ordered;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return value;
	const record = value as Record<string, unknown>;
	const ordered: Record<string, unknown> = {};
	for (const [key, nestedSelect] of Object.entries(select)) {
		if (!Object.hasOwn(record, key)) continue;
		const current = record[key];
		let selected: unknown;
		if (nestedSelect && typeof nestedSelect === "object") {
			selected = Array.isArray(current)
				? current.map((item) =>
						reorderSelectedValue(item, nestedSelect as Record<string, unknown>),
					)
				: reorderSelectedValue(
						current,
						nestedSelect as Record<string, unknown>,
					);
		} else if (nestedSelect === true) {
			selected = current;
		} else {
			continue;
		}
		Object.defineProperty(ordered, key, {
			value: selected,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return ordered;
}

function isAppendOnlyJsonLinesCollection(collection: CollectionRuntimeConfig) {
	if (!collection.raw.appendOnly || !collection.raw.file) return false;
	const format = inferCollectionFormat(collection.raw);
	return format === "jsonl" || format === "ndjson";
}

async function appendAppendOnlyEntities(
	persistence: PersistenceState | undefined,
	collection: CollectionRuntimeConfig,
	entities: ReadonlyArray<Record<string, unknown>>,
) {
	if (
		!persistence ||
		entities.length === 0 ||
		!isAppendOnlyJsonLinesCollection(collection) ||
		!collection.raw.file
	) {
		return;
	}
	try {
		const encode = Schema.encodeEffect(
			collection.schema as Schema.Codec<Record<string, unknown>, unknown>,
		);
		let payload = "";
		for (const entity of entities) {
			const encoded = await Effect.runPromise(
				encode(entity).pipe(Effect.catch(() => Effect.succeed(entity))),
			);
			payload += `${JSON.stringify(encoded)}\n`;
		}
		await persistence.host.ensureDir(collection.raw.file);
		await persistence.host.append(collection.raw.file, payload);
	} catch {
		// TS append-only persistence swallows immediate append failures and relies on the
		// debounced canonical saver for eventual durability.
	}
}

function invalidatePersistenceMirror(
	persistence: PersistenceState | undefined,
	collection: string,
	reason: string,
) {
	if (!persistence?.mirrorEligibleCollections.has(collection)) return;
	persistence.collectionMirrors.set(collection, {
		_tag: "canonicalRequired",
		reason,
	});
}

function invalidateAllPersistenceMirrors(
	persistence: PersistenceState | undefined,
	reason: string,
) {
	if (!persistence) return;
	for (const collection of persistence.mirrorEligibleCollections) {
		invalidatePersistenceMirror(persistence, collection, reason);
	}
}

function refreshPersistenceMirror(
	persistence: PersistenceState | undefined,
	collection: string,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	if (!persistence?.mirrorEligibleCollections.has(collection)) return;
	persistence.collectionMirrors.set(collection, {
		_tag: "valid",
		rows: toEntityMap(rows),
	});
}

function validPersistenceMirror(
	persistence: PersistenceState | undefined,
	collection: string,
): Map<string, Record<string, unknown>> | undefined {
	const state = persistence?.collectionMirrors.get(collection);
	return state?._tag === "valid" ? state.rows : undefined;
}

function isPersistenceRow(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { readonly id?: unknown }).id === "string"
	);
}

function mirrorUpsertRows(
	persistence: PersistenceState | undefined,
	collection: string,
	values: ReadonlyArray<unknown>,
): boolean {
	const rows = validPersistenceMirror(persistence, collection);
	if (!rows) return false;
	for (const value of values) {
		if (!isPersistenceRow(value)) return false;
		rows.set(value.id as string, value);
	}
	return true;
}

function mirrorDeleteRows(
	persistence: PersistenceState | undefined,
	collection: string,
	values: ReadonlyArray<unknown>,
): boolean {
	const rows = validPersistenceMirror(persistence, collection);
	if (!rows) return false;
	for (const value of values) {
		if (!isPersistenceRow(value)) return false;
		rows.delete(value.id as string);
	}
	return true;
}

function applyFormalMutationToPersistenceMirror(
	persistence: PersistenceState | undefined,
	collection: string,
	method: string,
	value: unknown,
) {
	if (!persistence?.mirrorEligibleCollections.has(collection)) return;
	const record =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: undefined;
	let applied = false;
	switch (method) {
		case "create":
		case "update":
			applied = mirrorUpsertRows(persistence, collection, [value]);
			break;
		case "createMany":
			applied =
				Array.isArray(record?.created) &&
				mirrorUpsertRows(persistence, collection, record.created);
			break;
		case "updateMany":
			applied =
				Array.isArray(record?.updated) &&
				mirrorUpsertRows(persistence, collection, record.updated);
			break;
		case "delete":
			applied = mirrorDeleteRows(persistence, collection, [value]);
			break;
		case "deleteMany":
			applied =
				Array.isArray(record?.deleted) &&
				mirrorDeleteRows(persistence, collection, record.deleted);
			break;
		case "upsert":
			if (isPersistenceRow(value)) {
				const stored = { ...value };
				delete stored.__action;
				applied = mirrorUpsertRows(persistence, collection, [stored]);
			}
			break;
		case "upsertMany":
			applied =
				Array.isArray(record?.created) &&
				Array.isArray(record?.updated) &&
				mirrorUpsertRows(persistence, collection, [
					...record.created,
					...record.updated,
				]);
			break;
	}
	if (!applied) invalidatePersistenceMirror(persistence, collection, method);
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
		markCollectionDirty(persistence, collection.name);
		if (writeKey) persistence?.saver.schedule(writeKey);
	};
	return {
		[PREDICATE_BULK_OPERATION]: (
			method: "updateMany" | "deleteMany",
			selectIds: (
				rows: ReadonlyArray<Record<string, unknown>>,
			) => ReadonlyArray<string>,
			data: unknown,
			options?: { readonly soft?: boolean },
		) => {
			try {
				ensureWritable(method);
			} catch (error) {
				return Promise.reject(error);
			}
			let writeScheduled = false;
			const scheduleWriteOnce = () => {
				if (writeScheduled) return;
				writeScheduled = true;
				scheduleWrite();
			};
			return runtime.invokePredicateBulk<{ readonly count?: number }>(
				method,
				collection.name,
				selectIds,
				data,
				options,
				() => {
					invalidatePersistenceMirror(
						persistence,
						collection.name,
						"predicate-callback-mutation",
					);
					scheduleWriteOnce();
				},
				(value) => {
					applyFormalMutationToPersistenceMirror(
						persistence,
						collection.name,
						method,
						value,
					);
					if ((value.count ?? 0) > 0) scheduleWriteOnce();
				},
			);
		},
		query: ((config?: any) => {
			if (config?.cursor) {
				return settledPromise(() => {
					validateCursorConfig(config.cursor);
					return runtime.invoke<any>("queryCursor", {
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
				}).then((page) => ({
					...page,
					items: applySelectionOrder(page.items, config.select),
				}));
			}
			return runtime
				.invoke<any[]>("query", {
					collection: collection.name,
					query: {
						where: config?.where,
						sort: config?.sort,
						offset: config?.offset,
						limit: config?.limit,
						select: config?.select,
					},
					populate: config?.populate,
				})
				.then((rows) => applySelectionOrder(rows, config?.select));
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
		findById: (id: string) => runtime.invokeFindById<any>(collection.name, id),
		exists: async (id: string) => {
			const results = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			return results.length > 0;
		},
		create: (input: any) =>
			settledPromise(() => {
				ensureWritable("create");
				const payload = { collection: collection.name, data: input };
				const finish = (value: any) => {
					applyFormalMutationToPersistenceMirror(
						persistence,
						collection.name,
						"create",
						value,
					);
					scheduleWrite();
					return value;
				};
				if (!isAppendOnlyJsonLinesCollection(collection)) {
					return runtime.invokeMapped("create", payload, finish);
				}
				return runtime.invoke<any>("create", payload).then(async (value) => {
					await appendAppendOnlyEntities(persistence, collection, [value]);
					return finish(value);
				});
			}),
		createMany: async (inputs: ReadonlyArray<any>, options?: any) => {
			ensureWritable("createMany");
			const value = await runtime.invoke<any>("createMany", {
				collection: collection.name,
				items: [...inputs],
				skipDuplicates: options?.skipDuplicates ?? false,
			});
			await appendAppendOnlyEntities(
				persistence,
				collection,
				value.created ?? [],
			);
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"createMany",
				value,
			);
			if ((value.created ?? []).length > 0) scheduleWrite();
			return value;
		},
		update: async (id: string, updates: any) => {
			ensureWritable("update");
			const value = await runtime.invoke<any>("update", {
				collection: collection.name,
				id,
				data: updates,
			});
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"update",
				value,
			);
			scheduleWrite();
			return value;
		},
		updateMany: async (where: any, updates: any) => {
			ensureWritable("updateMany");
			const value = await runtime.invoke<any>("updateMany", {
				collection: collection.name,
				where,
				data: updates,
			});
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"updateMany",
				value,
			);
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
				if (!mirrorUpsertRows(persistence, collection.name, value.deleted))
					invalidatePersistenceMirror(
						persistence,
						collection.name,
						"soft-delete",
					);
				scheduleWrite();
				return value.deleted[0];
			}
			const value = await runtime.invoke<any>("delete", {
				collection: collection.name,
				id,
			});
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"delete",
				value,
			);
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
			if (options?.soft) {
				if (
					!mirrorUpsertRows(persistence, collection.name, value.deleted ?? [])
				)
					invalidatePersistenceMirror(
						persistence,
						collection.name,
						"soft-delete-many",
					);
			} else {
				applyFormalMutationToPersistenceMirror(
					persistence,
					collection.name,
					"deleteMany",
					value,
				);
			}
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
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"upsert",
				value,
			);
			scheduleWrite();
			return value;
		},
		upsertMany: async (inputs: ReadonlyArray<any>) => {
			ensureWritable("upsertMany");
			const value = await runtime.invoke<any>("upsertMany", {
				collection: collection.name,
				items: [...inputs],
			});
			applyFormalMutationToPersistenceMirror(
				persistence,
				collection.name,
				"upsertMany",
				value,
			);
			if ((value.created?.length ?? 0) + (value.updated?.length ?? 0) > 0)
				scheduleWrite();
			return value;
		},
		createWithRelationships: async (input: any) => {
			ensureWritable("createWithRelationships");
			const value = await runtime.invoke<any>("createWithRelationships", {
				collection: collection.name,
				data: input,
			});
			invalidateAllPersistenceMirrors(persistence, "relationship-create");
			scheduleWrite();
			return value;
		},
		updateWithRelationships: async (id: string, input: any) => {
			ensureWritable("updateWithRelationships");
			const value = await runtime.invoke<any>("updateWithRelationships", {
				collection: collection.name,
				id,
				data: input,
			});
			invalidateAllPersistenceMirrors(persistence, "relationship-update");
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
			invalidateAllPersistenceMirrors(persistence, "relationship-delete");
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
			invalidateAllPersistenceMirrors(persistence, "relationship-delete-many");
			if ((value.count ?? 0) > 0) scheduleWrite();
			return value;
		},
		watch: (config?: any) => runtime.watch(collection.name, config),
		watchById: (id: string, options?: any) =>
			runtime.watchById(collection.name, id, options?.debounceMs),
	} as EngineCollection<any> & Record<symbol, unknown>;
}

async function loadLegacyCollections(
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	initialData: EngineInitialData<DatabaseConfig> | undefined,
	host: EngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<LoadedCollectionsResult> {
	const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	const baselines: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
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
								...(collection.raw.version !== undefined
									? { version: collection.raw.version }
									: {}),
								...(collection.raw.migrations
									? {
											migrations: collection.raw
												.migrations as ReadonlyArray<Migration>,
										}
									: {}),
							})),
						),
						layer,
					),
				)
			: undefined;
		for (const collection of group.collections) {
			const baselineRows = [...(loaded?.[collection.name]?.values() ?? [])];
			baselines[collection.name] = baselineRows;
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
									...(collection.raw.version !== undefined
										? { version: collection.raw.version }
										: {}),
									...(collection.raw.migrations
										? {
												migrations: collection.raw
													.migrations as ReadonlyArray<Migration>,
											}
										: {}),
									collectionName: collection.name,
								},
							),
							layer,
						),
					)
				: undefined;
			baselines[collection.name] = [...(loaded?.values() ?? [])];
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
								...(collection.raw.version !== undefined
									? { version: collection.raw.version }
									: {}),
								...(collection.raw.migrations
									? {
											migrations: collection.raw
												.migrations as ReadonlyArray<Migration>,
										}
									: {}),
								collectionName: collection.name,
								...(collection.raw.format
									? { format: collection.raw.format }
									: {}),
								...(collection.raw.path ? { path: collection.raw.path } : {}),
								...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
								...(collection.raw.validation
									? { validation: collection.raw.validation }
									: {}),
							}),
							layer,
						),
					)
				: undefined;
			baselines[collection.name] = [...(loaded?.values() ?? [])];
			result[collection.name] = mergeLoadedWithInitial(
				loaded,
				initialData?.[collection.name as never],
			);
			continue;
		}
		baselines[collection.name] = [];
		result[collection.name] = normalizeInitialCollection(
			initialData?.[collection.name as never],
		);
	}
	return { collections: result, baselines };
}

async function loadSourceOrientedCollections(
	config: Extract<
		DatabaseConfig,
		{ readonly collections: Record<string, CollectionConfig> }
	>,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	initialData: EngineInitialData<DatabaseConfig> | undefined,
	host: EngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<LoadedCollectionsResult> {
	void host;
	const normalizedConfig = normalizeSourceConfig(config);
	const loadedDocuments = normalizedConfig.sources.length
		? await Effect.runPromise(
				Effect.provide(loadDocumentSources(normalizedConfig), layer),
			)
		: undefined;
	const graphOwnedCollections = new Set(
		normalizedConfig.sources
			.filter((source) => source.kind === "documentGraph")
			.flatMap((source) => source.collections),
	);
	for (const collectionName of graphOwnedCollections) {
		if (
			(initialData as Record<string, unknown> | undefined)?.[collectionName] !==
			undefined
		) {
			throw new SourceConfigError({
				message: `Collection '${collectionName}' is backed by a read-only documentGraph source and cannot accept initialData`,
				collection: collectionName,
			});
		}
	}
	const loadedGraph = graphOwnedCollections.size
		? await Effect.runPromise(
				Effect.provide(loadDocumentGraphSources(normalizedConfig), layer),
			)
		: undefined;
	const writableSourceByCollection = new Map<string, string>();
	for (const source of normalizedConfig.sources) {
		if (source.kind !== "documents") continue;
		for (const collection of source.collections) {
			writableSourceByCollection.set(collection, source.id);
		}
	}
	const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	const baselines: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	for (const collection of collections) {
		const loaded =
			loadedGraph?.collections[collection.name] ??
			loadedDocuments?.collections[collection.name] ??
			new Map<string, Record<string, unknown>>();
		baselines[collection.name] = [...loaded.values()];
		result[collection.name] = mergeLoadedWithInitial(
			loaded,
			initialData?.[collection.name as never],
		);
	}
	return {
		collections: result,
		baselines,
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
	host: EngineStorageHost,
	layer: Layer.Layer<any>,
	writeDebounce: number,
	initialCollections: Record<string, ReadonlyArray<Record<string, unknown>>>,
	serializerRegistry?: SerializerRegistryShape,
	persistObjectFile?: (
		path: string,
		data: unknown,
		format: string,
	) => Promise<void>,
	mirrorWritesUseConfiguredStorage = true,
	initialBaselines?: Record<string, ReadonlyArray<Record<string, unknown>>>,
	sourceState?: SourcePersistenceState,
): PersistenceState {
	const sharedFiles = buildSharedFileGroups(collections);
	const directoryIds = initializeDirectoryIds(runtime, collections);
	const writeKeyByCollection = buildWriteKeyByCollection(
		collections,
		sharedFiles,
		sourceState,
	);
	const collectionBaselines = initializeCollectionBaselines(
		runtime,
		collections,
		initialBaselines,
	);
	const mirrorEligibleCollections = new Set(
		collections.flatMap((collection) => {
			const format = inferCollectionFormat(collection.raw);
			const ordinaryObjectFile =
				collection.raw.file !== undefined &&
				collection.raw.directory === undefined &&
				collection.raw.path === undefined &&
				collection.raw.version === undefined &&
				collection.raw.id === undefined &&
				collection.raw.appendOnly !== true &&
				format !== undefined &&
				OBJECT_KEYED_ONLY_FORMATS.has(format) &&
				!sharedFiles.some((group) => group.file === collection.raw.file);
			return serializerRegistry !== undefined &&
				mirrorWritesUseConfiguredStorage &&
				ordinaryObjectFile &&
				!isBrowserStorageHost(host) &&
				sourceState === undefined &&
				runtime.canUseIdentityPersistence(collection.name)
				? [collection.name]
				: [];
		}),
	);
	const collectionMirrors = new Map<string, PersistenceMirrorState>();
	for (const collection of mirrorEligibleCollections) {
		collectionMirrors.set(collection, {
			_tag: "valid",
			rows: toEntityMap(initialCollections[collection] ?? []),
		});
	}
	const state: PersistenceState = {
		host,
		layer,
		serializerRegistry,
		persistObjectFile,
		collectionMirrors,
		mirrorEligibleCollections,
		collections,
		sharedFiles,
		directoryIds,
		writeKeyByCollection,
		collectionBaselines,
		dirtyCollections: new Set<string>(),
		collectionsAwaitingExternalMerge: new Set<string>(),
		sourceState,
		watcherStops: [],
		backgroundReloads: new Set<Promise<void>>(),
		lifecycle: { status: "open" },
		backgroundError: undefined,
		saver: new DebouncedSaver(writeDebounce, async (key) => {
			await persistCollectionState(state, runtime, key);
		}),
	};
	runtime.setProjectionSynchronizationListener((changedCollections) => {
		for (const collection of changedCollections) {
			invalidatePersistenceMirror(
				state,
				collection,
				"caller-mutated-projection",
			);
		}
	});
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
	runtime.synchronizeForPersistence();
	if (state.sourceState && key.startsWith("source:")) {
		const sourceId = key.slice("source:".length);
		await persistDocumentSourceState(state, runtime, sourceId);
		for (const collection of state.collections) {
			if (
				state.sourceState.writableSourceByCollection.get(collection.name) !==
				sourceId
			)
				continue;
			const rows = await runtime.invoke<Record<string, unknown>[]>(
				"dumpCollection",
				{ collection: collection.name },
			);
			markCollectionPersisted(state, collection, rows);
		}
		return;
	}
	const sharedFile = state.sharedFiles.find(
		(group) => `file:${group.file}` === key,
	);
	if (sharedFile) {
		const rowsByCollection = new Map<
			string,
			ReadonlyArray<Record<string, unknown>>
		>();
		const data = await Promise.all(
			sharedFile.collections.map(async (collection) => {
				const rows = await runtime.invoke<Record<string, unknown>[]>(
					"dumpCollection",
					{ collection: collection.name },
				);
				rowsByCollection.set(collection.name, rows);
				return {
					name: collection.name,
					schema: collection.schema as never,
					data: toEntityMap(rows),
					...(collection.raw.version !== undefined
						? { version: collection.raw.version }
						: {}),
				};
			}),
		);
		await Effect.runPromise(
			Effect.provide(
				saveCollectionsToFile(sharedFile.file, data as never),
				state.layer,
			),
		);
		for (const collection of sharedFile.collections) {
			const rows = rowsByCollection.get(collection.name) ?? [];
			markCollectionPersisted(state, collection, rows);
		}
		return;
	}
	const fileCollections = state.collections.filter(
		(candidate) => candidate.raw.file && `file:${candidate.raw.file}` === key,
	);
	if (
		fileCollections.length > 0 &&
		(fileCollections.length > 1 || fileCollections[0]?.raw.path)
	) {
		for (const collection of fileCollections) {
			const entities = await runtime.invoke<Record<string, unknown>[]>(
				"dumpCollection",
				{
					collection: collection.name,
				},
			);
			const map = toEntityMap(entities);
			await Effect.runPromise(
				Effect.provide(
					saveData(
						collection.raw.file!,
						collection.schema as never,
						map as never,
						{
							...(collection.raw.version !== undefined
								? { version: collection.raw.version }
								: {}),
							...(collection.raw.format
								? { format: collection.raw.format }
								: {}),
							...(collection.raw.path ? { path: collection.raw.path } : {}),
							...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
						},
					),
					state.layer,
				),
			);
			markCollectionPersisted(state, collection, entities);
		}
		return;
	}
	const collection = state.collections.find(
		(candidate) => state.writeKeyByCollection.get(candidate.name) === key,
	);
	if (!collection) {
		throw new CollectionNotFoundError({
			collection: key,
			message: `Collection '${key}' not found`,
		});
	}
	const mirror = state.collectionMirrors.get(collection.name);
	if (
		mirror?._tag === "valid" &&
		state.serializerRegistry !== undefined &&
		collection.raw.file !== undefined
	) {
		const format = inferCollectionFormat(collection.raw);
		if (format !== undefined) {
			const rows = [...mirror.rows.values()];
			const entityMap = Object.fromEntries(mirror.rows);
			if (state.persistObjectFile) {
				await state.persistObjectFile(collection.raw.file, entityMap, format);
			} else {
				const content = await Effect.runPromise(
					state.serializerRegistry.serialize(entityMap, format),
				);
				try {
					await state.host.ensureDir(collection.raw.file);
				} catch (error) {
					throw toEngineStorageError(collection.raw.file, "write", error);
				}
				try {
					await state.host.write(collection.raw.file, content);
				} catch (error) {
					throw toEngineStorageError(collection.raw.file, "write", error);
				}
			}
			markCollectionPersisted(state, collection, rows);
			return;
		}
	}
	let entities = await runtime.invoke<Record<string, unknown>[]>(
		"dumpCollection",
		{ collection: collection.name },
	);
	let map = toEntityMap(entities);
	if (
		isBrowserStorageHost(state.host) &&
		state.dirtyCollections.has(collection.name) &&
		(collection.raw.directory || collection.raw.file)
	) {
		const baseline =
			state.collectionBaselines.get(collection.name) ??
			new Map<string, Record<string, unknown>>();
		const baselineRows = [...baseline.values()];
		const externalRows = await loadLegacyCollectionRows(
			collection,
			state.host,
			state.layer,
		);
		if (rowsFingerprint(baselineRows) !== rowsFingerprint(externalRows)) {
			const mergedRows = mergeExternalRowsWithLocalDelta(
				baseline,
				externalRows,
				entities,
			);
			await reloadCollectionIfChanged(runtime, collection.name, mergedRows);
			entities = mergedRows;
			map = toEntityMap(entities);
		}
	}
	if (collection.raw.directory) {
		const currentIds = new Set(map.keys());
		const previousIds =
			state.directoryIds.get(collection.name) ?? new Set<string>();
		for (const id of previousIds) {
			if (!currentIds.has(id)) {
				await Effect.runPromise(
					Effect.provide(
						removeEntityFromDirectory(
							collection.raw.directory,
							id,
							collection.raw.format ?? "json",
						),
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
		markCollectionPersisted(state, collection, entities);
		return;
	}
	if (collection.raw.file) {
		await Effect.runPromise(
			Effect.provide(
				saveData(
					collection.raw.file,
					collection.schema as never,
					map as never,
					{
						...(collection.raw.version !== undefined
							? { version: collection.raw.version }
							: {}),
						...(collection.raw.format ? { format: collection.raw.format } : {}),
						...(collection.raw.path ? { path: collection.raw.path } : {}),
						...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
					},
				),
				state.layer,
			),
		);
		markCollectionPersisted(state, collection, entities);
	}
}

async function persistDocumentSourceState(
	state: PersistenceState,
	runtime: EngineRuntime,
	sourceId: string,
): Promise<void> {
	const sourceState = state.sourceState;
	if (!sourceState) return;
	const snapshot =
		await runtime.invoke<
			Record<string, ReadonlyArray<Record<string, unknown>>>
		>("dumpAll");
	const collections = Object.fromEntries(
		Object.entries(snapshot).map(([collection, rows]) => [
			collection,
			toEntityMap(rows),
		]),
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

function initializeCollectionBaselines(
	runtime: EngineRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	initialBaselines?: Record<string, ReadonlyArray<Record<string, unknown>>>,
) {
	const baselines = new Map<
		string,
		ReadonlyMap<string, Record<string, unknown>>
	>();
	for (const collection of collections) {
		const rows =
			initialBaselines?.[collection.name] ??
			runtime.dispatch<Record<string, unknown>[]>("dumpCollection", {
				collection: collection.name,
			});
		baselines.set(collection.name, toEntityMap(rows));
	}
	return baselines;
}

function buildWriteKeyByCollection(
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	sharedFiles: ReadonlyArray<SharedFileGroup>,
	sourceState?: SourcePersistenceState,
) {
	const keys = new Map<string, string>();
	for (const collection of collections) {
		const sourceId = sourceState?.writableSourceByCollection.get(
			collection.name,
		);
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

function isBrowserStorageHost(
	host: EngineStorageHost | undefined,
): host is EngineStorageHost & { readonly __proseqlBrowserStorageHost: true } {
	return host?.__proseqlBrowserStorageHost === true;
}

function markCollectionDirty(
	persistence: PersistenceState | undefined,
	collection: string,
) {
	if (!persistence || !isBrowserStorageHost(persistence.host)) return;
	persistence.dirtyCollections.add(collection);
}

function updateCollectionBaseline(
	persistence: PersistenceState,
	collection: string,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	persistence.collectionBaselines.set(collection, toEntityMap(rows));
	persistence.dirtyCollections.delete(collection);
}

function markCollectionPersisted(
	persistence: PersistenceState,
	collection: CollectionRuntimeConfig,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	updateDirectoryBaseline(persistence, collection, rows);
	updateCollectionBaseline(persistence, collection.name, rows);
	refreshPersistenceMirror(persistence, collection.name, rows);
	if (
		isBrowserStorageHost(persistence.host) &&
		(collection.raw.directory || collection.raw.file)
	) {
		persistence.collectionsAwaitingExternalMerge.add(collection.name);
	}
}

function mergeExternalRowsWithLocalDelta(
	baseline: ReadonlyMap<string, Record<string, unknown>>,
	externalRows: ReadonlyArray<Record<string, unknown>>,
	localRows: ReadonlyArray<Record<string, unknown>>,
) {
	const external = new Map(toEntityMap(externalRows));
	const local = toEntityMap(localRows);
	const merged = new Map(external);
	for (const [id, row] of local) {
		const baselineRow = baseline.get(id);
		if (
			baselineRow === undefined ||
			rowsFingerprint([baselineRow]) !== rowsFingerprint([row])
		) {
			merged.set(id, row);
		}
	}
	for (const [id] of baseline) {
		if (!local.has(id)) {
			merged.delete(id);
		}
	}
	return [...merged.values()];
}

function mergeExternalRowsWithPersistedBaseline(
	baseline: ReadonlyMap<string, Record<string, unknown>>,
	externalRows: ReadonlyArray<Record<string, unknown>>,
) {
	const external = new Map(toEntityMap(externalRows));
	const missingBaselineRows = [...baseline.entries()].filter(
		([id]) => !external.has(id),
	);
	const hasExternalAddition = [...external.keys()].some(
		(id) => !baseline.has(id),
	);
	const hasExternalMutation = [...external.entries()].some(([id, row]) => {
		const baselineRow = baseline.get(id);
		return (
			baselineRow !== undefined &&
			rowsFingerprint([baselineRow]) !== rowsFingerprint([row])
		);
	});
	if (
		missingBaselineRows.length === 0 ||
		(!hasExternalAddition && !hasExternalMutation)
	) {
		return externalRows;
	}
	const merged = new Map(external);
	for (const [id, row] of missingBaselineRows) {
		merged.set(id, row);
	}
	return [...merged.values()];
}

function clearBackgroundError(persistence: PersistenceState) {
	persistence.backgroundError = undefined;
}

function reportBackgroundReloadError(error: unknown) {
	console.error("[proseql/engine] external reload failed", error);
}

function isPersistenceOpen(persistence: PersistenceState) {
	return persistence.lifecycle.status === "open";
}

function trackBackgroundReload(
	persistence: PersistenceState,
	task: Promise<void>,
) {
	persistence.backgroundReloads.add(task);
	void task.finally(() => {
		persistence.backgroundReloads.delete(task);
	});
}

async function waitForBackgroundReloads(persistence: PersistenceState) {
	while (persistence.backgroundReloads.size > 0) {
		await Promise.allSettled([...persistence.backgroundReloads]);
	}
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

async function currentCollectionRows(
	runtime: EngineRuntime,
	collection: string,
) {
	return runtime.invoke<Record<string, unknown>[]>("dumpCollection", {
		collection,
	});
}

async function reloadCollectionIfChanged(
	runtime: EngineRuntime,
	collection: string,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	const changedCollections = await reloadCollectionsAtomicallyIfChanged(
		runtime,
		{
			[collection]: rows,
		},
	);
	return changedCollections.includes(collection);
}

async function reloadCollectionsAtomicallyIfChanged(
	runtime: EngineRuntime,
	rowsByCollection: Record<string, ReadonlyArray<Record<string, unknown>>>,
) {
	const changedEntries: Array<
		readonly [string, ReadonlyArray<Record<string, unknown>>]
	> = [];
	for (const [collection, rows] of Object.entries(rowsByCollection)) {
		const current = await currentCollectionRows(runtime, collection);
		if (rowsFingerprint(current) !== rowsFingerprint(rows)) {
			changedEntries.push([collection, rows]);
		}
	}
	if (changedEntries.length === 0) return [] as ReadonlyArray<string>;
	const txRuntime = await runtime.createTemporaryTransactionRuntime();
	try {
		for (const [collection, rows] of changedEntries) {
			await txRuntime.invoke("reloadCollection", { collection, records: rows });
		}
		const snapshot =
			await txRuntime.invoke<
				Record<string, ReadonlyArray<Record<string, unknown>>>
			>("dumpAll");
		const committed = await runtime.invoke<{
			changedCollections: ReadonlyArray<string>;
		}>("commitSnapshotTransaction", { collections: snapshot });
		return committed.changedCollections;
	} finally {
		await txRuntime.drop().catch(() => undefined);
	}
}

async function persistCollectionRowsDirect(
	persistence: PersistenceState,
	collection: CollectionRuntimeConfig,
	rows: ReadonlyArray<Record<string, unknown>>,
) {
	const map = toEntityMap(rows);
	if (collection.raw.directory) {
		const currentIds = new Set(map.keys());
		const previousIds =
			persistence.directoryIds.get(collection.name) ?? new Set<string>();
		for (const id of previousIds) {
			if (!currentIds.has(id)) {
				await Effect.runPromise(
					Effect.provide(
						removeEntityFromDirectory(
							collection.raw.directory,
							id,
							collection.raw.format ?? "json",
						),
						persistence.layer,
					),
				);
			}
		}
		for (const entity of rows) {
			await Effect.runPromise(
				Effect.provide(
					saveEntityToDirectory(
						collection.raw.directory,
						entity as never,
						collection.schema as never,
						collection.raw.format ?? "json",
					),
					persistence.layer,
				),
			);
		}
		persistence.directoryIds.set(collection.name, currentIds);
		markCollectionPersisted(persistence, collection, rows);
		return;
	}
	if (collection.raw.file) {
		await Effect.runPromise(
			Effect.provide(
				saveData(
					collection.raw.file,
					collection.schema as never,
					map as never,
					{
						...(collection.raw.version !== undefined
							? { version: collection.raw.version }
							: {}),
						...(collection.raw.format ? { format: collection.raw.format } : {}),
						...(collection.raw.path ? { path: collection.raw.path } : {}),
						...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
					},
				),
				persistence.layer,
			),
		);
		markCollectionPersisted(persistence, collection, rows);
	}
}

async function reconcileCollectionWithExternalRows(
	persistence: PersistenceState,
	runtime: EngineRuntime,
	collection: CollectionRuntimeConfig,
	externalRows: ReadonlyArray<Record<string, unknown>>,
) {
	const baseline =
		persistence.collectionBaselines.get(collection.name) ??
		new Map<string, Record<string, unknown>>();
	if (persistence.dirtyCollections.has(collection.name)) {
		const localRows = await currentCollectionRows(runtime, collection.name);
		const mergedRows = mergeExternalRowsWithLocalDelta(
			baseline,
			externalRows,
			localRows,
		);
		await reloadCollectionIfChanged(runtime, collection.name, mergedRows);
		await persistCollectionRowsDirect(persistence, collection, mergedRows);
		persistence.collectionsAwaitingExternalMerge.delete(collection.name);
		return;
	}
	if (persistence.collectionsAwaitingExternalMerge.has(collection.name)) {
		const mergedRows = mergeExternalRowsWithPersistedBaseline(
			baseline,
			externalRows,
		);
		if (rowsFingerprint(mergedRows) !== rowsFingerprint(externalRows)) {
			await reloadCollectionIfChanged(runtime, collection.name, mergedRows);
			await persistCollectionRowsDirect(persistence, collection, mergedRows);
			persistence.collectionsAwaitingExternalMerge.delete(collection.name);
			return;
		}
		persistence.collectionsAwaitingExternalMerge.delete(collection.name);
	}
	if (await reloadCollectionIfChanged(runtime, collection.name, externalRows)) {
		updateDirectoryBaseline(persistence, collection, externalRows);
	}
	persistence.collectionsAwaitingExternalMerge.delete(collection.name);
	updateCollectionBaseline(persistence, collection.name, externalRows);
	refreshPersistenceMirror(persistence, collection.name, externalRows);
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
	return matchesComparableFile(filename, file);
}

function touchesWatchedDirectory(filename: string | null, directory: string) {
	return isWithinComparableDirectory(filename, directory);
}

function runBackgroundReload(
	persistence: PersistenceState,
	task: () => Promise<void>,
	options?: { readonly skipFlush?: boolean },
) {
	if (!isPersistenceOpen(persistence)) return;
	const reloadTask = promiseCall(async () => {
		if (!isPersistenceOpen(persistence)) return;
		if (!options?.skipFlush) {
			try {
				await persistence.saver.flush();
			} catch {
				return;
			}
		}
		try {
			await task();
			clearBackgroundError(persistence);
		} catch (error) {
			reportBackgroundReloadError(error);
		}
	}).catch((error) => {
		reportBackgroundReloadError(error);
	});
	trackBackgroundReload(persistence, reloadTask);
}

async function loadLegacyCollectionRows(
	collection: CollectionRuntimeConfig,
	host: EngineStorageHost,
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
						...(collection.raw.version !== undefined
							? { version: collection.raw.version }
							: {}),
						...(collection.raw.migrations
							? {
									migrations: collection.raw
										.migrations as ReadonlyArray<Migration>,
								}
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
					...(collection.raw.version !== undefined
						? { version: collection.raw.version }
						: {}),
					...(collection.raw.migrations
						? {
								migrations: collection.raw
									.migrations as ReadonlyArray<Migration>,
							}
						: {}),
					collectionName: collection.name,
					...(collection.raw.format ? { format: collection.raw.format } : {}),
					...(collection.raw.path ? { path: collection.raw.path } : {}),
					...(collection.raw.id ? { derivedId: collection.raw.id } : {}),
					...(collection.raw.validation
						? { validation: collection.raw.validation }
						: {}),
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
	host: EngineStorageHost,
	layer: Layer.Layer<any>,
) {
	if (
		group.collections.length > 1 &&
		group.collections.every((collection) => !collection.raw.path)
	) {
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
						...(collection.raw.version !== undefined
							? { version: collection.raw.version }
							: {}),
						...(collection.raw.migrations
							? {
									migrations: collection.raw
										.migrations as ReadonlyArray<Migration>,
								}
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
		result[collection.name] = await loadLegacyCollectionRows(
			collection,
			host,
			layer,
		);
	}
	return result;
}

async function registerLegacyWatchers(
	runtime: EngineRuntime,
	persistence: PersistenceState,
) {
	const fileGroups = new Map<string, CollectionRuntimeConfig[]>();
	for (const collection of persistence.collections) {
		if (!collection.raw.file) continue;
		const group = fileGroups.get(collection.raw.file) ?? [];
		group.push(collection);
		fileGroups.set(collection.raw.file, group);
	}

	for (const [file, collections] of fileGroups) {
		const supportsDirtyMerge =
			isBrowserStorageHost(persistence.host) &&
			collections.length === 1 &&
			!collections[0]?.raw.path;
		const reload = () => {
			runBackgroundReload(
				persistence,
				async () => {
					const rowsByCollection = await loadLegacyFileCollections(
						{ file, collections },
						persistence.host,
						persistence.layer,
					);
					for (const collection of collections) {
						const rows = rowsByCollection[collection.name] ?? [];
						if (supportsDirtyMerge) {
							await reconcileCollectionWithExternalRows(
								persistence,
								runtime,
								collection,
								rows,
							);
							continue;
						}
						await reloadCollectionIfChanged(runtime, collection.name, rows);
						persistence.collectionsAwaitingExternalMerge.delete(
							collection.name,
						);
						updateCollectionBaseline(persistence, collection.name, rows);
						refreshPersistenceMirror(persistence, collection.name, rows);
					}
				},
				{ skipFlush: supportsDirtyMerge },
			);
		};
		if (await persistence.host.exists(file)) {
			const stop = await persistence.host.watch(file, reload);
			trackWatcherStop(persistence, stop);
			continue;
		}
		const watchRoot = dirnameComparable(file);
		if (!supportsDirtyMerge && !(await persistence.host.exists(watchRoot)))
			continue;
		try {
			const stop = await persistence.host.watchDir(watchRoot, (event) => {
				if (!matchesWatchedFile(event.filename, file)) return;
				reload();
			});
			trackWatcherStop(persistence, stop);
		} catch {}
	}

	for (const collection of persistence.collections) {
		if (!collection.raw.directory) continue;
		const supportsDirtyMerge = isBrowserStorageHost(persistence.host);
		const watchRoot = (await persistence.host.exists(collection.raw.directory))
			? collection.raw.directory
			: dirnameComparable(collection.raw.directory);
		if (!supportsDirtyMerge && !(await persistence.host.exists(watchRoot)))
			continue;
		try {
			const stop = await persistence.host.watchDir(watchRoot, (event) => {
				if (!touchesWatchedDirectory(event.filename, collection.raw.directory!))
					return;
				runBackgroundReload(
					persistence,
					async () => {
						const rows = await loadLegacyCollectionRows(
							collection,
							persistence.host,
							persistence.layer,
						);
						if (supportsDirtyMerge) {
							await reconcileCollectionWithExternalRows(
								persistence,
								runtime,
								collection,
								rows,
							);
							return;
						}
						if (
							await reloadCollectionIfChanged(runtime, collection.name, rows)
						) {
							updateDirectoryBaseline(persistence, collection, rows);
						}
						refreshPersistenceMirror(persistence, collection.name, rows);
					},
					{ skipFlush: supportsDirtyMerge },
				);
			});
			trackWatcherStop(persistence, stop);
		} catch {}
	}
}

async function registerSourceWatchers(
	runtime: EngineRuntime,
	persistence: PersistenceState,
) {
	const sourceState = persistence.sourceState;
	if (!sourceState) return;
	for (const source of sourceState.normalizedConfig.sources) {
		if (source.kind === "documents") {
			const stop = await persistence.host.watchDir(source.root, () => {
				runBackgroundReload(persistence, async () => {
					const loaded = await Effect.runPromise(
						Effect.provide(
							loadDocumentSources(sourceState.normalizedConfig),
							persistence.layer,
						),
					);
					const rowsByCollection = Object.fromEntries(
						source.collections.map((collection) => [
							collection,
							[
								...(loaded.collections[collection]?.values() ?? []),
							] as ReadonlyArray<Record<string, unknown>>,
						]),
					) as Record<string, ReadonlyArray<Record<string, unknown>>>;
					await reloadCollectionsAtomicallyIfChanged(runtime, rowsByCollection);
					sourceState.documentsState.origins = loaded.origins;
					sourceState.documentsState.documents = loaded.documents;
				});
			});
			trackWatcherStop(persistence, stop);
			continue;
		}
		for (const root of source.roots) {
			const watchRoot = (await persistence.host.exists(root.root))
				? root.root
				: dirnameComparable(root.root);
			if (!(await persistence.host.exists(watchRoot))) continue;
			const stop = await persistence.host.watchDir(watchRoot, () => {
				runBackgroundReload(persistence, async () => {
					const loaded = await Effect.runPromise(
						Effect.provide(
							loadDocumentGraphSources(sourceState.normalizedConfig),
							persistence.layer,
						),
					);
					const rowsByCollection = Object.fromEntries(
						source.collections.map((collection) => [
							collection,
							[
								...(loaded.collections[collection]?.values() ?? []),
							] as ReadonlyArray<Record<string, unknown>>,
						]),
					) as Record<string, ReadonlyArray<Record<string, unknown>>>;
					await reloadCollectionsAtomicallyIfChanged(runtime, rowsByCollection);
					sourceState.graphState.provenance = loaded.provenance;
					sourceState.graphState.diagnostics = loaded.diagnostics;
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

function transactionBeginError(
	reason:
		| "nested transactions not supported"
		| "another transaction is already active"
		| "transaction is active; use transaction context",
) {
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
			transactionGate.context?.getStore() === true ||
				(!transactionGate.context && transactionGate.depth > 0)
				? "nested transactions not supported"
				: "another transaction is already active",
		);
	}
	transactionGate.active = true;
	transactionGate.depth += 1;
	let session: RuntimeTransactionSession | undefined;
	let finalized = false;
	const execute = async () => {
		session = runtime.beginTransactionSession();
		const sessionRuntime: TransactionStepRuntime = {
			invoke: <T>(method: string, payload?: unknown) =>
				runtime.invokeTransactionStep<T>(session!, method, payload),
		};
		const rollbackError = explicitRollbackError();
		const txFacade = buildTransactionDatabaseFacade(
			sessionRuntime,
			collections,
			persistence,
			rollbackError,
		);
		try {
			const result = await fn(txFacade as EngineTransactionDatabase<any>);
			const changedCollections = runtime.commitTransactionSession(session);
			finalized = true;
			for (const collection of changedCollections) {
				invalidatePersistenceMirror(
					persistence,
					collection,
					"transaction-commit",
				);
				markCollectionDirty(persistence, collection);
				const key = persistence?.writeKeyByCollection.get(collection);
				if (key) persistence?.saver.schedule(key);
			}
			return result;
		} catch (error) {
			if (!finalized) {
				try {
					runtime.rollbackTransactionSession(session);
				} catch {
					// Preserve the original callback or operation failure.
				}
				finalized = true;
			}
			throw error;
		}
	};
	try {
		return transactionGate.context
			? await transactionGate.context.run(true, execute)
			: await execute();
	} finally {
		transactionGate.depth = Math.max(0, transactionGate.depth - 1);
		if (session !== undefined) runtime.finishTransactionSession();
		transactionGate.active = false;
	}
}
type TransactionStepRuntime = {
	invoke<T>(method: string, payload?: unknown): Promise<T>;
};

function buildTransactionDatabaseFacade(
	runtime: TransactionStepRuntime,
	collections: ReadonlyArray<CollectionRuntimeConfig>,
	persistence: PersistenceState | undefined,
	rollbackError: TransactionError,
) {
	const db: Record<string, unknown> = {};
	for (const collection of collections) {
		db[collection.name] = buildTransactionCollectionFacade(
			runtime,
			collection,
			persistence,
		);
	}
	return Object.assign(db, {
		rollback: async () => {
			throw rollbackError;
		},
	});
}

function buildTransactionCollectionFacade(
	runtime: TransactionStepRuntime,
	collection: CollectionRuntimeConfig,
	persistence: PersistenceState | undefined,
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
	const push = (_operation: Record<string, unknown>) => undefined;
	return {
		query: (config?: any) =>
			config?.cursor
				? settledPromise(() => {
						validateCursorConfig(config.cursor);
						return runtime.invoke<any>("queryCursor", {
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
					}).then((page) => ({
						...page,
						items: applySelectionOrder(page.items, config.select),
					}))
				: runtime
						.invoke<any[]>("query", {
							collection: collection.name,
							query: {
								where: config?.where,
								sort: config?.sort,
								offset: config?.offset,
								limit: config?.limit,
								select: config?.select,
							},
							populate: config?.populate,
						})
						.then((rows) => applySelectionOrder(rows, config?.select)),
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
		findById: (id: string) =>
			runtime.invoke<any>("findById", {
				collection: collection.name,
				id,
			}),
		exists: async (id: string) => {
			const rows = await runtime.invoke<any[]>("query", {
				collection: collection.name,
				query: { where: { id }, limit: 1 },
			});
			return rows.length > 0;
		},
		create: async (input: any) => {
			ensureWritable("create");
			const value = await runtime.invoke<any>("create", {
				collection: collection.name,
				data: input,
			});
			push({ kind: "create", collection: collection.name, data: input });
			return value;
		},
		createMany: async (inputs: ReadonlyArray<any>, options?: any) => {
			ensureWritable("createMany");
			const items = [...inputs];
			const value = await runtime.invoke<any>("createMany", {
				collection: collection.name,
				items,
				skipDuplicates: options?.skipDuplicates ?? false,
			});
			push({
				kind: "createMany",
				collection: collection.name,
				items,
				skipDuplicates: options?.skipDuplicates ?? false,
			});
			return value;
		},
		update: async (id: string, data: any) => {
			ensureWritable("update");
			const value = await runtime.invoke<any>("update", {
				collection: collection.name,
				id,
				data,
			});
			push({ kind: "update", collection: collection.name, id, data });
			return value;
		},
		updateMany: async (where: any, data: any) => {
			ensureWritable("updateMany");
			const value = await runtime.invoke<any>("updateMany", {
				collection: collection.name,
				where,
				data,
			});
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
					throw new NotFoundError({
						collection: collection.name,
						id,
						message: `Entity with id "${id}" not found in collection "${collection.name}"`,
					});
				}
				push({
					kind: "deleteMany",
					collection: collection.name,
					where: { id },
					soft: true,
					limit: 1,
				});
				return value.deleted[0];
			}
			const value = await runtime.invoke<any>("delete", {
				collection: collection.name,
				id,
			});
			push({ kind: "delete", collection: collection.name, id });
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
			push({
				kind: "deleteMany",
				collection: collection.name,
				where,
				soft: options?.soft ?? false,
				limit: options?.limit,
			});
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
			push({
				kind: "upsert",
				collection: collection.name,
				where: input.where,
				create: input.create,
				update: input.update,
			});
			return value;
		},
		upsertMany: async (inputs: ReadonlyArray<any>) => {
			ensureWritable("upsertMany");
			const items = [...inputs];
			const value = await runtime.invoke<any>("upsertMany", {
				collection: collection.name,
				items,
			});
			push({ kind: "upsertMany", collection: collection.name, items });
			return value;
		},
		createWithRelationships: async (data: any) => {
			ensureWritable("createWithRelationships");
			const value = await runtime.invoke<any>("createWithRelationships", {
				collection: collection.name,
				data,
			});
			push({
				kind: "createWithRelationships",
				collection: collection.name,
				data,
			});
			return value;
		},
		updateWithRelationships: async (id: string, data: any) => {
			ensureWritable("updateWithRelationships");
			const value = await runtime.invoke<any>("updateWithRelationships", {
				collection: collection.name,
				id,
				data,
			});
			push({
				kind: "updateWithRelationships",
				collection: collection.name,
				id,
				data,
			});
			return value;
		},
		deleteWithRelationships: async (id: string, options?: any) => {
			ensureWritable("deleteWithRelationships");
			const value = await runtime.invoke<any>("deleteWithRelationships", {
				collection: collection.name,
				id,
				options,
			});
			push({
				kind: "deleteWithRelationships",
				collection: collection.name,
				id,
				options,
			});
			return value;
		},
		deleteManyWithRelationships: async (where: any, options?: any) => {
			ensureWritable("deleteManyWithRelationships");
			const value = await runtime.invoke<any>("deleteManyWithRelationships", {
				collection: collection.name,
				where,
				options,
			});
			push({
				kind: "deleteManyWithRelationships",
				collection: collection.name,
				where,
				options,
			});
			return value;
		},
		watch: (_config?: any) => {
			throw new OperationError({
				operation: "watch",
				reason: "unsupported-in-transaction",
				message: "watch() is not supported inside $transaction callbacks",
			});
		},
		watchById: (_id: string) => {
			throw new OperationError({
				operation: "watchById",
				reason: "unsupported-in-transaction",
				message: "watchById() is not supported inside $transaction callbacks",
			});
		},
	};
}

async function runDryRunMigrations(
	config: DatabaseConfig,
	_host: EngineStorageHost,
	layer: Layer.Layer<any>,
): Promise<DryRunResult> {
	return Effect.runPromise(
		Effect.provide(dryRunMigrations(config, {} as never), layer),
	);
}

function buildSharedFileGroups(
	collections: ReadonlyArray<CollectionRuntimeConfig>,
) {
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

function normalizeInitialCollection(
	value: unknown,
): ReadonlyArray<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null,
	);
}

function normalizeAggregateFields(value: unknown): ReadonlyArray<string> {
	if (value === undefined) return [];
	if (Array.isArray(value))
		return value.filter((field): field is string => typeof field === "string");
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
		return JSON.stringify({
			kind: "ok",
			value: JSON.parse(serializeBoundaryValue(value)),
		});
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

function isTaggedError(
	error: unknown,
): error is { readonly _tag: string } & Record<string, unknown> {
	return (
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		typeof (error as { _tag: unknown })._tag === "string"
	);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function isAsyncCallbackUnsupportedError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(
		"Async Effect callbacks are not supported by @proseql/engine",
	);
}

function encodeDataForCommand(data: unknown) {
	return encodeBoundaryValueForWire(data);
}

function encodeWhereForCommand(where: unknown) {
	return where === undefined ? undefined : encodeBoundaryValueForWire(where);
}

function encodeSortForCommand(sort: unknown): unknown {
	if (typeof sort !== "object" || sort === null || Array.isArray(sort)) {
		return sort;
	}
	return Object.entries(sort as Record<string, unknown>).map(
		([field, order]) => ({ field, order }),
	);
}

function normalizeQueryOffset(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const normalized = Math.max(0, Math.floor(value as number));
	if (Number.isNaN(normalized)) return 0;
	return Math.min(normalized, 0xffff_ffff);
}

function normalizeQueryLimit(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const normalized = Math.max(0, Math.floor(value as number));
	if (!Number.isFinite(normalized)) return undefined;
	return Math.min(normalized, 0xffff_ffff);
}

function prepareQueryConfigForCommand(config: unknown) {
	if (typeof config !== "object" || config === null) return config;
	const queryConfig = config as Record<string, unknown>;
	return {
		...queryConfig,
		where: encodeWhereForCommand(queryConfig.where),
		sort: encodeSortForCommand(queryConfig.sort),
		offset: normalizeQueryOffset(queryConfig.offset),
		limit: normalizeQueryLimit(queryConfig.limit),
	};
}

function prepareTransactionOperationForCommand(operation: unknown): unknown {
	if (typeof operation !== "object" || operation === null) return operation;
	const input = operation as Record<string, unknown>;
	switch (input.kind) {
		case "create":
		case "update":
		case "createWithRelationships":
		case "updateWithRelationships":
			return { ...input, data: encodeDataForCommand(input.data) };
		case "createMany":
			return {
				...input,
				items: Array.isArray(input.items)
					? input.items.map((item) => encodeDataForCommand(item))
					: input.items,
			};
		case "updateMany":
			return {
				...input,
				where: encodeWhereForCommand(input.where),
				data: encodeDataForCommand(input.data),
			};
		case "deleteMany":
		case "deleteManyWithRelationships":
		case "upsert":
			return {
				...input,
				where: encodeWhereForCommand(input.where),
				...(input.create !== undefined
					? { create: encodeDataForCommand(input.create) }
					: {}),
				...(input.update !== undefined
					? { update: encodeDataForCommand(input.update) }
					: {}),
			};
		case "upsertMany":
			return {
				...input,
				items: Array.isArray(input.items)
					? input.items.map((item) =>
							typeof item === "object" && item !== null
								? {
										...(item as Record<string, unknown>),
										where: encodeWhereForCommand(
											(item as Record<string, unknown>).where,
										),
										create: encodeDataForCommand(
											(item as Record<string, unknown>).create,
										),
										update: encodeDataForCommand(
											(item as Record<string, unknown>).update,
										),
									}
								: item,
						)
					: input.items,
			};
		default:
			return input;
	}
}

function prepareCommandPayload(method: string, payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const command = payload as Record<string, unknown>;
	switch (method) {
		case "query":
		case "queryCursor":
			return {
				...command,
				query: prepareQueryConfigForCommand(command.query),
			};
		case "aggregate":
		case "groupAggregate":
		case "deleteMany":
		case "deleteManyWithRelationships":
			return {
				...command,
				where: encodeWhereForCommand(command.where),
			};
		case "create":
		case "update":
		case "createWithRelationships":
		case "updateWithRelationships":
			return {
				...command,
				data: encodeDataForCommand(command.data),
			};
		case "createMany":
			return {
				...command,
				items: Array.isArray(command.items)
					? command.items.map((item) => encodeDataForCommand(item))
					: command.items,
			};
		case "updateMany":
			return {
				...command,
				where: encodeWhereForCommand(command.where),
				data: encodeDataForCommand(command.data),
			};
		case "upsert":
			return {
				...command,
				where: encodeWhereForCommand(command.where),
				create: encodeDataForCommand(command.create),
				update: encodeDataForCommand(command.update),
			};
		case "upsertMany":
			return {
				...command,
				items: Array.isArray(command.items)
					? command.items.map((item) =>
							typeof item === "object" && item !== null
								? {
										...(item as Record<string, unknown>),
										where: encodeWhereForCommand(
											(item as Record<string, unknown>).where,
										),
										create: encodeDataForCommand(
											(item as Record<string, unknown>).create,
										),
										update: encodeDataForCommand(
											(item as Record<string, unknown>).update,
										),
									}
								: item,
						)
					: command.items,
			};
		case "reloadCollection":
			return {
				...command,
				records: Array.isArray(command.records)
					? command.records.map((record) => encodeDataForCommand(record))
					: command.records,
			};
		case "commitSnapshotTransaction":
			return {
				...command,
				collections: encodeDataForCommand(command.collections),
			};
		case "transaction":
			return {
				...command,
				operations: Array.isArray(command.operations)
					? command.operations.map((operation) =>
							prepareTransactionOperationForCommand(operation),
						)
					: command.operations,
			};
		case "subscribeWatch":
			return {
				...command,
				config: prepareQueryConfigForCommand(command.config),
			};
		default:
			return command;
	}
}

function promiseCall<T>(fn: () => Promise<T>): Promise<T> {
	return Promise.resolve().then(fn);
}

function settledPromise<T>(fn: () => T): Promise<Awaited<T>> {
	try {
		return Promise.resolve(fn()) as Promise<Awaited<T>>;
	} catch (error) {
		return Promise.reject(error);
	}
}

function parseBridgeResponseValue<T>(
	parsed: BridgeResponse<T>,
	raw: string,
): T {
	switch (parsed.kind) {
		case "ok":
			return decodeBoundaryValueForHost(parsed.value);
		case "error":
			throw reconstructBoundaryError(decodeBoundaryValueForHost(parsed.error));
		case "defect":
			throw new WasmEngineDefectError(parsed.message);
		default:
			throw new Error(`Unknown bridge response: ${raw}`);
	}
}

function parseBridgeResponse<T>(raw: string): T {
	return parseBridgeResponseValue(JSON.parse(raw) as BridgeResponse<T>, raw);
}
