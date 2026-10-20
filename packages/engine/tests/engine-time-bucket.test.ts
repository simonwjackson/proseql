import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceConfigError } from "@proseql/core";
import { Schema } from "effect";
import { beforeAll, expect, it } from "vitest";
import { createPersistentEngineDatabase } from "../src/index.js";

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 600_000);

const config = (root: string) =>
	({
		collections: {
			heartrate: {
				schema: Schema.Struct({
					id: Schema.String,
					timestamp: Schema.String,
					bpm: Schema.Number,
				}),
				relationships: {},
				duplicateIds: "ignoreIdentical",
			},
		},
		sources: [
			{
				id: "heartrate",
				kind: "partitioned",
				collection: "heartrate",
				root: join(root, "heartrate"),
				format: "jsonl",
				partitionBy: {
					kind: "timeBucket",
					field: "timestamp",
					bucket: "month",
				},
			},
		],
	}) as const;

const sample = (timestamp: string) => ({
	id: `heartrate:${timestamp}`,
	timestamp,
	bpm: 80,
});

it("routes time-bucket partitions in the WASM engine like the native runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "proseql-engine-time-bucket-"));
	try {
		const db = await createPersistentEngineDatabase(config(root), undefined, {
			writeDebounce: 60_000,
		});
		try {
			await db.heartrate.create(sample("2026-04-01T08:15:00.123Z"));
			await db.heartrate.create(sample("2025-12-31T23:59:59.999Z"));
			// Identical re-create: a no-op that leaves the partition unchanged.
			await db.heartrate.create(sample("2026-04-01T08:15:00.123Z"));
			await db.flush();
		} finally {
			await db.close();
		}
		// Like other partition keys, the TypeScript save path validates the
		// key when it writes: the flush fails and no file changes.
		const invalid = await createPersistentEngineDatabase(
			config(root),
			undefined,
			{ writeDebounce: 60_000 },
		);
		await invalid.heartrate.create(sample("2026-04-01T10:15:00+02:00"));
		await expect(invalid.flush()).rejects.toBeInstanceOf(SourceConfigError);
		await invalid.close().catch(() => undefined);
		expect((await readdir(join(root, "heartrate"))).sort()).toEqual([
			"2025-12.jsonl",
			"2026-04.jsonl",
		]);
		expect(
			await readFile(join(root, "heartrate", "2026-04.jsonl"), "utf8"),
		).toBe(JSON.stringify(sample("2026-04-01T08:15:00.123Z")));
		const reopened = await createPersistentEngineDatabase(
			config(root),
			undefined,
			{ writeDebounce: 60_000 },
		);
		try {
			expect(await reopened.heartrate.query()).toHaveLength(2);
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
