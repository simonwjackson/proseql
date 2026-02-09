/**
 * Upsert operation implementation with unique constraint checking
 */

import type { z } from "zod";
import type {
	MinimalEntity,
	CreateInput,
	UpdateWithOperators,
	UpsertInput,
	UpsertResult,
	UpsertManyResult,
	ExtractUniqueFields,
} from "../../types/crud-types.js";
import type { LegacyCrudError as CrudError } from "../../errors/crud-errors.js";
import {
	createValidationError,
	createUnknownError,
	createOperationNotAllowedError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";
import { generateId } from "../../utils/id-generator.js";
import { validateForeignKeys } from "../../validators/foreign-key.js";
import { filterData } from "../query/filter.js";
import type { RelationshipDef } from "../../types/types.js";
import { applyUpdates } from "./update.js";

// Type guards for safe type checking
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Safe property access
function getProperty(obj: unknown, key: string): unknown {
	return isRecord(obj) ? obj[key] : undefined;
}

// ============================================================================
// Upsert Single Entity
// ============================================================================

/**
 * Find entity by unique fields
 */
function findByUniqueFields<T extends MinimalEntity>(
	data: T[],
	where: Partial<T>,
): T | undefined {
	return data.find((item) => {
		// Check all fields in where clause
		for (const [key, value] of Object.entries(where)) {
			if (getProperty(item, key) !== value) {
				return false;
			}
		}
		return true;
	});
}

/**
 * Upsert a single entity based on unique constraints
 */
export function createUpsertMethod<
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
): <UniqueFields extends keyof T = never>(
	input: UpsertInput<T, UniqueFields>,
) => Promise<Result<UpsertResult<T>, CrudError<T>>> {
	return async <UniqueFields extends keyof T = never>(
		input: UpsertInput<T, UniqueFields>,
	): Promise<Result<UpsertResult<T>, CrudError<T>>> => {
		try {
			const existingData = getData();

			// Find existing entity
			const existing = findByUniqueFields(
				existingData,
				input.where as Partial<T>,
			);

			if (existing) {
				// Update existing entity
				const updated = applyUpdates(existing, input.update);

				// Validate with schema
				const parseResult = schema.safeParse(updated);
				if (!parseResult.success) {
					const errors = parseResult.error.errors.map((e) => ({
						field: e.path.join("."),
						message: e.message,
						value:
							e.path.length > 0
								? getProperty(updated, e.path[0] as string)
								: undefined,
					}));

					return err(createValidationError(errors));
				}

				// Check foreign keys if relationships were updated
				const relationshipFields = Object.keys(relationships).map(
					(field) => relationships[field].foreignKey || `${field}Id`,
				);
				const hasRelationshipUpdate = Object.keys(input.update).some((key) =>
					relationshipFields.includes(key),
				);

				if (hasRelationshipUpdate) {
					const fkValidation = await validateForeignKeys(
						parseResult.data,
						relationships,
						allData,
					);
					if (!fkValidation.valid) {
						return err(createValidationError(fkValidation.errors));
					}
				}

				// Update in place
				const index = existingData.findIndex((item) => item.id === existing.id);
				const newData = [...existingData];
				newData[index] = parseResult.data;
				setData(newData);

				return ok({
					...parseResult.data,
					__action: "updated",
				});
			} else {
				// Create new entity
				const id =
					((input.where as Record<string, unknown>).id as string | undefined) ||
					generateId();
				const now = new Date().toISOString();

				// Merge where clause with create data
				const createData = {
					...input.where,
					...input.create,
					id,
					createdAt: now,
					updatedAt: now,
				} as unknown as T;

				// Validate with schema
				const parseResult = schema.safeParse(createData);
				if (!parseResult.success) {
					const errors = parseResult.error.errors.map((e) => ({
						field: e.path.join("."),
						message: e.message,
						value: (createData as Record<string, unknown>)[e.path[0]],
					}));

					return err(createValidationError(errors));
				}

				// Validate foreign keys
				const fkValidation = await validateForeignKeys(
					parseResult.data,
					relationships,
					allData,
				);
				if (!fkValidation.valid) {
					return err(createValidationError(fkValidation.errors));
				}

				// Add to collection
				setData([...existingData, parseResult.data]);

				return ok({
					...parseResult.data,
					__action: "created",
				});
			}
		} catch (error) {
			return err(createUnknownError("Failed to upsert entity", error));
		}
	};
}

// ============================================================================
// Upsert Multiple Entities
// ============================================================================

/**
 * Upsert multiple entities efficiently
 */
