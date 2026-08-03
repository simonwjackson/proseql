import type {
	AggregateConfig,
	AggregateResult,
	ApplyPopulateObject,
	ApplySelectAndPopulate,
	ApplySelectConfig,
	CollectionConfig,
	ComputedFieldsConfig,
	ConfiguredCollections,
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	CreateWithRelationshipsInput,
	CursorConfig,
	CursorPageResult,
	DatasetFor,
	DeleteManyResult,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
	DryRunResult,
	GenerateDatabase as CoreGenerateDatabase,
	GroupedAggregateResult,
	InferComputedFields,
	PopulateConfig,
	ProseQLPlugin,
	QueryConfig,
	RelationshipDef,
	ResolveRelationships,
	RuntimeEntityFromCollection,
	SelectConfig,
	SortConfig,
	UpdateManyResult,
	UpdateWithOperators,
	UpdateWithRelationshipsInput,
	UpsertInput,
	UpsertManyResult,
	UpsertResult,
	WhereClause,
} from "@proseql/core";

export type { DatasetFor } from "@proseql/core";

export interface WatchSubscription<T> extends AsyncIterableIterator<T> {
	unsubscribe(): Promise<void>;
}

export type EngineWatchConfig<T, Relations, DB> = {
	readonly where?: WhereClause<T, Relations, DB>;
	readonly sort?: SortConfig<T, Relations, Record<string, never>, DB>;
	readonly select?: SelectConfig<T, Relations, DB>;
	readonly limit?: number;
	readonly offset?: number;
	readonly debounceMs?: number;
};

export type EngineDeleteWithRelationshipsOptions<T, Relations> = Omit<
	DeleteWithRelationshipsOptions<T, Relations>,
	"returnDeleted"
>;

type QueryItemType<T, Relations, Config, DB> = Config extends {
	populate: infer P;
	select: infer S;
}
	? P extends PopulateConfig<Relations, DB>
		? S extends SelectConfig<T, Relations, DB>
			? ApplySelectAndPopulate<T, Relations, S, P, DB>
			: ApplyPopulateObject<T, Relations, P, DB>
		: T
	: Config extends { populate: infer P }
		? P extends PopulateConfig<Relations, DB>
			? ApplyPopulateObject<T, Relations, P, DB>
			: T
		: Config extends { select: infer S }
			? S extends SelectConfig<T, Relations, DB>
				? ApplySelectConfig<T, S, Relations, DB>
				: T
			: T;

export type EngineQueryReturnType<T, Relations, Config, DB> = Config extends {
	cursor: CursorConfig;
}
	? Promise<CursorPageResult<QueryItemType<T, Relations, Config, DB>>>
	: Promise<ReadonlyArray<QueryItemType<T, Relations, Config, DB>>>;

export interface EngineCollection<
	T,
	Relations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	> = Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
	DB = unknown,
