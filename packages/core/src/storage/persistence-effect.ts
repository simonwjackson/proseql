/**
 * Effect-based persistence functions for loading and saving collection data.
 *
 * Uses StorageAdapter and SerializerRegistry services for I/O and format handling.
 * Data is decoded/encoded through Effect Schema on load/save to ensure type safety.
 * Includes DebouncedWriter for coalescing rapid mutations into single file writes.
 */

import {
	Effect,
	Fiber,
	PubSub,
	Queue,
	Ref,
	Result,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { ValidationError } from "../errors/crud-errors.js";
import { MigrationError } from "../errors/migration-errors.js";
import {
	SerializationError,
	StorageError,
	type UnsupportedFormatError,
} from "../errors/storage-errors.js";
import { runMigrations } from "../migrations/migration-runner.js";
import type { Migration } from "../migrations/migration-types.js";
import { reloadEvent } from "../reactive/change-event.js";
import { jsonlDecodeLines } from "../serializers/codecs/jsonl.js";
import { SerializerRegistry } from "../serializers/serializer-service.js";
import type { ChangeEvent } from "../types/reactive-types.js";
import { getFileExtension } from "../utils/path.js";
import { StorageAdapter } from "./storage-service.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the file extension from a path, failing with StorageError if none found.
 */
const resolveExtension = (
	filePath: string,
): Effect.Effect<string, StorageError> => {
	const ext = getFileExtension(filePath);
	if (ext === "") {
		return Effect.fail(
			new StorageError({
				path: filePath,
				operation: "read",
				message: `Cannot determine file format: no extension in '${filePath}'`,
			}),
		);
	}
	return Effect.succeed(ext);
};

/**
 * Type guard: is the value a plain Record<string, unknown>?
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Navigate into a nested object using a dot-notation path.
 * Returns undefined if any segment along the path is missing.
 */
const getAtPath = (obj: unknown, path: string): unknown => {
	let current: unknown = obj;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
};

/**
 * Set a value at a dot-notation path within a nested object.
 * Creates intermediate objects as needed. Returns a shallow copy.
 */
const setAtPath = (
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> => {
	const segments = path.split(".");
	const root = { ...obj };
	let current: Record<string, unknown> = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		const next = current[seg];
		current[seg] = isRecord(next) ? { ...next } : {};
		current = current[seg] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = value;
	return root;
};

// ============================================================================
// loadData
// ============================================================================

/**
 * Options for loadData.
 */
export interface LoadDataOptions {
	/**
	 * Optional schema version from collection config.
	 * When provided, enables version checking and migration support.
	 */
	readonly version?: number;
	/**
	 * Optional migrations array for automatic data migration.
	 * Only used when version is also provided.
	 */
	readonly migrations?: ReadonlyArray<Migration>;
	/**
	 * Collection name for error messages.
	 * Required when version is provided.
	 */
	readonly collectionName?: string;
	/**
	 * Explicit serialization format override.
	 * When provided, this format is used instead of inferring from the file extension.
	 */
	readonly format?: string;
	/**
	 * Dot-notation path into the parsed document where the collection data lives.
	 * When provided, navigates into the document structure before loading entities.
	 * The resolved value can be a Record keyed by entity ID or an array of objects with `id`.
	 */
	readonly path?: string;
	/**
	 * Validation mode: "strict" (default) aborts on first invalid entity,
	 * "lenient" skips invalid entities with warnings.
	 */
	readonly validation?: "strict" | "lenient";
}

/**
 * Load collection data from a file, decode each entity through the given Schema.
 *
 * Flow:
 * 1. Check file existence via StorageAdapter
 * 2. Read raw content
 * 3. Deserialize via SerializerRegistry (format determined by file extension)
 * 4. Validate the top-level structure is a Record<string, object>
 * 5. Extract `_version` (default 0 if absent) and remove from entity map
 * 6. Decode each entity value through the Schema
 * 7. Return a ReadonlyMap<string, A> keyed by entity ID
 *
 * If the file does not exist, returns an empty ReadonlyMap.
 *
 * When `options.version` is provided:
 * - Extracts `_version` from the file (defaults to 0 if absent)
 * - Compares file version to config version
 * - If file version < config version: runs migrations (task 5.2)
 * - If file version > config version: fails with MigrationError
 * - If file version === config version: proceeds normally
 */
export const loadData = <A extends { readonly id: string }, I, R>(
	filePath: string,
	schema: Schema.Codec<A, I, R, R>,
	options?: LoadDataOptions,
): Effect.Effect<
	ReadonlyMap<string, A>,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const ext = options?.format ?? (yield* resolveExtension(filePath));

		// If file doesn't exist, return empty map
		const exists = yield* storage.exists(filePath);
		if (!exists) {
			return new Map<string, A>() as ReadonlyMap<string, A>;
		}

		// Read raw content
		const raw = yield* storage.read(filePath);

		const isJsonlFormat = ext === "jsonl" || ext === "ndjson";
		const isLenient = options?.validation === "lenient";
		const entityMap: Record<string, unknown> = {};
		// Map entity ID → 1-based line number (JSONL lenient mode only)
		const lineNumberMap = new Map<string, number>();
		let fileVersion = 0;

		if (isJsonlFormat && isLenient) {
			// JSONL lenient: parse line-by-line to track line numbers and
			// tolerate malformed JSON lines (skip serializer.deserialize which
			// would abort on the first bad line).
			const parsedLines = jsonlDecodeLines(raw);
			for (const line of parsedLines) {
				if (line.parseError) {
					yield* Effect.logWarning(
						`[proseql] Skipping malformed JSON at line ${line.lineNumber} in '${filePath}': ${line.parseError}`,
					);
					continue;
				}
				if (isRecord(line.parsed)) {
					const id =
						typeof line.parsed.id === "string"
							? line.parsed.id
							: String(line.lineNumber);
					entityMap[id] = line.parsed;
					lineNumberMap.set(id, line.lineNumber);
				}
			}
		} else {
			// Standard path: deserialize the entire file at once
			const parsed = yield* serializer.deserialize(raw, ext);

			// If a path is specified, navigate into the document structure
			const resolved = options?.path ? getAtPath(parsed, options.path) : parsed;

			// If path navigation resolved to undefined, return empty map
			if (resolved === undefined) {
				return new Map<string, A>() as ReadonlyMap<string, A>;
			}

			// The on-disk format depends on the file extension:
			// - JSONL/NDJSON/Prose: array of entity objects
			// - All other formats: Record<string, object> keyed by entity ID
			// When a path is specified, the resolved value may also be an array
			const isArrayFormat =
				isJsonlFormat ||
				ext === "prose" ||
				(options?.path !== undefined && Array.isArray(resolved));

			if (isArrayFormat && Array.isArray(resolved)) {
				// Array format: array of entity objects → convert to Record keyed by id
				// Entries without a string `id` get their array index as a fallback key
				for (let i = 0; i < resolved.length; i++) {
					const item = resolved[i];
					if (isRecord(item)) {
						const id = typeof item.id === "string" ? item.id : String(i);
						entityMap[id] = item;
					}
				}
			} else if (isRecord(resolved)) {
				// Standard format: Record keyed by entity ID
				fileVersion =
					typeof resolved._version === "number" ? resolved._version : 0;
				for (const [key, value] of Object.entries(resolved)) {
					if (key !== "_version") {
						entityMap[key] = value;
					}
				}
			} else {
				return yield* Effect.fail(
					new SerializationError({
						format: ext,
						message: `Invalid data format in '${filePath}'${options?.path ? ` at path '${options.path}'` : ""}: expected object or array, got ${typeof resolved}`,
					}),
				);
			}
		}

		// Determine the data to decode (may be migrated)
		let dataToLoad: Record<string, unknown> = entityMap;
		let needsWriteBack = false;
		let targetVersion: number | undefined;
		// Track if migrations were run (for post-migration validation error type)
		let migrationsRan = false;
		const fromVersionForError = fileVersion;
		let collectionNameForError = "unknown";

		// If version checking is enabled, validate version compatibility
		if (options?.version !== undefined) {
			const configVersion = options.version;
			const collectionName = options.collectionName ?? "unknown";
			collectionNameForError = collectionName;

			// File version ahead of config version is an error
			if (fileVersion > configVersion) {
				return yield* Effect.fail(
					new MigrationError({
						collection: collectionName,
						fromVersion: configVersion,
						toVersion: fileVersion,
						step: -1,
						reason: "version-ahead",
						message: `File version ${fileVersion} is ahead of config version ${configVersion}. Cannot load data from a future version.`,
					}),
				);
			}

			// If file version < config version and migrations are provided, run migrations
			if (
				fileVersion < configVersion &&
				options.migrations &&
				options.migrations.length > 0
			) {
				dataToLoad = yield* runMigrations(
					entityMap,
					fileVersion,
					configVersion,
					options.migrations,
					collectionName,
				);
				needsWriteBack = true;
				targetVersion = configVersion;
				migrationsRan = true;
			}
		}

		// Decode each entity through the schema
		const decode = Schema.decodeUnknownEffect(schema);
		const entries: Array<[string, A]> = [];

		for (const [id, value] of Object.entries(dataToLoad)) {
			if (isLenient) {
				// Lenient mode: skip invalid entities with warnings
				const result = yield* Effect.result(decode(value));
				if (Result.isFailure(result)) {
					const lineNum = lineNumberMap.get(id);
					const location = lineNum ? ` (line ${lineNum})` : "";
					yield* Effect.logWarning(
						`[proseql] Skipping entity '${id}'${location} in '${filePath}': ${result.failure.message}`,
					);
				} else {
					entries.push([id, result.success]);
				}
			} else {
				// Strict mode: abort on first failure
				const decoded = yield* decode(value).pipe(
					Effect.mapError((parseError) =>
						// If migrations were run, produce MigrationError with step: -1
						// Otherwise, produce ValidationError for normal schema mismatch
						migrationsRan
							? new MigrationError({
									collection: collectionNameForError,
									fromVersion: fromVersionForError,
									toVersion: targetVersion ?? 0,
									step: -1,
									reason: "post-migration-validation-failed",
									message: `Post-migration validation failed for entity '${id}': ${parseError.message}`,
								})
							: new ValidationError({
									message: `Failed to decode entity '${id}' in '${filePath}': ${parseError.message}`,
									issues: [
										{
											field: id,
											message: parseError.message,
										},
									],
								}),
					),
				);
				entries.push([id, decoded]);
			}
		}

		const result = new Map(entries) as ReadonlyMap<string, A>;

		// If migrations were run, write the migrated data back to disk with new version
		if (needsWriteBack && targetVersion !== undefined) {
			yield* saveData(filePath, schema, result, {
				version: targetVersion,
				...(options?.format !== undefined ? { format: options.format } : {}),
			});
		}

		return result;
	});

