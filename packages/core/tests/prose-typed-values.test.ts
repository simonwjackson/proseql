/**
 * A Prose file must give back every value with the type it was written with.
 * Mirrors crates/proseql-formats/tests/prose_typed_values.rs.
 */
import { describe, expect, it } from "vitest";
import { proseCodec } from "../src/serializers/codecs/prose.js";

const roundTrip = (template: string, records: ReadonlyArray<unknown>) => {
	const codec = proseCodec({ template });
	return codec.decode(codec.encode(records));
};

describe("Prose typed values", () => {
	it("keeps a spoken number in the last field as a string", () => {
		// 2026-10-01 call, turn 209: Susan reads out a booking total.
		const records = [{ id: "t209", t: "19:00", speaker: "SV", text: "35143" }];
		expect(roundTrip("[{id}] {t} {speaker}: {text}", records)).toEqual(records);
	});

	it("keeps strings that read as other types as strings in any field", () => {
		const records = [
			{ id: "1", a: "true", b: "~", c: "007" },
			{ id: "2", a: "false", b: "[x, y]", c: "-3.5" },
			{ id: "3", a: '"quoted"', b: '"open', c: "plain" },
		];
		expect(roundTrip("{id} | {a} | {b} | {c}", records)).toEqual(records);
	});

	it("keeps typed values typed", () => {
		const records = [
			{ id: "1", n: 42, f: -3.5, b: true, z: null, tags: ["a", "42", 7] },
		];
		expect(roundTrip("{id}: {n} {f} {b} {z} {tags}", records)).toEqual(records);
	});

	it("keeps an array that contains the next delimiter", () => {
		const records = [{ id: "1", tags: ["crescent", "columbia"], rest: "x" }];
		expect(roundTrip("{id}, {tags}, {rest}", records)).toEqual(records);
	});

	it("keeps a value that starts with a quote inside a quoted template literal", () => {
		const records = [{ id: 1, title: '"Hi" there', author: "Liz" }];
		expect(roundTrip('#{id} "{title}" by {author}', records)).toEqual(records);
	});

	it("fails to encode a number that contains the next delimiter", () => {
		const codec = proseCodec({ template: "{a}.{b}" });
		expect(() => codec.encode([{ a: 3.25, b: "x" }])).toThrow(/field 'a'/);
	});
});
