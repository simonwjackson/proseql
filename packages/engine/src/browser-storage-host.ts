import { StorageError, UnsupportedFormatError } from "@proseql/core";
import type {
	EngineStorageHost,
	EngineStorageWatchEvent,
} from "./storage-host-shared.js";
import {
	dirnameComparable,
	isWithinComparableDirectory,
	matchesComparableFile,
	normalizeComparablePath,
} from "./path-utils.js";

export const DEFAULT_STORAGE_KEY_PREFIX = "proseql:";

export interface BrowserStorageHostConfig {
	readonly keyPrefix?: string;
	readonly allowedFormats?: ReadonlyArray<string>;
	readonly originId?: string;
}

export interface WebStorageEngineHostConfig extends BrowserStorageHostConfig {
	readonly storage?: Storage;
	readonly kind?: "localStorage" | "sessionStorage";
}

export interface IndexedDBEngineHostConfig extends BrowserStorageHostConfig {
	readonly databaseName?: string;
	readonly storeName?: string;
	readonly version?: number;
	readonly indexedDB?: IDBFactory;
	readonly channelName?: string;
}

type BrowserStorageChange = {
	readonly namespace: string;
	readonly path: string;
	readonly type: "add" | "change" | "remove";
	readonly originId: string;
};

type LocalListener = (event: BrowserStorageChange) => void;

const localListeners = new Map<string, Set<LocalListener>>();
const indexedDbCache = new Map<string, Promise<IDBDatabase>>();
const storageObjectIds = new WeakMap<object, number>();
const indexedDbFactoryIds = new WeakMap<object, number>();
let nextBrowserObjectId = 1;

const normalizeAllowedFormats = (
	allowedFormats: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined =>
	allowedFormats === undefined ? undefined : allowedFormats.map((value) => value.toLowerCase());

const getFileExtension = (filePath: string): string => {
	const lastDotIndex = filePath.lastIndexOf(".");
	const lastSlashIndex = Math.max(
		filePath.lastIndexOf("/"),
		filePath.lastIndexOf("\\"),
	);
	if (lastDotIndex === -1 || lastDotIndex <= lastSlashIndex) return "";
	return filePath.slice(lastDotIndex + 1).toLowerCase();
};

const validateAllowedFormat = (
	path: string,
	allowedFormats: ReadonlyArray<string> | undefined,
): void => {
	if (allowedFormats === undefined || allowedFormats.length === 0) return;
	const ext = getFileExtension(path);
	if (ext === "" || allowedFormats.includes(ext)) return;
	throw new UnsupportedFormatError({
		format: ext,
		message: `Format '.${ext}' is not allowed. Allowed formats: ${allowedFormats.map((value) => `.${value}`).join(", ")}`,
	});
};

const pathToKey = (
	path: string,
	prefix: string = DEFAULT_STORAGE_KEY_PREFIX,
): string => `${prefix}${normalizeComparablePath(path)}`;

const keyToPath = (key: string, prefix: string): string | null =>
	key.startsWith(prefix) ? key.slice(prefix.length) : null;

const createOriginId = (): string =>
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `origin-${Math.random().toString(36).slice(2)}`;

const objectIdentity = (target: object, ids: WeakMap<object, number>): number => {
	const existing = ids.get(target);
	if (existing !== undefined) return existing;
	const created = nextBrowserObjectId++;
	ids.set(target, created);
	return created;
};

const createWebStorageNamespace = (
	storage: Storage,
	kind: "localStorage" | "sessionStorage",
	prefix: string,
): string => `${kind}:${objectIdentity(storage as object, storageObjectIds)}:${prefix}`;

const createIndexedDbCacheKey = (
	factory: IDBFactory | undefined,
	config: Required<Pick<IndexedDBEngineHostConfig, "databaseName" | "storeName" | "version">>,
): string =>
	`${factory ? objectIdentity(factory as object, indexedDbFactoryIds) : "global"}:${config.databaseName}:${config.storeName}:${config.version}`;

const subscribeLocal = (namespace: string, listener: LocalListener): (() => void) => {
	const listeners = localListeners.get(namespace) ?? new Set<LocalListener>();
	listeners.add(listener);
	localListeners.set(namespace, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) localListeners.delete(namespace);
	};
};

