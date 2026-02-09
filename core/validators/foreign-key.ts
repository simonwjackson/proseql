/**
 * Foreign key validation system.
 *
 * Effect-based validators use Ref<ReadonlyMap> for O(1) lookups.
 * Legacy async validators are preserved for backward compatibility.
 */

import { Effect, Ref } from "effect"
import type {
	ValidationResult,
	ForeignKeyValidation,
} from "../types/crud-types.js"
import { createForeignKeyError } from "../errors/legacy.js"
import { ForeignKeyError } from "../errors/crud-errors.js"
import type { RelationshipDef } from "../types/types.js"

// ============================================================================
// Shared Types
// ============================================================================

type HasId = { readonly id: string }

type RelationshipConfig = {
	readonly type: "ref" | "inverse"
	readonly target: string
	readonly foreignKey?: string
}

// ============================================================================
// Foreign Key Config Extraction (pure, shared by legacy and Effect paths)
// ============================================================================

/**
 * Extract foreign key configurations from relationships
 */
export function extractForeignKeyConfigs(
	relationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
): ForeignKeyValidation[] {
	const configs: ForeignKeyValidation[] = []

	for (const [field, rel] of Object.entries(relationships)) {
		if (rel.type === "ref") {
			const targetCollection =
				rel.target ||
				(rel as RelationshipDef & { __targetCollection?: string })
					.__targetCollection ||
				field
			configs.push({
				field,
				foreignKey: rel.foreignKey || `${field}Id`,
				targetCollection,
				optional: false,
			})
		}
	}

	return configs
}

// ============================================================================
// Effect-based Foreign Key Validation
// ============================================================================

/**
 * Validate foreign keys for an entity using Ref-based state.
 * Returns Effect that fails with ForeignKeyError if a violation is found.
 *
 * Uses ReadonlyMap for O(1) lookups instead of legacy array scanning.
 */
