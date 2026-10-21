import type { Effect, Schema, Scope, Stream } from "effect";
import type {
	AggregateConfig,
	AggregateResult,
	ConfiguredCollections,
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	CreateWithRelationshipsInput,
	CursorConfig,
	DanglingReferenceError,
	DatabaseConfig,
	DeleteManyResult,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
	DocumentGraphDiagnostic,
	DocumentGraphRecordProvenance,
	DryRunResult,
	DuplicateKeyError,
	ForeignKeyError,
	FormatCodec,
	GroupedAggregateResult,
	HookError,
	MigrationError,
	MinimalEntity,
	NotFoundError,
	OperationError,
	ProseQLPlugin,
	RelationshipDef,
	RunnableCursorPage,
	SerializationError,
	StorageError,
	TransactionContext,
	TransactionError,
	UniqueConstraintError,
	UnsupportedFormatError,
	UpdateManyResult,
	UpdateWithOperators,
	UpdateWithRelationshipsInput,
	UpsertInput,
	UpsertManyResult,
	UpsertResult,
	ValidationError,
} from "../index.js";

type HasId = { readonly id: string };
export type RunnableEffect<A, E> = Effect.Effect<A, E, never> & {
	readonly runPromise: Promise<A>;
};
export type RunnableStream<A, E> = Stream.Stream<A, E, never> & {
	readonly runPromise: Promise<ReadonlyArray<A>>;
};
export interface EffectCollection<T extends HasId> {
	readonly query: (options?: {
		readonly where?: Record<string, unknown>;
		readonly populate?: Record<string, unknown>;
		readonly sort?: Record<string, "asc" | "desc">;
		readonly select?: Record<string, unknown> | ReadonlyArray<string>;
		readonly limit?: number;
		readonly offset?: number;
		readonly cursor?: CursorConfig;
	}) =>
		| RunnableStream<
				Record<string, unknown>,
				DanglingReferenceError | ValidationError
		  >
		| RunnableCursorPage<
				Record<string, unknown>,
				DanglingReferenceError | ValidationError
		  >;

	readonly findById: (id: string) => RunnableEffect<T, NotFoundError>;

	readonly exists: (id: string) => RunnableEffect<boolean, never>;

	readonly create: (
		input: CreateInput<T>,
	) => RunnableEffect<
		T,
		| ValidationError
		| DuplicateKeyError
		| ForeignKeyError
		| HookError
		| UniqueConstraintError
	>;
	readonly createMany: (
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	) => RunnableEffect<
		CreateManyResult<T>,
		| ValidationError
		| DuplicateKeyError
		| ForeignKeyError
		| HookError
		| UniqueConstraintError
	>;