const publishLocal = (event: BrowserStorageChange): void => {
	for (const listener of localListeners.get(event.namespace) ?? []) {
		listener(event);
	}
};

const makeStorageError = (
	path: string,
	operation: StorageError["operation"],
	message: string,
	cause?: unknown,
): StorageError => new StorageError({ path, operation, message, cause });

const quotaStorageError = (path: string, action: "writing" | "appending to"): StorageError =>
	new StorageError({
		path,
		operation: "write",
		message: `Storage quota exceeded while ${action} '${path}'`,
	});

const storageDeniedError = (path: string, operation: StorageError["operation"], error: unknown): StorageError =>
	new StorageError({
		path,
		operation,
		message:
			error instanceof DOMException && error.name === "SecurityError"
				? `Browser storage denied access for '${path}'`
				: error instanceof Error
					? error.message
					: `Unknown ${operation} error`,
		cause: error,
	});

const watchEventForPath = (path: string, type: "add" | "change" | "remove"): EngineStorageWatchEvent => ({
	filename: normalizeComparablePath(path),
	type,
});

const matchesDirectoryEvent = (event: BrowserStorageChange, directory: string) =>
	isWithinComparableDirectory(event.path, directory);

const watchStorageEvent = (
	storage: Storage,
	prefix: string,
	kind: "localStorage" | "sessionStorage",
	originId: string,
	handler: (event: BrowserStorageChange) => void,
): (() => void) => {
	const namespace = createWebStorageNamespace(storage, kind, prefix);
	const unsubscribeLocal = subscribeLocal(namespace, (event) => {
		if (event.originId === originId) return;
		handler(event);
	});
	const eventTarget =
		typeof globalThis.window === "object" && globalThis.window !== null
			? globalThis.window
			: globalThis;
	if (
		kind !== "localStorage" ||
		typeof eventTarget.addEventListener !== "function" ||
		typeof eventTarget.removeEventListener !== "function"
	) {
		return unsubscribeLocal;
	}
	const listener = (event: StorageEvent) => {
		if (event.key === null) {
			handler({
				namespace,
				path: "",
				type: "change",
				originId: "external",
			});
			return;
		}
		const path = keyToPath(event.key, prefix);
		if (path === null) return;
		handler({
			namespace,
			path,
			type:
				event.newValue === null
					? "remove"
					: event.oldValue === null
						? "add"
						: "change",
			originId: "external",
		});
	};
	eventTarget.addEventListener("storage", listener as EventListener);
	return () => {
		unsubscribeLocal();
		eventTarget.removeEventListener("storage", listener as EventListener);
	};
};

const emitWebStorageChange = (
	storage: Storage,
	kind: "localStorage" | "sessionStorage",
	prefix: string,
	originId: string,
	path: string,
	type: "add" | "change" | "remove",
) => {
	publishLocal({
		namespace: createWebStorageNamespace(storage, kind, prefix),
		path: normalizeComparablePath(path),
		type,
		originId,
	});
};

const listStoragePaths = (storage: Storage, prefix: string): ReadonlyArray<string> => {
	const paths: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key?.startsWith(prefix)) continue;
		paths.push(key.slice(prefix.length));
	}
	paths.sort();
	return paths;
};

