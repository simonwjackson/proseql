/**
 * Foreign key validation system with parallel checking capabilities
 */

import type {
	ValidationResult,
	ForeignKeyValidation,
} from "../types/crud-types.js";
import { createForeignKeyError } from "../errors/crud-errors.js";
import type { RelationshipDef } from "../types/types.js";

// ============================================================================
// Foreign Key Validation
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
	const configs: ForeignKeyValidation[] = [];

	for (const [field, rel] of Object.entries(relationships)) {
		if (rel.type === "ref") {
			const targetCollection =
				rel.target ||
				(rel as RelationshipDef & { __targetCollection?: string })
					.__targetCollection ||
				field;
			configs.push({
				field,
				foreignKey: rel.foreignKey || `${field}Id`,
				targetCollection,
				optional: false, // Could be enhanced to check schema for optional fields
			});
		}
	}

	return configs;
}

/**
 * Validate a single foreign key reference
 */
async function validateSingleForeignKey(
	value: unknown,
	targetData: unknown[] | undefined,
	config: ForeignKeyValidation,
): Promise<{
	valid: boolean;
	error?: ReturnType<typeof createForeignKeyError>;
}> {
	// Skip validation if value is undefined or null
	// Null values are allowed for optional relationships
	if (value === undefined || value === null) {
		return { valid: true };
	}

	// Target collection must exist
	if (!Array.isArray(targetData)) {
		return {
			valid: false,
			error: createForeignKeyError(
				config.foreignKey,
				value,
				config.targetCollection,
				`${config.field}_fk`,
			),
		};
	}

	// Check if referenced entity exists
	const exists = targetData.some((item) => {
		if (typeof item === "object" && item !== null && "id" in item) {
			return item.id === value;
		}
		return false;
	});

	if (!exists) {
		return {
			valid: false,
			error: createForeignKeyError(
				config.foreignKey,
				value,
				config.targetCollection,
				`${config.field}_fk`,
			),
		};
	}

	return { valid: true };
}

/**
 * Validate all foreign keys for an entity in parallel
 */
