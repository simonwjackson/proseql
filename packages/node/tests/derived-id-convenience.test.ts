import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createNodeDatabase } from "../src/convenience.js";

const GameMetadata = Schema.Struct({
	name: Schema.String,
});

const GamePayload = Schema.Struct({
	metadata: Schema.optional(GameMetadata),
	userData: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const makeTempDir = () =>
	join(tmpdir(), `proseql-derived-id-${randomBytes(8).toString("hex")}`);

describe("createNodeDatabase derived ids", () => {
	it("persists YAML without duplicated id and returns hydrated runtime records", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });
		const filePath = join(tempDir, "games.yaml");

		const config = {
			games: {
				schema: GamePayload,
				file: filePath,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config);
					yield* db.games.create({
						id: "472c8ba3-c51c-45ed-8bab-fc560edd83ea",
						metadata: { name: "Default" },
					});
					yield* Effect.promise(() => db.flush());
				}),
			),
		);

		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toContain("472c8ba3-c51c-45ed-8bab-fc560edd83ea:");
		expect(content).toContain("metadata:");
		expect(content).toContain("name: Default");
		expect(content).not.toContain("id: 472c8ba3-c51c-45ed-8bab-fc560edd83ea");

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config);
					return yield* db.games.findById(
						"472c8ba3-c51c-45ed-8bab-fc560edd83ea",
					);
				}),
			),
		);

		expect(result).toEqual({
			id: "472c8ba3-c51c-45ed-8bab-fc560edd83ea",
			metadata: { name: "Default" },
		});

		await fs.rm(tempDir, { recursive: true, force: true });
	});
});
