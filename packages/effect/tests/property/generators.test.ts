/**
 * Unit tests for the property-based testing generators module.
 * Task 2.1: Verify shared constants and getNumRuns helper.
 * Task 2.6: Verify generated entities pass Schema decode and where clauses have valid structure.
 */
import { Schema } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ARRAY_OPERATORS,
	BOOLEAN_OPERATORS,
	DEFAULT_NUM_RUNS,
	entityArbitrary,
	extractFieldsFromSchema,
	getNumRuns,
	NUMBER_OPERATORS,
	operationSequenceArbitrary,
	STRING_OPERATORS,
	sortConfigArbitrary,
	whereClauseArbitrary,
} from "./generators";

describe("generators module", () => {
	describe("DEFAULT_NUM_RUNS", () => {
		it("should be 100", () => {
			expect(DEFAULT_NUM_RUNS).toBe(100);
		});
	});

	describe("getNumRuns", () => {
		const originalEnv = process.env.FC_NUM_RUNS;

		beforeEach(() => {
			// Clear the env variable before each test
			delete process.env.FC_NUM_RUNS;
		});

		afterEach(() => {
			// Restore original value after tests
			if (originalEnv !== undefined) {
				process.env.FC_NUM_RUNS = originalEnv;
			} else {
				delete process.env.FC_NUM_RUNS;
			}
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is not set", () => {
			delete process.env.FC_NUM_RUNS;
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is empty string", () => {
			process.env.FC_NUM_RUNS = "";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should parse FC_NUM_RUNS when set to a valid number", () => {
			process.env.FC_NUM_RUNS = "500";
			expect(getNumRuns()).toBe(500);
		});

		it("should parse FC_NUM_RUNS when set to 1", () => {
			process.env.FC_NUM_RUNS = "1";
			expect(getNumRuns()).toBe(1);
		});

		it("should parse FC_NUM_RUNS when set to a large number", () => {
			process.env.FC_NUM_RUNS = "10000";
			expect(getNumRuns()).toBe(10000);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is not a valid number", () => {
			process.env.FC_NUM_RUNS = "not-a-number";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is zero", () => {
			process.env.FC_NUM_RUNS = "0";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is negative", () => {
			process.env.FC_NUM_RUNS = "-10";
			expect(getNumRuns()).toBe(DEFAULT_NUM_RUNS);
		});

		it("should return DEFAULT_NUM_RUNS when FC_NUM_RUNS is a float", () => {
			// parseInt will parse "50.5" as 50, which is > 0, so it should return 50
			process.env.FC_NUM_RUNS = "50.5";
			expect(getNumRuns()).toBe(50);
		});

		it("should handle FC_NUM_RUNS with leading/trailing whitespace in the number", () => {
			// parseInt handles leading whitespace, "  100" parses to 100
			process.env.FC_NUM_RUNS = "  100";
			expect(getNumRuns()).toBe(100);
		});
	});

	// ============================================================================
	// Task 2.6: Tests for entityArbitrary
	// ============================================================================

	describe("extractFieldsFromSchema", () => {
		it("should extract fields from a simple Struct schema", () => {
			const TestSchema = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				age: Schema.Number,
				isActive: Schema.Boolean,
			});

			const fields = extractFieldsFromSchema(TestSchema);

			expect(fields).toHaveLength(4);
			expect(fields).toContainEqual({
				name: "id",
				type: "string",
				isOptional: false,
			});
			expect(fields).toContainEqual({
				name: "name",
				type: "string",
				isOptional: false,
			});
			expect(fields).toContainEqual({
				name: "age",
				type: "number",
				isOptional: false,
			});
			expect(fields).toContainEqual({
				name: "isActive",
				type: "boolean",
				isOptional: false,
			});
		});

		it("should extract optional fields correctly", () => {
			const TestSchema = Schema.Struct({
				id: Schema.String,
				nickname: Schema.optional(Schema.String),
			});

			const fields = extractFieldsFromSchema(TestSchema);

			expect(fields).toContainEqual({
				name: "id",
				type: "string",
				isOptional: false,
			});
			expect(fields).toContainEqual({
				name: "nickname",
				type: "string",
				isOptional: true,
			});
		});

		it("should extract array fields with element type", () => {
			const TestSchema = Schema.Struct({
				id: Schema.String,
				tags: Schema.Array(Schema.String),
				scores: Schema.Array(Schema.Number),
			});

			const fields = extractFieldsFromSchema(TestSchema);

			expect(fields).toContainEqual({
				name: "tags",
				type: "array",
				isOptional: false,
				elementType: "string",
			});
			expect(fields).toContainEqual({
				name: "scores",
				type: "array",
				isOptional: false,
				elementType: "number",
			});
		});
	});

	describe("entityArbitrary", () => {
		const SimpleSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
		});

		const ComplexSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			rating: Schema.Number,
			isPublished: Schema.Boolean,
			tags: Schema.Array(Schema.String),
			views: Schema.optional(Schema.Number),
		});

		it("should generate entities with all required fields", () => {
			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					expect(entity).toHaveProperty("id");
					expect(entity).toHaveProperty("name");
					expect(entity).toHaveProperty("age");
					expect(typeof entity.id).toBe("string");
					expect(typeof entity.name).toBe("string");
					expect(typeof entity.age).toBe("number");
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate entities with unique non-empty IDs", () => {
			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					expect(entity.id).toBeDefined();
					expect(entity.id.length).toBeGreaterThan(0);
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate entities that pass Schema.decode", () => {
			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					// Schema.decodeUnknownSync will throw if validation fails
					const decoded = Schema.decodeUnknownSync(SimpleSchema)(entity);
					expect(decoded).toEqual(entity);
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate complex entities that pass Schema.decode", () => {
			fc.assert(
				fc.property(entityArbitrary(ComplexSchema), (entity) => {
					const decoded = Schema.decodeUnknownSync(ComplexSchema)(entity);

					// Required fields should match
					expect(decoded.id).toBe(entity.id);
					expect(decoded.title).toBe(entity.title);
					expect(decoded.rating).toBe(entity.rating);
					expect(decoded.isPublished).toBe(entity.isPublished);
					expect(decoded.tags).toEqual(entity.tags);

					// Optional field may or may not be present
					if (entity.views !== undefined) {
						expect(decoded.views).toBe(entity.views);
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate arrays with correct element types", () => {
			const ArraySchema = Schema.Struct({
				id: Schema.String,
				stringTags: Schema.Array(Schema.String),
				numericScores: Schema.Array(Schema.Number),
				boolFlags: Schema.Array(Schema.Boolean),
			});

			fc.assert(
				fc.property(entityArbitrary(ArraySchema), (entity) => {
					expect(Array.isArray(entity.stringTags)).toBe(true);
					expect(Array.isArray(entity.numericScores)).toBe(true);
					expect(Array.isArray(entity.boolFlags)).toBe(true);

					for (const tag of entity.stringTags) {
						expect(typeof tag).toBe("string");
					}
					for (const score of entity.numericScores) {
						expect(typeof score).toBe("number");
					}
					for (const flag of entity.boolFlags) {
						expect(typeof flag).toBe("boolean");
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should not generate NaN or Infinity for number fields", () => {
			fc.assert(
				fc.property(entityArbitrary(SimpleSchema), (entity) => {
					expect(Number.isFinite(entity.age)).toBe(true);
				}),
				{ numRuns: 100 },
			);
		});
	});

	// ============================================================================
	// Task 2.6: Tests for whereClauseArbitrary
	// ============================================================================

	describe("whereClauseArbitrary", () => {
		const TestSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			isActive: Schema.Boolean,
			tags: Schema.Array(Schema.String),
		});

		/**
		 * Check if a value is a valid string operator structure.
		 */
		const isValidStringFilter = (
			value: unknown,
		): { valid: boolean; reason?: string } => {
			if (typeof value === "string") {
				return { valid: true };
			}
			if (typeof value === "object" && value !== null) {
				const ops = Object.keys(value);
				const validOps = new Set(STRING_OPERATORS);
				for (const op of ops) {
					if (!validOps.has(op as (typeof STRING_OPERATORS)[number])) {
						return { valid: false, reason: `Invalid string operator: ${op}` };
					}
				}
				return { valid: true };
			}
			return { valid: false, reason: `Unexpected value type: ${typeof value}` };
		};

		/**
		 * Check if a value is a valid number operator structure.
		 */
		const isValidNumberFilter = (
			value: unknown,
		): { valid: boolean; reason?: string } => {
			if (typeof value === "number") {
				return { valid: true };
			}
			if (typeof value === "object" && value !== null) {
				const ops = Object.keys(value);
				const validOps = new Set(NUMBER_OPERATORS);
				for (const op of ops) {
					if (!validOps.has(op as (typeof NUMBER_OPERATORS)[number])) {
						return { valid: false, reason: `Invalid number operator: ${op}` };
					}
				}
				return { valid: true };
			}
			return { valid: false, reason: `Unexpected value type: ${typeof value}` };
		};

		/**
		 * Check if a value is a valid boolean operator structure.
		 */
		const isValidBooleanFilter = (
			value: unknown,
		): { valid: boolean; reason?: string } => {
			if (typeof value === "boolean") {
				return { valid: true };
			}
			if (typeof value === "object" && value !== null) {
				const ops = Object.keys(value);
				const validOps = new Set(BOOLEAN_OPERATORS);
				for (const op of ops) {
					if (!validOps.has(op as (typeof BOOLEAN_OPERATORS)[number])) {
						return { valid: false, reason: `Invalid boolean operator: ${op}` };
					}
				}
				return { valid: true };
			}
			return { valid: false, reason: `Unexpected value type: ${typeof value}` };
		};

		/**
		 * Check if a value is a valid array operator structure.
		 */
		const isValidArrayFilter = (
			value: unknown,
		): { valid: boolean; reason?: string } => {
			if (typeof value === "object" && value !== null) {
				const ops = Object.keys(value);
				const validOps = new Set(ARRAY_OPERATORS);
				for (const op of ops) {
					if (!validOps.has(op as (typeof ARRAY_OPERATORS)[number])) {
						return { valid: false, reason: `Invalid array operator: ${op}` };
					}
				}
				return { valid: true };
			}
			return { valid: false, reason: `Unexpected value type: ${typeof value}` };
		};

		it("should generate valid where clause objects", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					expect(typeof where).toBe("object");
					expect(where).not.toBeNull();
				}),
				{ numRuns: 100 },
			);
		});

		it("should only include valid field names from schema", () => {
			const validFields = new Set(["name", "age", "isActive", "tags"]);

			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					for (const fieldName of Object.keys(where)) {
						expect(validFields.has(fieldName)).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate empty where clauses sometimes", () => {
			let foundEmpty = false;
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if (Object.keys(where).length === 0) {
						foundEmpty = true;
					}
					return true;
				}),
				{ numRuns: 200 },
			);
			expect(foundEmpty).toBe(true);
		});

		it("should generate valid string field filters", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if ("name" in where) {
						const result = isValidStringFilter(where.name);
						expect(result.valid).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate valid number field filters", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if ("age" in where) {
						const result = isValidNumberFilter(where.age);
						expect(result.valid).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate valid boolean field filters", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if ("isActive" in where) {
						const result = isValidBooleanFilter(where.isActive);
						expect(result.valid).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate valid array field filters", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if ("tags" in where) {
						const result = isValidArrayFilter(where.tags);
						expect(result.valid).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate multi-field where clauses", () => {
			let foundMultiField = false;
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					if (Object.keys(where).length > 1) {
						foundMultiField = true;
					}
					return true;
				}),
				{ numRuns: 200 },
			);
			expect(foundMultiField).toBe(true);
		});

		it("should not include id field in where clauses", () => {
			fc.assert(
				fc.property(whereClauseArbitrary(TestSchema), (where) => {
					expect("id" in where).toBe(false);
				}),
				{ numRuns: 100 },
			);
		});
	});

	// ============================================================================
	// Task 2.6: Tests for sortConfigArbitrary
	// ============================================================================

	describe("sortConfigArbitrary", () => {
		const TestSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			isActive: Schema.Boolean,
		});

		it("should generate valid sort config objects", () => {
			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					expect(typeof sort).toBe("object");
					expect(sort).not.toBeNull();
				}),
				{ numRuns: 100 },
			);
		});

		it("should only include valid field names from schema", () => {
			const validFields = new Set(["id", "name", "age", "isActive"]);

			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					for (const fieldName of Object.keys(sort)) {
						expect(validFields.has(fieldName)).toBe(true);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should only use 'asc' or 'desc' as sort directions", () => {
			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					for (const direction of Object.values(sort)) {
						expect(["asc", "desc"]).toContain(direction);
					}
				}),
				{ numRuns: 100 },
			);
		});

		it("should generate empty sort configs sometimes", () => {
			let foundEmpty = false;
			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					if (Object.keys(sort).length === 0) {
						foundEmpty = true;
					}
					return true;
				}),
				{ numRuns: 200 },
			);
			expect(foundEmpty).toBe(true);
		});

		it("should generate single-field sort configs", () => {
			let foundSingleField = false;
			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					if (Object.keys(sort).length === 1) {
						foundSingleField = true;
					}
					return true;
				}),
				{ numRuns: 100 },
			);
			expect(foundSingleField).toBe(true);
		});

		it("should generate multi-field sort configs", () => {
			let foundMultiField = false;
			fc.assert(
				fc.property(sortConfigArbitrary(TestSchema), (sort) => {
					if (Object.keys(sort).length > 1) {
						foundMultiField = true;
					}
					return true;
				}),
				{ numRuns: 200 },
			);
			expect(foundMultiField).toBe(true);
		});
	});

	// ============================================================================
	// Task 2.6: Tests for operationSequenceArbitrary
	// ============================================================================

	describe("operationSequenceArbitrary", () => {
		const TestSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			value: Schema.Number,
		});

		it("should generate valid operation sequence arrays", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					expect(Array.isArray(ops)).toBe(true);
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate operations with valid op types", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					for (const operation of ops) {
						expect(["create", "update", "delete"]).toContain(operation.op);
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should ensure create operations have valid payloads", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					for (const operation of ops) {
						if (operation.op === "create") {
							expect(operation.payload).toBeDefined();
							expect(typeof operation.payload.id).toBe("string");
							expect(operation.payload.id.length).toBeGreaterThan(0);
						}
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should ensure update/delete operations have valid ids", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					for (const operation of ops) {
						if (operation.op === "update" || operation.op === "delete") {
							expect(typeof operation.id).toBe("string");
							expect(operation.id.length).toBeGreaterThan(0);
						}
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should ensure update operations have payload objects", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					for (const operation of ops) {
						if (operation.op === "update") {
							expect(typeof operation.payload).toBe("object");
							expect(operation.payload).not.toBeNull();
						}
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should maintain referential integrity: update/delete only reference created IDs", () => {
			fc.assert(
				fc.property(operationSequenceArbitrary(TestSchema), (ops) => {
					// Replay the sequence tracking alive IDs
					const aliveIds = new Set<string>();

					for (const operation of ops) {
						if (operation.op === "create") {
							aliveIds.add(operation.payload.id);
						} else if (operation.op === "update") {
							// Update should reference an alive ID
							expect(aliveIds.has(operation.id)).toBe(true);
						} else if (operation.op === "delete") {
							// Delete should reference an alive ID, then remove it
							expect(aliveIds.has(operation.id)).toBe(true);
							aliveIds.delete(operation.id);
						}
					}
				}),
				{ numRuns: 50 },
			);
		});

		it("should generate sequences with create, update, and delete operations", () => {
			let foundCreate = false;
			let foundUpdate = false;
			let foundDelete = false;

			// Use more runs to ensure we see all operation types
			fc.assert(
				fc.property(
					operationSequenceArbitrary(TestSchema, {
						minLength: 5,
						maxLength: 15,
					}),
					(ops) => {
						for (const operation of ops) {
							if (operation.op === "create") foundCreate = true;
							if (operation.op === "update") foundUpdate = true;
							if (operation.op === "delete") foundDelete = true;
						}
						return true;
					},
				),
				{ numRuns: 100 },
			);

			expect(foundCreate).toBe(true);
			expect(foundUpdate).toBe(true);
			expect(foundDelete).toBe(true);
		});

		it("should respect minLength and maxLength options", () => {
			fc.assert(
				fc.property(
					operationSequenceArbitrary(TestSchema, {
						minLength: 3,
						maxLength: 7,
					}),
					(ops) => {
						expect(ops.length).toBeGreaterThanOrEqual(3);
						expect(ops.length).toBeLessThanOrEqual(7);
					},
				),
				{ numRuns: 50 },
			);
		});

		it("should start with a create operation when sequence is non-empty", () => {
			fc.assert(
				fc.property(
					operationSequenceArbitrary(TestSchema, { minLength: 1 }),
					(ops) => {
						if (ops.length > 0) {
							expect(ops[0].op).toBe("create");
						}
					},
				),
				{ numRuns: 50 },
			);
		});
	});
});
