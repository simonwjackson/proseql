import type { Effect, Schema, Stream } from "effect";
import type { EffectCollection, RunnableEffect, RunnableStream } from "../factories/database-effect.js";
import type { MinimalEntity, TransactionContext } from "./crud-types.js";
import type { DanglingReferenceError } from "../errors/query-errors.js";
import type { TransactionError } from "../errors/crud-errors.js";
import type {
	AggregateConfig,
	AggregateResult,
	GroupedAggregateResult,
} from "./aggregate-types.js";
import type { CursorConfig, RunnableCursorPage } from "./cursor-types.js";
import type { ValidationError } from "../errors/crud-errors.js";
import type { ComputedFieldsConfig, InferComputedFields } from "./computed-types.js";

// ============================================================================
// Core Types
// ============================================================================

// Generic record type for objects with string keys
export type UnknownRecord = Record<string, unknown>;

// Filter operators
export type FilterOperators<T> = T extends string
	? {
			$eq?: T;
			$ne?: T;
			$gt?: string;
			$gte?: string;
			$lt?: string;
			$lte?: string;
			$startsWith?: string;
			$endsWith?: string;
			$contains?: string;
			$in?: T[];
			$nin?: T[];
		}
	: T extends number
		? {
				$eq?: T;
				$ne?: T;
				$gt?: number;
				$gte?: number;
				$lt?: number;
				$lte?: number;
				$in?: T[];
				$nin?: T[];
			}
		: T extends boolean
			? {
					$eq?: T;
					$ne?: T;
				}
			: T extends readonly (infer U)[]
				? {
						$eq?: T;
						$ne?: T;
						$in?: T[];
						$nin?: T[];
						$contains?: U;
						$all?: U[];
						$size?: number;
					}
				: {
						$eq?: T;
						$ne?: T;
						$in?: T[];
						$nin?: T[];
					};

// Relationship definition with phantom type and target collection
export type RelationshipDef<
	T = unknown,
	Type extends "ref" | "inverse" = "ref",
	Target extends string = string,
> = {
	type: Type;
	foreignKey?: string;
	target?: Target; // Make target optional but available
	__target?: T; // Phantom type for TypeScript
	__targetCollection?: Target; // Phantom type for collection name
};

// Extract all entity mappings from database structure
export type ExtractDBMapping<DB> = {
	[K in keyof DB]: DB[K] extends SmartCollection<
		infer Entity,
		infer Relations,
		DB
	>
		? { entity: Entity; relations: Relations }
		: never;
}[keyof DB];

// Automatically find relations for any entity type by collection name
export type FindRelationsByCollection<
	DB,
	CollectionName extends keyof DB,
> = DB[CollectionName] extends SmartCollection<
	infer Entity,
	infer Relations,
	DB
>
	? Relations
	: Record<string, never>;

// Keep the old one for backward compatibility but simplified
export type FindRelationsForEntity<DB, T> = Record<string, never>; // Simplified for now

// Helper type to extract the target collection from a relationship
type GetRelationshipTargetCollection<R> = R extends RelationshipDef<
	infer _,
	infer __,
	infer Target
>
	? Target
	: never;

// Helper to extract nested object field paths (for dot notation) - limited to 2 levels deep to avoid infinite recursion
type ExtractNestedPaths<T> = {
	[K in keyof T]: T[K] extends Record<string, unknown>
		?
				| `${K & string}`
				| {
						[NK in keyof T[K]]: `${K & string}.${NK & string}`;
				  }[keyof T[K]]
		: `${K & string}`;
}[keyof T];

// Create a where clause type for an entity with its relationships
// Supports field filters, relationship filters, nested field paths, and conditional logic ($or, $and, $not)
export type WhereClause<T, Relations, DB> = {
	[K in keyof T]?: T[K] | FilterOperators<T[K]>;
} & {
	[K in keyof Relations]?: Relations[K] extends RelationshipDef<
		infer _,
		"ref",
		infer TargetColl
	>
		? TargetColl extends keyof DB
			? WhereClause<
					GetEntityFromCollection<DB, TargetColl>,
					FindRelationsByCollection<DB, TargetColl>,
					DB
				>
			: never
		: Relations[K] extends RelationshipDef<infer _, "inverse", infer TargetColl>
			? TargetColl extends keyof DB
				? {
						$some?: WhereClause<
							GetEntityFromCollection<DB, TargetColl>,
							FindRelationsByCollection<DB, TargetColl>,
							DB
						>;
						$every?: WhereClause<
							GetEntityFromCollection<DB, TargetColl>,
							FindRelationsByCollection<DB, TargetColl>,
							DB
						>;
						$none?: WhereClause<
							GetEntityFromCollection<DB, TargetColl>,
							FindRelationsByCollection<DB, TargetColl>,
							DB
						>;
					}
				: never
			: never;
} & {
	// Support for dot notation paths in nested objects
	[K in ExtractNestedPaths<T> as K extends keyof T ? never : K]?: unknown;
} & {
	// Conditional logic operators
	$or?: Array<WhereClause<T, Relations, DB>>;
	$and?: Array<WhereClause<T, Relations, DB>>;
	$not?: WhereClause<T, Relations, DB>;
};

