/**
 * Delete operations with relationship support
 * Implements Phase 2 delete with relationships features
 */

import type { z } from "zod";
import type { MinimalEntity } from "../../types/crud-types.js";
import type { CrudError } from "../../errors/crud-errors.js";
import { isErr } from "../../errors/crud-errors.js";
import type { RelationshipDef } from "../../types/types.js";
import type {
	CascadeOption,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
	RestrictViolation,
} from "../../types/crud-relationship-types.js";
import {
	createNotFoundError,
	createValidationError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";

// ============================================================================
// Helper Types
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

type CascadeResult = {
	[collection: string]: {
		count: number;
		ids: string[];
	};
};

// ============================================================================
// Delete with Relationships
// ============================================================================

/**
 * Delete a single entity with relationship cascade support
 */
export function createDeleteWithRelationshipsMethod<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
>(
	collectionName: string,
	schema: z.ZodType<T>,
	relationships: TRelations,
	getData: () => T[],
	setData: (data: T[]) => void,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): (
	id: string,
	options?: DeleteWithRelationshipsOptions<T, TRelations>,
) => Promise<Result<DeleteWithRelationshipsResult<T>, CrudError<T>>> {
	return async (
		id: string,
		options?: DeleteWithRelationshipsOptions<T, TRelations>,
	): Promise<Result<DeleteWithRelationshipsResult<T>, CrudError<T>>> => {
		try {
			// Find entity to delete
			const existingData = getData();
			const entityIndex = existingData.findIndex((item) => item.id === id);

			if (entityIndex === -1) {
				return err(createNotFoundError("Entity", id));
			}

			const entity = existingData[entityIndex];

			// Check relationship constraints
			const cascadeResults: CascadeResult = {};
			const restrictViolations: RestrictViolation[] = [];

			// Process each relationship
			for (const [field, relationship] of Object.entries(relationships)) {
				const targetCollection =
					relationship.target || relationship.__targetCollection;
				if (!targetCollection) continue;

				const cascadeOption =
					options?.include?.[field as keyof TRelations] || "preserve";

				// Check for related entities
				const relatedEntities = await findRelatedEntities(
					id,
					field,
					relationship,
					targetCollection,
					collectionName,
					allData,
					config,
				);

				if (relatedEntities.length > 0) {
					switch (cascadeOption) {
						case "restrict":
							restrictViolations.push({
								collection: collectionName,
								relatedCollection: targetCollection,
								relatedCount: relatedEntities.length,
								message: `Cannot delete ${collectionName} with ID ${id} because it has ${relatedEntities.length} related ${targetCollection} entities`,
							});
							break;

						case "cascade":
							// Delete related entities
							const result = await cascadeDelete(
								relatedEntities,
								targetCollection,
								allData,
								config,
								options?.soft || false,
							);
							if (isErr(result)) return err(result.error as CrudError<T>);
							cascadeResults[targetCollection] = result.data;
							break;

						case "cascade_soft":
							// Soft delete related entities
							const softResult = await cascadeDelete(
								relatedEntities,
								targetCollection,
								allData,
								config,
								true,
							);
							if (isErr(softResult))
								return err(softResult.error as CrudError<T>);
							cascadeResults[targetCollection] = softResult.data;
							break;

						case "set_null":
							// Set foreign keys to null
							const nullResult = await setForeignKeysToNull(
								relatedEntities,
								field,
								relationship,
								targetCollection,
								collectionName,
								allData,
								config,
							);
							if (isErr(nullResult))
								return err(nullResult.error as CrudError<T>);
							break;

						case "preserve":
						default:
							// Do nothing
							break;
					}
				}
			}

			// Check for restrict violations
			if (restrictViolations.length > 0) {
				return err(
					createValidationError(
						restrictViolations.map((v) => ({
							field: "relationships",
							message: v.message,
							code: "RESTRICT_VIOLATION",
						})),
					),
				);
			}

			// Perform the delete
			let deletedEntity: T;

			if (options?.soft && hasSoftDelete(entity)) {
				// Soft delete
				const now = new Date().toISOString();
				const softDeleted = {
					...entity,
					deletedAt: now,
					updatedAt: now,
				};

				const newData = [...existingData];
				newData[entityIndex] = softDeleted as T;
				setData(newData);
				deletedEntity = softDeleted as T;
			} else {
				// Hard delete
				const newData = existingData.filter(
					(_, index) => index !== entityIndex,
				);
				setData(newData);
				deletedEntity = entity;
			}

			return ok({
				deleted: deletedEntity,
				...(Object.keys(cascadeResults).length > 0
					? { cascaded: cascadeResults }
					: {}),
			});
		} catch (error) {
			return err(
				createUnknownError("Failed to delete entity with relationships", error),
			);
		}
	};
}

/**
 * Delete many entities with relationship cascade support
 */
export function createDeleteManyWithRelationshipsMethod<
	T extends MinimalEntity,
	TRelations extends Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
>(
	collectionName: string,
	schema: z.ZodType<T>,
	relationships: TRelations,
	getData: () => T[],
	setData: (data: T[]) => void,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): (
	where: Partial<T>,
	options?: DeleteWithRelationshipsOptions<T, TRelations> & { limit?: number },
) => Promise<
	Result<
		{ count: number; deleted: T[]; cascaded?: CascadeResult },
		CrudError<T>
	>
> {
	return async (
		where: Partial<T>,
		options?: DeleteWithRelationshipsOptions<T, TRelations> & {
			limit?: number;
		},
	): Promise<
		Result<
			{ count: number; deleted: T[]; cascaded?: CascadeResult },
			CrudError<T>
		>
	> => {
		try {
			const existingData = getData();

			// Find entities to delete
			let entitiesToDelete = existingData.filter((item) => {
				return Object.entries(where).every(([key, value]) => {
					return (item as Record<string, unknown>)[key] === value;
				});
			});

			// Apply limit if specified
			if (options?.limit && options.limit > 0) {
				entitiesToDelete = entitiesToDelete.slice(0, options.limit);
			}

			if (entitiesToDelete.length === 0) {
				return ok({ count: 0, deleted: [] });
			}

			// Check all entities for restrict violations first
			const allRestrictViolations: RestrictViolation[] = [];
			const cascadeResults: CascadeResult = {};

			for (const entity of entitiesToDelete) {
				for (const [field, relationship] of Object.entries(relationships)) {
					const targetCollection =
						relationship.target || relationship.__targetCollection;
					if (!targetCollection) continue;

					const cascadeOption =
						options?.include?.[field as keyof TRelations] || "preserve";

					const relatedEntities = await findRelatedEntities(
						entity.id,
						field,
						relationship,
						targetCollection,
						collectionName,
						allData,
						config,
					);

					if (relatedEntities.length > 0 && cascadeOption === "restrict") {
						allRestrictViolations.push({
							collection: collectionName,
							relatedCollection: targetCollection,
							relatedCount: relatedEntities.length,
							message: `Cannot delete ${collectionName} with ID ${entity.id} because it has ${relatedEntities.length} related ${targetCollection} entities`,
						});
					}
				}
			}

			// Fail if any restrict violations
			if (allRestrictViolations.length > 0) {
				return err(
					createValidationError(
						allRestrictViolations.map((v) => ({
							field: "relationships",
							message: v.message,
							code: "RESTRICT_VIOLATION",
						})),
					),
				);
			}

			// Process cascade operations for all entities
			for (const entity of entitiesToDelete) {
				for (const [field, relationship] of Object.entries(relationships)) {
					const targetCollection =
						relationship.target || relationship.__targetCollection;
					if (!targetCollection) continue;

					const cascadeOption =
						options?.include?.[field as keyof TRelations] || "preserve";

					const relatedEntities = await findRelatedEntities(
						entity.id,
						field,
						relationship,
						targetCollection,
						collectionName,
						allData,
						config,
					);

					if (relatedEntities.length > 0) {
						switch (cascadeOption) {
							case "cascade":
							case "cascade_soft":
								const result = await cascadeDelete(
									relatedEntities,
									targetCollection,
									allData,
									config,
									cascadeOption === "cascade_soft" || options?.soft || false,
								);
								if (isErr(result)) return err(result.error as CrudError<T>);

								if (!cascadeResults[targetCollection]) {
									cascadeResults[targetCollection] = { count: 0, ids: [] };
								}
								cascadeResults[targetCollection].count += result.data.count;
								cascadeResults[targetCollection].ids.push(...result.data.ids);
								break;

							case "set_null":
								const nullResult = await setForeignKeysToNull(
									relatedEntities,
									field,
									relationship,
									targetCollection,
									collectionName,
									allData,
									config,
								);
								if (isErr(nullResult))
									return err(nullResult.error as CrudError<T>);
								break;
						}
					}
				}
			}

			// Perform the deletes
			const deletedEntities: T[] = [];
			const now = new Date().toISOString();

			if (options?.soft) {
				// Soft delete
				const updatedData = existingData.map((item) => {
					const shouldDelete = entitiesToDelete.some((e) => e.id === item.id);
					if (shouldDelete && hasSoftDelete(item)) {
						const softDeleted = {
							...item,
							deletedAt: now,
							updatedAt: now,
						};
						deletedEntities.push(softDeleted);
						return softDeleted;
					}
					return item;
				});
				setData(updatedData);
			} else {
				// Hard delete
				deletedEntities.push(...entitiesToDelete);
				const remainingData = existingData.filter(
					(item) => !entitiesToDelete.some((e) => e.id === item.id),
				);
				setData(remainingData);
			}

			return ok({
				count: deletedEntities.length,
				deleted: deletedEntities,
				...(Object.keys(cascadeResults).length > 0
					? { cascaded: cascadeResults }
					: {}),
			});
		} catch (error) {
			return err(
				createUnknownError(
					"Failed to delete entities with relationships",
					error,
				),
			);
		}
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find entities related to the one being deleted
 */
async function findRelatedEntities(
	entityId: string,
	field: string,
	relationship: RelationshipDef<unknown, "ref" | "inverse", string>,
	targetCollection: string,
	sourceCollection: string,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Array<{ id: string; [key: string]: unknown }>> {
	const targetData = allData[targetCollection];
	if (!Array.isArray(targetData)) return [];

	const targetConfig = config[targetCollection];
	if (!targetConfig) return [];

	// Find the foreign key that references back to the source collection
	let foreignKey: string | null = null;

	if (relationship.type === "inverse") {
		// For inverse relationships, find the ref relationship in the target that points back
		for (const [targetField, targetRel] of Object.entries(
			targetConfig.relationships,
		)) {
			if (
				(targetRel.target === sourceCollection ||
					targetRel.__targetCollection === sourceCollection) &&
				targetRel.type === "ref"
			) {
				foreignKey = targetRel.foreignKey || `${targetField}Id`;
				break;
			}
		}
	} else {
		// For ref relationships, we need to check if there's an inverse in the target
		foreignKey = relationship.foreignKey || `${field}Id`;
	}

	if (!foreignKey) return [];

	// Filter entities that reference the entity being deleted
	return targetData.filter(
		(item: unknown): item is { id: string; [key: string]: unknown } => {
			if (typeof item !== "object" || item === null || !("id" in item))
				return false;
			return (item as Record<string, unknown>)[foreignKey!] === entityId;
		},
	);
}

/**
 * Cascade delete related entities
 */
async function cascadeDelete(
	entities: Array<{ id: string; [key: string]: unknown }>,
	collection: string,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
	soft: boolean,
): Promise<Result<{ count: number; ids: string[] }, CrudError<unknown>>> {
	try {
		const targetData = allData[collection];
		if (!Array.isArray(targetData)) {
			return ok({ count: 0, ids: [] });
		}

		const deletedIds: string[] = [];
		const now = new Date().toISOString();

		if (soft) {
			// Soft delete
			const updatedData = targetData.map((item: unknown) => {
				if (
					typeof item === "object" &&
					item !== null &&
					"id" in item &&
					entities.some((e) => e.id === item.id)
				) {
					deletedIds.push(item.id as string);
					return {
						...item,
						deletedAt: now,
						updatedAt: now,
					};
				}
				return item;
			});
			allData[collection] = updatedData;
		} else {
			// Hard delete
			deletedIds.push(...entities.map((e) => e.id));
			const remainingData = targetData.filter((item: unknown) => {
				if (typeof item !== "object" || item === null || !("id" in item))
					return true;
				return !entities.some((e) => e.id === item.id);
			});
			allData[collection] = remainingData;
		}

		return ok({ count: deletedIds.length, ids: deletedIds });
	} catch (error) {
		return err(
			createUnknownError(
				`Failed to cascade delete in collection ${collection}`,
				error,
			),
		);
	}
}

/**
 * Set foreign keys to null for related entities
 */
async function setForeignKeysToNull(
	entities: Array<{ id: string; [key: string]: unknown }>,
	field: string,
	relationship: RelationshipDef<unknown, "ref" | "inverse", string>,
	targetCollection: string,
	sourceCollection: string,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Result<void, CrudError<unknown>>> {
	try {
		const targetData = allData[targetCollection];
		if (!Array.isArray(targetData)) return ok(undefined);

		const targetConfig = config[targetCollection];
		if (!targetConfig) return ok(undefined);

		// Find the foreign key to set to null
		let foreignKey: string | null = null;

		if (relationship.type === "inverse") {
			// For inverse relationships, find the ref relationship in the target
			for (const [targetField, targetRel] of Object.entries(
				targetConfig.relationships,
			)) {
				if (
					(targetRel.target === sourceCollection ||
						targetRel.__targetCollection === sourceCollection) &&
					targetRel.type === "ref"
				) {
					foreignKey = targetRel.foreignKey || `${targetField}Id`;
					break;
				}
			}
		}

		if (!foreignKey) return ok(undefined);

		const now = new Date().toISOString();
		const updatedData = targetData.map((item: unknown) => {
			if (
				typeof item === "object" &&
				item !== null &&
				"id" in item &&
				entities.some((e) => e.id === item.id)
			) {
				return {
					...item,
					[foreignKey!]: null,
					updatedAt: now,
				};
			}
			return item;
		});

		allData[targetCollection] = updatedData;
		return ok(undefined);
	} catch (error) {
		return err(
			createUnknownError(
				`Failed to set foreign keys to null in collection ${targetCollection}`,
				error,
			),
		);
	}
}

/**
 * Check if entity has soft delete capability
 */
function hasSoftDelete<T>(entity: T): entity is T & { deletedAt?: string } {
	return (
		typeof entity === "object" &&
		entity !== null &&
		("deletedAt" in entity || !("deletedAt" in entity))
	); // Allow soft delete if field can be added
}
