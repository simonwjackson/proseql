/**
 * Shared constants and generators for property-based testing.
 *
 * This module provides:
 * - DEFAULT_NUM_RUNS: default number of test runs per property (100)
 * - getNumRuns(): reads FC_NUM_RUNS env variable or returns default
 * - entityArbitrary(schema): generate valid entities from Effect Schema
 *
 * Future tasks will add:
 * - whereClauseArbitrary(schema): generate valid where clauses
 * - sortConfigArbitrary(schema): generate valid sort configurations
 * - operationSequenceArbitrary(schema): generate CRUD operation sequences
 */

import { Arbitrary, type Schema, SchemaAST } from "effect";
import * as fc from "fast-check";

/**
 * Default number of runs per property test.
 * Balances coverage against CI speed (~10-30 seconds for all properties).
 */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Get the number of runs for property tests.
 * Reads from FC_NUM_RUNS environment variable if set, otherwise returns DEFAULT_NUM_RUNS.
 *
 * @example
 * // In shell: FC_NUM_RUNS=1000 bun test
 * // In test: fc.assert(fc.property(...), { numRuns: getNumRuns() })
 */
export const getNumRuns = (): number => {
	const envValue = process.env.FC_NUM_RUNS;
	if (envValue === undefined || envValue === "") {
		return DEFAULT_NUM_RUNS;
	}
	const parsed = Number.parseInt(envValue, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return DEFAULT_NUM_RUNS;
	}
	return parsed;
};

/**
 * Information about a field extracted from an Effect Schema.
 */
export interface FieldInfo {
	readonly name: string;
	readonly type: "string" | "number" | "boolean" | "array" | "unknown";
	readonly isOptional: boolean;
	readonly elementType?: "string" | "number" | "boolean" | "unknown";
}

/**
 * Extract field information from an Effect Schema AST.
 * Inspects the schema structure to determine field names, types, and optionality.
 *
 * @param schema - The Effect Schema to extract field information from
 * @returns Array of field information objects
 */
export const extractFieldsFromSchema = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
): readonly FieldInfo[] => {
	const ast = schema.ast;
	const fields: FieldInfo[] = [];

	// Handle TypeLiteral (Struct schemas)
	if (SchemaAST.isTypeLiteral(ast)) {
		for (const prop of ast.propertySignatures) {
			const name = String(prop.name);
			const fieldInfo = extractFieldType(prop.type, name, prop.isOptional);
			fields.push(fieldInfo);
		}
	}
	// Handle Transformation (e.g., schemas with optional with default)
	else if (SchemaAST.isTransformation(ast)) {
		// For transformations, we need to look at the "to" type which is the decoded type
		const toAst = ast.to;
		if (SchemaAST.isTypeLiteral(toAst)) {
			for (const prop of toAst.propertySignatures) {
				const name = String(prop.name);
				const fieldInfo = extractFieldType(prop.type, name, prop.isOptional);
				fields.push(fieldInfo);
			}
		}
	}

	return fields;
};

/**
 * Extract the type of a field from its AST.
 */
const extractFieldType = (
	ast: SchemaAST.AST,
	name: string,
	isOptional: boolean,
): FieldInfo => {
	// Unwrap transformations
	if (SchemaAST.isTransformation(ast)) {
		return extractFieldType(ast.to, name, isOptional);
	}

	// Handle Union types (for optional fields represented as T | undefined)
	if (SchemaAST.isUnion(ast)) {
		const nonUndefinedTypes = ast.types.filter(
			(t) => !SchemaAST.isUndefinedKeyword(t),
		);
		if (nonUndefinedTypes.length === 1) {
			return extractFieldType(nonUndefinedTypes[0], name, true);
		}
		// Multiple types in union - treat as unknown
		return { name, type: "unknown", isOptional };
	}

	// Handle basic types
	if (SchemaAST.isStringKeyword(ast)) {
		return { name, type: "string", isOptional };
	}
	if (SchemaAST.isNumberKeyword(ast)) {
		return { name, type: "number", isOptional };
	}
	if (SchemaAST.isBooleanKeyword(ast)) {
		return { name, type: "boolean", isOptional };
	}

	// Handle arrays (TupleType with rest element)
	if (SchemaAST.isTupleType(ast) && ast.rest.length > 0) {
		const elementAst = ast.rest[0].type;
		let elementType: "string" | "number" | "boolean" | "unknown" = "unknown";
		if (SchemaAST.isStringKeyword(elementAst)) {
			elementType = "string";
		} else if (SchemaAST.isNumberKeyword(elementAst)) {
			elementType = "number";
		} else if (SchemaAST.isBooleanKeyword(elementAst)) {
			elementType = "boolean";
		}
		return { name, type: "array", isOptional, elementType };
	}

	// Handle Refinement (e.g., branded types, validated strings, etc.)
	if (SchemaAST.isRefinement(ast)) {
		return extractFieldType(ast.from, name, isOptional);
	}

	return { name, type: "unknown", isOptional };
};

