import { Schema, type Stream } from "effect";
import { describe, expect, it } from "vitest";
import type {
	GenerateDatabase,
	PopulateConfig,
	QueryConfig,
	QueryReturnType,
	RelationshipDef,
	SelectConfig,
	SortConfig,
	WhereClause,
} from "../src/types/types";

// ============================================================================
// Test schemas using Effect Schema (not Zod)
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
});

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	industry: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
});

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	tags: Schema.Array(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
});

// Infer types from Effect Schemas
type User = Schema.Schema.Type<typeof UserSchema>;
type Company = Schema.Schema.Type<typeof CompanySchema>;
type Post = Schema.Schema.Type<typeof PostSchema>;

// Database config using Effect Schema
const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" },
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" },
		},
	},
} as const;

// Type-level database
type DB = GenerateDatabase<typeof dbConfig>;

// Helper: assert type compatibility at compile time
type Assert<T extends true> = T;
type IsAssignable<T, U> = T extends U ? true : false;

describe("QueryConfig types with Effect Schema entities", () => {
	describe("WhereClause", () => {
		it("should accept filter operators on Schema-inferred entity fields", () => {
			// String field filters
			const nameFilter: WhereClause<User, {}, {}> = {
				name: { $eq: "Alice" },
			};

			// Number field filters
			const ageFilter: WhereClause<User, {}, {}> = {
				age: { $gt: 18, $lt: 65 },
			};

			// Direct value matching
			const directFilter: WhereClause<User, {}, {}> = {
				email: "alice@example.com",
			};

			// String-specific operators
			const stringOps: WhereClause<User, {}, {}> = {
				name: { $startsWith: "A", $contains: "lic" },
			};

			expect(nameFilter).toBeDefined();
			expect(ageFilter).toBeDefined();
			expect(directFilter).toBeDefined();
			expect(stringOps).toBeDefined();
		});

		it("should accept $in/$nin operators for Schema-inferred types", () => {
			const inFilter: WhereClause<User, {}, {}> = {
				name: { $in: ["Alice", "Bob"] },
			};

			const ninFilter: WhereClause<User, {}, {}> = {
				age: { $nin: [18, 21] },
			};

			expect(inFilter).toBeDefined();
			expect(ninFilter).toBeDefined();
		});

		it("should support $or, $and, $not logical operators", () => {
			const logicalFilter: WhereClause<User, {}, {}> = {
				$or: [{ name: { $eq: "Alice" } }, { age: { $gt: 30 } }],
			};

			const andFilter: WhereClause<User, {}, {}> = {
				$and: [{ age: { $gte: 18 } }, { age: { $lte: 65 } }],
			};

			const notFilter: WhereClause<User, {}, {}> = {
				$not: { name: { $eq: "Admin" } },
			};

			expect(logicalFilter).toBeDefined();
			expect(andFilter).toBeDefined();
			expect(notFilter).toBeDefined();
		});

		it("should support array field operators for Schema.Array fields", () => {
			const arrayFilter: WhereClause<Post, {}, {}> = {
				tags: { $contains: "typescript" },
			};

			const allFilter: WhereClause<Post, {}, {}> = {
				tags: { $all: ["typescript", "effect"] },
			};

			const sizeFilter: WhereClause<Post, {}, {}> = {
				tags: { $size: 3 },
			};

			expect(arrayFilter).toBeDefined();
			expect(allFilter).toBeDefined();
			expect(sizeFilter).toBeDefined();
		});
	});

	describe("PopulateConfig", () => {
		it("should accept relationship names for population", () => {
			type UserRelations = {
				company: RelationshipDef<Company, "ref", "companies">;
				posts: RelationshipDef<Post, "inverse", "posts">;
			};

			const populateCompany: PopulateConfig<UserRelations, DB> = {
				company: true,
			};

			const populatePosts: PopulateConfig<UserRelations, DB> = {
				posts: true,
			};

			const populateBoth: PopulateConfig<UserRelations, DB> = {
				company: true,
				posts: true,
			};

			expect(populateCompany).toBeDefined();
			expect(populatePosts).toBeDefined();
			expect(populateBoth).toBeDefined();
		});
	});

	describe("SelectConfig", () => {
		it("should support object-based selection on Schema-inferred fields", () => {
			const objectSelect: SelectConfig<User, {}, {}> = {
				name: true,
				email: true,
			};

			expect(objectSelect).toBeDefined();
		});

		it("should support array-based selection on Schema-inferred fields", () => {
			const arraySelect: SelectConfig<User, {}, {}> = [
				"name",
				"email",
			] as const;

			expect(arraySelect).toBeDefined();
		});
	});

	describe("SortConfig", () => {
		it("should accept entity field names with sort order", () => {
			const sortConfig: SortConfig<User, {}, {}, {}> = {
				name: "asc",
				age: "desc",
			};

			expect(sortConfig).toBeDefined();
		});
	});

	describe("QueryConfig", () => {
		it("should compose where, sort, select, limit, offset for non-populated queries", () => {
			const config: QueryConfig<User, {}, {}> = {
				where: { age: { $gt: 18 } },
				sort: { name: "asc" },
				select: { name: true, email: true },
				limit: 10,
				offset: 0,
			};

			expect(config).toBeDefined();
		});

		it("should accept populate alongside where and sort", () => {
			type UserRelations = {
				company: RelationshipDef<Company, "ref", "companies">;
			};

			const config: QueryConfig<User, UserRelations, DB> = {
				populate: { company: true },
				where: { age: { $gte: 21 } },
				select: { name: true, email: true },
			};

			expect(config).toBeDefined();
		});
	});

	describe("QueryReturnType", () => {
		it("should return RunnableStream (Stream with .runPromise)", () => {
			// A plain query config returns RunnableStream<User, DanglingReferenceError>
			type PlainResult = QueryReturnType<User, {}, {}, {}>;

			// Verify it extends Stream.Stream (RunnableStream extends Stream.Stream)
			type _check1 = Assert<
				IsAssignable<PlainResult, Stream.Stream<User, unknown>>
			>;

			// Verify it has runPromise
			type _check2 = Assert<
				IsAssignable<PlainResult, { runPromise: Promise<ReadonlyArray<User>> }>
			>;

			expect(true).toBe(true);
		});

		it("should return correct element type for select queries", () => {
			type SelectResult = QueryReturnType<
				User,
				{},
				{ select: { name: true; email: true } },
				{}
			>;

			// The result should be a Stream of objects with name and email
			type _check = Assert<
				IsAssignable<
					SelectResult,
					Stream.Stream<{ name: string; email: string }, unknown>
				>
			>;

			expect(true).toBe(true);
		});
	});
});
