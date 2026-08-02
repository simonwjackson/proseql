import {
	CollectionNotFoundError,
	type CollectionConfig,
	type ConfiguredCollections,
	type DatabaseConfig,
	type DeleteManyResult,
	type DeleteWithRelationshipsOptions,
	DocumentGraphSourceError,
	DuplicateKeyError,
	DuplicatePhysicalFileError,
	DuplicateRecordError,
	type EffectDatabaseOptions,
	type EffectDatabasePersistenceConfig,
	ForeignKeyError,
	type GenerateDatabase,
	type GenerateDatabaseWithPersistence,
	getCollectionConfigs,
	HookError,
	InvalidDocumentSourceError,
	MigrationError,
	NotFoundError,
	OperationError,
	PluginError,
	PopulationError,
	type QueryConfig,
	SerializationError,
	SerializerRegistryService,
	type SerializerRegistryShape,
	type StorageAdapterShape,
	SourceConfigError,
	StorageAdapterService as StorageAdapter,
	StorageError,
	TransactionError,
	UnsupportedFormatError,
	UniqueConstraintError,
	UnknownCollectionError,
	type TransactionContext,
	type UpdateManyResult,
	ValidationError
} from "@proseql/core";
import type {
	EngineCollection,
	EngineDatabaseOptions,
	EngineInitialData,
	EnginePersistenceOptions,
	GenerateEngineDatabase,
	GenerateEngineDatabaseWithPersistence,
} from "@proseql/engine";
import { Effect, Layer, Queue, Stream } from "effect";

export type RunnableEffect<A, E> = Effect.Effect<A, E, never> & {
	readonly runPromise: Promise<A>;
};

export type RunnableStream<A, E> = Stream.Stream<A, E, never> & {
	readonly runPromise: Promise<ReadonlyArray<A>>;
};

type EffectEngineModule = {
	readonly createEngineDatabase: typeof import("@proseql/engine").createEngineDatabase;
	readonly createPersistentEngineDatabase: typeof import("@proseql/engine").createPersistentEngineDatabase;
	readonly WasmEngineDefectError: typeof import("@proseql/engine").WasmEngineDefectError;
};

let nodeEngineModulePromise: Promise<EffectEngineModule> | undefined;
let browserEngineModulePromise: Promise<EffectEngineModule> | undefined;

const loadNodeEngineModule = (): Promise<EffectEngineModule> =>
	nodeEngineModulePromise ??= import("@proseql/engine") as Promise<EffectEngineModule>;

const loadBrowserEngineModule = (): Promise<EffectEngineModule> =>
	browserEngineModulePromise ??= import("@proseql/engine/browser") as Promise<EffectEngineModule>;

type KnownCoreError =
	| NotFoundError
	| DuplicateKeyError
	| ForeignKeyError
	| ValidationError
	| UniqueConstraintError
	| OperationError
	| TransactionError
	| HookError
	| CollectionNotFoundError
	| PopulationError
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| SourceConfigError
	| UnknownCollectionError
	| DuplicateRecordError
	| DuplicatePhysicalFileError
	| InvalidDocumentSourceError
	| DocumentGraphSourceError
	| MigrationError
	| PluginError;

const knownErrorConstructors = [
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	UniqueConstraintError,
	OperationError,
	TransactionError,
	HookError,
	CollectionNotFoundError,
	PopulationError,
	StorageError,
	SerializationError,
	UnsupportedFormatError,
	SourceConfigError,
	UnknownCollectionError,
	DuplicateRecordError,
	DuplicatePhysicalFileError,
	InvalidDocumentSourceError,
	DocumentGraphSourceError,
	MigrationError,
	PluginError
] as const;

const joinComparablePath = (left: string, right: string): string => {
	const normalizedLeft = left.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
	const normalizedRight = right.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
	return normalizedLeft.length === 0 ? normalizedRight : `${normalizedLeft}/${normalizedRight}`;
};

const withRunPromise = <A, E>(effect: Effect.Effect<A, E, never>): RunnableEffect<A, E> => {
	let cached: Promise<A> | undefined;
	Object.defineProperty(effect, "runPromise", {
		get() {
			if (cached === undefined) {
				cached = Effect.runPromise(effect);
			}
			return cached;
		},
		enumerable: false,
		configurable: true
	});
	return effect as RunnableEffect<A, E>;
};

