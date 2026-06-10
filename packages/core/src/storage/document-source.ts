import { Effect, Schema } from "effect";
import { ValidationError } from "../errors/crud-errors.js";
import type { MigrationError } from "../errors/migration-errors.js";
import {
	DuplicatePhysicalFileError,
	DuplicateRecordError,
	InvalidDocumentSourceError,
	type SourceError,
	UnknownCollectionError,
} from "../errors/source-errors.js";
import {
	SerializationError,
	StorageError,
	type UnsupportedFormatError,
} from "../errors/storage-errors.js";
import { runMigrations } from "../migrations/migration-runner.js";
import { SerializerRegistry } from "../serializers/serializer-service.js";
import type { DerivedIdConfig } from "../types/database-config-types.js";
import type { HasId } from "./derived-id.js";
import {
	assertNoPhysicalDerivedId,
	hydrateDerivedId,
	requireHydratablePayload,
	stripDerivedIdField,
} from "./derived-id.js";
import { type OriginIndex, setOrigin } from "./origin-index.js";
import {
	matchesDocumentSourcePattern,
	type NormalizedDocumentSourceConfig,
	type NormalizedSourceConfig,
} from "./source-config.js";
import { StorageAdapter } from "./storage-service.js";

export interface LoadedDocumentSources {
	readonly collections: Record<string, ReadonlyMap<string, HasId>>;
	readonly origins: OriginIndex;
	readonly documents: ReadonlyArray<LoadedDocument>;
}

export interface SavedDocumentSource {
	readonly origins: OriginIndex;
	readonly documents: ReadonlyArray<LoadedDocument>;
}

export interface SaveDocumentSourceInput {
	readonly config: NormalizedSourceConfig;
	readonly sourceId: string;
	readonly collections: Record<string, ReadonlyMap<string, HasId>>;
	readonly origins: OriginIndex;
	readonly documents: ReadonlyArray<LoadedDocument>;
}

export interface LoadedDocument {
	readonly sourceId: string;
	readonly path: string;
	readonly data: Record<string, unknown>;
}

type CollectionLoadConfig = {
	readonly name: string;
	readonly schema: Schema.Codec<HasId, unknown, never, never>;
	readonly id?: DerivedIdConfig;
	readonly version?: number;
	readonly migrations?: ReadonlyArray<
		import("../migrations/migration-types.js").Migration
	>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const emptyCollectionMaps = (
	collectionNames: ReadonlyArray<string>,
): Record<string, Map<string, HasId>> => {
	const collections: Record<string, Map<string, HasId>> = {};
	for (const collectionName of collectionNames) {
		collections[collectionName] = new Map<string, HasId>();
	}
	return collections;
};

export const loadDocumentSources = (
	config: NormalizedSourceConfig,
): Effect.Effect<
	LoadedDocumentSources,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError
	| SourceError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const collectionConfigs = new Map<string, CollectionLoadConfig>();
		for (const collectionName of config.collections) {
			const collectionConfig = config.collectionConfigs[collectionName];
			collectionConfigs.set(collectionName, {
				name: collectionName,
				schema: collectionConfig.schema as Schema.Codec<
					HasId,
					unknown,
					never,
					never
				>,
				...(collectionConfig.id !== undefined
					? { id: collectionConfig.id }
					: {}),
				...(collectionConfig.version !== undefined
					? { version: collectionConfig.version }
					: {}),
				...(collectionConfig.migrations !== undefined
					? { migrations: collectionConfig.migrations }
					: {}),
			});
		}

		const collections = emptyCollectionMaps(config.collections);
		const origins = new Map<string, import("./origin-index.js").RecordOrigin>();
		const documents: LoadedDocument[] = [];

		for (const source of config.sources) {
			// documentGraph sources are loaded separately by loadDocumentGraphSources;
			// the writable documents loader only handles `documents` sources.
			if (source.kind !== "documents") continue;
			yield* loadDocumentSource(
				source,
				collectionConfigs,
				collections,
				origins,
				documents,
			);
		}

		return {
			collections,
			origins,
			documents,
		};
	});

