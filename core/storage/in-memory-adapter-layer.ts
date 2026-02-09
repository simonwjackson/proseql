/**
 * In-memory implementation of StorageAdapter as an Effect Layer.
 * Intended for testing — stores data in a Map<string, string> instead of the filesystem.
 */

import { Effect, Layer } from "effect"
import { StorageAdapter, type StorageAdapterShape } from "./storage-service.js"
import { StorageError } from "../errors/storage-errors.js"

// ============================================================================
// In-memory storage adapter
// ============================================================================

const makeInMemoryAdapter = (
	store: Map<string, string> = new Map(),
	watchers: Map<string, Set<() => void>> = new Map(),
): StorageAdapterShape => ({
	read: (path: string) =>
		Effect.suspend(() => {
			const content = store.get(path)
			if (content === undefined) {
				return Effect.fail(
					new StorageError({
						path,
						operation: "read",
						message: `File not found: ${path}`,
					}),
				)
			}
			return Effect.succeed(content)
		}),

	write: (path: string, data: string) =>
		Effect.sync(() => {
			store.set(path, data)
			// Notify watchers for this path
			const pathWatchers = watchers.get(path)
			if (pathWatchers) {
				for (const cb of pathWatchers) {
					cb()
				}
			}
		}),

	exists: (path: string) => Effect.sync(() => store.has(path)),

	remove: (path: string) =>
		Effect.suspend(() => {
			if (!store.has(path)) {
				return Effect.fail(
					new StorageError({
						path,
						operation: "delete",
						message: `File not found: ${path}`,
					}),
				)
			}
			store.delete(path)
			return Effect.void
		}),

	ensureDir: (_path: string) => Effect.void,

	watch: (path: string, onChange: () => void) =>
		Effect.sync(() => {
			const pathWatchers = watchers.get(path) ?? new Set()
			pathWatchers.add(onChange)
			watchers.set(path, pathWatchers)
			return () => {
				pathWatchers.delete(onChange)
				if (pathWatchers.size === 0) {
					watchers.delete(path)
				}
			}
		}),
})

// ============================================================================
// Layer construction
// ============================================================================

/**
 * Creates an InMemoryStorageLayer backed by the provided Map.
 * Pass your own Map to inspect stored data in tests.
 */
export const makeInMemoryStorageLayer = (
	store?: Map<string, string>,
): Layer.Layer<StorageAdapter> =>
	Layer.succeed(StorageAdapter, makeInMemoryAdapter(store))

/**
 * Default InMemoryStorageLayer with a fresh empty Map.
 */
export const InMemoryStorageLayer: Layer.Layer<StorageAdapter> =
	makeInMemoryStorageLayer()