export const createWebStorageEngineStorageHost = (
	config: WebStorageEngineHostConfig,
): EngineStorageHost => {
	const kind = config.kind ?? "localStorage";
	const storage =
		config.storage ??
		(kind === "localStorage" ? globalThis.localStorage : globalThis.sessionStorage);
	const prefix = config.keyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX;
	const allowedFormats = normalizeAllowedFormats(config.allowedFormats);
	const originId = config.originId ?? createOriginId();

	const writeValue = (path: string, nextValue: string, existingValue: string | null) => {
		try {
			storage.setItem(pathToKey(path, prefix), nextValue);
			emitWebStorageChange(storage, kind, prefix, originId, path, existingValue === null ? "add" : "change");
		} catch (error) {
			if (error instanceof DOMException && error.name === "QuotaExceededError") {
				throw quotaStorageError(path, "writing");
			}
			throw storageDeniedError(path, "write", error);
		}
	};

	return {
		__proseqlBrowserStorageHost: true,
		async read(path) {
			validateAllowedFormat(path, allowedFormats);
			const value = storage.getItem(pathToKey(path, prefix));
			if (value === null) {
				throw makeStorageError(path, "read", `Key not found: ${pathToKey(path, prefix)}`);
			}
			return value;
		},
		async write(path, data) {
			validateAllowedFormat(path, allowedFormats);
			const existing = storage.getItem(pathToKey(path, prefix));
			writeValue(path, data, existing);
		},
		async append(path, data) {
			validateAllowedFormat(path, allowedFormats);
			const key = pathToKey(path, prefix);
			const existing = storage.getItem(key);
			writeValue(path, `${existing ?? ""}${data}`, existing);
		},
		async exists(path) {
			const exact = storage.getItem(pathToKey(path, prefix));
			if (exact !== null) return true;
			const directoryPrefix = `${pathToKey(path, prefix)}/`;
			for (let index = 0; index < storage.length; index += 1) {
				if (storage.key(index)?.startsWith(directoryPrefix)) return true;
			}
			return false;
		},
		async remove(path) {
			const key = pathToKey(path, prefix);
			const existing = storage.getItem(key);
			storage.removeItem(key);
			if (existing !== null) {
				emitWebStorageChange(storage, kind, prefix, originId, path, "remove");
			}
		},
		async ensureDir(_path) {},
		async listDirectory(dirPath) {
			const root = normalizeComparablePath(dirPath);
			const prefixPath = root.length > 0 ? `${root}/` : "";
			return listStoragePaths(storage, prefix).filter((path) => {
				if (root.length > 0 && !path.startsWith(prefixPath)) return false;
				const remainder = root.length > 0 ? path.slice(prefixPath.length) : path;
				return remainder.length > 0 && !remainder.includes("/");
			});
		},
		async listRecursive(rootPath) {
			const root = normalizeComparablePath(rootPath);
			const prefixPath = root.length > 0 ? `${root}/` : "";
			return listStoragePaths(storage, prefix).filter((path) =>
				root.length === 0 ? true : path === root || path.startsWith(prefixPath),
			);
		},
		async watch(path, onChange) {
			return watchStorageEvent(storage, prefix, kind, originId, (event) => {
				if (!matchesComparableFile(event.path, path)) return;
				onChange();
			});
		},
		async watchDir(dirPath, onChange) {
			return watchStorageEvent(storage, prefix, kind, originId, (event) => {
				if (!matchesDirectoryEvent(event, dirPath)) return;
				onChange(watchEventForPath(event.path, event.type));
			});
		},
	};
};

export const createLocalStorageEngineStorageHost = (
	config: Omit<WebStorageEngineHostConfig, "kind"> = {},
): EngineStorageHost => createWebStorageEngineStorageHost({ ...config, kind: "localStorage" });

export const createSessionStorageEngineStorageHost = (
	config: Omit<WebStorageEngineHostConfig, "kind"> = {},
): EngineStorageHost => createWebStorageEngineStorageHost({ ...config, kind: "sessionStorage" });

const createIndexedDbNamespace = (
	factory: IDBFactory | undefined,
	config: IndexedDBEngineHostConfig,
	prefix: string,
): string =>
	config.channelName ??
	`indexeddb:${factory ? objectIdentity(factory as object, indexedDbFactoryIds) : "global"}:${config.databaseName ?? "proseql"}:${config.storeName ?? "collections"}:${prefix}`;

const isLikelyDirectoryPath = (path: string): boolean =>
	getFileExtension(path) === "";