export function createUpsertManyMethod<
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
): <UniqueFields extends keyof T = never>(
	inputs: UpsertInput<T, UniqueFields>[],
) => Promise<Result<UpsertManyResult<T>, CrudError<T>>> {
	return async <UniqueFields extends keyof T = never>(
		inputs: UpsertInput<T, UniqueFields>[],
	): Promise<Result<UpsertManyResult<T>, CrudError<T>>> => {
		try {
			const existingData = getData();
			const created: T[] = [];
			const updated: T[] = [];
			const unchanged: T[] = [];
			const now = new Date().toISOString();

			// Process each input
			const processedEntities: T[] = [];
			const entitiesToValidate: Array<{
				entity: T;
				isNew: boolean;
				originalIndex: number;
			}> = [];

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const existing = findByUniqueFields(
					existingData,
					input.where as Partial<T>,
				);

				if (existing) {
					// Check if update would change anything
					const wouldChange = Object.keys(input.update).some((key) => {
						const updateValue = (input.update as Record<string, unknown>)[key];
						const currentValue = (existing as Record<string, unknown>)[key];

						// Handle operator-based updates
						if (
							typeof updateValue === "object" &&
							updateValue !== null &&
							!Array.isArray(updateValue)
						) {
							return true; // Operators always cause a change
						}

						return updateValue !== currentValue;
					});

					if (!wouldChange) {
						unchanged.push(existing);
						continue;
					}

					// Apply updates
					const updatedEntity = applyUpdates(existing, input.update);

					// Validate
					const parseResult = schema.safeParse(updatedEntity);
					if (!parseResult.success) {
						const errors = parseResult.error.errors.map((e) => ({
							field: e.path.join("."),
							message: e.message,
							value: (updatedEntity as Record<string, unknown>)[e.path[0]],
						}));

						return err(
							createValidationError(
								errors,
								`Validation failed for upsert at index ${i}`,
							),
						);
					}

					entitiesToValidate.push({
						entity: parseResult.data,
						isNew: false,
						originalIndex: i,
					});
				} else {
					// Create new entity
					const id =
						((input.where as Record<string, unknown>).id as
							| string
							| undefined) || generateId();

					const createData = {
						...input.where,
						...input.create,
						id,
						createdAt: now,
						updatedAt: now,
					} as unknown as T;

					// Validate
					const parseResult = schema.safeParse(createData);
					if (!parseResult.success) {
						const errors = parseResult.error.errors.map((e) => ({
							field: e.path.join("."),
							message: e.message,
							value: (createData as Record<string, unknown>)[e.path[0]],
						}));

						return err(
							createValidationError(
								errors,
								`Validation failed for upsert at index ${i}`,
							),
						);
					}

					entitiesToValidate.push({
						entity: parseResult.data,
						isNew: true,
						originalIndex: i,
					});
				}
			}

			// Validate foreign keys for all entities
			const fkValidationPromises = entitiesToValidate.map(
				async ({ entity, isNew, originalIndex }) => {
					const result = await validateForeignKeys(
						entity,
						relationships,
						allData,
					);
					return {
						entity,
						isNew,
						originalIndex,
						valid: result.valid,
						errors: result.errors,
					};
				},
			);

			const fkValidationResults = await Promise.all(fkValidationPromises);

			// Check for FK validation failures
			const fkFailure = fkValidationResults.find((result) => !result.valid);
			if (fkFailure) {
				return err(
					createValidationError(
						fkFailure.errors,
						`Foreign key validation failed for upsert at index ${fkFailure.originalIndex}`,
					),
				);
			}

			// Apply all changes
			const updatedIds = new Set<string>();
			const newEntities: T[] = [];

			for (const { entity, isNew } of fkValidationResults) {
				if (isNew) {
					created.push(entity);
					newEntities.push(entity);
				} else {
					updated.push(entity);
					updatedIds.add(entity.id);
				}
			}

			// Update data
			const newData = existingData.map((existing) => {
				if (updatedIds.has(existing.id)) {
					return updated.find((u) => u.id === existing.id)!;
				}
				return existing;
			});

			// Add new entities
			newData.push(...newEntities);
			setData(newData);

			return ok({
				created,
				updated,
				unchanged,
			});
		} catch (error) {
			return err(createUnknownError("Failed to upsert entities", error));
		}
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract unique fields from schema metadata
 * This is a placeholder - would need to be implemented based on how unique constraints are defined
 */
export function extractUniqueFieldsFromSchema<T>(
	schema: z.ZodType<T>,
): string[] {
	// TODO: Implement based on schema metadata
	// For now, return empty array (only ID is unique by default)
	return [];
}

/**
 * Validate that where clause uses unique fields
 */
export function validateUniqueWhere<T>(
	where: Partial<T>,
	uniqueFields: string[],
): boolean {
	// Must have ID or all fields of a unique constraint
	if ("id" in where) {
		return true;
	}

	// Check if where clause contains any unique field combination
	// This is simplified - real implementation would check complete unique constraints
	return Object.keys(where).some((key) => uniqueFields.includes(key));
}

/**
 * Create a compound key from unique fields
 */
export function createCompoundKey<T>(
	entity: Partial<T>,
	fields: string[],
): string {
	const values = fields.map((field) => {
		const value = (entity as Record<string, unknown>)[field];
		return value === undefined ? "undefined" : String(value);
	});

	return values.join("::");
}
