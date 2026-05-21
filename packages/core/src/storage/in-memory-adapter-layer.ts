/**
 * In-memory implementation of StorageAdapter as an Effect Layer.
 * Intended for testing — stores data in a Map<string, string> instead of the filesystem.
 */

import { Effect, Layer } from "effect";
import { StorageError } from "../errors/storage-errors.js";
import { normalizePath } from "../utils/path.js";
import { StorageAdapter, type StorageAdapterShape } from "./storage-service.js";

// ============================================================================
// In-memory storage adapter
// ============================================================================

type DirWatchEvent = {
	readonly filename: string | null;
	readonly type: "add" | "change" | "remove";
};

const makeInMemoryAdapter = (
	store: Map<string, string> = new Map(),
	watchers: Map<string, Set<() => void>> = new Map(),
	dirWatchers: Map<string, Set<(event: DirWatchEvent) => void>> = new Map(),
): StorageAdapterShape => {
	const notifyDirWatchers = (
		path: string,
		eventType: "add" | "change" | "remove",
	): void => {
		// Find all directory watchers whose dirPath is a prefix of the file path
		for (const [dirPath, callbacks] of dirWatchers) {
			const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
			if (path.startsWith(prefix)) {
				// Only notify for direct children (no nested subdirectories)
				const rest = path.slice(prefix.length);
				if (!rest.includes("/")) {
					for (const cb of callbacks) {
						cb({ filename: rest, type: eventType });
					}
				}
			}
		}
	};

	return {
		read: (path: string) =>
			Effect.suspend(() => {
				const content = store.get(path);
				if (content === undefined) {
					return Effect.fail(
						new StorageError({
							path,
							operation: "read",
							message: `File not found: ${path}`,
						}),
					);
				}
				return Effect.succeed(content);
			}),

		write: (path: string, data: string) =>
			Effect.sync(() => {
				const existed = store.has(path);
				store.set(path, data);
				// Notify watchers for this path
				const pathWatchers = watchers.get(path);
				if (pathWatchers) {
					for (const cb of pathWatchers) {
						cb();
					}
				}
				notifyDirWatchers(path, existed ? "change" : "add");
			}),

		append: (path: string, data: string) =>
			Effect.sync(() => {
				const existed = store.has(path);
				const existing = store.get(path) ?? "";
				store.set(path, existing + data);
				// Notify watchers for this path
				const pathWatchers = watchers.get(path);
				if (pathWatchers) {
					for (const cb of pathWatchers) {
						cb();
					}
				}
				notifyDirWatchers(path, existed ? "change" : "add");
			}),

		exists: (path: string) =>
			Effect.sync(() => {
				if (store.has(path)) return true;
				const normalized = normalizePath(path);
				const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
				for (const key of store.keys()) {
					if (normalizePath(key).startsWith(prefix)) return true;
				}
				return false;
			}),

		remove: (path: string) =>
			Effect.suspend(() => {
				if (!store.has(path)) {
					return Effect.fail(
						new StorageError({
							path,
							operation: "delete",
							message: `File not found: ${path}`,
						}),
					);
				}
				store.delete(path);
				notifyDirWatchers(path, "remove");
				return Effect.void;
			}),

		ensureDir: (_path: string) => Effect.void,

		watch: (path: string, onChange: () => void) =>
			Effect.sync(() => {
				const pathWatchers = watchers.get(path) ?? new Set();
				pathWatchers.add(onChange);
				watchers.set(path, pathWatchers);
				return () => {
					pathWatchers.delete(onChange);
					if (pathWatchers.size === 0) {
						watchers.delete(path);
					}
				};
			}),

		listDirectory: (dirPath: string) =>
			Effect.sync(() => {
				const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
				const result: Array<string> = [];
				for (const key of store.keys()) {
					if (key.startsWith(prefix)) {
						const rest = key.slice(prefix.length);
						// Only direct children (no nested paths)
						if (!rest.includes("/")) {
							result.push(key);
						}
					}
				}
				return result as ReadonlyArray<string>;
			}),

		listRecursive: (rootPath: string) =>
			Effect.sync(() => {
				const normalizedRoot = normalizePath(rootPath);
				const prefix = normalizedRoot.endsWith("/")
					? normalizedRoot
					: `${normalizedRoot}/`;
				const result: string[] = [];
				for (const key of store.keys()) {
					const normalizedKey = normalizePath(key);
					if (normalizedKey.startsWith(prefix)) {
						result.push(normalizedKey);
					}
				}
				return result.sort() as ReadonlyArray<string>;
			}),

		watchDir: (dirPath: string, onChange: (event: DirWatchEvent) => void) =>
			Effect.sync(() => {
				const callbacks = dirWatchers.get(dirPath) ?? new Set();
				callbacks.add(onChange);
				dirWatchers.set(dirPath, callbacks);
				return () => {
					callbacks.delete(onChange);
					if (callbacks.size === 0) {
						dirWatchers.delete(dirPath);
					}
				};
			}),
	};
};

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
	Layer.succeed(StorageAdapter, makeInMemoryAdapter(store));

/**
 * Default InMemoryStorageLayer with a fresh empty Map.
 */
export const InMemoryStorageLayer: Layer.Layer<StorageAdapter> =
	makeInMemoryStorageLayer();