export const validateForeignKeysEffect = <T extends HasId>(
	entity: T,
	collectionName: string,
	relationships: Record<string, RelationshipConfig>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<void, ForeignKeyError> => {
	const configs = extractForeignKeyConfigs(
		relationships as Record<string, { type: "ref" | "inverse"; foreignKey?: string; target?: string }>,
	)

	if (configs.length === 0) {
		return Effect.void
	}

	return Effect.forEach(configs, (config) => {
		const value = (entity as Record<string, unknown>)[config.foreignKey]
		if (value === undefined || value === null) {
			return Effect.void
		}

		const targetRef = stateRefs[config.targetCollection]
		if (targetRef === undefined) {
			return Effect.fail(
				new ForeignKeyError({
					collection: collectionName,
					field: config.foreignKey,
					value: String(value),
					targetCollection: config.targetCollection,
					message: `Foreign key constraint violated: '${config.foreignKey}' references non-existent collection '${config.targetCollection}'`,
				}),
			)
		}

		return Ref.get(targetRef).pipe(
			Effect.flatMap((targetMap) => {
				if (targetMap.has(String(value))) {
					return Effect.void
				}
				return Effect.fail(
					new ForeignKeyError({
						collection: collectionName,
						field: config.foreignKey,
						value: String(value),
						targetCollection: config.targetCollection,
						message: `Foreign key constraint violated: '${config.foreignKey}' references non-existent ${config.targetCollection} '${value}'`,
					}),
				)
			}),
		)
	}, { discard: true })
}

/**
 * Check if deleting an entity would violate foreign key constraints.
 * Scans all collections for "ref" relationships targeting this collection
 * whose foreign key field references the entity being deleted.
 *
 * Returns Effect that fails with ForeignKeyError if violations exist.
 */
export const checkDeleteConstraintsEffect = (
	entityId: string,
	collectionName: string,
	allRelationships: Record<string, Record<string, RelationshipConfig>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<void, ForeignKeyError> =>
	Effect.gen(function* () {
		for (const [otherCollection, relationships] of Object.entries(allRelationships)) {
			for (const [field, rel] of Object.entries(relationships)) {
				if (rel.type === "ref" && rel.target === collectionName) {
					const foreignKey = rel.foreignKey || `${field}Id`
					const otherRef = stateRefs[otherCollection]
					if (otherRef === undefined) continue

					const otherMap = yield* Ref.get(otherRef)
					let refCount = 0

					for (const entity of otherMap.values()) {
						if ((entity as Record<string, unknown>)[foreignKey] === entityId) {
							refCount++
						}
					}

					if (refCount > 0) {
						return yield* Effect.fail(
							new ForeignKeyError({
								collection: collectionName,
								field: foreignKey,
								value: entityId,
								targetCollection: otherCollection,
								message: `Cannot delete: ${refCount} ${otherCollection} entities reference this ${collectionName}`,
							}),
						)
					}
				}
			}
		}
	})

/**
 * Check referential integrity for an entire database using Ref-based state.
 * Returns Effect with a list of violations.
 */
export const checkReferentialIntegrityEffect = (
	allRelationships: Record<string, Record<string, RelationshipConfig>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<ReadonlyArray<{
	readonly collection: string
	readonly entityId: string
	readonly field: string
	readonly invalidReference: unknown
	readonly targetCollection: string
}>> =>
	Effect.gen(function* () {
		const violations: Array<{
			readonly collection: string
			readonly entityId: string
			readonly field: string
			readonly invalidReference: unknown
			readonly targetCollection: string
		}> = []

		for (const [collection, relationships] of Object.entries(allRelationships)) {
			const collectionRef = stateRefs[collection]
			if (collectionRef === undefined) continue

			const collectionMap = yield* Ref.get(collectionRef)
			const foreignKeyConfigs = extractForeignKeyConfigs(
				relationships as Record<string, { type: "ref" | "inverse"; foreignKey?: string; target?: string }>,
			)

			for (const [entityId, entity] of collectionMap.entries()) {
				for (const config of foreignKeyConfigs) {
					const value = (entity as Record<string, unknown>)[config.foreignKey]
					if (value === null || value === undefined) continue

					const targetRef = stateRefs[config.targetCollection]
					if (targetRef === undefined) {
						violations.push({
							collection,
							entityId,
							field: config.field,
							invalidReference: value,
							targetCollection: config.targetCollection,
						})
						continue
					}

					const targetMap = yield* Ref.get(targetRef)
					if (!targetMap.has(String(value))) {
						violations.push({
							collection,
							entityId,
							field: config.field,
							invalidReference: value,
							targetCollection: config.targetCollection,
						})
					}
				}
			}
		}

		return violations
	})

// ============================================================================
// Legacy Async Validators (used by *-legacy.ts files)
// ============================================================================

/**
 * @deprecated Use validateForeignKeysEffect instead
 */
async function validateSingleForeignKey(
	value: unknown,
	targetData: unknown[] | undefined,
	config: ForeignKeyValidation,
): Promise<{
	valid: boolean;
	error?: ReturnType<typeof createForeignKeyError>;
}> {
	if (value === undefined || value === null) {
		return { valid: true }
	}

	if (!Array.isArray(targetData)) {
		return {
			valid: false,
			error: createForeignKeyError(
				config.foreignKey,
				value,
				config.targetCollection,
				`${config.field}_fk`,
			),
		}
	}

	const exists = targetData.some((item) => {
		if (typeof item === "object" && item !== null && "id" in item) {
			return item.id === value
		}
		return false
	})

	if (!exists) {
		return {
			valid: false,
			error: createForeignKeyError(
				config.foreignKey,
				value,
				config.targetCollection,
				`${config.field}_fk`,
			),
		}
	}

	return { valid: true }
}

/**
 * @deprecated Use validateForeignKeysEffect instead
 */
export async function validateForeignKeys<T>(
	entity: T,
	relationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	allData: Record<string, unknown[]>,
): Promise<ValidationResult<T>> {
	const configs = extractForeignKeyConfigs(relationships)

	if (configs.length === 0) {
		return { valid: true, errors: [] }
	}

	const validationPromises = configs.map(async (config) => {
		const value = (entity as Record<string, unknown>)[config.foreignKey]
		const targetData = allData[config.targetCollection]
		return validateSingleForeignKey(value, targetData, config)
	})

	const results = await Promise.all(validationPromises)

	const errors = results
		.filter((result) => !result.valid && result.error)
		.map((result) => ({
			field: result.error!.field,
			message: result.error!.message,
			value: result.error!.value,
			code: "FOREIGN_KEY_VIOLATION",
		}))

	return {
		valid: errors.length === 0,
		errors,
	}
}

/**
 * @deprecated Use validateForeignKeysEffect with Effect.forEach instead
 */
export async function validateBatchForeignKeys<T>(
	entities: T[],
	relationships: Record<string, RelationshipDef>,
	allData: Record<string, unknown[]>,
): Promise<Map<number, ValidationResult<T>>> {
	const results = new Map<number, ValidationResult<T>>()

	const validationPromises = entities.map(async (entity, index) => {
		const result = await validateForeignKeys(entity, relationships, allData)
		return { index, result }
	})

	const validationResults = await Promise.all(validationPromises)

	for (const { index, result } of validationResults) {
		results.set(index, result)
	}

	return results
}

// ============================================================================
// Cascade Operations
// ============================================================================

export type CascadeAction = "restrict" | "cascade" | "setNull" | "setDefault"

export interface CascadeConfig {
	onDelete: CascadeAction
	onUpdate: CascadeAction
	defaultValue?: unknown
}

/**
 * Default cascade configuration
 */
export const defaultCascadeConfig: CascadeConfig = {
	onDelete: "restrict",
	onUpdate: "cascade",
}

/**
 * @deprecated Use checkDeleteConstraintsEffect instead
 */
export async function checkDeleteConstraints(
	entityId: string,
	collectionName: string,
	allData: Record<string, unknown[]>,
	allRelationships: Record<
		string,
		Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>
	>,
	cascadeConfig: CascadeConfig = defaultCascadeConfig,
): Promise<{
	canDelete: boolean
	violations: Array<{ collection: string; field: string; count: number }>
	cascadeActions: Array<{
		collection: string
		field: string
		action: CascadeAction
		ids: string[]
	}>
}> {
	const violations: Array<{
		collection: string
		field: string
		count: number
	}> = []
	const cascadeActions: Array<{
		collection: string
		field: string
		action: CascadeAction
		ids: string[]
	}> = []

	for (const [otherCollection, relationships] of Object.entries(
		allRelationships,
	)) {
		for (const [field, rel] of Object.entries(relationships)) {
			if (rel.type === "ref" && rel.target === collectionName) {
				const foreignKey = rel.foreignKey || `${field}Id`
				const collectionData = allData[otherCollection] || []

				const referencingIds: string[] = []
				for (const item of collectionData) {
					if (
						typeof item === "object" &&
						item !== null &&
						foreignKey in item &&
						(item as Record<string, unknown>)[foreignKey] === entityId
					) {
						const itemId = (item as Record<string, unknown>).id
						if (typeof itemId === "string") {
							referencingIds.push(itemId)
						}
					}
				}

				if (referencingIds.length > 0) {
					switch (cascadeConfig.onDelete) {
						case "restrict":
							violations.push({
								collection: otherCollection,
								field,
								count: referencingIds.length,
							})
							break
						case "cascade":
						case "setNull":
						case "setDefault":
							cascadeActions.push({
								collection: otherCollection,
								field,
								action: cascadeConfig.onDelete,
								ids: referencingIds,
							})
							break
					}
				}
			}
		}
	}

	return {
		canDelete: violations.length === 0,
		violations,
		cascadeActions,
	}
}

/**
 * @deprecated Use Ref.update with Effect instead
 */
export async function applyCascadeActions(
	cascadeActions: Array<{
		collection: string
		field: string
		action: CascadeAction
		ids: string[]
	}>,
	allData: Record<string, unknown[]>,
	cascadeConfig: CascadeConfig,
): Promise<void> {
	for (const { collection, field, action, ids } of cascadeActions) {
		const collectionData = allData[collection] || []
		const foreignKey = `${field}Id`

		switch (action) {
			case "cascade":
				allData[collection] = collectionData.filter((item) => {
					if (typeof item === "object" && item !== null && "id" in item) {
						return !ids.includes((item as { id: string }).id)
					}
					return true
				})
				break

			case "setNull":
				for (const item of collectionData) {
					if (
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						ids.includes((item as { id: string }).id)
					) {
						(item as Record<string, unknown>)[foreignKey] = null
					}
				}
				break

			case "setDefault":
				if (cascadeConfig.defaultValue !== undefined) {
					for (const item of collectionData) {
						if (
							typeof item === "object" &&
							item !== null &&
							"id" in item &&
							ids.includes((item as { id: string }).id)
						) {
							(item as Record<string, unknown>)[foreignKey] =
								cascadeConfig.defaultValue
						}
					}
				}
				break
		}
	}
}

// ============================================================================
// Legacy Referential Integrity Checks
// ============================================================================

/**
 * @deprecated Use checkReferentialIntegrityEffect instead
 */
export async function checkReferentialIntegrity(
	allData: Record<string, unknown[]>,
	allRelationships: Record<string, Record<string, RelationshipDef>>,
): Promise<{
	valid: boolean
	violations: Array<{
		collection: string
		entityId: string
		field: string
		invalidReference: unknown
		targetCollection: string
	}>
}> {
	const violations: Array<{
		collection: string
		entityId: string
		field: string
		invalidReference: unknown
		targetCollection: string
	}> = []

	for (const [collection, relationships] of Object.entries(allRelationships)) {
		const collectionData = allData[collection] || []
		const foreignKeyConfigs = extractForeignKeyConfigs(relationships)

		for (const entity of collectionData) {
			if (typeof entity !== "object" || entity === null || !("id" in entity)) {
				continue
			}

			const entityId = (entity as { id: string }).id

			for (const config of foreignKeyConfigs) {
				const value = (entity as Record<string, unknown>)[config.foreignKey]
				if (value === null || value === undefined) {
					continue
				}

				const targetData = allData[config.targetCollection]
				const validation = await validateSingleForeignKey(
					value,
					targetData,
					config,
				)

				if (!validation.valid) {
					violations.push({
						collection,
						entityId,
						field: config.field,
						invalidReference: value,
						targetCollection: config.targetCollection,
					})
				}
			}
		}
	}

	return {
		valid: violations.length === 0,
		violations,
	}
}

/**
 * @deprecated Use checkReferentialIntegrityEffect + Ref.update instead
 */
export async function repairReferentialIntegrity(
	allData: Record<string, unknown[]>,
	allRelationships: Record<string, Record<string, RelationshipDef>>,
	strategy: "remove" | "setNull" = "setNull",
): Promise<{
	repaired: number
	details: Array<{
		collection: string
		entityId: string
		field: string
		action: "removed" | "nullified"
	}>
}> {
	const { violations } = await checkReferentialIntegrity(
		allData,
		allRelationships,
	)
	const details: Array<{
		collection: string
		entityId: string
		field: string
		action: "removed" | "nullified"
	}> = []

	if (violations.length === 0) {
		return { repaired: 0, details }
	}

	const violationsByCollection = new Map<string, typeof violations>()
	for (const violation of violations) {
		const existing = violationsByCollection.get(violation.collection) || []
		existing.push(violation)
		violationsByCollection.set(violation.collection, existing)
	}

	for (const [collection, collectionViolations] of Array.from(
		violationsByCollection.entries(),
	)) {
		const collectionData = allData[collection] || []

		if (strategy === "remove") {
			const idsToRemove = new Set(collectionViolations.map((v) => v.entityId))
			allData[collection] = collectionData.filter((item) => {
				if (typeof item === "object" && item !== null && "id" in item) {
					const shouldRemove = idsToRemove.has((item as { id: string }).id)
					if (shouldRemove) {
						details.push({
							collection,
							entityId: (item as { id: string }).id,
							field: collectionViolations.find(
								(v) => v.entityId === (item as { id: string }).id,
							)!.field,
							action: "removed",
						})
					}
					return !shouldRemove
				}
				return true
			})
		} else {
			for (const violation of collectionViolations) {
				const entity = collectionData.find(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						(item as { id: string }).id === violation.entityId,
				)

				if (entity) {
					const foreignKey = `${violation.field}Id`
					;(entity as Record<string, unknown>)[foreignKey] = null
					details.push({
						collection,
						entityId: violation.entityId,
						field: violation.field,
						action: "nullified",
					})
				}
			}
		}
	}

	return {
		repaired: details.length,
		details,
	}
}
