import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEngineDatabase } from "../src/index.js";

const schema = Schema.Struct({
	id: Schema.String,
	name: Schema.String.check(Schema.isMinLength(3)),
	profile: Schema.Struct({
		alias: Schema.optional(Schema.String.check(Schema.isMinLength(3))),
	}),
});
const config = { users: { schema, relationships: {} } } as const;

describe("schema checks at the engine boundary", () => {
	it("reports schema issues on create and update, including optional nested fields", async () => {
		const db = await createEngineDatabase(config);
		try {
			await db.users.create({ id: "u1", name: "Alice", profile: {} });
			for (const input of [
				{ id: "u2", name: "ab", profile: {} },
				{ id: "u2", name: "Alice", profile: { alias: "ab" } },
			]) {
				const expected = [
					{
						message:
							'Expected a value with a length of at least 3\n  at ["name"]',
						issues: [
							{
								field: "(root)",
								message:
									'Expected a value with a length of at least 3\n  at ["name"]',
							},
						],
						_tag: "ValidationError",
					},
					{
						message:
							'Expected a value with a length of at least 3\n  at ["profile"]["alias"]',
						issues: [
							{
								field: "(root)",
								message:
									'Expected a value with a length of at least 3\n  at ["profile"]["alias"]',
							},
						],
						_tag: "ValidationError",
					},
				][input.name === "ab" ? 0 : 1];
				await expect(db.users.create(input)).rejects.toMatchObject(expected);
				await expect(
					db.users.update("u1", { name: input.name, profile: input.profile }),
				).rejects.toMatchObject(expected);
			}
		} finally {
			await db.close();
		}
	});

	it("runs custom filters through host predicates", async () => {
		const custom = Schema.String.check(
			Schema.makeFilter((value: string) => value === "allowed", {
				expected: "an allowed name",
			}),
		);
		const db = await createEngineDatabase({
			users: {
				schema: Schema.Struct({ id: Schema.String, name: custom }),
				relationships: {},
			},
		});
		try {
			await expect(
				db.users.create({ id: "u1", name: "blocked" }),
			).rejects.toMatchObject({ _tag: "ValidationError" });
			expect(
				await db.users.create({ id: "u1", name: "allowed" }),
			).toMatchObject({ name: "allowed" });
		} finally {
			await db.close();
		}
	});

	it("runs ECMAScript patterns with lookaround, backreferences and flags", async () => {
		for (const [pattern, valid, invalid] of [
			[/(?<=a)b/, "ab", "cb"],
			[/^(a)\1$/, "aa", "ab"],
			[/^hello$/i, "HELLO", "world"],
			[/^.$/u, "😀", "ab"],
			[/^a.b$/s, "a\nb", "ab"],
			[/a/y, "abc", "ba"],
			[/a/g, "ba", "bc"],
			[/^.$/, "a", "😀"],
			[/^😀$/, "😀", "a"],
		] as const) {
			const db = await createEngineDatabase({
				users: {
					schema: Schema.Struct({
						id: Schema.String,
						name: Schema.String.check(Schema.isPattern(pattern)),
					}),
					relationships: {},
				},
			});
			try {
				expect(pattern.test(valid)).toBe(true);
				pattern.lastIndex = 0;
				expect(pattern.test(invalid)).toBe(false);
				pattern.lastIndex = 0;
				await db.users.create({ id: "u1", name: valid });
				await expect(
					db.users.create({ id: "u2", name: invalid }),
				).rejects.toMatchObject({ _tag: "ValidationError" });
			} finally {
				await db.close();
			}
		}
	});
});
