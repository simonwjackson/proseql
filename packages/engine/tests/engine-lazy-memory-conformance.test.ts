import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { beforeAll, expect, it } from "vitest";
import fixture from "../../../crates/proseql-engine/tests/fixtures/lazy-memory.json";
import { createEngineDatabase } from "../src/index.js";

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
		stdio: "inherit",
	});
}, 180_000);

it("keeps shared accumulator float order, group order and array/object min/max in WASM", async () => {
	const db = await createEngineDatabase(
		{
			samples: {
				schema: Schema.Struct({
					id: Schema.String,
					group: Schema.optional(Schema.NullOr(Schema.String)),
					value: Schema.Number,
					comparable: Schema.Unknown,
					object: Schema.optional(Schema.Unknown),
				}),
				relationships: {},
				indexes: ["group"],
				orderedIndexes: ["value"],
			},
		},
		{ samples: fixture.rows },
	);
	const config = {
		count: true,
		sum: "value",
		avg: "value",
		min: ["comparable", "object"],
		max: ["comparable", "object"],
	} as const;
	expect(await db.samples.aggregate(config)).toEqual(fixture.expected);
	const union = { group: { $in: ["z", "a"] } };
	expect(await db.samples.query({ where: union, select: ["id"] })).toEqual([
		{ id: "a" },
		{ id: "c" },
		{ id: "b" },
	]);
	expect(await db.samples.aggregate({ ...config, where: union })).toMatchObject(
		{
			sum: { value: 0 },
		},
	);
	const grouped = await db.samples.aggregate({ ...config, groupBy: "group" });
	expect(grouped.map((row) => row.group)).toEqual([
		{ group: "z" },
		{ group: "a" },
		{},
		{ group: null },
	]);
	expect(
		await db.samples.query({
			sort: { value: "asc" },
			offset: 1,
			limit: 2,
			select: ["id"],
		}),
	).toEqual([{ id: "d" }, { id: "e" }]);
});