// ============================================================================
// Object-Based Field Selection Types
// ============================================================================

// Helper type for nested object selection - allows selection on nested object properties
// Simplified version to avoid infinite recursion
type NestedObjectSelectConfig<T> = {
	[K in keyof T]?: true;
};

// Object-based select configuration - supports nested selection for populated fields and nested objects
// Usage: { select: { name: true, email: true, metadata: { views: true }, profile: { company: true } } }
export type ObjectSelectConfig<T, Relations, DB> = {
	[K in keyof T]?: true | Record<string, true | Record<string, true>>;
} & {
	[K in keyof Relations]?: Relations[K] extends RelationshipDef<
		infer _,
		infer Type,
		infer TargetColl
	>
		? TargetColl extends keyof DB
			? Type extends "ref"
				?
						| true
						| ObjectSelectConfig<
								GetEntityFromCollection<DB, TargetColl>,
								FindRelationsByCollection<DB, TargetColl>,
								DB
						  >
				: Type extends "inverse"
					?
							| true
							| ObjectSelectConfig<
									GetEntityFromCollection<DB, TargetColl>,
									FindRelationsByCollection<DB, TargetColl>,
									DB
							  >
					: never
			: never
		: never;
};

// Legacy array-based select configuration for backward compatibility
export type ArraySelectConfig<T> = ReadonlyArray<keyof T>;

// Union type supporting both object and array-based selection
export type SelectConfig<T, Relations, DB> =
	| ObjectSelectConfig<T, Relations, DB>
	| ArraySelectConfig<T>;

// Helper type to apply nested object selection
type ApplyNestedObjectSelect<T, Config> = Config extends Record<string, unknown>
	? {
			[K in keyof Config & keyof T]: Config[K] extends true
				? T[K]
				: Config[K] extends Record<string, unknown>
					? T[K] extends Record<string, unknown>
						? ApplyNestedObjectSelect<T[K], Config[K]>
						: never
					: never;
		}
	: T;

// Apply object-based select configuration to transform entity type
export type ApplyObjectSelectConfig<T, Config> = Config extends Record<
	string,
	unknown
>
	? ApplyNestedObjectSelect<T, Config>
	: T;

// Apply array-based select configuration (legacy support)
export type ApplyArraySelectConfig<T, Config> = Config extends ReadonlyArray<
	keyof T
>
	? Pick<T, Config[number] & keyof T>
	: T;

// Apply object-based select with relationship population
export type ApplyObjectSelectWithPopulation<T, Config, Relations, DB> =
	Config extends Record<string, unknown>
		? ApplyNestedObjectSelect<T, Config> & {
				[K in keyof Config & keyof Relations]: Config[K] extends true
					? Relations[K] extends RelationshipDef<
							infer _,
							infer Type,
							infer TargetColl
						>
						? TargetColl extends keyof DB
							? Type extends "ref"
								? GetEntityFromCollection<DB, TargetColl>
								: Type extends "inverse"
									? Array<GetEntityFromCollection<DB, TargetColl>>
									: never
							: never
						: never
					: Config[K] extends Record<string, unknown>
						? Relations[K] extends RelationshipDef<
								infer _,
								infer Type,
								infer TargetColl
							>
							? TargetColl extends keyof DB
								? Type extends "ref"
									? ApplyObjectSelectWithPopulation<
											GetEntityFromCollection<DB, TargetColl>,
											Config[K],
											FindRelationsByCollection<DB, TargetColl>,
											DB
										>
									: Type extends "inverse"
										? Array<
												ApplyObjectSelectWithPopulation<
													GetEntityFromCollection<DB, TargetColl>,
													Config[K],
													FindRelationsByCollection<DB, TargetColl>,
													DB
												>
											>
										: never
								: never
							: never
						: never;
			}
		: T;

