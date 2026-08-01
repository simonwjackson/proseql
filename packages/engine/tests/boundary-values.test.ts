import { describe, expect, it } from "vitest";
import {
	decodeBoundaryValueForHost,
	encodeBoundaryValueForWire,
	parseBoundaryJson,
	serializeBoundaryValue,
} from "../src/boundary-values.js";

describe("boundary value encoding", () => {
	it("round-trips -0, unsafe numbers, nested arrays, and escaped __proseqlFloat64__ objects", () => {
		const value = {
			negativeZero: -0,
			unsafeInteger: 9007199254740992,
			nestedNumbers: [[-0, 1.5], [1326.6499999999999]],
			escapedFloat64Object: {
				__proseqlFloat64__: "user-payload",
				label: "escaped",
			},
		} as const;

		const encoded = encodeBoundaryValueForWire(value);
		const decoded = decodeBoundaryValueForHost(encoded);
		const reparsed = parseBoundaryJson(
			serializeBoundaryValue(value),
		) as typeof value;

		expect(Object.is((decoded as typeof value).negativeZero, -0)).toBe(true);
		expect(Object.is(reparsed.negativeZero, -0)).toBe(true);
		expect(reparsed.unsafeInteger).toBe(9007199254740992);
		expect(reparsed.nestedNumbers).toEqual(value.nestedNumbers);
		expect(reparsed.escapedFloat64Object).toEqual(value.escapedFloat64Object);
	});
});
