// Alternative approach using function overloads for better type inference

import type {
	ApplyPopulateObject,
	ApplySelectAndPopulate,
	ApplySelectConfig,
	PopulateConfig,
	RelationshipDef,
	SelectConfig,
	SortConfig,
	WhereClause,
} from "./types.js";

// Define separate interfaces for each query variant
export interface QueryWithoutPopulate<T, Relations, DB> {
	where?: WhereClause<T, Relations, DB>;
	sort?: SortConfig<T, Relations, {}, DB>;
	select?: SelectConfig<T, Relations, DB>;
	limit?: number;
	offset?: number;
}

export interface QueryWithPopulate<T, Relations, DB> {
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

// Define overloaded query interface
export interface SmartCollectionWithOverloads<
	T,
	Relations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	DB,
> {
	// Overload 1: Query with populate and select
	query<
		P extends PopulateConfig<Relations, DB>,
		S extends SelectConfig<T, Relations, DB>,
	>(config: {
		populate: P;
		select: S;
		where?: WhereClause<T, Relations, DB>;
		sort?: SortConfig<T, Relations, { populate: P }, DB>;
		limit?: number;
		offset?: number;
	}): AsyncIterable<ApplySelectAndPopulate<T, Relations, S, P, DB>>;

	// Overload 2: Query with populate only
	query<P extends PopulateConfig<Relations, DB>>(config: {
		populate: P;
		where?: WhereClause<T, Relations, DB>;
		sort?: SortConfig<T, Relations, { populate: P }, DB>;
		limit?: number;
		offset?: number;
	}): AsyncIterable<ApplyPopulateObject<T, Relations, P, DB>>;

	// Overload 3: Query with select only
	query<S extends SelectConfig<T, Relations, DB>>(config: {
		select: S;
		where?: WhereClause<T, Relations, DB>;
		sort?: SortConfig<T, Relations, {}, DB>;
		limit?: number;
		offset?: number;
	}): AsyncIterable<ApplySelectConfig<T, S, Relations, DB>>;

	// Overload 4: Query without populate or select
	query(config?: {
		where?: WhereClause<T, Relations, DB>;
		sort?: SortConfig<T, Relations, {}, DB>;
		limit?: number;
		offset?: number;
	}): AsyncIterable<T>;

	// Generic fallback (implementation signature)
	query(config?: unknown): AsyncIterable<unknown>;
}