// ============================================================================
// saveData
// ============================================================================

/**
 * Options for saveData.
 */
export interface SaveDataOptions {
	/**
	 * Optional schema version to stamp into the file.
	 * When provided, `_version` is injected at the top level before entities.
	 */
	readonly version?: number;
	/**
	 * Explicit serialization format override.
	 * When provided, this format is used instead of inferring from the file extension.
	 */
	readonly format?: string;
	/**
	 * Dot-notation path into the document where the collection data should be written.
	 * When provided, the existing file is read first and the collection data is set
	 * at the specified path, preserving sibling data in the document.
	 */
	readonly path?: string;
}

/**
 * Save collection data to a file, encoding each entity through the given Schema.
 *
 * Flow:
 * 1. Encode each entity through the Schema (Type → Encoded)
 * 2. Build a Record<string, I> keyed by entity ID
 * 3. Optionally inject `_version` at the top level if version is provided
 * 4. Serialize via SerializerRegistry
 * 5. Ensure parent directory exists
 * 6. Write via StorageAdapter
 */
export const saveData = <A extends { readonly id: string }, I, R>(
	filePath: string,
	schema: Schema.Codec<A, I, R, R>,
	data: ReadonlyMap<string, A>,
	options?: SaveDataOptions,
): Effect.Effect<
	void,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const ext = options?.format ?? (yield* resolveExtension(filePath));

		// Encode each entity through the schema
		const encode = Schema.encodeEffect(schema);
		const isArrayFormat =
			ext === "jsonl" || ext === "ndjson" || ext === "prose";

		if (isArrayFormat && !options?.path) {
			// Array format (JSONL/Prose): encode as array of entities
			const entities: Array<I> = [];
			for (const [id, entity] of data) {
				const encoded = yield* encode(entity).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to encode entity '${id}' for '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: id,
										message: parseError.message,
									},
								],
							}),
					),
				);
				entities.push(encoded);
			}
			const content = yield* serializer.serialize(entities, ext);
			yield* storage.ensureDir(filePath);
			yield* storage.write(filePath, content);
		} else {
			// Encode entities
			const entityMap: Record<string, I> = {};
			for (const [id, entity] of data) {
				const encoded = yield* encode(entity).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to encode entity '${id}' for '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: id,
										message: parseError.message,
									},
								],
							}),
					),
				);
				entityMap[id] = encoded;
			}

			// Build the collection data object
			const collectionData: unknown =
				options?.path !== undefined
					? // Path mode: encode as array of entity values (matches how arrays are loaded)
						Object.values(entityMap)
					: options?.version !== undefined
						? { _version: options.version, ...entityMap }
						: entityMap;

			// If path is specified, read-modify-write to preserve sibling data
			let output: unknown;
			if (options?.path) {
				let existing: Record<string, unknown> = {};
				const fileExists = yield* storage.exists(filePath);
				if (fileExists) {
					const raw = yield* storage.read(filePath);
					const parsed = yield* serializer.deserialize(raw, ext);
					if (isRecord(parsed)) {
						existing = parsed as Record<string, unknown>;
					}
				}
				output = setAtPath(existing, options.path, collectionData);
			} else {
				output = collectionData;
			}

			// Serialize and write
			const content = yield* serializer.serialize(output, ext);
			yield* storage.ensureDir(filePath);
			yield* storage.write(filePath, content);
		}
	});

