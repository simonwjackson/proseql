/**
 * Property-based tests for transaction atomicity.
 *
 * Task 8.1: Create this test file
 * Task 8.2: Property - snapshot state before transaction, execute arbitrary operations,
 *           force failure, verify all states match pre-transaction snapshot
 * Task 8.3: Property - a transaction that completes without failure applies all mutations
 *
 * These tests verify that transactions maintain atomicity: either all operations
 * are applied (commit) or none are (rollback). Partial state is never observable.
 */
import { Chunk, Effect, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import {
	entityArbitrary,
	getNumRuns,
	operationSequenceArbitrary,
	type CrudOperation,
} from "./generators";

/**
 * Test schema for transaction atomicity tests.
 * Uses a simple schema to focus on transaction semantics.
 */
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	rating: Schema.Number,
	isPublished: Schema.Boolean,
	tags: Schema.Array(Schema.String),
});

type Book = Schema.Schema.Type<typeof BookSchema>;

/**
 * Database config for transaction atomicity tests.
 */
const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

/**
 * Custom error for simulating transaction failures at arbitrary points.
 */
class SimulatedFailureError extends Error {
	readonly _tag = "SimulatedFailureError";
	constructor(message: string) {
		super(message);
		this.name = "SimulatedFailureError";
	}
}

/**
 * Snapshot the state of a collection as a sorted array of entities.
 * Sorting ensures consistent comparison across snapshots.
 */
const snapshotCollection = (entities: readonly Book[]): readonly Book[] => {
	return [...entities].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Deep equal comparison for two snapshots.
 */
const snapshotsEqual = (
	a: readonly Book[],
	b: readonly Book[],
): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
			return false;
		}
	}
	return true;
};

describe("Transaction atomicity properties", () => {
	describe("Task 8.1: Test file structure", () => {
		it("should have access to the required imports and generators", () => {
			// Verify entityArbitrary generates valid entities
			fc.assert(
				fc.property(entityArbitrary(BookSchema), (book) => {
					expect(typeof book.id).toBe("string");
					expect(typeof book.title).toBe("string");
					expect(typeof book.author).toBe("string");
					expect(typeof book.year).toBe("number");
					expect(typeof book.rating).toBe("number");
					expect(typeof book.isPublished).toBe("boolean");
					expect(Array.isArray(book.tags)).toBe(true);
				}),
				{ numRuns: 10 },
			);
		});

		it("should be able to create a database and use transactions", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, { books: [] });

				// Basic transaction that succeeds
				const result = yield* db.$transaction((ctx) =>
					Effect.gen(function* () {
						const book = yield* ctx.books.create({
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							rating: 4.5,
							isPublished: true,
							tags: ["sci-fi"],
						});
						return book;
					}),
				);

				expect(result.title).toBe("Dune");

				// Verify entity persisted after commit
				const found = yield* db.books.findById(result.id);
				expect(found.title).toBe("Dune");
			});

			await Effect.runPromise(program);
		});

		it("should be able to create a database and rollback transactions", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, { books: [] });

				// Transaction that fails and rolls back
				const result = yield* db
					.$transaction((ctx) =>
						Effect.gen(function* () {
							yield* ctx.books.create({
								title: "Dune",
								author: "Frank Herbert",
								year: 1965,
								rating: 4.5,
								isPublished: true,
								tags: ["sci-fi"],
							});

							// Simulate failure
							return yield* Effect.fail(
								new SimulatedFailureError("Test failure"),
							);
						}),
					)
					.pipe(Effect.either);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left).toBeInstanceOf(SimulatedFailureError);
				}

				// Verify collection is empty after rollback
				const allBooksChunk = yield* Stream.runCollect(db.books.query({}));
				const allBooks = Chunk.toReadonlyArray(allBooksChunk);
				expect(allBooks).toHaveLength(0);
			});

			await Effect.runPromise(program);
		});

		it("should have access to operationSequenceArbitrary", () => {
			// Verify operationSequenceArbitrary generates valid sequences
			fc.assert(
				fc.property(
					operationSequenceArbitrary(BookSchema, {
						minLength: 1,
						maxLength: 5,
					}),
					(ops) => {
						expect(Array.isArray(ops)).toBe(true);
						expect(ops.length).toBeGreaterThanOrEqual(1);
						expect(ops.length).toBeLessThanOrEqual(5);

						// Every operation should have valid structure
						for (const op of ops) {
							expect(["create", "update", "delete"]).toContain(op.op);
							if (op.op === "create") {
								expect(typeof op.payload).toBe("object");
								expect(typeof op.payload.id).toBe("string");
							} else if (op.op === "update") {
								expect(typeof op.id).toBe("string");
								expect(typeof op.payload).toBe("object");
							} else if (op.op === "delete") {
								expect(typeof op.id).toBe("string");
							}
						}
					},
				),
				{ numRuns: 20 },
			);
		});
	});

	// Tasks 8.2 and 8.3 will be implemented in subsequent tasks
});
