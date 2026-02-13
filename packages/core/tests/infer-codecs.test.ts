import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { inferCodecsFromConfig } from "../src/serializers/infer-codecs.js";
import type { DatabaseConfig } from "../src/types/database-config-types.js";

const TestSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

describe("inferCodecsFromConfig", () => {
	it("returns yaml codec for a .yaml config", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.yaml",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(1);
		expect(codecs[0].name).toBe("yaml");
	});

	it("returns multiple codecs for mixed formats", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.yaml",
				relationships: {},
			},
			users: {
				schema: TestSchema,
				file: "./data/users.json",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(2);
		const names = codecs.map((c) => c.name);
		expect(names).toContain("yaml");
		expect(names).toContain("json");
	});

	it("deduplicates: two .yaml collections produce one yaml codec", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.yaml",
				relationships: {},
			},
			authors: {
				schema: TestSchema,
				file: "./data/authors.yaml",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(1);
		expect(codecs[0].name).toBe("yaml");
	});

	it("deduplicates .yaml and .yml to a single codec", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.yaml",
				relationships: {},
			},
			authors: {
				schema: TestSchema,
				file: "./data/authors.yml",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(1);
		expect(codecs[0].name).toBe("yaml");
	});

	it("skips in-memory collections (no file field)", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(0);
	});

	it("returns empty array for all-in-memory config", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				relationships: {},
			},
			users: {
				schema: TestSchema,
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(0);
	});

	it("respects format override (.md file with format: prose)", () => {
		const config: DatabaseConfig = {
			catalog: {
				schema: TestSchema,
				file: "./docs/catalog.md",
				format: "prose",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(1);
		expect(codecs[0].name).toBe("prose");
	});

	it("format override takes precedence over file extension", () => {
		const config: DatabaseConfig = {
			data: {
				schema: TestSchema,
				file: "./data/items.json",
				format: "yaml",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(1);
		expect(codecs[0].name).toBe("yaml");
	});

	it("skips unknown extensions gracefully", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.xyz",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(0);
	});

	it("handles all supported extensions", () => {
		const config: DatabaseConfig = {
			a: { schema: TestSchema, file: "./a.json", relationships: {} },
			b: { schema: TestSchema, file: "./b.yaml", relationships: {} },
			c: { schema: TestSchema, file: "./c.json5", relationships: {} },
			d: { schema: TestSchema, file: "./d.jsonc", relationships: {} },
			e: { schema: TestSchema, file: "./e.jsonl", relationships: {} },
			f: { schema: TestSchema, file: "./f.toml", relationships: {} },
			g: { schema: TestSchema, file: "./g.toon", relationships: {} },
			h: { schema: TestSchema, file: "./h.hjson", relationships: {} },
			i: { schema: TestSchema, file: "./i.prose", relationships: {} },
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(9);
	});

	it("mixes in-memory and persistent collections", () => {
		const config: DatabaseConfig = {
			books: {
				schema: TestSchema,
				file: "./data/books.yaml",
				relationships: {},
			},
			cache: {
				schema: TestSchema,
				relationships: {},
			},
			users: {
				schema: TestSchema,
				file: "./data/users.json",
				relationships: {},
			},
		};

		const codecs = inferCodecsFromConfig(config);
		expect(codecs).toHaveLength(2);
		const names = codecs.map((c) => c.name);
		expect(names).toContain("yaml");
		expect(names).toContain("json");
	});
});
