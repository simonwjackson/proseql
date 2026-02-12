import { StorageAdapterService as StorageAdapter } from "@proseql/core";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
	makeLocalStorageAdapter,
	makeLocalStorageLayer,
} from "../src/adapters/local-storage-adapter.js";

// ============================================================================
// Mock Storage Implementation
// ============================================================================

/**
 * A mock implementation of the Web Storage API (localStorage/sessionStorage).
 * Allows inspection of stored values and simulation of quota errors.
 */
class MockStorage implements Storage {
	private store = new Map<string, string>();
	private quotaExceeded = false;

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
		if (this.quotaExceeded) {
			const error = new DOMException(
				"QuotaExceededError: The quota has been exceeded.",
				"QuotaExceededError",
			);
			throw error;
		}
		this.store.set(key, value);
	}

	removeItem(key: string): void {
		this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	// Test utilities
	setQuotaExceeded(exceeded: boolean): void {
		this.quotaExceeded = exceeded;
	}

	getStore(): Map<string, string> {
		return this.store;
	}
}

// ============================================================================
// Test Helper
// ============================================================================

const createTestAdapter = (storage: MockStorage, config = {}) => {
	const adapter = makeLocalStorageAdapter(storage, config);
	const layer = Layer.succeed(StorageAdapter, adapter);
	return {
		adapter,
		layer,
		run: <A, E>(effect: Effect.Effect<A, E, StorageAdapter>) =>
			Effect.runPromise(Effect.provide(effect, layer)),
	};
};

// ============================================================================
// Tests
// ============================================================================

describe("LocalStorageAdapter", () => {
	let mockStorage: MockStorage;

	beforeEach(() => {
		mockStorage = new MockStorage();
	});

	// ========================================================================
	// 11.2: Test write then read round-trip
	// ========================================================================
	describe("write/read round-trip", () => {
		it("stores data and retrieves it correctly", async () => {
			const { run } = createTestAdapter(mockStorage);

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
					return yield* adapter.read("./data/books.yaml");
				}),
			);

			expect(result).toBe('{"title":"Dune"}');
		});

		it("stores data with the correct key prefix", async () => {
			const { run } = createTestAdapter(mockStorage);

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
				}),
			);

			// Default prefix is "proseql:"
			expect(mockStorage.getStore().has("proseql:data/books.yaml")).toBe(true);
		});

		it("uses custom key prefix when configured", async () => {
			const { run } = createTestAdapter(mockStorage, { keyPrefix: "myapp:" });

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./data/books.yaml", '{"title":"Dune"}');
				}),
			);

			expect(mockStorage.getStore().has("myapp:data/books.yaml")).toBe(true);
		});

		it("overwrites existing data on subsequent writes", async () => {
			const { run } = createTestAdapter(mockStorage);

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./file.txt", "first");
					yield* adapter.write("./file.txt", "second");
					return yield* adapter.read("./file.txt");
				}),
			);

			expect(result).toBe("second");
		});
	});

	// ========================================================================
	// 11.3: Test exists returns false for missing key, true after write
	// ========================================================================
	describe("exists", () => {
		it("returns false for missing key", async () => {
			const { run } = createTestAdapter(mockStorage);

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.exists("./nonexistent.json");
				}),
			);

			expect(result).toBe(false);
		});

		it("returns true after write", async () => {
			const { run } = createTestAdapter(mockStorage);

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					const before = yield* adapter.exists("./file.txt");
					yield* adapter.write("./file.txt", "hello");
					const after = yield* adapter.exists("./file.txt");
					return { before, after };
				}),
			);

			expect(result.before).toBe(false);
			expect(result.after).toBe(true);
		});
	});

	// ========================================================================
	// 11.4: Test remove deletes the key, subsequent exists returns false
	// ========================================================================
	describe("remove", () => {
		it("deletes an existing key", async () => {
			const { run } = createTestAdapter(mockStorage);

			const result = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.write("./file.txt", "data");
					yield* adapter.remove("./file.txt");
					return yield* adapter.exists("./file.txt");
				}),
			);

			expect(result).toBe(false);
		});

		it("succeeds silently for non-existent keys", async () => {
			const { run } = createTestAdapter(mockStorage);

			// Should not throw
			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.remove("./nonexistent.txt");
				}),
			);
		});
	});

	// ========================================================================
	// 11.5: Test read on missing key fails with StorageError
	// ========================================================================
	describe("read missing key", () => {
		it("fails with StorageError when key does not exist", async () => {
			const { layer } = createTestAdapter(mockStorage);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const adapter = yield* StorageAdapter;
						return yield* adapter.read("./missing.json").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					layer,
				),
			);

			expect(result._tag).toBe("StorageError");
			if (result._tag === "StorageError") {
				expect(result.operation).toBe("read");
				expect(result.message).toContain("Key not found");
			}
		});
	});

	// ========================================================================
	// 11.6: Test ensureDir is a no-op (succeeds without side effects)
	// ========================================================================
	describe("ensureDir", () => {
		it("succeeds without side effects (no-op)", async () => {
			const { run } = createTestAdapter(mockStorage);
			const initialSize = mockStorage.length;

			await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					yield* adapter.ensureDir("./some/deep/path");
				}),
			);

			// No new entries should be created
			expect(mockStorage.length).toBe(initialSize);
		});
	});

	// ========================================================================
	// 11.7: Test write with quota exceeded throws StorageError
	// ========================================================================
	describe("quota exceeded", () => {
		it("throws StorageError when storage quota is exceeded", async () => {
			const { layer } = createTestAdapter(mockStorage);

			// Enable quota exceeded simulation
			mockStorage.setQuotaExceeded(true);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const adapter = yield* StorageAdapter;
						return yield* adapter
							.write("./large-file.json", "lots of data")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);
					}),
					layer,
				),
			);

			expect(result._tag).toBe("StorageError");
			if (result._tag === "StorageError") {
				expect(result.operation).toBe("write");
				expect(result.message).toContain("quota");
			}
		});
	});

	// ========================================================================
	// Layer factory tests
	// ========================================================================
	describe("makeLocalStorageLayer", () => {
		it("creates a Layer that provides StorageAdapter", async () => {
			// Note: This test uses a global mock since makeLocalStorageLayer
			// accesses globalThis.localStorage by default
			const mockGlobalStorage = new MockStorage();

			// Temporarily replace globalThis.localStorage
			const originalLocalStorage = globalThis.localStorage;
			Object.defineProperty(globalThis, "localStorage", {
				value: mockGlobalStorage,
				writable: true,
				configurable: true,
			});

			try {
				const layer = makeLocalStorageLayer({ keyPrefix: "test:" });

				await Effect.runPromise(
					Effect.provide(
						Effect.gen(function* () {
							const adapter = yield* StorageAdapter;
							yield* adapter.write("./file.txt", "content");
						}),
						layer,
					),
				);

				expect(mockGlobalStorage.getStore().has("test:file.txt")).toBe(true);
			} finally {
				// Restore original localStorage
				Object.defineProperty(globalThis, "localStorage", {
					value: originalLocalStorage,
					writable: true,
					configurable: true,
				});
			}
		});
	});
});
