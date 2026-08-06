import { describe, expect, it } from "vitest";
import { hjsonCodec } from "../src/serializers/codecs/hjson.js";

describe("hjsonCodec", () => {
	it("round-trips Hjson through the browser-safe bundle", () => {
		const codec = hjsonCodec({ indent: 2 });
		const encoded = codec.encode({ title: "Dune", tags: ["sci-fi"] });
		expect(encoded).toContain("title: Dune");
		expect(codec.decode(encoded)).toEqual({
			title: "Dune",
			tags: ["sci-fi"],
		});
	});

	it("decodes comments and unquoted values", () => {
		const codec = hjsonCodec();
		expect(codec.decode("# book\ntitle: Dune")).toEqual({ title: "Dune" });
	});
});
