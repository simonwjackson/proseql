/**
 * Delete operation implementation with soft delete support
 */

import type {
	MinimalEntity,
	DeleteOptions,
	DeleteManyOptions,
	DeleteManyResult,
} from "../../types/crud-types.js";
import { hasSoftDelete } from "../../types/crud-types.js";
import type { CrudError } from "../../errors/crud-errors.js";
import type { WhereClause } from "../../types/types.js";
import {
	createNotFoundError,
	createOperationNotAllowedError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";
import {
	checkDeleteConstraints,
	CascadeAction,
} from "../../validators/foreign-key.js";
import { filterData } from "../query/filter.js";
import type { RelationshipDef } from "../../types/types.js";

// Helper to transform relationships to the format expected by filterData
function transformRelationships(
	relationships: Record<string, RelationshipDef<unknown>>,
): Record<string, { type: string; target: string; foreignKey?: string }> {
	const transformed: Record<
		string,
		{ type: string; target: string; foreignKey?: string }
	> = {};
	for (const [key, rel] of Object.entries(relationships)) {
		const entry: { type: string; target: string; foreignKey?: string } = {
			type: rel.type,
			target: rel.target || rel.__targetCollection || key,
		};
		if (rel.foreignKey !== undefined) {
			entry.foreignKey = rel.foreignKey;
		}
		transformed[key] = entry;
	}
	return transformed;
}

// ============================================================================
// Delete Single Entity
// ============================================================================

/**
 * Delete a single entity by ID with optional soft delete
 */
export function createDeleteMethod<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
>(
	collectionName: string,
	relationships: TRelations,
	getData: () => T[],
	setData: (data: T[]) => void,
	allData: Record<string, unknown[]>,
	allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	>,
): (
	id: string,
	options?: DeleteOptions<T>,
) => Promise<Result<T, CrudError<T>>> {
	return async (
		id: string,
		options?: DeleteOptions<T>,
	): Promise<Result<T, CrudError<T>>> => {
		try {
			const existingData = getData();
			const entityIndex = existingData.findIndex((item) => item.id === id);

			if (entityIndex === -1) {
				return err(createNotFoundError<T>(collectionName, id));
			}

			const entity = existingData[entityIndex];

			// Check if soft delete is requested but not supported
			if (
				"soft" in (options ?? {}) &&
				(options as { soft?: boolean })?.soft &&
				!hasSoftDelete(entity)
			) {
				return err(
					createOperationNotAllowedError(
						"soft delete",
						"Entity does not have a deletedAt field",
					),
				);
			}

			// Check foreign key constraints
			const constraints = await checkDeleteConstraints(
				id,
				collectionName,
				allData,
				allRelationships,
			);

			if (!constraints.canDelete) {
				const violation = constraints.violations[0];
				return err(
					createOperationNotAllowedError(
						"delete",
						`Cannot delete: ${violation.count} ${violation.collection} entities reference this ${collectionName}`,
					),
				);
			}

			let deletedEntity: T;

			if (
				"soft" in (options ?? {}) &&
				(options as { soft?: boolean })?.soft &&
				hasSoftDelete(entity)
			) {
				// Soft delete - just mark as deleted
				const now = new Date().toISOString();
				deletedEntity = {
					...entity,
					deletedAt: now,
					updatedAt: now,
				} as T;

				// Update the entity in place
				const newData = [...existingData];
				newData[entityIndex] = deletedEntity;
				setData(newData);
			} else {
				// Hard delete - remove from collection
				deletedEntity = entity;
				const newData = existingData.filter(
					(_, index) => index !== entityIndex,
				);
				setData(newData);
			}

			return ok(deletedEntity);
		} catch (error) {
			return err(createUnknownError("Failed to delete entity", error));
		}
	};
}

// ============================================================================
// Delete Multiple Entities
// ============================================================================

/**
 * Delete multiple entities matching a query
 */
export function createDeleteManyMethod<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	TDB,
>(
	collectionName: string,
	relationships: TRelations,
	getData: () => T[],
	setData: (data: T[]) => void,
	allData: Record<string, unknown[]>,
	allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	>,
	config: Record<
		string,
		{
			schema: unknown;
			relationships: Record<
				string,
				RelationshipDef<unknown, "ref" | "inverse", string>
			>;
		}
	>,
): (
	where: WhereClause<T, TRelations, TDB>,
	options?: DeleteManyOptions<T>,
) => Promise<Result<DeleteManyResult<T>, CrudError<T>>> {
	return async (
		where: WhereClause<T, TRelations, TDB>,
		options?: DeleteManyOptions<T>,
	): Promise<Result<DeleteManyResult<T>, CrudError<T>>> => {
		try {
			const existingData = getData();

			// Filter entities to delete
			let entitiesToDelete = filterData(
				existingData as unknown as Record<string, unknown>[],
				where,
				allData,
				transformRelationships(
					relationships as Record<string, RelationshipDef<unknown>>,
				),
				collectionName,
				config as Record<
					string,
					{
						schema: unknown;
						relationships: Record<
							string,
							{ type: string; target: string; foreignKey?: string }
						>;
					}
				>,
			) as unknown as T[];

			// Apply limit if specified
			if (options?.limit && options.limit > 0) {
				entitiesToDelete = entitiesToDelete.slice(0, options.limit);
			}

			if (entitiesToDelete.length === 0) {
				return ok({ count: 0, deleted: [] });
			}

			// Check if soft delete is requested but not supported
			if ("soft" in (options ?? {}) && (options as { soft?: boolean })?.soft) {
				const firstEntity = entitiesToDelete[0];
				if (!hasSoftDelete(firstEntity)) {
					return err(
						createOperationNotAllowedError(
							"soft delete",
							"Entities do not have a deletedAt field",
						),
					);
				}
			}

			// Check foreign key constraints for all entities
			const constraintChecks = await Promise.all(
				entitiesToDelete.map((entity) =>
					checkDeleteConstraints(
						entity.id,
						collectionName,
						allData,
						allRelationships,
					),
				),
			);

			// Find any constraint violations
			const violations = constraintChecks
				.map((check, index) => ({ check, entity: entitiesToDelete[index] }))
				.filter(({ check }) => !check.canDelete);

			if (violations.length > 0) {
				const firstViolation = violations[0];
				const violation = firstViolation.check.violations[0];
				return err(
					createOperationNotAllowedError(
						"batch delete",
						`Cannot delete ${violations.length} entities due to foreign key constraints. First violation: ${violation.count} ${violation.collection} entities reference ${collectionName} ${firstViolation.entity.id}`,
					),
				);
			}

			const deleted: T[] = [];
			const deletedIds = new Set<string>();
			const now = new Date().toISOString();

			if ("soft" in (options ?? {}) && (options as { soft?: boolean })?.soft) {
				// Soft delete - mark as deleted
				const newData = existingData.map((entity) => {
					const shouldDelete = entitiesToDelete.some((e) => e.id === entity.id);
					if (shouldDelete && hasSoftDelete(entity)) {
						const softDeleted = {
							...entity,
							deletedAt: now,
							updatedAt: now,
						} as T;
						deleted.push(softDeleted);
						deletedIds.add(entity.id);
						return softDeleted;
					}
					return entity;
				});

				setData(newData);
			} else {
				// Hard delete - remove from collection
				entitiesToDelete.forEach((entity) => {
					deleted.push(entity);
					deletedIds.add(entity.id);
				});

				const newData = existingData.filter(
					(entity) => !deletedIds.has(entity.id),
				);
				setData(newData);
			}

			return ok({
				count: deleted.length,
				deleted: options?.returnDeleted
					? deleted
					: deleted.map((e) => ({ ...e })),
			});
		} catch (error) {
			return err(createUnknownError("Failed to delete entities", error));
		}
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Filter out soft-deleted entities from results
 */
export function excludeSoftDeleted<T extends MinimalEntity>(
	entities: T[],
): T[] {
	return entities.filter((entity) => {
		if (hasSoftDelete(entity)) {
			return !entity.deletedAt;
		}
		return true;
	});
}

/**
 * Include only soft-deleted entities
 */
export function onlySoftDeleted<T extends MinimalEntity>(entities: T[]): T[] {
	return entities.filter((entity) => {
		if (hasSoftDelete(entity)) {
			return !!entity.deletedAt;
		}
		return false;
	});
}

/**
 * Restore soft-deleted entities
 */
export function restoreSoftDeleted<T extends MinimalEntity>(
	entities: T[],
	ids: string[],
): { restored: T[]; notFound: string[] } {
	const restored: T[] = [];
	const notFound: string[] = [];
	const idSet = new Set(ids);
	const now = new Date().toISOString();

	entities.forEach((entity) => {
		if (idSet.has(entity.id) && hasSoftDelete(entity) && entity.deletedAt) {
			const restoredEntity = {
				...entity,
				deletedAt: undefined,
				updatedAt: now,
			} as T;
			restored.push(restoredEntity);
			idSet.delete(entity.id);
		}
	});

	// IDs that weren't found
	notFound.push(...Array.from(idSet));

	return { restored, notFound };
}

/**
 * Permanently delete soft-deleted entities older than a certain date
 */
export function purgeSoftDeleted<T extends MinimalEntity>(
	entities: T[],
	olderThan: Date,
): { purged: number; remaining: T[] } {
	let purged = 0;
	const remaining = entities.filter((entity) => {
		if (hasSoftDelete(entity) && entity.deletedAt) {
			const deletedAt = new Date(entity.deletedAt);
			if (deletedAt < olderThan) {
				purged++;
				return false; // Remove from collection
			}
		}
		return true; // Keep in collection
	});

	return { purged, remaining };
}
