import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DuplicateKeyError,
	HookError,
	createPersistentEffectDatabase,
	inferCodecsFromConfig,
	makeSerializerLayer,
} from "@proseql/core";
import { createNodeDatabase } from "@proseql/node";
import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createEngineDatabase,
	createNodeEngineStorageHost,
	createPersistentEngineDatabase,
	makeNodeEngineStorageLayer,
} from "../src/index.js";

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	role: Schema.String,
	age: Schema.Number,
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	authorId: Schema.String,
});

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const BoundaryUndefinedShapeSchema = Schema.Struct({
	__proseqlUndefined__: Schema.Number,
});

const BoundaryEscapedShapeSchema = Schema.Struct({
	__proseqlEscaped__: Schema.String,
});

const BoundaryRecordSchema = Schema.Struct({
	id: Schema.String,
	sentinel: BoundaryUndefinedShapeSchema,
	escaped: BoundaryEscapedShapeSchema,
	nested: Schema.Struct({
		sentinel: BoundaryUndefinedShapeSchema,
		escaped: BoundaryEscapedShapeSchema,
	}),
	sentinelArray: Schema.Array(BoundaryUndefinedShapeSchema),
	escapedArray: Schema.Array(BoundaryEscapedShapeSchema),
	optional: Schema.optional(Schema.String),
});

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 60_000);

