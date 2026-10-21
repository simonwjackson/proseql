import { Schema } from "effect";
import { expect, it } from "vitest";
import { createEngineDatabase } from "../src/index.js";

const config = {
	users: {
		schema: Schema.Struct({
			id: Schema.String,
			deletedAt: Schema.optional(Schema.String),
		}),
		relationships: {},
	},
	posts: {
		schema: Schema.Struct({ id: Schema.String, authorId: Schema.String }),
		relationships: {
			author: { type: "ref", target: "users", foreignKey: "authorId" },
		},
	},
} as const;
const initial = {
	users: [{ id: "free" }, { id: "u1" }],
	posts: [{ id: "p1", authorId: "u1" }],
};

it.each([
	0,
	undefined,
	2,
])("checks every selected inbound reference before deleting with limit %s", async (limit) => {
	const db = await createEngineDatabase(config, initial);
	try {
		await expect(db.users.deleteMany({}, { limit })).rejects.toMatchObject({
			_tag: "ForeignKeyError",
		});
		expect(await db.users.query({})).toEqual(initial.users);
		expect(await db.posts.query({})).toEqual(initial.posts);
	} finally {
		await db.close();
	}
});

it("checks only the selected records for a positive deleteMany limit", async () => {
	const db = await createEngineDatabase(config, initial);
	try {
		expect((await db.users.deleteMany({}, { limit: 1 })).deleted).toEqual([
			{ id: "free" },
		]);
		expect(await db.users.query({})).toEqual([{ id: "u1" }]);
		expect(await db.posts.query({})).toEqual(initial.posts);
	} finally {
		await db.close();
	}
});

it("treats a zero soft-delete limit as unlimited without checking inbound references", async () => {
	const db = await createEngineDatabase(config, initial);
	try {
		expect(
			(await db.users.deleteMany({}, { limit: 0, soft: true })).count,
		).toBe(2);
		const users = await db.users.query({});
		expect(users.map((user) => user.id)).toEqual(["free", "u1"]);
		expect(users.every((user) => typeof user.deletedAt === "string")).toBe(
			true,
		);
		expect(await db.posts.query({})).toEqual(initial.posts);
	} finally {
		await db.close();
	}
});
