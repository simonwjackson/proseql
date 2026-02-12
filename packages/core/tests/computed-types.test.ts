import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type {
	GenerateDatabase,
	ObjectSelectConfig,
	QueryReturnType,
	SelectConfig,
	SortConfig,
	WhereClause,
} from "../src/types/types";

/**
 * Task 1.4: Verify that WhereClause, SortConfig, ObjectSelectConfig, and QueryReturnType
 * automatically pick up computed field keys through the widened T.
 *
 * These tests verify at compile time that computed fields are available in query types.
 */

// Type assertion helpers for compile-time type checking
type Assert<T extends true> = T;
type IsAssignable<T, U> = T extends U ? true : false;

// Test schema
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	authorId: Schema.String,
});

type Book = Schema.Schema.Type<typeof BookSchema>;

// Database config with computed fields
const dbConfigWithComputed = {
	books: {
		schema: BookSchema,
		relationships: {},
		computed: {
			displayName: (book: Book) => `${book.title} (${book.year})`,
			isClassic: (book: Book) => book.year < 1980,
			decade: (book: Book) => Math.floor(book.year / 10) * 10,
		},
	},
} as const;

// Generate the database type with computed fields
type DBWithComputed = GenerateDatabase<typeof dbConfigWithComputed>;

// Extract the entity type from the collection (includes computed fields)
type BookWithComputed = DBWithComputed["books"] extends {
	query<C>(config?: C): infer R;
}
	? R extends { runPromise: Promise<ReadonlyArray<infer T>> }
		? T
		: never
	: never;

// Verify the entity type includes computed fields
type _checkEntityHasDisplayName = Assert<
	IsAssignable<BookWithComputed, { displayName: string }>
>;
type _checkEntityHasIsClassic = Assert<
	IsAssignable<BookWithComputed, { isClassic: boolean }>
>;
type _checkEntityHasDecade = Assert<
	IsAssignable<BookWithComputed, { decade: number }>
>;

// Verify the entity type still has original fields
type _checkEntityHasTitle = Assert<
	IsAssignable<BookWithComputed, { title: string }>
>;
type _checkEntityHasYear = Assert<
	IsAssignable<BookWithComputed, { year: number }>
>;

