import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { createEffectDatabase } from "../src/index.js";

it("rejects isMinLength through the Effect adapter", async () => {
	const schema = Schema.Struct({
		id: Schema.String,
		name: Schema.String.check(Schema.isMinLength(3)),
	});
	const db = await Effect.runPromise(
		createEffectDatabase({ users: { schema, relationships: {} } }),
	);
	const result = await Effect.runPromise(
		Effect.result(db.users.create({ id: "u1", name: "ab" })),
	);
	expect(result._tag).toBe("Failure");
	if (result._tag === "Failure")
		expect(result.failure).toMatchObject({ _tag: "ValidationError" });
});
