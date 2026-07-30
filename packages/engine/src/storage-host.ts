import { randomBytes } from "node:crypto";
import { promises as fs, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import {
	StorageAdapterService as StorageAdapter,
	StorageError,
	type StorageAdapterShape,
} from "@proseql/core";
import { Effect, Layer } from "effect";

export interface NodeEngineStorageHostConfig {
	readonly createMissingDirectories?: boolean;
	readonly fileMode?: number;
	readonly dirMode?: number;
}

const defaultConfig: Required<NodeEngineStorageHostConfig> = {
	createMissingDirectories: true,
	fileMode: 0o644,
	dirMode: 0o755,
};

export const toEngineStorageError = (
	path: string,
	operation: StorageError["operation"],
	error: unknown,
): StorageError =>
	new StorageError({
		path,
		operation,
		message: error instanceof Error ? error.message : `Unknown ${operation} error`,
		cause: error,
	});

export interface NodeEngineStorageHost {
	readonly read: (path: string) => Promise<string>;
	readonly write: (path: string, data: string) => Promise<void>;
	readonly append: (path: string, data: string) => Promise<void>;
	readonly exists: (path: string) => Promise<boolean>;
	readonly remove: (path: string) => Promise<void>;
	readonly ensureDir: (path: string) => Promise<void>;
	readonly listDirectory: (dirPath: string) => Promise<ReadonlyArray<string>>;
	readonly listRecursive: (rootPath: string) => Promise<ReadonlyArray<string>>;
	readonly watch: (
		path: string,
		onChange: () => void,
	) => Promise<() => void>;
	readonly watchDir: (
		dirPath: string,
		onChange: (event: {
			readonly filename: string | null;
			readonly type: "add" | "change" | "remove";
		}) => void,
	) => Promise<() => void>;
}

export const createNodeEngineStorageHost = (
	config: NodeEngineStorageHostConfig = {},
): NodeEngineStorageHost => {
	const resolved = { ...defaultConfig, ...config };
	const ensureParent = async (path: string) => {
		if (!resolved.createMissingDirectories) return;
		await fs.mkdir(dirname(path), { recursive: true, mode: resolved.dirMode });
	};
	return {
		read: (path) => fs.readFile(path, "utf8"),
		write: async (path, data) => {
			await ensureParent(path);
			const tempPath = `${path}.tmp.${randomBytes(8).toString("hex")}`;
			try {
				await fs.writeFile(tempPath, data, { mode: resolved.fileMode });
				await fs.rename(tempPath, path);
			} catch (error) {
				try {
					await fs.unlink(tempPath);
				} catch {
					// best-effort temp file cleanup
				}
				throw error;
			}
		},
		append: async (path, data) => {
			await ensureParent(path);
			await fs.appendFile(path, data, { mode: resolved.fileMode });
		},
		exists: async (path) => {
			try {
				await fs.access(path);
				return true;
			} catch {
				return false;
			}
		},
		remove: async (path) => {
			await fs.unlink(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		},
		ensureDir: async (path) => {
			await fs.mkdir(dirname(path), { recursive: true, mode: resolved.dirMode });
		},
		listDirectory: async (dirPath) => {
			try {
				const entries = await fs.readdir(dirPath, { withFileTypes: true });
				return entries
					.filter((entry) => entry.isFile())
					.map((entry) => join(dirPath, entry.name))
					.sort();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		},
		listRecursive: async (rootPath) => {
			const files: string[] = [];
			const visit = async (dirPath: string) => {
				let entries: any[];
				try {
					entries = await fs.readdir(dirPath, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				for (const entry of entries) {
					const child = join(dirPath, entry.name);
					if (entry.isDirectory()) await visit(child);
					else if (entry.isFile()) files.push(child);
				}
			};
			await visit(rootPath);
			return files.sort();
		},
		watch: async (path, onChange) => {
			const watcher = fsWatch(path, { persistent: false }, (eventType) => {
				if (eventType === "change" || eventType === "rename") onChange();
			});
			return () => watcher.close();
		},
		watchDir: async (dirPath, onChange) => {
			const watchers = new Map<string, ReturnType<typeof fsWatch>>();
			const watchDirectory = async (watchedDir: string): Promise<void> => {
				if (watchers.has(watchedDir)) return;
				let entries: any[];
				try {
					entries = await fs.readdir(watchedDir, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				const watcher = fsWatch(
					watchedDir,
					{ persistent: false },
					(eventType, filename) => {
						const childPath = typeof filename === "string" ? join(watchedDir, filename) : null;
						onChange({
							filename: childPath,
							type: eventType === "rename" ? "add" : "change",
						});
						if (childPath) {
							void (async () => {
								try {
									const stat = await fs.stat(childPath);
									if (stat.isDirectory()) await watchDirectory(childPath);
								} catch {
									// ignore races where the entry disappears before inspection
								}
							})();
						}
					},
				);
				watchers.set(watchedDir, watcher);
				for (const entry of entries) {
					if (entry.isDirectory()) await watchDirectory(join(watchedDir, entry.name));
				}
			};
			await watchDirectory(dirPath);
			return () => {
				for (const watcher of watchers.values()) watcher.close();
				watchers.clear();
			};
		},
	};
};

export const makeEngineStorageLayer = (
	host: NodeEngineStorageHost,
): Layer.Layer<any> => {
	const adapter: StorageAdapterShape = {
		read: (path: string) =>
			Effect.tryPromise({
				try: () => host.read(path),
				catch: (error) => toEngineStorageError(path, "read", error),
			}),
		write: (path: string, data: string) =>
			Effect.tryPromise({
				try: () => host.write(path, data),
				catch: (error) => toEngineStorageError(path, "write", error),
			}),
		append: (path: string, data: string) =>
			Effect.tryPromise({
				try: () => host.append(path, data),
				catch: (error) => toEngineStorageError(path, "write", error),
			}),
		exists: (path: string) =>
			Effect.tryPromise({
				try: () => host.exists(path),
				catch: (error) => toEngineStorageError(path, "read", error),
			}),
		remove: (path: string) =>
			Effect.tryPromise({
				try: () => host.remove(path),
				catch: (error) => toEngineStorageError(path, "delete", error),
			}),
		ensureDir: (path: string) =>
			Effect.tryPromise({
				try: () => host.ensureDir(path),
				catch: (error) => toEngineStorageError(path, "write", error),
			}),
		watch: (path: string, onChange: () => void) =>
			Effect.tryPromise({
				try: () => host.watch(path, onChange),
				catch: (error) => toEngineStorageError(path, "watch", error),
			}),
		listDirectory: (dirPath: string) =>
			Effect.tryPromise({
				try: () => host.listDirectory(dirPath),
				catch: (error) => toEngineStorageError(dirPath, "list", error),
			}),
		listRecursive: (rootPath: string) =>
			Effect.tryPromise({
				try: () => host.listRecursive(rootPath),
				catch: (error) => toEngineStorageError(rootPath, "list", error),
			}),
		watchDir: (
			dirPath: string,
			onChange: (event: {
				readonly filename: string | null;
				readonly type: "add" | "change" | "remove";
			}) => void,
		) =>
			Effect.tryPromise({
				try: () => host.watchDir(dirPath, onChange),
				catch: (error) => toEngineStorageError(dirPath, "watch", error),
			}),
	};
	return Layer.succeed(StorageAdapter, adapter);
};

export const makeNodeEngineStorageLayer = (
	config: NodeEngineStorageHostConfig = {},
): Layer.Layer<any> => makeEngineStorageLayer(createNodeEngineStorageHost(config));
