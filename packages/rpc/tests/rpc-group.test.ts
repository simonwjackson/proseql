import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { describe, expect, expectTypeOf, it } from "vitest";
import { makeCollectionRpcs, makeRpcGroup } from "../src/index.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});

const config = {
	books: { schema: BookSchema, relationships: {} },
} as const;

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
		type QueryRows<T> = T extends ReadonlyArray<infer Row>
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
		expectTypeOf<
			Success<typeof books.upsert.successSchema>
		>().toMatchTypeOf<Book & { readonly __action: string }>();
		expectTypeOf<
			QueryRows<Success<typeof books.query.successSchema>>
		>().toMatchTypeOf<Partial<Book>>();
	});

	it("keeps the root export client-safe and the WASM adapter behind ./server", async () => {
		const manifest = (await Bun.file(
			new URL("../package.json", import.meta.url),
		).json()) as {
			readonly exports: Readonly<Record<string, unknown>>;
			readonly peerDependenciesMeta: Readonly<
				Record<string, { readonly optional?: boolean }>
			>;
		};
		const rootSource = await Bun.file(
			new URL("../src/index.ts", import.meta.url),
		).text();
		expect(manifest.exports["./server"]).toBeDefined();
		expect(manifest.peerDependenciesMeta["@proseql/effect"]?.optional).toBe(
			true,
		);
		expect(rootSource).not.toContain("@proseql/effect");
		expect(rootSource).not.toContain("rpc-handlers");
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
