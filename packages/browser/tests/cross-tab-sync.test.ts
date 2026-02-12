import { Effect, Layer } from "effect";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { StorageAdapterService as StorageAdapter } from "@proseql/core";
import { makeLocalStorageAdapter } from "../src/adapters/local-storage-adapter.js";

// ============================================================================
// Mock Storage Implementation
// ============================================================================

/**
 * A mock implementation of the Web Storage API (localStorage/sessionStorage).
 */
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

	getStore(): Map<string, string> {
		return this.store;
	}
}

// ============================================================================
// Mock Window Storage Event Infrastructure
// ============================================================================

/**
 * Track registered storage event listeners for testing
 */
interface StorageEventState {
	listeners: Array<(event: StorageEvent) => void>;
}

const createMockWindow = (): {
	state: StorageEventState;
	addEventListener: (type: string, listener: (event: StorageEvent) => void) => void;
	removeEventListener: (type: string, listener: (event: StorageEvent) => void) => void;
	dispatchStorageEvent: (key: string | null, oldValue: string | null, newValue: string | null) => void;
} => {
	const state: StorageEventState = {
		listeners: [],
	};

	return {
		state,
		addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
			if (type === "storage") {
				state.listeners.push(listener);
			}
		},
		removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
			if (type === "storage") {
				const index = state.listeners.indexOf(listener);
				if (index !== -1) {
					state.listeners.splice(index, 1);
				}
			}
		},
		dispatchStorageEvent: (key: string | null, oldValue: string | null, newValue: string | null) => {
			const event = {
				key,
				oldValue,
				newValue,
				url: "http://localhost",
				storageArea: null,
			} as StorageEvent;

			for (const listener of state.listeners) {
				listener(event);
			}
		},
	};
};

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
// Tests — Cross-Tab Sync
// ============================================================================

