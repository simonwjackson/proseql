/**
 * Factory for creating CRUD methods with full type safety
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
// CRUD Methods Type
// ============================================================================

export interface CrudMethods<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
> {
	// Create operations
	create(input: CreateInput<T>): Promise<Result<T, CrudError<T>>>;
	createMany(
		inputs: CreateInput<T>[],
		options?: CreateManyOptions,
	): Promise<Result<CreateManyResult<T>, CrudError<T>>>;

	// Update operations
	update(
		id: string,
		updates: UpdateWithOperators<T>,
	): Promise<Result<T, CrudError<T>>>;
	updateMany(
		where: WhereClause<T, TRelations, TDB>,
		updates: UpdateWithOperators<T>,
	): Promise<Result<UpdateManyResult<T>, CrudError<T>>>;

	// Delete operations
	delete(
		id: string,
		options?: DeleteOptions<T>,
	): Promise<Result<T, CrudError<T>>>;
	deleteMany(
		where: WhereClause<T, TRelations, TDB>,
		options?: DeleteManyOptions<T>,
	): Promise<Result<DeleteManyResult<T>, CrudError<T>>>;

	// Upsert operations
	upsert<UniqueFields extends keyof T = never>(
		input: UpsertInput<T, UniqueFields>,
	): Promise<Result<UpsertResult<T>, CrudError<T>>>;
	upsertMany<UniqueFields extends keyof T = never>(
		inputs: UpsertInput<T, UniqueFields>[],
	): Promise<Result<UpsertManyResult<T>, CrudError<T>>>;
}

// ============================================================================
// CRUD Factory
// ============================================================================

/**
 * Create all CRUD methods for a collection
 */
export function createCrudMethods<
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
): CrudMethods<T, TRelations, TDB> {
	// Helper to get mutable collection data
	const getCollectionData = (): T[] => {
		return (data[collectionName] as T[]) || [];
	};

	// Helper to set collection data
	const setCollectionData = (newData: T[]): void => {
		data[collectionName] = newData;
	};

	// Extract all relationships for constraint checking
	// Convert raw relationships to RelationshipDef format
	const allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	> = {};
	for (const [coll, def] of Object.entries(config)) {
		allRelationships[coll] = def.relationships;
	}

	return {
		// Create operations
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

		// Update operations
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

		// Delete operations
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

		// Upsert operations
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

// ============================================================================
// Helper to check if a type extends BaseEntity
// ============================================================================

/**
 * Wrap CRUD methods to work with Result type or throw
 */
export function wrapCrudMethods<
	T extends MinimalEntity,
	TRelations extends Record<string, RelationshipDef<unknown>>,
	TDB,
>(
	methods: CrudMethods<T, TRelations, TDB>,
	throwOnError: boolean = false,
): CrudMethods<T, TRelations, TDB> {
	if (!throwOnError) {
		return methods;
	}

	// Create throwing versions of each method
	const throwingMethods: CrudMethods<T, TRelations, TDB> = {
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
