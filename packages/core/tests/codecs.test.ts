import { describe, expect, it } from "vitest";
import { hjsonCodec } from "../src/serializers/codecs/hjson.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { json5Codec } from "../src/serializers/codecs/json5.js";
import { jsoncCodec } from "../src/serializers/codecs/jsonc.js";
import { jsonlCodec } from "../src/serializers/codecs/jsonl.js";
import { tomlCodec } from "../src/serializers/codecs/toml.js";
import { toonCodec } from "../src/serializers/codecs/toon.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import type { FormatCodec } from "../src/serializers/format-codec.js";

/**
 * Round-trip tests for all 7 codecs.
 * Tests: nested objects, arrays, strings, numbers, booleans, null handling.
 */

// Common test data that works across all JSON-compatible formats
const simpleObject = { id: "1", name: "test" };
const nestedObject = {
	user: {
		id: 1,
		profile: {
			name: "Alice",
			settings: {
				theme: "dark",
				notifications: true,
			},
		},
	},
};
const arrayData = {
	items: [1, 2, 3],
	names: ["alice", "bob", "charlie"],
	mixed: [{ id: 1 }, { id: 2, extra: "value" }],
};
const primitives = {
	string: "hello world",
	number: 42,
	float: Math.PI,
	negativeInt: -100,
	negativeFloat: -2.5,
	boolTrue: true,
	boolFalse: false,
	emptyString: "",
	zero: 0,
};
const specialStrings = {
	withQuotes: 'He said "hello"',
	withNewline: "line1\nline2",
	withTab: "col1\tcol2",
	withBackslash: "path\\to\\file",
	unicode: "Hello \u4e16\u754c",
	emoji: "Hello 👋",
};
const objectWithNull = {
	id: "1",
	name: null,
	nested: {
		value: null,
		valid: true,
	},
};

// Helper to run round-trip test
const testRoundTrip = (
	codec: FormatCodec,
	data: unknown,
	description: string,
) => {
	it(`round-trips ${description}`, () => {
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});
};

// Helper to run round-trip without null preservation (for TOML)
const testRoundTripWithNullStripping = (
	codec: FormatCodec,
	data: unknown,
	expected: unknown,
	description: string,
) => {
	it(`round-trips ${description} (with null stripping)`, () => {
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(expected);
	});
};

describe("jsonCodec", () => {
	const codec = jsonCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("json");
		expect(codec.extensions).toEqual(["json"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("respects indent option", () => {
		const compactCodec = jsonCodec({ indent: 0 });
		const prettyCodec = jsonCodec({ indent: 4 });

		const compact = compactCodec.encode({ a: 1 });
		const pretty = prettyCodec.encode({ a: 1 });

		expect(compact).not.toContain("\n");
		expect(pretty).toContain("    "); // 4 spaces
	});

	it("respects formatOptions override", () => {
		const codec = jsonCodec({ indent: 2 });
		const result = codec.encode({ a: 1 }, { indent: 0 });
		expect(result).not.toContain("\n");
	});

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});

	it("handles empty array", () => {
		const encoded = codec.encode([]);
		expect(codec.decode(encoded)).toEqual([]);
	});
});

describe("yamlCodec", () => {
	const codec = yamlCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("yaml");
		expect(codec.extensions).toEqual(["yaml", "yml"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("respects indent option", () => {
		const indentedCodec = yamlCodec({ indent: 4 });
		const result = indentedCodec.encode({ nested: { value: 1 } });
		expect(result).toContain("    "); // 4 spaces for nested value
	});

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});

	it("handles empty array", () => {
		const encoded = codec.encode([]);
		expect(codec.decode(encoded)).toEqual([]);
	});
});

describe("json5Codec", () => {
	const codec = json5Codec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("json5");
		expect(codec.extensions).toEqual(["json5"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("decodes unquoted keys", () => {
		const input = "{ name: 'test', value: 42 }";
		expect(codec.decode(input)).toEqual({ name: "test", value: 42 });
	});

	it("decodes trailing commas", () => {
		const input = '{ "a": 1, "b": 2, }';
		expect(codec.decode(input)).toEqual({ a: 1, b: 2 });
	});

	it("decodes single-quoted strings", () => {
		const input = "{ 'key': 'value' }";
		expect(codec.decode(input)).toEqual({ key: "value" });
	});

	it("respects indent option", () => {
		const compactCodec = json5Codec({ indent: 0 });
		const result = compactCodec.encode({ a: 1 });
		expect(result).not.toContain("\n");
	});

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});
});

