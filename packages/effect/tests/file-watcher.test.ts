import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createPersistentEffectDatabase,
	jsonCodec,
	makeSerializerLayer,
	StorageAdapterService,
	StorageError,
} from "@proseql/effect";
import { makeNodeEngineStorageLayer } from "@proseql/engine";
import { Effect, Layer, Schema } from "effect";
import { expect, it } from "vitest";

const schema = Schema.Struct({ id: Schema.String, name: Schema.String });
const eventually = async (read: () => Promise<unknown>, expected: unknown) => {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(await read()).toEqual(expected);
};
const withFiles = async (run: (root: string) => Promise<void>) => {
	const root = await mkdtemp(join(tmpdir(), "proseql-effect-watch-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

it("updates queries when a real file changes", () =>
	withFiles(async (root) => {
		const file = join(root, "users.json");
		await writeFile(file, JSON.stringify({ a: { id: "a", name: "Alice" } }));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase({
						users: { schema, file, relationships: {} },
					});
					expect(yield* db.users.findById("a")).toEqual({
						id: "a",
						name: "Alice",
					});
					yield* Effect.promise(() =>
						writeFile(
							file,
							JSON.stringify({ a: { id: "a", name: "Updated" } }),
						),
					);
					yield* Effect.promise(() =>
						eventually(() => db.users.findById("a").runPromise, {
							id: "a",
							name: "Updated",
						}),
					);
				}),
			),
		);
	}));

it("observes the final state after rapid real-file changes", () =>
	withFiles(async (root) => {
		const file = join(root, "users.json");
		await writeFile(file, JSON.stringify({ a: { id: "a", name: "Alice" } }));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase({
						users: { schema, file, relationships: {} },
					});
					for (const name of ["First", "Second", "Final"])
						yield* Effect.promise(() =>
							writeFile(file, JSON.stringify({ a: { id: "a", name } })),
						);
					yield* Effect.promise(() =>
						eventually(() => db.users.findById("a").runPromise, {
							id: "a",
							name: "Final",
						}),
					);
				}),
			),
		);
	}));

for (const changed of ["users", "authors"] as const)
	it(`independently reloads the ${changed} file`, () =>
		withFiles(async (root) => {
			const users = join(root, "users.json");
			const authors = join(root, "authors.json");
			for (const file of [users, authors])
				await writeFile(
					file,
					JSON.stringify({ a: { id: "a", name: "Original" } }),
				);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase({
							users: { schema, file: users, relationships: {} },
							authors: { schema, file: authors, relationships: {} },
						});
						yield* Effect.promise(() =>
							writeFile(
								changed === "users" ? users : authors,
								JSON.stringify({ a: { id: "a", name: "Updated" } }),
							),
						);
						yield* Effect.promise(() =>
							eventually(() => db[changed].findById("a").runPromise, {
								id: "a",
								name: "Updated",
							}),
						);
						expect(
							yield* db[changed === "users" ? "authors" : "users"].findById(
								"a",
							),
						).toEqual({ id: "a", name: "Original" });
					}),
				),
			);
		}));

it("surfaces a host watch failure as StorageError", () =>
	withFiles(async (root) => {
		const file = join(root, "users.json");
		await writeFile(file, "{}");
		const storage = await Effect.runPromise(
			Effect.provide(StorageAdapterService, makeNodeEngineStorageLayer()),
		);
		const error = new StorageError({
			path: file,
			operation: "watch",
			message: "watch unavailable",
		});
		const layer = Layer.merge(
			Layer.succeed(StorageAdapterService, {
				...storage,
				watch: () => Effect.fail(error),
			}),
			makeSerializerLayer([jsonCodec()]),
		);
		const result = await Effect.runPromise(
			Effect.result(
				Effect.scoped(
					createPersistentEffectDatabase({
						users: { schema, file, relationships: {} },
					}).pipe(Effect.provide(layer)),
				),
			),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure")
			expect(result.failure).toMatchObject({
				_tag: "StorageError",
				path: file,
			});
		expect(await readFile(file, "utf8")).toBe("{}");
	}));
