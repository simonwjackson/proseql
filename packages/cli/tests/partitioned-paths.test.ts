import { Schema } from "effect";
import { expect, it } from "vitest";
import { resolveConfigPaths } from "../src/config/paths.js";

it("resolves partition roots relative to the config file", () => {
	const config = {
		collections: {
			turns: {
				schema: Schema.Struct({ id: Schema.String }),
				relationships: {},
			},
		},
		sources: [
			{
				id: "turns",
				kind: "partitioned",
				collection: "turns",
				root: "./turns",
				format: "jsonl",
				partitionBy: { kind: "prefix", field: "id", delimiter: "." },
			},
		],
	} as const;
	expect(resolveConfigPaths(config, "/data/config.ts")).toEqual({
		...config,
		sources: [{ ...config.sources[0], root: "/data/turns" }],
	});
});