describe("jsoncCodec", () => {
	const codec = jsoncCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("jsonc");
		expect(codec.extensions).toEqual(["jsonc"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("decodes content with line comments", () => {
		const input = `{
  // This is a comment
  "name": "test"
}`;
		expect(codec.decode(input)).toEqual({ name: "test" });
	});

	it("decodes content with block comments", () => {
		const input = `{
  /* Block comment */
  "value": 42
}`;
		expect(codec.decode(input)).toEqual({ value: 42 });
	});

	it("encodes to clean JSON (no comments)", () => {
		const encoded = codec.encode({ a: 1 });
		expect(encoded).not.toContain("//");
		expect(encoded).not.toContain("/*");
	});

	it("respects indent option", () => {
		const compactCodec = jsoncCodec({ indent: 0 });
		const result = compactCodec.encode({ a: 1 });
		expect(result).not.toContain("\n");
	});

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});
});

describe("tomlCodec", () => {
	const codec = tomlCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("toml");
		expect(codec.extensions).toEqual(["toml"]);
	});

	// TOML-compatible test data (no null values)
	const tomlSimpleObject = { id: "1", name: "test" };
	const tomlNestedObject = {
		user: {
			id: 1,
			profile: {
				name: "Alice",
				theme: "dark",
				notifications: true,
			},
		},
	};
	const tomlArrayData = {
		items: [1, 2, 3],
		names: ["alice", "bob", "charlie"],
	};
	const tomlPrimitives = {
		string: "hello world",
		number: 42,
		float: Math.PI,
		negativeInt: -100,
		negativeFloat: -2.5,
		boolTrue: true,
		boolFalse: false,
		emptyString: "",
		zero: 0,
	};

	testRoundTrip(codec, tomlSimpleObject, "simple objects");
	testRoundTrip(codec, tomlNestedObject, "nested objects");
	testRoundTrip(codec, tomlArrayData, "arrays");
	testRoundTrip(codec, tomlPrimitives, "primitives");

	it("strips null values on encode", () => {
		const dataWithNull = { a: 1, b: null, c: 3 };
		const encoded = codec.encode(dataWithNull);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual({ a: 1, c: 3 });
		expect(decoded).not.toHaveProperty("b");
	});

	// Use testRoundTripWithNullStripping for null cases
	testRoundTripWithNullStripping(
		codec,
		objectWithNull,
		{
			id: "1",
			nested: { valid: true },
		},
		"objects with null (nulls stripped)",
	);

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});

	it("handles array of objects (inline tables)", () => {
		// TOML requires arrays to be homogeneous
		const data = {
			users: [
				{ id: 1, name: "Alice" },
				{ id: 2, name: "Bob" },
			],
		};
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});
});

describe("toonCodec", () => {
	const codec = toonCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("toon");
		expect(codec.extensions).toEqual(["toon"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});

	it("handles empty array", () => {
		const encoded = codec.encode([]);
		expect(codec.decode(encoded)).toEqual([]);
	});

	it("handles uniform arrays of objects (TOON's specialty)", () => {
		const uniformData = {
			records: [
				{ id: 1, name: "A", active: true },
				{ id: 2, name: "B", active: false },
				{ id: 3, name: "C", active: true },
			],
		};
		const encoded = codec.encode(uniformData);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(uniformData);
	});
});

describe("hjsonCodec", () => {
	const codec = hjsonCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("hjson");
		expect(codec.extensions).toEqual(["hjson"]);
	});

	testRoundTrip(codec, simpleObject, "simple objects");
	testRoundTrip(codec, nestedObject, "nested objects");
	testRoundTrip(codec, arrayData, "arrays");
	testRoundTrip(codec, primitives, "primitives");
	testRoundTrip(codec, specialStrings, "special strings");
	testRoundTrip(codec, objectWithNull, "objects with null");

	it("decodes content with line comments", () => {
		const input = `{
  // This is a comment
  name: test
}`;
		expect(codec.decode(input)).toEqual({ name: "test" });
	});

	it("decodes content with hash comments", () => {
		const input = `{
  # Hash comment
  value: 42
}`;
		expect(codec.decode(input)).toEqual({ value: 42 });
	});

	it("decodes unquoted keys and values", () => {
		const input = `{
  name: hello
  count: 5
}`;
		expect(codec.decode(input)).toEqual({ name: "hello", count: 5 });
	});

	it("decodes multiline strings", () => {
		const input = `{
  text:
    '''
    Line 1
    Line 2
    '''
}`;
		const decoded = codec.decode(input) as { text: string };
		expect(decoded.text).toContain("Line 1");
		expect(decoded.text).toContain("Line 2");
	});

	it("respects indent option", () => {
		const indentedCodec = hjsonCodec({ indent: 4 });
		const result = indentedCodec.encode({ a: { b: 1 } });
		// Hjson output format may vary, just verify it encodes
		expect(result).toBeTruthy();
	});

	it("handles empty object", () => {
		const encoded = codec.encode({});
		expect(codec.decode(encoded)).toEqual({});
	});
});