// ============================================================================
// loadCollectionsFromFile
// ============================================================================

/**
 * Configuration for loading a single collection from a multi-collection file.
 */
export interface LoadCollectionConfig {
	readonly name: string;
	readonly schema: Schema.Codec<{ readonly id: string }, unknown, never, never>;
	/**
	 * Optional schema version from collection config.
	 * When provided, enables version checking and migration support.
	 */
	readonly version?: number;
	/**
	 * Optional migrations array for automatic data migration.
	 * Only used when version is also provided.
	 */
	readonly migrations?: ReadonlyArray<Migration>;
}

/**
 * Load multiple collections from a single file.
 *
 * The file is expected to contain a top-level object where keys are collection names
 * and values are objects keyed by entity ID. Each collection is decoded independently
 * using its own schema.
 *
 * When collections have `version` and `migrations` specified, per-collection migration
 * is applied:
 * - Each collection's `_version` is extracted from its section (default 0 if absent)
 * - If file version < config version: migrations run for that collection
 * - If file version > config version: fails with MigrationError
 * - After any migrations, the entire file is rewritten with all collections at their current versions
 *
 * Returns a Record mapping collection name to ReadonlyMap<string, unknown>.
 */
export const loadCollectionsFromFile = (
	filePath: string,
	collections: ReadonlyArray<LoadCollectionConfig>,
): Effect.Effect<
	Record<string, ReadonlyMap<string, { readonly id: string }>>,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const ext = yield* resolveExtension(filePath);

		const exists = yield* storage.exists(filePath);
		if (!exists) {
			const result: Record<
				string,
				ReadonlyMap<string, { readonly id: string }>
			> = {};
			for (const col of collections) {
				result[col.name] = new Map();
			}
			return result;
		}

		const raw = yield* storage.read(filePath);
		const parsed = yield* serializer.deserialize(raw, ext);

		if (!isRecord(parsed)) {
			return yield* Effect.fail(
				new SerializationError({
					format: ext,
					message: `Invalid data format in '${filePath}': expected object, got ${typeof parsed}`,
				}),
			);
		}

		const result: Record<
			string,
			ReadonlyMap<string, { readonly id: string }>
		> = {};
		// Track which collections need write-back after migration
		let needsWriteBack = false;
		// Store migrated data for write-back (maps collection name to encoded entities + version)
		const writeBackData: Array<{
			readonly name: string;
			readonly schema: Schema.Codec<
				{ readonly id: string },
				unknown,
				never,
				never
			>;
			readonly data: ReadonlyMap<string, { readonly id: string }>;
			readonly version?: number;
		}> = [];

		for (const col of collections) {
			const collectionData = parsed[col.name];
			if (collectionData === undefined || !isRecord(collectionData)) {
				result[col.name] = new Map();
				// Build write-back entry, only adding version if defined
				const emptyEntry: {
					readonly name: string;
					readonly schema: Schema.Codec<
						{ readonly id: string },
						unknown,
						never,
						never
					>;
					readonly data: ReadonlyMap<string, { readonly id: string }>;
					readonly version?: number;
				} = {
					name: col.name,
					schema: col.schema,
					data: new Map(),
				};
				if (col.version !== undefined) {
					writeBackData.push({ ...emptyEntry, version: col.version });
				} else {
					writeBackData.push(emptyEntry);
				}
				continue;
			}

			// Extract _version from collection data (default 0 if absent)
			const fileVersion =
				typeof collectionData._version === "number"
					? collectionData._version
					: 0;

			// Create entity map without _version
			const entityMap: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(collectionData)) {
				if (key !== "_version") {
					entityMap[key] = value;
				}
			}

			// Determine the data to decode (may be migrated)
			let dataToLoad: Record<string, unknown> = entityMap;
			let collectionNeedsMigration = false;

			// If version checking is enabled, validate version compatibility
			if (col.version !== undefined) {
				const configVersion = col.version;

				// File version ahead of config version is an error
				if (fileVersion > configVersion) {
					return yield* Effect.fail(
						new MigrationError({
							collection: col.name,
							fromVersion: configVersion,
							toVersion: fileVersion,
							step: -1,
							reason: "version-ahead",
							message: `File version ${fileVersion} for collection "${col.name}" is ahead of config version ${configVersion}. Cannot load data from a future version.`,
						}),
					);
				}

				// If file version < config version and migrations are provided, run migrations
				if (
					fileVersion < configVersion &&
					col.migrations &&
					col.migrations.length > 0
				) {
					dataToLoad = yield* runMigrations(
						entityMap,
						fileVersion,
						configVersion,
						col.migrations,
						col.name,
					);
					collectionNeedsMigration = true;
					needsWriteBack = true;
				}
			}

			// Decode each entity through the schema
			const decode = Schema.decodeUnknownEffect(col.schema);
			const entries: Array<[string, { readonly id: string }]> = [];

			for (const [id, value] of Object.entries(dataToLoad)) {
				const decoded = yield* decode(value).pipe(
					Effect.mapError((parseError) =>
						// If migrations were run, produce MigrationError with step: -1
						// Otherwise, produce ValidationError for normal schema mismatch
						collectionNeedsMigration
							? new MigrationError({
									collection: col.name,
									fromVersion: fileVersion,
									toVersion: col.version ?? 0,
									step: -1,
									reason: "post-migration-validation-failed",
									message: `Post-migration validation failed for entity '${id}': ${parseError.message}`,
								})
							: new ValidationError({
									message: `Failed to decode entity '${id}' in collection '${col.name}' from '${filePath}': ${parseError.message}`,
									issues: [
										{
											field: `${col.name}.${id}`,
											message: parseError.message,
										},
									],
								}),
					),
				);
				entries.push([id, decoded]);
			}

			const collectionMap = new Map(entries) as ReadonlyMap<
				string,
				{ readonly id: string }
			>;
			result[col.name] = collectionMap;

			// Track for write-back, only adding version if defined
			const entry: {
				readonly name: string;
				readonly schema: Schema.Codec<
					{ readonly id: string },
					unknown,
					never,
					never
				>;
				readonly data: ReadonlyMap<string, { readonly id: string }>;
				readonly version?: number;
			} = {
				name: col.name,
				schema: col.schema,
				data: collectionMap,
			};
			// Use the target version if versioned collection (whether migrated or not)
			if (col.version !== undefined) {
				writeBackData.push({ ...entry, version: col.version });
			} else {
				writeBackData.push(entry);
			}
		}

		// If any collection was migrated, write back the entire file
		if (needsWriteBack) {
			yield* saveCollectionsToFile(filePath, writeBackData);
		}

		return result;
	});

