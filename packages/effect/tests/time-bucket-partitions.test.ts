import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeNodeStorageLayer } from "../src/node.ts";
import { SourceConfigError } from "../../core/src/errors/source-errors.js";
import { createPersistentEffectDatabase } from "@proseql/effect";
import { jsonlCodec } from "../../core/src/serializers/codecs/jsonl.js";
import { makeSerializerLayer } from "../../core/src/serializers/format-codec.js";
import { timeBucketKey } from "../../engine/src/host/partitioned-source.js";
import {
	normalizeSourceConfig,
	type PartitionTimeBucket,
} from "../../core/src/storage/source-config.js";

const SampleSchema = Schema.Struct({
	id: Schema.String,
	timestamp: Schema.String,
	bpm: Schema.Number,
});

const config = (root: string, bucket: PartitionTimeBucket) =>
	({
		collections: {
			heartrate: { schema: SampleSchema, relationships: {} },
		},
		sources: [
			{
				id: "heartrate",
				kind: "partitioned",
				collection: "heartrate",
				root: join(root, "heartrate"),
				format: "jsonl",
				partitionBy: { kind: "timeBucket", field: "timestamp", bucket },
			},
		],
	}) as const;

const layer = Layer.merge(
	makeNodeStorageLayer(),
	makeSerializerLayer([jsonlCodec()]),
);

const sample = (timestamp: string) => ({
	id: `heartrate:${timestamp}`,
	timestamp,
	bpm: 80,
});

describe("timeBucketKey", () => {
	it("derives year, month and day keys from UTC timestamps", async () => {
		const value = "2026-04-01T08:15:00.123Z";
		expect(timeBucketKey(value, "year")).toBe("2026");
		expect(timeBucketKey(value, "month")).toBe("2026-04");
		expect(timeBucketKey(value, "day")).toBe("2026-04-01");
		expect(timeBucketKey("2024-02-29T23:59:59Z", "day")).toBe("2024-02-29");
	});

	// Same cases as the native `time_bucket_keys_accept_only_utc_timestamps`.
	it.each([
		"2026-04-01T08:15:00.123+02:00",
		"2026-04-01T08:15:00.123",
		"2026-04-01 08:15:00Z",
		"2026-04-01",
		"2026-4-01T08:15:00Z",
		"2026-13-01T08:15:00Z",
		"2026-02-29T08:15:00Z",
		"2026-04-31T08:15:00Z",
		"2026-04-01T24:00:00Z",
		"2026-04-01T08:60:00Z",
		"2026-04-01T08:15:00.Z",
		"2026-04-01T08:15:00.12aZ",
		"+02026-04-01T08:15:00Z",
		"2026-04-01T08:15:00z",
		"",
	])("rejects %s", (value) => {
		expect(timeBucketKey(value, "month")).toBeUndefined();
	});
});

describe("timeBucket partitions in the legacy core runtime", () => {
	it("accepts the key and rejects an unknown bucket", async () => {
		expect(() =>
			normalizeSourceConfig(config("/tmp/x", "month")),
		).not.toThrow();
		expect(() =>
			normalizeSourceConfig(config("/tmp/x", "week" as PartitionTimeBucket)),
		).toThrow(SourceConfigError);
	});

	it.each([
		["year", ["2025.jsonl", "2026.jsonl"]],
		["month", ["2025-12.jsonl", "2026-04.jsonl"]],
		["day", ["2025-12-31.jsonl", "2026-04-01.jsonl", "2026-04-02.jsonl"]],
	] as const)("routes records by %s like the native runtime", async (bucket, files) => {
		const root = await mkdtemp(join(tmpdir(), "proseql-time-bucket-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(config(root, bucket), undefined, {
								writeDebounce: 60_000,
							}),
							layer,
						);
						yield* db.heartrate.create(sample("2026-04-01T08:15:00.123Z"));
						yield* db.heartrate.create(sample("2026-04-02T00:00:00Z"));
						yield* db.heartrate.create(sample("2025-12-31T23:59:59.999Z"));
						yield* Effect.promise(() => db.flush());
					}),
				),
			);
			expect((await readdir(join(root, "heartrate"))).sort()).toEqual(files);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["a non-UTC timestamp", "2026-04-01T10:15:00+02:00", /UTC timestamp/],
		["a record in the wrong bucket", "2026-05-01T00:00:00Z", /wrong partition/],
	])("fails to open with %s", async (_label, timestamp, message) => {
		const root = await mkdtemp(join(tmpdir(), "proseql-time-bucket-load-"));
		try {
			await mkdir(join(root, "heartrate"));
			const path = join(root, "heartrate", "2026-04.jsonl");
			await writeFile(path, `${JSON.stringify(sample(timestamp))}\n`);
			const error = await Effect.runPromise(
				Effect.flip(
					Effect.scoped(
						Effect.provide(
							createPersistentEffectDatabase(config(root, "month")),
							layer,
						),
					),
				),
			);
			expect(error).toBeInstanceOf(SourceConfigError);
			expect((error as SourceConfigError).path).toBe(path);
			expect((error as SourceConfigError).message).toMatch(message);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
