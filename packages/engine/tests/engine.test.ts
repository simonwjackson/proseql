import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DuplicateKeyError,
	HookError,
	makeSerializerLayer,
	createPersistentEffectDatabase,
	inferCodecsFromConfig,
} from "@proseql/core";
import { createNodeDatabase } from "@proseql/node";
import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createEngineDatabase,
	createPersistentEngineDatabase,
	createNodeEngineStorageHost,
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

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: "/home/simonwjackson/code/github/simonwjackson/proseql/.worktrees/refactor-rust-engine-conversion",
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

			const engineDb = await createPersistentEngineDatabase(engineConfig, undefined, {
				writeDebounce: 5,
			});
			const referenceLayer = Layer.merge(
				makeNodeEngineStorageLayer(),
				makeSerializerLayer(inferCodecsFromConfig(referenceConfig)),
			);
			const referenceDb = await Effect.runPromise(
				Effect.scoped(
					createPersistentEffectDatabase(referenceConfig, undefined, {
						writeDebounce: 5,
					}).pipe(Effect.provide(referenceLayer)),
				),
			);

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

			await Effect.runPromise(referenceDb.authors.create({ id: "a1", name: "Frank Herbert" }));
			await Effect.runPromise(
				referenceDb.books.create({
					id: "b1",
					title: "Dune",
					year: 1965,
					authorId: "a1",
				}),
			);
			await Effect.runPromise(referenceDb.books.update("b1", { year: { $increment: 1 } }));
			await referenceDb.flush();

			expect(await readFile(join(engineDir, "authors.yaml"), "utf8")).toBe(
				await readFile(join(referenceDir, "authors.yaml"), "utf8"),
			);
			expect(await readFile(join(engineDir, "books.json"), "utf8")).toBe(
				await readFile(join(referenceDir, "books.json"), "utf8"),
			);
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
