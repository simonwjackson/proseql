import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
	type CollectedQueryResult,
	type CreateManyResult,
	makeCollectionRpcs,
	makeRpcGroup,
	type UpsertResult,
} from "../src/index.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});

const config = {
	books: { schema: BookSchema, relationships: {} },
} as const;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeAll(() => {
	execFileSync("bunx", ["tsc", "--build", "packages/core", "packages/rpc"], {
		cwd: root,
		stdio: "inherit",
	});
});

const existsInConsumer = (consumer: string, packageName: string): boolean =>
	existsSync(join(consumer, "node_modules", "@proseql", packageName));

const operationNames = [
	"findById",
	"query",
	"queryStream",
	"create",
	"update",
	"delete",
	"aggregate",
	"createMany",
	"updateMany",
	"deleteMany",
	"upsert",
	"upsertMany",
] as const;

describe("public RPC definitions", () => {
	it("builds one Effect 4 RpcGroup with every collection-qualified operation", () => {
		const group = makeRpcGroup(config);
		expect(RpcGroup.make).toBeTypeOf("function");
		expect([...group.requests.keys()]).toEqual(
			operationNames.map((operation) => `books.${operation}`),
		);
		for (const rpc of group.requests.values())
			expect(Rpc.isRpc(rpc)).toBe(true);
	});

	it("exposes composable per-collection definitions without request classes", () => {
		const books = makeCollectionRpcs("books", BookSchema);
		expect(books.findById._tag).toBe("books.findById");
		expect(books.query._tag).toBe("books.query");
		expect(books.queryStream._tag).toBe("books.queryStream");
		expect([...books.group.requests.keys()]).toHaveLength(
			operationNames.length,
		);
	});

	it("derives entity-bearing result types from the collection schema", () => {
		const books = makeCollectionRpcs("books", BookSchema);
		type Book = typeof BookSchema.Type;
		type Success<S extends Schema.Top> = Schema.Schema.Type<S>;
		type QueryRows<T> =
			T extends ReadonlyArray<infer Row>
				? Row
				: T extends { readonly items: ReadonlyArray<infer Row> }
					? Row
					: never;

		expectTypeOf<
			Success<typeof books.createMany.successSchema>["created"][number]
		>().toEqualTypeOf<Book>();
		expectTypeOf<
			Success<typeof books.updateMany.successSchema>["updated"][number]
		>().toEqualTypeOf<Book>();
		expectTypeOf<
			Success<typeof books.deleteMany.successSchema>["deleted"][number]
		>().toEqualTypeOf<Book>();
		expectTypeOf<
			Success<typeof books.upsertMany.successSchema>["created"][number]
		>().toEqualTypeOf<Book>();
		expectTypeOf<Success<typeof books.upsert.successSchema>>().toMatchTypeOf<
			Book & { readonly __action: string }
		>();
		expectTypeOf<
			QueryRows<Success<typeof books.query.successSchema>>
		>().toMatchTypeOf<Partial<Book>>();
		expectTypeOf<
			CreateManyResult<Book>["created"][number]
		>().toEqualTypeOf<Book>();
		expectTypeOf<UpsertResult<Book>>().toMatchTypeOf<
			Book & { readonly __action: string }
		>();
		expectTypeOf<CollectedQueryResult<Book>>().toMatchTypeOf<
			| ReadonlyArray<Partial<Book>>
			| { readonly items: ReadonlyArray<Partial<Book>> }
		>();
	});

	it("loads the built root without engine packages and gates ./server on its optional peer", () => {
		const consumer = mkdtempSync(join(tmpdir(), "proseql-rpc-client-"));
		try {
			const scope = join(consumer, "node_modules", "@proseql");
			mkdirSync(scope, { recursive: true });
			const rpcPackage = join(scope, "rpc");
			mkdirSync(rpcPackage, { recursive: true });
			cpSync(join(root, "packages/rpc/dist"), join(rpcPackage, "dist"), {
				recursive: true,
			});
			cpSync(
				join(root, "packages/rpc/package.json"),
				join(rpcPackage, "package.json"),
			);
			symlinkSync(
				realpathSync(join(root, "packages/core")),
				join(scope, "core"),
				"dir",
			);
			symlinkSync(
				realpathSync(join(root, "node_modules/effect")),
				join(consumer, "node_modules", "effect"),
				"dir",
			);
			writeFileSync(
				join(consumer, "package.json"),
				JSON.stringify({ type: "module" }),
			);

			const rootImport = spawnSync(
				"node",
				["--input-type=module", "--eval", "await import('@proseql/rpc')"],
				{ cwd: consumer, encoding: "utf8" },
			);
			expect(rootImport.status, rootImport.stderr).toBe(0);
			expect(existsInConsumer(consumer, "effect")).toBe(false);
			expect(existsInConsumer(consumer, "engine")).toBe(false);

			const serverImport = spawnSync(
				"node",
				[
					"--input-type=module",
					"--eval",
					"await import('@proseql/rpc/server')",
				],
				{ cwd: consumer, encoding: "utf8" },
			);
			expect(serverImport.status).not.toBe(0);
			expect(serverImport.stderr).toContain("@proseql/effect");
		} finally {
			rmSync(consumer, { recursive: true, force: true });
		}
	});

	it.each([
		"",
		"books.admin",
		"../books",
		"books space",
		"$books",
	])("rejects dangerous collection name %j before defining routes", (name) => {
		expect(() => makeCollectionRpcs(name, BookSchema)).toThrow(
			"Invalid RPC collection name",
		);
	});
});