describe("Computed Field Types Integration", () => {
	describe("WhereClause with computed fields", () => {
		it("should accept computed string field in where clause", () => {
			// WhereClause should accept displayName (computed string field)
			const whereDisplayName: WhereClause<
				BookWithComputed,
				Record<string, never>,
				Record<string, never>
			> = {
				displayName: { $contains: "1984" },
			};

			// Direct equality should also work
			const whereDisplayNameExact: WhereClause<
				BookWithComputed,
				Record<string, never>,
				Record<string, never>
			> = {
				displayName: "Dune (1965)",
			};

			expect(whereDisplayName).toBeDefined();
			expect(whereDisplayNameExact).toBeDefined();
		});

		it("should accept computed boolean field in where clause", () => {
			// WhereClause should accept isClassic (computed boolean field)
			const whereIsClassic: WhereClause<BookWithComputed, Record<string, never>, Record<string, never>> = {
				isClassic: true,
			};

			const whereIsClassicOp: WhereClause<BookWithComputed, Record<string, never>, Record<string, never>> = {
				isClassic: { $eq: true },
			};

			expect(whereIsClassic).toBeDefined();
			expect(whereIsClassicOp).toBeDefined();
		});

		it("should accept computed numeric field in where clause", () => {
			// WhereClause should accept decade (computed numeric field)
			const whereDecade: WhereClause<BookWithComputed, Record<string, never>, Record<string, never>> = {
				decade: { $gte: 1960, $lt: 1990 },
			};

			const whereDecadeIn: WhereClause<BookWithComputed, Record<string, never>, Record<string, never>> = {
				decade: { $in: [1960, 1970, 1980] },
			};

			expect(whereDecade).toBeDefined();
			expect(whereDecadeIn).toBeDefined();
		});

		it("should accept mixed stored and computed fields in where clause", () => {
			const whereMixed: WhereClause<BookWithComputed, Record<string, never>, Record<string, never>> = {
				title: { $contains: "Dune" },
				isClassic: true,
				decade: { $gte: 1960 },
			};

			expect(whereMixed).toBeDefined();
		});
	});

	describe("SortConfig with computed fields", () => {
		it("should accept computed string field in sort config", () => {
			const sortByDisplayName: SortConfig<BookWithComputed, Record<string, never>, Record<string, never>, Record<string, never>> = {
				displayName: "asc",
			};

			expect(sortByDisplayName).toBeDefined();
		});

		it("should accept computed boolean field in sort config", () => {
			const sortByIsClassic: SortConfig<BookWithComputed, Record<string, never>, Record<string, never>, Record<string, never>> = {
				isClassic: "desc",
			};

			expect(sortByIsClassic).toBeDefined();
		});

		it("should accept computed numeric field in sort config", () => {
			const sortByDecade: SortConfig<BookWithComputed, Record<string, never>, Record<string, never>, Record<string, never>> = {
				decade: "asc",
			};

			expect(sortByDecade).toBeDefined();
		});

		it("should accept mixed stored and computed fields in sort config", () => {
			const sortMixed: SortConfig<BookWithComputed, Record<string, never>, Record<string, never>, Record<string, never>> = {
				isClassic: "desc",
				year: "asc",
			};

			expect(sortMixed).toBeDefined();
		});
	});

	describe("ObjectSelectConfig with computed fields", () => {
		it("should accept computed fields in object select config", () => {
			const selectDisplayName: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				displayName: true,
			};

			const selectIsClassic: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				isClassic: true,
			};

			const selectDecade: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				decade: true,
			};

			expect(selectDisplayName).toBeDefined();
			expect(selectIsClassic).toBeDefined();
			expect(selectDecade).toBeDefined();
		});

		it("should accept mixed stored and computed fields in select config", () => {
			const selectMixed: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				title: true,
				displayName: true,
				isClassic: true,
			};

			expect(selectMixed).toBeDefined();
		});

		it("should accept only stored fields in select config", () => {
			const selectStoredOnly: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				id: true,
				title: true,
				year: true,
			};

			expect(selectStoredOnly).toBeDefined();
		});

		it("should accept only computed fields in select config", () => {
			const selectComputedOnly: ObjectSelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = {
				displayName: true,
				isClassic: true,
				decade: true,
			};

			expect(selectComputedOnly).toBeDefined();
		});
	});

	describe("SelectConfig union type with computed fields", () => {
		it("should accept array-based selection with computed fields", () => {
			// Array-based select with computed fields
			const arraySelect: SelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = [
				"displayName",
				"isClassic",
			] as const;

			expect(arraySelect).toBeDefined();
		});

		it("should accept mixed array-based selection", () => {
			const arraySelectMixed: SelectConfig<BookWithComputed, Record<string, never>, Record<string, never>> = [
				"title",
				"displayName",
				"isClassic",
			] as const;

			expect(arraySelectMixed).toBeDefined();
		});
	});

	describe("QueryReturnType with computed fields", () => {
		it("should include computed fields in result type by default", () => {
			// Plain query without select should return entity with computed fields
			type PlainResult = QueryReturnType<BookWithComputed, Record<string, never>, Record<string, never>, Record<string, never>>;

			// Verify result includes computed fields
			type _check1 = Assert<
				IsAssignable<
					PlainResult,
					{
						runPromise: Promise<
							ReadonlyArray<{
								displayName: string;
								isClassic: boolean;
								decade: number;
							}>
						>;
					}
				>
			>;

			expect(true).toBe(true);
		});

		it("should apply select config to computed fields correctly", () => {
			// Query with select should narrow the result type
			type SelectResult = QueryReturnType<
				BookWithComputed,
				Record<string, never>,
				{ select: { title: true; displayName: true } },
				Record<string, never>
			>;

			// Verify result has only selected fields
			type _check = Assert<
				IsAssignable<
					SelectResult,
					{
						runPromise: Promise<
							ReadonlyArray<{ title: string; displayName: string }>
						>;
					}
				>
			>;

			expect(true).toBe(true);
		});
	});

	describe("Database without computed fields (regression check)", () => {
		const dbConfigWithoutComputed = {
			books: {
				schema: BookSchema,
				relationships: {},
			},
		} as const;

		type DBWithoutComputed = GenerateDatabase<typeof dbConfigWithoutComputed>;

		it("should still work correctly without computed config", () => {
			// Extract entity type from collection without computed fields
			type BookWithoutComputed = DBWithoutComputed["books"] extends {
				query<C>(config?: C): infer R;
			}
				? R extends { runPromise: Promise<ReadonlyArray<infer T>> }
					? T
					: never
				: never;

			// Verify entity has stored fields
			type _checkHasTitle = Assert<
				IsAssignable<BookWithoutComputed, { title: string }>
			>;
			type _checkHasYear = Assert<
				IsAssignable<BookWithoutComputed, { year: number }>
			>;

			// WhereClause should work with stored fields
			const whereTitle: WhereClause<
				BookWithoutComputed,
				Record<string, never>,
				Record<string, never>
			> = {
				title: { $contains: "Dune" },
			};

			expect(whereTitle).toBeDefined();
		});
	});
});
