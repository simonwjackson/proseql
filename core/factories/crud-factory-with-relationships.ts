/**
 * Extended CRUD factory with relationship support
 * Implements Phase 2 relationship features
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
import { CrudMethods } from "./crud-factory.js";

// Import standard CRUD operations
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

// Import relationship-aware CRUD operations
import { createCreateWithRelationshipsMethod } from "../operations/crud/create-with-relationships.js";
import { createUpdateWithRelationshipsMethod } from "../operations/crud/update-with-relationships.js";
import {
	createDeleteWithRelationshipsMethod,
	createDeleteManyWithRelationshipsMethod,
} from "../operations/crud/delete-with-relationships.js";

// ============================================================================
// Extended CRUD Methods Type
// ============================================================================

export interface CrudMethodsWithRelationships<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
> extends Omit<CrudMethods<T, TRelations, TDB>, "delete" | "deleteMany"> {
	// Override delete operations with overloaded signatures for better type inference
	delete(
		id: string,
		options?: DeleteOptions<T>,
	): Promise<Result<T, CrudError<T>>>;

	deleteMany(
		where: WhereClause<T, TRelations, TDB>,
		options?: DeleteManyOptions<T>,
	): Promise<Result<DeleteManyResult<T>, CrudError<T>>>;

	// Create with relationships
	createWithRelationships(
		input: CreateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>>;

	// Update with relationships
	updateWithRelationships(
		id: string,
		input: UpdateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>>;

	// Delete with relationships
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

// ============================================================================
// Database Configuration Type
// ============================================================================

type DatabaseConfig = Record<
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
// Extended CRUD Factory
// ============================================================================

/**
 * Create all CRUD methods including relationship operations
 */
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
	config: DatabaseConfig,
): CrudMethodsWithRelationships<T, TRelations, TDB> {
	// Helper to get mutable collection data
	const getCollectionData = (): T[] => {
		return (data[collectionName] as T[]) || [];
	};

	// Helper to set collection data
	const setCollectionData = (newData: T[]): void => {
		data[collectionName] = newData;
	};

	// Extract all relationships for constraint checking
	const allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	> = {};
	for (const [coll, def] of Object.entries(config)) {
		allRelationships[coll] = def.relationships;
	}

	return {
		// Standard CRUD operations
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

		// Relationship-aware operations
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

// ============================================================================
// Wrapper for throwing/non-throwing behavior
// ============================================================================

/**
 * Wrap CRUD methods to work with Result type or throw
 */
export function wrapCrudMethodsWithRelationships<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
>(
	methods: CrudMethodsWithRelationships<T, TRelations, TDB>,
	throwOnError: boolean = false,
): CrudMethodsWithRelationships<T, TRelations, TDB> {
	if (!throwOnError) {
		return methods;
	}

	// Create throwing versions of each method
	const throwingMethods: CrudMethodsWithRelationships<T, TRelations, TDB> = {
		// Standard CRUD methods
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

		// Relationship methods
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
