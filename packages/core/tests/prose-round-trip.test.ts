import { describe, expect, it } from "vitest";
import { proseCodec } from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose codec round-trip (encode → decode).
 * Task 8.4: flat records, records with overflow, records with quoting,
 * empty collection, mixed pass-through text
 *
 * Note: The prose codec uses heuristic type detection during decode.
 * Numeric strings like "1" are decoded as numbers, "true"/"false" as booleans,
 * "~" as null. Tests use values that round-trip correctly under these rules.
 */

describe("proseCodec round-trip", () => {
	describe("flat records", () => {
		it("round-trips a single flat record", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			// Use numeric IDs since "1" decodes as number 1
			const records = [{ id: 1, name: "Alice" }];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips multiple flat records", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			const records = [
				{ id: 1, name: "Alice" },
				{ id: 2, name: "Bob" },
				{ id: 3, name: "Charlie" },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with multiple fields", () => {
			const codec = proseCodec({
				template: '#{id} "{title}" by {author} ({year})',
			});

			const records = [
				{ id: 1, title: "Dune", author: "Frank Herbert", year: 1965 },
				{ id: 2, title: "Neuromancer", author: "William Gibson", year: 1984 },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with different value types", () => {
			const codec = proseCodec({
				template: "{id}: {count} items, active: {active}",
			});

			const records = [
				{ id: "item1", count: 42, active: true },
				{ id: "item2", count: 0, active: false },
				{ id: "item3", count: -5, active: true },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with null values", () => {
			const codec = proseCodec({
				template: "{id}: {value}",
			});

			const records = [
				{ id: "a", value: null },
				{ id: "b", value: "text" },
				{ id: "c", value: null },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with floating point numbers", () => {
			const codec = proseCodec({
				template: "{id}: {rating}",
			});

			const records = [
				{ id: "a", rating: 4.5 },
				{ id: "b", rating: -3.14 },
				{ id: "c", rating: 0.001 },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with boolean values", () => {
			const codec = proseCodec({
				template: "{id}: {enabled}",
			});

			const records = [
				{ id: "a", enabled: true },
				{ id: "b", enabled: false },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});
	});

	describe("records with overflow", () => {
		it("round-trips records with single overflow field", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["~ {description}"],
			});

			const records = [
				{ id: 1, title: "Dune", description: "A sci-fi classic" },
				{ id: 2, title: "Neuromancer", description: "Cyberpunk pioneer" },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with multiple overflow fields", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["tagged {tags}", "~ {description}"],
			});

			const records = [
				{
					id: 1,
					title: "Dune",
					tags: ["sci-fi", "classic"],
					description: "A masterpiece",
				},
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records where some overflow fields are null", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["tagged {tags}", "~ {description}"],
			});

			const records = [
				{ id: 1, title: "Dune", tags: null, description: "A masterpiece" },
				{ id: 2, title: "Neuromancer", tags: ["cyberpunk"], description: null },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			// Null overflow fields are omitted from encoding, so they won't appear in decoded
			// The decoded records will not have those fields at all
			expect(decoded).toEqual([
				{ id: 1, title: "Dune", description: "A masterpiece" },
				{ id: 2, title: "Neuromancer", tags: ["cyberpunk"] },
			]);
		});

		it("round-trips records with array overflow field", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["tagged {tags}"],
			});

			const records = [
				{ id: 1, title: "Dune", tags: ["sci-fi", "classic", "desert"] },
				{ id: 2, title: "Neuromancer", tags: ["cyberpunk"] },
				{ id: 3, title: "Empty Tags", tags: [] },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with multi-line overflow value", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["~ {description}"],
			});

			const records = [
				{
					id: 1,
					title: "Dune",
					description: "A epic saga\nspanning generations\nof conflict",
				},
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with mixed overflow presence", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["~ {description}"],
			});

			const records = [
				{ id: 1, title: "Dune", description: "Has description" },
				{ id: 2, title: "Neuromancer" }, // No description field
				{ id: 3, title: "Snow Crash", description: "Another one" },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			// Records without the overflow field won't have it in decoded output
			expect(decoded).toEqual([
				{ id: 1, title: "Dune", description: "Has description" },
				{ id: 2, title: "Neuromancer" },
				{ id: 3, title: "Snow Crash", description: "Another one" },
			]);
		});
	});

	describe("records with quoting", () => {
		it("round-trips records where value contains delimiter", () => {
			const codec = proseCodec({
				template: '#{id} "{title}" ({year})',
			});

			// Title contains quote character which is a delimiter
			const records = [{ id: 1, title: 'Say "Hello"', year: 2024 }];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with values containing parentheses", () => {
			const codec = proseCodec({
				template: "{id}: {name} ({note})",
			});

			// Name contains the delimiter " ("
			// Use string ID that doesn't look numeric
			const records = [
				{ id: "item-a", name: "Test (with parens)", note: "works" },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with values containing colons", () => {
			const codec = proseCodec({
				template: "{id}: {message}",
			});

			// First field value contains the delimiter ":"
			const records = [{ id: "note: important", message: "test" }];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips records with complex quoting scenarios", () => {
			const codec = proseCodec({
				template: '{id} - "{title}" by {author}',
			});

			const records = [
				// Title contains the delimiter '" by '
				{ id: 1, title: 'A "Quote" by Someone', author: "Author" },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips arrays with elements containing commas", () => {
			const codec = proseCodec({
				template: "{id}: {items}",
			});

			const records = [
				{ id: "item-a", items: ["one, two", "three"] },
				{ id: "item-b", items: ["has, many, commas"] },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips arrays with elements containing brackets", () => {
			const codec = proseCodec({
				template: "{id}: {items}",
			});

			const records = [{ id: "item-a", items: ["has]bracket", "normal"] }];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips arrays with elements containing quotes", () => {
			const codec = proseCodec({
				template: "{id}: {items}",
			});

			const records = [{ id: "item-a", items: ['has "quotes"', "normal"] }];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips last field without quoting (greedy capture)", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
			});

			// Last field can contain anything without quoting
			const records = [
				{ id: 1, title: 'Contains: colons and "quotes" freely' },
			];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});
	});

	describe("empty collection", () => {
		it("round-trips empty array", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			const records: Array<Record<string, unknown>> = [];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("round-trips empty array with overflow templates", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
				overflow: ["tagged {tags}", "~ {description}"],
			});

			const records: Array<Record<string, unknown>> = [];

			const encoded = codec.encode(records);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(records);
		});

		it("encoded empty collection still contains directive", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			const encoded = codec.encode([]);

			expect(encoded).toContain("@prose #{id} {name}");
		});
	});

	describe("mixed pass-through text (v1 behavior)", () => {
		// Note: In v1, pass-through text is NOT preserved through ProseQL mutation cycles.
		// The decode captures records, encode emits only records.
		// These tests verify that pass-through text in input is correctly ignored
		// when extracting records, but is not preserved in re-encoded output.

		it("decodes records ignoring pass-through text between them", () => {
			const codec = proseCodec({
				// Use a template that won't match markdown headings
				template: "BOOK #{id} {title}",
			});

			// Input with blank lines and other text between records
			const input = `@prose BOOK #{id} {title}

BOOK #1 Dune

Some pass-through text.

BOOK #2 Neuromancer

More text here.

BOOK #3 The Hobbit`;

			const decoded = codec.decode(input) as Array<Record<string, unknown>>;

			// All three records should be extracted
			expect(decoded).toEqual([
				{ id: 1, title: "Dune" },
				{ id: 2, title: "Neuromancer" },
				{ id: 3, title: "The Hobbit" },
			]);
		});

		it("re-encoding after decode loses pass-through text", () => {
			const codec = proseCodec({
				template: "BOOK #{id} {title}",
			});

			// Input with pass-through text
			const inputWithPassthrough = `@prose BOOK #{id} {title}

Some intro text.

BOOK #1 Dune

This is pass-through text.

BOOK #2 Neuromancer`;

			// Decode extracts records
			const decoded = codec.decode(inputWithPassthrough);

			// Re-encode produces clean output without pass-through
			const reEncoded = codec.encode(decoded);

			// The re-encoded output should only have directive and records
			expect(reEncoded).toBe(`@prose BOOK #{id} {title}

BOOK #1 Dune
BOOK #2 Neuromancer`);
		});

		it("decodes records from file with preamble", () => {
			const codec = proseCodec({
				template: "ITEM #{id} {title}",
			});

			// Input with markdown preamble before directive
			const input = `# My Book Collection

A curated list of favorites.

@prose ITEM #{id} {title}

ITEM #1 Dune
ITEM #2 Neuromancer`;

			const decoded = codec.decode(input) as Array<Record<string, unknown>>;

			expect(decoded).toEqual([
				{ id: 1, title: "Dune" },
				{ id: 2, title: "Neuromancer" },
			]);
		});

		it("preamble is not preserved in re-encoded output", () => {
			const codec = proseCodec({
				template: "ITEM #{id} {title}",
			});

			// Input with preamble
			const inputWithPreamble = `# Header

Intro text.

@prose ITEM #{id} {title}

ITEM #1 Dune`;

			const decoded = codec.decode(inputWithPreamble);
			const reEncoded = codec.encode(decoded);

			// Preamble is lost
			expect(reEncoded).not.toContain("# Header");
			expect(reEncoded).not.toContain("Intro text");
			expect(reEncoded).toBe(`@prose ITEM #{id} {title}

ITEM #1 Dune`);
		});

		it("handles embedded markdown with record-looking non-matching lines", () => {
			const codec = proseCodec({
				// Use a template that requires (year) - plain lines without it won't match
				template: "BOOK #{id} {title} ({year})",
			});

			// Line "BOOK #1 Dune" does not match because it lacks the (year) part
			const input = `@prose BOOK #{id} {title} ({year})

# Books Section

BOOK #1 Dune
BOOK #2 Neuromancer (1984)`;

			const decoded = codec.decode(input) as Array<Record<string, unknown>>;

			// Only the second record matches the template
			expect(decoded).toEqual([{ id: 2, title: "Neuromancer", year: 1984 }]);
		});
	});

	describe("encode/decode consistency", () => {
		it("decode(encode(x)) === x for well-formed records", () => {
			const codec = proseCodec({
				template: '#{id} "{title}" by {author}',
				overflow: ["tagged {tags}", "~ {description}"],
			});

			const original = [
				{
					id: 1,
					title: "Dune",
					author: "Frank Herbert",
					tags: ["sci-fi", "classic"],
					description: "A masterpiece",
				},
				{
					id: 2,
					title: "Neuromancer",
					author: "William Gibson",
					tags: ["cyberpunk"],
					description: "Groundbreaking",
				},
			];

			const encoded = codec.encode(original);
			const decoded = codec.decode(encoded);

			expect(decoded).toEqual(original);
		});

		it("multiple encode/decode cycles produce same result", () => {
			const codec = proseCodec({
				// Use string IDs that won't be converted to numbers
				template: "id-{id} {name}: {score}",
			});

			const original = [
				{ id: "alice", name: "Alice", score: 95 },
				{ id: "bob", name: "Bob", score: 87 },
			];

			// Cycle 1
			const cycle1Encoded = codec.encode(original);
			const cycle1Decoded = codec.decode(cycle1Encoded);

			// Cycle 2
			const cycle2Encoded = codec.encode(cycle1Decoded);
			const cycle2Decoded = codec.decode(cycle2Encoded);

			// Cycle 3
			const cycle3Encoded = codec.encode(cycle2Decoded);
			const cycle3Decoded = codec.decode(cycle3Encoded);

			expect(cycle1Decoded).toEqual(original);
			expect(cycle2Decoded).toEqual(original);
			expect(cycle3Decoded).toEqual(original);

			// Encoded forms should also be identical
			expect(cycle2Encoded).toBe(cycle1Encoded);
			expect(cycle3Encoded).toBe(cycle1Encoded);
		});

		it("encode produces valid structure", () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["~ {description}"],
			});

			const records = [{ id: 1, title: "Dune", description: "A classic" }];

			const encoded = codec.encode(records);
			const lines = encoded.split("\n");

			// First line should be the directive
			expect(lines[0]).toBe("@prose #{id} {title}");

			// Second line should be the overflow declaration
			expect(lines[1]).toBe("  ~ {description}");

			// Third line should be blank (separator)
			expect(lines[2]).toBe("");

			// Fourth line should be the record headline
			expect(lines[3]).toBe("#1 Dune");

			// Fifth line should be the overflow
			expect(lines[4]).toBe("  ~ A classic");
		});
	});

	describe("error cases", () => {
		it("encode throws for non-array input", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			expect(() => codec.encode({ id: "1", name: "Alice" })).toThrow(
				/expects an array/,
			);
			expect(() => codec.encode("not an array")).toThrow(/expects an array/);
			expect(() => codec.encode(42)).toThrow(/expects an array/);
		});

		it("decode throws for missing directive", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			expect(() => codec.decode("#1 Alice\n#2 Bob")).toThrow(
				/No @prose directive/,
			);
		});

		it("decode throws for multiple directives", () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});

			const input = `@prose #{id} {name}
#1 Alice
@prose #{id} {other}
#2 Bob`;

			expect(() => codec.decode(input)).toThrow(/Multiple @prose directives/);
		});
	});

	describe("template-less proseCodec", () => {
		it("decodes a .prose file without a constructor template", () => {
			const codec = proseCodec();

			const input = `@prose #{id} {name}

#1 Alice
#2 Bob`;

			const decoded = codec.decode(input);

			expect(decoded).toEqual([
				{ id: 1, name: "Alice" },
				{ id: 2, name: "Bob" },
			]);
		});

		it("can encode after decoding (learns template from file)", () => {
			const codec = proseCodec();

			const input = `@prose #{id} {name}

#1 Alice
#2 Bob`;

			const decoded = codec.decode(input);
			const encoded = codec.encode(decoded);

			expect(encoded).toBe(`@prose #{id} {name}

#1 Alice
#2 Bob`);
		});

		it("encode before decode throws a clear error", () => {
			const codec = proseCodec();

			expect(() => codec.encode([{ id: 1, name: "Alice" }])).toThrow(
				/Cannot encode prose: no template provided/,
			);
		});

		it("learns overflow templates from file", () => {
			const codec = proseCodec();

			const input = `@prose #{id} {title}
  ~ {description}

#1 Dune
  ~ A sci-fi classic
#2 Neuromancer
  ~ Cyberpunk pioneer`;

			const decoded = codec.decode(input);

			expect(decoded).toEqual([
				{ id: 1, title: "Dune", description: "A sci-fi classic" },
				{ id: 2, title: "Neuromancer", description: "Cyberpunk pioneer" },
			]);

			// Re-encode should use learned template including overflow
			const encoded = codec.encode(decoded);

			expect(encoded).toBe(`@prose #{id} {title}
  ~ {description}

#1 Dune
  ~ A sci-fi classic
#2 Neuromancer
  ~ Cyberpunk pioneer`);
		});

		it("round-trips correctly with template-less codec", () => {
			const codec = proseCodec();

			const input = `@prose [{id}] {name}, born {birthYear} — {country}

[1] Frank Herbert, born 1920 — USA
[2] William Gibson, born 1948 — USA`;

			const decoded = codec.decode(input);
			const encoded = codec.encode(decoded);
			const decoded2 = codec.decode(encoded);

			expect(decoded2).toEqual(decoded);
		});

		it("accepts empty options object", () => {
			const codec = proseCodec({});

			const input = `@prose #{id} {name}

#1 Alice`;

			const decoded = codec.decode(input);
			expect(decoded).toEqual([{ id: 1, name: "Alice" }]);
		});
	});
});