/**
 * Generate an arbitrary for a single field based on its type.
 */
const fieldArbitrary = (field: FieldInfo): fc.Arbitrary<unknown> => {
	switch (field.type) {
		case "string":
			// Use alphanumeric strings for cleaner test output
			return fc.string({ minLength: 0, maxLength: 50 });
		case "number":
			// Use finite numbers to avoid NaN/Infinity issues
			return fc.float({ min: -1000000, max: 1000000, noNaN: true });
		case "boolean":
			return fc.boolean();
		case "array": {
			const elementArb =
				field.elementType === "string"
					? fc.string({ minLength: 0, maxLength: 20 })
					: field.elementType === "number"
						? fc.float({ min: -10000, max: 10000, noNaN: true })
						: field.elementType === "boolean"
							? fc.boolean()
							: fc.string();
			return fc.array(elementArb, { minLength: 0, maxLength: 10 });
		}
		default:
			// For unknown types, generate simple string values as fallback
			return fc.string({ minLength: 0, maxLength: 20 });
	}
};

/**
 * Generate an arbitrary that produces valid entities matching the given Effect Schema.
 * Automatically generates an `id` field and fills all required fields with type-appropriate values.
 *
 * @param schema - The Effect Schema defining the entity structure
 * @returns A fast-check Arbitrary that generates valid entities
 *
 * @example
 * ```ts
 * const UserSchema = Schema.Struct({
 *   id: Schema.String,
 *   name: Schema.String,
 *   age: Schema.Number,
 *   isActive: Schema.optional(Schema.Boolean),
 * });
 *
 * const userArb = entityArbitrary(UserSchema);
 * fc.assert(fc.property(userArb, (user) => {
 *   // user has valid structure with auto-generated id
 *   return typeof user.id === 'string' && user.id.length > 0;
 * }));
 * ```
 */
export const entityArbitrary = <A extends { id: string }, I, R>(
	schema: Schema.Schema<A, I, R>,
): fc.Arbitrary<A> => {
	const fields = extractFieldsFromSchema(schema);

	// Build a record of arbitraries for each field
	const arbitraries: Record<string, fc.Arbitrary<unknown>> = {};

	for (const field of fields) {
		if (field.name === "id") {
			// Generate unique IDs using uuid format for better uniqueness
			arbitraries.id = fc.uuid();
		} else if (field.isOptional) {
			// For optional fields, sometimes include them, sometimes don't
			arbitraries[field.name] = fc.option(fieldArbitrary(field), {
				nil: undefined,
			});
		} else {
			arbitraries[field.name] = fieldArbitrary(field);
		}
	}

	// Use fc.record to combine all field arbitraries
	return fc.record(arbitraries) as fc.Arbitrary<A>;
};

/**
 * Alternative entity arbitrary that uses Effect's built-in Arbitrary.make.
 * This approach leverages Effect's schema introspection directly but requires
 * the schema to be fully compatible with Arbitrary generation.
 *
 * Note: This may not always produce valid `id` fields since Effect's Arbitrary
 * generates random strings. For controlled ID generation, use `entityArbitrary`.
 *
 * @param schema - The Effect Schema defining the entity structure
 * @returns A fast-check Arbitrary that generates valid entities
 */
