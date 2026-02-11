/**
 * Foreign key validation system.
 *
 * Effect-based validators use Ref<ReadonlyMap> for O(1) lookups.
 */

import { Effect, Ref } from "effect"
import type {
	ForeignKeyValidation,
} from "../types/crud-types.js"
import { ForeignKeyError } from "../errors/crud-errors.js"
import type { RelationshipDef } from "../types/types.js"

// ============================================================================
// Shared Types
// ============================================================================

type HasId = { readonly id: string }

type RelationshipConfig = {
	readonly type: "ref" | "inverse"
	readonly target?: string
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

