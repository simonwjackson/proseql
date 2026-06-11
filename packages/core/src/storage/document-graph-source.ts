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
export type DocumentGraphDiagnosticAction =
	| "skipped-fragment"
	| "skipped-root"
	| "ignored-collection";

export interface DocumentGraphDiagnostic {
	readonly sourceId: string;
	readonly rootId: string;
	readonly path?: string;
	readonly action: DocumentGraphDiagnosticAction;
	readonly collection?: string;
	readonly recordId?: string;
	readonly message: string;
	readonly error?: DocumentGraphSourceError;
}

export interface DocumentGraphRecordContribution {
	readonly sourceId: string;
	readonly rootId: string;
	readonly path: string;
	readonly collection: string;
	readonly id: string;
}

export interface DocumentGraphRecordProvenance {
	readonly sourceId: string;
	readonly collection: string;
	readonly id: string;
	readonly contributors: ReadonlyArray<DocumentGraphRecordContribution>;
	readonly effectiveContributor: DocumentGraphRecordContribution;
}

export interface LoadedDocumentGraph {
	readonly collections: Record<string, ReadonlyMap<string, HasId>>;
	readonly contributingPaths: ReadonlyMap<string, ReadonlyArray<string>>;
	readonly provenance: ReadonlyMap<string, DocumentGraphRecordProvenance>;
	readonly diagnostics: ReadonlyArray<DocumentGraphDiagnostic>;
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
		const provenance = new Map<string, DocumentGraphRecordProvenance>();
		const diagnostics: DocumentGraphDiagnostic[] = [];

		const graphSources = config.sources.filter(
			(source): source is NormalizedDocumentGraphSourceConfig =>
				source.kind === "documentGraph",
		);

		for (const source of graphSources) {
			yield* loadGraphSource(
				source,
				config,
				collections,
				contributingPaths,
				provenance,
				diagnostics,
			);
		}

		return { collections, contributingPaths, provenance, diagnostics };
	});

