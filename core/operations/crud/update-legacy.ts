/**
 * @deprecated Legacy update operations using Zod + Result pattern.
 * These are preserved for backward compatibility with the unmigrated database factory.
 * Will be removed when core/factories/database.ts is migrated to Effect (task 10).
 *
 * New code should use the Effect-based `update` and `updateMany` from ./update.ts
 */

import type { z } from "zod"
import type {
	MinimalEntity,
	UpdateWithOperators,
	UpdateManyResult,
} from "../../types/crud-types.js"
import type { LegacyCrudError as CrudError } from "../../errors/legacy.js"
import type { WhereClause } from "../../types/types.js"
import {
	createNotFoundError,
	createValidationError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/legacy.js"
import { validateForeignKeys } from "../../validators/foreign-key.js"
import { filterData } from "../query/filter.js"
import type { RelationshipDef } from "../../types/types.js"
import { applyUpdates, validateImmutableFields } from "./update.js"

// Helper to transform relationships to the format expected by filterData
function transformRelationships(
	relationships: Record<string, RelationshipDef<unknown>>,
): Record<string, { type: string; target: string; foreignKey?: string }> {
	const transformed: Record<
		string,
		{ type: string; target: string; foreignKey?: string }
	> = {}
	for (const [key, rel] of Object.entries(relationships)) {
		const entry: { type: string; target: string; foreignKey?: string } = {
			type: rel.type,
			target: rel.target || rel.__targetCollection || key,
		}
		if (rel.foreignKey !== undefined) {
			entry.foreignKey = rel.foreignKey
		}
		transformed[key] = entry
	}
	return transformed
}

// ============================================================================
// Update Single Entity (Legacy)
// ============================================================================

/** @deprecated Use Effect-based `update` from ./update.ts */
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
			const immutableValidation = validateImmutableFields(updates)
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
				)
			}

			const existingData = getData()
			const entityIndex = existingData.findIndex((item) => item.id === id)

			if (entityIndex === -1) {
				return err(createNotFoundError<T>(collectionName, id))
			}

			const entity = existingData[entityIndex]
			const updated = applyUpdates(entity, updates)

			// Validate with Zod schema
			const parseResult = schema.safeParse(updated)
			if (!parseResult.success) {
				const errors = parseResult.error.errors.map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: (updated as Record<string, unknown>)[e.path[0]],
				}))

				return err(createValidationError(errors))
			}

			// Validate foreign keys if any relationships were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			)
			const hasRelationshipUpdate = Object.keys(updates).some((key) =>
				relationshipFields.includes(key),
			)

			if (hasRelationshipUpdate) {
				const fkValidation = await validateForeignKeys(
					parseResult.data,
					relationships,
					allData,
				)
				if (!fkValidation.valid) {
					return err(createValidationError(fkValidation.errors))
				}
			}

			// Update the data
			const newData = [...existingData]
			newData[entityIndex] = parseResult.data
			setData(newData)

			return ok(parseResult.data)
		} catch (error) {
			return err(createUnknownError("Failed to update entity", error))
		}
	}
}

// ============================================================================
// Update Multiple Entities (Legacy)
// ============================================================================

/** @deprecated Use Effect-based `updateMany` from ./update.ts */
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
			schema: z.ZodType<unknown>
			relationships: Record<
				string,
				RelationshipDef<unknown, "ref" | "inverse", string>
			>
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
			const immutableValidation = validateImmutableFields(updates)
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
				)
			}

			const existingData = getData()

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
						schema: unknown
						relationships: Record<
							string,
							{ type: string; target: string; foreignKey?: string }
						>
					}
				>,
			) as unknown as T[]

			if (entitiesToUpdate.length === 0) {
				return ok({ count: 0, updated: [] })
			}

			// Apply updates to each entity
			const updatedEntities: T[] = []
			const validationErrors: Array<{ index: number; errors: unknown[] }> = []

			for (let i = 0; i < entitiesToUpdate.length; i++) {
				const entity = entitiesToUpdate[i]
				const updatedEntity = applyUpdates(entity, updates)

				// Validate with Zod
				const parseResult = schema.safeParse(updatedEntity)
				if (!parseResult.success) {
					validationErrors.push({
						index: i,
						errors: parseResult.error.errors,
					})
					continue
				}

				updatedEntities.push(parseResult.data)
			}

			// Return validation errors if any
			if (validationErrors.length > 0) {
				const firstError = validationErrors[0]
				const errors = (firstError.errors as z.ZodError["errors"]).map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: undefined,
				}))

				return err(createValidationError(errors))
			}

			// Validate foreign keys if relationships were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			)
			const hasRelationshipUpdate = Object.keys(updates).some((key) =>
				relationshipFields.includes(key),
			)

			if (hasRelationshipUpdate && updatedEntities.length > 0) {
				const fkValidationPromises = updatedEntities.map((entity) =>
					validateForeignKeys(entity, relationships, allData),
				)
				const fkValidationResults = await Promise.all(fkValidationPromises)

				const failedValidation = fkValidationResults.find(
					(result) => !result.valid,
				)
				if (failedValidation) {
					return err(createValidationError(failedValidation.errors))
				}
			}

			// Update the data
			const updatedIds = new Set(updatedEntities.map((e) => e.id))
			const newData = existingData.map((entity) => {
				if (updatedIds.has(entity.id)) {
					return updatedEntities.find((u) => u.id === entity.id)!
				}
				return entity
			})

			setData(newData)

			return ok({
				count: updatedEntities.length,
				updated: updatedEntities,
			})
		} catch (error) {
			return err(createUnknownError("Failed to update entities", error))
		}
	}
}
