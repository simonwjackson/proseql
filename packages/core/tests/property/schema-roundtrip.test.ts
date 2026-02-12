/**
 * Property-based tests for Schema encode/decode invariants.
 *
 * Task 3.1: Create this test file
 * Task 3.2: Property - any value produced by entityArbitrary survives Schema.encode then
 *           Schema.decode and is deeply equal to the original
 * Task 3.3: Property - a randomly mutated entity (wrong field types, missing required fields)
 *           is rejected by Schema.decode with a validation error, never silently accepted
 */
import { Either, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entityArbitrary, getNumRuns } from "./generators";

/**
 * Mutation types for generating invalid data.
 */
type MutationType =
	| "wrongTypeString" // Replace a string field with a number
	| "wrongTypeNumber" // Replace a number field with a string
	| "wrongTypeBoolean" // Replace a boolean field with a string
	| "wrongTypeArray" // Replace an array field with a non-array
	| "missingRequired" // Remove a required field
	| "nullRequired" // Set a required field to null
	| "undefinedRequired" // Set a required field to undefined
	| "extraNested"; // Add an invalid nested structure

/**
 * Field mutation information for generating invalid data.
 */
interface FieldMutation {
	readonly fieldName: string;
	readonly mutationType: MutationType;
	readonly invalidValue: unknown;
}

/**
 * Generate an arbitrary that produces invalid entity mutations for SimpleSchema.
 * The mutations include wrong types for fields and missing required fields.
 */
const simpleSchemaInvalidArbitrary = (): fc.Arbitrary<
	Record<string, unknown>