const loadGraphSource = (
	source: NormalizedDocumentGraphSourceConfig,
	config: NormalizedSourceConfig,
	collections: Record<string, Map<string, HasId>>,
	contributingPaths: Map<string, string[]>,
	provenance: Map<string, DocumentGraphRecordProvenance>,
	diagnostics: DocumentGraphDiagnostic[],
): Effect.Effect<void, GraphLoadError, StorageAdapter | SerializerRegistry> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const supportedExtensions = new Set(serializer.supportedExtensions());

		const collectionConfigs = buildCollectionConfigs(source, config);
		const sourceAllowedCollections = new Set(source.collections);

		// Per collection, an ordered list of migrated fragment sections (id -> record).
		const fragmentsByCollection = new Map<
			string,
			Array<Record<string, unknown>>
		>();
		for (const collectionName of source.collections) {
			fragmentsByCollection.set(collectionName, []);
		}

		const handleFragmentError = (
			error: DocumentGraphSourceError,
			rootId: string,
		): "fail" | "skip-fragment" | "skip-root" => {
			if (source.onFragmentError === "error") return "fail";
			const action =
				source.onFragmentError === "skip-root"
					? "skipped-root"
					: "skipped-fragment";
			diagnostics.push({
				sourceId: source.id,
				rootId,
				path: error.path,
				action,
				...(error.collection !== undefined
					? { collection: error.collection }
					: {}),
				...(error.recordId !== undefined ? { recordId: error.recordId } : {}),
				message: error.message,
				error,
			});
			return source.onFragmentError;
		};

		// Discover and process fragments root-by-root. Root-local fragments are only
		// committed to the graph after the root succeeds, so skip-root can discard
		// earlier valid fragments from the same root atomically for this rebuild.
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

			const rootAllowedCollections = new Set(root.collections);
			const rootFragmentsByCollection = new Map<
				string,
				Array<Record<string, unknown>>
			>();
			for (const collectionName of source.collections) {
				rootFragmentsByCollection.set(collectionName, []);
			}
			const rootContributingPaths = new Map<string, string[]>();
			const rootContributions = new Map<
				string,
				DocumentGraphRecordContribution[]
			>();
			let skipRoot = false;

			for (const path of matched) {
				const raw = yield* storage.read(path);
				if (raw.trim().length === 0) continue;

				const extension = getFileExtension(path);
				if (!supportedExtensions.has(extension)) {
					const error = new DocumentGraphSourceError({
						sourceId: source.id,
						path,
						kind: "unsupported-extension",
						message: `Document graph source '${source.id}' cannot decode '${path}': extension '.${extension}' is not registered`,
					});
					const action = handleFragmentError(error, root.id);
					if (action === "fail") return yield* Effect.fail(error);
					if (action === "skip-root") {
						skipRoot = true;
						break;
					}
					continue;
				}

				const parsedResult = yield* Effect.result(
					serializer.deserialize(raw, extension),
				);
				if (Result.isFailure(parsedResult)) {
					const error = new DocumentGraphSourceError({
						sourceId: source.id,
						path,
						kind: "deserialize",
						message: `Document graph source '${source.id}' cannot decode '${path}': ${String(parsedResult.failure)}`,
						cause: parsedResult.failure,
					});
					const action = handleFragmentError(error, root.id);
					if (action === "fail")
						return yield* Effect.fail(parsedResult.failure);
					if (action === "skip-root") {
						skipRoot = true;
						break;
					}
					continue;
				}
				const parsed = parsedResult.success;
				if (parsed === null || parsed === undefined) continue;

				let document: unknown = parsed;
				if (source.transform !== undefined) {
					const transform = source.transform;
					const outcomeResult = yield* Effect.result(
						Effect.try({
							try: () =>
								transform(parsed, {
									sourceId: source.id,
									rootId: root.id,
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
						}),
					);
					if (Result.isFailure(outcomeResult)) {
						const error = outcomeResult.failure;
						const action = handleFragmentError(error, root.id);
						if (action === "fail") return yield* Effect.fail(error);
						if (action === "skip-root") {
							skipRoot = true;
							break;
						}
						continue;
					}
					const outcome = outcomeResult.success;
					if (Result.isFailure(outcome)) {
						const error = new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "transform-failure",
							message: `Document graph transform rejected '${path}'`,
							cause: outcome.failure,
						});
						const action = handleFragmentError(error, root.id);
						if (action === "fail") return yield* Effect.fail(error);
						if (action === "skip-root") {
							skipRoot = true;
							break;
						}
						continue;
					}
					document = outcome.success;
				}

				if (!isRecord(document)) {
					const error = new DocumentGraphSourceError({
						sourceId: source.id,
						path,
						kind: "non-object",
						message: `Document graph source '${source.id}' file '${path}' must resolve to a top-level object`,
					});
					const action = handleFragmentError(error, root.id);
					if (action === "fail") return yield* Effect.fail(error);
					if (action === "skip-root") {
						skipRoot = true;
						break;
					}
					continue;
				}

				for (const key of Object.keys(document)) {
					if (!sourceAllowedCollections.has(key)) {
						const error = new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "unknown-collection",
							collection: key,
							message: `Document graph source '${source.id}' file '${path}' contains unknown collection '${key}'`,
						});
						const action = handleFragmentError(error, root.id);
						if (action === "fail") return yield* Effect.fail(error);
						if (action === "skip-root") {
							skipRoot = true;
							break;
						}
						continue;
					}
					if (!rootAllowedCollections.has(key)) {
						diagnostics.push({
							sourceId: source.id,
							rootId: root.id,
							path,
							action: "ignored-collection",
							collection: key,
							message: `Document graph source '${source.id}' root '${root.id}' ignored collection '${key}' from '${path}'`,
						});
					}
				}
				if (skipRoot) break;

				for (const collectionName of source.collections) {
					if (!rootAllowedCollections.has(collectionName)) continue;
					const section = document[collectionName];
					if (section === undefined) continue;
					const collectionConfig = collectionConfigs.get(collectionName);
					if (collectionConfig === undefined) continue;
					if (!isRecord(section)) {
						const error = new DocumentGraphSourceError({
							sourceId: source.id,
							path,
							kind: "non-object",
							collection: collectionName,
							message: `Collection '${collectionName}' in '${path}' must be an object keyed by record id`,
						});
						const action = handleFragmentError(error, root.id);
						if (action === "fail") return yield* Effect.fail(error);
						if (action === "skip-root") {
							skipRoot = true;
							break;
						}
						continue;
					}

					const migratedResult = yield* Effect.result(
						migrateFragmentSection(source, path, collectionConfig, section),
					);
					if (Result.isFailure(migratedResult)) {
						const failure = migratedResult.failure;
						if (failure instanceof DocumentGraphSourceError) {
							const action = handleFragmentError(failure, root.id);
							if (action === "fail") return yield* Effect.fail(failure);
							if (action === "skip-root") {
								skipRoot = true;
								break;
							}
							continue;
						}
						return yield* Effect.fail(failure);
					}

					const migrated = migratedResult.success;
					rootFragmentsByCollection.get(collectionName)?.push(migrated);
					for (const id of Object.keys(migrated)) {
						const key = provenanceKey(collectionName, id);
						const paths = rootContributingPaths.get(key);
						if (paths === undefined) {
							rootContributingPaths.set(key, [path]);
						} else if (!paths.includes(path)) {
							paths.push(path);
						}
						const contribution: DocumentGraphRecordContribution = {
							sourceId: source.id,
							rootId: root.id,
							path,
							collection: collectionName,
							id,
						};
						const contributions = rootContributions.get(key);
						if (contributions === undefined) {
							rootContributions.set(key, [contribution]);
						} else {
							contributions.push(contribution);
						}
					}
				}
				if (skipRoot) break;
			}

			if (skipRoot) continue;
			for (const collectionName of source.collections) {
				const rootFragments =
					rootFragmentsByCollection.get(collectionName) ?? [];
				fragmentsByCollection.get(collectionName)?.push(...rootFragments);
			}
			for (const [key, rootPaths] of rootContributingPaths) {
				const paths = contributingPaths.get(key);
				if (paths === undefined) {
					contributingPaths.set(key, [...rootPaths]);
				} else {
					for (const path of rootPaths) {
						if (!paths.includes(path)) paths.push(path);
					}
				}
			}
			for (const [key, rootRecordContributions] of rootContributions) {
				const existing = provenance.get(key);
				const contributors = [
					...(existing?.contributors ?? []),
					...rootRecordContributions,
				];
				const effectiveContributor = contributors[contributors.length - 1];
				if (effectiveContributor !== undefined) {
					provenance.set(key, {
						sourceId: effectiveContributor.sourceId,
						collection: effectiveContributor.collection,
						id: effectiveContributor.id,
						contributors,
						effectiveContributor,
					});
				}
			}
		}

		// Deep-merge fragments per collection, then validate effective records.
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
