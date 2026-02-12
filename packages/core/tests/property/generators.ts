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
 */
const STRING_OPERATORS = [
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
 */
const NUMBER_OPERATORS = [
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
 */
const BOOLEAN_OPERATORS = ["$eq", "$ne"] as const;

/**
 * Array operators that can be used in where clauses for array fields.
 */
const ARRAY_OPERATORS = [
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
			arbitrary: fc
				.nat({ max: fieldArbitraries.length - 1 })
				.chain((index) => {
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
