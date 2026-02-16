import { describe, expect, test } from "bun:test";
import { makeProseQLTag } from "@proseql/core";
import { Context, type Effect, Schema } from "effect";
import { type createNodeDatabase, makeProseQLLayer } from "./convenience.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const testConfig = {
	books: {
		schema: BookSchema,
		file: "./test-data/books.json",
		relationships: {},
	},
} as const;

describe("makeProseQLLayer", () => {
	test("creates a layer from GenericTag and config", () => {
		const tag = makeProseQLTag<typeof testConfig>("TestDB");
		const layer = makeProseQLLayer(tag, testConfig);
		// Layer is created without errors
		expect(layer).toBeDefined();
	});

	test("creates a layer from class-based tag and config", () => {
		type DB = Effect.Effect.Success<
			ReturnType<typeof createNodeDatabase<typeof testConfig>>
		>;
		class MyDB extends Context.Tag("MyDB")<MyDB, DB>() {}
		const layer = makeProseQLLayer(MyDB, testConfig);
		expect(layer).toBeDefined();
	});
});