// ============================================================================
// saveCollectionsToFile
// ============================================================================

type HasId = { readonly id: string };

/**
 * Configuration for a collection to be saved to a multi-collection file.
 *
 * @template T - The decoded entity type (must have `id` field)
 * @template I - The encoded/serialized type (defaults to T for simple schemas)
 */
export interface SaveCollectionConfig<T extends HasId = HasId, I = T> {
	readonly name: string;
	readonly schema: Schema.Codec<T, I, never, never>;
	readonly data: ReadonlyMap<string, T>;
	/**
	 * Optional schema version to stamp into this collection's section.
	 * When provided, `_version` is injected first in the collection object.
	 */
	readonly version?: number;
}

/**
 * Save multiple collections to a single file.
 *
 * Encodes each entity in each collection through its schema, then writes
 * the combined data as { collectionName: { _version?, id: encodedEntity, ... }, ... }.
 *
 * If a collection has a `version` specified, `_version` is stamped first
 * in that collection's object for readability.
 */
export function saveCollectionsToFile<T extends HasId, I>(
	filePath: string,
	collections: ReadonlyArray<SaveCollectionConfig<T, I>>,
): Effect.Effect<
	void,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry
> {
	return Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const ext = yield* resolveExtension(filePath);

		const fileObj: Record<string, Record<string, unknown>> = {};

		for (const col of collections) {
			const encode = Schema.encodeEffect(col.schema);
			const entityMap: Record<string, unknown> = {};

			for (const [id, entity] of col.data) {
				const encoded = yield* encode(entity).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to encode entity '${id}' in collection '${col.name}' for '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: `${col.name}.${id}`,
										message: parseError.message,
									},
								],
							}),
					),
				);
				entityMap[id] = encoded;
			}

			// Inject _version first if provided for readability
			fileObj[col.name] =
				col.version !== undefined
					? { _version: col.version, ...entityMap }
					: entityMap;
		}

		const content = yield* serializer.serialize(fileObj, ext);
		yield* storage.ensureDir(filePath);
		yield* storage.write(filePath, content);
	});
}