export const entityArbitraryFromEffect = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
): fc.Arbitrary<A> => {
	return Arbitrary.make(schema);
};

// ============================================================================
// Where Clause Generator
// ============================================================================

/**
 * Type representing a generated where clause.
 * This is a simplified representation that's valid for proseql queries.
 */
export type GeneratedWhereClause = Record<
	string,
	unknown | Record<string, unknown>
>;

/**
 * String operators that can be used in where clauses for string fields.
 * (Exported for documentation; actual generation uses inline oneof)
 */
export const STRING_OPERATORS = [
	"$eq",
	"$ne",
	"$in",
	"$nin",
	"$contains",
	"$startsWith",
	"$endsWith",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
] as const;

/**
 * Number operators that can be used in where clauses for numeric fields.
 * (Exported for documentation; actual generation uses inline oneof)
 */
export const NUMBER_OPERATORS = [
	"$eq",
	"$ne",
	"$in",
	"$nin",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
] as const;

/**
 * Boolean operators that can be used in where clauses for boolean fields.
 * (Exported for documentation; actual generation uses inline oneof)
 */
export const BOOLEAN_OPERATORS = ["$eq", "$ne"] as const;

/**
 * Array operators that can be used in where clauses for array fields.
 * (Exported for documentation; actual generation uses inline oneof)
 */
export const ARRAY_OPERATORS = [
	"$eq",
	"$ne",
	"$in",
	"$nin",
	"$contains",
	"$all",
	"$size",
] as const;

/**
 * Generate an arbitrary for a single filter condition on a string field.
 */
const stringFilterArbitrary = (): fc.Arbitrary<
	string | Record<string, unknown>
> => {
	const stringValue = fc.string({ minLength: 0, maxLength: 20 });
	const stringArray = fc.array(stringValue, { minLength: 1, maxLength: 5 });

	return fc.oneof(
		// Direct equality (no operator)
		stringValue,
		// $eq operator
		fc.record({ $eq: stringValue }),
		// $ne operator
		fc.record({ $ne: stringValue }),
		// $in operator
		fc.record({ $in: stringArray }),
		// $nin operator
		fc.record({ $nin: stringArray }),
		// $contains operator
		fc.record({ $contains: stringValue }),
		// $startsWith operator
		fc.record({ $startsWith: stringValue }),
		// $endsWith operator
		fc.record({ $endsWith: stringValue }),
		// $gt, $gte, $lt, $lte operators (for string comparison)
		fc.record({ $gt: stringValue }),
		fc.record({ $gte: stringValue }),
		fc.record({ $lt: stringValue }),
		fc.record({ $lte: stringValue }),
		// Combined operators (e.g., range)
		fc.record({ $gte: stringValue, $lte: stringValue }),
	);
};

/**
 * Generate an arbitrary for a single filter condition on a numeric field.
 */
const numberFilterArbitrary = (): fc.Arbitrary<
	number | Record<string, unknown>
> => {
	const numberValue = fc.float({ min: -10000, max: 10000, noNaN: true });
	const numberArray = fc.array(numberValue, { minLength: 1, maxLength: 5 });

	return fc.oneof(
		// Direct equality (no operator)
		numberValue,
		// $eq operator
		fc.record({ $eq: numberValue }),
		// $ne operator
		fc.record({ $ne: numberValue }),
		// $in operator
		fc.record({ $in: numberArray }),
		// $nin operator
		fc.record({ $nin: numberArray }),
		// $gt operator
		fc.record({ $gt: numberValue }),
		// $gte operator
		fc.record({ $gte: numberValue }),
		// $lt operator
		fc.record({ $lt: numberValue }),
		// $lte operator
		fc.record({ $lte: numberValue }),
		// Combined operators (e.g., range)
		fc.record({ $gte: numberValue, $lte: numberValue }),
		fc.record({ $gt: numberValue, $lt: numberValue }),
	);
};