	readonly update: (
		id: string,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<
		T,
		| ValidationError
		| NotFoundError
		| ForeignKeyError
		| HookError
		| UniqueConstraintError
	>;
	readonly updateMany: (
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T & MinimalEntity>,
	) => RunnableEffect<
		UpdateManyResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	>;

	readonly delete: (
		id: string,
		options?: { readonly soft?: boolean },
	) => RunnableEffect<
		T,
		NotFoundError | OperationError | ForeignKeyError | HookError
	>;
	readonly deleteMany: (
		predicate: (entity: T) => boolean,
		options?: { readonly soft?: boolean; readonly limit?: number },
	) => RunnableEffect<
		DeleteManyResult<T>,
		OperationError | ForeignKeyError | HookError
	>;

	readonly upsert: (
		input: UpsertInput<T>,
	) => RunnableEffect<
		UpsertResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	>;
	readonly upsertMany: (
		inputs: ReadonlyArray<UpsertInput<T>>,
	) => RunnableEffect<
		UpsertManyResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	>;

	readonly createWithRelationships: (
		input: CreateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => RunnableEffect<T, ValidationError | ForeignKeyError | OperationError>;
	readonly updateWithRelationships: (
		id: string,
		input: UpdateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	) => RunnableEffect<
		T,
		ValidationError | NotFoundError | ForeignKeyError | OperationError
	>;
	readonly deleteWithRelationships: (
		id: string,
		options?: DeleteWithRelationshipsOptions<
			T,
			Record<string, RelationshipDef>
		>,
	) => RunnableEffect<
		DeleteWithRelationshipsResult<T>,
		NotFoundError | ValidationError | OperationError
	>;
	readonly deleteManyWithRelationships: (
		predicate: (entity: T) => boolean,
		options?: DeleteWithRelationshipsOptions<
			T,
			Record<string, RelationshipDef>
		> & {
			readonly limit?: number;
		},
	) => RunnableEffect<
		{
			readonly count: number;
			readonly deleted: ReadonlyArray<T>;
			readonly cascaded?: Record<
				string,
				{ readonly count: number; readonly ids: ReadonlyArray<string> }
			>;
		},
		ValidationError | OperationError
	>;

	readonly aggregate: <C extends AggregateConfig>(
		config: C,
	) => C extends { readonly groupBy: string | ReadonlyArray<string> }
		? RunnableEffect<GroupedAggregateResult, never>
		: RunnableEffect<AggregateResult, never>;

	/**
	 * Create a reactive subscription that emits query results whenever the collection changes.
	 *
	 * The stream:
	 * 1. Emits the current result set immediately upon subscription
	 * 2. Re-emits whenever the underlying data changes (create/update/delete/reload)
	 * 3. Deduplicates consecutive identical result sets to avoid spurious emissions
	 *
	 * The stream is scoped: it subscribes to change notifications on creation and
	 * automatically unsubscribes when the scope closes or the stream is interrupted.
	 *
	 * @param config - Optional query configuration (where, sort, select, limit, offset, debounceMs)
	 * @returns A scoped Effect that produces a Stream of result arrays
	 */
	readonly watch: (config?: {
		readonly where?: Record<string, unknown>;
		readonly sort?: Record<string, "asc" | "desc">;
		readonly select?: Record<string, unknown> | ReadonlyArray<string>;
		readonly limit?: number;
		readonly offset?: number;
		readonly debounceMs?: number;
	}) => Effect.Effect<Stream.Stream<ReadonlyArray<T>>, never, Scope.Scope>;

	/**
	 * Create a reactive subscription for a single entity by ID.
	 *
	 * Emits the entity immediately if it exists (or null if not), then re-emits
	 * whenever the entity is created, updated, or deleted.
	 *
	 * The stream is scoped: it subscribes to change notifications on creation and
	 * automatically unsubscribes when the scope closes or the stream is interrupted.
	 *
	 * @param id - The entity ID to watch
	 * @returns A scoped Effect that produces a Stream of T | null
	 */
	readonly watchById: (
		id: string,
	) => Effect.Effect<Stream.Stream<T | null>, never, Scope.Scope>;
}

/**
 * Database type: a record of collection names to EffectCollections,
 * plus the $transaction method for atomic operations.
 */
export interface DocumentGraphMetadata {
	readonly getRecordProvenance: (
		collection: string,
		id: string,
	) => Effect.Effect<DocumentGraphRecordProvenance | undefined>;
	readonly getDiagnostics: () => Effect.Effect<
		ReadonlyArray<DocumentGraphDiagnostic>
	>;
}

export type EffectDatabase<Config extends DatabaseConfig> = {
	readonly [K in keyof ConfiguredCollections<Config>]: EffectCollection<
		Schema.Schema.Type<ConfiguredCollections<Config>[K]["schema"]> & HasId
	>;
} & {
	/**
	 * Execute multiple operations atomically within a transaction.
	 * On success, all changes are committed and persistence is triggered.
	 * On failure, all changes are rolled back and the original error is re-raised.
	 */
	readonly $transaction: <A, E>(
		fn: (ctx: TransactionContext) => Effect.Effect<A, E>,
	) => RunnableEffect<A, E | TransactionError>;
	readonly $documentGraph: DocumentGraphMetadata;
};

/**
 * Configuration for database persistence.
 * When provided, CRUD mutations trigger debounced saves to disk.
 */
export interface EffectDatabasePersistenceConfig {
	/** Debounce delay in milliseconds (default 100) */
	readonly writeDebounce?: number;
	/**
	 * Plugin codecs to merge with the serializer registry.
	 * When provided, these codecs are layered on top of the user-provided
	 * SerializerRegistry service, with plugin codecs taking precedence.
	 * @internal Used by plugin system integration
	 */
	readonly _pluginCodecs?: ReadonlyArray<FormatCodec>;
}

/**
 * Extended database type with persistence control methods.
 */
export type EffectDatabaseWithPersistence<Config extends DatabaseConfig> =
	EffectDatabase<Config> & {
		/** Flush all pending debounced writes immediately. Returns a Promise. */
		readonly flush: () => Promise<void>;
		/** Returns the number of writes currently pending. */
		readonly pendingCount: () => number;
		/**
		 * Preview which files need migration and what transforms would apply.
		 * No transforms are executed. No files are written.
		 */
		readonly $dryRunMigrations: () => RunnableEffect<
			DryRunResult,
			| MigrationError
			| StorageError
			| SerializationError
			| UnsupportedFormatError
		>;
	};
export interface EffectDatabaseOptions {
	readonly plugins?: ReadonlyArray<ProseQLPlugin>;
}