// ============================================================================
// Directory-mode persistence
// ============================================================================

/**
 * Options for loadDataFromDirectory.
 */
export interface LoadDataFromDirectoryOptions {
	/**
	 * Optional schema version from collection config.
	 */
	readonly version?: number;
	/**
	 * Optional migrations array for automatic data migration.
	 */
	readonly migrations?: ReadonlyArray<Migration>;
	/**
	 * Collection name for error messages.
	 */
	readonly collectionName?: string;
	/**
	 * Validation mode: "strict" (default) aborts on first invalid entity,
	 * "lenient" skips invalid entities with warnings.
	 */
	readonly validation?: "strict" | "lenient";
}

/**
 * Load collection data from a directory where each entity is a separate file.
 *
 * Flow:
 * 1. List files in directory via StorageAdapter.listDirectory
 * 2. Filter files matching the given format extension
 * 3. Read and deserialize each file
 * 4. Decode each entity through the Schema
 * 5. Return a ReadonlyMap<string, A> keyed by entity ID (derived from filename)
 *
 * If the directory does not exist, returns an empty ReadonlyMap.
 */
export const loadDataFromDirectory = <A extends { readonly id: string }, I, R>(
	dirPath: string,
	schema: Schema.Codec<A, I, R, R>,
	format: string,
	_options?: LoadDataFromDirectoryOptions,
): Effect.Effect<
	ReadonlyMap<string, A>,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const ext = format;
		const suffix = `.${ext}`;

		// List files in directory
		const files = yield* storage.listDirectory(dirPath);

		// Filter by format extension
		const matchingFiles = files.filter((f) => f.endsWith(suffix));

		if (matchingFiles.length === 0) {
			return new Map<string, A>() as ReadonlyMap<string, A>;
		}

		// Decode each file
		const decode = Schema.decodeUnknownEffect(schema);
		const entries: Array<[string, A]> = [];
		const isLenient = _options?.validation === "lenient";

		for (const filePath of matchingFiles) {
			const raw = yield* storage.read(filePath);
			const parsed = yield* serializer.deserialize(raw, ext);

			// Extract ID from filename (strip directory and extension)
			const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
			const id = filename.slice(0, filename.length - suffix.length);

			if (isLenient) {
				const result = yield* Effect.result(decode(parsed));
				if (Result.isFailure(result)) {
					yield* Effect.logWarning(
						`[proseql] Skipping entity '${id}' in '${filePath}': ${result.failure.message}`,
					);
				} else {
					entries.push([id, result.success]);
				}
			} else {
				const decoded = yield* decode(parsed).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to decode entity from '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: id,
										message: parseError.message,
									},
								],
							}),
					),
				);
				entries.push([id, decoded]);
			}
		}

		return new Map(entries) as ReadonlyMap<string, A>;
	});

/**
 * Save a single entity to a directory as `<dirPath>/<id>.<format>`.
 */
export const saveEntityToDirectory = <A extends { readonly id: string }, I, R>(
	dirPath: string,
	entity: A,
	schema: Schema.Codec<A, I, R, R>,
	format: string,
): Effect.Effect<
	void,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const encode = Schema.encodeEffect(schema);

		const encoded = yield* encode(entity).pipe(
			Effect.mapError(
				(parseError) =>
					new ValidationError({
						message: `Failed to encode entity '${entity.id}' for directory '${dirPath}': ${parseError.message}`,
						issues: [
							{
								field: entity.id,
								message: parseError.message,
							},
						],
					}),
			),
		);

		const content = yield* serializer.serialize(encoded, format);
		const filePath = `${dirPath}/${entity.id}.${format}`;
		yield* storage.ensureDir(filePath);
		yield* storage.write(filePath, content);
	});

/**
 * Remove a single entity file from a directory.
 */
