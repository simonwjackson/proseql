/**
 * Node.js filesystem implementation of StorageAdapter as an Effect Layer.
 * Provides atomic writes (temp file + rename) and retry with exponential backoff.
 */

import { randomBytes } from "node:crypto";
import { promises as fs, watch as fsWatch } from "node:fs";
import { dirname } from "node:path";
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
	Schedule.intersect(
		Schedule.exponential(config.baseDelay),
		Schedule.recurs(config.maxRetries),
	);

// ============================================================================
// Storage operations
// ============================================================================

const makeRead =
	(config: Required<NodeAdapterConfig>) =>
	(path: string): Effect.Effect<string, StorageError> =>
		Effect.tryPromise({
			try: () => fs.readFile(path, "utf-8"),
			catch: (error) => toStorageError(path, "read", error),
		}).pipe(Effect.retry(retryPolicy(config)));

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
			Effect.catchAll((error) =>
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
		Effect.tryPromise({
			try: () => fs.access(path).then(() => true),
			catch: () => false as never,
		}).pipe(Effect.catchAll(() => Effect.succeed(false)));

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
				const watcher = fsWatch(path, { persistent: false }, (eventType) => {
					if (eventType === "change") {
						onChange();
					}
				});
				return () => {
					watcher.close();
				};
			},
			catch: (error) => toStorageError(path, "watch", error),
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
