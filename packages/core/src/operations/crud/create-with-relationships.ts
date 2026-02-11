/**
 * Effect-based create operations with relationship support.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors. Supports $connect, $create, and $connectOrCreate operations
 * for both ref (single) and inverse (many) relationship types.
 */

import { Effect, Ref, type Schema } from "effect";
import {
	ForeignKeyError,
	type OperationError,
	ValidationError,
} from "../../errors/crud-errors.js";
import type { ComputedFieldsConfig } from "../../types/computed-types.js";
import type {
	ConnectInput,
	CreateWithRelationshipsInput,
	ManyRelationshipInput,
	SingleRelationshipInput,
} from "../../types/crud-relationship-types.js";
import { isRelationshipOperation } from "../../types/crud-relationship-types.js";
import type { CreateInput } from "../../types/crud-types.js";
import type { RelationshipDef } from "../../types/types.js";
import { generateId } from "../../utils/id-generator.js";
import { validateForeignKeysEffect } from "../../validators/foreign-key.js";
import { validateEntity } from "../../validators/schema-validator.js";

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string };

type RelationshipConfig = {
	readonly type: "ref" | "inverse";
	readonly target?: string;
	readonly __targetCollection?: string;
	readonly foreignKey?: string;
};

type CollectionConfig = {
	readonly schema: Schema.Schema<HasId, unknown>;
	readonly relationships: Record<string, RelationshipConfig>;
};

type DatabaseConfig = Record<string, CollectionConfig>;

type ProcessedRelationships = {
	readonly connect: ReadonlyArray<{
		readonly field: string;
		readonly targetId: string;
		readonly targetCollection: string;
	}>;
	readonly create: ReadonlyArray<{
		readonly field: string;
		readonly data: unknown;
		readonly targetCollection: string;
	}>;
	readonly connectOrCreate: ReadonlyArray<{
		readonly field: string;
		readonly where: ConnectInput<unknown>;
		readonly create: CreateInput<unknown>;
		readonly targetCollection: string;
	}>;
};

// ============================================================================
// Helpers
// ============================================================================

const getTargetCollection = (rel: RelationshipConfig): string | undefined =>
	rel.target || rel.__targetCollection;

/**
 * Resolve a connect input to a target entity's ID by looking up the Ref state.
 */
