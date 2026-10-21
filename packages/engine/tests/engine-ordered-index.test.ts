import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { createEngineDatabase } from "../src/index.js";

// `orderedIndexes` reaches the WASM engine, which plans range filters and
// single-field sorts with it. Every query must return what the same database
// without the setting returns. Index use itself is asserted at the WASM
// boundary (crates/proseql-wasm/tests/ordered_index_boundary.rs, `explainQuery`).

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 60_000);

const SampleSchema = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String,
	bpm: Schema.Number,
	note: Schema.optional(Schema.NullOr(Schema.String)),
});

const samples = [
	{ id: "a", timestamp: "2026-01-01T00:10:00.000Z", bpm: 70, note: "x" },
	{ id: "b", timestamp: "2026-01-01T01:10:00.000Z", bpm: 71 },
	{ id: "c", timestamp: "2026-01-01T00:40:00.000Z", bpm: 72, note: null },
	{ id: "d", timestamp: "2026-01-01T00:10:00.000Z", bpm: 70, note: "B" },
	{ id: "e", timestamp: "2025-12-31T23:59:59.999Z", bpm: -0, note: "" },
];

const config = (orderedIndexes?: ReadonlyArray<string>) =>
	({
		samples: {
			schema: SampleSchema,
			relationships: {},
			...(orderedIndexes ? { orderedIndexes } : {}),
		},
	}) as const;

const oneHour = {
	timestamp: {
		$gte: "2026-01-01T00:00:00.000Z",
		$lt: "2026-01-01T01:00:00.000Z",
	},
} as const;

const queries = [
	{ where: oneHour },
	{ where: { $and: [{ bpm: { $gt: 0 } }, { bpm: { $lte: 71 } }] } },
	{ where: { bpm: { $gte: 70 } }, sort: { bpm: "desc" } },
	{ sort: { timestamp: "asc" }, offset: 1, limit: 3 },
	{ sort: { timestamp: "desc" } },
	{ sort: { bpm: "asc" } },
	{ sort: { note: "asc" } },
	{ where: { note: { $gte: "B" } } },
	{ where: { timestamp: { $gt: 5 } } },
	{ where: oneHour, select: ["id"] },
] as const;

const runAll = async (db: {
	readonly samples: {
		readonly query: (query?: never) => Promise<ReadonlyArray<unknown>>;
	};
}) => {
	const results: Array<ReadonlyArray<unknown>> = [];
	for (const query of queries) {
		results.push(await db.samples.query(query as never));
	}
	return results;
};

describe("@proseql/engine orderedIndexes", () => {
	it("returns the same results and order as the unindexed engine across writes", async () => {
		const indexed = await createEngineDatabase(
			config(["timestamp", "bpm", "note"]),
			{ samples },
		);
		const plain = await createEngineDatabase(config(), { samples });
		const both = [indexed, plain] as const;

		expect(await runAll(indexed)).toEqual(await runAll(plain));
		expect(
			(await indexed.samples.query({ where: oneHour })).map((row) => row.id),
		).toEqual(["a", "c", "d"]);

		for (const db of both) {
			await db.samples.update("b", { timestamp: "2026-01-01T00:20:00.000Z" });
			await db.samples.delete("a");
			await db.samples.create({
				id: "f",
				timestamp: "2026-01-01T00:10:00.000Z",
				bpm: 71,
			});
		}
		expect(await runAll(indexed)).toEqual(await runAll(plain));
		expect(
			(await indexed.samples.query({ where: oneHour })).map((row) => row.id),
		).toEqual(["b", "c", "d", "f"]);
	});

	it("rejects an ordered index on a field the schema does not declare", async () => {
		await expect(
			createEngineDatabase(config(["recordedAt"]), { samples }),
		).rejects.toMatchObject({ _tag: "ValidationError" });
	});
});
