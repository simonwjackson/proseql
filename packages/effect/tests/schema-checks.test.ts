import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "@proseql/effect";

const User = Schema.Struct({
	id: Schema.String,
	name: Schema.String.check(Schema.isMinLength(3)),
	profile: Schema.Struct({
		alias: Schema.optional(Schema.String.check(Schema.isMinLength(3))),
	}),
});
const config = { users: { schema: User, relationships: {} } } as const;

const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
	const result = await Effect.runPromise(Effect.result(effect));
	expect(result._tag).toBe("Failure");
	if (result._tag !== "Failure") throw new Error("Expected validation failure");
	return result.failure;
};

describe("Effect Schema checks", () => {
	it("rejects a short string with the core SchemaIssue shape", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config));
		const error = await failure(
			db.users.create({ id: "u1", name: "ab", profile: {} }),
		);
		expect(error).toMatchObject({
			_tag: "ValidationError",
			message: 'Expected a value with a length of at least 3\n  at ["name"]',
			issues: [
				{
					field: "(root)",
					message:
						'Expected a value with a length of at least 3\n  at ["name"]',
				},
			],
		});
	});

	it("checks update values without changing stored data", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config));
		await Effect.runPromise(
			db.users.create({ id: "u1", name: "Alice", profile: {} }),
		);
		await failure(db.users.update("u1", { name: "ab" }));
		expect((await Effect.runPromise(db.users.findById("u1"))).name).toBe(
			"Alice",
		);
	});

	it("checks present optional nested fields on create and update", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config));
		for (const operation of [
			db.users.create({ id: "bad", name: "Alice", profile: { alias: "ab" } }),
			Effect.gen(function* () {
				yield* db.users.create({ id: "u1", name: "Alice", profile: {} });
				return yield* db.users.update("u1", { profile: { alias: "ab" } });
			}),
		]) {
			const error = await failure(operation);
			expect(error).toMatchObject({
				_tag: "ValidationError",
				issues: [
					{
						field: "(root)",
						message:
							'Expected a value with a length of at least 3\n  at ["profile"]["alias"]',
					},
				],
			});
		}
	});

	it("enforces custom filters and grouped filters", async () => {
		const schema = Schema.Struct({
			id: Schema.String,
			name: Schema.String.check(
				Schema.isMinLength(3).and(
					Schema.makeFilter((name: string) => name !== "blocked", {
						expected: "an allowed name",
					}),
				),
			),
		});
		const db = await Effect.runPromise(
			createEffectDatabase({ users: { schema, relationships: {} } }),
		);
		expect(
			await failure(db.users.create({ id: "u1", name: "blocked" })),
		).toMatchObject({
			_tag: "ValidationError",
			issues: [
				{ field: "(root)", message: 'Expected an allowed name\n  at ["name"]' },
			],
		});
	});
	it("preserves custom filter messages without evaluating filters twice", async () => {
		let calls = 0;
		const schema = Schema.Struct({
			id: Schema.String,
			name: Schema.String.check(
				Schema.makeFilter((name: string) => {
					calls += 1;
					return name === "allowed" || `Name ${name} is blocked`;
				}),
			),
		});
		const db = await Effect.runPromise(
			createEffectDatabase({ users: { schema, relationships: {} } }),
		);
		expect(
			await failure(db.users.create({ id: "u1", name: "bad" })),
		).toMatchObject({
			_tag: "ValidationError",
			issues: [
				{ field: "(root)", message: 'Name bad is blocked\n  at ["name"]' },
			],
		});
		expect(calls).toBe(1);
	});
	it("rolls back a transaction after a check fails", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config));
		await failure(
			db.$transaction((ctx) =>
				Effect.gen(function* () {
					yield* ctx.users.create({ id: "valid", name: "Alice", profile: {} });
					yield* ctx.users.create({ id: "invalid", name: "ab", profile: {} });
				}),
			),
		);
		await failure(db.users.findById("valid"));
		await failure(db.users.findById("invalid"));
	});

	it("rejects a batch atomically when a check fails", async () => {
		const db = await Effect.runPromise(createEffectDatabase(config));
		await failure(
			db.users.createMany([
				{ id: "valid", name: "Alice", profile: {} },
				{ id: "invalid", name: "ab", profile: {} },
			]),
		);
		await failure(db.users.findById("valid"));
		await failure(db.users.findById("invalid"));
	});
	it("preserves array offsets and punctuation in field names", async () => {
		const schema = Schema.Struct({
			id: Schema.String,
			data: Schema.Struct({
				"a.b[]": Schema.Array(
					Schema.Struct({
						alias: Schema.optional(Schema.String.check(Schema.isMinLength(3))),
					}),
				),
			}),
		});
		const db = await Effect.runPromise(
			createEffectDatabase({ users: { schema, relationships: {} } }),
		);
		expect(
			await failure(
				db.users.create({ id: "u1", data: { "a.b[]": [{ alias: "ab" }] } }),
			),
		).toMatchObject({
			issues: [
				{
					field: "(root)",
					message:
						'Expected a value with a length of at least 3\n  at ["data"]["a.b[]"][0]["alias"]',
				},
			],
		});
	});

	it("prefixes paths from custom filter issues", async () => {
		const schema = Schema.Struct({
			id: Schema.String,
			name: Schema.String.check(
				Schema.makeFilter(() => ({ path: ["detail"], issue: "Blocked name" })),
			),
		});
		const db = await Effect.runPromise(
			createEffectDatabase({ users: { schema, relationships: {} } }),
		);
		expect(
			await failure(db.users.create({ id: "u1", name: "bad" })),
		).toMatchObject({
			issues: [
				{ field: "(root)", message: 'Blocked name\n  at ["name"]["detail"]' },
			],
		});
	});
	for (const [name, key] of [
		["built-in", Schema.String.check(Schema.isMinLength(4))],
		[
			"host predicate",
			Schema.String.check(
				Schema.makeFilter((key: string) => key.startsWith("ok")),
			),
		],
	] as const) {
		it(`drops Record keys rejected by a ${name} check`, async () => {
			const schema = Schema.Struct({
				id: Schema.String,
				data: Schema.Record(key, Schema.Number),
			});
			const db = await Effect.runPromise(
				createEffectDatabase({ users: { schema, relationships: {} } }),
			);
			const created = await Effect.runPromise(
				db.users.create({ id: "u1", data: { bad: 1, okay: 2, ok_two: 3 } }),
			);
			expect(created.data).toEqual({ okay: 2, ok_two: 3 });
			expect(Object.keys(created.data)).toEqual(["okay", "ok_two"]);
			expect(await Effect.runPromise(db.users.findById("u1"))).toEqual(created);
		});
	}
});
