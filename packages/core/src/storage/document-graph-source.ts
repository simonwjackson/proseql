import { Effect, Result, Schema } from "effect";
import type { ValidationError } from "../errors/crud-errors.js";
import type { MigrationError } from "../errors/migration-errors.js";
import { DocumentGraphSourceError } from "../errors/source-errors.js";
import type {
	SerializationError,
	StorageError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js";
import { runMigrations } from "../migrations/migration-runner.js";
import { SerializerRegistry } from "../serializers/serializer-service.js";
import type { DerivedIdConfig } from "../types/database-config-types.js";
import { deepMergeAll } from "../utils/deep-merge.js";
import { matchesAny } from "../utils/glob-match.js";
import { getFileExtension } from "../utils/path.js";
import {
	assertNoPhysicalDerivedId,
	type HasId,
	hydrateDerivedId,
	requireHydratablePayload,
} from "./derived-id.js";
import {
	type NormalizedDocumentGraphSourceConfig,
	type NormalizedSourceConfig,
	relativeToRoot,
} from "./source-config.js";
import { StorageAdapter } from "./storage-service.js";

/**
 * Result of loading every `documentGraph` source in a config: the merged,
 * validated effective records per graph-owned collection plus internal
 * record-level provenance (which file paths contributed each record), used only
 * to enrich error messages.
 */
export interface LoadedDocumentGraph {
	readonly collections: Record<string, ReadonlyMap<string, HasId>>;
	readonly contributingPaths: ReadonlyMap<string, ReadonlyArray<string>>;
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

type GraphLoadError =
	| DocumentGraphSourceError
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| MigrationError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const provenanceKey = (collection: string, id: string): string =>
	`${collection}\u0000${id}`;

/**
 * Load and merge all `documentGraph` sources from a normalized config. Each
 * source assembles one effective graph from ordered roots: discover by glob,
 * decode by extension, apply a pure transform, migrate each fragment to current
 * schema, deep-merge in order, then validate the effective records.
 *
 * Read-only: this returns data only; the factory is responsible for exposing the
 * graph-owned collections as non-writable.
 */
export const loadDocumentGraphSources = (
	config: NormalizedSourceConfig,
): Effect.Effect<
	LoadedDocumentGraph,
	GraphLoadError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const collections: Record<string, Map<string, HasId>> = {};
		const contributingPaths = new Map<string, string[]>();

		const graphSources = config.sources.filter(
			(source): source is NormalizedDocumentGraphSourceConfig =>
				source.kind === "documentGraph",
		);

		for (const source of graphSources) {
			yield* loadGraphSource(source, config, collections, contributingPaths);
		}

		return { collections, contributingPaths };
	});

