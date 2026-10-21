import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { expect, it } from "vitest";
import { makeNodeStorageLayer } from "../src/node.ts";
import { createPersistentEffectDatabase } from "@proseql/effect";
import { makeSerializerLayer } from "../../core/src/serializers/format-codec.js";

const config = (root: string) =>
	({
		collections: {
			turns: {
				schema: Schema.Struct({
					id: Schema.String,
					speaker: Schema.String,
					text: Schema.String,
				}),
				relationships: {},
			},
		},
		sources: [
			{
				id: "turns",
				kind: "partitioned",
				collection: "turns",
				root: join(root, "turns"),
				format: "prose",
				partitionBy: { kind: "prefix", field: "id", delimiter: "." },
				prose: {
					template: "[{id}] {speaker}: {text}",
					unmatchedLines: "error",
				},
			},
		],
	}) as const;
const layer = Layer.merge(makeNodeStorageLayer(), makeSerializerLayer([]));

it.each([
	"../escape.0001",
	"a/b.0001",
	"missing-delimiter",
])("rejects unsafe routing for %s before writing", async (id) => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-unsafe-"));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root), undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* db.turns.create({ id, speaker: "SJ", text: "Unsafe" });
					yield* Effect.promise(async () => {
						await expect(db.flush()).rejects.toThrow();
					});
					const names = yield* Effect.promise(() => readdir(root));
					expect(names).toEqual([]);
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("updates and deletes only rewrite the changed partition", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-update-"));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root), undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* db.turns.create({ id: "a.0001", speaker: "SJ", text: "One" });
					yield* db.turns.create({ id: "b.0001", speaker: "DF", text: "Two" });
					yield* Effect.promise(() => db.flush());
					const path = join(root, "turns/b.prose");
					const before = yield* Effect.promise(() => stat(path));
					yield* db.turns.update("a.0001", { text: "Changed" });
					yield* Effect.promise(() => db.flush());
					expect(
						yield* Effect.promise(() =>
							readFile(join(root, "turns/a.prose"), "utf8"),
						),
					).toContain("Changed");
					yield* db.turns.delete("a.0001");
					yield* Effect.promise(() => db.flush());
					const after = yield* Effect.promise(() => stat(path));
					expect(after.ino).toBe(before.ino);
					expect(after.mtimeMs).toBe(before.mtimeMs);
					expect(
						yield* Effect.promise(() =>
							readFile(join(root, "turns/a.prose"), "utf8"),
						),
					).not.toContain("a.0001");
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("moves a record when its partition field changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-move-"));
	const cfg = config(root);
	const moved = {
		...cfg,
		sources: [
			{
				...cfg.sources[0],
				partitionBy: { kind: "field", field: "speaker" } as const,
			},
		],
	};
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(moved, undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* db.turns.create({ id: "a.0001", speaker: "SJ", text: "One" });
					yield* Effect.promise(() => db.flush());
					yield* db.turns.update("a.0001", { speaker: "DF" });
					yield* Effect.promise(() => db.flush());
					expect(
						yield* Effect.promise(() =>
							readFile(join(root, "turns/SJ.prose"), "utf8"),
						),
					).not.toContain("a.0001");
					expect(
						yield* Effect.promise(() =>
							readFile(join(root, "turns/DF.prose"), "utf8"),
						),
					).toContain("[a.0001] DF: One");
				}),
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(moved),
						layer,
					);
					expect((yield* db.turns.findById("a.0001")).speaker).toBe("DF");
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("does not overwrite an externally-created partition at flush", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-conflict-"));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root), undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* db.turns.create({ id: "a.0001", speaker: "SJ", text: "One" });
					yield* Effect.promise(() => mkdir(join(root, "turns")));
					const external =
						"@prose [{id}] {speaker}: {text}\n\n[a.0002] DF: External";
					yield* Effect.promise(() =>
						writeFile(join(root, "turns/a.prose"), external),
					);
					yield* Effect.promise(async () => {
						await expect(db.flush()).rejects.toThrow("changed since load");
					});
					expect(
						yield* Effect.promise(() =>
							readFile(join(root, "turns/a.prose"), "utf8"),
						),
					).toBe(external);
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	["duplicate", "[a.0001] SJ: One\n[a.0001] SJ: Two"],
	["misrouted", "[b.0001] SJ: Wrong file"],
	["malformed", "not a record"],
])("rejects %s partition data when opening", async (_kind, text) => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-invalid-"));
	try {
		await mkdir(join(root, "turns"));
		await writeFile(
			join(root, "turns/a.prose"),
			`@prose [{id}] {speaker}: {text}\n\n${text}`,
		);
		await expect(
			Effect.runPromise(
				Effect.scoped(
					Effect.provide(createPersistentEffectDatabase(config(root)), layer),
				),
			),
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("creates partition files and queries them as one collection after reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-"));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root), undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* db.turns.create({
						id: "meeting-a.0001",
						speaker: "SJ",
						text: "35143",
					});
					yield* db.turns.create({
						id: "meeting-b.0001",
						speaker: "DF",
						text: "Second meeting",
					});
					yield* Effect.promise(() => db.flush());
				}),
			),
		);
		expect(
			await readFile(join(root, "turns/meeting-a.prose"), "utf8"),
		).toContain('[meeting-a.0001] SJ: "35143"');
		expect(
			await readFile(join(root, "turns/meeting-b.prose"), "utf8"),
		).toContain("[meeting-b.0001] DF: Second meeting");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root)),
						layer,
					);
					expect((yield* Stream.runCollect(db.turns.query())).length).toBe(2);
					expect(yield* db.turns.findById("meeting-a.0001")).toEqual({
						id: "meeting-a.0001",
						speaker: "SJ",
						text: "35143",
					});
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("reloads external partition changes through the managed watcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-partition-watch-"));
	try {
		await mkdir(join(root, "turns"));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(config(root), undefined, {
							writeDebounce: 60_000,
						}),
						layer,
					);
					yield* Effect.promise(() =>
						writeFile(
							join(root, "turns/external.prose"),
							"@prose [{id}] {speaker}: {text}\n\n[external.0001] SJ: External",
						),
					);
					const deadline = Date.now() + 2000;
					let record = yield* db.turns
						.findById("external.0001")
						.pipe(Effect.catch(() => Effect.succeed(undefined)));
					while (record === undefined && Date.now() < deadline) {
						yield* Effect.sleep(10);
						record = yield* db.turns
							.findById("external.0001")
							.pipe(Effect.catch(() => Effect.succeed(undefined)));
					}
					expect(record).toEqual({
						id: "external.0001",
						speaker: "SJ",
						text: "External",
					});
				}),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
