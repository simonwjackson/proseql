import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonCodec, makeSerializerLayer } from "@proseql/core";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createPersistentEffectDatabase as createEffectDatabase } from "../../effect/src/index.js";
import {
	createPersistentEngineDatabase,
	makeNodeEngineStorageLayer,
} from "../src/index.js";

const cases = [
	{
		name: "built-in key checks",
		key: Schema.String.check(Schema.isMinLength(4)),
	},
	{
		name: "host-predicate key checks",
		key: Schema.String.check(
			Schema.makeFilter((key: string) => key.startsWith("ok"), {
				expected: "a key starting with ok",
			}),
		),
	},
] as const;

describe("Record key checks", () => {
	for (const entry of cases) {
		it(`checks returned, stored and persisted records with ${entry.name}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "proseql-record-keys-"));
			const schema = Schema.Struct({
				id: Schema.String,
				data: Schema.Record(entry.key, Schema.Number),
			});
			const config = (file: string) =>
				({ users: { schema, relationships: {}, file } }) as const;
			const input = { id: "u1", data: { bad: 1, okay: 2, ok_two: 3 } };
			const layer = Layer.merge(
				makeNodeEngineStorageLayer(),
				makeSerializerLayer([jsonCodec()]),
			);
			try {
				const results = [];
				for (const [runtime, create] of [
					["effect", createEffectDatabase],
				] as const) {
					const file = join(root, `${runtime}.json`);
					results.push(
						await Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const db = yield* create(config(file));
									const created = yield* db.users.create(input);
									yield* db.users.update("u1", { data: { bad: 4, ok_end: 5 } });
									const stored = yield* db.users.findById("u1");
									yield* Effect.promise(() => db.flush());
									const persisted = yield* Effect.promise(() =>
										readFile(file, "utf8"),
									);
									return {
										created,
										stored,
										persisted: JSON.parse(persisted) as unknown,
									};
								}),
							).pipe(Effect.provide(layer)),
						),
					);
				}
				const file = join(root, "engine.json");
				const db = await createPersistentEngineDatabase(config(file));
				try {
					const created = await db.users.create(input);
					await db.users.update("u1", { data: { bad: 4, ok_end: 5 } });
					const stored = await db.users.findById("u1");
					await db.flush();
					results.push({
						created,
						stored,
						persisted: JSON.parse(await readFile(file, "utf8")) as unknown,
					});
				} finally {
					await db.close();
				}
				for (const result of results) {
					expect(result).toEqual({
						created: { id: "u1", data: { okay: 2, ok_two: 3 } },
						stored: { id: "u1", data: { okay: 2, ok_two: 3, ok_end: 5 } },
						persisted: {
							u1: { id: "u1", data: { okay: 2, ok_two: 3, ok_end: 5 } },
						},
					});
					expect(result.created.data).toEqual({ okay: 2, ok_two: 3 });
					expect(Object.keys(result.created.data)).toEqual(["okay", "ok_two"]);
					expect(result.stored.data).not.toHaveProperty("bad");
					expect(result.persisted).toMatchObject({
						u1: { data: result.stored.data },
					});
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
	it("surfaces a throwing key predicate as a WASM defect instead of silently dropping the key", () => {
		// A callback defect can poison its WASM runtime. Isolate that runtime
		// in a subprocess instead of leaking it into the other database tests.
		const entryPoint = new URL("../src/index.ts", import.meta.url).pathname;
		const script = `
            import { createEngineDatabase, WasmEngineDefectError } from ${JSON.stringify(entryPoint)};
            import { Schema } from "effect";
            const key = Schema.String.check(Schema.makeFilter(() => { throw new Error("record key predicate aborted"); }));
            const db = await createEngineDatabase({ users: { schema: Schema.Struct({ id: Schema.String, data: Schema.Record(key, Schema.Number) }), relationships: {} } });
            try {
                await db.users.create({ id: "u1", data: { okay: 1 } });
                throw new Error("Record key predicate abort was swallowed");
            } catch (error) {
                if (!(error instanceof WasmEngineDefectError)) throw error;
                console.log("Record key predicate abort surfaced");
            }
        `;
		expect(
			execFileSync("bun", ["-e", script], { encoding: "utf8" }).trim(),
		).toBe("Record key predicate abort surfaced");
	});
});
