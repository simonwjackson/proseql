import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SourceConfigError } from "../src/errors/source-errors.js";
import { normalizeSourceConfig } from "../src/storage/source-config.js";

const EntitySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const makeConfig = () =>
	({
		collections: {
			games: { schema: EntitySchema, relationships: {} },
			systems: { schema: EntitySchema, relationships: {} },
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
	}) as const;

describe("source config normalization", () => {
	it("normalizes a document source that targets all configured collections", () => {
		const normalized = normalizeSourceConfig(makeConfig());

		expect(normalized.collections).toEqual(["games", "systems"]);
		expect(normalized.sources).toHaveLength(1);
		expect(normalized.sources[0]).toMatchObject({
			id: "library",
			kind: "documents",
			root: "/config",
			format: "yaml",
			collections: ["games", "systems"],
			unknownCollections: "error",
			duplicates: "error",
			outbox: "/config/generated.yaml",
		});
	});

	it("fails when a document source references an undeclared collection", () => {
		const config = {
			...makeConfig(),
			sources: [
				{
					id: "library",
					kind: "documents",
					root: "/config",
					format: "yaml",
					collections: ["games", "emulators"],
					outbox: "/config/generated.yaml",
				},
			],
		} as const;

		expect(() => normalizeSourceConfig(config)).toThrow(SourceConfigError);
		expect(() => normalizeSourceConfig(config)).toThrow("emulators");
	});

	it("fails old-style collection persistence fields in a source-oriented config", () => {
		const config = {
			...makeConfig(),
			collections: {
				games: {
					schema: EntitySchema,
					relationships: {},
					file: "/legacy/games.yaml",
				},
				systems: { schema: EntitySchema, relationships: {} },
			},
		} as const;

		expect(() => normalizeSourceConfig(config)).toThrow(
			"old-style persistence fields",
		);
	});

	it("fails duplicate source ids", () => {
		const first = makeConfig().sources[0];
		const config = {
			...makeConfig(),
			sources: [first, { ...first, root: "/other", outbox: "/other/out.yaml" }],
		} as const;

		expect(() => normalizeSourceConfig(config)).toThrow("Duplicate source id");
	});

	it("fails when the configured outbox is not rediscoverable by its document source", () => {
		const config = {
			...makeConfig(),
			sources: [
				{
					id: "library",
					kind: "documents",
					root: "/config",
					include: "manual/*.yaml",
					format: "yaml",
					collections: "all",
					outbox: "/config/generated.yaml",
				},
			],
		} as const;

		expect(() => normalizeSourceConfig(config)).toThrow("outbox");
	});

	it("fails when two document sources back the same collection", () => {
		const config = {
			...makeConfig(),
			sources: [
				{
					id: "games-source",
					kind: "documents",
					root: "/config/games",
					format: "yaml",
					collections: ["games"],
					outbox: "/config/games/generated.yaml",
				},
				{
					id: "other-games-source",
					kind: "documents",
					root: "/config/other",
					format: "yaml",
					collections: ["games"],
					outbox: "/config/other/generated.yaml",
				},
			],
		} as const;

		expect(() => normalizeSourceConfig(config)).toThrow("games");
		expect(() => normalizeSourceConfig(config)).toThrow(
			"both document sources",
		);
	});
});
