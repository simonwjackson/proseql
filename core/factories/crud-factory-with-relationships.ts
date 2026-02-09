/**
 * Extended CRUD type definitions with relationship support.
 *
 * All methods return RunnableEffect (Effect with .runPromise convenience)
 * instead of the legacy Promise<Result<T, E>>.
 */

import type {
	MinimalEntity,
} from "../types/crud-types.js";
import type {
	CreateWithRelationshipsInput,
	UpdateWithRelationshipsInput,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
} from "../types/crud-relationship-types.js";
import type { RelationshipDef } from "../types/types.js";
import type {
	NotFoundError,
	ValidationError,
	ForeignKeyError,
	OperationError,
} from "../errors/crud-errors.js";
import type { RunnableEffect } from "./database-effect.js";
import type { CrudMethods } from "./crud-factory.js";

// ============================================================================
// Extended CRUD Methods Type (Effect-based)
// ============================================================================

export interface CrudMethodsWithRelationships<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	> = Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
> extends CrudMethods<T> {
	readonly createWithRelationships: (
		input: CreateWithRelationshipsInput<T, TRelations>,
	) => RunnableEffect<
		T,
		ValidationError | ForeignKeyError | OperationError
	>

	readonly updateWithRelationships: (
		id: string,
		input: UpdateWithRelationshipsInput<T, TRelations>,
	) => RunnableEffect<
		T,
		ValidationError | NotFoundError | ForeignKeyError | OperationError
	>

	readonly deleteWithRelationships: (
		id: string,
		options?: DeleteWithRelationshipsOptions<T, TRelations>,
	) => RunnableEffect<
		DeleteWithRelationshipsResult<T>,
		NotFoundError | ValidationError | OperationError
	>

	readonly deleteManyWithRelationships: (
		predicate: (entity: T) => boolean,
		options?: DeleteWithRelationshipsOptions<T, TRelations> & {
			readonly limit?: number
		},
	) => RunnableEffect<
		{
			readonly count: number
			readonly deleted: ReadonlyArray<T>
			readonly cascaded?: Record<string, { readonly count: number; readonly ids: ReadonlyArray<string> }>
		},
		ValidationError | OperationError
	>
}