export async function validateForeignKeys<T>(
	entity: T,
	relationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	allData: Record<string, unknown[]>,
): Promise<ValidationResult<T>> {
	const configs = extractForeignKeyConfigs(relationships);

	if (configs.length === 0) {
		return { valid: true, errors: [] };
	}

	// Validate all foreign keys in parallel
	const validationPromises = configs.map(async (config) => {
		const value = (entity as Record<string, unknown>)[config.foreignKey];
		const targetData = allData[config.targetCollection];
		return validateSingleForeignKey(value, targetData, config);
	});

	const results = await Promise.all(validationPromises);

	// Collect errors
	const errors = results
		.filter((result) => !result.valid && result.error)
		.map((result) => ({
			field: result.error!.field,
			message: result.error!.message,
			value: result.error!.value,
			code: "FOREIGN_KEY_VIOLATION",
		}));

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate foreign keys for multiple entities
 */
export async function validateBatchForeignKeys<T>(
	entities: T[],
	relationships: Record<string, RelationshipDef>,
	allData: Record<string, unknown[]>,
): Promise<Map<number, ValidationResult<T>>> {
	const results = new Map<number, ValidationResult<T>>();

	// Validate all entities in parallel
	const validationPromises = entities.map(async (entity, index) => {
		const result = await validateForeignKeys(entity, relationships, allData);
		return { index, result };
	});

	const validationResults = await Promise.all(validationPromises);

	// Map results by index
	for (const { index, result } of validationResults) {
		results.set(index, result);
	}

	return results;
}

// ============================================================================
// Cascade Operations
// ============================================================================

export type CascadeAction = "restrict" | "cascade" | "setNull" | "setDefault";

export interface CascadeConfig {
	onDelete: CascadeAction;
	onUpdate: CascadeAction;
	defaultValue?: unknown;
}

/**
 * Default cascade configuration
 */
export const defaultCascadeConfig: CascadeConfig = {
	onDelete: "restrict",
	onUpdate: "cascade",
};

/**
 * Check if a delete operation would violate foreign key constraints
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
	canDelete: boolean;
	violations: Array<{ collection: string; field: string; count: number }>;
	cascadeActions: Array<{
		collection: string;
		field: string;
		action: CascadeAction;
		ids: string[];
	}>;
}> {
	const violations: Array<{
		collection: string;
		field: string;
		count: number;
	}> = [];
	const cascadeActions: Array<{
		collection: string;
		field: string;
		action: CascadeAction;
		ids: string[];
	}> = [];

	// Check all collections for references to this entity
	for (const [otherCollection, relationships] of Object.entries(
		allRelationships,
	)) {
		for (const [field, rel] of Object.entries(relationships)) {
			if (rel.type === "ref" && rel.target === collectionName) {
				const foreignKey = rel.foreignKey || `${field}Id`;
				const collectionData = allData[otherCollection] || [];

				// Find all entities that reference the entity being deleted
				const referencingIds: string[] = [];
				for (const item of collectionData) {
					if (
						typeof item === "object" &&
						item !== null &&
						foreignKey in item &&
						(item as Record<string, unknown>)[foreignKey] === entityId
					) {
						const itemId = (item as Record<string, unknown>).id;
						if (typeof itemId === "string") {
							referencingIds.push(itemId);
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
							});
							break;
						case "cascade":
						case "setNull":
						case "setDefault":
							cascadeActions.push({
								collection: otherCollection,
								field,
								action: cascadeConfig.onDelete,
								ids: referencingIds,
							});
							break;
					}
				}
			}
		}
	}

	return {
		canDelete: violations.length === 0,
		violations,
		cascadeActions,
	};
}

/**
 * Apply cascade actions after a delete operation
 */
export async function applyCascadeActions(
	cascadeActions: Array<{
		collection: string;
		field: string;
		action: CascadeAction;
		ids: string[];
	}>,
	allData: Record<string, unknown[]>,
	cascadeConfig: CascadeConfig,
): Promise<void> {
	for (const { collection, field, action, ids } of cascadeActions) {
		const collectionData = allData[collection] || [];
		const foreignKey = `${field}Id`;

		switch (action) {
			case "cascade":
				// Remove all referencing entities
				allData[collection] = collectionData.filter((item) => {
					if (typeof item === "object" && item !== null && "id" in item) {
						return !ids.includes((item as { id: string }).id);
					}
					return true;
				});
				break;

			case "setNull":
				// Set foreign key to null
				for (const item of collectionData) {
					if (
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						ids.includes((item as { id: string }).id)
					) {
						(item as Record<string, unknown>)[foreignKey] = null;
					}
				}
				break;

			case "setDefault":
				// Set foreign key to default value
				if (cascadeConfig.defaultValue !== undefined) {
					for (const item of collectionData) {
						if (
							typeof item === "object" &&
							item !== null &&
							"id" in item &&
							ids.includes((item as { id: string }).id)
						) {
							(item as Record<string, unknown>)[foreignKey] =
								cascadeConfig.defaultValue;
						}
					}
				}
				break;
		}
	}
}

// ============================================================================
// Referential Integrity Checks
// ============================================================================

/**
 * Check referential integrity for an entire database
 */
export async function checkReferentialIntegrity(
	allData: Record<string, unknown[]>,
	allRelationships: Record<string, Record<string, RelationshipDef>>,
): Promise<{
	valid: boolean;
	violations: Array<{
		collection: string;
		entityId: string;
		field: string;
		invalidReference: unknown;
		targetCollection: string;
	}>;
}> {
	const violations: Array<{
		collection: string;
		entityId: string;
		field: string;
		invalidReference: unknown;
		targetCollection: string;
	}> = [];

	// Check each collection
	for (const [collection, relationships] of Object.entries(allRelationships)) {
		const collectionData = allData[collection] || [];
		const foreignKeyConfigs = extractForeignKeyConfigs(relationships);

		// Check each entity in the collection
		for (const entity of collectionData) {
			if (typeof entity !== "object" || entity === null || !("id" in entity)) {
				continue;
			}

			const entityId = (entity as { id: string }).id;

			// Check each foreign key
			for (const config of foreignKeyConfigs) {
				const value = (entity as Record<string, unknown>)[config.foreignKey];
				if (value === null || value === undefined) {
					continue; // Skip null/undefined values
				}

				const targetData = allData[config.targetCollection];
				const validation = await validateSingleForeignKey(
					value,
					targetData,
					config,
				);

				if (!validation.valid) {
					violations.push({
						collection,
						entityId,
						field: config.field,
						invalidReference: value,
						targetCollection: config.targetCollection,
					});
				}
			}
		}
	}

	return {
		valid: violations.length === 0,
		violations,
	};
}

/**
 * Repair referential integrity violations
 */
export async function repairReferentialIntegrity(
	allData: Record<string, unknown[]>,
	allRelationships: Record<string, Record<string, RelationshipDef>>,
	strategy: "remove" | "setNull" = "setNull",
): Promise<{
	repaired: number;
	details: Array<{
		collection: string;
		entityId: string;
		field: string;
		action: "removed" | "nullified";
	}>;
}> {
	const { violations } = await checkReferentialIntegrity(
		allData,
		allRelationships,
	);
	const details: Array<{
		collection: string;
		entityId: string;
		field: string;
		action: "removed" | "nullified";
	}> = [];

	if (violations.length === 0) {
		return { repaired: 0, details };
	}

	// Group violations by collection for efficient processing
	const violationsByCollection = new Map<string, typeof violations>();
	for (const violation of violations) {
		const existing = violationsByCollection.get(violation.collection) || [];
		existing.push(violation);
		violationsByCollection.set(violation.collection, existing);
	}

	// Process each collection
	for (const [collection, collectionViolations] of Array.from(
		violationsByCollection.entries(),
	)) {
		const collectionData = allData[collection] || [];

		if (strategy === "remove") {
			// Remove entities with violations
			const idsToRemove = new Set(collectionViolations.map((v) => v.entityId));
			allData[collection] = collectionData.filter((item) => {
				if (typeof item === "object" && item !== null && "id" in item) {
					const shouldRemove = idsToRemove.has((item as { id: string }).id);
					if (shouldRemove) {
						details.push({
							collection,
							entityId: (item as { id: string }).id,
							field: collectionViolations.find(
								(v) => v.entityId === (item as { id: string }).id,
							)!.field,
							action: "removed",
						});
					}
					return !shouldRemove;
				}
				return true;
			});
		} else {
			// Set invalid references to null
			for (const violation of collectionViolations) {
				const entity = collectionData.find(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						(item as { id: string }).id === violation.entityId,
				);

				if (entity) {
					const foreignKey = `${violation.field}Id`;
					(entity as Record<string, unknown>)[foreignKey] = null;
					details.push({
						collection,
						entityId: violation.entityId,
						field: violation.field,
						action: "nullified",
					});
				}
			}
		}
	}

	return {
		repaired: details.length,
		details,
	};
}