export const saveDocumentSource = (
	input: SaveDocumentSourceInput,
): Effect.Effect<
	SavedDocumentSource,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| SourceError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const source = input.config.sources.find(
			(candidate) => candidate.id === input.sourceId,
		);
		if (source === undefined) {
			return yield* Effect.fail(
				new InvalidDocumentSourceError({
					sourceId: input.sourceId,
					path: "",
					message: `Unknown document source '${input.sourceId}'`,
				}),
			);
		}
		if (source.kind !== "documents") {
			// documentGraph (and any future read-only source) has no write path.
			return yield* Effect.fail(
				new InvalidDocumentSourceError({
					sourceId: input.sourceId,
					path: "",
					message: `Source '${input.sourceId}' is read-only and cannot be saved`,
				}),
			);
		}

		const collectionConfigs = new Map<string, CollectionLoadConfig>();
		for (const collectionName of source.collections) {
			const collectionConfig = input.config.collectionConfigs[collectionName];
			collectionConfigs.set(collectionName, {
				name: collectionName,
				schema: collectionConfig.schema as Schema.Codec<
					HasId,
					unknown,
					never,
					never
				>,
				...(collectionConfig.id !== undefined
					? { id: collectionConfig.id }
					: {}),
				...(collectionConfig.version !== undefined
					? { version: collectionConfig.version }
					: {}),
				...(collectionConfig.migrations !== undefined
					? { migrations: collectionConfig.migrations }
					: {}),
			});
		}

		const projectedByPath = new Map<string, Record<string, unknown>>();
		const sourceDocuments = input.documents.filter(
			(document) => document.sourceId === source.id,
		);
		for (const document of sourceDocuments) {
			projectedByPath.set(
				document.path,
				cloneDocumentForSource(source, document, collectionConfigs),
			);
		}
		const newOrigins = new Map(input.origins);
		for (const [key, origin] of input.origins) {
			if (origin.sourceId !== source.id) continue;
			if (!source.collections.includes(origin.collection)) continue;
			const currentCollection = input.collections[origin.collection];
			if (
				currentCollection === undefined ||
				!currentCollection.has(origin.id)
			) {
				newOrigins.delete(key);
			}
		}

		for (const collectionName of source.collections) {
			const collectionConfig = collectionConfigs.get(collectionName);
			const currentCollection = input.collections[collectionName];
			if (collectionConfig === undefined || currentCollection === undefined) {
				continue;
			}

			for (const [id, entity] of currentCollection) {
				const existingOrigin = input.origins.get(
					`${collectionName}\u0000${id}`,
				);
				if (
					existingOrigin !== undefined &&
					existingOrigin.sourceId !== source.id
				) {
					continue;
				}
				const path = existingOrigin?.path ?? source.outbox;
				const targetDocument = getOrCreateDocument(projectedByPath, path);
				const section = getOrCreateSection(targetDocument, collectionName);
				stampSectionVersion(section, collectionConfig);
				const encoded = yield* encodeDocumentSourceEntity(
					source,
					path,
					collectionConfig,
					id,
					entity,
				);
				section[id] = encoded;
				setOrigin(newOrigins, {
					sourceId: source.id,
					path,
					collection: collectionName,
					id,
				});
			}
		}

		const serializer = yield* SerializerRegistry;
		const storage = yield* StorageAdapter;
		const writes: Array<{ readonly path: string; readonly data: string }> = [];
		for (const [path, document] of projectedByPath) {
			const data = yield* serializer.serialize(document, source.format);
			writes.push({ path, data });
		}

		for (const write of writes) {
			yield* storage.ensureDir(write.path);
			yield* storage.write(write.path, write.data);
		}

		const mergedDocuments = [
			...input.documents.filter((document) => document.sourceId !== source.id),
			...Array.from(projectedByPath.entries()).map(([path, data]) => ({
				sourceId: source.id,
				path,
				data,
			})),
		].sort((left, right) =>
			left.sourceId === right.sourceId
				? left.path.localeCompare(right.path)
				: left.sourceId.localeCompare(right.sourceId),
		);

		return {
			origins: newOrigins,
			documents: mergedDocuments,
		};
	});

const cloneDocumentForSource = (
	source: NormalizedDocumentSourceConfig,
	document: LoadedDocument,
	collectionConfigs: ReadonlyMap<string, CollectionLoadConfig>,
): Record<string, unknown> => {
	const cloned: Record<string, unknown> = { ...document.data };
	for (const collectionName of source.collections) {
		const section = cloned[collectionName];
		if (!isRecord(section)) continue;
		const nextSection: Record<string, unknown> = {};
		const collectionConfig = collectionConfigs.get(collectionName);
		stampSectionVersion(nextSection, collectionConfig);
		if (
			collectionConfig?.version === undefined &&
			section._version !== undefined
		) {
			nextSection._version = section._version;
		}
		cloned[collectionName] = nextSection;
	}
	return cloned;
};

const getOrCreateDocument = (
	documents: Map<string, Record<string, unknown>>,
	path: string,
): Record<string, unknown> => {
	const existing = documents.get(path);
	if (existing !== undefined) return existing;
	const created: Record<string, unknown> = {};
	documents.set(path, created);
	return created;
};

const getOrCreateSection = (
	document: Record<string, unknown>,
	collectionName: string,
): Record<string, unknown> => {
	const existing = document[collectionName];
	if (isRecord(existing)) return existing;
	const created: Record<string, unknown> = {};
	document[collectionName] = created;
	return created;
};