describe("@proseql/engine", () => {
	it("round-trips a quickstart flow and matches active TS file bytes for json + yaml", async () => {
		const engineDir = await mkdtemp(join(tmpdir(), "proseql-engine-wasm-"));
		const referenceDir = await mkdtemp(join(tmpdir(), "proseql-engine-ref-"));
		try {
			const engineConfig = {
				authors: {
					schema: AuthorSchema,
					file: join(engineDir, "authors.yaml"),
					relationships: {},
				},
				books: {
					schema: BookSchema,
					file: join(engineDir, "books.json"),
					relationships: {
						author: { type: "ref" as const, target: "authors", foreignKey: "authorId" },
					},
				},
			} as const;
			const referenceConfig = {
				authors: {
					schema: AuthorSchema,
					file: join(referenceDir, "authors.yaml"),
					relationships: {},
				},
				books: {
					schema: BookSchema,
					file: join(referenceDir, "books.json"),
					relationships: {
						author: { type: "ref" as const, target: "authors", foreignKey: "authorId" },
					},
				},
			} as const;

			const referenceLayer = Layer.merge(
				makeNodeEngineStorageLayer(),
				makeSerializerLayer(inferCodecsFromConfig(referenceConfig)),
			);
			const referenceFiles = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const referenceDb = yield* createPersistentEffectDatabase(referenceConfig, undefined, {
							writeDebounce: 5,
						});
						yield* referenceDb.authors.create({ id: "a1", name: "Frank Herbert" });
						yield* referenceDb.books.create({
							id: "b1",
							title: "Dune",
							year: 1965,
							authorId: "a1",
						});
						yield* referenceDb.books.update("b1", { year: { $increment: 1 } });
						yield* Effect.tryPromise(() => referenceDb.flush());
						return yield* Effect.all({
							authors: Effect.tryPromise(() => readFile(join(referenceDir, "authors.yaml"), "utf8")),
							books: Effect.tryPromise(() => readFile(join(referenceDir, "books.json"), "utf8")),
						});
					}),
				).pipe(Effect.provide(referenceLayer)),
			);

			const engineDb = await createPersistentEngineDatabase(engineConfig, undefined, {
				writeDebounce: 5,
			});
			await engineDb.authors.create({ id: "a1", name: "Frank Herbert" });
			await engineDb.books.create({
				id: "b1",
				title: "Dune",
				year: 1965,
				authorId: "a1",
			});
			await engineDb.books.update("b1", { year: { $increment: 1 } });
			const engineQuery = await engineDb.books.query({
				populate: { author: true },
				select: { title: true, author: { name: true } },
			});
			expect(engineQuery).toEqual([{ title: "Dune", author: { name: "Frank Herbert" } }]);
			await engineDb.flush();
			expect(await readFile(join(engineDir, "authors.yaml"), "utf8")).toBe(referenceFiles.authors);
			expect(await readFile(join(engineDir, "books.json"), "utf8")).toBe(referenceFiles.books);
			await engineDb.close();
		} finally {
			await rm(engineDir, { recursive: true, force: true });
			await rm(referenceDir, { recursive: true, force: true });
		}
	});

	it("round-trips reserved boundary sentinel shapes through create/query/update/persistence and preserves undefined where semantics", async () => {
		const engineDir = await mkdtemp(join(tmpdir(), "proseql-engine-boundary-"));
		const referenceDir = await mkdtemp(join(tmpdir(), "proseql-engine-boundary-ref-"));
		const created = {
			id: "r1",
			sentinel: { __proseqlUndefined__: 1 },
			escaped: { __proseqlEscaped__: "create" },
			nested: {
				sentinel: { __proseqlUndefined__: 2 },
				escaped: { __proseqlEscaped__: "nested-create" },
			},
			sentinelArray: [{ __proseqlUndefined__: 3 }],
			escapedArray: [{ __proseqlEscaped__: "alpha" }],
		} as const;
		const updated = {
			id: "r1",
			sentinel: { __proseqlUndefined__: 11 },
			escaped: { __proseqlEscaped__: "update" },
			nested: {
				sentinel: { __proseqlUndefined__: 12 },
				escaped: { __proseqlEscaped__: "nested-update" },
			},
			sentinelArray: [{ __proseqlUndefined__: 13 }, { __proseqlUndefined__: 14 }],
			escapedArray: [{ __proseqlEscaped__: "beta" }, { __proseqlEscaped__: "gamma" }],
		} as const;
		const presentOptional = {
			id: "r2",
			sentinel: { __proseqlUndefined__: 21 },
			escaped: { __proseqlEscaped__: "other" },
			nested: {
				sentinel: { __proseqlUndefined__: 22 },
				escaped: { __proseqlEscaped__: "nested-other" },
			},
			sentinelArray: [{ __proseqlUndefined__: 23 }],
			escapedArray: [{ __proseqlEscaped__: "delta" }],
			optional: "present",
		} as const;
		try {
			const engineConfig = {
				records: {
					schema: BoundaryRecordSchema,
					file: join(engineDir, "records.json"),
					relationships: {},
				},
			} as const;
			const referenceConfig = {
				records: {
					schema: BoundaryRecordSchema,
					file: join(referenceDir, "records.json"),
					relationships: {},
				},
			} as const;

			const engineDb = await createPersistentEngineDatabase(engineConfig, undefined, { writeDebounce: 5 });
			await engineDb.records.create(created);
			await engineDb.records.create(presentOptional);
			expect(await engineDb.records.query({ where: { optional: { $eq: undefined } }, sort: { id: "asc" } })).toEqual([
				created,
			]);
			await engineDb.records.update("r1", {
				sentinel: { $set: updated.sentinel },
				escaped: { $set: updated.escaped },
				nested: { $set: updated.nested },
				sentinelArray: { $set: updated.sentinelArray },
				escapedArray: { $set: updated.escapedArray },
			});
			expect(await engineDb.records.findById("r1")).toEqual(updated);
			await engineDb.flush();
			await engineDb.close();

			const reopened = await createPersistentEngineDatabase(engineConfig, undefined, { writeDebounce: 5 });
			expect(await reopened.records.findById("r1")).toEqual(updated);
			expect(await reopened.records.query({ where: { optional: { $eq: undefined } }, sort: { id: "asc" } })).toEqual([
				updated,
			]);
			await reopened.close();

			const referenceLayer = Layer.merge(
				makeNodeEngineStorageLayer(),
				makeSerializerLayer(inferCodecsFromConfig(referenceConfig)),
			);
			const referenceBytes = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const referenceDb = yield* createPersistentEffectDatabase(referenceConfig, undefined, {
							writeDebounce: 5,
						});
						yield* referenceDb.records.create(created);
						yield* referenceDb.records.create(presentOptional);
						yield* referenceDb.records.update("r1", {
							sentinel: { $set: updated.sentinel },
							escaped: { $set: updated.escaped },
							nested: { $set: updated.nested },
							sentinelArray: { $set: updated.sentinelArray },
							escapedArray: { $set: updated.escapedArray },
						});
						yield* Effect.tryPromise(() => referenceDb.flush());
						return yield* Effect.tryPromise(() => readFile(join(referenceDir, "records.json"), "utf8"));
					}),
				).pipe(Effect.provide(referenceLayer)),
			);
			expect(await readFile(join(engineDir, "records.json"), "utf8")).toBe(referenceBytes);
		} finally {
			await rm(engineDir, { recursive: true, force: true });
			await rm(referenceDir, { recursive: true, force: true });
		}
	});

	it("bridges JS hooks, computed fields, custom operators, and id generators", async () => {
		const plugin = {
			name: "bridge-plugin",
			operators: [
				{
					name: "$prefix",
					types: ["string"] as const,
					evaluate: (fieldValue: unknown, operand: unknown) =>
						typeof fieldValue === "string" && typeof operand === "string" && fieldValue.startsWith(operand),
				},
			],
			idGenerators: [
				{
					name: "prefixed",
					generate: () => "user-1",
				},
			],
		} as const;
		const db = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					idGenerator: "prefixed",
					relationships: {},
					hooks: {
						beforeCreate: [
							(ctx) =>
								ctx.data.age < 18
									? Effect.fail(
											new HookError({
												hook: "beforeCreate",
												collection: ctx.collection,
												operation: "create",
												reason: "underage",
												message: "Too young",
											}),
									  )
									: Effect.succeed({ ...ctx.data, role: ctx.data.role.toUpperCase() }),
						],
					},
					computed: {
						displayName: (user: typeof UserSchema.Type) => `${user.name}:${user.role}`,
					},
				},
			} as const,
			undefined,
			{ plugins: [plugin] },
		);

		await expect(db.users.create({ name: "Kid", role: "guest", age: 10 })).rejects.toBeInstanceOf(
			HookError,
		);
		const created = await db.users.create({ name: "Alice", role: "admin", age: 30 });
		expect(created.id).toBe("user-1");
		expect(created.role).toBe("ADMIN");
		const queried = await db.users.query({
			where: { name: { $prefix: "Al" } },
			select: { name: true, displayName: true },
		});
		expect(queried).toEqual([{ name: "Alice", displayName: "Alice:ADMIN" }]);
	});

	it("emits debounced watch updates and cleans up on unsubscribe", async () => {
		const db = await createEngineDatabase(
			{
				books: { schema: BookSchema, relationships: { author: { type: "ref" as const, target: "authors", foreignKey: "authorId" } } },
				authors: { schema: AuthorSchema, relationships: {} },
			} as const,
			{
				authors: [{ id: "a1", name: "Frank Herbert" }],
				books: [{ id: "b1", title: "Dune", year: 1965, authorId: "a1" }],
			},
		);
		const sub = db.books.watch({ sort: { year: "asc" }, debounceMs: 20 });
		const first = await sub.next();
		expect(first.value?.[0]?.year).toBe(1965);
		await db.books.update("b1", { year: { $increment: 1 } });
		await db.books.update("b1", { year: { $increment: 1 } });
		await new Promise((resolve) => setTimeout(resolve, 40));
		const second = await sub.next();
		expect(second.value?.[0]?.year).toBe(1967);
		await sub.unsubscribe();
		const done = await sub.next();
		expect(done.done).toBe(true);
	});

	it("reconstructs tagged boundary errors for CRUD failures", async () => {
		const db = await createEngineDatabase({ users: { schema: UserSchema, relationships: {} } } as const);
		await db.users.create({ id: "u1", name: "Alice", role: "admin", age: 30 });
		await expect(db.users.create({ id: "u1", name: "Alice", role: "admin", age: 30 })).rejects.toBeInstanceOf(
			DuplicateKeyError,
		);
	});

	it("provides a recursive Node/Bun storage host watcher", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-watch-"));
		try {
			const host = createNodeEngineStorageHost();
			const events: Array<string | null> = [];
			const stop = await host.watchDir(root, (event) => events.push(event.filename));
			await host.write(join(root, "nested", "file.txt"), "hello");
			await new Promise((resolve) => setTimeout(resolve, 150));
			stop();
			expect(events.some((filename) => filename?.endsWith("nested") || filename?.endsWith("file.txt"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
