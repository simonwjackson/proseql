import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeProseQLTag } from "./context-tag.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const testConfig = {
	books: {
		schema: BookSchema,
		file: "./data/books.json",
		relationships: {},
	},
} as const;

describe("makeProseQLTag", () => {
	test("creates a Context.Tag with default id", () => {
		const tag = makeProseQLTag<typeof testConfig>();
		expect(tag.key).toBe("ProseQL");
	});

	test("creates a Context.Tag with custom id", () => {
		const tag = makeProseQLTag<typeof testConfig>("MyDatabase");
		expect(tag.key).toBe("MyDatabase");
	});

	test("tag can be used in Effect.gen", () => {
		const tag = makeProseQLTag<typeof testConfig>("TestDB");
		expect(tag.key).toBe("TestDB");
		// Verify it's usable as a service tag (has pipe method from Effect ecosystem)
		expect(typeof tag.pipe).toBe("function");
	});
});