/**
 * Generate an arbitrary for a single filter condition on a boolean field.
 */
const booleanFilterArbitrary = (): fc.Arbitrary<
	boolean | Record<string, unknown>
> => {
	return fc.oneof(
		// Direct equality (no operator)
		fc.boolean(),
		// $eq operator
		fc.record({ $eq: fc.boolean() }),
		// $ne operator
		fc.record({ $ne: fc.boolean() }),
	);
};

/**
 * Generate an arbitrary for a single filter condition on an array field.
 */
const arrayFilterArbitrary = (
	elementType: "string" | "number" | "boolean" | "unknown",
): fc.Arbitrary<Record<string, unknown>> => {
	const elementArb =
		elementType === "string"
			? fc.string({ minLength: 0, maxLength: 20 })
			: elementType === "number"
				? fc.float({ min: -10000, max: 10000, noNaN: true })
				: elementType === "boolean"
					? fc.boolean()
					: fc.string();

	const arrayArb = fc.array(elementArb, {
		minLength: 0,
		maxLength: 5,
	}) as fc.Arbitrary<unknown[]>;

	return fc.oneof(
		// $contains operator (single element)
		fc.record({ $contains: elementArb as fc.Arbitrary<unknown> }),
		// $all operator (array of elements)
		fc.record({ $all: arrayArb }),
		// $size operator
		fc.record({ $size: fc.integer({ min: 0, max: 10 }) }),
	);
};

/**
 * Generate an arbitrary for a filter condition based on field type.
 */
const filterArbitraryForField = (
	field: FieldInfo,
): fc.Arbitrary<unknown> | null => {
	switch (field.type) {
		case "string":
			return stringFilterArbitrary();
		case "number":
			return numberFilterArbitrary();
		case "boolean":
			return booleanFilterArbitrary();
		case "array":
			return arrayFilterArbitrary(field.elementType ?? "unknown");
		default:
			// For unknown types, use string filter as fallback
			return stringFilterArbitrary();
	}
};

/**
 * Generate an arbitrary that produces valid where clauses matching the given Effect Schema.
 * Inspects the schema's field types and generates appropriate operators with matching value types.
 *
 * The generator produces:
 * - Empty where clauses (to test "return all" path)
 * - Single-field where clauses
 * - Multi-field where clauses (AND logic)
 *
 * @param schema - The Effect Schema defining the entity structure
 * @returns A fast-check Arbitrary that generates valid where clauses
 *
 * @example
 * ```ts
 * const UserSchema = Schema.Struct({
 *   id: Schema.String,
 *   name: Schema.String,
 *   age: Schema.Number,
 *   isActive: Schema.Boolean,
 * });
 *
 * const whereArb = whereClauseArbitrary(UserSchema);
 * fc.assert(fc.property(whereArb, (where) => {
 *   // where is a valid where clause object
 *   // e.g., {}, { name: "Alice" }, { age: { $gt: 18 } }, { name: "Bob", isActive: true }
 *   return typeof where === 'object';
 * }));
 * ```
 */
export const whereClauseArbitrary = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
): fc.Arbitrary<GeneratedWhereClause> => {
	const fields = extractFieldsFromSchema(schema);

	// Filter out the id field and fields with no valid filter arbitrary
	const filterableFields = fields.filter(
		(field) => field.name !== "id" && filterArbitraryForField(field) !== null,
	);

	// If no filterable fields, return empty object
	if (filterableFields.length === 0) {
		return fc.constant({});
	}

	// Build array of [fieldName, filterArbitrary] pairs
	const fieldArbitraries: Array<{
		name: string;
		arb: fc.Arbitrary<unknown>;
	}> = filterableFields
		.map((field) => ({
			name: field.name,
			arb: filterArbitraryForField(field),
		}))
		.filter(
			(f): f is { name: string; arb: fc.Arbitrary<unknown> } => f.arb !== null,
		);

	// Generate where clauses with 0 to N fields
	// Weight empty clauses to appear ~10% of the time
	return fc.oneof(
		// Empty where clause (10% weight)
		{ weight: 1, arbitrary: fc.constant({}) },
		// Single field where clause (40% weight)
		{
			weight: 4,
			arbitrary: fc.nat({ max: fieldArbitraries.length - 1 }).chain((index) => {
				const { name, arb } = fieldArbitraries[index];
				return arb.map((value) => ({ [name]: value }));
			}),
		},
		// Multi-field where clause (50% weight)
		{
			weight: 5,
			arbitrary: fc
				.subarray(fieldArbitraries, { minLength: 1, maxLength: 3 })
				.chain((selectedFields) => {
					// Generate a value for each selected field
					const recordArbitraries: Record<string, fc.Arbitrary<unknown>> = {};
					for (const { name, arb } of selectedFields) {
						recordArbitraries[name] = arb;
					}
					return fc.record(recordArbitraries);
				}),
		},
	);
};

