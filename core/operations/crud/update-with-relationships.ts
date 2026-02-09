/**
 * Update operations with relationship support
 * Implements Phase 2 update with relationships features
 */

import type { z } from "zod";
import type { MinimalEntity, UpdateInput } from "../../types/crud-types.js";
import type { LegacyCrudError as CrudError } from "../../errors/crud-errors.js";
import { isErr } from "../../errors/crud-errors.js";
import type { RelationshipDef } from "../../types/types.js";
import type {
	UpdateWithRelationshipsInput,
	ConnectInput,
	SingleRelationshipInput,
	ManyRelationshipInput,
} from "../../types/crud-relationship-types.js";
import { isRelationshipOperation } from "../../types/crud-relationship-types.js";
import {
	createValidationError,
	createNotFoundError,
	createForeignKeyError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";
import { validateForeignKeys } from "../../validators/foreign-key.js";

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

type UpdateOperations = {
	disconnect: Array<{ field: string; targetCollection: string }>;
	connect: Array<{ field: string; targetId: string; targetCollection: string }>;
	update: Array<{
		field: string;
		data: UpdateInput<unknown>;
		targetCollection: string;
	}>;
	delete: Array<{ field: string; targetId?: string; targetCollection: string }>;
	set: Array<{ field: string; targetIds: string[]; targetCollection: string }>;
};

// ============================================================================
// Update with Relationships
// ============================================================================

/**
 * Update a single entity with relationship support
 */
export function createUpdateWithRelationshipsMethod<
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
	input: UpdateWithRelationshipsInput<T, TRelations>,
) => Promise<Result<T, CrudError<T>>> {
	return async (
		id: string,
		input: UpdateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>> => {
		try {
			// Find existing entity
			const existingData = getData();
			const existingIndex = existingData.findIndex((item) => item.id === id);

			if (existingIndex === -1) {
				return err(createNotFoundError("Entity", id));
			}

			const existing = existingData[existingIndex];
			const now = new Date().toISOString();

			// Process relationship operations
			const relationshipOps = await processRelationshipOperations(
				input,
				relationships,
				existing,
				allData,
				config,
			);
			if (isErr(relationshipOps))
				return err(relationshipOps.error as CrudError<T>);

			// Extract base entity updates (without relationship operations)
			const baseUpdate: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(input)) {
				if (!(key in relationships)) {
					baseUpdate[key] = value;
				}
			}

			// Apply relationship operations
			const updatedEntity = { ...existing };

			// Process disconnects (set foreign keys to null)
			for (const op of relationshipOps.data.disconnect) {
				const relationship = relationships[op.field];
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${op.field}Id`;
					(updatedEntity as Record<string, unknown>)[foreignKey] = null;
				} else if (relationship && relationship.type === "inverse") {
					// For inverse relationships, we need to update the foreign keys in the related entities
					const targetConfig = config[op.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						op.field,
						targetConfig.relationships,
					);

					if (inverseField) {
						const targetData = allData[op.targetCollection] as unknown[];
						const foreignKey =
							targetConfig.relationships[inverseField].foreignKey ||
							`${inverseField}Id`;

						// Disconnect specific entities or all entities
						const updatedTargetData = targetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								(item as Record<string, unknown>)[foreignKey] === id
							) {
								return {
									...item,
									[foreignKey]: null,
									updatedAt: now,
								};
							}
							return item;
						});

						allData[op.targetCollection] = updatedTargetData;
					}
				}
			}

			// Process connects (set foreign keys)
			for (const op of relationshipOps.data.connect) {
				const relationship = relationships[op.field];
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${op.field}Id`;
					(updatedEntity as Record<string, unknown>)[foreignKey] = op.targetId;
				} else if (relationship && relationship.type === "inverse") {
					// For inverse relationships, we need to update the foreign keys in the related entities
					const targetConfig = config[op.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						op.field,
						targetConfig.relationships,
					);

					if (inverseField) {
						const targetData = allData[op.targetCollection] as unknown[];
						const foreignKey =
							targetConfig.relationships[inverseField].foreignKey ||
							`${inverseField}Id`;

						// Connect the specific entity
						const updatedTargetData = targetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								"id" in item &&
								item.id === op.targetId
							) {
								return {
									...item,
									[foreignKey]: id,
									updatedAt: now,
								};
							}
							return item;
						});

						allData[op.targetCollection] = updatedTargetData;
					}
				}
			}

			// Process nested updates
			for (const op of relationshipOps.data.update) {
				// Update the related entity
				const targetData = allData[op.targetCollection] as unknown[];
				if (!Array.isArray(targetData)) continue;

				const targetIndex = targetData.findIndex(
					(item: unknown) =>
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						item.id ===
							(updatedEntity as Record<string, unknown>)[`${op.field}Id`],
				);

				if (targetIndex !== -1) {
					const targetEntity = targetData[targetIndex] as Record<
						string,
						unknown
					>;
					const updateData = op.data as Record<string, unknown>;
					const updatedTarget = {
						...targetEntity,
						...updateData,
						updatedAt: now,
					};

					// Validate updated target
					const targetConfig = config[op.targetCollection];
					if (targetConfig) {
						const parseResult = targetConfig.schema.safeParse(updatedTarget);
						if (!parseResult.success) {
							return err(
								createValidationError([
									{
										field: op.field,
										message: parseResult.error.errors[0].message,
									},
								]),
							);
						}
						targetData[targetIndex] = parseResult.data;
					}
				}
			}

			// Process delete operations (disconnect specific entities)
			for (const op of relationshipOps.data.delete) {
				const relationship = relationships[op.field];
				if (relationship && relationship.type === "inverse") {
					const targetConfig = config[op.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						op.field,
						targetConfig.relationships,
					);

					if (inverseField && op.targetId) {
						const targetData = allData[op.targetCollection] as unknown[];
						const foreignKey =
							targetConfig.relationships[inverseField].foreignKey ||
							`${inverseField}Id`;

						// Disconnect specific entity
						const updatedTargetData = targetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								"id" in item &&
								item.id === op.targetId &&
								(item as Record<string, unknown>)[foreignKey] === id
							) {
								return {
									...item,
									[foreignKey]: null,
									updatedAt: now,
								};
							}
							return item;
						});

						allData[op.targetCollection] = updatedTargetData;
					}
				}
			}

			// Process set operations (many-to-many replacement)
			for (const op of relationshipOps.data.set) {
				const relationship = relationships[op.field];
				if (relationship && relationship.type === "inverse") {
					// Update all related entities
					const targetConfig = config[op.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						op.field,
						targetConfig.relationships,
					);

					if (inverseField) {
						const targetData = allData[op.targetCollection] as unknown[];
						const foreignKey =
							targetConfig.relationships[inverseField].foreignKey ||
							`${inverseField}Id`;

						// Remove current relationships
						const updatedTargetData = targetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								(item as Record<string, unknown>)[foreignKey] === id
							) {
								return {
									...item,
									[foreignKey]: null,
									updatedAt: now,
								};
							}
							return item;
						});

						// Set new relationships
						const finalTargetData = updatedTargetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								"id" in item &&
								op.targetIds.includes(item.id as string)
							) {
								return {
									...item,
									[foreignKey]: id,
									updatedAt: now,
								};
							}
							return item;
						});

						allData[op.targetCollection] = finalTargetData;
					}
				}
			}

			// Merge base updates
			Object.assign(updatedEntity, baseUpdate);
			(updatedEntity as Record<string, unknown>).updatedAt = now;

			// Validate updated entity
			const parseResult = schema.safeParse(updatedEntity);
			if (!parseResult.success) {
				const errors = parseResult.error.errors.map((e) => ({
					field: e.path.join("."),
					message: e.message,
					value: (updatedEntity as Record<string, unknown>)[e.path[0]],
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

			// Update collection
			const newData = [...existingData];
			newData[existingIndex] = parseResult.data;
			setData(newData);

			return ok(parseResult.data);
		} catch (error) {
			return err(
				createUnknownError("Failed to update entity with relationships", error),
			);
		}
	};
}

// ============================================================================
// Relationship Processing
// ============================================================================

/**
 * Process relationship operations from update input
 */
async function processRelationshipOperations<T extends MinimalEntity>(
	input: UpdateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	relationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	existing: T,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Result<UpdateOperations, CrudError<T>>> {
	const operations: UpdateOperations = {
		disconnect: [],
		connect: [],
		update: [],
		delete: [],
		set: [],
	};

	for (const [field, value] of Object.entries(input)) {
		const relationship = relationships[field];
		if (!relationship || !value) continue;

		const targetCollection =
			relationship.target || relationship.__targetCollection;
		if (!targetCollection) continue;

		try {
			if (relationship.type === "ref") {
				// Process single relationship
				const result = await processSingleRelationshipUpdate(
					field,
					value as SingleRelationshipInput<unknown> | ConnectInput<unknown>,
					targetCollection,
					allData,
				);
				if (isErr(result)) return err(result.error as CrudError<T>);
				if (result.data) {
					mergeUpdateOperations(operations, result.data);
				}
			} else {
				// Process many relationship
				const result = await processManyRelationshipUpdate(
					field,
					value as ManyRelationshipInput<unknown>,
					targetCollection,
					existing,
					allData,
				);
				if (isErr(result)) return err(result.error as CrudError<T>);
				if (result.data) {
					mergeUpdateOperations(operations, result.data);
				}
			}
		} catch (error) {
			return err(
				createUnknownError(`Failed to process relationship ${field}`, error),
			);
		}
	}

	return ok(operations);
}

/**
 * Process single (ref) relationship update operations
 */
async function processSingleRelationshipUpdate(
	field: string,
	value: SingleRelationshipInput<unknown> | ConnectInput<unknown>,
	targetCollection: string,
	allData: Record<string, unknown[]>,
): Promise<Result<UpdateOperations, CrudError<unknown>>> {
	const operations: UpdateOperations = {
		disconnect: [],
		connect: [],
		update: [],
		delete: [],
		set: [],
	};

	// Check if it's a direct connect (shorthand syntax)
	if (!isRelationshipOperation(value)) {
		const targetId = await resolveConnectInput(
			value as ConnectInput<unknown>,
			targetCollection,
			allData,
		);
		if (!targetId) {
			return err(createForeignKeyError(field, "", targetCollection));
		}
		operations.connect.push({ field, targetId, targetCollection });
		return ok(operations);
	}

	const ops = value as SingleRelationshipInput<unknown>;

	// Process operations
	if (ops.$disconnect) {
		operations.disconnect.push({ field, targetCollection });
	}

	if (ops.$connect) {
		const targetId = await resolveConnectInput(
			ops.$connect,
			targetCollection,
			allData,
		);
		if (!targetId) {
			return err(createForeignKeyError(field, "", targetCollection));
		}
		operations.connect.push({ field, targetId, targetCollection });
	}

	if (ops.$update) {
		operations.update.push({ field, data: ops.$update, targetCollection });
	}

	if (ops.$delete) {
		operations.delete.push({ field, targetCollection });
	}

	return ok(operations);
}

/**
 * Process many (inverse) relationship update operations
 */
async function processManyRelationshipUpdate(
	field: string,
	value: ManyRelationshipInput<unknown>,
	targetCollection: string,
	existing: MinimalEntity,
	allData: Record<string, unknown[]>,
): Promise<Result<UpdateOperations, CrudError<unknown>>> {
	const operations: UpdateOperations = {
		disconnect: [],
		connect: [],
		update: [],
		delete: [],
		set: [],
	};

	// Process $set (replace all)
	if (value.$set) {
		const targetIds: string[] = [];
		for (const connect of value.$set) {
			const targetId = await resolveConnectInput(
				connect,
				targetCollection,
				allData,
			);
			if (!targetId) {
				return err(createForeignKeyError(field, "", targetCollection));
			}
			targetIds.push(targetId);
		}
		operations.set.push({ field, targetIds, targetCollection });
		return ok(operations); // $set replaces all other operations
	}

	// Process $disconnect
	if (value.$disconnect) {
		if (value.$disconnect === true) {
			// Disconnect all
			operations.disconnect.push({ field, targetCollection });
		} else {
			const disconnects = Array.isArray(value.$disconnect)
				? value.$disconnect
				: [value.$disconnect];
			for (const disconnect of disconnects) {
				const targetId = await resolveConnectInput(
					disconnect,
					targetCollection,
					allData,
				);
				if (targetId) {
					operations.delete.push({ field, targetId, targetCollection });
				}
			}
		}
	}

	// Process $connect
	if (value.$connect) {
		const connects = Array.isArray(value.$connect)
			? value.$connect
			: [value.$connect];
		for (const connect of connects) {
			const targetId = await resolveConnectInput(
				connect,
				targetCollection,
				allData,
			);
			if (!targetId) {
				return err(createForeignKeyError(field, "", targetCollection));
			}
			operations.connect.push({ field, targetId, targetCollection });
		}
	}

	// Process $update
	if (value.$update) {
		const updates = Array.isArray(value.$update)
			? value.$update
			: [value.$update];
		for (const update of updates) {
			const targetId = await resolveConnectInput(
				update.where,
				targetCollection,
				allData,
			);
			if (targetId) {
				operations.update.push({
					field,
					data: update.data,
					targetCollection,
				});
			}
		}
	}

	// Process $delete
	if (value.$delete) {
		const deletes = Array.isArray(value.$delete)
			? value.$delete
			: [value.$delete];
		for (const del of deletes) {
			const targetId = await resolveConnectInput(
				del,
				targetCollection,
				allData,
			);
			if (targetId) {
				operations.delete.push({ field, targetId, targetCollection });
			}
		}
	}

	return ok(operations);
}

/**
 * Resolve connect input to target ID
 */
async function resolveConnectInput(
	input: ConnectInput<unknown>,
	targetCollection: string,
	allData: Record<string, unknown[]>,
): Promise<string | null> {
	const targetData = allData[targetCollection];
	if (!Array.isArray(targetData)) return null;

	// If input has id, use it directly
	if ("id" in input && typeof input.id === "string") {
		const exists = targetData.some(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				"id" in item &&
				item.id === input.id,
		);
		return exists ? input.id : null;
	}

	// Otherwise, find by unique fields
	const found = targetData.find((item: unknown) => {
		if (typeof item !== "object" || item === null) return false;

		return Object.entries(input).every(([key, value]) => {
			return (item as Record<string, unknown>)[key] === value;
		});
	});

	return found &&
		typeof found === "object" &&
		found !== null &&
		"id" in found &&
		typeof found.id === "string"
		? found.id
		: null;
}

/**
 * Merge update operations
 */
function mergeUpdateOperations(
	target: UpdateOperations,
	source: UpdateOperations,
): void {
	target.disconnect.push(...source.disconnect);
	target.connect.push(...source.connect);
	target.update.push(...source.update);
	target.delete.push(...source.delete);
	target.set.push(...source.set);
}

/**
 * Find inverse relationship field
 */
function findInverseRelationship(
	sourceCollection: string,
	sourceField: string,
	targetRelationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
): string | null {
	for (const [field, rel] of Object.entries(targetRelationships)) {
		if (
			rel.target === sourceCollection ||
			rel.__targetCollection === sourceCollection
		) {
			return field;
		}
	}
	return null;
}
