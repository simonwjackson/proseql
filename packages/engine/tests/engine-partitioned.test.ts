import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { createPersistentEngineDatabase } from "../src/index.js";

it("keeps partitioned sources writable through the Promise engine interface", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-engine-partition-"));
	const config = {
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
	} as const;
	try {
		const db = await createPersistentEngineDatabase(config, undefined, {
			writeDebounce: 60_000,
		});
		try {
			await db.turns.create({ id: "one.0001", speaker: "SJ", text: "35143" });
			await db.turns.create({ id: "two.0001", speaker: "DF", text: "Second" });
			await db.flush();
		} finally {
			await db.close();
		}
		expect(await readFile(join(root, "turns/one.prose"), "utf8")).toContain(
			'[one.0001] SJ: "35143"',
		);
		const reopened = await createPersistentEngineDatabase(config, undefined, {
			writeDebounce: 60_000,
		});
		try {
			expect((await reopened.turns.query()).length).toBe(2);
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