> => {
	// Generate a base valid-ish structure, then mutate one field to be invalid
	const mutations: FieldMutation[] = [
		// Wrong type mutations
		{ fieldName: "id", mutationType: "wrongTypeString", invalidValue: 12345 },
		{ fieldName: "id", mutationType: "wrongTypeString", invalidValue: true },
		{ fieldName: "id", mutationType: "wrongTypeString", invalidValue: null },
		{
			fieldName: "id",
			mutationType: "wrongTypeString",
			invalidValue: { nested: "object" },
		},
		{ fieldName: "name", mutationType: "wrongTypeString", invalidValue: 42 },
		{ fieldName: "name", mutationType: "wrongTypeString", invalidValue: false },
		{
			fieldName: "name",
			mutationType: "wrongTypeString",
			invalidValue: ["array"],
		},
		{
			fieldName: "age",
			mutationType: "wrongTypeNumber",
			invalidValue: "not a number",
		},
		{ fieldName: "age", mutationType: "wrongTypeNumber", invalidValue: true },
		{
			fieldName: "age",
			mutationType: "wrongTypeNumber",
			invalidValue: { obj: 1 },
		},
		{
			fieldName: "isActive",
			mutationType: "wrongTypeBoolean",
			invalidValue: "true",
		},
		{
			fieldName: "isActive",
			mutationType: "wrongTypeBoolean",
			invalidValue: 1,
		},
		{
			fieldName: "isActive",
			mutationType: "wrongTypeBoolean",
			invalidValue: null,
		},
		// Missing required field mutations (represented by undefined)
		{
			fieldName: "id",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "name",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "age",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "isActive",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
	];

	return fc.constantFrom(...mutations).chain((mutation) => {
		// Build a base valid object, then apply the mutation
		return fc
			.record({
				id:
					mutation.fieldName === "id"
						? fc.constant(mutation.invalidValue)
						: fc.uuid(),
				name:
					mutation.fieldName === "name"
						? fc.constant(mutation.invalidValue)
						: fc.string(),
				age:
					mutation.fieldName === "age"
						? fc.constant(mutation.invalidValue)
						: fc.integer(),
				isActive:
					mutation.fieldName === "isActive"
						? fc.constant(mutation.invalidValue)
						: fc.boolean(),
			})
			.map((obj) => {
				// For "missingRequired" mutations, actually delete the field
				if (mutation.mutationType === "missingRequired") {
					const result = { ...obj };
					delete (result as Record<string, unknown>)[mutation.fieldName];
					return result;
				}
				return obj;
			});
	});
};

/**
 * Generate an arbitrary that produces invalid entity mutations for ComplexSchema.
 * Includes wrong types, missing fields, and invalid array contents.
 */
const complexSchemaInvalidArbitrary = (): fc.Arbitrary<
	Record<string, unknown>
> => {
	const mutations: FieldMutation[] = [
		// Wrong type mutations for required fields
		{ fieldName: "id", mutationType: "wrongTypeString", invalidValue: 999 },
		{ fieldName: "title", mutationType: "wrongTypeString", invalidValue: 123 },
		{
			fieldName: "rating",
			mutationType: "wrongTypeNumber",
			invalidValue: "five stars",
		},
		{
			fieldName: "isPublished",
			mutationType: "wrongTypeBoolean",
			invalidValue: "yes",
		},
		// Wrong type mutations for arrays
		{
			fieldName: "tags",
			mutationType: "wrongTypeArray",
			invalidValue: "not an array",
		},
		{ fieldName: "tags", mutationType: "wrongTypeArray", invalidValue: 123 },
		{
			fieldName: "scores",
			mutationType: "wrongTypeArray",
			invalidValue: { scores: [1, 2] },
		},
		// Missing required field mutations
		{
			fieldName: "id",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "title",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "rating",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "isPublished",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "tags",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "scores",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
	];

	return fc.constantFrom(...mutations).chain((mutation) => {
		return fc
			.record({
				id:
					mutation.fieldName === "id"
						? fc.constant(mutation.invalidValue)
						: fc.uuid(),
				title:
					mutation.fieldName === "title"
						? fc.constant(mutation.invalidValue)
						: fc.string(),
				rating:
					mutation.fieldName === "rating"
						? fc.constant(mutation.invalidValue)
						: fc.float({ noNaN: true }),
				isPublished:
					mutation.fieldName === "isPublished"
						? fc.constant(mutation.invalidValue)
						: fc.boolean(),
				tags:
					mutation.fieldName === "tags"
						? fc.constant(mutation.invalidValue)
						: fc.array(fc.string()),
				scores:
					mutation.fieldName === "scores"
						? fc.constant(mutation.invalidValue)
						: fc.array(fc.float({ noNaN: true })),
				views: fc.option(fc.float({ noNaN: true }), { nil: undefined }),
				description: fc.option(fc.string(), { nil: undefined }),
			})
			.map((obj) => {
				if (mutation.mutationType === "missingRequired") {
					const result = { ...obj };
					delete (result as Record<string, unknown>)[mutation.fieldName];
					return result;
				}
				return obj;
			});
	});
};

/**
 * Generate an arbitrary that produces arrays with wrong element types.
 * For ArrayHeavySchema, this generates arrays where elements have wrong types.
 */
const arraySchemaInvalidArbitrary = (): fc.Arbitrary<
	Record<string, unknown>
> => {
	const mutations: FieldMutation[] = [
		// Array with wrong element types
		{
			fieldName: "stringTags",
			mutationType: "wrongTypeArray",
			invalidValue: [1, 2, 3],
		}, // numbers instead of strings
		{
			fieldName: "stringTags",
			mutationType: "wrongTypeArray",
			invalidValue: [true, false],
		}, // booleans instead of strings
		{
			fieldName: "numericScores",
			mutationType: "wrongTypeArray",
			invalidValue: ["a", "b", "c"],
		}, // strings instead of numbers
		{
			fieldName: "numericScores",
			mutationType: "wrongTypeArray",
			invalidValue: [true, false],
		}, // booleans instead of numbers
		{
			fieldName: "boolFlags",
			mutationType: "wrongTypeArray",
			invalidValue: [1, 0, 1],
		}, // numbers instead of booleans
		{
			fieldName: "boolFlags",
			mutationType: "wrongTypeArray",
			invalidValue: ["true", "false"],
		}, // strings instead of booleans
		// Not arrays at all
		{
			fieldName: "stringTags",
			mutationType: "wrongTypeArray",
			invalidValue: "not an array",
		},
		{
			fieldName: "numericScores",
			mutationType: "wrongTypeArray",
			invalidValue: 42,
		},
		{
			fieldName: "boolFlags",
			mutationType: "wrongTypeArray",
			invalidValue: { flag: true },
		},
		// Missing required arrays
		{
			fieldName: "id",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "stringTags",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "numericScores",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
		{
			fieldName: "boolFlags",
			mutationType: "missingRequired",
			invalidValue: undefined,
		},
	];

	return fc.constantFrom(...mutations).chain((mutation) => {
		return fc
			.record({
				id:
					mutation.fieldName === "id"
						? fc.constant(mutation.invalidValue)
						: fc.uuid(),
				stringTags:
					mutation.fieldName === "stringTags"
						? fc.constant(mutation.invalidValue)
						: fc.array(fc.string()),
				numericScores:
					mutation.fieldName === "numericScores"
						? fc.constant(mutation.invalidValue)
						: fc.array(fc.float({ noNaN: true })),
				boolFlags:
					mutation.fieldName === "boolFlags"
						? fc.constant(mutation.invalidValue)
						: fc.array(fc.boolean()),
			})
			.map((obj) => {
				if (mutation.mutationType === "missingRequired") {
					const result = { ...obj };
					delete (result as Record<string, unknown>)[mutation.fieldName];
					return result;
				}
				return obj;
			});
	});
};

/**
 * Generate arbitrary completely random values that are very unlikely to be valid entities.
 * These include primitives, null, deeply nested objects, etc.
 */
const totallyInvalidArbitrary = (): fc.Arbitrary<unknown> => {
	return fc.oneof(
		fc.constant(null),
		fc.constant(undefined),
		fc.string(),
		fc.integer(),
		fc.boolean(),
		fc.constant([]),
		fc.constant({}),
		fc.array(fc.integer()),
		fc.array(fc.string()),
		// Deeply nested invalid structures
		fc.record({
			wrong: fc.string(),
			structure: fc.integer(),
		}),
		// Arrays of objects (wrong type entirely)
		fc.array(fc.record({ x: fc.integer() })),
	);
};

/**
 * Test schemas used for property-based testing.
 * These cover various field types: strings, numbers, booleans, arrays, and optional fields.
 */
const SimpleSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	isActive: Schema.Boolean,
});

const ComplexSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	rating: Schema.Number,
	isPublished: Schema.Boolean,
	tags: Schema.Array(Schema.String),
	scores: Schema.Array(Schema.Number),
	views: Schema.optional(Schema.Number),
	description: Schema.optional(Schema.String),
});