// ============================================================================
// Sort Config Generator
// ============================================================================

/**
 * Type representing a generated sort configuration.
 * This maps field names to sort directions ("asc" or "desc").
 */
export type GeneratedSortConfig = Record<string, "asc" | "desc">;

/**
 * Sort direction options.
 */
const SORT_DIRECTIONS = ["asc", "desc"] as const;

/**
 * Arbitrary that generates a sort direction ("asc" or "desc").
 */
const sortDirectionArbitrary = (): fc.Arbitrary<"asc" | "desc"> => {
	return fc.constantFrom(...SORT_DIRECTIONS);
};

/**
 * Generate an arbitrary that produces valid sort configurations matching the given Effect Schema.
 * Picks field names from the schema and assigns them sort directions ("asc" or "desc").
 *
 * The generator produces:
 * - Empty sort configurations (to test "no sorting" path)
 * - Single-field sort configurations (most common use case)
 * - Multi-field sort configurations (for secondary sort keys)
 *
 * @param schema - The Effect Schema defining the entity structure
 * @returns A fast-check Arbitrary that generates valid sort configurations
 *
 * @example
 * ```ts
 * const UserSchema = Schema.Struct({
 *   id: Schema.String,
 *   name: Schema.String,
 *   age: Schema.Number,
 *   isActive: Schema.Boolean,
 * });
 *
 * const sortArb = sortConfigArbitrary(UserSchema);
 * fc.assert(fc.property(sortArb, (sort) => {
 *   // sort is a valid sort config object
 *   // e.g., {}, { name: "asc" }, { age: "desc", name: "asc" }
 *   return typeof sort === 'object';
 * }));
 * ```
 */
export const sortConfigArbitrary = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
): fc.Arbitrary<GeneratedSortConfig> => {
	const fields = extractFieldsFromSchema(schema);

	// Extract sortable field names (all fields are sortable)
	// Include 'id' since it's commonly used for stable sorting
	const sortableFieldNames = fields.map((field) => field.name);

	// If no sortable fields, return empty object
	if (sortableFieldNames.length === 0) {
		return fc.constant({});
	}

	// Build array of field name arbitraries with their direction
	const fieldWithDirectionArbitrary = fc
		.constantFrom(...sortableFieldNames)
		.chain((fieldName) =>
			sortDirectionArbitrary().map(
				(direction) => [fieldName, direction] as const,
			),
		);

	// Generate sort configs with 0 to N fields
	// Weight empty configs to appear ~10% of the time, single field ~50%, multi-field ~40%
	return fc.oneof(
		// Empty sort config (10% weight)
		{ weight: 1, arbitrary: fc.constant({}) },
		// Single field sort config (50% weight)
		{
			weight: 5,
			arbitrary: fieldWithDirectionArbitrary.map(([fieldName, direction]) => ({
				[fieldName]: direction,
			})),
		},
		// Multi-field sort config (40% weight)
		{
			weight: 4,
			arbitrary: fc
				.uniqueArray(fc.constantFrom(...sortableFieldNames), {
					minLength: 2,
					maxLength: Math.min(3, sortableFieldNames.length),
				})
				.chain((selectedFields) => {
					// Generate a direction for each selected field
					const directionArbitraries = selectedFields.map((name) =>
						sortDirectionArbitrary().map((dir) => [name, dir] as const),
					);
					return fc.tuple(...directionArbitraries).map((pairs) => {
						const result: GeneratedSortConfig = {};
						for (const [name, direction] of pairs) {
							result[name] = direction;
						}
						return result;
					});
				}),
		},
	);
};

