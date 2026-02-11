/**
 * Type definitions for CRUD methods with full type safety.
 *
 * All methods return RunnableEffect (Effect with .runPromise convenience)
 * instead of the legacy Promise<Result<T, E>>.
 */

import type {
	DuplicateKeyError,
	ForeignKeyError,
	NotFoundError,
	OperationError,
	ValidationError,
} from "../errors/crud-errors.js";
import type {
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	DeleteManyResult,
	MinimalEntity,
	UpdateManyResult,
	UpdateWithOperators,
	UpsertInput,
	UpsertManyResult,
	UpsertResult,
} from "../types/crud-types.js";
import type { RunnableEffect } from "./database-effect.js";

// ============================================================================
// CRUD Methods Type (Effect-based)
// ============================================================================

export interface CrudMethods<T extends MinimalEntity> {
	readonly create: (
		input: CreateInput<T>,
	) => RunnableEffect<T, ValidationError | DuplicateKeyError | ForeignKeyError>;

	readonly createMany: (
		inputs: ReadonlyArray<CreateInput<T>>,
		options?: CreateManyOptions,
	) => RunnableEffect<
		CreateManyResult<T>,
		ValidationError | DuplicateKeyError | ForeignKeyError
	>;

	readonly update: (
		id: string,
		updates: UpdateWithOperators<T>,
	) => RunnableEffect<T, ValidationError | NotFoundError | ForeignKeyError>;

	readonly updateMany: (
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T>,
	) => RunnableEffect<UpdateManyResult<T>, ValidationError | ForeignKeyError>;

	readonly delete: (
		id: string,
		options?: { readonly soft?: boolean },
	) => RunnableEffect<T, NotFoundError | OperationError | ForeignKeyError>;

	readonly deleteMany: (
		predicate: (entity: T) => boolean,
		options?: { readonly soft?: boolean; readonly limit?: number },
	) => RunnableEffect<DeleteManyResult<T>, OperationError | ForeignKeyError>;

	readonly upsert: (
		input: UpsertInput<T>,
	) => RunnableEffect<UpsertResult<T>, ValidationError | ForeignKeyError>;

	readonly upsertMany: (
		inputs: ReadonlyArray<UpsertInput<T>>,
	) => RunnableEffect<UpsertManyResult<T>, ValidationError | ForeignKeyError>;
}
