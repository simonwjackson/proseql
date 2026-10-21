import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DuplicateKeyError,
	NotFoundError,
	ValidationError,
} from "@proseql/core";
import { Effect, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createEngineDatabase,
	createPersistentEngineDatabase,
} from "../src/index.js";

const SampleSchema = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String,
	bpm: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 120_000);

const sample = (id: string, bpm: number) => ({
	id,
	timestamp: "2026-04-01T08:15:00.123Z",
	bpm,
});

describe("duplicateIds", () => {
	it("returns the stored record for an identical re-create in the WASM engine", async () => {
		const db = await createEngineDatabase({
			heartrate: {
				schema: SampleSchema,
				relationships: {},
				duplicateIds: "ignoreIdentical",
			},
		} as const);
		const stored = await db.heartrate.create(sample("hr:1", 81));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const again = await db.heartrate.create(sample("hr:1", 81));
		expect(again).toEqual(stored);
		await expect(
			db.heartrate.create(sample("hr:1", 82)),
		).rejects.toBeInstanceOf(DuplicateKeyError);

		const batch = await db.heartrate.createMany([
			sample("hr:0", 70),
			sample("hr:1", 81),
		]);
		expect(batch.created.map((record) => record.id)).toEqual(["hr:0", "hr:1"]);
		expect(batch.created[1]).toEqual(stored);

		await expect(
			db.heartrate.createMany([sample("hr:2", 90), sample("hr:1", 99)]),
		).rejects.toBeInstanceOf(DuplicateKeyError);
		await expect(db.heartrate.findById("hr:2")).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(await db.heartrate.query()).toHaveLength(2);
	});

	it("keeps rejecting identical re-creates by default", async () => {
		const db = await createEngineDatabase({
			heartrate: { schema: SampleSchema, relationships: {} },
		} as const);
		await db.heartrate.create(sample("hr:1", 81));
		await expect(
			db.heartrate.create(sample("hr:1", 81)),
		).rejects.toBeInstanceOf(DuplicateKeyError);
	});

	it("does not append a line for an identical re-create to an append-only JSONL file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "proseql-engine-dupids-"));
		try {
			const file = join(dir, "heartrate.jsonl");
			const db = await createPersistentEngineDatabase(
				{
					heartrate: {
						schema: SampleSchema,
						relationships: {},
						file,
						appendOnly: true,
						duplicateIds: "ignoreIdentical",
					},
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			await db.heartrate.create(sample("hr:1", 81));
			await db.heartrate.create(sample("hr:1", 81));
			await db.heartrate.createMany([
				sample("hr:1", 81),
				sample("hr:2", 90),
				sample("hr:2", 90),
			]);
			const beforeFlush = (await readFile(file, "utf8"))
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line).id);
			expect(beforeFlush).toEqual(["hr:1", "hr:2"]);
			await db.flush();
			await db.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses a conflicting batch with skipDuplicates and writes nothing to the JSONL file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "proseql-engine-dupids-skip-"));
		try {
			const file = join(dir, "heartrate.jsonl");
			const db = await createPersistentEngineDatabase(
				{
					heartrate: {
						schema: SampleSchema,
						relationships: {},
						file,
						appendOnly: true,
						duplicateIds: "ignoreIdentical",
					},
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			await db.heartrate.create(sample("hr:1", 81));
			const before = await readFile(file, "utf8");
			await expect(
				db.heartrate.createMany([sample("hr:2", 90), sample("hr:1", 82)], {
					skipDuplicates: true,
				}),
			).rejects.toBeInstanceOf(DuplicateKeyError);
			expect(await readFile(file, "utf8")).toBe(before);
			await expect(db.heartrate.findById("hr:2")).rejects.toBeInstanceOf(
				NotFoundError,
			);
			const identical = await db.heartrate.createMany(
				[sample("hr:1", 81), sample("hr:3", 70)],
				{ skipDuplicates: true },
			);
			expect(identical.created.map((record) => record.id)).toEqual([
				"hr:1",
				"hr:3",
			]);
			await db.flush();
			await db.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unknown policy at the descriptor boundary with ValidationError", async () => {
		const error = await createEngineDatabase({
			heartrate: {
				schema: SampleSchema,
				relationships: {},
				duplicateIds: "ignore_identical" as never,
			},
		} as const).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).message).toMatch(
			/unsupported duplicateIds/,
		);
		expect((error as ValidationError).issues[0]?.field).toBe(
			"heartrate.duplicateIds",
		);
	});
});
