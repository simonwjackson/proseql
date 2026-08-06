import {
	StorageAdapterService as StorageAdapter,
	type StorageAdapterShape,
	StorageError,
	UnsupportedFormatError,
} from "@proseql/core";
import { Effect, Layer } from "effect";

export type EngineStorageWatchEvent = {
	readonly filename: string | null;
	readonly type: "add" | "change" | "remove";
};

export interface EngineStorageHost {
	readonly __proseqlBrowserStorageHost?: true;
	readonly read: (path: string) => Promise<string>;
	readonly write: (path: string, data: string) => Promise<void>;
	readonly append: (path: string, data: string) => Promise<void>;
	readonly exists: (path: string) => Promise<boolean>;
	readonly remove: (path: string) => Promise<void>;
	readonly ensureDir: (path: string) => Promise<void>;
	readonly listDirectory: (dirPath: string) => Promise<ReadonlyArray<string>>;
	readonly listRecursive: (rootPath: string) => Promise<ReadonlyArray<string>>;
	readonly watch: (path: string, onChange: () => void) => Promise<() => void>;
	readonly watchDir: (
		dirPath: string,
		onChange: (event: EngineStorageWatchEvent) => void,
	) => Promise<() => void>;
}

export const toEngineStorageError = (
	path: string,
	operation: StorageError["operation"],
	error: unknown,
): StorageError => {
	if (error instanceof StorageError) {
		return error;
	}
	return new StorageError({
		path,
		operation,
		message:
			error instanceof Error ? error.message : `Unknown ${operation} error`,
		cause: error,
	});
};

export const toEngineStorageReadWriteError = (
	path: string,
	operation: StorageError["operation"],
	error: unknown,
): StorageError | UnsupportedFormatError => {
	if (
		error instanceof UnsupportedFormatError ||
		error instanceof StorageError
	) {
		return error;
	}
	return toEngineStorageError(path, operation, error);
};

export const createEngineStorageAdapter = (
	host: EngineStorageHost,
): StorageAdapterShape => ({
	read: (path: string) =>
		Effect.tryPromise({
			try: () => host.read(path),
			catch: (error) => toEngineStorageReadWriteError(path, "read", error),
		}),
	write: (path: string, data: string) =>
		Effect.tryPromise({
			try: () => host.write(path, data),
			catch: (error) => toEngineStorageReadWriteError(path, "write", error),
		}),
	append: (path: string, data: string) =>
		Effect.tryPromise({
			try: () => host.append(path, data),
			catch: (error) => toEngineStorageReadWriteError(path, "write", error),
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
	watchDir: (dirPath: string, onChange) =>
		Effect.tryPromise({
			try: () => host.watchDir(dirPath, onChange),
			catch: (error) => toEngineStorageError(dirPath, "watch", error),
		}),
});

export const makeEngineStorageLayer = (
	host: EngineStorageHost,
): Layer.Layer<any> =>
	Layer.succeed(StorageAdapter, createEngineStorageAdapter(host));
