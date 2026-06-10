import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DocumentGraphSourceError } from "../src/errors/source-errors.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { tomlCodec } from "../src/serializers/codecs/toml.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { loadDocumentGraphSources } from "../src/storage/document-graph-source.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import {
	normalizeSourceConfig,
	type SourceOrientedConfigInput,
} from "../src/storage/source-config.js";
import type { DocumentGraphTransform } from "../src/storage/source-config.js";

const FoodPayload = Schema.Struct({
	name: Schema.String,
	macros: Schema.Struct({
		cal: Schema.Number,
		fat: Schema.optional(Schema.Number),
	}),
});

const makeLayer = (store: Map<string, string>) =>
	Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([yamlCodec(), jsonCodec(), tomlCodec()]),
	);

const baseConfig = (
	overrides: Record<string, unknown> = {},
): SourceOrientedConfigInput =>
	({
		collections: {
			foods: {
				schema: FoodPayload,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		},
		sources: [
			{
				id: "graph",
				kind: "documentGraph",
				include: "**/*.{yaml,json,toml}",
				roots: [{ root: "/a" }, { root: "/b" }],
				...overrides,
			},
		],
	}) as SourceOrientedConfigInput;

const load = (
	store: Map<string, string>,
	config: SourceOrientedConfigInput = baseConfig(),
) => {
	const normalized = normalizeSourceConfig(config);
	return Effect.runPromise(
		Effect.provide(loadDocumentGraphSources(normalized), makeLayer(store)),
	);
};

const loadResult = (
	store: Map<string, string>,
	config: SourceOrientedConfigInput = baseConfig(),
) => {
	const normalized = normalizeSourceConfig(config);
	return Effect.runPromise(
		Effect.provide(
			Effect.result(loadDocumentGraphSources(normalized)),
			makeLayer(store),
		),
	);
};

describe("loadDocumentGraphSources", () => {
	it("overlays a later root over an earlier root on a shared record, deep-merging nested objects", async () => {
		const store = new Map<string, string>([
			["/a/base.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
			["/b/over.yaml", "foods:\n  apple:\n    macros: { fat: 2 }\n"],
		]);
		const graph = await load(store);
		const apple = graph.collections.foods.get("apple");
		expect(apple).toEqual({ id: "apple", name: "Apple", macros: { cal: 10, fat: 2 } });
	});

	it("overlays a lexically later file within one root over an earlier file", async () => {
		const store = new Map<string, string>([
			["/a/01-base.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
			["/a/02-over.yaml", "foods:\n  apple:\n    macros: { cal: 99 }\n"],
		]);
		const graph = await load(store, baseConfig({ roots: [{ root: "/a" }] }));
		expect(graph.collections.foods.get("apple")).toMatchObject({
			macros: { cal: 99 },
		});
	});

	it("composes mixed-format fragments (YAML + JSON + TOML) into one graph", async () => {
		const store = new Map<string, string>([
			["/a/y.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
			["/a/j.json", '{ "foods": { "banana": { "name": "Banana", "macros": { "cal": 90 } } } }'],
			["/b/t.toml", "[foods.cherry.macros]\ncal = 5\n[foods.cherry]\nname = \"Cherry\"\n"],
		]);
		const graph = await load(store);
		expect([...graph.collections.foods.keys()].sort()).toEqual([
			"apple",
			"banana",
			"cherry",
		]);
	});

	it("makes a partial overlay valid only after merging with the base record", async () => {
		const store = new Map<string, string>([
			["/a/base.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
			// This fragment alone lacks `name` and would fail validation; merged it is valid.
			["/b/over.yaml", "foods:\n  apple:\n    macros: { cal: 12, fat: 1 }\n"],
		]);
		const graph = await load(store);
		expect(graph.collections.foods.get("apple")).toEqual({
			id: "apple",
			name: "Apple",
			macros: { cal: 12, fat: 1 },
		});
	});

	it("treats empty optional root, empty root, and zero-match glob as empty contributions", async () => {
		const store = new Map<string, string>([
			["/b/empty.yaml", "foods: {}\n"],
		]);
		const config = baseConfig({
			roots: [{ root: "/missing", optional: true }, { root: "/b" }],
		});
		const graph = await load(store, config);
		expect(graph.collections.foods.size).toBe(0);
	});

	it("records contributing paths for an effective record (provenance)", async () => {
		const store = new Map<string, string>([
			["/a/base.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
			["/b/over.yaml", "foods:\n  apple:\n    macros: { fat: 2 }\n"],
		]);
		const graph = await load(store);
		const paths = graph.contributingPaths.get("foods\u0000apple");
		expect(paths).toEqual(["/a/base.yaml", "/b/over.yaml"]);
	});

	it("fails when a matched file has an unregistered extension", async () => {
		const store = new Map<string, string>([
			["/a/data.ini", "foods=bad"],
		]);
		const config = baseConfig({
			include: "**/*",
			roots: [{ root: "/a" }],
		});
		const result = await loadResult(store, config);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(DocumentGraphSourceError);
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"unsupported-extension",
			);
		}
	});

	it("fails when a decode transform returns a Result failure", async () => {
		const store = new Map<string, string>([
			["/a/x.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
		]);
		const transform: DocumentGraphTransform = () =>
			Result.fail(new Error("nope"));
		const result = await loadResult(
			store,
			baseConfig({ roots: [{ root: "/a" }], transform }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"transform-failure",
			);
		}
	});

	it("wraps a thrown transform as an unexpected defect", async () => {
		const store = new Map<string, string>([
			["/a/x.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n"],
		]);
		const transform: DocumentGraphTransform = () => {
			throw new Error("boom");
		};
		const result = await loadResult(
			store,
			baseConfig({ roots: [{ root: "/a" }], transform }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"transform-defect",
			);
		}
	});

	it("fails when a fragment resolves to a non-object", async () => {
		const store = new Map<string, string>([["/a/x.json", "[1, 2, 3]"]]);
		const result = await loadResult(
			store,
			baseConfig({ include: "**/*.json", roots: [{ root: "/a" }] }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"non-object",
			);
		}
	});

	it("fails per file when a fragment contains an unknown top-level collection", async () => {
		const store = new Map<string, string>([
			["/a/x.yaml", "drinks:\n  water: {}\n"],
		]);
		const result = await loadResult(
			store,
			baseConfig({ roots: [{ root: "/a" }] }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			const error = result.failure as DocumentGraphSourceError;
			expect(error.kind).toBe("unknown-collection");
			expect(error.collection).toBe("drinks");
		}
	});

	it("fails an effective record that violates the schema, naming collection, id, and contributing paths", async () => {
		const store = new Map<string, string>([
			["/a/x.yaml", "foods:\n  apple:\n    name: Apple\n    macros: { cal: not-a-number }\n"],
		]);
		const result = await loadResult(
			store,
			baseConfig({ roots: [{ root: "/a" }] }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			const error = result.failure as DocumentGraphSourceError;
			expect(error.kind).toBe("validation");
			expect(error.collection).toBe("foods");
			expect(error.recordId).toBe("apple");
			expect(error.contributingPaths).toContain("/a/x.yaml");
		}
	});

	it("rejects a physical derived-id field in a derived-id payload", async () => {
		const store = new Map<string, string>([
			["/a/x.yaml", "foods:\n  apple:\n    id: apple\n    name: Apple\n    macros: { cal: 10 }\n"],
		]);
		const result = await loadResult(
			store,
			baseConfig({ roots: [{ root: "/a" }] }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"validation",
			);
		}
	});

	it("fails a non-optional missing root", async () => {
		const result = await loadResult(
			new Map(),
			baseConfig({ roots: [{ root: "/gone" }] }),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect((result.failure as DocumentGraphSourceError).kind).toBe(
				"missing-root",
			);
		}
	});
});

describe("loadDocumentGraphSources migrations", () => {
	const VersionedPayload = Schema.Struct({
		title: Schema.String,
	});
	const migrationConfig = (): SourceOrientedConfigInput =>
		({
			collections: {
				foods: {
					schema: VersionedPayload,
					id: { kind: "derivedFromKey", field: "id" },
					version: 2,
					migrations: [
						{
							from: 1,
							to: 2,
							transform: (map: Record<string, unknown>) => {
								const out: Record<string, unknown> = {};
								for (const [id, record] of Object.entries(map)) {
									const value = record as Record<string, unknown>;
									out[id] = { title: value.name ?? value.title };
								}
								return out;
							},
						},
					],
					relationships: {},
				},
			},
			sources: [
				{
					id: "graph",
					kind: "documentGraph",
					include: "**/*.yaml",
					roots: [{ root: "/a" }, { root: "/b" }],
				},
			],
		}) as SourceOrientedConfigInput;

	it("migrates each fragment to the current version before merge, regardless of fragment _version", async () => {
		const store = new Map<string, string>([
			// v1 fragment: uses old `name` field, must be migrated to `title`.
			["/a/old.yaml", "foods:\n  _version: 1\n  apple:\n    name: Apple\n"],
			// v2 fragment: already current shape.
			["/b/new.yaml", "foods:\n  _version: 2\n  banana:\n    title: Banana\n"],
		]);
		const normalized = normalizeSourceConfig(migrationConfig());
		const graph = await Effect.runPromise(
			Effect.provide(
				loadDocumentGraphSources(normalized),
				makeLayer(store),
			),
		);
		expect(graph.collections.foods.get("apple")).toEqual({
			id: "apple",
			title: "Apple",
		});
		expect(graph.collections.foods.get("banana")).toEqual({
			id: "banana",
			title: "Banana",
		});
	});
});