// Main select configuration application type
export type ApplySelectConfig<
	T,
	Config,
	Relations = {},
	DB = {},
> = Config extends ReadonlyArray<keyof T>
	? ApplyArraySelectConfig<T, Config>
	: Config extends Record<string, unknown>
		? Relations extends Record<string, unknown>
			? DB extends Record<string, unknown>
				? ApplyObjectSelectWithPopulation<T, Config, Relations, DB>
				: ApplyObjectSelectConfig<T, Config>
			: ApplyObjectSelectConfig<T, Config>
		: T;

// Helper types for separating ref and inverse relationships
type RefRelationKeys<Relations> = {
	[K in keyof Relations]: Relations[K] extends { type: "ref" } ? K : never;
}[keyof Relations];

type InverseRelationKeys<Relations> = {
	[K in keyof Relations]: Relations[K] extends { type: "inverse" } ? K : never;
}[keyof Relations];

// Advanced type for handling object-based selection with nested population
// Advanced type for handling object-based selection with nested population
export type ApplyObjectSelectWithPopulate<
	T,
	Relations,
	SelectConf,
	PopulateConf,
	DB,
> = {
	// Selected base entity fields
	[K in keyof SelectConf & keyof T]: SelectConf[K] extends true ? T[K] : never;
} & {
	// Selected and populated ref relationships (optional fields)
	[K in keyof SelectConf &
		keyof Relations &
		RefRelationKeys<Relations>]?: SelectConf[K] extends Record<string, unknown>
		? GetTargetCollection<Relations, K> extends keyof DB
			? Relations[K] extends RelationshipDef<infer _, "ref", infer TargetColl>
				? TargetColl extends keyof DB
					? ApplyObjectSelectWithPopulate<
							GetEntityFromCollection<DB, TargetColl>,
							FindRelationsByCollection<DB, TargetColl>,
							SelectConf[K],
							Record<string, never>,
							DB
						>
					: never
				: never
			: never
		: PopulateConf extends PopulateConfig<Relations, DB>
			? K extends keyof PopulateConf
				? PopulateConf[K] extends true
					? GetTargetCollection<Relations, K> extends keyof DB
						? GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>
						: never
					: PopulateConf[K] extends PopulateConfig<infer _, DB>
						? GetTargetCollection<Relations, K> extends keyof DB
							? ApplyPopulateObject<
									GetEntityFromCollection<
										DB,
										GetTargetCollection<Relations, K>
									>,
									FindRelationsByCollection<
										DB,
										GetTargetCollection<Relations, K>
									>,
									Extract<
										PopulateConf[K],
										PopulateConfig<
											FindRelationsByCollection<
												DB,
												GetTargetCollection<Relations, K>
											>,
											DB
										>
									>,
									DB
								>
							: never
						: never
				: never
			: never;
} & {
	// Selected and populated inverse relationships (required array fields)
	[K in keyof SelectConf &
		keyof Relations &
		InverseRelationKeys<Relations>]: SelectConf[K] extends Record<
		string,
		unknown
	>
		? GetTargetCollection<Relations, K> extends keyof DB
			? Relations[K] extends RelationshipDef<
					infer _,
					"inverse",
					infer TargetColl
				>
				? TargetColl extends keyof DB
					? Array<
							ApplyObjectSelectWithPopulate<
								GetEntityFromCollection<DB, TargetColl>,
								FindRelationsByCollection<DB, TargetColl>,
								SelectConf[K],
								Record<string, never>,
								DB
							>
						>
					: never
				: never
			: never
		: PopulateConf extends PopulateConfig<Relations, DB>
			? K extends keyof PopulateConf
				? PopulateConf[K] extends true
					? GetTargetCollection<Relations, K> extends keyof DB
						? Array<
								GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>
							>
						: never
					: PopulateConf[K] extends PopulateConfig<infer _, DB>
						? GetTargetCollection<Relations, K> extends keyof DB
							? Array<
									ApplyPopulateObject<
										GetEntityFromCollection<
											DB,
											GetTargetCollection<Relations, K>
										>,
										FindRelationsByCollection<
											DB,
											GetTargetCollection<Relations, K>
										>,
										Extract<
											PopulateConf[K],
											PopulateConfig<
												FindRelationsByCollection<
													DB,
													GetTargetCollection<Relations, K>
												>,
												DB
											>
										>,
										DB
									>
								>
							: never
						: never
				: never
			: never;
};

