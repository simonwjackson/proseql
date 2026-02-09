/**
 * Create operations with relationship support
 * Implements Phase 2 create with relationships features
 */

import type { z } from "zod";
import type { MinimalEntity, CreateInput } from "../../types/crud-types.js";
import type { LegacyCrudError as CrudError } from "../../errors/crud-errors.js";
import { isErr } from "../../errors/crud-errors.js";
import type { RelationshipDef } from "../../types/types.js";
import type {
	CreateWithRelationshipsInput,
	ConnectInput,
	ConnectOrCreateInput,
	SingleRelationshipInput,
	ManyRelationshipInput,
} from "../../types/crud-relationship-types.js";
import { isRelationshipOperation } from "../../types/crud-relationship-types.js";
import {
	createValidationError,
	createForeignKeyError,
	createUnknownError,
	ok,
	err,
	type Result,
} from "../../errors/crud-errors.js";
import { generateId } from "../../utils/id-generator.js";
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

type ProcessedRelationships = {
	connect: Array<{ field: string; targetId: string; targetCollection: string }>;
	create: Array<{ field: string; data: unknown; targetCollection: string }>;
	connectOrCreate: Array<{
		field: string;
		where: ConnectInput<unknown>;
		create: CreateInput<unknown>;
		targetCollection: string;
	}>;
};

// ============================================================================
// Relationship Processing
// ============================================================================

/**
 * Process relationship operations from input
 */
async function processRelationshipOperations<T extends MinimalEntity>(
	input: CreateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	relationships: Record<
		string,
		RelationshipDef<unknown, "ref" | "inverse", string>
	>,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Result<ProcessedRelationships, CrudError<T>>> {
	const processed: ProcessedRelationships = {
		connect: [],
		create: [],
		connectOrCreate: [],
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
				const result = await processSingleRelationship(
					field,
					value as SingleRelationshipInput<unknown> | ConnectInput<unknown>,
					targetCollection,
					allData,
					config,
				);
				if (isErr(result)) return err(result.error as CrudError<T>);
				if (result.data) {
					mergeProcessedRelationships(processed, result.data);
				}
			} else {
				// Process many relationship
				const result = await processManyRelationship(
					field,
					value as ManyRelationshipInput<unknown>,
					targetCollection,
					allData,
					config,
				);
				if (isErr(result)) return err(result.error as CrudError<T>);
				if (result.data) {
					mergeProcessedRelationships(processed, result.data);
				}
			}
		} catch (error) {
			return err(
				createUnknownError(`Failed to process relationship ${field}`, error),
			);
		}
	}

	return ok(processed);
}

/**
 * Process single (ref) relationship operations
 */
async function processSingleRelationship(
	field: string,
	value: SingleRelationshipInput<unknown> | ConnectInput<unknown>,
	targetCollection: string,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Result<ProcessedRelationships, CrudError<unknown>>> {
	const processed: ProcessedRelationships = {
		connect: [],
		create: [],
		connectOrCreate: [],
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
		processed.connect.push({ field, targetId, targetCollection });
		return ok(processed);
	}

	const ops = value as SingleRelationshipInput<unknown>;

	// Process $connect
	if (ops.$connect) {
		const targetId = await resolveConnectInput(
			ops.$connect,
			targetCollection,
			allData,
		);
		if (!targetId) {
			return err(createForeignKeyError(field, "", targetCollection));
		}
		processed.connect.push({ field, targetId, targetCollection });
	}

	// Process $create
	if (ops.$create) {
		processed.create.push({ field, data: ops.$create, targetCollection });
	}

	// Process $connectOrCreate
	if (ops.$connectOrCreate) {
		processed.connectOrCreate.push({
			field,
			where: ops.$connectOrCreate.where,
			create: ops.$connectOrCreate.create,
			targetCollection,
		});
	}

	return ok(processed);
}

/**
 * Process many (inverse) relationship operations
 */
async function processManyRelationship(
	field: string,
	value: ManyRelationshipInput<unknown>,
	targetCollection: string,
	allData: Record<string, unknown[]>,
	config: DatabaseConfig,
): Promise<Result<ProcessedRelationships, CrudError<unknown>>> {
	const processed: ProcessedRelationships = {
		connect: [],
		create: [],
		connectOrCreate: [],
	};

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
			processed.connect.push({ field, targetId, targetCollection });
		}
	}

	// Process $create
	if (value.$create) {
		const creates = Array.isArray(value.$create)
			? value.$create
			: [value.$create];
		for (const create of creates) {
			processed.create.push({ field, data: create, targetCollection });
		}
	}

	// Process $createMany
	if (value.$createMany) {
		for (const create of value.$createMany) {
			processed.create.push({ field, data: create, targetCollection });
		}
	}

	// Process $connectOrCreate
	if (value.$connectOrCreate) {
		const items = Array.isArray(value.$connectOrCreate)
			? value.$connectOrCreate
			: [value.$connectOrCreate];
		for (const item of items) {
			processed.connectOrCreate.push({
				field,
				where: item.where,
				create: item.create,
				targetCollection,
			});
		}
	}

	return ok(processed);
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
 * Merge processed relationships
 */
function mergeProcessedRelationships(
	target: ProcessedRelationships,
	source: ProcessedRelationships,
): void {
	target.connect.push(...source.connect);
	target.create.push(...source.create);
	target.connectOrCreate.push(...source.connectOrCreate);
}

// ============================================================================
// Create with Relationships
// ============================================================================

/**
 * Create a single entity with relationship support
 */