> {
	query<
		C extends QueryConfig<T, Relations, DB> = {
			where?: WhereClause<T, Relations, DB>;
		},
	>(config?: C): EngineQueryReturnType<T, Relations, C, DB>;
	aggregate<C extends AggregateConfig<T, Relations, DB>>(
		config: C,
	): Promise<
		C extends { readonly groupBy: string | ReadonlyArray<string> }
			? GroupedAggregateResult
			: AggregateResult
	>;
	findById(id: string): Promise<T>;
	exists(id: string): Promise<boolean>;
	create(input: CreateInput<T>): Promise<T>;
	createMany(
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	): Promise<CreateManyResult<T>>;
	update(id: string, updates: UpdateWithOperators<T>): Promise<T>;
	updateMany(
		where: WhereClause<T, Relations, DB>,
		updates: UpdateWithOperators<T>,
	): Promise<UpdateManyResult<T>>;
	delete(id: string, options?: { readonly soft?: boolean }): Promise<T>;
	deleteMany(
		where: WhereClause<T, Relations, DB>,
		options?: { readonly soft?: boolean; readonly limit?: number },
	): Promise<DeleteManyResult<T>>;
	upsert(input: UpsertInput<T>): Promise<UpsertResult<T>>;
	upsertMany(inputs: ReadonlyArray<UpsertInput<T>>): Promise<UpsertManyResult<T>>;
	createWithRelationships(
		input: CreateWithRelationshipsInput<T, Relations>,
	): Promise<T>;
	updateWithRelationships(
		id: string,
		input: UpdateWithRelationshipsInput<T, Relations>,
	): Promise<T>;
	deleteWithRelationships(
		id: string,
		options?: EngineDeleteWithRelationshipsOptions<T, Relations>,
	): Promise<DeleteWithRelationshipsResult<T>>;
	deleteManyWithRelationships(
		where: WhereClause<T, Relations, DB>,
		options?: EngineDeleteWithRelationshipsOptions<T, Relations> & {
			readonly limit?: number;
		},
	): Promise<{
		readonly count: number;
		readonly deleted: ReadonlyArray<T>;
		readonly cascaded?: Record<
			string,
			{ readonly count: number; readonly ids: ReadonlyArray<string> }
		>;
	}>;
	watch<C extends EngineWatchConfig<T, Relations, DB>>(
		config?: C,
	): WatchSubscription<ReadonlyArray<QueryItemType<T, Relations, C, DB>>>;
	watchById(id: string, options?: { readonly debounceMs?: number }): WatchSubscription<T | null>;
}

type EntityWithComputed<Entity, Computed> = Computed extends ComputedFieldsConfig<Entity>
	? Entity & InferComputedFields<Computed>
	: Entity;

export type EngineDatabaseEntityMap<Config> = {
	[P in keyof ConfiguredCollections<Config>]: RuntimeEntityFromCollection<
		ConfiguredCollections<Config>[P]
	>;
};

type EngineCollectionMap<Config, DB> = {
	[K in keyof ConfiguredCollections<Config>]: ConfiguredCollections<Config>[K] extends {
		relationships: infer Relations;
		computed?: infer Computed;
	}
		? EngineCollection<
				EntityWithComputed<
					RuntimeEntityFromCollection<ConfiguredCollections<Config>[K]>,
					Computed
				>,
				ResolveRelationships<Relations, EngineDatabaseEntityMap<Config>>,
				DB
			>
		: never;
};

export type EngineTransactionDatabase<Config> = EngineCollectionMap<
	Config,
	CoreGenerateDatabase<Config>
> & {
	readonly rollback: () => Promise<never>;
};

export type GenerateEngineDatabase<Config> = EngineCollectionMap<
	Config,
	CoreGenerateDatabase<Config>
> & {
	readonly $transaction: <A>(
		fn: (ctx: EngineTransactionDatabase<Config>) => Promise<A>,
	) => Promise<A>;
	readonly $documentGraph: {
		getRecordProvenance: (
			collection: string,
			id: string,
		) => Promise<unknown | undefined>;
		getDiagnostics: () => Promise<ReadonlyArray<unknown>>;
	};
	readonly close: () => Promise<void>;
};

export type GenerateEngineDatabaseWithPersistence<Config> =
	GenerateEngineDatabase<Config> & {
		readonly flush: () => Promise<void>;
		readonly pendingCount: () => number;
		readonly $dryRunMigrations: () => Promise<DryRunResult>;
	};

export type EngineDatabaseConfig = Record<string, CollectionConfig>;
export type EngineInitialData<Config> = Partial<DatasetFor<Config>>;

export type EngineDatabaseOptions = {
	readonly plugins?: ReadonlyArray<ProseQLPlugin>;
};

export type EnginePersistenceOptions = {
	readonly writeDebounce?: number;
	readonly storageHost?: import("./storage-host-shared.js").EngineStorageHost;
	readonly storageLayer?: import("effect").Layer.Layer<any>;
	readonly serializerRegistry?: import("@proseql/core").SerializerRegistryShape;
	readonly _persistObjectFile?: (
		path: string,
		data: unknown,
		format: string,
	) => Promise<void>;
	readonly _suppressInitialWrites?: boolean;
};
