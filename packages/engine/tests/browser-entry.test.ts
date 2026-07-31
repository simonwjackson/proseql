import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OperationError } from "@proseql/core";
import * as Schema from "effect/Schema";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistentEngineDatabase } from "../src/browser.js";

const WORKTREE_ROOT = "/home/simonwjackson/code/github/simonwjackson/proseql/.worktrees/refactor-rust-engine-conversion";

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
	execFileSync("bunx", ["tsc", "--build", "packages/core", "packages/engine"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 120_000);

describe("@proseql/engine/browser", () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, "localStorage", {
			value: new MockStorage(),
			writable: true,
			configurable: true,
		});
	});

	it("defaults persistent databases to a browser localStorage host", async () => {
		const first = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 5 });
		await first.books.create({ id: "b1", title: "Dune" });
		await first.flush();
		await first.close();

		const second = await createPersistentEngineDatabase(config, { books: [] }, { writeDebounce: 5 });
		expect(await second.books.query()).toEqual([{ id: "b1", title: "Dune" }]);
		await second.close();
	});

	it("fails with a typed error when no default browser storage host is available", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: undefined,
			writable: true,
			configurable: true,
		});

		await expect(createPersistentEngineDatabase(config, { books: [] })).rejects.toBeInstanceOf(
			OperationError,
		);
		await expect(createPersistentEngineDatabase(config, { books: [] })).rejects.toMatchObject({
			_tag: "OperationError",
			reason: "browser-storage-host-unavailable",
		});
	});

	it("publishes a browser entry whose built graph contains no node storage host imports", async () => {
		const browserEntry = resolve(WORKTREE_ROOT, "packages/engine/dist/browser.js");
		const built = readFileSync(browserEntry, "utf8");
		expect(built).not.toContain("node:");
		expect(built).not.toContain("./storage-host.js");
		expect(built).not.toContain("createNodeEngineStorageHost");
	});
});