const loadGraphSource = (
	source: NormalizedDocumentGraphSourceConfig,
	config: NormalizedSourceConfig,
	collections: Record<string, Map<string, HasId>>,
	contributingPaths: Map<string, string[]>,
): Effect.Effect<void, GraphLoadError, StorageAdapter | SerializerRegistry> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const supportedExtensions = new Set(serializer.supportedExtensions());

		const collectionConfigs = buildCollectionConfigs(source, config);
		const allowedCollections = new Set(source.collections);

		// Per collection, an ordered list of migrated fragment sections (id -> record).
		const fragmentsByCollection = new Map<
			string,
			Array<Record<string, unknown>>
		>();
		for (const collectionName of source.collections) {
			fragmentsByCollection.set(collectionName, []);
		}

		// 1. Discover fragments across roots, preserving root order then lexical
		//    order within a root.
		const orderedFragments: Array<{ path: string; rootId: string }> = [];
		for (const root of source.roots) {
			const exists = yield* storage.exists(root.root);
			if (!exists) {
				if (root.optional) continue;
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path: root.root,
						kind: "missing-root",
						message: `Document graph source '${source.id}' root '${root.root}' does not exist`,
					}),
				);
			}
			const discovered = yield* storage.listRecursive(root.root);
			const matched: string[] = [];
			for (const path of discovered) {
				const relative = relativeToRoot(root.root, path);
				if (relative.startsWith("../") || relative === "..") continue;
				if (!matchesAny(relative, root.include)) continue;
				if (matchesAny(relative, root.exclude)) continue;
				matched.push(path);
			}
			matched.sort((a, b) =>
				relativeToRoot(root.root, a) < relativeToRoot(root.root, b) ? -1 : 1,
			);
			for (const path of matched) {
				orderedFragments.push({ path, rootId: root.id });
			}
		}

		// 2. Decode -> transform -> unknown-key check -> per-fragment migrate.
		for (const fragment of orderedFragments) {
			const { path, rootId } = fragment;
			const raw = yield* storage.read(path);
			if (raw.trim().length === 0) continue;

			const extension = getFileExtension(path);
			if (!supportedExtensions.has(extension)) {
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path,
						kind: "unsupported-extension",
						message: `Document graph source '${source.id}' cannot decode '${path}': extension '.${extension}' is not registered`,
					}),
				);
			}

			const parsed = yield* serializer.deserialize(raw, extension);
			if (parsed === null || parsed === undefined) continue;

			let document: unknown = parsed;
			if (source.transform !== undefined) {
				const transform = source.transform;
				const outcome = yield* Effect.try({
					try: () =>
						transform(parsed, {
							sourceId: source.id,
							rootId,
							path,
							extension,
						}),
					catch: (error) =>
						new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "transform-defect",
							message: `Document graph transform threw for '${path}': ${error instanceof Error ? error.message : String(error)}`,
							cause: error,
						}),
				});
				if (Result.isFailure(outcome)) {
					return yield* Effect.fail(
						new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "transform-failure",
							message: `Document graph transform rejected '${path}'`,
							cause: outcome.failure,
						}),
					);
				}
				document = outcome.success;
			}

			if (!isRecord(document)) {
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path,
						kind: "non-object",
						message: `Document graph source '${source.id}' file '${path}' must resolve to a top-level object`,
					}),
				);
			}

			for (const key of Object.keys(document)) {
				if (!allowedCollections.has(key)) {
					return yield* Effect.fail(
						new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "unknown-collection",
							collection: key,
							message: `Document graph source '${source.id}' file '${path}' contains unknown collection '${key}'`,
						}),
					);
				}
			}

			for (const collectionName of source.collections) {
				const section = document[collectionName];
				if (section === undefined) continue;
				const collectionConfig = collectionConfigs.get(collectionName);
				if (collectionConfig === undefined) continue;
				if (!isRecord(section)) {
					return yield* Effect.fail(
						new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "non-object",
							collection: collectionName,
							message: `Collection '${collectionName}' in '${path}' must be an object keyed by record id`,
						}),
					);
				}

				const migrated = yield* migrateFragmentSection(
					source,
					path,
					collectionConfig,
					section,
				);
				fragmentsByCollection.get(collectionName)?.push(migrated);
				for (const id of Object.keys(migrated)) {
					const key = provenanceKey(collectionName, id);
					const paths = contributingPaths.get(key);
					if (paths === undefined) {
						contributingPaths.set(key, [path]);
					} else if (!paths.includes(path)) {
						paths.push(path);
					}
				}
			}
		}

		// 3. Deep-merge fragments per collection, then validate effective records.
		for (const collectionName of source.collections) {
			const collectionConfig = collectionConfigs.get(collectionName);
			if (collectionConfig === undefined) continue;
			let target = collections[collectionName];
			if (target === undefined) {
				target = new Map<string, HasId>();
				collections[collectionName] = target;
			}
			const fragments = fragmentsByCollection.get(collectionName) ?? [];
			const effective = deepMergeAll(fragments);
			yield* validateEffectiveSection(
				source,
				collectionConfig,
				effective,
				target,
				contributingPaths,
			);
		}
	});

const buildCollectionConfigs = (
	source: NormalizedDocumentGraphSourceConfig,
	config: NormalizedSourceConfig,
): ReadonlyMap<string, CollectionLoadConfig> => {
	const collectionConfigs = new Map<string, CollectionLoadConfig>();
	for (const collectionName of source.collections) {
		const collectionConfig = config.collectionConfigs[collectionName];
		if (collectionConfig === undefined) continue;
		collectionConfigs.set(collectionName, {
			name: collectionName,
			schema: collectionConfig.schema as Schema.Codec<
				HasId,
				unknown,
				never,
				never
			>,
			...(collectionConfig.id !== undefined ? { id: collectionConfig.id } : {}),
			...(collectionConfig.version !== undefined
				? { version: collectionConfig.version }
				: {}),
			...(collectionConfig.migrations !== undefined
				? { migrations: collectionConfig.migrations }
				: {}),
		});
	}
	return collectionConfigs;
};