const openIndexedDb = async (
	factory: IDBFactory | undefined,
	config: Required<Pick<IndexedDBEngineHostConfig, "databaseName" | "storeName" | "version">>,
): Promise<IDBDatabase> => {
	if (!factory) {
		throw makeStorageError(
			config.databaseName,
			"read",
			"IndexedDB is not available in this environment. Provide persistenceOptions.storageHost explicitly or run in a browser with indexedDB.",
		);
	}
	const cacheKey = createIndexedDbCacheKey(factory, config);
	const cached = indexedDbCache.get(cacheKey);
	if (cached) return cached;
	const opened = new Promise<IDBDatabase>((resolve, reject) => {
		const rejectAndEvict = (error: StorageError) => {
			indexedDbCache.delete(cacheKey);
			reject(error);
		};
		const request = factory.open(config.databaseName, config.version);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(config.storeName)) {
				db.createObjectStore(config.storeName);
			}
		};
		request.onerror = () => {
			rejectAndEvict(
				makeStorageError(
					config.databaseName,
					"read",
					`Failed to open IndexedDB database: ${request.error?.message ?? "Unknown error"}`,
					request.error,
				),
			);
		};
		request.onblocked = () => {
			rejectAndEvict(
				makeStorageError(
					config.databaseName,
					"read",
					"IndexedDB database is blocked. Close other tabs using this database.",
				),
			);
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
	});
	indexedDbCache.set(cacheKey, opened);
	return opened;
};

const withStore = async <T>(
	db: IDBDatabase,
	storeName: string,
	mode: IDBTransactionMode,
	path: string,
	operation: StorageError["operation"],
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		try {
			const transaction = db.transaction(storeName, mode);
			const store = transaction.objectStore(storeName);
			const request = run(store);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(storageDeniedError(path, operation, request.error));
		} catch (error) {
			reject(storageDeniedError(path, operation, error));
		}
	});

const listIndexedDbKeys = async (
	db: IDBDatabase,
	storeName: string,
	path: string,
): Promise<ReadonlyArray<string>> => {
	const keys = await withStore<IDBValidKey[]>(db, storeName, "readonly", path, "list", (store) =>
		store.getAllKeys(),
	);
	return keys.map((value) => String(value)).sort();
};

const createBroadcastPair = (namespace: string, originId: string, handler: (event: BrowserStorageChange) => void) => {
	const unsubscribeLocal = subscribeLocal(namespace, (event) => {
		if (event.originId === originId) return;
		handler(event);
	});
	const BroadcastCtor = globalThis.BroadcastChannel;
	if (typeof BroadcastCtor !== "function") {
		return {
			post: (event: BrowserStorageChange) => publishLocal(event),
			stop: unsubscribeLocal,
		};
	}
	const channel = new BroadcastCtor(namespace);
	channel.addEventListener("message", (message) => {
		const event = message.data as BrowserStorageChange;
		if (event.originId === originId) return;
		handler(event);
	});
	return {
		post: (event: BrowserStorageChange) => {
			publishLocal(event);
			channel.postMessage(event);
		},
		stop: () => {
			unsubscribeLocal();
			channel.close();
		},
	};
};