describe("Cross-Tab Sync", () => {
	let mockStorage: MockStorage;
	let mockWindow: ReturnType<typeof createMockWindow>;
	let originalWindow: typeof globalThis.window;

	beforeEach(() => {
		mockStorage = new MockStorage();
		mockWindow = createMockWindow();

		// Save original window
		originalWindow = globalThis.window;

		// Mock the global window object with our test implementation
		Object.defineProperty(globalThis, "window", {
			value: {
				addEventListener: mockWindow.addEventListener,
				removeEventListener: mockWindow.removeEventListener,
			},
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		// Restore original window
		Object.defineProperty(globalThis, "window", {
			value: originalWindow,
			writable: true,
			configurable: true,
		});
	});

	// ========================================================================
	// 14.2: Test watch registers listener and calls onChange for watched key
	// ========================================================================
	describe("watch registers listener and calls onChange", () => {
		it("calls onChange when the watched key is modified", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/books.yaml", onChange);
				}),
			);

			// Verify listener was registered
			expect(mockWindow.state.listeners.length).toBe(1);

			// Simulate a storage event from another tab for the watched key
			mockWindow.dispatchStorageEvent(
				"proseql:data/books.yaml",
				'{"old":"value"}',
				'{"new":"value"}',
			);

			// onChange should have been called
			expect(onChange).toHaveBeenCalledTimes(1);

			// Cleanup
			unsubscribe();
		});

		it("uses the correct key prefix when matching events", async () => {
			const { run } = createTestAdapter(mockStorage, { keyPrefix: "myapp:" });
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/test.json", onChange);
				}),
			);

			// Event with custom prefix should trigger onChange
			mockWindow.dispatchStorageEvent("myapp:data/test.json", null, "new data");
			expect(onChange).toHaveBeenCalledTimes(1);

			// Event with default prefix should NOT trigger onChange
			mockWindow.dispatchStorageEvent("proseql:data/test.json", null, "other data");
			expect(onChange).toHaveBeenCalledTimes(1); // Still 1, not 2

			unsubscribe();
		});
	});

	// ========================================================================
	// 14.3: Test watch ignores storage events for unrelated keys
	// ========================================================================
	describe("watch ignores unrelated keys", () => {
		it("does not call onChange for events on different keys", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/books.yaml", onChange);
				}),
			);

			// Simulate storage events for OTHER keys
			mockWindow.dispatchStorageEvent("proseql:data/authors.yaml", null, "new");
			mockWindow.dispatchStorageEvent("proseql:data/publishers.json", null, "new");
			mockWindow.dispatchStorageEvent("other-app:data/books.yaml", null, "new");

			// onChange should NOT have been called
			expect(onChange).not.toHaveBeenCalled();

			// Now dispatch for the correct key
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "new");

			// NOW it should be called
			expect(onChange).toHaveBeenCalledTimes(1);

			unsubscribe();
		});

		it("ignores events with null key", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/books.yaml", onChange);
				}),
			);

			// storage.clear() fires an event with key = null
			mockWindow.dispatchStorageEvent(null, null, null);

			expect(onChange).not.toHaveBeenCalled();

			unsubscribe();
		});
	});

	// ========================================================================
	// 14.4: Test unsubscribe function removes the event listener
	// ========================================================================
	describe("unsubscribe removes event listener", () => {
		it("removes the listener when unsubscribe is called", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/books.yaml", onChange);
				}),
			);

			// Verify listener was registered
			expect(mockWindow.state.listeners.length).toBe(1);

			// Call unsubscribe
			unsubscribe();

			// Verify listener was removed
			expect(mockWindow.state.listeners.length).toBe(0);

			// Events should no longer trigger onChange
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "new");
			expect(onChange).not.toHaveBeenCalled();
		});

		it("calling unsubscribe multiple times is safe", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange = vi.fn();

			const unsubscribe = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					return yield* adapter.watch("./data/books.yaml", onChange);
				}),
			);

			// Call unsubscribe multiple times - should not throw
			unsubscribe();
			unsubscribe();
			unsubscribe();

			expect(mockWindow.state.listeners.length).toBe(0);
		});
	});

	// ========================================================================
	// 14.5: Test multiple watchers on different keys coexist independently
	// ========================================================================
	describe("multiple watchers coexist independently", () => {
		it("can register multiple watchers for different keys", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChangeBooks = vi.fn();
			const onChangeAuthors = vi.fn();
			const onChangePublishers = vi.fn();

			const [unsubBooks, unsubAuthors, unsubPublishers] = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					const unsub1 = yield* adapter.watch("./data/books.yaml", onChangeBooks);
					const unsub2 = yield* adapter.watch("./data/authors.yaml", onChangeAuthors);
					const unsub3 = yield* adapter.watch("./data/publishers.json", onChangePublishers);
					return [unsub1, unsub2, unsub3] as const;
				}),
			);

			// All 3 listeners should be registered
			expect(mockWindow.state.listeners.length).toBe(3);

			// Trigger event for books
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "new");
			expect(onChangeBooks).toHaveBeenCalledTimes(1);
			expect(onChangeAuthors).not.toHaveBeenCalled();
			expect(onChangePublishers).not.toHaveBeenCalled();

			// Trigger event for authors
			mockWindow.dispatchStorageEvent("proseql:data/authors.yaml", null, "new");
			expect(onChangeBooks).toHaveBeenCalledTimes(1);
			expect(onChangeAuthors).toHaveBeenCalledTimes(1);
			expect(onChangePublishers).not.toHaveBeenCalled();

			// Trigger event for publishers
			mockWindow.dispatchStorageEvent("proseql:data/publishers.json", null, "new");
			expect(onChangeBooks).toHaveBeenCalledTimes(1);
			expect(onChangeAuthors).toHaveBeenCalledTimes(1);
			expect(onChangePublishers).toHaveBeenCalledTimes(1);

			// Cleanup
			unsubBooks();
			unsubAuthors();
			unsubPublishers();
		});

		it("unsubscribing one watcher does not affect others", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChangeBooks = vi.fn();
			const onChangeAuthors = vi.fn();

			const [unsubBooks, unsubAuthors] = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					const unsub1 = yield* adapter.watch("./data/books.yaml", onChangeBooks);
					const unsub2 = yield* adapter.watch("./data/authors.yaml", onChangeAuthors);
					return [unsub1, unsub2] as const;
				}),
			);

			// Unsubscribe only the books watcher
			unsubBooks();
			expect(mockWindow.state.listeners.length).toBe(1);

			// Books events should no longer trigger
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "new");
			expect(onChangeBooks).not.toHaveBeenCalled();

			// Authors events should still trigger
			mockWindow.dispatchStorageEvent("proseql:data/authors.yaml", null, "new");
			expect(onChangeAuthors).toHaveBeenCalledTimes(1);

			// Cleanup
			unsubAuthors();
		});

		it("can register multiple watchers for the same key", async () => {
			const { run } = createTestAdapter(mockStorage);
			const onChange1 = vi.fn();
			const onChange2 = vi.fn();

			const [unsub1, unsub2] = await run(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter;
					const u1 = yield* adapter.watch("./data/books.yaml", onChange1);
					const u2 = yield* adapter.watch("./data/books.yaml", onChange2);
					return [u1, u2] as const;
				}),
			);

			// Both listeners should be registered
			expect(mockWindow.state.listeners.length).toBe(2);

			// Both should be called when the key changes
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "new");
			expect(onChange1).toHaveBeenCalledTimes(1);
			expect(onChange2).toHaveBeenCalledTimes(1);

			// Unsubscribe first watcher
			unsub1();
			expect(mockWindow.state.listeners.length).toBe(1);

			// Only second watcher should respond now
			mockWindow.dispatchStorageEvent("proseql:data/books.yaml", null, "newer");
			expect(onChange1).toHaveBeenCalledTimes(1); // Still 1
			expect(onChange2).toHaveBeenCalledTimes(2); // Now 2

			unsub2();
		});
	});
});