const withStreamRunPromise = <A, E>(stream: Stream.Stream<A, E, never>): RunnableStream<A, E> => {
	let cached: Promise<ReadonlyArray<A>> | undefined;
	Object.defineProperty(stream, "runPromise", {
		get() {
			if (cached === undefined) {
				cached = Effect.runPromise(Stream.runCollect(stream)) as Promise<ReadonlyArray<A>>;
			}
			return cached;
		},
		enumerable: false,
		configurable: true
	});
	return stream as RunnableStream<A, E>;
};

const isTaggedObject = (value: unknown): value is { _tag: string } =>
	typeof value === "object" && value !== null && "_tag" in value && typeof (value as { _tag?: unknown })._tag === "string";

const isKnownCoreError = (value: unknown): value is KnownCoreError =>
	knownErrorConstructors.some((Ctor) => value instanceof Ctor);

const isWasmEngineDefectError = (error: unknown): error is Error =>
	error instanceof Error && error.name === "WasmEngineDefectError";

const normalizeRejection = (error: unknown): Error => {
	if (error instanceof Error) {
		return error;
	}
	if (isTaggedObject(error)) {
		for (const Ctor of knownErrorConstructors) {
			if (Ctor.name === error._tag) {
				return new Ctor(error as never);
			}
		}
		return new Error(`Unknown engine error tag: ${error._tag}`);
	}
	return new Error(`Unknown engine rejection: ${JSON.stringify(error)}`);
};

class ScalarPredicateDefect extends Error {
	readonly defect: unknown;

	constructor(defect: unknown) {
		super("Scalar predicate threw");
		this.name = "ScalarPredicateDefect";
		this.defect = defect;
	}
}

const liftPromise = <A, E extends Error = Error>(
	thunk: () => Promise<A>,
	isDefect: (error: Error) => boolean = () => false,
): Effect.Effect<A, E, never> =>
	Effect.tryPromise({
		try: () => thunk(),
		catch: (error) => error
	}).pipe(
		Effect.catch((error) => {
			const normalized = normalizeRejection(error);
			if (normalized instanceof ScalarPredicateDefect) {
				return Effect.die(normalized.defect);
			}
			if (isDefect(normalized) || isWasmEngineDefectError(normalized)) {
				return Effect.die(normalized);
			}
			return Effect.fail(normalized as unknown as E);
		})
	);

const ignoreCloseError = (close: () => Promise<void>) =>
	Effect.tryPromise({
		try: () => close(),
		catch: () => undefined
	}).pipe(Effect.ignore);

const makePersistentCloseOnce = (
	flush: () => Promise<void>,
	close: () => Promise<void>,
	plugins: ReadonlyArray<{ readonly shutdown?: () => Effect.Effect<unknown, unknown, never> }> | undefined
) => {
	let closePromise: Promise<void> | undefined;
	return () => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			let firstError: Error | undefined;
			const capture = (error: unknown) => {
				if (firstError === undefined) {
					firstError = normalizeRejection(error);
				}
			};
			try {
				await flush();
			} catch (error) {
				capture(error);
			}
			for (const plugin of [...(plugins ?? [])].reverse()) {
				if (plugin.shutdown === undefined) continue;
				try {
					await Effect.runPromise(plugin.shutdown());
				} catch (error) {
					console.error("[proseql/effect] plugin shutdown failed", error);
				}
			}
			try {
				await close();
			} catch (error) {
				capture(error);
			}
			if (firstError !== undefined) {
				throw firstError;
			}
		})();
		return closePromise;
	};
};

const subscriptionEffectToStream = <A>(
	acquire: () => AsyncIterableIterator<A> & { unsubscribe(): Promise<void> }
): Effect.Effect<Stream.Stream<A, never, never>, never, import("effect").Scope.Scope> =>
	Effect.suspend(() =>
		Effect.acquireRelease(
			Effect.gen(function* () {
				const sub = acquire();
				const queue = yield* Queue.unbounded<A>();
				void (async () => {
					try {
						while (true) {
							const next = await sub.next();
							if (next.done) break;
							Queue.offerUnsafe(queue, next.value);
						}
					} finally {
						await Effect.runPromise(Queue.shutdown(queue));
					}
				})();
				return { sub, queue };
			}),
			({ sub, queue }) =>
				Effect.gen(function* () {
					yield* ignoreCloseError(() => sub.unsubscribe());
					yield* Queue.shutdown(queue).pipe(Effect.ignore);
				})
		).pipe(
			Effect.map(({ queue }) => Stream.fromQueue(queue).pipe(Stream.orDie) as Stream.Stream<A, never, never>)
		)
	) as Effect.Effect<Stream.Stream<A, never, never>, never, import("effect").Scope.Scope>;