export const createIndexedDBEngineStorageHost = (
	config: IndexedDBEngineHostConfig = {},
): EngineStorageHost => {
	const databaseName = config.databaseName ?? "proseql";
	const storeName = config.storeName ?? "collections";
	const version = config.version ?? 1;
	const factory = config.indexedDB ?? globalThis.indexedDB;
	const prefix = config.keyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX;
	const allowedFormats = normalizeAllowedFormats(config.allowedFormats);
	const originId = config.originId ?? createOriginId();
	const namespace = createIndexedDbNamespace(factory, config, prefix);
	const notify = createBroadcastPair(namespace, originId, () => {});
	const emit = (path: string, type: "add" | "change" | "remove") =>
		notify.post({ namespace, path: normalizeComparablePath(path), type, originId });
	const getDb = () => openIndexedDb(factory, { databaseName, storeName, version });

	return {
		__proseqlBrowserStorageHost: true,
		async read(path) {
			validateAllowedFormat(path, allowedFormats);
			const value = await withStore<string | undefined>(
				await getDb(),
				storeName,
				"readonly",
				path,
				"read",
				(store) => store.get(pathToKey(path, prefix)),
			);
			if (value === undefined) {
				throw makeStorageError(path, "read", `Key not found: ${pathToKey(path, prefix)}`);
			}
			return value;
		},
		async write(path, data) {
			validateAllowedFormat(path, allowedFormats);
			const db = await getDb();
			const key = pathToKey(path, prefix);
			const existing = await withStore<string | undefined>(db, storeName, "readonly", path, "read", (store) => store.get(key));
			try {
				await withStore(db, storeName, "readwrite", path, "write", (store) => store.put(data, key));
			} catch (error) {
				if (error instanceof DOMException && error.name === "QuotaExceededError") {
					throw quotaStorageError(path, "writing");
				}
				throw error;
			}
			emit(path, existing === undefined ? "add" : "change");
		},
		async append(path, data) {
			validateAllowedFormat(path, allowedFormats);
			const db = await getDb();
			const key = pathToKey(path, prefix);
			const existing = await withStore<string | undefined>(db, storeName, "readonly", path, "read", (store) => store.get(key));
			await withStore(db, storeName, "readwrite", path, "write", (store) => store.put(`${existing ?? ""}${data}`, key));
			emit(path, existing === undefined ? "add" : "change");
		},
		async exists(path) {
			const db = await getDb();
			const key = pathToKey(path, prefix);
			const count = await withStore<number>(db, storeName, "readonly", path, "read", (store) => store.count(key));
			if (count > 0) return true;
			if (!isLikelyDirectoryPath(path)) return false;
			const keys = await listIndexedDbKeys(db, storeName, path).catch(() => [] as string[]);
			return keys.some((candidate) => candidate.startsWith(`${key}/`));
		},
		async remove(path) {
			const db = await getDb();
			const key = pathToKey(path, prefix);
			const existing = await withStore<string | undefined>(db, storeName, "readonly", path, "read", (store) => store.get(key));
			await withStore(db, storeName, "readwrite", path, "delete", (store) => store.delete(key));
			if (existing !== undefined) emit(path, "remove");
		},
		async ensureDir(_path) {},
		async listDirectory(dirPath) {
			const keys = await listIndexedDbKeys(await getDb(), storeName, dirPath);
			const root = normalizeComparablePath(dirPath);
			const prefixPath = `${prefix}${root.length > 0 ? `${root}/` : ""}`;
			return keys
				.filter((key) => key.startsWith(prefixPath))
				.map((key) => key.slice(prefix.length))
				.filter((path) => {
					const remainder = root.length > 0 ? path.slice(root.length + 1) : path;
					return remainder.length > 0 && !remainder.includes("/");
				})
				.sort();
		},
		async listRecursive(rootPath) {
			const keys = await listIndexedDbKeys(await getDb(), storeName, rootPath);
			const root = normalizeComparablePath(rootPath);
			const prefixPath = `${prefix}${root.length > 0 ? `${root}/` : ""}`;
			return keys
				.filter((key) => root.length === 0 || key === `${prefix}${root}` || key.startsWith(prefixPath))
				.map((key) => key.slice(prefix.length))
				.sort();
		},
		async watch(path, onChange) {
			const listener = (event: BrowserStorageChange) => {
				if (!matchesComparableFile(event.path, path)) return;
				onChange();
			};
			const pair = createBroadcastPair(namespace, originId, listener);
			return () => pair.stop();
		},
		async watchDir(dirPath, onChange) {
			const listener = (event: BrowserStorageChange) => {
				if (!isWithinComparableDirectory(event.path, dirPath)) return;
				onChange(watchEventForPath(event.path, event.type));
			};
			const pair = createBroadcastPair(namespace, originId, listener);
			return () => pair.stop();
		},
	};
};

export type BrowserEngineStorageHost = EngineStorageHost;
export type LocalStorageEngineStorageHostConfig = Omit<WebStorageEngineHostConfig, "kind">;
export type SessionStorageEngineStorageHostConfig = Omit<WebStorageEngineHostConfig, "kind">;

export const createIndexedDbWatchRoot = (path: string): string => dirnameComparable(path);