const stampSectionVersion = (
	section: Record<string, unknown>,
	collectionConfig: CollectionLoadConfig | undefined,
): void => {
	if (collectionConfig?.version !== undefined) {
		section._version = collectionConfig.version;
	}
};

const encodeDocumentSourceEntity = (
	source: NormalizedDocumentSourceConfig,
	path: string,
	collectionConfig: CollectionLoadConfig,
	id: string,
	entity: HasId,
): Effect.Effect<unknown, ValidationError, never> => {
	const encode = Schema.encodeEffect(collectionConfig.schema);
	const valueToEncode = stripDerivedIdField(entity, collectionConfig.id);
	return encode(valueToEncode as HasId).pipe(
		Effect.mapError(
			(parseError) =>
				new ValidationError({
					message: `Failed to encode entity '${id}' in collection '${collectionConfig.name}' for document source '${source.id}' at '${path}': ${parseError.message}`,
					issues: [
						{
							field: `${collectionConfig.name}.${id}`,
							message: parseError.message,
						},
					],
				}),
		),
	);
};
const loadDocumentSource = (
	source: NormalizedDocumentSourceConfig,
	collectionConfigs: ReadonlyMap<string, CollectionLoadConfig>,
	collections: Record<string, Map<string, HasId>>,
	origins: Map<string, import("./origin-index.js").RecordOrigin>,
	documents: Array<LoadedDocument>,
): Effect.Effect<
	void,
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError
	| SourceError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const rootExists = yield* storage.exists(source.root);
		if (!rootExists && !source.optional) {
			return yield* Effect.fail(
				new StorageError({
					path: source.root,
					operation: "list",
					message: `Document source root '${source.root}' does not exist`,
				}),
			);
		}
		if (!rootExists && source.optional) return;

		const discovered = yield* storage.listRecursive(source.root);
		const seenPaths = new Set<string>();
		const matchingFiles: string[] = [];
		for (const path of discovered) {
			if (!matchesDocumentSourcePattern(source, path)) continue;
			if (seenPaths.has(path)) {
				return yield* Effect.fail(
					new DuplicatePhysicalFileError({
						sourceId: source.id,
						path,
						message: `Document source '${source.id}' discovered '${path}' more than once`,
					}),
				);
			}
			seenPaths.add(path);
			matchingFiles.push(path);
		}
		matchingFiles.sort();

		for (const path of matchingFiles) {
			const raw = yield* storage.read(path);
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				documents.push({ sourceId: source.id, path, data: {} });
				continue;
			}

			const parsed = yield* deserializeDocument(path, source.format, raw);
			if (parsed === null || parsed === undefined) {
				documents.push({ sourceId: source.id, path, data: {} });
				continue;
			}
			if (!isRecord(parsed)) {
				return yield* Effect.fail(
					new InvalidDocumentSourceError({
						sourceId: source.id,
						path,
						message: `Document source '${source.id}' file '${path}' must contain a top-level object`,
					}),
				);
			}

			documents.push({ sourceId: source.id, path, data: parsed });
			yield* loadDocumentFile(
				source,
				path,
				parsed,
				collectionConfigs,
				collections,
				origins,
			);
		}
	});

const deserializeDocument = (
	path: string,
	format: string,
	raw: string,
): Effect.Effect<
	unknown,
	SerializationError | UnsupportedFormatError,
	SerializerRegistry
> =>
	Effect.gen(function* () {
		const serializer = yield* SerializerRegistry;
		return yield* serializer.deserialize(raw, format).pipe(
			Effect.mapError((error) => {
				if (error._tag !== "SerializationError") return error;
				return new SerializationError({
					format: error.format,
					message: `${error.message} in '${path}'`,
					cause: error.cause,
				});
			}),
		);
	});

const loadDocumentFile = (
	source: NormalizedDocumentSourceConfig,
	path: string,
	parsed: Record<string, unknown>,
	collectionConfigs: ReadonlyMap<string, CollectionLoadConfig>,
	collections: Record<string, Map<string, HasId>>,
	origins: Map<string, import("./origin-index.js").RecordOrigin>,
): Effect.Effect<void, ValidationError | MigrationError | SourceError, never> =>
	Effect.gen(function* () {
		const allowedCollections = new Set(source.collections);
		for (const key of Object.keys(parsed)) {
			if (!allowedCollections.has(key)) {
				if (source.unknownCollections === "preserve") continue;
				return yield* Effect.fail(
					new UnknownCollectionError({
						sourceId: source.id,
						path,
						collection: key,
						message: `Document source '${source.id}' file '${path}' contains unknown collection '${key}'`,
					}),
				);
			}
		}

		for (const collectionName of source.collections) {
			const section = parsed[collectionName];
			if (section === undefined) continue;
			const collectionConfig = collectionConfigs.get(collectionName);
			if (collectionConfig === undefined) continue;
			if (!isRecord(section)) {
				return yield* Effect.fail(
					new InvalidDocumentSourceError({
						sourceId: source.id,
						path,
						collection: collectionName,
						message: `Collection '${collectionName}' in '${path}' must be an object keyed by record id`,
					}),
				);
			}

			yield* loadCollectionSection(
				source,
				path,
				collectionConfig,
				section,
				collections,
				origins,
			);
		}
	});

