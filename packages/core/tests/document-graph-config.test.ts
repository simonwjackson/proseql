import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SourceConfigError } from "../src/errors/source-errors.js";
import {
	type NormalizedDocumentGraphSourceConfig,
	normalizeSourceConfig,
	type SourceOrientedConfigInput,
} from "../src/storage/source-config.js";

const EntitySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const baseCollections = {
	foods: { schema: EntitySchema, relationships: {} },
	drinks: { schema: EntitySchema, relationships: {} },
} as const;

const graphSource = (
	overrides: Record<string, unknown> = {},
): SourceOrientedConfigInput =>
	({
		collections: baseCollections,
		sources: [
			{
				id: "config-graph",
				kind: "documentGraph",
				include: "**/*.yaml",
				roots: [{ root: "/a" }, { root: "/b" }],
				...overrides,
			},
		],
	}) as SourceOrientedConfigInput;

const onlyGraph = (
	input: SourceOrientedConfigInput,
): NormalizedDocumentGraphSourceConfig => {
	const normalized = normalizeSourceConfig(input);
	const source = normalized.sources[0];
	if (source.kind !== "documentGraph") {
		throw new Error("expected a documentGraph source");
	}
	return source;
};

describe("documentGraph config normalization", () => {
	it("normalizes a graph targeting all collections with resolved roots in order", () => {
		const source = onlyGraph(graphSource());
		expect(source.collections).toEqual(["drinks", "foods"]);
		expect(source.roots.map((r) => r.root)).toEqual(["/a", "/b"]);
		expect(source.roots[0]).toMatchObject({
			root: "/a",
			optional: false,
			include: ["**/*.yaml"],
			exclude: [],
		});
	});

	it("lets a root-level include override the graph-level include", () => {
		const source = onlyGraph(
			graphSource({
				include: "**/*.yaml",
				exclude: "**/ignore/**",
				roots: [
					{ root: "/a" },
					{ root: "/b", include: "**/*.json", exclude: "**/draft/**" },
				],
			}),
		);
		expect(source.roots[0].include).toEqual(["**/*.yaml"]);
		expect(source.roots[1].include).toEqual(["**/*.json"]);
		// graph + root excludes combine
		expect(source.roots[1].exclude).toEqual(["**/ignore/**", "**/draft/**"]);
	});

	it("preserves optional:true and defaults optional to false", () => {
		const source = onlyGraph(
			graphSource({
				roots: [{ root: "/a", optional: true }, { root: "/b" }],
			}),
		);
		expect(source.roots[0].optional).toBe(true);
		expect(source.roots[1].optional).toBe(false);
	});

	it("fails when neither graph nor a root provides an include", () => {
		expect(() =>
			normalizeSourceConfig(
				graphSource({ include: undefined, roots: [{ root: "/a" }] }),
			),
		).toThrowError(SourceConfigError);
	});

	it("rejects a collection owned by both a documentGraph and a documents source", () => {
		const input: SourceOrientedConfigInput = {
			collections: baseCollections,
			sources: [
				{
					id: "writable",
					kind: "documents",
					root: "/w",
					include: "**/*.yaml",
					format: "yaml",
					collections: ["foods"],
					outbox: "/w/generated.yaml",
				},
				{
					id: "config-graph",
					kind: "documentGraph",
					include: "**/*.yaml",
					collections: ["foods"],
					roots: [{ root: "/a" }],
				},
			],
		} as SourceOrientedConfigInput;
		let error: unknown;
		try {
			normalizeSourceConfig(input);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SourceConfigError);
		expect((error as SourceConfigError).message).toContain("writable");
		expect((error as SourceConfigError).message).toContain("config-graph");
	});

	it("rejects a graph referencing an undeclared collection", () => {
		expect(() =>
			normalizeSourceConfig(graphSource({ collections: ["missing"] })),
		).toThrowError(SourceConfigError);
	});
});