export const removeEntityFromDirectory = (
	dirPath: string,
	id: string,
	format: string,
): Effect.Effect<void, StorageError, StorageAdapter> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const filePath = `${dirPath}/${id}.${format}`;
		const exists = yield* storage.exists(filePath);
		if (exists) {
			yield* storage.remove(filePath);
		}
	});

/**
 * Entry type for streaming directory reads.
 */
export interface StreamCollectionEntry<A> {
	readonly id: string;
	readonly data: A;
}

/**
 * Stream collection entities from a directory, reading files lazily.
 *
 * Returns a Stream that eagerly lists files, then lazily reads/decodes each.
 */
export const streamCollectionFromDirectory = <
	A extends { readonly id: string },
	I,
	R,
>(
	dirPath: string,
	schema: Schema.Codec<A, I, R, R>,
	format: string,
): Stream.Stream<
	StreamCollectionEntry<A>,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> => {
	const suffix = `.${format}`;

	return Stream.unwrap(
		Effect.gen(function* () {
			const storage = yield* StorageAdapter;
			const files = yield* storage.listDirectory(dirPath);
			const matchingFiles = files.filter((f) => f.endsWith(suffix));

			return Stream.fromIterable(matchingFiles).pipe(
				Stream.mapEffect((filePath) =>
					Effect.gen(function* () {
						const storage = yield* StorageAdapter;
						const serializer = yield* SerializerRegistry;
						const decode = Schema.decodeUnknownEffect(schema);

						const raw = yield* storage.read(filePath);
						const parsed = yield* serializer.deserialize(raw, format);

						const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
						const id = filename.slice(0, filename.length - suffix.length);

						const decoded = yield* decode(parsed).pipe(
							Effect.mapError(
								(parseError) =>
									new ValidationError({
										message: `Failed to decode entity from '${filePath}': ${parseError.message}`,
										issues: [
											{
												field: id,
												message: parseError.message,
											},
										],
									}),
							),
						);

						return { id, data: decoded } as StreamCollectionEntry<A>;
					}),
				),
			);
		}),
	);
};

// ============================================================================
// DirectoryWatcher
// ============================================================================

/**
 * Configuration for a directory watcher.
 */
export interface DirectoryWatcherConfig<
	A extends { readonly id: string },
	I,
	R,
> {
	/** Path to the directory to watch */
	readonly dirPath: string;
	/** Serialization format (e.g., "yaml", "json") */
	readonly format: string;
	/** Schema to decode loaded data through */
	readonly schema: Schema.Codec<A, I, R, R>;
	/** Ref holding the collection state to update on file change */
	readonly ref: Ref.Ref<ReadonlyMap<string, A>>;
	/** Optional debounce delay in ms for reload after change (default 50) */
	readonly debounceMs?: number;
	/** Optional PubSub to publish reload events to for reactive query subscriptions */
	readonly changePubSub?: PubSub.PubSub<ChangeEvent>;
	/** Collection name (required when changePubSub is provided) */
	readonly collectionName?: string;
}

/**
 * Create a managed directory watcher using Effect.acquireRelease.
 *
 * The watcher monitors a directory for file changes. When a change is detected,
 * it reloads the affected entity (or the full directory for unknown filenames)
 * and updates the collection Ref.
 */
export const createDirectoryWatcher = <A extends { readonly id: string }, I, R>(
	config: DirectoryWatcherConfig<A, I, R>,
): Effect.Effect<
	FileWatcher,
	StorageError,
	Scope.Scope | StorageAdapter | SerializerRegistry | R
> => {
	const debounceMs = config.debounceMs ?? 50;
	const suffix = `.${config.format}`;

	return Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const storage = yield* StorageAdapter;
		const runtimeContext = yield* Effect.context<
			StorageAdapter | SerializerRegistry | R
		>();
		const active = yield* Ref.make(true);

		const changeQueue = yield* Queue.unbounded<{
			readonly filename: string | null;
			readonly type: "add" | "change" | "remove";
		}>();

		const pendingReload = yield* Ref.make<Fiber.Fiber<
			void,
			| StorageError
			| SerializationError
			| UnsupportedFormatError
			| ValidationError
			| MigrationError
		> | null>(null);

		const processorFiber = yield* Effect.forkIn(
			Effect.forever(
				Effect.gen(function* () {
					const event = yield* Queue.take(changeQueue);
					// Drain any queued signals
					yield* Queue.takeAll(changeQueue);

					const isActive = yield* Ref.get(active);
					if (!isActive) return;

					// Cancel existing pending reload
					const existing = yield* Ref.get(pendingReload);
					if (existing !== null) {
						yield* Fiber.interrupt(existing);
					}

					const fiber = yield* Effect.forkIn(
						Effect.gen(function* () {
							yield* Effect.sleep(debounceMs);

							if (event.filename?.endsWith(suffix)) {
								const id = event.filename.slice(
									0,
									event.filename.length - suffix.length,
								);
								if (event.type === "remove") {
									// Remove entity from Ref
									yield* Ref.update(config.ref, (m) => {
										const next = new Map(m);
										next.delete(id);
										return next;
									});
								} else {
									// add or change: read and upsert
									const filePath = `${config.dirPath}/${event.filename}`;
									const storage = yield* StorageAdapter;
									const serializer = yield* SerializerRegistry;
									const decode = Schema.decodeUnknownEffect(config.schema);

									const raw = yield* storage.read(filePath);
									const parsed = yield* serializer.deserialize(
										raw,
										config.format,
									);
									const decoded = yield* decode(parsed).pipe(
										Effect.catch(() => Effect.succeed(null)),
									);
									if (decoded !== null) {
										yield* Ref.update(config.ref, (m) => {
											const next = new Map(m);
											next.set(id, decoded);
											return next;
										});
									}
								}
							} else {
								// Unknown filename or null — full reload
								const newData = yield* loadDataFromDirectory(
									config.dirPath,
									config.schema,
									config.format,
								);
								yield* Ref.set(config.ref, newData);
							}

							// Publish reload event
							if (
								config.changePubSub !== undefined &&
								config.collectionName !== undefined
							) {
								yield* PubSub.publish(
									config.changePubSub,
									reloadEvent(config.collectionName),
								);
							}
						}),
						scope,
						{ startImmediately: true },
					);

					yield* Ref.set(pendingReload, fiber);
				}),
			).pipe(Effect.provide(runtimeContext)),
			scope,
			{ startImmediately: true },
		);

		yield* Effect.acquireRelease(
			storage.watchDir(config.dirPath, (event) => {
				Queue.offerUnsafe(changeQueue, event);
			}),
			(stopWatching) =>
				Effect.gen(function* () {
					yield* Ref.set(active, false);
					yield* Fiber.interrupt(processorFiber);
					const pending = yield* Ref.get(pendingReload);
					if (pending !== null) {
						yield* Fiber.interrupt(pending);
					}
					stopWatching();
				}),
		);

		return {
			isActive: () => Ref.get(active),
		} satisfies FileWatcher;
	});
};

