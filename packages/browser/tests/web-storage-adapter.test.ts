import {
	StorageAdapterService as StorageAdapter,
	UnsupportedFormatError,
} from "@proseql/core";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWebStorageAdapter } from "../src/adapters/web-storage-adapter.js";

class MockStorage implements Storage {
	private store = new Map<string, string>();

	get length(): number {
		return this.store.size;
	}

	key(index: number): string | null {
		const keys = Array.from(this.store.keys());
		return keys[index] ?? null;
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

const createHarness = (storage: Storage, ...args: Parameters<typeof makeWebStorageAdapter>) => {
	const adapter = makeWebStorageAdapter(...args);
	const layer = Layer.succeed(StorageAdapter, adapter);
	return {
		run: <A, E>(effect: Effect.Effect<A, E, StorageAdapter>) =>
			Effect.runPromise(Effect.provide(effect, layer)),
	};
};

describe("makeWebStorageAdapter", () => {
	let storage: MockStorage;

	beforeEach(() => {
		storage = new MockStorage();
	});

	it("lists only direct children beneath a non-root directory", async () => {
		const { run } = createHarness(storage, storage, {});
		await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				yield* adapter.write("./data/books.json", "books");
				yield* adapter.write("./data/nested/authors.json", "authors");
				yield* adapter.write("./other.json", "other");
			}),
		);

		const listed = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				return yield* adapter.listDirectory("./data");
			}),
		);

		expect(listed).toEqual(["data/books.json"]);
	});

	it("returns false for missing extensionless paths without exact keys or children", async () => {
		const { run } = createHarness(storage, storage, {});

		const before = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				return yield* adapter.exists("./docs");
			}),
		);
		expect(before).toBe(false);

		await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				yield* adapter.write("./docs/file.json", "value");
			}),
		);

		const after = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				return yield* adapter.exists("./docs");
			}),
		);
		expect(after).toBe(true);
	});

	it("preserves UnsupportedFormatError tags from the engine storage adapter", async () => {
		const { run } = createHarness(storage, storage, { allowedFormats: ["json"] });

		const error = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				return yield* adapter.write("./data/books.yaml", "value").pipe(
					Effect.match({
						onFailure: (failure) => failure,
						onSuccess: () => new Error("expected failure"),
					}),
				);
			}),
		);

		expect(error).toBeInstanceOf(UnsupportedFormatError);
		expect((error as UnsupportedFormatError)._tag).toBe("UnsupportedFormatError");
	});

	it("accepts a custom watch implementation with the legacy public signature", async () => {
		const onChange = vi.fn();
		const unsubscribe = vi.fn();
		const watchImpl = vi.fn(async (_key: string, callback: () => void) => {
			callback();
			return unsubscribe;
		});
		const { run } = createHarness(storage, storage, { keyPrefix: "custom:" }, watchImpl);

		const stop = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter;
				return yield* adapter.watch("./data/books.json", onChange);
			}),
		);

		expect(watchImpl).toHaveBeenCalledWith("custom:data/books.json", expect.any(Function));
		expect(onChange).toHaveBeenCalledTimes(1);
		stop();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