const engineOptionsFrom = (options: EffectDatabaseOptions | undefined): EngineDatabaseOptions | undefined =>
	options ? { plugins: options.plugins } : undefined;

const collectionNamesFromConfig = (config: DatabaseConfig): ReadonlyArray<string> =>
	Object.keys(getCollectionConfigs(config) as Record<string, CollectionConfig>);

const makePersistenceOptions = (
	adapter: StorageAdapterShape | undefined,
	serializerRegistry: SerializerRegistryShape | undefined,
	persistenceConfig: EffectDatabasePersistenceConfig | undefined
): EnginePersistenceOptions => {
	if (adapter === undefined) {
		return {
			writeDebounce: persistenceConfig?.writeDebounce,
			_suppressInitialWrites: true,
			...(serializerRegistry ? { serializerRegistry } : {})
		};
	}
	return {
		writeDebounce: persistenceConfig?.writeDebounce,
		_suppressInitialWrites: true,
		...(serializerRegistry ? { serializerRegistry } : {}),
		storageHost: {
			read: (path: string) => Effect.runPromise(adapter.read(path)),
			write: (path: string, data: string) => Effect.runPromise(adapter.write(path, data)),
			append: (path: string, data: string) => Effect.runPromise(adapter.append(path, data)),
			exists: (path: string) => Effect.runPromise(adapter.exists(path)),
			remove: (path: string) => Effect.runPromise(adapter.remove(path)),
			ensureDir: (path: string) => Effect.runPromise(adapter.ensureDir(path)),
			listDirectory: (dirPath: string) => Effect.runPromise(adapter.listDirectory(dirPath)),
			listRecursive: (rootPath: string) => Effect.runPromise(adapter.listRecursive(rootPath)),
			watch: (path: string, onChange: () => void) => Effect.runPromise(adapter.watch(path, onChange)),
			watchDir: (
				dirPath: string,
				onChange: (event: { readonly filename: string | null; readonly type: "add" | "change" | "remove" }) => void
			) =>
				Effect.runPromise(
					adapter.watchDir(dirPath, (event) =>
						onChange({
							...event,
							filename:
								typeof event.filename === "string" && !event.filename.startsWith("/")
									? joinComparablePath(dirPath, event.filename)
									: event.filename
						})
					)
				)
		},
		storageLayer: Layer.succeed(StorageAdapter, adapter)
	};
};

const streamQuery = (engineCollection: EngineCollection<any, any, any>, config?: QueryConfig<any, any, any>) =>
	withStreamRunPromise(
		Stream.unwrap(
			liftPromise(() => engineCollection.query(config as never)).pipe(
				Effect.map((rows) => Stream.fromIterable(rows as Iterable<unknown>))
			)
		)
	);

const cursorOrStreamQuery = (engineCollection: EngineCollection<any, any, any>, config?: QueryConfig<any, any, any>) => {
	if (config && "cursor" in config && config.cursor !== undefined) {
		return withRunPromise(liftPromise(() => engineCollection.query(config as never))) as never;
	}
	return streamQuery(engineCollection, config) as never;
};

const unsupportedWatchInTransaction = (method: "watch" | "watchById") =>
	Effect.die(
		new Error(
			`${method}() is not supported within transactions. Reactive queries can only be used on the main database collections.`
		)
	);

const transactionInactiveError = (operation: "begin" | "commit" | "rollback") =>
	new TransactionError({
		operation,
		reason: "transaction is no longer active",
		message:
			operation === "commit"
				? "Cannot commit: transaction is no longer active"
				: operation === "rollback"
					? "Cannot rollback: transaction is no longer active"
					: "Cannot perform operation: transaction is no longer active"
	});

const transactionRolledBackError = () =>
	new TransactionError({
		operation: "rollback",
		reason: "transaction rolled back",
		message: "Transaction rolled back"
	});

type TransactionAdapterState = {
	active: boolean;
	commitRequested: boolean;
	rollbackRequested: boolean;
	readonly mutatedCollections: Set<string>;
	readonly rollbackError: TransactionError;
};

class TransactionCallbackFailure {
	constructor(readonly error: unknown) {}
}

