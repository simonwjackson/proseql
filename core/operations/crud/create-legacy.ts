/**
 * @deprecated Legacy create operations using Zod + Result pattern.
 * These are preserved for backward compatibility with the unmigrated database factory.
 * Will be removed when core/factories/database.ts is migrated to Effect (task 10).
 *
 * New code should use the Effect-based `create` and `createMany` from ./create.ts
 */

import type { z } from "zod"
import type {
	MinimalEntity,
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
} from "../../types/crud-types.js"
import type { LegacyCrudError as CrudError } from "../../errors/legacy.js"
import {
	createDuplicateKeyError,
	createValidationError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/legacy.js"
import { generateId } from "../../utils/id-generator.js"
import { validateForeignKeys } from "../../validators/foreign-key.js"
import type { RelationshipDef } from "../../types/types.js"

/** @deprecated Use Effect-based `create` from ./create.ts */
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
			const id = input.id || generateId()
			const now = new Date().toISOString()

			const entity = {
				...input,
				id,
				createdAt: now,
				updatedAt: now,
			} as unknown as T

			const parseResult = schema.safeParse(entity)
			if (!parseResult.success) {
				const errors = parseResult.error.errors.map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: (entity as Record<string, unknown>)[e.path[0]],
					received: typeof (entity as Record<string, unknown>)[e.path[0]],
				}))
				return err(createValidationError(errors))
			}

			const existingData = getData()
			if (existingData.some((item) => item.id === id)) {
				return err(createDuplicateKeyError("id", id, id))
			}

			const fkValidation = await validateForeignKeys(
				entity,
				relationships,
				allData,
			)
			if (!fkValidation.valid) {
				return err(createValidationError(fkValidation.errors))
			}

			setData([...existingData, parseResult.data])
			return ok(parseResult.data)
		} catch (error) {
			return err(createUnknownError("Failed to create entity", error))
		}
	}
}

/** @deprecated Use Effect-based `createMany` from ./create.ts */
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
			const created: T[] = []
			const skipped: Array<{ data: Partial<T>; reason: string }> = []
			const existingData = getData()
			const now = new Date().toISOString()

			const existingIds = new Set(existingData.map((item) => item.id))
			const entitiesToValidate: T[] = []
			const indexMap = new Map<number, number>()

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i]
				const id = input.id || generateId()

				if (
					existingIds.has(id) ||
					entitiesToValidate.some((e) => e.id === id)
				) {
					if (options?.skipDuplicates) {
						skipped.push({
							data: { ...input, id } as Partial<T>,
							reason: `Duplicate ID: ${id}`,
						})
						continue
					} else {
						return err(createDuplicateKeyError("id", id, id))
					}
				}

				const entity = {
					...input,
					id,
					createdAt: now,
					updatedAt: now,
				} as unknown as T

				const parseResult = schema.safeParse(entity)
				if (!parseResult.success) {
					if (options?.skipDuplicates) {
						skipped.push({
							data: { ...input, id } as Partial<T>,
							reason: `Validation failed: ${parseResult.error.errors[0].message}`,
						})
						continue
					} else {
						const errors = parseResult.error.errors.map((e) => ({
							field: e.path.join("."),
							message: e.message,
							value: (entity as Record<string, unknown>)[e.path[0]],
						}))
						return err(createValidationError(errors))
					}
				}

				indexMap.set(entitiesToValidate.length, i)
				entitiesToValidate.push(parseResult.data)
			}

			if (options?.validateRelationships !== false) {
				const validationPromises = entitiesToValidate.map(
					async (entity, idx) => {
						const result = await validateForeignKeys(
							entity,
							relationships,
							allData,
						)
						return { entity, result, originalIndex: indexMap.get(idx)! }
					},
				)

				const validationResults = await Promise.all(validationPromises)

				const validEntities: T[] = []
				for (const { entity, result, originalIndex } of validationResults) {
					if (!result.valid) {
						if (options?.skipDuplicates) {
							skipped.push({
								data: inputs[originalIndex] as Partial<T>,
								reason: `Foreign key violation: ${result.errors[0].message}`,
							})
						} else {
							return err(createValidationError(result.errors))
						}
					} else {
						validEntities.push(entity)
						created.push(entity)
					}
				}

				if (validEntities.length > 0) {
					setData([...existingData, ...validEntities])
				}
			} else {
				created.push(...entitiesToValidate)
				setData([...existingData, ...entitiesToValidate])
			}

			return ok({
				created,
				...(skipped.length > 0 ? { skipped } : {}),
			})
		} catch (error) {
			return err(createUnknownError("Failed to create entities", error))
		}
	}
}