// ============================================================================
// DebouncedWriter
// ============================================================================

/**
 * A pending write entry: the forked fiber (sleeping then saving) and
 * the save effect itself (so flush can execute it immediately).
 */
interface PendingWrite {
	readonly fiber: Fiber.Fiber<
		void,
		StorageError | SerializationError | UnsupportedFormatError | ValidationError
	>;
	readonly save: Effect.Effect<
		void,
		| StorageError
		| SerializationError
		| UnsupportedFormatError
		| ValidationError,
		StorageAdapter | SerializerRegistry
	>;
}

/**
 * Handle returned by `createDebouncedWriter`. Provides methods to schedule
 * debounced writes, flush all pending writes, and query pending state.
 */
export interface DebouncedWriter {
	/**
	 * Schedule a debounced write for the given key. If a write for this key
	 * is already pending, it is cancelled and replaced with the new one.
	 * The actual write executes after the configured delay unless superseded.
	 */
	readonly triggerSave: (
		key: string,
		save: Effect.Effect<
			void,
			| StorageError
			| SerializationError
			| UnsupportedFormatError
			| ValidationError,
			StorageAdapter | SerializerRegistry
		>,
	) => Effect.Effect<
		void,
		never,
		Scope.Scope | StorageAdapter | SerializerRegistry
	>;
	/**
	 * Immediately execute all pending writes, cancelling their debounce timers.
	 * Errors from individual saves are collected but do not prevent other saves.
	 */
	readonly flush: () => Effect.Effect<
		void,
		| StorageError
		| SerializationError
		| UnsupportedFormatError
		| ValidationError,
		StorageAdapter | SerializerRegistry
	>;
	/**
	 * Returns the number of writes currently pending.
	 */
	readonly pendingCount: () => Effect.Effect<number>;
}

/**
 * Create a DebouncedWriter that coalesces rapid writes into single file operations.
 *
 * Each call to `triggerSave(key, saveEffect)` cancels any pending write for
 * that key and schedules a new one after `delayMs` milliseconds. If another
 * `triggerSave` for the same key arrives before the delay elapses, the timer
 * resets — only the last write within a burst actually hits the filesystem.
 *
 * @param delayMs - Debounce delay in milliseconds (default 100)
 */
export const createDebouncedWriter = (
	delayMs = 100,
): Effect.Effect<DebouncedWriter> =>
	Effect.gen(function* () {
		const pending = yield* Ref.make<ReadonlyMap<string, PendingWrite>>(
			new Map(),
		);

		const triggerSave: DebouncedWriter["triggerSave"] = (key, save) =>
			Effect.gen(function* () {
				// Cancel existing pending write for this key if any
				const current = yield* Ref.get(pending);
				const existing = current.get(key);
				if (existing !== undefined) {
					yield* Fiber.interrupt(existing.fiber);
				}

				// Fork a fiber that sleeps then executes the save
				const fiber = yield* Effect.forkDetach(
					Effect.gen(function* () {
						yield* Effect.sleep(delayMs);
						yield* save;
						// Remove from pending after successful write
						yield* Ref.update(pending, (m) => {
							const next = new Map(m);
							next.delete(key);
							return next;
						});
					}),
					{ startImmediately: true },
				);

				// Store the pending write
				yield* Ref.update(pending, (m) => {
					const next = new Map(m);
					next.set(key, { fiber, save });
					return next;
				});
			});

		const flush: DebouncedWriter["flush"] = () =>
			Effect.gen(function* () {
				// Atomically take all pending writes and clear the map
				const writes = yield* Ref.getAndSet(pending, new Map());

				// Interrupt all pending fibers first
				for (const [, entry] of writes) {
					yield* Fiber.interrupt(entry.fiber);
				}

				// Execute all saves immediately
				for (const [, entry] of writes) {
					yield* entry.save;
				}
			});

		const pendingCount: DebouncedWriter["pendingCount"] = () =>
			Ref.get(pending).pipe(Effect.map((m) => m.size));

		return { triggerSave, flush, pendingCount } as const;
	});

