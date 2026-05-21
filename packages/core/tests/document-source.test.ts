import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	DuplicateRecordError,
	UnknownCollectionError,
} from "../src/errors/source-errors.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { loadDocumentSources } from "../src/storage/document-source.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import { getOrigin } from "../src/storage/origin-index.js";
import { normalizeSourceConfig } from "../src/storage/source-config.js";

const GamePayload = Schema.Struct({
	name: Schema.String,
	systemId: Schema.String,
});

const SystemPayload = Schema.Struct({
	name: Schema.String,
});

const makeLayer = (store: Map<string, string>) =>
	Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([yamlCodec()]),
	);

const config = {
	collections: {
		games: {
			schema: GamePayload,
			id: { kind: "derivedFromKey", field: "id" },
			relationships: {},
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
			root: "/config",
			include: "**/*.yaml",
			format: "yaml",
			collections: "all",
			outbox: "/config/generated.yaml",
		},
	],
} as const;

const load = (store: Map<string, string>) => {
	const normalized = normalizeSourceConfig(config);
	return Effect.runPromise(
		Effect.provide(loadDocumentSources(normalized), makeLayer(store)),
	);
};

describe("document-source loading", () => {
	it("merges records from multiple YAML files and records each origin", async () => {
		const store = new Map<string, string>([
			[
				"/config/base.yaml",
				`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
			],
			[
				"/config/nested/more.yaml",
				`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\nsystems:\n  genesis:\n    name: Genesis\n`,
			],
		]);

		const loaded = await load(store);

		expect(loaded.collections.games.get("smw")).toEqual({
			id: "smw",
			name: "Super Mario World",
			systemId: "snes",
		});
		expect(loaded.collections.games.get("sonic")?.id).toBe("sonic");
		expect(loaded.collections.systems.get("snes")).toEqual({
			id: "snes",
			name: "Super Nintendo",
		});
		expect(getOrigin(loaded.origins, "games", "smw")).toMatchObject({
			sourceId: "library",
			path: "/config/base.yaml",
			collection: "games",
			id: "smw",
		});
		expect(getOrigin(loaded.origins, "systems", "genesis")?.path).toBe(
			"/config/nested/more.yaml",
		);
	});

	it("allows files that omit declared collections and empty documents", async () => {
		const store = new Map<string, string>([
			[
				"/config/games.yaml",
				"games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n",
			],
			["/config/empty.yaml", ""],
		]);

		const loaded = await load(store);

		expect(loaded.collections.games.size).toBe(1);
		expect(loaded.collections.systems.size).toBe(0);
	});

	it("treats _version inside a collection section as metadata", async () => {
		const store = new Map<string, string>([
			[
				"/config/versioned.yaml",
				`games:\n  _version: 1\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
			],
		]);

		const loaded = await load(store);

		expect(loaded.collections.games.size).toBe(1);
		expect(loaded.collections.games.has("_version")).toBe(false);
	});

	it("fails duplicate records with source, collection, id, and both paths", async () => {
		const store = new Map<string, string>([
			["/config/a.yaml", "games:\n  smw:\n    name: One\n    systemId: snes\n"],
			["/config/b.yaml", "games:\n  smw:\n    name: Two\n    systemId: snes\n"],
		]);

		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					loadDocumentSources(normalizeSourceConfig(config)),
					makeLayer(store),
				),
			),
		);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(DuplicateRecordError);
			expect(result.failure.collection).toBe("games");
			expect(result.failure.id).toBe("smw");
			expect(result.failure.first.path).toBe("/config/a.yaml");
			expect(result.failure.duplicate.path).toBe("/config/b.yaml");
		}
	});

	it("fails unknown top-level collection keys by default", async () => {
		const store = new Map<string, string>([
			["/config/bad.yaml", "emulators:\n  retroarch:\n    name: RetroArch\n"],
		]);

		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					loadDocumentSources(normalizeSourceConfig(config)),
					makeLayer(store),
				),
			),
		);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(UnknownCollectionError);
			expect(result.failure.path).toBe("/config/bad.yaml");
			expect(result.failure.collection).toBe("emulators");
		}
	});

	it("fails physical id fields in derived-id payloads with file and record context", async () => {
		const store = new Map<string, string>([
			[
				"/config/bad.yaml",
				"games:\n  smw:\n    id: smw\n    name: Super Mario World\n    systemId: snes\n",
			],
		]);

		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					loadDocumentSources(normalizeSourceConfig(config)),
					makeLayer(store),
				),
			),
		);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("ValidationError");
			expect(result.failure.message).toContain("/config/bad.yaml");
			expect(result.failure.message).toContain("smw");
		}
	});
});
