import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OperationError } from "@proseql/core";
import { Effect, Schema, Stream } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistentEffectDatabase } from "../src/index.js";

class MockStorage implements Storage {
	private store = new Map<string, string>();

	get length(): number {
		return this.store.size;
	}

	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}

	getItem(key: string): string | null {
		return this.store.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value);
	}

	removeItem(key: string): void {
		this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}
}

const WORKTREE_ROOT = "/home/simonwjackson/code/github/simonwjackson/proseql/.worktrees/refactor-rust-engine-conversion";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const config = {
	books: {
		schema: BookSchema,
		file: "./data/books.json",
		relationships: {},
	},
} as const;

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
	execFileSync("bunx", ["tsc", "--build", "packages/core", "packages/engine", "packages/effect", "packages/browser"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 120_000);

describe("@proseql/browser persistent effect factory", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "localStorage", {
			value: new MockStorage(),
			writable: true,
			configurable: true,
		});
	});

	it("defaults to a browser localStorage adapter when no StorageAdapter layer is provided", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config, { books: [] }, { writeDebounce: 5 });
					yield* db.books.create({ id: "b1", title: "Dune" });
					yield* Effect.tryPromise(() => db.flush());
				}),
			),
		);

		const rows = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config, { books: [] }, { writeDebounce: 5 });
					return yield* Stream.runCollect(db.books.query());
				}),
			),
		);

		expect([...rows]).toEqual([{ id: "b1", title: "Dune" }]);
	});

	it("fails with a typed error when neither localStorage nor an explicit browser layer is available", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: undefined,
			writable: true,
			configurable: true,
		});

		await expect(
			Effect.runPromise(
				Effect.scoped(
					createPersistentEffectDatabase(config, { books: [] }),
				),
			),
		).rejects.toBeInstanceOf(OperationError);
	});

	it("publishes browser-safe effect and browser entrypoints with explicit browser subpath exports", async () => {
		const effectPackage = JSON.parse(
			readFileSync(resolve(WORKTREE_ROOT, "packages/effect/package.json"), "utf8"),
		) as {
			exports?: Record<string, { import?: string; types?: string }>;
		};
		expect(effectPackage.exports?.["./browser"]).toEqual({
			import: "./dist/browser.js",
			types: "./dist/browser.d.ts",
		});

		const effectRoot = readFileSync(resolve(WORKTREE_ROOT, "packages/effect/dist/index.js"), "utf8");
		expect(effectRoot).toContain("@proseql/engine");
		expect(effectRoot).not.toContain("@proseql/engine/browser");

		const effectBrowser = readFileSync(resolve(WORKTREE_ROOT, "packages/effect/dist/browser.js"), "utf8");
		expect(effectBrowser).toContain("@proseql/engine/browser");
		expect(effectBrowser).not.toContain("node:");

		const browserBuilt = readFileSync(resolve(WORKTREE_ROOT, "packages/browser/dist/index.js"), "utf8");
		expect(browserBuilt).toContain("@proseql/effect/browser");
		expect(browserBuilt).not.toContain("node:");
	});
});
