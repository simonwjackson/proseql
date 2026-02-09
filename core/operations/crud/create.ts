/**
 * Create operation implementation with full type safety and validation
 */

import type { z } from "zod";
import type {
	MinimalEntity,
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
} from "../../types/crud-types.js";
import type { LegacyCrudError as CrudError } from "../../errors/crud-errors.js";
import {
	createDuplicateKeyError,
	createValidationError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";
import { generateId } from "../../utils/id-generator.js";
import { validateForeignKeys } from "../../validators/foreign-key.js";
import type { RelationshipDef } from "../../types/types.js";

// ============================================================================
// Create Single Entity
// ============================================================================

/**
 * Create a single entity with validation and foreign key checks
 */
export function createCreateMethod<
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
): (input: CreateInput<T>) => Promise<Result<T, CrudError<T>>> {
	return async (input: CreateInput<T>): Promise<Result<T, CrudError<T>>> => {
		try {
			// Generate ID if not provided
			const id = input.id || generateId();
			const now = new Date().toISOString();

			// Construct complete entity
			const entity = {
				...input,
				id,
				createdAt: now,
				updatedAt: now,
			} as unknown as T;

			// Validate with Zod schema
			const parseResult = schema.safeParse(entity);
			if (!parseResult.success) {
				const errors = parseResult.error.errors.map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: (entity as Record<string, unknown>)[e.path[0]],
					received: typeof (entity as Record<string, unknown>)[e.path[0]],
				}));

				return err(createValidationError(errors));
			}

			// Check for duplicate ID
			const existingData = getData();
			if (existingData.some((item) => item.id === id)) {
				return err(createDuplicateKeyError("id", id, id));
			}

			// Validate foreign keys
			const fkValidation = await validateForeignKeys(
				entity,
				relationships,
				allData,
			);
			if (!fkValidation.valid) {
				return err(createValidationError(fkValidation.errors));
			}

			// Add to collection
			setData([...existingData, parseResult.data]);

			return ok(parseResult.data);
		} catch (error) {
			return err(createUnknownError("Failed to create entity", error));
		}
	};
}

// ============================================================================
// Create Multiple Entities
// ============================================================================

/**
 * Create multiple entities with batch validation and optional duplicate skipping
 */
export function createCreateManyMethod<
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
): (
	inputs: CreateInput<T>[],
	options?: CreateManyOptions,
) => Promise<Result<CreateManyResult<T>, CrudError<T>>> {
	return async (
		inputs: CreateInput<T>[],
		options?: CreateManyOptions,
	): Promise<Result<CreateManyResult<T>, CrudError<T>>> => {
		try {
			const created: T[] = [];
			const skipped: Array<{ data: Partial<T>; reason: string }> = [];
			const existingData = getData();
			const now = new Date().toISOString();

			// Build a set of existing IDs for faster lookup
			const existingIds = new Set(existingData.map((item) => item.id));

			// Process each input
			const entitiesToValidate: T[] = [];
			const indexMap = new Map<number, number>(); // Maps entity index to input index

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const id = input.id || generateId();

				// Check for duplicate ID
				if (
					existingIds.has(id) ||
					entitiesToValidate.some((e) => e.id === id)
				) {
					if (options?.skipDuplicates) {
						skipped.push({
							data: { ...input, id } as Partial<T>,
							reason: `Duplicate ID: ${id}`,
						});
						continue;
					} else {
						return err(createDuplicateKeyError("id", id, id));
					}
				}

				// Construct entity
				const entity = {
					...input,
					id,
					createdAt: now,
					updatedAt: now,
				} as unknown as T;

				// Validate with Zod
				const parseResult = schema.safeParse(entity);
				if (!parseResult.success) {
					if (options?.skipDuplicates) {
						skipped.push({
							data: { ...input, id } as Partial<T>,
							reason: `Validation failed: ${parseResult.error.errors[0].message}`,
						});
						continue;
					} else {
						const errors = parseResult.error.errors.map((e) => ({
							field: e.path.join("."),
							message: e.message,
							value: (entity as Record<string, unknown>)[e.path[0]],
						}));
						return err(createValidationError(errors));
					}
				}

				indexMap.set(entitiesToValidate.length, i);
				entitiesToValidate.push(parseResult.data);
			}

			// Validate foreign keys if requested
			if (options?.validateRelationships !== false) {
				// Validate all entities in parallel
				const validationPromises = entitiesToValidate.map(
					async (entity, idx) => {
						const result = await validateForeignKeys(
							entity,
							relationships,
							allData,
						);
						return { entity, result, originalIndex: indexMap.get(idx)! };
					},
				);

				const validationResults = await Promise.all(validationPromises);

				// Process validation results
				const validEntities: T[] = [];
				for (const { entity, result, originalIndex } of validationResults) {
					if (!result.valid) {
						if (options?.skipDuplicates) {
							skipped.push({
								data: inputs[originalIndex] as Partial<T>,
								reason: `Foreign key violation: ${result.errors[0].message}`,
							});
						} else {
							return err(createValidationError(result.errors));
						}
					} else {
						validEntities.push(entity);
						created.push(entity);
					}
				}

				// Update data with all valid entities
				if (validEntities.length > 0) {
					setData([...existingData, ...validEntities]);
				}
			} else {
				// No FK validation, add all validated entities
				created.push(...entitiesToValidate);
				setData([...existingData, ...entitiesToValidate]);
			}

			return ok({
				created,
				...(skipped.length > 0 ? { skipped } : {}),
			});
		} catch (error) {
			return err(createUnknownError("Failed to create entities", error));
		}
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract unique constraint fields from schema
 * This is a placeholder - in a real implementation, this would analyze the Zod schema
 */
export function extractUniqueFields<T>(schema: z.ZodType<T>): string[] {
	// TODO: Implement schema analysis to extract unique fields
	// For now, return empty array (only ID is unique by default)
	return [];
}

/**
 * Check for unique constraint violations
 */
export function checkUniqueConstraints<T extends MinimalEntity>(
	entity: T,
	existingData: T[],
	uniqueFields: string[],
): { valid: boolean; field?: string; value?: unknown; existingId?: string } {
	for (const field of uniqueFields) {
		const value = (entity as Record<string, unknown>)[field];
		if (value === undefined || value === null) continue;

		const existing = existingData.find(
			(item) =>
				(item as Record<string, unknown>)[field] === value &&
				item.id !== entity.id,
		);

		if (existing) {
			return {
				valid: false,
				field,
				value,
				existingId: existing.id,
			};
		}
	}

	return { valid: true };
}
