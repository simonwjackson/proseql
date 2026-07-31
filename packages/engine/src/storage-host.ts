import { randomBytes } from "node:crypto";
import { promises as fs, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import {
	makeEngineStorageLayer,
	type EngineStorageHost,
} from "./storage-host-shared.js";

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

export type NodeEngineStorageHost = EngineStorageHost;

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
				let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
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
				let entries: Array<{ isDirectory(): boolean; name: string }>;
				try {
					entries = await fs.readdir(watchedDir, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				const watcher = fsWatch(watchedDir, { persistent: false }, (eventType, filename) => {
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
				});
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

export { makeEngineStorageLayer } from "./storage-host-shared.js";

export const makeNodeEngineStorageLayer = (
	config: NodeEngineStorageHostConfig = {},
): import("effect").Layer.Layer<any> =>
	makeEngineStorageLayer(createNodeEngineStorageHost(config));
