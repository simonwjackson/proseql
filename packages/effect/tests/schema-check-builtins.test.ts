import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "@proseql/effect";

const cases: ReadonlyArray<{
	readonly name: string;
	readonly schema: Schema.Codec<unknown>;
	readonly valid: unknown;
	readonly invalid: unknown;
}> = [
	{
		name: "min length",
		schema: Schema.String.check(Schema.isMinLength(3)),
		valid: "abc",
		invalid: "ab",
	},
	{
		name: "max length counts UTF-16",
		schema: Schema.String.check(Schema.isMaxLength(1)),
		valid: "a",
		invalid: "😀",
	},
	{
		name: "length between",
		schema: Schema.String.check(Schema.isLengthBetween(2, 3)),
		valid: "ab",
		invalid: "a",
	},
	{
		name: "pattern",
		schema: Schema.String.check(Schema.isPattern(/^(a)\1$/)),
		valid: "aa",
		invalid: "ab",
	},
	{
		name: "greater than",
		schema: Schema.Number.check(Schema.isGreaterThan(1)),
		valid: 2,
		invalid: 1,
	},
	{
		name: "greater than or equal",
		schema: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
		valid: 1,
		invalid: 0,
	},
	{
		name: "less than",
		schema: Schema.Number.check(Schema.isLessThan(2)),
		valid: 1,
		invalid: 2,
	},
	{
		name: "less than or equal",
		schema: Schema.Number.check(Schema.isLessThanOrEqualTo(2)),
		valid: 2,
		invalid: 3,
	},
	{
		name: "exclusive range",
		schema: Schema.Number.check(
			Schema.isBetween({
				minimum: 1,
				maximum: 3,
				exclusiveMinimum: true,
				exclusiveMaximum: true,
			}),
		),
		valid: 2,
		invalid: 3,
	},
	{
		name: "safe integer",
		schema: Schema.Number.check(Schema.isInt()),
		valid: 1,
		invalid: 9007199254740992,
	},
	{
		name: "decimal multiple",
		schema: Schema.Number.check(Schema.isMultipleOf(0.1)),
		valid: 0.3,
		invalid: 0.31,
	},
	{
		name: "UUID version",
		schema: Schema.String.check(Schema.isUUID(4)),
		valid: "550e8400-e29b-41d4-a716-446655440000",
		invalid: "550e8400-e29b-11d4-a716-446655440000",
	},
	{
		name: "ULID",
		schema: Schema.String.check(Schema.isULID()),
		valid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		invalid: "01ARZ3NDEKTSV4RRFFQ69G5FAI",
	},
	{
		name: "trimmed",
		schema: Schema.String.check(Schema.isTrimmed()),
		valid: "abc",
		invalid: "\ufeffabc",
	},
	{
		name: "lowercased",
		schema: Schema.String.check(Schema.isLowercased()),
		valid: "àbc",
		invalid: "Àbc",
	},
	{
		name: "uppercased",
		schema: Schema.String.check(Schema.isUppercased()),
		valid: "ÀBC",
		invalid: "àBC",
	},
	{
		name: "capitalized",
		schema: Schema.String.check(Schema.isCapitalized()),
		valid: "Àbc",
		invalid: "àbc",
	},
	{
		name: "uncapitalized",
		schema: Schema.String.check(Schema.isUncapitalized()),
		valid: "àBC",
		invalid: "Àbc",
	},
	{
		name: "starts with",
		schema: Schema.String.check(Schema.isStartsWith("ab")),
		valid: "abc",
		invalid: "cab",
	},
	{
		name: "ends with",
		schema: Schema.String.check(Schema.isEndsWith("ab")),
		valid: "cab",
		invalid: "abc",
	},
	{
		name: "includes",
		schema: Schema.String.check(Schema.isIncludes("ab")),
		valid: "cabc",
		invalid: "acb",
	},
	{
		name: "array minimum",
		schema: Schema.Array(Schema.Number).check(Schema.isMinLength(2)),
		valid: [1, 2],
		invalid: [1],
	},
	{
		name: "array maximum",
		schema: Schema.Array(Schema.Number).check(Schema.isMaxLength(2)),
		valid: [1, 2],
		invalid: [1, 2, 3],
	},
	{
		name: "array length range",
		schema: Schema.Array(Schema.Number).check(Schema.isLengthBetween(1, 2)),
		valid: [1, 2],
		invalid: [],
	},
];

describe("built-in Schema checks on create and update", () => {
	for (const entry of cases) {
		it(entry.name, async () => {
			const schema = Schema.Struct({ id: Schema.String, value: entry.schema });
			const db = await Effect.runPromise(
				createEffectDatabase({ records: { schema, relationships: {} } }),
			);
			await Effect.runPromise(
				db.records.create({ id: "valid", value: entry.valid }),
			);
			for (const operation of [
				db.records.create({ id: "invalid", value: entry.invalid }),
				db.records.update("valid", { value: entry.invalid }),
			]) {
				const result = await Effect.runPromise(Effect.result(operation));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expect(result.failure).toMatchObject({ _tag: "ValidationError" });
			}
			expect(
				(await Effect.runPromise(db.records.findById("valid"))).value,
			).toEqual(entry.valid);
		});
	}
});
