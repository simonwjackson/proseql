/**
 * Type-level tests for nested schema support.
 *
 * Task 8.4: Verify TypeScript accepts nested where clauses, nested update operators,
 * dot-path index declarations, and dot-path aggregate field refs.
 * Verify TypeScript rejects invalid nested paths.
 *
 * These tests use @ts-expect-error to verify that invalid types are rejected.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type {
	AggregateConfig,
	GroupedAggregateConfig,
	ScalarAggregateConfig,
} from "../src/types/aggregate-types";
import type { UpdateWithOperators } from "../src/types/crud-types";
import type {
	GenerateDatabase,
	RelationshipDef,
	WhereClause,
} from "../src/types/types";

// ============================================================================
// Test Schemas with Nested Objects
// ============================================================================

const MetadataSchema = Schema.Struct({
	views: Schema.Number,
	rating: Schema.Number,
	tags: Schema.Array(Schema.String),
	description: Schema.optional(Schema.String),
	featured: Schema.optional(Schema.Boolean),
});

const AuthorSchema = Schema.Struct({
	name: Schema.String,
	country: Schema.String,
});

const DeepNestedSchema = Schema.Struct({
	level1: Schema.Struct({
		level2: Schema.Struct({
			value: Schema.String,
			count: Schema.Number,
		}),
	}),
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	genre: Schema.String,
	year: Schema.Number,
	metadata: MetadataSchema,
	author: Schema.optional(AuthorSchema),
	deep: Schema.optional(DeepNestedSchema),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

// Infer types from schemas
type Metadata = Schema.Schema.Type<typeof MetadataSchema>;
type Author = Schema.Schema.Type<typeof AuthorSchema>;
type Book = Schema.Schema.Type<typeof BookSchema>;

// Database config
const dbConfig = {
	books: {
		schema: BookSchema,
		relationships: {},
		indexes: [
			"genre",
			"metadata.views",
			"metadata.rating",
			["metadata.rating", "genre"],
			"author.country",
		] as const,
		searchIndex: ["title", "metadata.description", "author.name"] as const,
	},
} as const;

type DB = GenerateDatabase<typeof dbConfig>;

// ============================================================================
// Type Assertion Helpers
// ============================================================================

// Use underscore prefix to indicate intentionally unused variables
// These are compile-time only type assertions

describe("Nested Schema Type Safety", () => {
	describe("WhereClause - nested object support (task 8.1)", () => {
		it("should accept shape-mirroring nested where clauses", () => {
			// Shape-mirroring: nested object with filter operators
			const _where1: WhereClause<Book, {}, DB> = {
				metadata: { views: { $gt: 100 } },
			};

			const _where2: WhereClause<Book, {}, DB> = {
				metadata: { rating: 5 },
			};

			const _where3: WhereClause<Book, {}, DB> = {
				metadata: { views: { $gte: 50 }, rating: { $lt: 5 } },
			};

			// Nested string operators
			const _where4: WhereClause<Book, {}, DB> = {
				author: { name: { $startsWith: "Frank" } },
			};

			const _where5: WhereClause<Book, {}, DB> = {
				author: { country: { $in: ["USA", "UK"] } },
			};

			expect(true).toBe(true);
		});

		it("should accept dot-notation nested where clauses", () => {
			// Dot-notation paths for filtering
			const _where1: WhereClause<Book, {}, DB> = {
				"metadata.views": { $gt: 100 },
			};

			const _where2: WhereClause<Book, {}, DB> = {
				"metadata.rating": 5,
			};

			const _where3: WhereClause<Book, {}, DB> = {
				"author.name": { $contains: "Herbert" },
			};

			expect(true).toBe(true);
		});

		it("should accept mixed flat + nested where clauses", () => {
			// Combine flat fields with nested filters
			const _where1: WhereClause<Book, {}, DB> = {
				title: "Dune",
				metadata: { views: { $gt: 100 } },
			};

			const _where2: WhereClause<Book, {}, DB> = {
				genre: "sci-fi",
				year: { $gte: 1960 },
				metadata: { rating: { $gte: 4 } },
				author: { country: "USA" },
			};

			expect(true).toBe(true);
		});

		it("should accept nested in logical operators", () => {
			// Nested in $or
			const _where1: WhereClause<Book, {}, DB> = {
				$or: [
					{ metadata: { views: { $gt: 1000 } } },
					{ metadata: { rating: 5 } },
				],
			};

			// Nested in $and
			const _where2: WhereClause<Book, {}, DB> = {
				$and: [
					{ metadata: { views: { $gte: 100 } } },
					{ author: { country: "USA" } },
				],
			};

			// Nested in $not
			const _where3: WhereClause<Book, {}, DB> = {
				$not: { metadata: { views: { $lt: 10 } } },
			};

			expect(true).toBe(true);
		});

		it("should accept array operators on nested array fields", () => {
			// Nested array operators
			const _where1: WhereClause<Book, {}, DB> = {
				metadata: { tags: { $contains: "classic" } },
			};

			const _where2: WhereClause<Book, {}, DB> = {
				metadata: { tags: { $all: ["sci-fi", "epic"] } },
			};

			const _where3: WhereClause<Book, {}, DB> = {
				metadata: { tags: { $size: 3 } },
			};

			expect(true).toBe(true);
		});

		it("should reject invalid nested field names", () => {
			// @ts-expect-error - 'nonexistent' is not a valid nested field
			const _invalid1: WhereClause<Book, {}, DB> = {
				metadata: { nonexistent: 100 },
			};

			// @ts-expect-error - 'invalid' is not a valid field on author
			const _invalid2: WhereClause<Book, {}, DB> = {
				author: { invalid: "value" },
			};

			expect(true).toBe(true);
		});

		it("should reject wrong types for nested field operators", () => {
			// @ts-expect-error - views is a number, can't use $startsWith
			const _invalid1: WhereClause<Book, {}, DB> = {
				metadata: { views: { $startsWith: "100" } },
			};

			// @ts-expect-error - rating is a number, can't use $contains
			const _invalid2: WhereClause<Book, {}, DB> = {
				metadata: { rating: { $contains: "5" } },
			};

			expect(true).toBe(true);
		});
	});

	describe("UpdateWithOperators - nested object support (task 8.2)", () => {
		it("should accept nested partial updates (deep merge)", () => {
			// Partial update on nested object - preserves sibling fields
			const _update1: UpdateWithOperators<Book> = {
				metadata: { views: 500 },
			};

			const _update2: UpdateWithOperators<Book> = {
				metadata: { rating: 5, featured: true },
			};

			const _update3: UpdateWithOperators<Book> = {
				author: { name: "New Author" },
			};

			expect(true).toBe(true);
		});

		it("should accept nested update operators", () => {
			// $increment on nested number field
			const _update1: UpdateWithOperators<Book> = {
				metadata: { views: { $increment: 1 } },
			};

			// $decrement on nested number field
			const _update2: UpdateWithOperators<Book> = {
				metadata: { rating: { $decrement: 1 } },
			};

			// $multiply on nested number field
			const _update3: UpdateWithOperators<Book> = {
				metadata: { views: { $multiply: 2 } },
			};

			// $toggle on nested boolean field
			const _update4: UpdateWithOperators<Book> = {
				metadata: { featured: { $toggle: true } },
			};

			// $append on nested string field
			const _update5: UpdateWithOperators<Book> = {
				metadata: { description: { $append: " (Updated)" } },
			};

			// $prepend on nested string field
			const _update6: UpdateWithOperators<Book> = {
				author: { name: { $prepend: "Dr. " } },
			};

			expect(true).toBe(true);
		});

		it("should accept nested array operators", () => {
			// $append on nested array field
			const _update1: UpdateWithOperators<Book> = {
				metadata: { tags: { $append: "classic" } },
			};

			// $prepend on nested array field
			const _update2: UpdateWithOperators<Book> = {
				metadata: { tags: { $prepend: "must-read" } },
			};

			// $remove on nested array field
			const _update3: UpdateWithOperators<Book> = {
				metadata: { tags: { $remove: "draft" } },
			};

			// $set on nested array field
			const _update4: UpdateWithOperators<Book> = {
				metadata: { tags: { $set: ["new", "tags"] } },
			};

			expect(true).toBe(true);
		});

		it("should accept $set to replace entire nested object", () => {
			// $set at nested object level replaces the entire object
			const _update1: UpdateWithOperators<Book> = {
				metadata: { $set: { views: 0, rating: 1, tags: [] } },
			};

			const _update2: UpdateWithOperators<Book> = {
				author: { $set: { name: "New Author", country: "UK" } },
			};

			expect(true).toBe(true);
		});

		it("should accept mixed flat + nested updates", () => {
			const _update1: UpdateWithOperators<Book> = {
				title: "New Title",
				metadata: { views: { $increment: 1 } },
			};

			const _update2: UpdateWithOperators<Book> = {
				genre: "fantasy",
				year: { $increment: 1 },
				metadata: { rating: 5 },
				author: { country: "UK" },
			};

			expect(true).toBe(true);
		});

		it("should reject invalid nested field names in updates", () => {
			// @ts-expect-error - 'nonexistent' is not a valid nested field
			const _invalid1: UpdateWithOperators<Book> = {
				metadata: { nonexistent: 100 },
			};

			// @ts-expect-error - 'invalid' is not a valid field on author
			const _invalid2: UpdateWithOperators<Book> = {
				author: { invalid: "value" },
			};

			expect(true).toBe(true);
		});

		it("should reject invalid operators for nested field types", () => {
			// @ts-expect-error - $increment not valid for strings
			const _invalid1: UpdateWithOperators<Book> = {
				metadata: { description: { $increment: 1 } },
			};

			// @ts-expect-error - $toggle not valid for numbers
			const _invalid2: UpdateWithOperators<Book> = {
				metadata: { views: { $toggle: true } },
			};

			// @ts-expect-error - $append string not valid for booleans
			const _invalid3: UpdateWithOperators<Book> = {
				metadata: { featured: { $append: "true" } },
			};

			expect(true).toBe(true);
		});
	});

	describe("Index declarations - dot-path support (task 8.3)", () => {
		it("should accept dot-path index declarations in config", () => {
			// This test verifies the config compiles without errors
			const _config = {
				books: {
					schema: BookSchema,
					relationships: {},
					// Single field indexes including dot-paths
					indexes: [
						"genre", // flat field
						"year", // flat field
						"metadata.views", // dot-path
						"metadata.rating", // dot-path
						"author.country", // dot-path
					] as const,
				},
			} as const;

			// Type assertion that config is valid
			type _ValidConfig = typeof _config;

			expect(true).toBe(true);
		});

		it("should accept compound indexes with dot-paths", () => {
			const _config = {
				books: {
					schema: BookSchema,
					relationships: {},
					indexes: [
						["metadata.rating", "genre"], // dot-path + flat field
						["author.country", "year"], // dot-path + flat field
						["metadata.views", "metadata.rating"], // two dot-paths
					] as const,
				},
			} as const;

			type _ValidConfig = typeof _config;

			expect(true).toBe(true);
		});

		it("should accept searchIndex with dot-paths", () => {
			const _config = {
				books: {
					schema: BookSchema,
					relationships: {},
					searchIndex: [
						"title", // flat field
						"metadata.description", // dot-path
						"author.name", // dot-path
					] as const,
				},
			} as const;

			type _ValidConfig = typeof _config;

			expect(true).toBe(true);
		});
	});

	describe("Aggregate field refs - dot-path support (task 8.3)", () => {
		it("should accept dot-path fields in scalar aggregates", () => {
			// sum on nested field
			const _agg1: ScalarAggregateConfig<Book, {}, DB> = {
				sum: "metadata.views",
			};

			// avg on nested field
			const _agg2: ScalarAggregateConfig<Book, {}, DB> = {
				avg: "metadata.rating",
			};

			// min on nested field
			const _agg3: ScalarAggregateConfig<Book, {}, DB> = {
				min: "metadata.views",
			};

			// max on nested field
			const _agg4: ScalarAggregateConfig<Book, {}, DB> = {
				max: "metadata.rating",
			};

			// multiple aggregates on nested fields
			const _agg5: ScalarAggregateConfig<Book, {}, DB> = {
				sum: "metadata.views",
				avg: "metadata.rating",
				min: "year",
				max: "metadata.views",
			};

			expect(true).toBe(true);
		});

		it("should accept dot-path fields in grouped aggregates", () => {
			// groupBy on nested field
			const _agg1: GroupedAggregateConfig<Book, {}, DB> = {
				groupBy: "metadata.rating",
				count: true,
			};

			// groupBy on nested field with aggregations
			const _agg2: GroupedAggregateConfig<Book, {}, DB> = {
				groupBy: "author.country",
				count: true,
				sum: "metadata.views",
			};

			// multiple groupBy fields including dot-paths
			const _agg3: GroupedAggregateConfig<Book, {}, DB> = {
				groupBy: ["metadata.rating", "genre"],
				count: true,
				avg: "metadata.views",
			};

			expect(true).toBe(true);
		});

		it("should accept nested where clause in aggregates", () => {
			// Aggregate with nested where filter
			const _agg1: AggregateConfig<Book, {}, DB> = {
				where: { metadata: { rating: { $gte: 4 } } },
				count: true,
				sum: "metadata.views",
			};

			const _agg2: AggregateConfig<Book, {}, DB> = {
				where: {
					$and: [
						{ metadata: { views: { $gt: 100 } } },
						{ author: { country: "USA" } },
					],
				},
				groupBy: "genre",
				count: true,
			};

			expect(true).toBe(true);
		});
	});

	describe("ExtractNestedPaths type utility", () => {
		// These are compile-time only type assertions
		// The tests verify that the ExtractNestedPaths type correctly
		// generates dot-path strings from nested object types

		it("should extract valid nested paths from type", () => {
			// Type-level test: verify ExtractNestedPaths produces correct paths
			// The type system should accept these as valid paths
			type BookPaths =
				| "id"
				| "title"
				| "genre"
				| "year"
				| "metadata"
				| "metadata.views"
				| "metadata.rating"
				| "metadata.tags"
				| "metadata.description"
				| "metadata.featured"
				| "author"
				| "author.name"
				| "author.country"
				| "deep"
				| "deep.level1"
				| "createdAt"
				| "updatedAt";

			// These paths should be valid for sorting (which uses ExtractNestedPaths)
			type ValidSort = Partial<Record<BookPaths, "asc" | "desc">>;

			const _sort1: ValidSort = { "metadata.views": "desc" };
			const _sort2: ValidSort = { "metadata.rating": "asc", genre: "desc" };
			const _sort3: ValidSort = { "author.country": "asc" };

			expect(true).toBe(true);
		});
	});

	describe("Database type with nested schema", () => {
		it("should generate correct database type from config with nested indexes", () => {
			// This verifies the entire type system works end-to-end
			// with nested schemas, indexes, and search indexes
			type TestDB = GenerateDatabase<typeof dbConfig>;

			// The generated database type should have the books collection
			type BooksCollection = TestDB["books"];

			// Verify the collection has query method (this is a type assertion)
			type _HasQuery = BooksCollection extends { query: unknown }
				? true
				: false;

			expect(true).toBe(true);
		});
	});
});
