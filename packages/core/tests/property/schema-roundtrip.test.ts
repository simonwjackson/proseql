/**
 * Property-based tests for Schema encode/decode invariants.
 *
 * Task 3.1: Create this test file
 * Task 3.2: Property - any value produced by entityArbitrary survives Schema.encode then
 *           Schema.decode and is deeply equal to the original
 * Task 3.3: Property - a randomly mutated entity (wrong field types, missing required fields)
 *           is rejected by Schema.decode with a validation error, never silently accepted
 */
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entityArbitrary, getNumRuns } from "./generators";

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
		// TODO: Implement in task 3.3
		it.skip("placeholder for schema rejection property tests", () => {
			// Will be implemented in task 3.3
		});
	});
});
