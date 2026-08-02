import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DuplicateKeyError,
	FormatCodec,
	OperationError,
	StorageAdapterService as StorageAdapter,
	StorageError,
	TransactionError,
	ValidationError,
	jsonCodec,
	makeInMemoryStorageLayer,
	makeSerializerLayer,
} from "@proseql/core";
import { Cause, Data, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { unsafeSubscriptionEffectToStreamForTests, unsafeLiftPromiseForTests } from "../src/database.js";
import { createEffectDatabase, createPersistentEffectDatabase } from "../src/index.js";
import { repoRootFromImportMetaUrl } from "../src/repo-root.js";
import { WasmEngineDefectError } from "@proseql/engine";

const root = repoRootFromImportMetaUrl(import.meta.url);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: root,
		stdio: "inherit"
	});
}, 60_000);

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String)
});

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String)
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String)
});

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies", foreignKey: "companyId" }
		}
	},
	companies: {
		schema: CompanySchema,
		relationships: {}
	},
	books: {
		schema: BookSchema,
		relationships: {}
	}
} as const;

class TestBusinessError extends Data.TaggedError("TestBusinessError")<{
	readonly message: string;
}> {}

describe("@proseql/effect", () => {
	it("derives the repo root from import.meta.url even when cwd changes", async () => {
		const originalCwd = process.cwd();
		const tempCwd = await mkdtemp(join(tmpdir(), "proseql-effect-root-"));
		try {
			process.chdir(tempCwd);
			expect(repoRootFromImportMetaUrl(import.meta.url)).toBe(root);
		} finally {
			process.chdir(originalCwd);
			await rm(tempCwd, { recursive: true, force: true });
		}
	});

	it("acquires watch subscriptions lazily and unsubscribes on scope close without consumption", async () => {
		let activeSubscriptions = 0;
		let unsubscribeCalls = 0;
		const watch = unsafeSubscriptionEffectToStreamForTests<number>(() => {
			activeSubscriptions += 1;
			let closed = false;
			let resolveNext: ((value: IteratorResult<number>) => void) | undefined;
			return {
				[Symbol.asyncIterator]() {
					return this;
				},
				next: async () => {
					if (closed) return { value: undefined, done: true } as const;
					return await new Promise<IteratorResult<number>>((resolve) => {
						resolveNext = resolve;
					});
				},
				unsubscribe: async () => {
					if (!closed) {
						closed = true;
						activeSubscriptions -= 1;
						unsubscribeCalls += 1;
						resolveNext?.({ value: undefined, done: true });
					}
				}
			};
		});

		expect(activeSubscriptions).toBe(0);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const stream = yield* watch;
					expect(activeSubscriptions).toBe(1);
					void stream;
				})
			)
		);
		expect(activeSubscriptions).toBe(0);
		expect(unsubscribeCalls).toBe(1);
	});

	it("unsubscribes watchById subscriptions when interrupted after acquisition and before consumption", async () => {
		let activeSubscriptions = 0;
		let unsubscribeCalls = 0;
		const watchById = unsafeSubscriptionEffectToStreamForTests<string | null>(() => {
			activeSubscriptions += 1;
			let closed = false;
			let resolveNext: ((value: IteratorResult<string | null>) => void) | undefined;
			return {
				[Symbol.asyncIterator]() {
					return this;
				},
				next: async () => {
					if (closed) return { value: undefined, done: true } as const;
					return await new Promise<IteratorResult<string | null>>((resolve) => {
						resolveNext = resolve;
					});
				},
				unsubscribe: async () => {
					if (!closed) {
						closed = true;
						activeSubscriptions -= 1;
						unsubscribeCalls += 1;
						resolveNext?.({ value: undefined, done: true });
					}
				}
			};
		});

		expect(activeSubscriptions).toBe(0);
		await Effect.runPromiseExit(
			Effect.scoped(
				Effect.gen(function* () {
					yield* watchById;
					expect(activeSubscriptions).toBe(1);
					return yield* Effect.interrupt;
				})
			)
		);
		expect(activeSubscriptions).toBe(0);
		expect(unsubscribeCalls).toBe(1);
	});

	it("trusts initial data during bootstrap but still validates normal writes", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [{ id: "u1", name: "Alice", age: "thirty", companyId: "c1" } as any],
				companies: [{ id: "c1", name: "Acme" }],
				books: []
			})
		);
		expect(await db.users.findById("u1").runPromise).toEqual({
			id: "u1",
			name: "Alice",
			age: "thirty",
			companyId: "c1"
		});
		const failure = await Effect.runPromise(
			db.users.create({ id: "u2", name: "Bob", age: "forty", companyId: "c1" } as any).pipe(Effect.flip)
		);
		expect(failure).toBeInstanceOf(ValidationError);
	});

	it("preserves non-integer initialData numbers across the WASM boundary", async () => {
		const OrderSchema = Schema.Struct({
			id: Schema.String,
			total: Schema.Number,
		});
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					orders: {
						schema: OrderSchema,
						relationships: {},
					},
				} as const,
				{
					orders: [{ id: "o1", total: 1326.6499999999999 }],
				},
			),
		);

		const order = await db.orders.findById("o1").runPromise;
		expect(JSON.stringify(order.total)).toBe("1326.6499999999999");
	});

	it("round-trips boundary float sentinels, nested arrays, and escaped __proseqlFloat64__ objects through write/query/reload", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "proseql-effect-boundary-"));
		const file = join(tmp, "records.json");
		const BoundarySchema = Schema.Struct({
			id: Schema.String,
			negativeZero: Schema.Number,
			unsafeInteger: Schema.Number,
			nestedNumbers: Schema.Array(Schema.Array(Schema.Number)),
			escapedFloat64Object: Schema.Struct({
				__proseqlFloat64__: Schema.String,
				label: Schema.String,
			}),
		});
		const record = {
			id: "r1",
			negativeZero: -0,
			unsafeInteger: 9007199254740992,
			nestedNumbers: [[-0, 1.5], [1326.6499999999999]],
			escapedFloat64Object: {
				__proseqlFloat64__: "user-payload",
				label: "escaped",
			},
		} as const;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							{
								records: {
									schema: BoundarySchema,
									file,
									relationships: {},
								},
							} as const,
							{ records: [] },
							{ writeDebounce: 5 },
						);
						yield* db.records.create(record);
						const queried = yield* db.records.findById(record.id);
						expect(Object.is(queried.negativeZero, -0)).toBe(true);
						expect(queried.unsafeInteger).toBe(9007199254740992);
						expect(Object.is(queried.nestedNumbers[0]?.[0], -0)).toBe(true);
						expect(queried.escapedFloat64Object).toEqual(record.escapedFloat64Object);
						yield* Effect.tryPromise(() => db.flush());
					}),
				),
			);
			const reopened = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							{
								records: {
									schema: BoundarySchema,
									file,
									relationships: {},
								},
							} as const,
							undefined,
							{ writeDebounce: 5 },
						);
						return yield* db.records.findById(record.id);
					}),
				),
			);
			// JSON persistence intentionally follows JSON.stringify semantics, which
			// normalize negative zero even though the in-memory WASM boundary does not.
			expect(Object.is(reopened.negativeZero, 0)).toBe(true);
			expect(Object.is(reopened.nestedNumbers[0]?.[0], 0)).toBe(true);
			expect(reopened.unsafeInteger).toBe(9007199254740992);
			expect(reopened.nestedNumbers[1]).toEqual(record.nestedNumbers[1]);
			expect(reopened.escapedFloat64Object).toEqual(record.escapedFloat64Object);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("preserves declared multi-field sort precedence across the WASM boundary", async () => {
		const SortUserSchema = Schema.Struct({
			id: Schema.String,
			role: Schema.String,
			age: Schema.Number,
		});
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					users: {
						schema: SortUserSchema,
						relationships: {},
					},
				} as const,
				{
					users: [
						{ id: "u1", role: "user", age: 80 },
						{ id: "u2", role: "admin", age: 79 },
						{ id: "u3", role: "admin", age: 80 },
					],
				},
			),
		);

		const rows = await db.users.query({
			sort: { role: "asc", age: "desc", id: "asc" },
		}).runPromise;
		expect(rows.map((row) => row.id)).toEqual(["u3", "u2", "u1"]);
	});

	it("preserves indexed $in candidate order through the database query path", async () => {
		const IndexedUserSchema = Schema.Struct({
			id: Schema.String,
			role: Schema.String,
			age: Schema.Number,
			name: Schema.String,
		});
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					users: {
						schema: IndexedUserSchema,
						indexes: ["role", "age"],
						relationships: {},
					},
				} as const,
				{
					users: [
						{ id: "moderator", role: "moderator", age: 55, name: "Yara" },
						{ id: "admin", role: "admin", age: 55, name: "Yara" },
					],
				},
			),
		);

		const rows = await db.users.query({
			where: { role: { $in: ["admin", "moderator"] } },
			sort: { age: "desc", name: "asc" },
		}).runPromise;
		expect(rows.map((row) => row.id)).toEqual(["admin", "moderator"]);
	});

	it("supports Effect.gen/yield* and catchTag on reconstructed DuplicateKeyError", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, {
					users: [],
					companies: [{ id: "c1", name: "Acme" }],
					books: []
				});

				yield* db.users.create({ id: "u1", name: "Alice", age: 30, companyId: "c1" });
				return yield* db.users.create({ id: "u1", name: "Again", age: 31, companyId: "c1" }).pipe(
					Effect.catchTag("DuplicateKeyError", (error) => Effect.succeed(`${error._tag}:${error.existingId}`))
				);
			})
		);

		expect(result).toBe("DuplicateKeyError:u1");
	});

	it("exposes query as stream and watch as scoped stream with debounce semantics", async () => {
		const emissions = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, {
						users: [],
						companies: [],
						books: [
							{ id: "b1", title: "Dune", year: 1965, genre: "sci-fi" },
							{ id: "b2", title: "The Hobbit", year: 1937, genre: "fantasy" }
						]
					});

					const initial = yield* Stream.runCollect(db.books.query({ sort: { year: "asc" } }));
					expect(initial.map((book) => book.id)).toEqual(["b2", "b1"]);

					const stream = yield* db.books.watch({ sort: { year: "asc" }, debounceMs: 20 });
					const fiber = yield* Stream.take(stream, 2).pipe(Stream.runCollect, Effect.forkChild);

					yield* db.books.update("b1", { year: 1966 });
					yield* db.books.update("b1", { year: 1967 });

					return yield* Fiber.join(fiber);
				})
			)
		);

		expect(emissions).toHaveLength(2);
		expect(emissions[0]?.[1]?.year).toBe(1965);
		expect(emissions[1]?.[1]?.year).toBe(1967);
	});

	it("collapses scalar predicate bulk mutations to one Rust bulk command outside and inside transactions", async () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `b${index}`,
			title: `Book ${index}`,
			year: 2000 + index,
			genre: index % 2 === 0 ? "even" : "odd",
		}));
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [],
				companies: [],
				books: rows,
			}),
		);
		const diagnostics = () =>
			(
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => {
						queryDispatches: number;
						bulkMutationDispatches: number;
					};
				}
			).__proseqlMaterializationDiagnostics();

		const updateCalls: Array<{
			readonly id: string;
			readonly argumentCount: number;
			readonly receiver: unknown;
		}> = [];
		const beforeUpdate = { ...diagnostics() };
		const updated = await db.books.updateMany(
			function (book) {
				updateCalls.push({
					id: book.id,
					argumentCount: arguments.length,
					receiver: this,
				});
				return book.genre === "even";
			},
			{ genre: "updated" },
		).runPromise;
		const afterUpdate = diagnostics();

		expect(updateCalls).toEqual(
			rows.map((book) => ({
				id: book.id,
				argumentCount: 1,
				receiver: undefined,
			})),
		);
		expect(updated.updated.map((book) => book.id)).toEqual([
			"b0",
			"b2",
			"b4",
			"b6",
			"b8",
			"b10",
		]);
		expect(afterUpdate.queryDispatches - beforeUpdate.queryDispatches).toBe(1);
		expect(
			afterUpdate.bulkMutationDispatches - beforeUpdate.bulkMutationDispatches,
		).toBe(1);

		let zeroMatchCalls = 0;
		const beforeZero = { ...diagnostics() };
		const zero = await db.books.updateMany(
			() => {
				zeroMatchCalls += 1;
				return false;
			},
			{ genre: "unused" },
		).runPromise;
		const afterZero = diagnostics();
		expect(zero).toEqual({ count: 0, updated: [] });
		expect(zeroMatchCalls).toBe(rows.length);
		expect(afterZero.queryDispatches - beforeZero.queryDispatches).toBe(1);
		expect(
			afterZero.bulkMutationDispatches - beforeZero.bulkMutationDispatches,
		).toBe(1);

		const deleteCalls: string[] = [];
		const beforeDelete = { ...diagnostics() };
		const deleted = await Effect.runPromise(
			db.$transaction((tx) =>
				tx.books.deleteMany(
					(book) => {
						deleteCalls.push(book.id);
						return book.genre === "odd";
					},
					{ limit: 3 },
				),
			),
		);
		const afterDelete = diagnostics();
		expect(deleteCalls).toEqual(rows.map((book) => book.id));
		expect(deleted.deleted.map((book) => book.id)).toEqual(["b1", "b3", "b5"]);
		expect(afterDelete.queryDispatches - beforeDelete.queryDispatches).toBe(1);
		expect(
			afterDelete.bulkMutationDispatches - beforeDelete.bulkMutationDispatches,
		).toBe(1);
	});

	it("preserves scalar deleteMany limit coercion after predicate selection", async () => {
		const cases = [
			{ limit: -1, expected: ["b0", "b1", "b2", "b3", "b4"] },
			{ limit: 0, expected: ["b0", "b1", "b2", "b3", "b4"] },
			{ limit: 2.8, expected: ["b0", "b1"] },
			{ limit: 3, expected: ["b0", "b1", "b2"] },
		] as const;

		for (const [caseIndex, testCase] of cases.entries()) {
			const rows = Array.from({ length: 5 }, (_, index) => ({
				id: `b${index}`,
				title: `Book ${index}`,
				year: 2000 + index,
				genre: "original",
			}));
			const db = await Effect.runPromise(
				createEffectDatabase(config, {
					users: [],
					companies: [],
					books: rows,
				}),
			);
			const calls: string[] = [];
			const remove = (book: (typeof rows)[number]) => {
				calls.push(book.id);
				return true;
			};
			const deleted =
				caseIndex % 2 === 0
					? await db.books.deleteMany(remove, {
							limit: testCase.limit,
						}).runPromise
					: await Effect.runPromise(
							db.$transaction((tx) =>
								tx.books.deleteMany(remove, {
									limit: testCase.limit,
								}),
							),
						);

			expect(calls).toEqual(rows.map((row) => row.id));
			expect(deleted.deleted.map((row) => row.id)).toEqual(testCase.expected);
			await db.close();
		}
	});

	it("keeps predicate-captured rows live, identical, and dirty-synchronized", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [],
				companies: [],
				books: [
					{ id: "b1", title: "One", year: 2001, genre: "original" },
					{ id: "b2", title: "Two", year: 2002, genre: "original" },
				],
			}),
		);
		let captured:
			| { id: string; title: string; year: number; genre: string }
			| undefined;

		await db.books.updateMany(
			(book) => {
				if (book.id === "b1") captured = book;
				return book.id === "b2";
			},
			{ genre: "updated" },
		).runPromise;

		expect(captured).toBeDefined();
		expect(await db.books.findById("b1").runPromise).toBe(captured);
		if (captured === undefined) throw new Error("expected captured row");
		captured.genre = "caller-mutated";
		expect((await db.books.findById("b1").runPromise)?.genre).toBe(
			"caller-mutated",
		);
		expect(await db.books.findById("b1").runPromise).toBe(captured);
		await db.close();
	});

	it("performs zero writes when a scalar bulk predicate throws midway", async () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `b${index}`,
			title: `Book ${index}`,
			year: 2000 + index,
			genre: "original",
		}));
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [],
				companies: [],
				books: rows,
			}),
		);
		const diagnostics = () =>
			(
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => {
						bulkMutationDispatches: number;
					};
				}
			).__proseqlMaterializationDiagnostics();
		const before = { ...diagnostics() };
		const predicateError = new Error("predicate stopped");

		const exit = await Effect.runPromiseExit(
			db.books.updateMany(
				(book) => {
					if (book.id === "b3") throw predicateError;
					return true;
				},
				{ genre: "changed" },
			),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			const reason = exit.cause.reasons[0];
			expect(reason === undefined ? false : Cause.isDieReason(reason)).toBe(
				true,
			);
			if (reason !== undefined && Cause.isDieReason(reason)) {
				expect(reason.defect).toBe(predicateError);
			}
		}
		expect(
			diagnostics().bulkMutationDispatches - before.bulkMutationDispatches,
		).toBe(0);

		const transactionPredicateError = new Error(
			"transaction predicate stopped",
		);
		const transactionExit = await Effect.runPromiseExit(
			db.$transaction((tx) =>
				tx.books.deleteMany((book) => {
					if (book.id === "b2") throw transactionPredicateError;
					return true;
				}),
			),
		);
		expect(transactionExit._tag).toBe("Failure");
		if (transactionExit._tag === "Failure") {
			const reason = transactionExit.cause.reasons[0];
			expect(reason === undefined ? false : Cause.isDieReason(reason)).toBe(
				true,
			);
			if (reason !== undefined && Cause.isDieReason(reason)) {
				expect(reason.defect).toBe(transactionPredicateError);
			}
		}
		expect(
			diagnostics().bulkMutationDispatches - before.bulkMutationDispatches,
		).toBe(0);
		expect(
			(await db.books.query({ sort: { id: "asc" } }).runPromise).map(
				(book) => book.genre,
			),
		).toEqual(rows.map((book) => book.genre));
	});

	it("interrupts an active transaction by rolling back and releasing queued operations", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
				companies: [{ id: "c1", name: "Acme" }],
				books: [],
			}),
		);
		let started!: () => void;
		const active = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fiber = Effect.runFork(
			db.$transaction((tx) =>
				Effect.gen(function* () {
					yield* tx.users.create({
						id: "u2",
						name: "Bob",
						age: 31,
						companyId: "c1",
					});
					yield* Effect.sync(started);
					yield* Effect.never;
				}),
			),
		);
		await active;
		await Effect.runPromise(Fiber.interrupt(fiber));
		await expect(db.users.findById("u2").runPromise).rejects.toMatchObject({
			_tag: "NotFoundError",
		});
		await db.close();
	});

	it("supplies the full TransactionContext surface with manual commit/rollback, inactive guards, and mutation tracking", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, {
					users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
					companies: [{ id: "c1", name: "Acme" }],
					books: []
				});

				const commitSummary = yield* db.$transaction((tx) =>
					Effect.gen(function* () {
						expect(typeof tx.commit).toBe("function");
						expect(typeof tx.rollback).toBe("function");
						expect(tx.isActive).toBe(true);
						expect([...tx.mutatedCollections]).toEqual([]);

						yield* tx.users.create({ id: "u2", name: "Bob", age: 25, companyId: "c1" });
						yield* tx.books.create({ id: "b1", title: "Dune", year: 1965, genre: "sci-fi" });
						expect([...tx.mutatedCollections]).toEqual(["users", "books"]);

						const streamConstructedWhileActive = tx.users.query({
							sort: { id: "asc" },
						});
						const cursorConstructedWhileActive = tx.users.query({
							cursor: { key: "id", limit: 1 },
							sort: { id: "asc" },
						});
						yield* tx.commit();
						expect(tx.isActive).toBe(false);
						expect([...tx.mutatedCollections]).toEqual(["users", "books"]);

						const inactiveCreate = yield* tx.users
							.create({ id: "u3", name: "Cara", age: 22, companyId: "c1" })
							.pipe(Effect.flip);
						expect(inactiveCreate).toBeInstanceOf(TransactionError);
						if (inactiveCreate instanceof TransactionError) {
							expect(inactiveCreate.reason).toBe("transaction is no longer active");
						}

						const inactiveStreamQuery = yield* Stream.runCollect(
							streamConstructedWhileActive,
						).pipe(Effect.flip);
						expect(inactiveStreamQuery).toMatchObject({
							_tag: "TransactionError",
							operation: "begin",
							reason: "transaction is no longer active",
							message: "Cannot perform operation: transaction is no longer active",
						});
						const inactiveCursorQuery = yield* cursorConstructedWhileActive.pipe(
							Effect.flip,
						);
						expect(inactiveCursorQuery).toMatchObject({
							_tag: "TransactionError",
							operation: "begin",
							reason: "transaction is no longer active",
						});
						const inactiveFind = yield* tx.users.findById("u1").pipe(Effect.flip);
						expect(inactiveFind).toMatchObject({
							_tag: "TransactionError",
							reason: "transaction is no longer active",
						});
						const inactiveAggregate = yield* tx.users
							.aggregate({ count: true })
							.pipe(Effect.flip);
						expect(inactiveAggregate).toMatchObject({
							_tag: "TransactionError",
							reason: "transaction is no longer active",
						});

						const secondCommit = yield* tx.commit().pipe(Effect.flip);
						expect(secondCommit).toBeInstanceOf(TransactionError);
						if (secondCommit instanceof TransactionError) {
							expect(secondCommit.operation).toBe("commit");
							expect(secondCommit.reason).toBe("transaction is no longer active");
						}

						const rollbackAfterCommit = yield* tx.rollback().pipe(Effect.flip);
						expect(rollbackAfterCommit).toBeInstanceOf(TransactionError);
						if (rollbackAfterCommit instanceof TransactionError) {
							expect(rollbackAfterCommit.operation).toBe("rollback");
							expect(rollbackAfterCommit.reason).toBe("transaction is no longer active");
						}

						return { isActive: tx.isActive, mutated: [...tx.mutatedCollections] };
					})
				);

				const rollbackFailure = yield* db.$transaction((tx) =>
					Effect.gen(function* () {
						expect(tx.isActive).toBe(true);
						yield* tx.users.create({ id: "u4", name: "Dana", age: 33, companyId: "c1" });
						expect([...tx.mutatedCollections]).toEqual(["users"]);
						const streamConstructedWhileActive = tx.users.query();
						const cursorConstructedWhileActive = tx.users.query({
							cursor: { key: "id", limit: 1 },
						});
						const explicitRollback = yield* tx.rollback().pipe(Effect.flip);
						const inactiveStreamQuery = yield* Stream.runCollect(
							streamConstructedWhileActive,
						).pipe(Effect.flip);
						expect(inactiveStreamQuery).toMatchObject({
							_tag: "TransactionError",
							operation: "begin",
							reason: "transaction is no longer active",
						});
						const inactiveCursorQuery = yield* cursorConstructedWhileActive.pipe(
							Effect.flip,
						);
						expect(inactiveCursorQuery).toMatchObject({
							_tag: "TransactionError",
							operation: "begin",
							reason: "transaction is no longer active",
						});
						return yield* Effect.fail(explicitRollback);
					})
				).pipe(Effect.flip);

				const users = yield* Stream.runCollect(db.users.query({ sort: { id: "asc" } }));
				const books = yield* Stream.runCollect(db.books.query({ sort: { id: "asc" } }));
				return { commitSummary, rollbackFailure, users, books };
			})
		);

		expect(result.commitSummary).toEqual({ isActive: false, mutated: ["users", "books"] });
		expect(result.rollbackFailure).toBeInstanceOf(TransactionError);
		if (result.rollbackFailure instanceof TransactionError) {
			expect(result.rollbackFailure.operation).toBe("rollback");
			expect(result.rollbackFailure.reason).toBe("transaction rolled back");
		}
		expect(result.users.map((user) => user.id)).toEqual(["u1", "u2"]);
		expect(result.books.map((book) => book.id)).toEqual(["b1"]);
	});

	it("keeps populated transaction targets canonical through the Effect adapter", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(config, {
				users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
				companies: [{ id: "c1", name: "Before" }],
				books: [],
			}),
		);
		await Effect.runPromise(
			db.$transaction((tx) =>
				Effect.gen(function* () {
					const rows = Array.from(
						yield* Stream.runCollect(
							tx.users.query({ populate: { company: true } } as never),
						),
					);
					const company = (rows[0] as unknown as { company: { name: string } })
						.company;
					const direct = yield* tx.companies.findById("c1");
					expect(company).toBe(direct);
					company.name = "Committed";
				}),
			),
		);
		expect(
			(await Effect.runPromise(db.companies.findById("c1"))).name,
		).toBe("Committed");
	});

	it("preserves arbitrary callback errors through $transaction and rolls back", async () => {
		const customTagged = { _tag: "CustomTransactionFailure", detail: "rollback-tag" } as const;
		const program = Effect.gen(function* () {
			const db = yield* createEffectDatabase(config, {
				users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
				companies: [{ id: "c1", name: "Acme" }],
				books: []
			});

			const typedFailure = yield* db.$transaction((tx) =>
				Effect.gen(function* () {
					yield* tx.users.create({ id: "u2", name: "Bob", age: 25, companyId: "c1" });
					return yield* Effect.fail(new TestBusinessError({ message: "rollback" }));
				})
			).pipe(Effect.flip);

			const stringRecovered = yield* db.$transaction((tx) =>
				Effect.gen(function* () {
					yield* tx.users.create({ id: "u3", name: "Cara", age: 20, companyId: "c1" });
					return yield* Effect.fail("rollback-string");
				})
			).pipe(
				Effect.catchIf((error): error is string => typeof error === "string", (error) =>
					Effect.succeed(`caught:${error}`)
				)
			);

			const taggedRecovered = yield* db.$transaction((tx) =>
				Effect.gen(function* () {
					yield* tx.users.create({ id: "u4", name: "Dana", age: 27, companyId: "c1" });
					return yield* Effect.fail(customTagged);
				})
			).pipe(
				Effect.catchTag("CustomTransactionFailure", (error) =>
					Effect.succeed(`caught-tag:${error.detail}`)
				)
			);

			const users = yield* Stream.runCollect(db.users.query({ sort: { id: "asc" } }));
			return { typedFailure, stringRecovered, taggedRecovered, users };
		});

		const result = await Effect.runPromise(program);
		expect(result.typedFailure._tag).toBe("TestBusinessError");
		expect(result.stringRecovered).toBe("caught:rollback-string");
		expect(result.taggedRecovered).toBe("caught-tag:rollback-tag");
		expect(result.users.map((user) => user.id)).toEqual(["u1"]);
	});

	it("turns unexpected WasmEngineDefectError into an Effect defect, not a typed failure", async () => {
		const effect = unsafeLiftPromiseForTests(() => Promise.reject(new WasmEngineDefectError("boom")));
		await expect(
			Effect.runPromise(
				effect.pipe(Effect.catch(() => Effect.succeed("typed-recovery")))
			)
		).rejects.toBeInstanceOf(WasmEngineDefectError);
	});

	it("honors the provided SerializerRegistry service for persistent custom codecs", async () => {
		const file = "/virtual/users.cjson";
		const store = new Map<string, string>([
			[
				file,
				`CJSON:${JSON.stringify({ u1: { id: "u1", name: "Alice", age: 30 } })}`,
			],
		]);
		const customCodec: FormatCodec = {
			name: "custom-json",
			extensions: ["cjson"],
			encode: (data) => `CJSON:${JSON.stringify(data)}`,
			decode: (raw) => JSON.parse(raw.slice("CJSON:".length)),
		};
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([customCodec])
		);
		const PersistentUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String)
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(
						{
							users: {
								schema: PersistentUserSchema,
								file,
								relationships: {}
							}
						} as const,
						undefined,
						{ writeDebounce: 5 }
					);
					const existing = yield* db.users.findById("u1");
					expect(existing).toEqual({ id: "u1", name: "Alice", age: 30 });
					yield* db.users.create({ id: "u2", name: "Bob", age: 25 } as any);
					yield* Effect.tryPromise(() => db.flush());
				})
			).pipe(Effect.provide(layer))
		);
		const persisted = store.get(file);
		expect(persisted?.startsWith("CJSON:")).toBe(true);
		expect(JSON.parse(persisted!.slice("CJSON:".length))).toEqual({
			u1: { id: "u1", name: "Alice", age: 30 },
			u2: expect.objectContaining({ id: "u2", name: "Bob", age: 25 })
		});
	});

	it("surfaces computed watch callback defects through Stream.runPromise", async () => {
		const trace: string[] = [];
		const computedConfig = {
			users: {
				schema: UserSchema,
				relationships: {},
				computed: {
					marker: (user: { readonly id: string }) => {
						trace.push(user.id);
						if (user.id === "u2") throw new Error("effect-watch-u2");
						return user.id;
					},
				},
			},
		} as const;

		await expect(
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createEffectDatabase(computedConfig, {
							users: [
								{ id: "u1", name: "one", age: 1, companyId: "c1" },
								{ id: "u2", name: "two", age: 2, companyId: "c1" },
							],
						});
						const stream = yield* db.users.watch({ debounceMs: 0 });
						return yield* Stream.runHead(stream);
					}),
				),
			),
		).rejects.toMatchObject({
			name: "WasmEngineDefectError",
			message: "unexpected defect: computedCallback: effect-watch-u2",
		});
		expect(trace).toEqual(["u1", "u2"]);
	});

	it("closes scoped persistent databases exactly once, stopping storage watchers and dropping engine handles", async () => {
		const file = "/virtual/users.json";
		const store = new Map<string, string>([[file, "{}"]]);
		let fileWatchCalls = 0;
		let fileWatchStops = 0;
		let dirWatchCalls = 0;
		let dirWatchStops = 0;
		let initializeCount = 0;
		let shutdownCount = 0;
		let leakedDb: any;
		const adapter = {
			read: (path: string) =>
				Effect.suspend(() => {
					const value = store.get(path);
					return value === undefined
						? Effect.fail(
								new StorageError({
									path,
									operation: "read",
									message: `File not found: ${path}`,
								}),
							)
						: Effect.succeed(value);
				}),
			write: (path: string, data: string) =>
				Effect.sync(() => {
					store.set(path, data);
				}),
			append: (path: string, data: string) =>
				Effect.sync(() => {
					store.set(path, `${store.get(path) ?? ""}${data}`);
				}),
			exists: (path: string) => Effect.sync(() => store.has(path)),
			remove: (path: string) =>
				Effect.sync(() => {
					store.delete(path);
				}),
			ensureDir: () => Effect.void,
			watch: (_path: string, _onChange: () => void) =>
				Effect.sync(() => {
					fileWatchCalls += 1;
					let stopped = false;
					return () => {
						if (!stopped) {
							stopped = true;
							fileWatchStops += 1;
						}
					};
				}),
			listDirectory: () => Effect.succeed([] as ReadonlyArray<string>),
			listRecursive: () => Effect.succeed([] as ReadonlyArray<string>),
			watchDir: (_path: string, _onChange: (event: { readonly filename: string | null; readonly type: "add" | "change" | "remove" }) => void) =>
				Effect.sync(() => {
					dirWatchCalls += 1;
					let stopped = false;
					return () => {
						if (!stopped) {
							stopped = true;
							dirWatchStops += 1;
						}
					};
				}),
		};
		const layer = Layer.merge(Layer.succeed(StorageAdapter, adapter), makeSerializerLayer([jsonCodec()]));
		const plugin = {
			name: "scope-close-plugin",
			initialize: () =>
				Effect.sync(() => {
					initializeCount += 1;
				}),
			shutdown: () =>
				Effect.sync(() => {
					shutdownCount += 1;
				}),
		} as const;

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(
						{
							users: {
								schema: Schema.Struct({
									id: Schema.String,
									name: Schema.String,
									age: Schema.Number,
									createdAt: Schema.optional(Schema.String),
									updatedAt: Schema.optional(Schema.String),
								}),
								file,
								relationships: {},
							},
						} as const,
						undefined,
						{ writeDebounce: 5 },
						{ plugins: [plugin] }
					);
					leakedDb = db;
					yield* db.users.create({ id: "u1", name: "Alice", age: 30 } as any);
					expect(fileWatchCalls + dirWatchCalls).toBeGreaterThan(0);
				}),
			).pipe(Effect.provide(layer)),
		);

		expect(initializeCount).toBe(1);
		expect(shutdownCount).toBe(1);
		expect(fileWatchStops + dirWatchStops).toBe(fileWatchCalls + dirWatchCalls);

		const closable = leakedDb as typeof leakedDb & { close: () => Promise<void> };
		await expect(closable.close()).resolves.toBeUndefined();
		expect(shutdownCount).toBe(1);
		expect(fileWatchStops + dirWatchStops).toBe(fileWatchCalls + dirWatchCalls);
		await expect(Effect.runPromise(leakedDb!.users.findById("u1"))).rejects.toBeInstanceOf(OperationError);
		await expect(Effect.runPromise(leakedDb!.users.findById("u1"))).rejects.toMatchObject({ reason: "unknown-handle" });
	});

	it("defaults persistent root imports to the real Node storage host", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "proseql-effect-node-default-"));
		const file = join(tmp, "users.json");
		const PersistentUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String)
		});
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							{
								users: {
									schema: PersistentUserSchema,
									file,
									relationships: {}
								}
							} as const,
							{ users: [] },
							{ writeDebounce: 5 }
						);
						yield* db.users.create({ id: "u1", name: "Alice", age: 30 } as any);
						yield* Effect.tryPromise(() => db.flush());
					})
				)
			);
			expect(existsSync(file)).toBe(true);
			expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
				u1: expect.objectContaining({ id: "u1", name: "Alice", age: 30 }),
			});
			const reopened = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							{
								users: {
									schema: PersistentUserSchema,
									file,
									relationships: {}
								}
							} as const,
							undefined,
							{ writeDebounce: 5 }
						);
						return yield* Stream.runCollect(db.users.query({ sort: { id: "asc" } }));
					})
				)
			);
			expect([...reopened]).toEqual([
				expect.objectContaining({ id: "u1", name: "Alice", age: 30 }),
			]);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("supports persistence flush, dry-run, and close over provided core storage services", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "proseql-effect-"));
		const file = join(tmp, "users.json");
		const layer = Layer.merge(
			makeInMemoryStorageLayer(new Map()),
			makeSerializerLayer([jsonCodec()])
		);
		const PersistentUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String)
		});
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							{
								users: {
									schema: PersistentUserSchema,
									file,
									relationships: {}
								}
							} as const,
							{ users: [] },
							{ writeDebounce: 5 }
						);
						yield* db.users.create({ id: "u1", name: "Alice", age: 30 } as any);
						yield* Effect.tryPromise(() => db.flush());
						const report = yield* db.$dryRunMigrations();
						expect(Array.isArray(report.collections)).toBe(true);
						expect(typeof (db as typeof db & { close: () => Promise<void> }).close).toBe("function");
					})
				).pipe(Effect.provide(layer))
			);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});
