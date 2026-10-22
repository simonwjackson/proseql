// Parity check for the legacy TypeScript YAML codec (the `yaml` package):
// encode then decode returns the same value for the shapes and strings that
// broke the native Rust encoder, at indents 2 and 4 and widths 20, 80, 120.

import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { LONG_TEXT, YAML_HAZARDS } from "./fixtures/yaml-hazards.js";

const shapes = (text: string): ReadonlyArray<unknown> => [
	{ k: text },
	{ [text]: 1 },
	[text],
	[{ k: text, j: text }],
	{
		meals: {
			"meal-x": {
				items: [
					{ food: text, quantity: 1 },
					{ food: `${LONG_TEXT} ${text}`, quantity: 1.5 },
				],
			},
		},
	},
	{ deep: [[{ food: `${LONG_TEXT} ${text}`, note: text }]] },
];

describe("yamlCodec round trip", () => {
	for (const indent of [2, 4]) {
		for (const lineWidth of [20, 80, 120]) {
			it(`reads back every hazard at indent ${indent}, width ${lineWidth}`, () => {
				const codec = yamlCodec({ indent, lineWidth });
				const failures: Array<string> = [];
				for (const text of YAML_HAZARDS) {
					shapes(text).forEach((value, shape) => {
						const encoded = codec.encode(value);
						let decoded: unknown;
						try {
							decoded = codec.decode(encoded);
						} catch (error) {
							decoded = error;
						}
						if (!isDeepStrictEqual(decoded, value)) {
							failures.push(
								`${JSON.stringify(text)} shape ${shape}: ${JSON.stringify(encoded)}`,
							);
						}
					});
				}
				expect(failures).toEqual([]);
			});
		}
	}
});