const resolveConnectInput = (
	input: ConnectInput<unknown>,
	targetCollection: string,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<string, ForeignKeyError> =>
	Effect.gen(function* () {
		const targetRef = stateRefs[targetCollection];
		if (targetRef === undefined) {
			return yield* Effect.fail(
				new ForeignKeyError({
					collection: targetCollection,
					field: "",
					value: "",
					targetCollection,
					message: `Target collection '${targetCollection}' not found`,
				}),
			);
		}

		const targetMap = yield* Ref.get(targetRef);

		// If input has id, use it directly
		if (
			"id" in input &&
			typeof (input as Record<string, unknown>).id === "string"
		) {
			const id = (input as { readonly id: string }).id;
			if (targetMap.has(id)) {
				return id;
			}
			return yield* Effect.fail(
				new ForeignKeyError({
					collection: targetCollection,
					field: "id",
					value: id,
					targetCollection,
					message: `Entity with ID '${id}' not found in '${targetCollection}'`,
				}),
			);
		}

		// Otherwise, find by matching fields
		const inputEntries = Object.entries(input as Record<string, unknown>);
		for (const [id, entity] of targetMap) {
			const entityRecord = entity as Record<string, unknown>;
			const matches = inputEntries.every(
				([key, value]) => entityRecord[key] === value,
			);
			if (matches) {
				return id;
			}
		}

		return yield* Effect.fail(
			new ForeignKeyError({
				collection: targetCollection,
				field: "",
				value: JSON.stringify(input),
				targetCollection,
				message: `No matching entity found in '${targetCollection}'`,
			}),
		);
	});

/**
 * Find the inverse relationship field name in the target collection
 * that points back to the source collection.
 */
const findInverseRelationship = (
	sourceCollection: string,
	targetRelationships: Record<string, RelationshipConfig>,
): string | null => {
	for (const [field, rel] of Object.entries(targetRelationships)) {
		const target = getTargetCollection(rel);
		if (target === sourceCollection) {
			return field;
		}
	}
	return null;
};

// ============================================================================
// Relationship Processing
// ============================================================================

/**
 * Process a single (ref) relationship input into connect/create/connectOrCreate ops.
 */
const processSingleRelationship = (
	field: string,
	value: SingleRelationshipInput<unknown> | ConnectInput<unknown>,
	targetCollection: string,
): ProcessedRelationships => {
	const connect: Array<{
		field: string;
		targetId: string;
		targetCollection: string;
	}> = [];
	const create: Array<{
		field: string;
		data: unknown;
		targetCollection: string;
	}> = [];
	const connectOrCreate: Array<{
		field: string;
		where: ConnectInput<unknown>;
		create: CreateInput<unknown>;
		targetCollection: string;
	}> = [];

	// Direct connect (shorthand syntax — not a relationship operation object)
	if (!isRelationshipOperation(value)) {
		connect.push({ field, targetId: "__pending__", targetCollection });
		return { connect, create, connectOrCreate };
	}

	const ops = value as SingleRelationshipInput<unknown>;

	if (ops.$connect) {
		connect.push({ field, targetId: "__pending__", targetCollection });
	}
	if (ops.$create) {
		create.push({ field, data: ops.$create, targetCollection });
	}
	if (ops.$connectOrCreate) {
		connectOrCreate.push({
			field,
			where: ops.$connectOrCreate.where,
			create: ops.$connectOrCreate.create,
			targetCollection,
		});
	}

	return { connect, create, connectOrCreate };
};

/**
 * Process a many (inverse) relationship input into connect/create/connectOrCreate ops.
 */
const processManyRelationship = (
	field: string,
	value: ManyRelationshipInput<unknown>,
	targetCollection: string,
): ProcessedRelationships => {
	const connect: Array<{
		field: string;
		targetId: string;
		targetCollection: string;
	}> = [];
	const create: Array<{
		field: string;
		data: unknown;
		targetCollection: string;
	}> = [];
	const connectOrCreate: Array<{
		field: string;
		where: ConnectInput<unknown>;
		create: CreateInput<unknown>;
		targetCollection: string;
	}> = [];

	if (value.$connect) {
		const connects = Array.isArray(value.$connect)
			? value.$connect
			: [value.$connect];
		for (const _ of connects) {
			connect.push({ field, targetId: "__pending__", targetCollection });
		}
	}

	if (value.$create) {
		const creates = Array.isArray(value.$create)
			? value.$create
			: [value.$create];
		for (const c of creates) {
			create.push({ field, data: c, targetCollection });
		}
	}

	if (value.$createMany) {
		for (const c of value.$createMany) {
			create.push({ field, data: c, targetCollection });
		}
	}

	if (value.$connectOrCreate) {
		const items = Array.isArray(value.$connectOrCreate)
			? value.$connectOrCreate
			: [value.$connectOrCreate];
		for (const item of items) {
			connectOrCreate.push({
				field,
				where: item.where,
				create: item.create,
				targetCollection,
			});
		}
	}

	return { connect, create, connectOrCreate };
};

/**
 * Extract the original connect inputs from the raw input for later resolution.
 */
const extractConnectInputs = (
	input: Record<string, unknown>,
	relationships: Record<string, RelationshipConfig>,
): Record<string, ReadonlyArray<ConnectInput<unknown>>> => {
	const result: Record<string, Array<ConnectInput<unknown>>> = {};

	for (const [field, value] of Object.entries(input)) {
		const rel = relationships[field];
		if (!rel || value === undefined || value === null) continue;

		if (rel.type === "ref") {
			if (!isRelationshipOperation(value)) {
				result[field] = [value as ConnectInput<unknown>];
			} else {
				const ops = value as SingleRelationshipInput<unknown>;
				if (ops.$connect) {
					result[field] = [ops.$connect];
				}
			}
		} else {
			const ops = value as ManyRelationshipInput<unknown>;
			if (ops.$connect) {
				const connects = Array.isArray(ops.$connect)
					? ops.$connect
					: [ops.$connect];
				result[field] = connects;
			}
		}
	}

	return result;
};

/**
 * Process all relationship operations from the input.
 */
const processRelationshipOperations = (
	input: Record<string, unknown>,
	relationships: Record<string, RelationshipConfig>,
): ProcessedRelationships => {
	const allConnect: Array<{
		field: string;
		targetId: string;
		targetCollection: string;
	}> = [];
	const allCreate: Array<{
		field: string;
		data: unknown;
		targetCollection: string;
	}> = [];
	const allConnectOrCreate: Array<{
		field: string;
		where: ConnectInput<unknown>;
		create: CreateInput<unknown>;
		targetCollection: string;
	}> = [];

	for (const [field, value] of Object.entries(input)) {
		const rel = relationships[field];
		if (!rel || value === undefined || value === null) continue;

		const targetCollection = getTargetCollection(rel);
		if (!targetCollection) continue;

		let processed: ProcessedRelationships;

		if (rel.type === "ref") {
			processed = processSingleRelationship(
				field,
				value as SingleRelationshipInput<unknown> | ConnectInput<unknown>,
				targetCollection,
			);
		} else {
			processed = processManyRelationship(
				field,
				value as ManyRelationshipInput<unknown>,
				targetCollection,
			);
		}

		allConnect.push(...processed.connect);
		allCreate.push(...processed.create);
		allConnectOrCreate.push(...processed.connectOrCreate);
	}

	return {
		connect: allConnect,
		create: allCreate,
		connectOrCreate: allConnectOrCreate,
	};
};

// ============================================================================
// Computed Field Stripping
// ============================================================================

/**
 * Strip computed field keys from an input object.
 * Used to remove computed field names from create input before schema validation.
 *
 * @param input - The input object (possibly with computed field keys)
 * @param computed - The computed fields configuration that defines which keys to strip
 * @returns A new object with computed field keys removed
 */
const stripComputedFromInput = <T>(
	input: T,
	computed: ComputedFieldsConfig<unknown> | undefined,
): T => {
	if (computed === undefined || Object.keys(computed).length === 0) {
		return input;
	}

	const computedKeys = new Set(Object.keys(computed));
	const result: Record<string, unknown> = {};

	for (const key of Object.keys(input as Record<string, unknown>)) {
		if (!computedKeys.has(key)) {
			result[key] = (input as Record<string, unknown>)[key];
		}
	}

	return result as T;
};

// ============================================================================
// Create with Relationships
// ============================================================================

/**
 * Create a single entity with relationship support.
 *
 * Steps:
 * 1. Strip computed field keys from input (they are derived, not stored)
 * 2. Parse relationship operations from input
 * 3. Generate parent ID early for use in inverse relationships
 * 4. Process $create: create nested entities in target collections
 * 5. Process $connectOrCreate: find or create target entities
 * 6. Process $connect: resolve target entity IDs
 * 7. Set foreign keys from resolved relationships
 * 8. Validate and create the parent entity
 * 9. Update inverse relationship foreign keys on connected entities
 */
export const createWithRelationships =
	<T extends HasId, I = T>(
		collectionName: string,
		schema: Schema.Schema<T, I>,
		relationships: Record<string, RelationshipConfig>,
		ref: Ref.Ref<ReadonlyMap<string, T>>,
		stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
		dbConfig: DatabaseConfig,
		computed?: ComputedFieldsConfig<unknown>,
	) =>
	(
		input: CreateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
	): Effect.Effect<T, ValidationError | ForeignKeyError | OperationError> =>
		Effect.gen(function* () {
			// 1. Strip computed field keys from input (they are derived, not stored)
			const sanitizedInput = stripComputedFromInput(input, computed);

			// 2. Process relationship operations
			const relationshipOps = processRelationshipOperations(
				sanitizedInput as Record<string, unknown>,
				relationships,
			);

			// Extract connect inputs for later resolution
			const connectInputMap = extractConnectInputs(
				sanitizedInput as Record<string, unknown>,
				relationships,
			);
			// Make a mutable copy for tracking which have been consumed
			const pendingConnects: Record<string, Array<ConnectInput<unknown>>> = {};
			for (const [k, v] of Object.entries(connectInputMap)) {
				pendingConnects[k] = [...v];
			}

			// 3. Extract base entity data (non-relationship fields)
			const baseInput: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(
				sanitizedInput as Record<string, unknown>,
			)) {
				if (!(key in relationships)) {
					baseInput[key] = value;
				}
			}

			// Generate parent ID early
			const parentId = (baseInput.id as string | undefined) || generateId();
			const now = new Date().toISOString();

			// 4. Process $create: create nested entities
			for (const nestedCreate of relationshipOps.create) {
				const targetConfig = dbConfig[nestedCreate.targetCollection];
				if (!targetConfig) continue;

				const targetRef = stateRefs[nestedCreate.targetCollection];
				if (!targetRef) continue;

				const id = generateId();
				const relationship = relationships[nestedCreate.field];

				let entityData = nestedCreate.data as Record<string, unknown>;
				if (typeof entityData !== "object" || entityData === null) {
					entityData = {};
				}
				entityData = { ...entityData };

				// For inverse relationships, set the foreign key on the nested entity
				if (relationship && relationship.type === "inverse") {
					const targetRels = targetConfig.relationships;
					const inverseField = findInverseRelationship(
						collectionName,
						targetRels,
					);
					if (inverseField) {
						const inverseRel = targetRels[inverseField];
						if (inverseRel) {
							const foreignKey = inverseRel.foreignKey || `${inverseField}Id`;
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
				const validated = yield* validateEntity(
					targetConfig.schema,
					entity,
				).pipe(
					Effect.mapError(
						(ve) =>
							new ValidationError({
								message: `Nested create in '${nestedCreate.targetCollection}' failed: ${ve.message}`,
								issues: ve.issues,
							}),
					),
				);

				// Add to target collection Ref
				yield* Ref.update(targetRef, (map) => {
					const next = new Map(map);
					next.set(id, validated);
					return next;
				});

				// For ref relationships, set the foreign key on the parent
				if (relationship && relationship.type === "ref") {
					const foreignKey =
						relationship.foreignKey || `${nestedCreate.field}Id`;
					baseInput[foreignKey] = id;
				}
			}

			// 5. Process $connectOrCreate operations
			for (const op of relationshipOps.connectOrCreate) {
				const targetRef = stateRefs[op.targetCollection];
				if (!targetRef) continue;

				const targetConfig = dbConfig[op.targetCollection];

				// Try to resolve existing entity
				const existingResult = yield* resolveConnectInput(
					op.where,
					op.targetCollection,
					stateRefs,
				).pipe(
					Effect.map((id) => ({ found: true as const, id })),
					Effect.catchTag("ForeignKeyError", () =>
						Effect.succeed({ found: false as const, id: "" }),
					),
				);

				let resolvedId: string;

				if (existingResult.found) {
					resolvedId = existingResult.id;
				} else {
					// Create new entity
					if (!targetConfig) continue;

					const id = generateId();
					const createData = { ...(op.create as Record<string, unknown>) };

					// For inverse relationships, set the foreign key on the created entity
					const relForCOC = relationships[op.field];
					if (relForCOC && relForCOC.type === "inverse") {
						const targetRels = targetConfig.relationships;
						const inverseField = findInverseRelationship(
							collectionName,
							targetRels,
						);
						if (inverseField) {
							const inverseRel = targetRels[inverseField];
							if (inverseRel) {
								const foreignKey = inverseRel.foreignKey || `${inverseField}Id`;
								createData[foreignKey] = parentId;
							}
						}
					}

					const entity = {
						...createData,
						id,
						createdAt: now,
						updatedAt: now,
					};

					const validated = yield* validateEntity(
						targetConfig.schema,
						entity,
					).pipe(
						Effect.mapError(
							(ve) =>
								new ValidationError({
									message: `ConnectOrCreate in '${op.targetCollection}' failed: ${ve.message}`,
									issues: ve.issues,
								}),
						),
					);

					yield* Ref.update(targetRef, (map) => {
						const next = new Map(map);
						next.set(id, validated);
						return next;
					});

					resolvedId = id;
				}

				// Set the foreign key on the parent for ref relationships
				const relationship = relationships[op.field];
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${op.field}Id`;
					baseInput[foreignKey] = resolvedId;
				}
			}

			// 6. Process $connect operations — resolve target IDs
			const resolvedConnects: Array<{
				field: string;
				targetId: string;
				targetCollection: string;
			}> = [];

			// Deduplicate connect ops by field — each field's pending inputs are consumed once
			const seenFields = new Set<string>();
			for (const conn of relationshipOps.connect) {
				if (seenFields.has(conn.field)) continue;
				seenFields.add(conn.field);

				const fieldInputs = pendingConnects[conn.field];
				if (!fieldInputs || fieldInputs.length === 0) continue;

				for (const connectInput of fieldInputs) {
					const targetId = yield* resolveConnectInput(
						connectInput,
						conn.targetCollection,
						stateRefs,
					);
					resolvedConnects.push({
						field: conn.field,
						targetId,
						targetCollection: conn.targetCollection,
					});
				}
			}

			// 7. Set foreign keys from connect operations (ref relationships)
			for (const connect of resolvedConnects) {
				const relationship = relationships[connect.field];
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${connect.field}Id`;
					baseInput[foreignKey] = connect.targetId;
				}
			}

			// 8. Construct, validate, and create the parent entity
			const rawEntity = {
				...baseInput,
				id: parentId,
				createdAt: now,
				updatedAt: now,
			};

			const validated = yield* validateEntity(schema, rawEntity);

			// Check for duplicate ID
			const currentMap = yield* Ref.get(ref);
			if (currentMap.has(parentId)) {
				return yield* Effect.fail(
					new ValidationError({
						message: `Entity with ID '${parentId}' already exists in '${collectionName}'`,
						issues: [
							{
								field: "id",
								message: `Entity with ID ${parentId} already exists`,
								value: parentId,
							},
						],
					}),
				);
			}

			// Validate foreign keys
			yield* validateForeignKeysEffect(
				validated,
				collectionName,
				relationships,
				stateRefs,
			);

			// Add to collection
			yield* Ref.update(ref, (map) => {
				const next = new Map(map);
				next.set(parentId, validated);
				return next;
			});

			// 9. Update inverse relationship foreign keys on connected entities
			for (const connect of resolvedConnects) {
				const relationship = relationships[connect.field];
				if (relationship && relationship.type === "inverse") {
					const targetConfig = dbConfig[connect.targetCollection];
					if (!targetConfig) continue;

					const inverseField = findInverseRelationship(
						collectionName,
						targetConfig.relationships,
					);

					if (inverseField) {
						const inverseRel = targetConfig.relationships[inverseField];
						if (!inverseRel) continue;
						const foreignKey = inverseRel.foreignKey || `${inverseField}Id`;

						const targetRef = stateRefs[connect.targetCollection];
						if (!targetRef) continue;

						yield* Ref.update(targetRef, (map) => {
							const existing = map.get(connect.targetId);
							if (!existing) return map;

							const updated = {
								...existing,
								[foreignKey]: parentId,
								updatedAt: now,
							} as HasId;
							const next = new Map(map);
							next.set(connect.targetId, updated);
							return next;
						});
					}
				}
			}

			return validated;
		});
