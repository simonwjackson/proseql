import { mkdirSync, existsSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Schema, Stream } from "effect";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const scopedNodeModules = join(root, "node_modules", "@proseql");
mkdirSync(scopedNodeModules, { recursive: true });

for (const pkg of ["core", "engine"]) {
	const linkPath = join(scopedNodeModules, pkg);
	const targetPath = join(root, "packages", pkg);
	if (!existsSync(linkPath)) {
		symlinkSync(targetPath, linkPath, "dir");
	}
}

const { createEffectDatabase } = await import(pathToFileURL(join(root, "packages/effect/dist/index.js")).href);

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number
});

const db = await Effect.runPromise(
	createEffectDatabase(
		{
			users: { schema: UserSchema, relationships: {} }
		},
		{ users: [{ id: "u1", name: "Alice", age: 30 }] }
	)
);

const rows = await Effect.runPromise(Stream.runCollect(db.users.query({ select: ["name"] })));
if (rows[0]?.name !== "Alice") {
	throw new Error(`Unexpected node smoke result: ${JSON.stringify(rows)}`);
}
