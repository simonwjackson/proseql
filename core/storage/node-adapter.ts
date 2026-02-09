/**
 * Node.js filesystem storage adapter for the persistence system.
 * Provides atomic writes, file watching, and directory management.
 */

import { promises as fs } from "fs";
import { watch } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import type { StorageAdapter, StorageAdapterOptions } from "./types.js";
import { StorageError } from "./types.js";

/**
 * Creates a Node.js filesystem storage adapter with atomic write operations.
 *
 * @param options - Configuration options for the adapter
 * @returns A storage adapter instance
 */
export function createNodeStorageAdapter(
	options: StorageAdapterOptions = {},
): StorageAdapter {
	const {
		maxRetries = 3,
		retryDelay = 100,
		createMissingDirectories = true,
		fileMode = 0o644,
		dirMode = 0o755,
	} = options;

	/**
	 * Retry a function with exponential backoff
	 */
	async function withRetry<T>(
		operation: () => Promise<T>,
		path: string,
		operationName: string,
	): Promise<T> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error;

				if (attempt < maxRetries) {
					// Exponential backoff with jitter
					const delay = retryDelay * Math.pow(2, attempt) + Math.random() * 100;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw new StorageError(
			`${operationName} failed after ${maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : "Unknown error"}`,
			path,
			lastError,
			operationName as "read" | "write" | "exists" | "watch" | "ensureDir",
		);
	}

	return {
		read: async (path: string): Promise<Buffer | string> => {
			return withRetry(
				async () => {
					try {
						return await fs.readFile(path);
					} catch (error) {
						if (error instanceof Error && "code" in error) {
							if (error.code === "ENOENT") {
								throw new StorageError(
									`File not found: ${path}`,
									path,
									error,
									"read",
								);
							}
							if (error.code === "EACCES") {
								throw new StorageError(
									`Permission denied: ${path}`,
									path,
									error,
									"read",
								);
							}
						}
						throw error;
					}
				},
				path,
				"read",
			);
		},

		write: async (path: string, data: Buffer | string): Promise<void> => {
			return withRetry(
				async () => {
					if (createMissingDirectories) {
						await ensureDirectoryExists(dirname(path));
					}

					// Atomic write using temporary file
					const tempPath = `${path}.tmp.${randomBytes(8).toString("hex")}`;

					try {
						await fs.writeFile(tempPath, data, { mode: fileMode });
						await fs.rename(tempPath, path);
					} catch (error) {
						// Clean up temp file on error
						try {
							await fs.unlink(tempPath);
						} catch {
							// Ignore cleanup errors
						}

						if (error instanceof Error && "code" in error) {
							if (error.code === "EACCES") {
								throw new StorageError(
									`Permission denied: ${path}`,
									path,
									error,
									"write",
								);
							}
							if (error.code === "ENOSPC") {
								throw new StorageError(
									`No space left on device: ${path}`,
									path,
									error,
									"write",
								);
							}
						}
						throw error;
					}
				},
				path,
				"write",
			);
		},

		exists: async (path: string): Promise<boolean> => {
			try {
				await fs.access(path);
				return true;
			} catch {
				return false;
			}
		},

		watch: (path: string, callback: () => void): (() => void) => {
			let watcher: ReturnType<typeof watch> | undefined;

			try {
				watcher = watch(path, { persistent: false }, (eventType) => {
					// Only trigger on actual file changes, not just access
					if (eventType === "change") {
						callback();
					}
				});

				return () => {
					if (watcher) {
						watcher.close();
						watcher = undefined;
					}
				};
			} catch (error) {
				// Return a no-op cleanup function if watching fails
				return () => {};
			}
		},

		ensureDir: async (path: string): Promise<void> => {
			const directory = dirname(path);
			return withRetry(
				async () => {
					await ensureDirectoryExists(directory);
				},
				directory,
				"ensureDir",
			);
		},
	};

	/**
	 * Recursively ensure that a directory exists
	 */
	async function ensureDirectoryExists(directory: string): Promise<void> {
		try {
			await fs.mkdir(directory, { recursive: true, mode: dirMode });
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				if (error.code === "EEXIST") {
					// Directory already exists, which is fine
					return;
				}
				if (error.code === "EACCES") {
					throw new StorageError(
						`Permission denied creating directory: ${directory}`,
						directory,
						error,
						"ensureDir",
					);
				}
			}
			throw error;
		}
	}
}

/**
 * Default Node.js storage adapter instance with standard configuration.
 */
export const defaultNodeStorageAdapter = createNodeStorageAdapter();
