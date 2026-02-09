/**
 * Legacy CRUD factory types using Promise<Result<T, E>>.
 * These are superseded by the Effect-based types in crud-factory.ts.
 * Kept for backward compatibility with the old database.ts factory.
 */

import type { z } from "zod";
import type {
	MinimalEntity,
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	UpdateWithOperators,
	UpdateManyResult,
	DeleteOptions,
	DeleteManyOptions,
	DeleteManyResult,
	UpsertInput,
	UpsertResult,
	UpsertManyResult,
} from "../types/crud-types.js";
import type { LegacyCrudError as CrudError, Result } from "../errors/legacy.js";
import { isErr } from "../errors/legacy.js";
import type { RelationshipDef, WhereClause } from "../types/types.js";

import {
	createCreateMethod,
	createCreateManyMethod,
} from "../operations/crud/create.js";
import {
	createUpdateMethod,
	createUpdateManyMethod,
} from "../operations/crud/update.js";
import {
	createDeleteMethod,
	createDeleteManyMethod,
} from "../operations/crud/delete.js";
import {
	createUpsertMethod,
	createUpsertManyMethod,
} from "../operations/crud/upsert.js";

// ============================================================================
// Legacy CRUD Methods Type (Promise-based)
// ============================================================================

export interface LegacyCrudMethods<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
> {
	create(input: CreateInput<T>): Promise<Result<T, CrudError<T>>>;
	createMany(
		inputs: CreateInput<T>[],
		options?: CreateManyOptions,
	): Promise<Result<CreateManyResult<T>, CrudError<T>>>;
	update(
		id: string,
		updates: UpdateWithOperators<T>,
	): Promise<Result<T, CrudError<T>>>;
	updateMany(
		where: WhereClause<T, TRelations, TDB>,
		updates: UpdateWithOperators<T>,
	): Promise<Result<UpdateManyResult<T>, CrudError<T>>>;
	delete(
		id: string,
		options?: DeleteOptions<T>,
	): Promise<Result<T, CrudError<T>>>;
	deleteMany(
		where: WhereClause<T, TRelations, TDB>,
		options?: DeleteManyOptions<T>,
	): Promise<Result<DeleteManyResult<T>, CrudError<T>>>;
	upsert<UniqueFields extends keyof T = never>(
		input: UpsertInput<T, UniqueFields>,
	): Promise<Result<UpsertResult<T>, CrudError<T>>>;
	upsertMany<UniqueFields extends keyof T = never>(
		inputs: UpsertInput<T, UniqueFields>[],
	): Promise<Result<UpsertManyResult<T>, CrudError<T>>>;
}

// ============================================================================
// Legacy CRUD Factory
// ============================================================================

export function createLegacyCrudMethods<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
>(
	collectionName: string,
	schema: z.ZodType<T>,
	relationships: TRelations,
	data: Record<string, unknown[]>,
	config: Record<
		string,
		{
			schema: z.ZodType<unknown>;
			relationships: Record<
				string,
				RelationshipDef<unknown, "ref" | "inverse", string>
			>;
		}
	>,
): LegacyCrudMethods<T, TRelations, TDB> {
	const getCollectionData = (): T[] => {
		return (data[collectionName] as T[]) || [];
	};

	const setCollectionData = (newData: T[]): void => {
		data[collectionName] = newData;
	};

	const allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	> = {};
	for (const [coll, def] of Object.entries(config)) {
		allRelationships[coll] = def.relationships;
	}

	return {
		create: createCreateMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
		),
		createMany: createCreateManyMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
		),
		update: createUpdateMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
		),
		updateMany: createUpdateManyMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			config,
		),
		delete: createDeleteMethod(
			collectionName,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			allRelationships,
		),
		deleteMany: createDeleteManyMethod(
			collectionName,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			allRelationships,
			config,
		),
		upsert: createUpsertMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
		),
		upsertMany: createUpsertManyMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
		),
	};
}

export function wrapLegacyCrudMethods<
	T extends MinimalEntity,
	TRelations extends Record<string, RelationshipDef<unknown>>,
	TDB,
>(
	methods: LegacyCrudMethods<T, TRelations, TDB>,
	throwOnError: boolean = false,
): LegacyCrudMethods<T, TRelations, TDB> {
	if (!throwOnError) {
		return methods;
	}

	const throwingMethods: LegacyCrudMethods<T, TRelations, TDB> = {
		create: async (input) => {
			const result = await methods.create(input);
			if (isErr(result)) throw result.error;
			return result;
		},
		createMany: async (inputs, options) => {
			const result = await methods.createMany(inputs, options);
			if (isErr(result)) throw result.error;
			return result;
		},
		update: async (id, updates) => {
			const result = await methods.update(id, updates);
			if (isErr(result)) throw result.error;
			return result;
		},
		updateMany: async (where, updates) => {
			const result = await methods.updateMany(where, updates);
			if (isErr(result)) throw result.error;
			return result;
		},
		delete: async (id, options) => {
			const result = await methods.delete(id, options as DeleteOptions<T>);
			if (isErr(result)) throw result.error;
			return result;
		},
		deleteMany: async (where, options) => {
			const result = await methods.deleteMany(
				where,
				options as DeleteManyOptions<T>,
			);
			if (isErr(result)) throw result.error;
			return result;
		},
		upsert: async (input) => {
			const result = await methods.upsert(input);
			if (isErr(result)) throw result.error;
			return result;
		},
		upsertMany: async (inputs) => {
			const result = await methods.upsertMany(inputs);
			if (isErr(result)) throw result.error;
			return result;
		},
	};

	return throwingMethods;
}