/**
 * Bring one fragment's section to the current schema version, using that
 * fragment's own `_version`. Migration runs before merge because
 * `runMigrations` early-returns once `fileVersion >= targetVersion`, so merging
 * mixed-version fragments first would leave older fragments unmigrated.
 */
const migrateFragmentSection = (
	source: NormalizedDocumentGraphSourceConfig,
	path: string,
	collectionConfig: CollectionLoadConfig,
	section: Record<string, unknown>,
): Effect.Effect<Record<string, unknown>, GraphLoadError, never> =>
	Effect.gen(function* () {
		const fileVersion =
			typeof section._version === "number" ? section._version : 0;
		const entityMap: Record<string, unknown> = {};
		for (const [id, value] of Object.entries(section)) {
			if (id !== "_version") entityMap[id] = value;
		}

		if (collectionConfig.version === undefined) return entityMap;
		if (fileVersion > collectionConfig.version) {
			return yield* Effect.fail(
				new DocumentGraphSourceError({
					sourceId: source.id,
					path,
					kind: "migration",
					collection: collectionConfig.name,
					message: `File version ${fileVersion} for collection '${collectionConfig.name}' in '${path}' is ahead of config version ${collectionConfig.version}`,
				}),
			);
		}
		if (
			fileVersion < collectionConfig.version &&
			collectionConfig.migrations !== undefined &&
			collectionConfig.migrations.length > 0
		) {
			return yield* runMigrations(
				entityMap,
				fileVersion,
				collectionConfig.version,
				collectionConfig.migrations,
				collectionConfig.name,
			);
		}
		return entityMap;
	});

const validateEffectiveSection = (
	source: NormalizedDocumentGraphSourceConfig,
	collectionConfig: CollectionLoadConfig,
	effective: Record<string, unknown>,
	target: Map<string, HasId>,
	contributingPaths: ReadonlyMap<string, ReadonlyArray<string>>,
): Effect.Effect<void, GraphLoadError, never> =>
	Effect.gen(function* () {
		const decode = Schema.decodeUnknownEffect(collectionConfig.schema);
		for (const [id, value] of Object.entries(effective)) {
			const paths = contributingPaths.get(
				provenanceKey(collectionConfig.name, id),
			);
			if (!isRecord(value)) {
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path: paths?.[0] ?? "",
						kind: "validation",
						collection: collectionConfig.name,
						recordId: id,
						...(paths !== undefined ? { contributingPaths: paths } : {}),
						message: `Effective record '${collectionConfig.name}.${id}' must be an object`,
					}),
				);
			}

			const physicalIdError = assertNoPhysicalDerivedId(
				id,
				value,
				collectionConfig.id,
				`${collectionConfig.name}`,
			);
			if (physicalIdError !== undefined) {
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path: paths?.[0] ?? "",
						kind: "validation",
						collection: collectionConfig.name,
						recordId: id,
						...(paths !== undefined ? { contributingPaths: paths } : {}),
						message: physicalIdError.message,
					}),
				);
			}

			const decoded = yield* decode(value).pipe(
				Effect.mapError(
					(parseError) =>
						new DocumentGraphSourceError({
							sourceId: source.id,
							path: paths?.[0] ?? "",
							kind: "validation",
							collection: collectionConfig.name,
							recordId: id,
							...(paths !== undefined ? { contributingPaths: paths } : {}),
							message: `Effective record '${collectionConfig.name}.${id}' failed validation${paths !== undefined ? ` (contributed by ${paths.join(", ")})` : ""}: ${parseError.message}`,
						}),
				),
			);

			const hydratableError = requireHydratablePayload(
				id,
				decoded,
				collectionConfig.id,
				`${collectionConfig.name}`,
			);
			if (hydratableError !== undefined) {
				return yield* Effect.fail(
					new DocumentGraphSourceError({
						sourceId: source.id,
						path: paths?.[0] ?? "",
						kind: "validation",
						collection: collectionConfig.name,
						recordId: id,
						...(paths !== undefined ? { contributingPaths: paths } : {}),
						message: hydratableError.message,
					}),
				);
			}

			const hydrated = hydrateDerivedId<HasId>(
				id,
				decoded,
				collectionConfig.id,
			);
			target.set(hydrated.id, hydrated);
		}
	});