export function createCreateWithRelationshipsMethod<
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
	input: CreateWithRelationshipsInput<T, TRelations>,
) => Promise<Result<T, CrudError<T>>> {
	return async (
		input: CreateWithRelationshipsInput<T, TRelations>,
	): Promise<Result<T, CrudError<T>>> => {
		try {
			// Process relationship operations
			const relationshipOps = await processRelationshipOperations(
				input,
				relationships,
				allData,
				config,
			);
			if (isErr(relationshipOps)) return err(relationshipOps.error);

			// Extract base entity data (without relationship operations)
			const baseInput: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(input)) {
				if (!(key in relationships)) {
					baseInput[key] = value;
				}
			}

			// Generate parent ID early so we can use it for inverse relationships
			const parentId = (baseInput.id as string) || generateId();

			// Handle nested creates first
			const nestedCreates: Array<{
				field: string;
				collection: string;
				data: unknown;
			}> = [];
			for (const create of relationshipOps.data.create) {
				nestedCreates.push({
					field: create.field,
					collection: create.targetCollection,
					data: create.data,
				});
			}

			// Create nested entities
			const createdIds: Record<string, { field: string; id: string }[]> = {};
			for (const nested of nestedCreates) {
				const targetConfig = config[nested.collection];
				if (!targetConfig) continue;

				const targetData = allData[nested.collection] || [];
				const id = generateId();
				const now = new Date().toISOString();

				// Handle foreign key based on relationship type
				const relationship = relationships[nested.field];
				let entityData = nested.data as Record<string, unknown>;
				if (typeof entityData !== "object" || entityData === null) {
					entityData = {};
				}
				entityData = { ...entityData };

				if (relationship && relationship.type === "inverse") {
					// For inverse relationships, set foreign key on the nested entity
					const targetConfig = config[nested.collection];
					if (targetConfig) {
						const inverseField = findInverseRelationship(
							collectionName,
							nested.field,
							targetConfig.relationships,
						);
						if (inverseField) {
							const inverseRel = targetConfig.relationships[inverseField];
							const foreignKey = inverseRel.foreignKey || `${inverseField}Id`;
							// Set the foreign key to the parent's ID
							entityData[foreignKey] = parentId;
						}
					}
				}

				const entity = {
					...entityData,
					id,
					createdAt: now,
					updatedAt: now,
				};

				// Validate nested entity
				const parseResult = targetConfig.schema.safeParse(entity);
				if (!parseResult.success) {
					return err(
						createValidationError([
							{
								field: `${nested.collection}`,
								message: parseResult.error.errors[0].message,
							},
						]),
					);
				}

				// Add to collection
				allData[nested.collection] = [...targetData, parseResult.data];

				if (!createdIds[nested.collection]) {
					createdIds[nested.collection] = [];
				}
				createdIds[nested.collection].push({ field: nested.field, id });

				// If this is a ref relationship, set the foreign key on parent
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${nested.field}Id`;
					baseInput[foreignKey] = id;
				}
			}

			// Handle connectOrCreate operations
			for (const op of relationshipOps.data.connectOrCreate) {
				const existingId = await resolveConnectInput(
					op.where,
					op.targetCollection,
					allData,
				);

				if (!existingId) {
					// Create new entity
					const targetConfig = config[op.targetCollection];
					if (!targetConfig) continue;

					const targetData = allData[op.targetCollection] || [];
					const id = generateId();
					const now = new Date().toISOString();

					const createData = op.create as Record<string, unknown>;
					const entity = {
						...createData,
						id,
						createdAt: now,
						updatedAt: now,
					};

					// Validate entity
					const parseResult = targetConfig.schema.safeParse(entity);
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

					// Add to collection
					allData[op.targetCollection] = [...targetData, parseResult.data];
					relationshipOps.data.connect.push({
						field: op.field,
						targetId: id,
						targetCollection: op.targetCollection,
					});
				} else {
					// Use existing entity
					relationshipOps.data.connect.push({
						field: op.field,
						targetId: existingId,
						targetCollection: op.targetCollection,
					});
				}
			}

			// Set foreign keys from connect operations
			for (const connect of relationshipOps.data.connect) {
				const relationship = relationships[connect.field];
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${connect.field}Id`;
					baseInput[foreignKey] = connect.targetId;
				}
			}

			// Use the parent ID we generated earlier
			const id = parentId;
			const now = new Date().toISOString();

			// Construct complete entity
			const entity = {
				...baseInput,
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
				}));
				return err(createValidationError(errors));
			}

			// Check for duplicate ID
			const existingData = getData();
			if (existingData.some((item) => item.id === id)) {
				return err(
					createValidationError([
						{
							field: "id",
							message: `Entity with ID ${id} already exists`,
							value: id,
						},
					]),
				);
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

			// Update inverse relationships
			for (const connect of relationshipOps.data.connect) {
				const relationship = relationships[connect.field];
				if (relationship && relationship.type === "inverse") {
					// Find the inverse relationship in the target collection
					const targetConfig = config[connect.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						connect.field,
						targetConfig.relationships,
					);

					if (inverseField) {
						// Update the target entity's foreign key
						const targetData = allData[connect.targetCollection] as unknown[];
						const updatedTargetData = targetData.map((item: unknown) => {
							if (
								typeof item === "object" &&
								item !== null &&
								"id" in item &&
								item.id === connect.targetId
							) {
								const foreignKey =
									targetConfig.relationships[inverseField].foreignKey ||
									`${inverseField}Id`;
								return {
									...item,
									[foreignKey]: id,
									updatedAt: now,
								};
							}
							return item;
						});
						allData[connect.targetCollection] = updatedTargetData;
					}
				}
			}

			return ok(parseResult.data);
		} catch (error) {
			return err(
				createUnknownError("Failed to create entity with relationships", error),
			);
		}
	};
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
			// This is a relationship back to the source collection
			return field;
		}
	}
	return null;
}
