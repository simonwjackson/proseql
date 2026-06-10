import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationError } from "@proseql/core";
import { Effect, Result, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeDatabase } from "../src/convenience.js";

const FoodSchema = Schema.Struct({
	name: Schema.String,
	macros: Schema.Struct({
		cal: Schema.Number,
		fat: Schema.optional(Schema.Number),
	}),
});

let tempDir: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `proseql-graph-${randomBytes(8).toString("hex")}`);
	await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

const graphConfig = (rootA: string, rootB: string) =>
	({
		collections: {
			foods: {
				schema: FoodSchema,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		},
		sources: [
			{
				id: "config-graph",
				kind: "documentGraph",
				include: "**/*.{yaml,json}",
				roots: [{ root: rootA }, { root: rootB }],
			},
		],
	}) as const;

describe("documentGraph through @proseql/node", () => {
	it("loads a graph from nested real files across two roots without manual codecs", async () => {
		const rootA = join(tempDir, "a");
		const rootB = join(tempDir, "b");
		await fs.mkdir(join(rootA, "nested"), { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		await fs.writeFile(
			join(rootA, "nested", "apple.yaml"),
			"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
		);
		await fs.writeFile(
			join(rootB, "apple-over.yaml"),
			"foods:\n  apple:\n    macros: { fat: 2 }\n",
		);

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(
						graphConfig(rootA, rootB),
						undefined,
						{
							writeDebounce: 60_000,
						},
					);
					return yield* db.foods.findById("apple");
				}),
			),
		);
		expect(result).toEqual({
			id: "apple",
			name: "Apple",
			macros: { cal: 10, fat: 2 },
		});
	});

	it("composes mixed-format fragments (YAML + JSON) via inferred codecs", async () => {
		const rootA = join(tempDir, "a");
		const rootB = join(tempDir, "b");
		await fs.mkdir(rootA, { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		await fs.writeFile(
			join(rootA, "y.yaml"),
			"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
		);
		await fs.writeFile(
			join(rootB, "j.json"),
			'{ "foods": { "banana": { "name": "Banana", "macros": { "cal": 90 } } } }',
		);

		const ids = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(
						graphConfig(rootA, rootB),
						undefined,
						{
							writeDebounce: 60_000,
						},
					);
					const foods = yield* Stream.runCollect(db.foods.query());
					return foods.map((f) => f.id).sort();
				}),
			),
		);
		expect(ids).toEqual(["apple", "banana"]);
	});

	it("rejects mutations end-to-end (read-only)", async () => {
		const rootA = join(tempDir, "a");
		const rootB = join(tempDir, "b");
		await fs.mkdir(rootA, { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		await fs.writeFile(
			join(rootA, "y.yaml"),
			"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
		);

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(
						graphConfig(rootA, rootB),
						undefined,
						{
							writeDebounce: 60_000,
						},
					);
					return yield* Effect.result(
						db.foods.create({ id: "x", name: "X", macros: { cal: 1 } }),
					);
				}),
			),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(OperationError);
			expect((result.failure as OperationError).reason).toBe(
				"read-only-source",
			);
		}
	});

	it("treats an optional missing root on disk as an empty contribution", async () => {
		const rootA = join(tempDir, "a");
		const rootB = join(tempDir, "missing");
		await fs.mkdir(rootA, { recursive: true });
		await fs.writeFile(
			join(rootA, "y.yaml"),
			"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
		);

		const size = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const config = {
						collections: {
							foods: {
								schema: FoodSchema,
								id: { kind: "derivedFromKey", field: "id" },
								relationships: {},
							},
						},
						sources: [
							{
								id: "config-graph",
								kind: "documentGraph",
								include: "**/*.yaml",
								roots: [{ root: rootA }, { root: rootB, optional: true }],
							},
						],
					} as const;
					const db = yield* createNodeDatabase(config, undefined, {
						writeDebounce: 60_000,
					});
					const foods = yield* Stream.runCollect(db.foods.query());
					return foods.length;
				}),
			),
		);
		expect(size).toBe(1);
	});
});
