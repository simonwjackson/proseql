/**
 * Legacy extended CRUD factory with relationship support.
 * Uses Promise<Result<T, E>> return types.
 * Superseded by Effect-based types in crud-factory-with-relationships.ts.
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
import type {
	CreateWithRelationshipsInput,
	UpdateWithRelationshipsInput,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
} from "../types/crud-relationship-types.js";
import type { LegacyCrudError as CrudError, Result } from "../errors/legacy.js";
import { isErr } from "../errors/legacy.js";
import type { RelationshipDef, WhereClause } from "../types/types.js";
import type { LegacyCrudMethods } from "./crud-factory-legacy.js";

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
import { createCreateWithRelationshipsMethod } from "../operations/crud/create-with-relationships.js";
import { createUpdateWithRelationshipsMethod } from "../operations/crud/update-with-relationships.js";
import {
	createDeleteWithRelationshipsMethod,
	createDeleteManyWithRelationshipsMethod,
} from "../operations/crud/delete-with-relationships.js";

// ============================================================================
// Legacy Extended CRUD Methods Type (Promise-based)
// ============================================================================

export interface LegacyCrudMethodsWithRelationships<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
> extends Omit<LegacyCrudMethods<T, TRelations, TDB>, "delete" | "deleteMany"> {
	delete(
		id: string,
		options?: DeleteOptions<T>,
	): Promise<Result<T, CrudError<T>>>;

	deleteMany(
		where: WhereClause<T, TRelations, TDB>,
		options?: DeleteManyOptions<T>,
	): Promise<Result<DeleteManyResult<T>, CrudError<T>>>;

	createWithRelationships(
		input: CreateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>>;

	updateWithRelationships(
		id: string,
		input: UpdateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>>;

	deleteWithRelationships(
		id: string,
		options?: DeleteWithRelationshipsOptions<T, TRelations>,
	): Promise<Result<DeleteWithRelationshipsResult<T>, CrudError<T>>>;

	deleteManyWithRelationships(
		where: Partial<T>,
		options?: DeleteWithRelationshipsOptions<T, TRelations> & {
			limit?: number;
		},
	): Promise<
		Result<
			{
				count: number;
				deleted: T[];
				cascaded?: Record<string, { count: number; ids: string[] }>;
			},
			CrudError<T>
		>
	>;
}

type LegacyDatabaseConfig = Record<
	string,
	{
		schema: z.ZodType<unknown>;
		relationships: Record<
			string,
			RelationshipDef<unknown, "ref" | "inverse", string>
		>;
	}
>;

// ============================================================================
// Legacy Extended CRUD Factory
// ============================================================================

export function createCrudMethodsWithRelationships<
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
	config: LegacyDatabaseConfig,
): LegacyCrudMethodsWithRelationships<T, TRelations, TDB> {
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
		createWithRelationships: createCreateWithRelationshipsMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			config,
		),
		updateWithRelationships: createUpdateWithRelationshipsMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			config,
		),
		deleteWithRelationships: createDeleteWithRelationshipsMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			config,
		),
		deleteManyWithRelationships: createDeleteManyWithRelationshipsMethod(
			collectionName,
			schema,
			relationships,
			getCollectionData,
			setCollectionData,
			data,
			config,
		),
	};
}

export function wrapCrudMethodsWithRelationships<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
>(
	methods: LegacyCrudMethodsWithRelationships<T, TRelations, TDB>,
	throwOnError: boolean = false,
): LegacyCrudMethodsWithRelationships<T, TRelations, TDB> {
	if (!throwOnError) {
		return methods;
	}

	const throwingMethods: LegacyCrudMethodsWithRelationships<T, TRelations, TDB> = {
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
			const result = await methods.delete(id, options);
			if (isErr(result)) throw result.error;
			return result;
		},
		deleteMany: async (where, options) => {
			const result = await methods.deleteMany(where, options);
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
		createWithRelationships: async (input) => {
			const result = await methods.createWithRelationships(input);
			if (isErr(result)) throw result.error;
			return result;
		},
		updateWithRelationships: async (id, input) => {
			const result = await methods.updateWithRelationships(id, input);
			if (isErr(result)) throw result.error;
			return result;
		},
		deleteWithRelationships: async (id, options) => {
			const result = await methods.deleteWithRelationships(id, options);
			if (isErr(result)) throw result.error;
			return result;
		},
		deleteManyWithRelationships: async (where, options) => {
			const result = await methods.deleteManyWithRelationships(where, options);
			if (isErr(result)) throw result.error;
			return result;
		},
	};

	return throwingMethods;
}