// ============================================================================
// Operation Sequence Generator
// ============================================================================

/**
 * Type representing a CRUD operation in an operation sequence.
 */
export type CrudOperation<A extends { id: string }> =
	| { readonly op: "create"; readonly payload: A }
	| { readonly op: "update"; readonly id: string; readonly payload: Partial<A> }
	| { readonly op: "delete"; readonly id: string };

/**
 * Type representing a generated sequence of CRUD operations.
 */
export type GeneratedOperationSequence<A extends { id: string }> =
	readonly CrudOperation<A>[];

/**
 * Generate an arbitrary for partial update payload based on field information.
 * Only includes non-id fields and makes them all optional.
 */
const updatePayloadArbitrary = (
	fields: readonly FieldInfo[],
): fc.Arbitrary<Record<string, unknown>> => {
	// Filter out id field - we don't want to update the id
	const updateableFields = fields.filter((f) => f.name !== "id");

	if (updateableFields.length === 0) {
		return fc.constant({});
	}

	// Generate a subset of fields to update (at least 1)
	return fc
		.subarray(updateableFields, {
			minLength: 1,
			maxLength: updateableFields.length,
		})
		.chain((selectedFields) => {
			const arbitraries: Record<string, fc.Arbitrary<unknown>> = {};
			for (const field of selectedFields) {
				arbitraries[field.name] = fieldArbitrary(field);
			}
			return fc.record(arbitraries);
		});
};

/**
 * Generate an arbitrary that produces sequences of CRUD operations (create, update, delete).
 *
 * The generator ensures referential integrity:
 * - `create` operations produce new entities with unique IDs
 * - `update` operations reference IDs from previously created (and not deleted) entities
 * - `delete` operations reference IDs from previously created (and not deleted) entities
 *
 * This is achieved by generating sequences where operations can only reference
 * entities that would exist at that point in the sequence.
 *
 * @param schema - The Effect Schema defining the entity structure
 * @param options - Optional configuration
 * @param options.minLength - Minimum sequence length (default: 1)
 * @param options.maxLength - Maximum sequence length (default: 10)
 * @returns A fast-check Arbitrary that generates valid operation sequences
 *
 * @example
 * ```ts
 * const BookSchema = Schema.Struct({
 *   id: Schema.String,
 *   title: Schema.String,
 *   year: Schema.Number,
 * });
 *
 * const opsArb = operationSequenceArbitrary(BookSchema);
 * fc.assert(fc.property(opsArb, (ops) => {
 *   // ops is a valid sequence where update/delete reference existing IDs
 *   // e.g., [
 *   //   { op: "create", payload: { id: "abc", title: "Dune", year: 1965 } },
 *   //   { op: "update", id: "abc", payload: { year: 1966 } },
 *   //   { op: "delete", id: "abc" },
 *   // ]
 *   return Array.isArray(ops);
 * }));
 * ```
 */
export const operationSequenceArbitrary = <A extends { id: string }, I, R>(
	schema: Schema.Schema<A, I, R>,
	options?: { readonly minLength?: number; readonly maxLength?: number },
): fc.Arbitrary<GeneratedOperationSequence<A>> => {
	const minLength = options?.minLength ?? 1;
	const maxLength = options?.maxLength ?? 10;
	const fields = extractFieldsFromSchema(schema);

	// We use a stateful generator that tracks which IDs are "alive" at each step
	// This ensures update/delete operations only reference valid IDs
	return fc
		.integer({ min: minLength, max: maxLength })
		.chain((sequenceLength) => {
			// Generate enough entities for potential creates
			const entityArb = entityArbitrary(schema);

			// Generate the full sequence with a model that tracks alive IDs
			return generateSequenceWithModel<A>(
				sequenceLength,
				entityArb,
				updatePayloadArbitrary(fields),
			);
		});
};

