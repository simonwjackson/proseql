import { createEffectDatabase } from "@proseql/effect";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { createEngineDatabase } from "../src/index.js";

const config = {
	rows: {
		schema: Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			parentId: Schema.optional(Schema.String),
			deletedAt: Schema.optional(Schema.String),
		}),
		relationships: {
			parent: { type: "ref", target: "rows", foreignKey: "parentId" },
		},
	},
} as const;
const initial = {
	rows: [
		{ id: "boss", name: "Boss" },
		{ id: "worker", name: "Worker", parentId: "boss" },
	],
};

it("checks inbound references for single soft deletes, but not batch soft deletes", async () => {
	const db = await createEngineDatabase(config, initial);
	try {
		await expect(db.rows.delete("boss", { soft: true })).rejects.toMatchObject({
			_tag: "ForeignKeyError",
		});
		expect(
			(await db.rows.deleteMany({ id: "boss" }, { soft: true })).count,
		).toBe(1);
		expect(typeof (await db.rows.findById("boss"))?.deletedAt).toBe("string");
	} finally {
		await db.close();
	}
});

it("keeps the same single-versus-batch soft-delete rule in the Effect API", async () => {
	const db = await Effect.runPromise(createEffectDatabase(config, initial));
	try {
		await expect(
			db.rows.delete("boss", { soft: true }).runPromise,
		).rejects.toMatchObject({ _tag: "ForeignKeyError" });
		expect(
			(
				await db.rows.deleteMany((row) => row.id === "boss", { soft: true })
					.runPromise
			).count,
		).toBe(1);
		expect(typeof (await db.rows.findById("boss").runPromise).deletedAt).toBe(
			"string",
		);
	} finally {
		await db.close();
	}
});