class TransactionCallbackDefect {
	constructor(readonly defect: unknown) {}
}

const extractFirstCauseFailure = (cause: unknown):
	| { readonly _tag: "Fail"; readonly error: unknown }
	| { readonly _tag: "Die"; readonly defect: unknown }
	| undefined => {
	if (typeof cause !== "object" || cause === null) {
		return undefined;
	}
	const entries = "failures" in cause
		? (cause as { failures?: ReadonlyArray<unknown> }).failures
		: "reasons" in cause
			? (cause as { reasons?: ReadonlyArray<unknown> }).reasons
			: undefined;
	const first = Array.isArray(entries) ? entries[0] : undefined;
	if (typeof first !== "object" || first === null || !("_tag" in first)) {
		return undefined;
	}
	if ((first as { _tag?: unknown })._tag === "Fail") {
		return { _tag: "Fail", error: (first as { error?: unknown }).error };
	}
	if ((first as { _tag?: unknown })._tag === "Die") {
		return { _tag: "Die", defect: (first as { defect?: unknown }).defect };
	}
	return undefined;
};

const wrapTransactionOperation = <A>(
	state: TransactionAdapterState,
	operation: () => Promise<A>,
	onSuccess?: (value: A) => void,
) =>
	withRunPromise(
		Effect.suspend(() => {
			if (!state.active) {
				return Effect.fail(transactionInactiveError("begin"));
			}
			return liftPromise(operation).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						onSuccess?.(value);
					})
				)
			);
		})
	);

const selectScalarPredicateIds = <Row extends { readonly id: string }>(
	rows: ReadonlyArray<Row>,
	predicate: (entity: Row) => boolean,
	limit?: number,
): ReadonlyArray<string> => {
	const ids: string[] = [];
	for (const row of rows) {
		let matches: boolean;
		try {
			matches = predicate.call(undefined, row);
		} catch (defect) {
			throw new ScalarPredicateDefect(defect);
		}
		if (matches) ids.push(row.id);
	}
	return limit !== undefined && limit > 0 ? ids.slice(0, limit) : ids;
};

const idSetWhere = (ids: ReadonlyArray<string>) => ({
	id: { $in: [...ids] },
});

const optionsAfterPredicateLimit = (
	options?: { readonly soft?: boolean; readonly limit?: number },
): { readonly soft?: boolean } | undefined =>
	options?.soft === undefined ? undefined : { soft: options.soft };

