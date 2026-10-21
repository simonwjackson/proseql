import { Schema } from "effect";
import { expect, it } from "vitest";
import { createEngineDatabase, WasmEngineDefectError } from "../src/index.js";

it("surfaces mutation defects and refreshes projection state before a later read", async () => {
	const committed = [
		{ id: "u1", name: "Alice" },
		{ id: "u2", name: "Bob" },
	];
	const db = await createEngineDatabase(
		{
			users: {
				schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
				relationships: {},
			},
		},
		{ users: committed },
		{
			plugins: [
				{
					name: "aborting-mutation-selector",
					operators: [
						{
							name: "$abortMutation",
							types: ["string"],
							evaluate: (value: unknown) => {
								if (value === "Bob")
									throw new Error("mutation selector aborted");
								return true;
							},
						},
					],
				},
			],
		},
	);
	try {
		expect(await db.users.query({ sort: { id: "asc" } })).toEqual(committed);
		await expect(
			db.users.deleteManyWithRelationships(
				{ name: { $abortMutation: true } },
				{},
			),
		).rejects.toBeInstanceOf(WasmEngineDefectError);
		// The selector aborted before writes. Reads must refresh projection
		// state and return the data that remains committed in Rust.
		expect(await db.users.query({ sort: { id: "asc" } })).toEqual(committed);
		expect(await db.users.findById("u1")).toEqual(committed[0]);
	} finally {
		await db.close();
	}
});
