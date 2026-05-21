/**
 * Node.js filesystem implementation of StorageAdapter as an Effect Layer.
 * Provides atomic writes (temp file + rename) and retry with exponential backoff.
 */

import { randomBytes } from "node:crypto";
import { promises as fs, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import {
	StorageAdapterService as StorageAdapter,
	type StorageAdapterShape,
	StorageError,
} from "@proseql/core";
import { Effect, Layer, Schedule } from "effect";

// ============================================================================
// Configuration
// ============================================================================

export interface NodeAdapterConfig {
	readonly maxRetries?: number;
	readonly baseDelay?: number; // milliseconds
	readonly createMissingDirectories?: boolean;
	readonly fileMode?: number;
	readonly dirMode?: number;
}

const defaultConfig: Required<NodeAdapterConfig> = {
	maxRetries: 3,
	baseDelay: 100,
	createMissingDirectories: true,
	fileMode: 0o644,
	dirMode: 0o755,
};

// ============================================================================
// Helpers
// ============================================================================

const toStorageError = (
	path: string,
	operation: StorageError["operation"],
	error: unknown,
): StorageError =>
	new StorageError({
		path,
		operation,
		message:
			error instanceof Error ? error.message : `Unknown ${operation} error`,
		cause: error,
	});

const retryPolicy = (config: Required<NodeAdapterConfig>) =>
	Schedule.exponential(`${config.baseDelay} millis`).pipe(
		Schedule.both(Schedule.recurs(config.maxRetries)),
	);

// ============================================================================
// Storage operations
// ============================================================================

const makeRead =
	(config: Required<NodeAdapterConfig>) =>
	(path: string): Effect.Effect<string, StorageError> =>
		Effect.tryPromise<string, StorageError>({
			try: () => fs.readFile(path, "utf-8"),
			catch: (error) => toStorageError(path, "read", error),
		}).pipe(Effect.retry(retryPolicy(config))) as Effect.Effect<
			string,
			StorageError
		>;

const makeWrite =
	(config: Required<NodeAdapterConfig>) =>
	(path: string, data: string): Effect.Effect<void, StorageError> => {
		const tempPath = `${path}.tmp.${randomBytes(8).toString("hex")}`;

		const ensureParentDir = config.createMissingDirectories
			? Effect.tryPromise({
					try: () =>
						fs.mkdir(dirname(path), {
							recursive: true,
							mode: config.dirMode,
						}),
					catch: (error) => toStorageError(dirname(path), "write", error),
				}).pipe(Effect.asVoid)
			: Effect.void;

		const writeAndRename = Effect.tryPromise({
			try: () => fs.writeFile(tempPath, data, { mode: config.fileMode }),
			catch: (error) => toStorageError(path, "write", error),
		}).pipe(
			Effect.andThen(
				Effect.tryPromise({
					try: () => fs.rename(tempPath, path),
					catch: (error) => toStorageError(path, "write", error),
				}),
			),
			Effect.catch((error) =>
				Effect.tryPromise({
					try: () => fs.unlink(tempPath),
					catch: () => error,
				}).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
			),
		);

		return ensureParentDir.pipe(
			Effect.andThen(writeAndRename),
			Effect.retry(retryPolicy(config)),
		);
	};

const makeAppend =
	(config: Required<NodeAdapterConfig>) =>
	(path: string, data: string): Effect.Effect<void, StorageError> => {
		const ensureParentDir = config.createMissingDirectories
			? Effect.tryPromise({
					try: () =>
						fs.mkdir(dirname(path), {
							recursive: true,
							mode: config.dirMode,
						}),
					catch: (error) => toStorageError(dirname(path), "write", error),
				}).pipe(Effect.asVoid)
			: Effect.void;

		return ensureParentDir.pipe(
			Effect.andThen(
				Effect.tryPromise({
					try: () => fs.appendFile(path, data, { mode: config.fileMode }),
					catch: (error) => toStorageError(path, "write", error),
				}),
			),
			Effect.retry(retryPolicy(config)),
		);
	};

const makeExists =
	(_config: Required<NodeAdapterConfig>) =>
	(path: string): Effect.Effect<boolean, StorageError> =>
		Effect.tryPromise<boolean, StorageError>({
			try: () => fs.access(path).then(() => true),
			catch: (error) => toStorageError(path, "read", error),
		}).pipe(Effect.catch(() => Effect.succeed(false))) as Effect.Effect<
			boolean,
			StorageError
		>;

const makeRemove =
	(config: Required<NodeAdapterConfig>) =>
	(path: string): Effect.Effect<void, StorageError> =>
		Effect.tryPromise({
			try: () => fs.unlink(path),
			catch: (error) => toStorageError(path, "delete", error),
		}).pipe(Effect.retry(retryPolicy(config)));

const makeEnsureDir =
	(config: Required<NodeAdapterConfig>) =>
	(path: string): Effect.Effect<void, StorageError> =>
		Effect.tryPromise({
			try: () =>
				fs.mkdir(dirname(path), { recursive: true, mode: config.dirMode }),
			catch: (error) => toStorageError(dirname(path), "write", error),
		}).pipe(Effect.asVoid, Effect.retry(retryPolicy(config)));

// ============================================================================
// Layer construction
// ============================================================================

const makeWatch =
	(_config: Required<NodeAdapterConfig>) =>
	(
		path: string,
		onChange: () => void,
	): Effect.Effect<() => void, StorageError> =>
		Effect.try({
			try: () => {
				const watcher = fsWatch(
					path,
					{ persistent: false },
					(eventType: string) => {
						if (eventType === "change") {
							onChange();
						}
					},
				);
				return () => {
					watcher.close();
				};
			},
			catch: (error) => toStorageError(path, "watch", error),
		});

const makeListDirectory =
	(_config: Required<NodeAdapterConfig>) =>
	(dirPath: string): Effect.Effect<ReadonlyArray<string>, StorageError> =>
		Effect.tryPromise({
			try: async () => {
				try {
					const entries = await fs.readdir(dirPath, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isFile())
						.map((entry) => join(dirPath, entry.name));
				} catch (err: unknown) {
					// Directory doesn't exist — return empty array
					if (err instanceof Error && "code" in err && err.code === "ENOENT") {
						return [];
					}
					throw err;
				}
			},
			catch: (error) => toStorageError(dirPath, "list", error),
		});

const makeListRecursive =
	(_config: Required<NodeAdapterConfig>) =>
	(rootPath: string): Effect.Effect<ReadonlyArray<string>, StorageError> =>
		Effect.tryPromise({
			try: async () => {
				const files: string[] = [];
				const visit = async (dirPath: string): Promise<void> => {
					let entries: ReadonlyArray<{
						readonly name: string;
						readonly isDirectory: () => boolean;
						readonly isFile: () => boolean;
					}>;
					try {
						entries = await fs.readdir(dirPath, { withFileTypes: true });
					} catch (err: unknown) {
						if (
							err instanceof Error &&
							"code" in err &&
							err.code === "ENOENT"
						) {
							return;
						}
						throw err;
					}

					for (const entry of entries) {
						const child = join(dirPath, entry.name);
						if (entry.isDirectory()) {
							await visit(child);
						} else if (entry.isFile()) {
							files.push(child);
						}
					}
				};
				await visit(rootPath);
				return files.sort();
			},
			catch: (error) => toStorageError(rootPath, "list", error),
		});

const makeWatchDir =
	(_config: Required<NodeAdapterConfig>) =>
	(
		dirPath: string,
		onChange: (event: {
			readonly filename: string | null;
			readonly type: "add" | "change" | "remove";
		}) => void,
	): Effect.Effect<() => void, StorageError> =>
		Effect.try({
			try: () => {
				const watcher = fsWatch(
					dirPath,
					{ persistent: false },
					(eventType, filename) => {
						// Map fs.watch events to our event types
						// "rename" can mean add or remove — callers must reconcile
						const type = eventType === "rename" ? "add" : "change";
						onChange({
							filename: typeof filename === "string" ? filename : null,
							type,
						});
					},
				);
				return () => {
					watcher.close();
				};
			},
			catch: (error) => toStorageError(dirPath, "watch", error),
		});

const makeAdapter = (
	config: Required<NodeAdapterConfig>,
): StorageAdapterShape => ({
	read: makeRead(config),
	write: makeWrite(config),
	append: makeAppend(config),
	exists: makeExists(config),
	remove: makeRemove(config),
	ensureDir: makeEnsureDir(config),
	watch: makeWatch(config),
	listDirectory: makeListDirectory(config),
	listRecursive: makeListRecursive(config),
	watchDir: makeWatchDir(config),
});

/**
 * Creates a NodeStorageLayer with custom configuration.
 */
export const makeNodeStorageLayer = (
	config: NodeAdapterConfig = {},
): Layer.Layer<StorageAdapter> => {
	const resolved = { ...defaultConfig, ...config };
	return Layer.succeed(StorageAdapter, makeAdapter(resolved));
};

/**
 * Default NodeStorageLayer with standard configuration.
 */
export const NodeStorageLayer: Layer.Layer<StorageAdapter> =
	makeNodeStorageLayer();
