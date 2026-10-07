/**
 * With `unmatchedLines: "error"`, a Prose file used as a database cannot lose
 * a line without an error. Mirrors
 * crates/proseql-formats/tests/prose_unmatched_lines.rs.
 */
import { describe, expect, it } from "vitest";
import { proseCodec } from "../src/serializers/codecs/prose.js";

const strict = () =>
	proseCodec({
		template: "[{id}] {t} {speaker}: {text}",
		unmatchedLines: "error",
	});

describe("Prose unmatched lines", () => {
	it("names the line of a hand edit that breaks the template", () => {
		// Turns 12-14 of the second 2026-06-10 call, turn 13 edited so ": " became " - ".
		const file = [
			"@prose [{id}] {t} {speaker}: {text}",
			"",
			"[0012] 2:24 D: Okay.",
			"[0013] 2:25 SJ - On the left-hand side, you'll see a bunch of icons.",
			"[0014] 2:34 D: This, the database projects.",
		].join("\n");
		expect(() => strict().decode(file)).toThrow(
			/line 4 .*\[0013\] 2:25 SJ - On the left/,
		);
	});

	it("rejects a note above the directive", () => {
		const file =
			"# reviewed 2026-10-06\n@prose [{id}] {t} {speaker}: {text}\n\n[1] 0:04 D: Hi";
		expect(() => strict().decode(file)).toThrow(/line 1/);
	});

	it("rejects an indented line without an overflow template", () => {
		const file =
			"@prose [{id}] {t} {speaker}: {text}\n\n[1] 0:04 D: Hi\n  stray note";
		expect(() => strict().decode(file)).toThrow(/line 4/);
	});

	it("accepts blank lines and overflow lines", () => {
		const codec = proseCodec({
			template: "[{id}] {title}",
			overflow: ["~ {description}"],
			unmatchedLines: "error",
		});
		const file =
			"@prose [{id}] {title}\n  ~ {description}\n\n[1] Dune\n  ~ Spice\n    and sand\n\n[2] Emma\n  ~ Matchmaking\n";
		expect(codec.decode(file)).toEqual([
			{ id: 1, title: "Dune", description: "Spice\nand sand" },
			{ id: 2, title: "Emma", description: "Matchmaking" },
		]);
	});

	it("still ignores Markdown around records by default", () => {
		const file = "# Books\n@prose [{id}] {title}\n\nSome prose.\n[1] Dune";
		expect(proseCodec().decode(file)).toEqual([{ id: 1, title: "Dune" }]);
	});
});