// ============================================================================
// FileWatcher
// ============================================================================

/**
 * Handle returned by `createFileWatcher`. Provides the ability to check
 * whether the watcher is active. The watcher is automatically cleaned up
 * when the enclosing Effect Scope closes.
 */
export interface FileWatcher {
	/**
	 * Returns true if the watcher is still active (has not been closed).
	 */
	readonly isActive: () => Effect.Effect<boolean>;
}

/**
 * Configuration for a single file watcher.
 */
export interface FileWatcherConfig<A extends { readonly id: string }, I, R> {
	/** Path to the file to watch */
	readonly filePath: string;
	/** Schema to decode loaded data through */
	readonly schema: Schema.Codec<A, I, R, R>;
	/** Ref holding the collection state to update on file change */
	readonly ref: Ref.Ref<ReadonlyMap<string, A>>;
	/** Optional debounce delay in ms for reload after change (default 50) */
	readonly debounceMs?: number;
	/** Optional PubSub to publish reload events to for reactive query subscriptions */
	readonly changePubSub?: PubSub.PubSub<ChangeEvent>;
	/** Collection name (required when changePubSub is provided) */
	readonly collectionName?: string;
}

/**
 * Create a managed file watcher using Effect.acquireRelease.
 *
 * The watcher monitors a file for external changes. When a change is detected,
 * it reloads the file through the Schema and updates the collection Ref.
 *
 * The watcher lifecycle is managed by Effect's Scope — it is automatically
 * closed when the Scope finalizes (database shutdown, test cleanup, etc.).
 *
 * Reload is debounced to avoid redundant reloads when editors write
 * multiple change events in quick succession.
 *
 * @param config - File watcher configuration
 * @returns Effect that yields a FileWatcher handle (requires Scope)
 */
export const createFileWatcher = <A extends { readonly id: string }, I, R>(
	config: FileWatcherConfig<A, I, R>,
): Effect.Effect<
	FileWatcher,
	StorageError,
	Scope.Scope | StorageAdapter | SerializerRegistry | R
> => {
	const debounceMs = config.debounceMs ?? 50;

	return Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const storage = yield* StorageAdapter;
		const runtimeContext = yield* Effect.context<
			StorageAdapter | SerializerRegistry | R
		>();
		const active = yield* Ref.make(true);

		// Ref to hold the debounce timer fiber so it can be cancelled on new events
		const pendingReload = yield* Ref.make<Fiber.Fiber<
			void,
			| StorageError
			| SerializationError
			| UnsupportedFormatError
			| ValidationError
			| MigrationError
		> | null>(null);

		const scheduleReload = Effect.gen(function* () {
			const isActive = yield* Ref.get(active);
			if (!isActive) return;

			// Cancel any existing pending reload
			const existing = yield* Ref.get(pendingReload);
			if (existing !== null) {
				yield* Fiber.interrupt(existing);
			}

			// Fork a debounced reload
			const fiber = yield* Effect.forkIn(
				Effect.gen(function* () {
					yield* Effect.sleep(debounceMs);
					const newData = yield* loadData(config.filePath, config.schema);
					yield* Ref.set(config.ref, newData);
					// Publish reload event if PubSub is provided
					if (
						config.changePubSub !== undefined &&
						config.collectionName !== undefined
					) {
						yield* PubSub.publish(
							config.changePubSub,
							reloadEvent(config.collectionName),
						);
					}
				}),
				scope,
				{ startImmediately: true },
			);

			yield* Ref.set(pendingReload, fiber);
		}).pipe(Effect.provide(runtimeContext));

		// Acquire the watcher via StorageAdapter.watch, release by calling the
		// returned stop function. acquireRelease ties the lifetime to the Scope.
		yield* Effect.acquireRelease(
			storage.watch(config.filePath, () => {
				Effect.runFork(scheduleReload);
			}),
			(stopWatching) =>
				Effect.gen(function* () {
					yield* Ref.set(active, false);
					// Cancel any pending reload
					const pending = yield* Ref.get(pendingReload);
					if (pending !== null) {
						yield* Fiber.interrupt(pending);
					}
					stopWatching();
				}),
		);

		return {
			isActive: () => Ref.get(active),
		} satisfies FileWatcher;
	});
};

/**
 * Create managed file watchers for multiple files at once.
 *
 * Convenience wrapper that creates a watcher for each config entry.
 * All watchers share the enclosing Scope and are cleaned up together.
 *
 * @param configs - Array of file watcher configurations
 * @returns Effect yielding an array of FileWatcher handles
 */
export const createFileWatchers = <A extends { readonly id: string }, I, R>(
	configs: ReadonlyArray<FileWatcherConfig<A, I, R>>,
): Effect.Effect<
	ReadonlyArray<FileWatcher>,
	StorageError,
	Scope.Scope | StorageAdapter | SerializerRegistry | R
> =>
	Effect.all(
		configs.map((cfg) => createFileWatcher(cfg)),
		{ concurrency: "unbounded" },
	);