const createTransactionCollectionAdapter = (
	engineCollection: EngineCollection<any, any, any>,
	collectionName: string,
	state: TransactionAdapterState,
) => ({
	query: (config?: QueryConfig<any, any, any>) => {
		if (config && "cursor" in config && config.cursor !== undefined) {
			return wrapTransactionOperation(state, () =>
				engineCollection.query(config as never),
			) as never;
		}
		return withStreamRunPromise(
			Stream.unwrap(
				Effect.suspend(() => {
					if (!state.active) {
						return Effect.fail(transactionInactiveError("begin"));
					}
					return liftPromise(() => engineCollection.query(config as never)).pipe(
						Effect.map((rows) =>
							Stream.fromIterable(rows as Iterable<unknown>),
						),
					);
				}),
			),
		) as never;
	},
	findById: (id: string) => wrapTransactionOperation(state, () => engineCollection.findById(id)) as never,
	exists: (id: string) => wrapTransactionOperation(state, () => engineCollection.exists(id)) as never,
	create: (input: unknown) =>
		wrapTransactionOperation(state, () => engineCollection.create(input as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	createMany: (inputs: ReadonlyArray<unknown>, options?: { readonly skipDuplicates?: boolean; readonly validateRelationships?: boolean }) =>
		wrapTransactionOperation(state, () => engineCollection.createMany(inputs as never, options), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	update: (id: string, updates: unknown) =>
		wrapTransactionOperation(state, () => engineCollection.update(id, updates as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	updateMany: (predicate: (entity: any) => boolean, updates: unknown) =>
		wrapTransactionOperation(
			state,
			async () => {
				if (typeof predicate !== "function") {
					return engineCollection.updateMany(predicate as never, updates as never) as Promise<UpdateManyResult<any>>;
				}
				const rows = (await engineCollection.query()) as ReadonlyArray<{ readonly id: string }>;
				const ids = selectScalarPredicateIds(rows, predicate);
				return engineCollection.updateMany(
					idSetWhere(ids) as never,
					updates as never,
				) as Promise<UpdateManyResult<any>>;
			},
			() => {
				state.mutatedCollections.add(collectionName);
			}
		) as never,
	delete: (id: string, options?: { readonly soft?: boolean }) =>
		wrapTransactionOperation(state, () => engineCollection.delete(id, options), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	deleteMany: (predicate: (entity: any) => boolean, options?: { readonly soft?: boolean; readonly limit?: number }) =>
		wrapTransactionOperation(
			state,
			async () => {
				if (typeof predicate !== "function") {
					return engineCollection.deleteMany(predicate as never, options) as Promise<DeleteManyResult<any>>;
				}
				const rows = (await engineCollection.query()) as ReadonlyArray<{ readonly id: string }>;
				const ids = selectScalarPredicateIds(rows, predicate, options?.limit);
				return engineCollection.deleteMany(
					idSetWhere(ids) as never,
					optionsAfterPredicateLimit(options),
				) as Promise<DeleteManyResult<any>>;
			},
			() => {
				state.mutatedCollections.add(collectionName);
			}
		) as never,
	upsert: (input: unknown) =>
		wrapTransactionOperation(state, () => engineCollection.upsert(input as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	upsertMany: (inputs: ReadonlyArray<unknown>) =>
		wrapTransactionOperation(state, () => engineCollection.upsertMany(inputs as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	createWithRelationships: (input: unknown) =>
		wrapTransactionOperation(state, () => engineCollection.createWithRelationships(input as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	updateWithRelationships: (id: string, input: unknown) =>
		wrapTransactionOperation(state, () => engineCollection.updateWithRelationships(id, input as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	deleteWithRelationships: (id: string, options?: DeleteWithRelationshipsOptions<any, any>) =>
		wrapTransactionOperation(state, () => engineCollection.deleteWithRelationships(id, options as never), () => {
			state.mutatedCollections.add(collectionName);
		}) as never,
	deleteManyWithRelationships: (predicate: (entity: any) => boolean, options?: DeleteWithRelationshipsOptions<any, any> & { readonly limit?: number }) =>
		wrapTransactionOperation(
			state,
			async () => {
				if (typeof predicate !== "function") {
					return engineCollection.deleteManyWithRelationships(predicate as never, options as never);
				}
				const matched = (await engineCollection.query()) as ReadonlyArray<any>;
				const targets = matched.filter(predicate);
				const limited = options?.limit && options.limit > 0 ? targets.slice(0, options.limit) : targets;
				if (limited.length === 0) {
					return { count: 0, deleted: [] };
				}
				const ids = new Set(limited.map((entity) => entity.id));
				return engineCollection.deleteManyWithRelationships({ id: { $in: [...ids] } } as never, options as never);
			},
			() => {
				state.mutatedCollections.add(collectionName);
			}
		) as never,
	aggregate: (config: unknown) => wrapTransactionOperation(state, () => engineCollection.aggregate(config as never)) as never,
	watch: () => unsupportedWatchInTransaction("watch") as never,
	watchById: () => unsupportedWatchInTransaction("watchById") as never
});

const createCollectionAdapter = (
	engineCollection: EngineCollection<any, any, any>,
	transactionRunner: <A>(fn: (tx: EngineCollection<any, any, any>) => Promise<A>) => Promise<A>
) => ({
	query: (config?: QueryConfig<any, any, any>) => cursorOrStreamQuery(engineCollection, config),
	findById: (id: string) => withRunPromise(liftPromise(() => engineCollection.findById(id))) as never,
	exists: (id: string) => withRunPromise(liftPromise(() => engineCollection.exists(id))) as never,
	create: (input: unknown) => withRunPromise(liftPromise(() => engineCollection.create(input as never))) as never,
	createMany: (inputs: ReadonlyArray<unknown>, options?: { readonly skipDuplicates?: boolean; readonly validateRelationships?: boolean }) =>
		withRunPromise(liftPromise(() => engineCollection.createMany(inputs as never, options))) as never,
	update: (id: string, updates: unknown) => withRunPromise(liftPromise(() => engineCollection.update(id, updates as never))) as never,
	updateMany: (predicate: (entity: any) => boolean, updates: unknown) =>
		withRunPromise(
			liftPromise(async () => {
				if (typeof predicate !== "function") {
					return engineCollection.updateMany(
						predicate as never,
						updates as never,
					) as Promise<UpdateManyResult<any>>;
				}
				const rows = (await engineCollection.query()) as ReadonlyArray<{
					readonly id: string;
				}>;
				const ids = selectScalarPredicateIds(rows, predicate);
				return engineCollection.updateMany(
					idSetWhere(ids) as never,
					updates as never,
				) as Promise<UpdateManyResult<any>>;
			})
		) as never,
	delete: (id: string, options?: { readonly soft?: boolean }) => withRunPromise(liftPromise(() => engineCollection.delete(id, options))) as never,
	deleteMany: (predicate: (entity: any) => boolean, options?: { readonly soft?: boolean; readonly limit?: number }) =>
		withRunPromise(
			liftPromise(async () => {
				if (typeof predicate !== "function") {
					return engineCollection.deleteMany(
						predicate as never,
						options,
					) as Promise<DeleteManyResult<any>>;
				}
				const rows = (await engineCollection.query()) as ReadonlyArray<{
					readonly id: string;
				}>;
				const ids = selectScalarPredicateIds(rows, predicate, options?.limit);
				return engineCollection.deleteMany(
					idSetWhere(ids) as never,
					optionsAfterPredicateLimit(options),
				) as Promise<DeleteManyResult<any>>;
			})
		) as never,
	upsert: (input: unknown) => withRunPromise(liftPromise(() => engineCollection.upsert(input as never))) as never,
	upsertMany: (inputs: ReadonlyArray<unknown>) => withRunPromise(liftPromise(() => engineCollection.upsertMany(inputs as never))) as never,
	createWithRelationships: (input: unknown) => withRunPromise(liftPromise(() => engineCollection.createWithRelationships(input as never))) as never,
	updateWithRelationships: (id: string, input: unknown) => withRunPromise(liftPromise(() => engineCollection.updateWithRelationships(id, input as never))) as never,
	deleteWithRelationships: (id: string, options?: DeleteWithRelationshipsOptions<any, any>) =>
		withRunPromise(liftPromise(() => engineCollection.deleteWithRelationships(id, options as never))) as never,
	deleteManyWithRelationships: (predicate: (entity: any) => boolean, options?: DeleteWithRelationshipsOptions<any, any> & { readonly limit?: number }) =>
		withRunPromise(
			liftPromise(() =>
				transactionRunner(async (txCollection) => {
					if (typeof predicate !== "function") {
						return txCollection.deleteManyWithRelationships(predicate as never, options as never);
					}
					const matched = (await txCollection.query()) as ReadonlyArray<any>;
					const targets = matched.filter(predicate);
					const limited = options?.limit && options.limit > 0 ? targets.slice(0, options.limit) : targets;
					if (limited.length === 0) {
						return { count: 0, deleted: [] };
					}
					const ids = limited.map((entity) => entity.id);
					return txCollection.deleteManyWithRelationships({ id: { $in: ids } } as never, options as never);
				})
			)
		) as never,
	aggregate: (config: unknown) => withRunPromise(liftPromise(() => engineCollection.aggregate(config as never))) as never,
	watch: (config?: unknown) =>
		subscriptionEffectToStream(() => engineCollection.watch(config as never)) as never,
	watchById: (id: string, options?: { readonly debounceMs?: number }) =>
		subscriptionEffectToStream(() => engineCollection.watchById(id, options)) as never
});

const adaptDatabase = <Config extends DatabaseConfig>(
	engineDb: GenerateEngineDatabase<Config>,
	collectionNames: ReadonlyArray<string>
): GenerateDatabase<Config> & { close: () => Promise<void> } => {
	const collections: Record<string, unknown> = {};

	const transactionRunner = <A>(
		collectionName: string,
		fn: (txCollection: EngineCollection<any, any, any>) => Promise<A>
	) =>
		engineDb.$transaction(async (tx) =>
			fn((tx as Record<string, EngineCollection<any, any, any>>)[collectionName]!)
		);

	for (const name of collectionNames) {
		collections[name] = createCollectionAdapter(
			(engineDb as Record<string, EngineCollection<any, any, any>>)[name]!,
			(fn) => transactionRunner(name, fn)
		);
	}

	const adapted = Object.assign(collections, {
		$transaction: <A, E>(fn: (ctx: TransactionContext<GenerateDatabase<Config>>) => Effect.Effect<A, E>) =>
			withRunPromise(
				Effect.tryPromise({
					try: (signal) =>
						engineDb.$transaction(async (tx) => {
							const txRecord = tx as Record<string, EngineCollection<any, any, any>>;
							const state: TransactionAdapterState = {
								active: true,
								commitRequested: false,
								rollbackRequested: false,
								mutatedCollections: new Set<string>(),
								rollbackError: transactionRolledBackError(),
							};
							const txCollections: Record<string, unknown> = {};
							for (const name of collectionNames) {
								txCollections[name] = createTransactionCollectionAdapter(txRecord[name]!, name, state);
							}
							const txContext = txCollections as Record<string, unknown>;
							Object.defineProperties(txContext, {
								commit: {
									value: () =>
										withRunPromise(
											Effect.suspend(() => {
												if (!state.active) {
													return Effect.fail(transactionInactiveError("commit"));
												}
												state.active = false;
												state.commitRequested = true;
												return Effect.void;
											})
										),
									enumerable: true,
								},
								rollback: {
									value: () =>
										withRunPromise(
											Effect.suspend(() => {
												if (!state.active) {
													return Effect.fail(transactionInactiveError("rollback"));
												}
												state.active = false;
												state.rollbackRequested = true;
												return Effect.fail(state.rollbackError);
											})
										),
									enumerable: true,
								},
								isActive: {
									get: () => state.active,
									enumerable: true,
								},
								mutatedCollections: {
									get: () => state.mutatedCollections as ReadonlySet<string>,
									enumerable: true,
								}
							});
							const typedTxContext = txContext as TransactionContext<GenerateDatabase<Config>>;
							const exit = await Effect.runPromiseExit(fn(typedTxContext), { signal });
							if (exit._tag === "Success") {
								if (state.rollbackRequested) {
									throw new TransactionCallbackFailure(state.rollbackError);
								}
								return exit.value;
							}
							const failure = extractFirstCauseFailure(exit.cause);
							if (failure?._tag === "Fail") {
								throw new TransactionCallbackFailure(failure.error);
							}
							if (failure?._tag === "Die") {
								throw new TransactionCallbackDefect(failure.defect);
							}
							throw new TransactionCallbackDefect(exit.cause);
						}),
					catch: (error) => error
				}).pipe(
					Effect.catch((error) => {
						if (error instanceof TransactionCallbackFailure) {
							return Effect.fail(error.error as E | TransactionError);
						}
						if (error instanceof TransactionCallbackDefect) {
							return Effect.die(error.defect);
						}
						const normalized = normalizeRejection(error);
						if (isWasmEngineDefectError(normalized)) {
							return Effect.die(normalized);
						}
						return Effect.fail(normalized as unknown as E | TransactionError);
					})
				)
			) as never,
		$documentGraph: {
			getRecordProvenance: (collection: string, id: string) =>
				liftPromise(() => engineDb.$documentGraph.getRecordProvenance(collection, id)) as never,
			getDiagnostics: () => liftPromise(() => engineDb.$documentGraph.getDiagnostics()) as never
		},
		close: () => engineDb.close()
	}) as unknown as GenerateDatabase<Config> & { close: () => Promise<void> };
	Object.defineProperty(adapted, "__proseqlMaterializationDiagnostics", {
		value: () =>
			(engineDb as unknown as { __proseqlMaterializationDiagnostics?: () => unknown })
				.__proseqlMaterializationDiagnostics?.(),
		enumerable: false
	});
	return adapted;
};

const adaptPersistentDatabase = <Config extends DatabaseConfig>(
	engineDb: GenerateEngineDatabaseWithPersistence<Config>,
	collectionNames: ReadonlyArray<string>
): GenerateDatabaseWithPersistence<Config> & { close: () => Promise<void> } => {
	const db = adaptDatabase(engineDb, collectionNames) as GenerateDatabaseWithPersistence<Config> & { close: () => Promise<void> };
	return Object.assign(db, {
		flush: () => engineDb.flush(),
		pendingCount: () => engineDb.pendingCount(),
		$dryRunMigrations: () => withRunPromise(liftPromise(() => engineDb.$dryRunMigrations())) as never,
		close: () => engineDb.close()
	});
};

type CreateEffectDatabaseError =
	| MigrationError
	| PluginError
	| ValidationError
	| DuplicateKeyError
	| ForeignKeyError
	| UniqueConstraintError
	| CollectionNotFoundError;

const createEffectDatabaseWithLoader = (
	loadEngineModule: () => Promise<EffectEngineModule>,
) => <Config extends DatabaseConfig>(
	config: Config,
	initialData?: { readonly [K in keyof ConfiguredCollections<Config>]?: ReadonlyArray<Record<string, unknown>> },
	options?: EffectDatabaseOptions,
): Effect.Effect<GenerateDatabase<Config>, CreateEffectDatabaseError> => {
	const collectionNames = collectionNamesFromConfig(config);
	let defectConstructor: EffectEngineModule["WasmEngineDefectError"] | undefined;
	return liftPromise<GenerateDatabase<Config>, CreateEffectDatabaseError>(
		async () => {
			const engine = await loadEngineModule();
			defectConstructor = engine.WasmEngineDefectError;
			const db = await engine.createEngineDatabase(
				config,
				initialData as EngineInitialData<Config> | undefined,
				engineOptionsFrom(options),
			);
			return adaptDatabase(db, collectionNames);
		},
		(error) => defectConstructor !== undefined && error instanceof defectConstructor,
	);
};

const createPersistentEffectDatabaseWithLoader = (
	loadEngineModule: () => Promise<EffectEngineModule>,
) => <Config extends DatabaseConfig>(
	config: Config,
	initialData?: { readonly [K in keyof ConfiguredCollections<Config>]?: ReadonlyArray<Record<string, unknown>> },
	persistenceConfig?: EffectDatabasePersistenceConfig,
	options?: EffectDatabaseOptions,
): Effect.Effect<
	GenerateDatabaseWithPersistence<Config>,
	| MigrationError
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| SourceConfigError
	| UnknownCollectionError
	| DuplicateRecordError
	| DuplicatePhysicalFileError
	| InvalidDocumentSourceError
	| DocumentGraphSourceError
	| PluginError,
	typeof StorageAdapter | typeof SerializerRegistryService
> => {
	const collectionNames = collectionNamesFromConfig(config);
	let defectConstructor: EffectEngineModule["WasmEngineDefectError"] | undefined;
	return Effect.gen(function* () {
		const adapterOption = yield* Effect.serviceOption(StorageAdapter);
		const serializerRegistryOption = yield* Effect.serviceOption(SerializerRegistryService);
		const enginePersistence = makePersistenceOptions(
			adapterOption._tag === "Some" ? adapterOption.value : undefined,
			serializerRegistryOption._tag === "Some" ? serializerRegistryOption.value : undefined,
			persistenceConfig,
		);
		const baseDb = yield* liftPromise(
			async () => {
				const engine = await loadEngineModule();
				defectConstructor = engine.WasmEngineDefectError;
				const db = await engine.createPersistentEngineDatabase(
					config,
					initialData as EngineInitialData<Config> | undefined,
					enginePersistence,
					engineOptionsFrom(options),
				);
				return adaptPersistentDatabase(db, collectionNames);
			},
			(error) => defectConstructor !== undefined && error instanceof defectConstructor,
		);
		const baseClose = baseDb.close.bind(baseDb);
		const close = makePersistentCloseOnce(
			() => baseDb.flush(),
			() => baseClose(),
			options?.plugins,
		);
		const db = Object.assign(baseDb, { close });
		yield* Effect.addFinalizer(() => Effect.promise(() => close()).pipe(Effect.orDie));
		return db;
	}) as unknown as Effect.Effect<
		GenerateDatabaseWithPersistence<Config>,
		| MigrationError
		| StorageError
		| SerializationError
		| UnsupportedFormatError
		| ValidationError
		| SourceConfigError
		| UnknownCollectionError
		| DuplicateRecordError
		| DuplicatePhysicalFileError
		| InvalidDocumentSourceError
		| DocumentGraphSourceError
		| PluginError,
		typeof StorageAdapter | typeof SerializerRegistryService
	>;
};

export const createEffectDatabase = createEffectDatabaseWithLoader(loadNodeEngineModule);
export const createPersistentEffectDatabase = createPersistentEffectDatabaseWithLoader(loadNodeEngineModule);
export const createBrowserEffectDatabase = createEffectDatabaseWithLoader(loadBrowserEngineModule);
export const createBrowserPersistentEffectDatabase = createPersistentEffectDatabaseWithLoader(loadBrowserEngineModule);

export const unsafeLiftPromiseForTests = liftPromise;
export const unsafeSubscriptionEffectToStreamForTests = subscriptionEffectToStream;