/**
 * Generate an operation sequence by maintaining a model of alive IDs.
 * This ensures referential integrity is maintained throughout the sequence.
 */
const generateSequenceWithModel = <A extends { id: string }>(
	length: number,
	entityArb: fc.Arbitrary<A>,
	updatePayloadArb: fc.Arbitrary<Record<string, unknown>>,
): fc.Arbitrary<GeneratedOperationSequence<A>> => {
	if (length === 0) {
		return fc.constant([]);
	}

	// Generate all potential entities upfront
	return fc
		.array(entityArb, { minLength: length, maxLength: length })
		.chain((entities) => {
			// Generate operation types with weights:
			// - First op must be create (to have IDs to work with)
			// - Subsequent ops: 50% create, 30% update, 20% delete
			return fc
				.array(
					fc.oneof(
						{ weight: 5, arbitrary: fc.constant("create" as const) },
						{ weight: 3, arbitrary: fc.constant("update" as const) },
						{ weight: 2, arbitrary: fc.constant("delete" as const) },
					),
					{ minLength: length, maxLength: length },
				)
				.chain((opTypes) => {
					// Generate update payloads for each potential update
					return fc
						.array(updatePayloadArb, { minLength: length, maxLength: length })
						.chain((updatePayloads) => {
							// Generate random indices for targeting existing entities
							return fc
								.array(fc.nat({ max: 1000 }), {
									minLength: length,
									maxLength: length,
								})
								.map((targetIndices) => {
									// Build the sequence maintaining alive IDs state
									const operations: CrudOperation<A>[] = [];
									const aliveIds: string[] = [];
									let entityIndex = 0;

									for (let i = 0; i < length; i++) {
										let opType = opTypes[i];

										// First operation must be create, or if no alive IDs exist
										if (aliveIds.length === 0) {
											opType = "create";
										}

										if (opType === "create") {
											const entity = entities[entityIndex];
											entityIndex = (entityIndex + 1) % entities.length;
											operations.push({
												op: "create",
												payload: entity,
											});
											aliveIds.push(entity.id);
										} else if (opType === "update") {
											// Pick a random alive ID
											const targetIdx = targetIndices[i] % aliveIds.length;
											const targetId = aliveIds[targetIdx];
											operations.push({
												op: "update",
												id: targetId,
												payload: updatePayloads[i] as Partial<A>,
											});
										} else {
											// delete
											// Pick a random alive ID and remove it
											const targetIdx = targetIndices[i] % aliveIds.length;
											const targetId = aliveIds[targetIdx];
											operations.push({
												op: "delete",
												id: targetId,
											});
											// Remove from alive IDs
											aliveIds.splice(targetIdx, 1);
										}
									}

									return operations;
								});
						});
				});
		});
};

// ============================================================================
// Reference Where Clause Evaluator (Test Oracle)
// ============================================================================

/**
 * Evaluate a single operator against a value.
 * This is a reference implementation used as a test oracle for property tests.
 *
 * @param value - The field value from the entity
 * @param operator - The operator string (e.g., "$eq", "$gt", "$contains")
 * @param operand - The operand value from the where clause
 * @returns true if the value matches the condition, false otherwise
 */
