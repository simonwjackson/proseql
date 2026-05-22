/**
 * Document Sources Example
 *
 * Shows how one logical database can load several collections from a directory
 * of object-keyed YAML files.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeDatabase } from "@proseql/node";
import { Effect, Schema } from "effect";

const GamePayload = Schema.Struct({
	title: Schema.String,
	systemId: Schema.String,
});

const SystemPayload = Schema.Struct({
	name: Schema.String,
});

const program = Effect.gen(function* () {
	const root = yield* Effect.promise(() =>
		mkdtemp(join(tmpdir(), "proseql-docs-")),
	);
	const dataRoot = join(root, "library");
	yield* Effect.promise(() => mkdir(dataRoot, { recursive: true }));

	yield* Effect.promise(() =>
		writeFile(
			join(dataRoot, "base.yaml"),
			[
				"systems:",
				"  snes:",
				"    name: Super Nintendo",
				"",
				"games:",
				"  smw:",
				"    title: Super Mario World",
				"    systemId: snes",
				"",
			].join("\n"),
		),
	);

	yield* Effect.promise(() =>
		writeFile(
			join(dataRoot, "rpgs.yaml"),
			[
				"games:",
				"  chrono-trigger:",
				"    title: Chrono Trigger",
				"    systemId: snes",
				"",
			].join("\n"),
		),
	);

	const config = {
		collections: {
			games: {
				schema: GamePayload,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {
					system: {
						type: "ref" as const,
						target: "systems" as const,
						foreignKey: "systemId",
					},
				},
			},
			systems: {
				schema: SystemPayload,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		},
		sources: [
			{
				id: "library",
				kind: "documents",
				root: dataRoot,
				include: "**/*.yaml",
				format: "yaml",
				collections: "all",
				outbox: "generated.yaml",
			},
		],
	} as const;

	const db = yield* createNodeDatabase(config);

	const games = yield* Effect.promise(
		() => db.games.query({ sort: { title: "asc" } }).runPromise,
	);
	console.log(
		"Loaded games:",
		games.map((game) => `${game.id}: ${game.title}`),
	);

	yield* db.games.create({
		id: "earthbound",
		title: "EarthBound",
		systemId: "snes",
	});
	yield* Effect.promise(() => db.flush());

	console.log("Created EarthBound in:", join(dataRoot, "generated.yaml"));
});

Effect.runPromise(Effect.scoped(program)).catch(console.error);