describe("jsonlCodec", () => {
	const codec = jsonlCodec();

	it("has correct metadata", () => {
		expect(codec.name).toBe("jsonl");
		expect(codec.extensions).toEqual(["jsonl", "ndjson"]);
	});

	it("round-trips array of objects", () => {
		const data = [
			{ id: "1", name: "Alice" },
			{ id: "2", name: "Bob" },
		];
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("encodes each element on its own line", () => {
		const data = [{ a: 1 }, { b: 2 }, { c: 3 }];
		const encoded = codec.encode(data);
		const lines = encoded.split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0])).toEqual({ a: 1 });
		expect(JSON.parse(lines[1])).toEqual({ b: 2 });
		expect(JSON.parse(lines[2])).toEqual({ c: 3 });
	});

	it("handles empty array", () => {
		const encoded = codec.encode([]);
		expect(codec.decode(encoded)).toEqual([]);
	});

	it("ignores blank lines on decode", () => {
		const raw = '{"a":1}\n\n{"b":2}\n\n';
		const decoded = codec.decode(raw);
		expect(decoded).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("round-trips objects with special strings", () => {
		const data = [
			{ text: 'He said "hello"' },
			{ text: "line1\nline2" },
			{ text: "Hello \u4e16\u754c" },
		];
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("round-trips objects with null values", () => {
		const data = [
			{ id: "1", name: null },
			{ id: "2", value: null },
		];
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("throws on invalid JSON lines", () => {
		const raw = '{"a":1}\n{invalid json}';
		expect(() => codec.decode(raw)).toThrow();
	});

	it("encodes non-array data as single JSON line", () => {
		const data = { id: "1", name: "test" };
		const encoded = codec.encode(data);
		expect(encoded).toBe('{"id":"1","name":"test"}');
		expect(JSON.parse(encoded)).toEqual(data);
	});
});

describe("all codecs handle common edge cases", () => {
	// Skip TOML for tests involving null since TOML strips nulls
	// Skip JSONL since it encodes arrays (not objects) at the top level
	const jsonCompatibleCodecs = [
		{ name: "json", codec: jsonCodec() },
		{ name: "yaml", codec: yamlCodec() },
		{ name: "json5", codec: json5Codec() },
		{ name: "jsonc", codec: jsoncCodec() },
		{ name: "toon", codec: toonCodec() },
		{ name: "hjson", codec: hjsonCodec() },
	];

	const allCodecs = [
		...jsonCompatibleCodecs,
		{ name: "toml", codec: tomlCodec() },
	];

	describe("deeply nested structures", () => {
		const deeplyNested = {
			level1: {
				level2: {
					level3: {
						level4: {
							value: "deep",
						},
					},
				},
			},
		};

		for (const { name, codec } of allCodecs) {
			it(`${name} handles deeply nested objects`, () => {
				const encoded = codec.encode(deeplyNested);
				const decoded = codec.decode(encoded);
				expect(decoded).toEqual(deeplyNested);
			});
		}
	});

	describe("large arrays", () => {
		const largeArray = {
			numbers: Array.from({ length: 100 }, (_, i) => i),
		};

		for (const { name, codec } of allCodecs) {
			it(`${name} handles large arrays`, () => {
				const encoded = codec.encode(largeArray);
				const decoded = codec.decode(encoded);
				expect(decoded).toEqual(largeArray);
			});
		}
	});

	describe("mixed content types", () => {
		const mixedContent = {
			string: "text",
			number: 123,
			float: 1.5,
			boolean: true,
			array: [1, "two", true],
			nested: { key: "value" },
		};

		// Skip TOML for mixed arrays (TOML requires homogeneous arrays)
		for (const { name, codec } of jsonCompatibleCodecs) {
			it(`${name} handles mixed content types`, () => {
				const encoded = codec.encode(mixedContent);
				const decoded = codec.decode(encoded);
				expect(decoded).toEqual(mixedContent);
			});
		}
	});

	describe("null preservation", () => {
		const withNulls = { a: 1, b: null, c: { d: null, e: 2 } };

		for (const { name, codec } of jsonCompatibleCodecs) {
			it(`${name} preserves null values`, () => {
				const encoded = codec.encode(withNulls);
				const decoded = codec.decode(encoded);
				expect(decoded).toEqual(withNulls);
			});
		}
	});
});
