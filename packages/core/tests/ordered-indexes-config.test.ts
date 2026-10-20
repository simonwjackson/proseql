import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/factories/database-effect.js";

// The legacy TypeScript core accepts `orderedIndexes` (for config parity with
// the Rust engine) but does not use it for query planning. Results must be
// the same with and without the setting.

const SampleSchema = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String,
	bpm: Schema.Number,
});

const samples = [
	{ id: "a", timestamp: "2026-01-01T00:10:00.000Z", bpm: 70 },
	{ id: "b", timestamp: "2026-01-01T01:10:00.000Z", bpm: 71 },
	{ id: "c", timestamp: "2026-01-01T00:40:00.000Z", bpm: 72 },
	{ id: "d", timestamp: "2026-01-01T00:10:00.000Z", bpm: 70 },
];

const config = (orderedIndexes?: ReadonlyArray<string>) =>
	({
		samples: {
			schema: SampleSchema,
			relationships: {},
			...(orderedIndexes ? { orderedIndexes } : {}),
		},
	}) as const;

const queries = [
	{
		where: {
			timestamp: {
				$gte: "2026-01-01T00:00:00.000Z",
				$lt: "2026-01-01T01:00:00.000Z",
			},
		},
	},
	{ where: { bpm: { $gt: 69, $lte: 71 } }, sort: { bpm: "desc" } },
	{ sort: { timestamp: "asc" }, offset: 1, limit: 2 },
] as const;

describe("orderedIndexes in the legacy core", () => {
	it("is accepted and returns the same results as without it", async () => {
		const run = (orderedIndexes?: ReadonlyArray<string>) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config(orderedIndexes), {
						samples,
					});
					const results: Array<ReadonlyArray<unknown>> = [];
					for (const query of queries) {
						results.push(yield* Stream.runCollect(db.samples.query(query)));
					}
					return results;
				}),
			);
		const indexed = await run(["timestamp", "bpm"]);
		const plain = await run();
		expect(indexed).toEqual(plain);
		expect(
			(indexed[0] as ReadonlyArray<{ readonly id: string }>).map(
				(row) => row.id,
			),
		).toEqual(["a", "c", "d"]);
	});
});