// Enhanced select and populate combination that supports both object and array-based selection
export type ApplySelectAndPopulate<T, Relations, SelectConf, PopulateConf, DB> =
	// Object-based selection
	SelectConf extends Record<string, unknown>
		? ApplyObjectSelectWithPopulate<T, Relations, SelectConf, PopulateConf, DB>
		: // Array-based selection (legacy)
			SelectConf extends ArraySelectConfig<T>
			? ApplyArraySelectConfig<T, SelectConf> &
					(PopulateConf extends PopulateConfig<Relations, DB>
						? // Optional fields for ref relationships
							{
								[K in keyof PopulateConf &
									RefRelationKeys<Relations>]?: PopulateConf[K] extends true
									? GetTargetCollection<Relations, K> extends keyof DB
										? GetEntityFromCollection<
												DB,
												GetTargetCollection<Relations, K>
											>
										: never
									: PopulateConf[K] extends PopulateConfig<infer _, DB>
										? GetTargetCollection<Relations, K> extends keyof DB
											? ApplyPopulateObject<
													GetEntityFromCollection<
														DB,
														GetTargetCollection<Relations, K>
													>,
													FindRelationsByCollection<
														DB,
														GetTargetCollection<Relations, K>
													>,
													Extract<
														PopulateConf[K],
														PopulateConfig<
															FindRelationsByCollection<
																DB,
																GetTargetCollection<Relations, K>
															>,
															DB
														>
													>,
													DB
												>
											: never
										: never;
							} & { // Required fields for inverse relationships
								[K in keyof PopulateConf &
									InverseRelationKeys<Relations>]: PopulateConf[K] extends true
									? GetTargetCollection<Relations, K> extends keyof DB
										? Array<
												GetEntityFromCollection<
													DB,
													GetTargetCollection<Relations, K>
												>
											>
										: never
									: PopulateConf[K] extends PopulateConfig<infer _, DB>
										? GetTargetCollection<Relations, K> extends keyof DB
											? Array<
													ApplyPopulateObject<
														GetEntityFromCollection<
															DB,
															GetTargetCollection<Relations, K>
														>,
														FindRelationsByCollection<
															DB,
															GetTargetCollection<Relations, K>
														>,
														Extract<
															PopulateConf[K],
															PopulateConfig<
																FindRelationsByCollection<
																	DB,
																	GetTargetCollection<Relations, K>
																>,
																DB
															>
														>,
														DB
													>
												>
											: never
										: never;
							}
						: Record<string, never>)
			: // No selection, just populate
				PopulateConf extends PopulateConfig<Relations, DB>
				? ApplyPopulateObject<T, Relations, PopulateConf, DB>
				: T;

// ============================================================================
// New Object-based Populate Types
// ============================================================================

// Helper to get collection name from resolved relationships
export type GetTargetCollection<
	Relations,
	K extends keyof Relations,
> = Relations[K] extends { target: infer TargetColl } ? TargetColl : never;

// Populate configuration - allows true or nested config for each relationship
export type PopulateConfig<
	Relations,
	DB,
	Depth extends unknown[] = [],
> = Depth["length"] extends 5 // Max depth to prevent infinite recursion
	? never
	: {
			[K in keyof Relations]?: GetTargetCollection<
				Relations,
				K
			> extends keyof DB
				?
						| true
						| PopulateConfig<
								FindRelationsByCollection<
									DB,
									GetTargetCollection<Relations, K>
								>,
								DB,
								[...Depth, unknown]
						  >
				: never;
		};

// Helper to get entity type from collection
export type GetEntityFromCollection<
	DB,
	CollectionName extends keyof DB,
> = DB[CollectionName] extends SmartCollection<
	infer Entity,
	infer Relations,
	DB
>
	? Entity
	: never;

