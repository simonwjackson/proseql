import * as Schema from "effect/Schema";
import { createEngineDatabase } from "../dist/index.js";

const db = await createEngineDatabase({
	users: {
		schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
		relationships: {},
	},
}, {
	users: [{ id: "u1", name: "Alice" }],
});

const users = await db.users.query();
if (users.length !== 1 || users[0]?.name !== "Alice") {
	throw new Error(`Unexpected node smoke result: ${JSON.stringify(users)}`);
}
console.log("node smoke ok");
