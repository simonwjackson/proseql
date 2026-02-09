/**
 * Update operation implementation with operators and validation
 */

import type { z } from "zod";
import type {
	MinimalEntity,
	UpdateWithOperators,
	UpdateManyResult,
} from "../../types/crud-types.js";
import type { LegacyCrudError as CrudError } from "../../errors/legacy.js";
import type { WhereClause } from "../../types/types.js";
import {
	createNotFoundError,
	createValidationError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/legacy.js";
import { validateForeignKeys } from "../../validators/foreign-key.js";
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
// Update Operators Implementation
// ============================================================================

/**
 * Apply update operators to a value
 */
function applyOperator<T>(
	currentValue: T,
	operator: Record<string, unknown>,
): T {
	// Number operators
	if (typeof currentValue === "number") {
		if ("$increment" in operator && typeof operator.$increment === "number") {
			return (currentValue + operator.$increment) as T;
		}
		if ("$decrement" in operator && typeof operator.$decrement === "number") {
			return (currentValue - operator.$decrement) as T;
		}
		if ("$multiply" in operator && typeof operator.$multiply === "number") {
			return (currentValue * operator.$multiply) as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// String operators
	if (typeof currentValue === "string") {
		if ("$append" in operator && typeof operator.$append === "string") {
			return (currentValue + operator.$append) as T;
		}
		if ("$prepend" in operator && typeof operator.$prepend === "string") {
			return (operator.$prepend + currentValue) as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Array operators
	if (Array.isArray(currentValue)) {
		if ("$append" in operator) {
			const toAppend = Array.isArray(operator.$append)
				? operator.$append
				: [operator.$append];
			return [...currentValue, ...toAppend] as T;
		}
		if ("$prepend" in operator) {
			const toPrepend = Array.isArray(operator.$prepend)
				? operator.$prepend
				: [operator.$prepend];
			return [...toPrepend, ...currentValue] as T;
		}
		if ("$remove" in operator) {
			if (typeof operator.$remove === "function") {
				return currentValue.filter(
					(item) => !(operator.$remove as (item: unknown) => boolean)(item),
				) as T;
			} else {
				return currentValue.filter((item) => item !== operator.$remove) as T;
			}
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Boolean operators
	if (typeof currentValue === "boolean") {
		if ("$toggle" in operator && operator.$toggle === true) {
			return !currentValue as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Default: just set the value
	if ("$set" in operator) {
		return operator.$set as T;
	}

	// If no operator matched, return current value
	return currentValue;
}

/**
 * Apply update operations to an entity
 */
export function applyUpdates<T extends MinimalEntity>(
	entity: T,
	updates: UpdateWithOperators<T>,
): T {
	const updated = { ...entity };
	const now = new Date().toISOString();

	for (const [key, value] of Object.entries(updates)) {
		if (key === "updatedAt" && !value) {
			// Auto-set updatedAt if not provided
			(updated as Record<string, unknown>).updatedAt = now;
		} else if (value !== undefined || value === null) {
			// Check if it's an operator
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				const hasOperator = Object.keys(value).some((k) => k.startsWith("$"));
				if (hasOperator) {
					// Apply operator
					const currentValue = (entity as Record<string, unknown>)[key];
					(updated as Record<string, unknown>)[key] = applyOperator(
						currentValue,
						value,
					);
				} else {
					// Direct assignment (for nested objects)
					(updated as Record<string, unknown>)[key] = value;
				}
			} else {
				// Direct assignment (including null values)
				(updated as Record<string, unknown>)[key] = value;
			}
		}
	}

	// Ensure updatedAt is set
	if (!("updatedAt" in updates)) {
		(updated as Record<string, unknown>).updatedAt = now;
	}

	return updated;
}

// ============================================================================
// Update Single Entity
// ============================================================================

/**
 * Update a single entity by ID
 */
export function createUpdateMethod<
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
	id: string,
	updates: UpdateWithOperators<T>,
) => Promise<Result<T, CrudError<T>>> {
	return async (
		id: string,
		updates: UpdateWithOperators<T>,
	): Promise<Result<T, CrudError<T>>> => {
		try {
			// Validate immutable fields
			const immutableValidation = validateImmutableFields(updates);
			if (!immutableValidation.valid) {
				return err(
					createValidationError([
						{
							field: immutableValidation.field!,
							message: `Cannot update immutable field: ${immutableValidation.field}`,
							value: (updates as Record<string, unknown>)[
								immutableValidation.field!
							],
						},
					]),
				);
			}

			const existingData = getData();
			const entityIndex = existingData.findIndex((item) => item.id === id);

			if (entityIndex === -1) {
				return err(createNotFoundError<T>(collectionName, id));
			}

			const entity = existingData[entityIndex];
			const updated = applyUpdates(entity, updates);

			// Validate with Zod schema
			const parseResult = schema.safeParse(updated);
			if (!parseResult.success) {
				const errors = parseResult.error.errors.map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: (updated as Record<string, unknown>)[e.path[0]],
				}));

				return err(createValidationError(errors));
			}

			// Validate foreign keys if any relationships were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			);
			const hasRelationshipUpdate = Object.keys(updates).some((key) =>
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

			// Update the data
			const newData = [...existingData];
			newData[entityIndex] = parseResult.data;
			setData(newData);

			return ok(parseResult.data);
		} catch (error) {
			return err(createUnknownError("Failed to update entity", error));
		}
	};
}

// ============================================================================
// Update Multiple Entities
// ============================================================================

/**
 * Update multiple entities matching a query
 */
export function createUpdateManyMethod<
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
	getData: () => T[],
	setData: (data: T[]) => void,
	allData: Record<string, unknown[]>,
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
): (
	where: WhereClause<T, TRelations, TDB>,
	updates: UpdateWithOperators<T>,
) => Promise<Result<UpdateManyResult<T>, CrudError<T>>> {
	return async (
		where: WhereClause<T, TRelations, TDB>,
		updates: UpdateWithOperators<T>,
	): Promise<Result<UpdateManyResult<T>, CrudError<T>>> => {
		try {
			// Validate immutable fields
			const immutableValidation = validateImmutableFields(updates);
			if (!immutableValidation.valid) {
				return err(
					createValidationError([
						{
							field: immutableValidation.field!,
							message: `Cannot update immutable field: ${immutableValidation.field}`,
							value: (updates as Record<string, unknown>)[
								immutableValidation.field!
							],
						},
					]),
				);
			}

			const existingData = getData();

			// Filter entities to update
			const entitiesToUpdate = filterData(
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

			if (entitiesToUpdate.length === 0) {
				return ok({ count: 0, updated: [] });
			}

			// Apply updates to each entity
			const updated: T[] = [];
			const validationErrors: Array<{ index: number; errors: unknown[] }> = [];

			for (let i = 0; i < entitiesToUpdate.length; i++) {
				const entity = entitiesToUpdate[i];
				const updatedEntity = applyUpdates(entity, updates);

				// Validate with Zod
				const parseResult = schema.safeParse(updatedEntity);
				if (!parseResult.success) {
					validationErrors.push({
						index: i,
						errors: parseResult.error.errors,
					});
					continue;
				}

				updated.push(parseResult.data);
			}

			// Return validation errors if any
			if (validationErrors.length > 0) {
				const firstError = validationErrors[0];
				const errors = (firstError.errors as z.ZodError["errors"]).map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: undefined,
				}));

				return err(createValidationError(errors));
			}

			// Validate foreign keys if relationships were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			);
			const hasRelationshipUpdate = Object.keys(updates).some((key) =>
				relationshipFields.includes(key),
			);

			if (hasRelationshipUpdate && updated.length > 0) {
				// Validate all updated entities
				const fkValidationPromises = updated.map((entity) =>
					validateForeignKeys(entity, relationships, allData),
				);
				const fkValidationResults = await Promise.all(fkValidationPromises);

				// Check for any validation failures
				const failedValidation = fkValidationResults.find(
					(result) => !result.valid,
				);
				if (failedValidation) {
					return err(createValidationError(failedValidation.errors));
				}
			}

			// Update the data
			const updatedIds = new Set(updated.map((e) => e.id));
			const newData = existingData.map((entity) => {
				if (updatedIds.has(entity.id)) {
					return updated.find((u) => u.id === entity.id)!;
				}
				return entity;
			});

			setData(newData);

			return ok({
				count: updated.length,
				updated,
			});
		} catch (error) {
			return err(createUnknownError("Failed to update entities", error));
		}
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that an update doesn't violate immutable fields
 */
export function validateImmutableFields<T extends MinimalEntity>(
	updates: UpdateWithOperators<T>,
): { valid: boolean; field?: string } {
	const immutableFields = ["id", "createdAt"] as const;

	for (const field of immutableFields) {
		if (field in updates) {
			return {
				valid: false,
				field,
			};
		}
	}

	return { valid: true };
}

/**
 * Extract fields that were actually changed
 */
export function getChangedFields<T extends MinimalEntity>(
	original: T,
	updated: T,
): string[] {
	const changed: string[] = [];

	for (const key of Object.keys(updated) as Array<keyof T>) {
		if (original[key] !== updated[key]) {
			changed.push(String(key));
		}
	}

	return changed;
}