// Apply populate configuration to transform entity type
export type ApplyPopulateObject<T, Relations, Config, DB> = T & { // Optional fields for ref relationships
	[K in keyof Config & RefRelationKeys<Relations>]?: Config[K] extends true
		? GetTargetCollection<Relations, K> extends keyof DB
			? GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>
			: never
		: Config[K] extends PopulateConfig<infer _, DB, infer __>
			? GetTargetCollection<Relations, K> extends keyof DB
				? ApplyPopulateObject<
						GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>,
						FindRelationsByCollection<DB, GetTargetCollection<Relations, K>>,
						Config[K],
						DB
					>
				: never
			: never;
} & { // Required fields for inverse relationships
	[K in keyof Config & InverseRelationKeys<Relations>]: Config[K] extends true
		? GetTargetCollection<Relations, K> extends keyof DB
			? Array<GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>>
			: never
		: Config[K] extends PopulateConfig<infer _, DB, infer __>
			? GetTargetCollection<Relations, K> extends keyof DB
				? Array<
						ApplyPopulateObject<
							GetEntityFromCollection<DB, GetTargetCollection<Relations, K>>,
							FindRelationsByCollection<DB, GetTargetCollection<Relations, K>>,
							Config[K],
							DB
						>
					>
				: never
			: never;
};

// Sort order type
export type SortOrder = "asc" | "desc";

// Helper to extract valid sort paths based on populated relationships
type ExtractSortPaths<
	T,
	Relations,
	Config,
	DB,
	Prefix extends string = "",
> = // Direct fields of the entity
| (Prefix extends "" ? keyof T : never)
// Relationship paths based on what's populated
| (Config extends { populate: infer P }
		? P extends PopulateConfig<Relations, DB>
			? {
					[K in keyof P & keyof Relations]: P[K] extends true
						? GetTargetCollection<Relations, K> extends keyof DB
							? Relations[K] extends RelationshipDef<infer _, "ref">
								? `${K & string}.${keyof GetEntityFromCollection<DB, GetTargetCollection<Relations, K>> & string}`
								: never
							: never
						: P[K] extends PopulateConfig<infer _, DB>
							? GetTargetCollection<Relations, K> extends keyof DB
								? Relations[K] extends RelationshipDef<infer _, "ref">
									?
											| `${K & string}.${keyof GetEntityFromCollection<DB, GetTargetCollection<Relations, K>> & string}`
											| `${K & string}.${ExtractSortPaths<
													GetEntityFromCollection<
														DB,
														GetTargetCollection<Relations, K>
													>,
													FindRelationsByCollection<
														DB,
														GetTargetCollection<Relations, K>
													>,
													{ populate: P[K] },
													DB,
													`${K & string}.`
											  > &
													string}`
									: never
								: never
							: never;
				}[keyof P & keyof Relations]
			: never
		: never);

// Sort configuration type with support for nested object paths
export type SortConfig<T, Relations, Config, DB> = Partial<
	Record<
		ExtractSortPaths<T, Relations, Config, DB> | ExtractNestedPaths<T>,
		SortOrder
	>
>;

// Enhanced query config that properly discriminates between populated and non-populated queries
// Now supports both object-based and array-based selection
// Cursor variants exclude limit/offset (limit lives inside CursorConfig)
export type QueryConfig<T, Relations, DB> =
	// Offset pagination without populate
	| {
			where?: WhereClause<T, Relations, DB>;
			sort?: SortConfig<T, Relations, {}, DB>;
			select?: SelectConfig<T, Relations, DB>;
			limit?: number;
			offset?: number;
	  }
	// Offset pagination with populate
	| {
			populate: PopulateConfig<Relations, DB>;
			where?: WhereClause<T, Relations, DB>;
			sort?: SortConfig<
				T,
				Relations,
				{ populate: PopulateConfig<Relations, DB> },
				DB
			>;
			select?: SelectConfig<T, Relations, DB>;
			limit?: number;
			offset?: number;
	  }
	// Cursor pagination without populate
	| {
			cursor: CursorConfig;
			where?: WhereClause<T, Relations, DB>;
			sort?: SortConfig<T, Relations, {}, DB>;
			select?: SelectConfig<T, Relations, DB>;
	  }
	// Cursor pagination with populate
	| {
			cursor: CursorConfig;
			populate: PopulateConfig<Relations, DB>;
			where?: WhereClause<T, Relations, DB>;
			sort?: SortConfig<
				T,
				Relations,
				{ populate: PopulateConfig<Relations, DB> },
				DB
			>;
			select?: SelectConfig<T, Relations, DB>;
	  };

// Helper type to compute the item type based on populate/select config
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