export const evaluateOperator = (
	value: unknown,
	operator: string,
	operand: unknown,
): boolean => {
	switch (operator) {
		// Universal operators
		case "$eq":
			return value === operand;
		case "$ne":
			return value !== operand;
		case "$in":
			return Array.isArray(operand) && operand.includes(value);
		case "$nin":
			return Array.isArray(operand) && !operand.includes(value);

		// Comparison operators (numbers and strings)
		case "$gt":
			if (typeof value === "number" && typeof operand === "number") {
				return value > operand;
			}
			if (typeof value === "string" && typeof operand === "string") {
				return value > operand;
			}
			return false;
		case "$gte":
			if (typeof value === "number" && typeof operand === "number") {
				return value >= operand;
			}
			if (typeof value === "string" && typeof operand === "string") {
				return value >= operand;
			}
			return false;
		case "$lt":
			if (typeof value === "number" && typeof operand === "number") {
				return value < operand;
			}
			if (typeof value === "string" && typeof operand === "string") {
				return value < operand;
			}
			return false;
		case "$lte":
			if (typeof value === "number" && typeof operand === "number") {
				return value <= operand;
			}
			if (typeof value === "string" && typeof operand === "string") {
				return value <= operand;
			}
			return false;

		// String operators
		case "$startsWith":
			return (
				typeof value === "string" &&
				typeof operand === "string" &&
				value.startsWith(operand)
			);
		case "$endsWith":
			return (
				typeof value === "string" &&
				typeof operand === "string" &&
				value.endsWith(operand)
			);
		case "$contains":
			// String contains
			if (typeof value === "string" && typeof operand === "string") {
				return value.includes(operand);
			}
			// Array contains
			if (Array.isArray(value)) {
				return value.includes(operand);
			}
			return false;

		// Array operators
		case "$all":
			if (!Array.isArray(value) || !Array.isArray(operand)) {
				return false;
			}
			return operand.every((item) => value.includes(item));
		case "$size":
			return Array.isArray(value) && value.length === operand;

		default:
			// Unknown operator - treat as not matching
			return false;
	}
};

/**
 * Check if a single field value matches a condition.
 * Handles both direct equality and operator-based conditions.
 *
 * @param value - The field value from the entity
 * @param condition - The condition from the where clause (can be a direct value or operator object)
 * @returns true if the value matches the condition, false otherwise
 */
export const fieldMatchesCondition = (
	value: unknown,
	condition: unknown,
): boolean => {
	// Direct equality (no operator)
	if (
		typeof condition !== "object" ||
		condition === null ||
		Array.isArray(condition)
	) {
		return value === condition;
	}

	// Operator-based condition
	const ops = condition as Record<string, unknown>;

	// Multiple operators in the same object = AND logic
	for (const [op, operand] of Object.entries(ops)) {
		if (!evaluateOperator(value, op, operand)) {
			return false;
		}
	}

	return true;
};

/**
 * Reference implementation for evaluating where clauses against entities.
 * This function serves as a test oracle for property-based tests — it provides
 * a simple, readable implementation that we can trust, against which we compare
 * the actual query engine behavior.
 *
 * The implementation evaluates where clauses using plain JavaScript:
 * - Empty where clause matches all entities
 * - Field conditions use AND logic (all must match)
 * - Supports all operators generated by whereClauseArbitrary
 *
 * @param entity - The entity to test against the where clause
 * @param where - The where clause to evaluate
 * @returns true if the entity matches the where clause, false otherwise
 *
 * @example
 * ```ts
 * const book = { id: "1", title: "Dune", year: 1965, isPublished: true };
 *
 * // Empty where matches everything
 * matchesWhere(book, {}) // => true
 *
 * // Direct value equality
 * matchesWhere(book, { title: "Dune" }) // => true
 * matchesWhere(book, { title: "Other" }) // => false
 *
 * // Operator-based conditions
 * matchesWhere(book, { year: { $gt: 1960 } }) // => true
 * matchesWhere(book, { year: { $gte: 1965, $lt: 1970 } }) // => true
 *
 * // Multiple field conditions (AND logic)
 * matchesWhere(book, { title: "Dune", isPublished: true }) // => true
 * matchesWhere(book, { title: "Dune", isPublished: false }) // => false
 * ```
 */
export const matchesWhere = <T extends Record<string, unknown>>(
	entity: T,
	where: GeneratedWhereClause,
): boolean => {
	// Empty where clause matches everything
	if (Object.keys(where).length === 0) {
		return true;
	}

	// Check each field condition (AND logic - all must match)
	for (const [fieldName, condition] of Object.entries(where)) {
		const fieldValue = entity[fieldName];

		if (!fieldMatchesCondition(fieldValue, condition)) {
			return false;
		}
	}

	return true;
};