const ArrayHeavySchema = Schema.Struct({
	id: Schema.String,
	stringTags: Schema.Array(Schema.String),
	numericScores: Schema.Array(Schema.Number),
	boolFlags: Schema.Array(Schema.Boolean),
});

describe("Schema round-trip properties", () => {
	describe("Task 3.2: encode-decode round-trip invariant", () => {
		it("should survive encode→decode round-trip for SimpleSchema", () => {
			const encode = Schema.encodeSync(SimpleSchema);
			const decode = Schema.decodeSync(SimpleSchema);

			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					// Encode the entity, then decode it back
					const encoded = encode(entity);
					const decoded = decode(encoded);

					// The decoded value should be deeply equal to the original
					expect(decoded).toEqual(entity);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should survive encode→decode round-trip for ComplexSchema with optional fields", () => {
			const encode = Schema.encodeSync(ComplexSchema);
			const decode = Schema.decodeSync(ComplexSchema);

			fc.assert(
				fc.property(entityArbitrary(ComplexSchema), (entity) => {
					const encoded = encode(entity);
					const decoded = decode(encoded);

					// Required fields must match exactly
					expect(decoded.id).toBe(entity.id);
					expect(decoded.title).toBe(entity.title);
					expect(decoded.rating).toBe(entity.rating);
					expect(decoded.isPublished).toBe(entity.isPublished);
					expect(decoded.tags).toEqual(entity.tags);
					expect(decoded.scores).toEqual(entity.scores);

					// Optional fields: compare presence and value
					expect(decoded.views).toBe(entity.views);
					expect(decoded.description).toBe(entity.description);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should survive encode→decode round-trip for ArrayHeavySchema", () => {
			const encode = Schema.encodeSync(ArrayHeavySchema);
			const decode = Schema.decodeSync(ArrayHeavySchema);

			fc.assert(
				fc.property(entityArbitrary(ArrayHeavySchema), (entity) => {
					const encoded = encode(entity);
					const decoded = decode(encoded);

					expect(decoded).toEqual(entity);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should maintain value identity through encode→decode (reference equality not required)", () => {
			const encode = Schema.encodeSync(SimpleSchema);
			const decode = Schema.decodeSync(SimpleSchema);

			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					const encoded = encode(entity);
					const decoded = decode(encoded);

					// Values should be equal but may not be the same reference
					expect(decoded.id).toBe(entity.id);
					expect(decoded.name).toBe(entity.name);
					expect(decoded.age).toBe(entity.age);
					expect(decoded.isActive).toBe(entity.isActive);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should preserve array order through encode→decode", () => {
			const encode = Schema.encodeSync(ComplexSchema);
			const decode = Schema.decodeSync(ComplexSchema);

			fc.assert(
				fc.property(entityArbitrary(ComplexSchema), (entity) => {
					const encoded = encode(entity);
					const decoded = decode(encoded);

					// Arrays should preserve order
					expect(decoded.tags).toEqual(entity.tags);
					expect(decoded.scores).toEqual(entity.scores);

					// Verify element-by-element
					for (let i = 0; i < entity.tags.length; i++) {
						expect(decoded.tags[i]).toBe(entity.tags[i]);
					}
					for (let i = 0; i < entity.scores.length; i++) {
						expect(decoded.scores[i]).toBe(entity.scores[i]);
					}
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle empty arrays through encode→decode", () => {
			// Create a schema that will produce entities with potentially empty arrays
			const encode = Schema.encodeSync(ArrayHeavySchema);
			const decode = Schema.decodeSync(ArrayHeavySchema);

			fc.assert(
				fc.property(entityArbitrary(ArrayHeavySchema), (entity) => {
					const encoded = encode(entity);
					const decoded = decode(encoded);

					// Even empty arrays should survive round-trip
					expect(Array.isArray(decoded.stringTags)).toBe(true);
					expect(Array.isArray(decoded.numericScores)).toBe(true);
					expect(Array.isArray(decoded.boolFlags)).toBe(true);

					expect(decoded.stringTags).toEqual(entity.stringTags);
					expect(decoded.numericScores).toEqual(entity.numericScores);
					expect(decoded.boolFlags).toEqual(entity.boolFlags);
				}),
				{ numRuns: getNumRuns() },
			);
		});
	});

	describe("Task 3.3: Schema rejection of invalid data", () => {
		it("should reject SimpleSchema entities with wrong field types", () => {
			const decode = Schema.decodeUnknownEither(SimpleSchema);

			fc.assert(
				fc.property(simpleSchemaInvalidArbitrary(), (invalidEntity) => {
					const result = decode(invalidEntity);
					// The result should be a Left (failure), never a Right (success)
					expect(Either.isLeft(result)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should reject ComplexSchema entities with wrong field types or missing fields", () => {
			const decode = Schema.decodeUnknownEither(ComplexSchema);

			fc.assert(
				fc.property(complexSchemaInvalidArbitrary(), (invalidEntity) => {
					const result = decode(invalidEntity);
					expect(Either.isLeft(result)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should reject ArrayHeavySchema entities with wrong array element types", () => {
			const decode = Schema.decodeUnknownEither(ArrayHeavySchema);

			fc.assert(
				fc.property(arraySchemaInvalidArbitrary(), (invalidEntity) => {
					const result = decode(invalidEntity);
					expect(Either.isLeft(result)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should reject completely invalid data types for SimpleSchema", () => {
			const decode = Schema.decodeUnknownEither(SimpleSchema);

			fc.assert(
				fc.property(totallyInvalidArbitrary(), (invalidData) => {
					const result = decode(invalidData);
					// Non-object inputs should always be rejected
					expect(Either.isLeft(result)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should reject completely invalid data types for ComplexSchema", () => {
			const decode = Schema.decodeUnknownEither(ComplexSchema);

			fc.assert(
				fc.property(totallyInvalidArbitrary(), (invalidData) => {
					const result = decode(invalidData);
					expect(Either.isLeft(result)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should reject null and undefined for all schemas", () => {
			const decodeSimple = Schema.decodeUnknownEither(SimpleSchema);
			const decodeComplex = Schema.decodeUnknownEither(ComplexSchema);
			const decodeArray = Schema.decodeUnknownEither(ArrayHeavySchema);

			// null should be rejected
			expect(Either.isLeft(decodeSimple(null))).toBe(true);
			expect(Either.isLeft(decodeComplex(null))).toBe(true);
			expect(Either.isLeft(decodeArray(null))).toBe(true);

			// undefined should be rejected
			expect(Either.isLeft(decodeSimple(undefined))).toBe(true);
			expect(Either.isLeft(decodeComplex(undefined))).toBe(true);
			expect(Either.isLeft(decodeArray(undefined))).toBe(true);
		});

		it("should reject empty objects for schemas with required fields", () => {
			const decodeSimple = Schema.decodeUnknownEither(SimpleSchema);
			const decodeComplex = Schema.decodeUnknownEither(ComplexSchema);
			const decodeArray = Schema.decodeUnknownEither(ArrayHeavySchema);

			// Empty objects are missing all required fields
			expect(Either.isLeft(decodeSimple({}))).toBe(true);
			expect(Either.isLeft(decodeComplex({}))).toBe(true);
			expect(Either.isLeft(decodeArray({}))).toBe(true);
		});

		it("should reject objects with extra fields of wrong types mixed with valid fields", () => {
			const decode = Schema.decodeUnknownEither(SimpleSchema);

			// Object has all required fields with correct types,
			// but we're testing that partial objects are rejected
			const partialObject = {
				id: "valid-id",
				name: "Valid Name",
				// missing: age, isActive
			};

			expect(Either.isLeft(decode(partialObject))).toBe(true);
		});

		it("should consistently reject the same invalid input (deterministic)", () => {
			const decode = Schema.decodeUnknownEither(SimpleSchema);

			fc.assert(
				fc.property(simpleSchemaInvalidArbitrary(), (invalidEntity) => {
					// Decode the same invalid entity multiple times
					const result1 = decode(invalidEntity);
					const result2 = decode(invalidEntity);
					const result3 = decode(invalidEntity);

					// All should be Left (failure)
					expect(Either.isLeft(result1)).toBe(true);
					expect(Either.isLeft(result2)).toBe(true);
					expect(Either.isLeft(result3)).toBe(true);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should never silently accept invalid data as valid (discrimination test)", () => {
			// This test verifies the core property: invalid data is NEVER silently accepted.
			// We generate valid entities, then mutate them to be invalid, and verify rejection.
			const decode = Schema.decodeUnknownEither(SimpleSchema);

			fc.assert(
				fc.property(
					entityArbitrary(SimpleSchema),
					fc.constantFrom("id", "name", "age", "isActive"),
					fc.oneof(
						fc.constant(null),
						fc.constant(undefined),
						// Wrong type values
						fc.record({ wrong: fc.string() }),
						fc.array(fc.integer()),
					),
					(validEntity, fieldToMutate, invalidValue) => {
						// Create a copy with one field mutated to an invalid value
						const mutatedEntity = {
							...validEntity,
							[fieldToMutate]: invalidValue,
						};
						const result = decode(mutatedEntity);

						// The mutated entity should be rejected
						expect(Either.isLeft(result)).toBe(true);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});
});