const loadCollectionSection = (
	source: NormalizedDocumentSourceConfig,
	path: string,
	collectionConfig: CollectionLoadConfig,
	section: Record<string, unknown>,
	collections: Record<string, Map<string, HasId>>,
	origins: Map<string, import("./origin-index.js").RecordOrigin>,
): Effect.Effect<
	void,
	| ValidationError
	| MigrationError
	| DuplicateRecordError
	| InvalidDocumentSourceError,
	never
> =>
	Effect.gen(function* () {
		const fileVersion =
			typeof section._version === "number" ? section._version : 0;
		const entityMap: Record<string, unknown> = {};
		for (const [id, value] of Object.entries(section)) {
			if (id !== "_version") entityMap[id] = value;
		}

		let dataToLoad = entityMap;
		let migrationsRan = false;
		if (collectionConfig.version !== undefined) {
			if (fileVersion > collectionConfig.version) {
				return yield* Effect.fail(
					new InvalidDocumentSourceError({
						sourceId: source.id,
						path,
						collection: collectionConfig.name,
						message: `File version ${fileVersion} for collection '${collectionConfig.name}' is ahead of config version ${collectionConfig.version}`,
					}),
				);
			}
			if (
				fileVersion < collectionConfig.version &&
				collectionConfig.migrations !== undefined &&
				collectionConfig.migrations.length > 0
			) {
				dataToLoad = yield* runMigrations(
					entityMap,
					fileVersion,
					collectionConfig.version,
					collectionConfig.migrations,
					collectionConfig.name,
				);
				migrationsRan = true;
			}
		}

		const decode = Schema.decodeUnknownEffect(collectionConfig.schema);
		for (const [id, value] of Object.entries(dataToLoad)) {
			if (value === null || value === undefined || !isRecord(value)) {
				return yield* Effect.fail(
					new InvalidDocumentSourceError({
						sourceId: source.id,
						path,
						collection: collectionConfig.name,
						id,
						message: `Record '${collectionConfig.name}.${id}' in '${path}' must be an object`,
					}),
				);
			}

			const physicalIdError = assertNoPhysicalDerivedId(
				id,
				value,
				collectionConfig.id,
				`${path}.${collectionConfig.name}`,
			);
			if (physicalIdError !== undefined) {
				return yield* Effect.fail(physicalIdError);
			}

			const decoded = yield* decode(value).pipe(
				Effect.mapError((parseError) =>
					migrationsRan
						? new ValidationError({
								message: `Post-migration validation failed for entity '${id}' in collection '${collectionConfig.name}' from '${path}': ${parseError.message}`,
								issues: [
									{
										field: `${collectionConfig.name}.${id}`,
										message: parseError.message,
									},
								],
							})
						: new ValidationError({
								message: `Failed to decode entity '${id}' in collection '${collectionConfig.name}' from '${path}': ${parseError.message}`,
								issues: [
									{
										field: `${collectionConfig.name}.${id}`,
										message: parseError.message,
									},
								],
							}),
				),
			);
			const hydratableError = requireHydratablePayload(
				id,
				decoded,
				collectionConfig.id,
				`${path}.${collectionConfig.name}`,
			);
			if (hydratableError !== undefined) {
				return yield* Effect.fail(hydratableError);
			}

			const hydrated = hydrateDerivedId<HasId>(
				id,
				decoded,
				collectionConfig.id,
			);
			const target = collections[collectionConfig.name];
			const existingOrigin = origins.get(
				`${collectionConfig.name}\u0000${hydrated.id}`,
			);
			const origin = {
				sourceId: source.id,
				path,
				collection: collectionConfig.name,
				id: hydrated.id,
			};
			if (existingOrigin !== undefined) {
				return yield* Effect.fail(
					new DuplicateRecordError({
						collection: collectionConfig.name,
						id: hydrated.id,
						first: existingOrigin,
						duplicate: origin,
						message: `Duplicate record '${collectionConfig.name}.${hydrated.id}' in '${existingOrigin.path}' and '${path}'`,
					}),
				);
			}
			target.set(hydrated.id, hydrated);
			setOrigin(origins, origin);
		}

		if (collectionConfig.version !== undefined) {
			for (const key of Object.keys(section)) {
				delete section[key];
			}
			section._version = collectionConfig.version;
			for (const [id, value] of Object.entries(dataToLoad)) {
				section[id] = value;
			}
		}
	});