// Enhanced query return type that supports both object and array-based selection
// Uses RunnableStream (Stream.Stream + .runPromise) for composable query pipelines with typed errors
// Cursor pagination returns RunnableCursorPage instead of RunnableStream
export type QueryReturnType<T, Relations, Config, DB> = Config extends { cursor: CursorConfig }
	? RunnableCursorPage<
			QueryItemType<T, Relations, Config, DB>,
			DanglingReferenceError | ValidationError
		>
	: Config extends {
			populate: infer P;
			select: infer S;
		}
		? P extends PopulateConfig<Relations, DB>
			? S extends SelectConfig<T, Relations, DB>
				? RunnableStream<ApplySelectAndPopulate<T, Relations, S, P, DB>, DanglingReferenceError>
				: RunnableStream<ApplyPopulateObject<T, Relations, P, DB>, DanglingReferenceError>
			: RunnableStream<T, DanglingReferenceError>
		: Config extends { populate: infer P }
			? P extends PopulateConfig<Relations, DB>
				? RunnableStream<ApplyPopulateObject<T, Relations, P, DB>, DanglingReferenceError>
				: RunnableStream<T, DanglingReferenceError>
			: Config extends { select: infer S }
				? S extends SelectConfig<T, Relations, DB>
					? RunnableStream<ApplySelectConfig<T, S, Relations, DB>, DanglingReferenceError>
					: RunnableStream<T, DanglingReferenceError>
				: RunnableStream<T, DanglingReferenceError>;

export type SmartCollection<
	T,
	Relations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	> = Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
	DB = unknown,
> = {
	query<
		C extends QueryConfig<T, Relations, DB> = {
			where?: WhereClause<T, Relations, DB>;
		},
	>(config?: C): QueryReturnType<T, Relations, C, DB>;

	/**
	 * Compute aggregates over the collection.
	 *
	 * @param config - Aggregation configuration: which aggregates to compute and optional where/groupBy
	 * @returns Effect with AggregateResult (scalar) or GroupedAggregateResult (when groupBy is present)
	 */
	aggregate<C extends AggregateConfig<T, Relations, DB>>(
		config: C,
	): C extends { readonly groupBy: string | ReadonlyArray<string> }
		? RunnableEffect<GroupedAggregateResult, never>
		: RunnableEffect<AggregateResult, never>;
} & EffectCollection<T & MinimalEntity>;

// Extract all entity types from config
export type ExtractEntityTypes<Config> = {
	[K in keyof Config]: Config[K] extends { schema: Schema.Schema<infer T, infer _E, infer _R> }
		? T
		: never;
};

// Convert string targets to actual types
export type ResolveRelationships<Relations, AllEntities> = {
	[K in keyof Relations]: Relations[K] extends {
		type: infer Type;
		target: infer Target;
		foreignKey?: infer FK;
	}
		? Type extends "ref" | "inverse"
			? Target extends keyof AllEntities
				? Target extends string
					? RelationshipDef<AllEntities[Target], Type, Target> & {
							foreignKey?: FK;
							target: Target;
						}
					: never
				: never
			: never
		: never;
};

// Helper type to merge entity with computed fields when computed config is present
type EntityWithComputed<Entity, Computed> = Computed extends ComputedFieldsConfig<Entity>
	? Entity & InferComputedFields<Computed>
	: Entity;

// Generate the full database type automatically
export type GenerateDatabase<Config> = {
	[K in keyof Config]: Config[K] extends {
		schema: Schema.Schema<infer Entity, infer _E, infer _R>;
		relationships: infer Relations;
		computed?: infer Computed;
	}
		? SmartCollection<
				EntityWithComputed<Entity, Computed>,
				ResolveRelationships<Relations, ExtractEntityTypes<Config>>,
				GenerateDatabase<Config>
			>
		: never;
} & {
	/**
	 * Execute multiple operations atomically within a transaction.
	 * On success, all changes are committed and persistence is triggered.
	 * On failure, all changes are rolled back and the original error is re-raised.
	 */
	$transaction<A, E>(
		fn: (ctx: TransactionContext<GenerateDatabase<Config>>) => Effect.Effect<A, E>,
	): Effect.Effect<A, E | TransactionError>;
};

// Type-safe populate helper for better IntelliSense
export type TypedPopulate<
	DB,
	Collection extends keyof DB,
> = DB[Collection] extends SmartCollection<
	infer T,
	infer Relations,
	infer DBType
>
	? PopulateConfig<Relations, DBType>
	: never;

// Type for the dataset that matches the config
export type DatasetFor<Config> = {
	[K in keyof Config]: Config[K] extends { schema: Schema.Schema<infer T, infer _E, infer _R> }
		? T[]
		: never;
};
