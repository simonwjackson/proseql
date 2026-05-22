import { SourceConfigError } from "../errors/source-errors.js";
import type { CollectionConfig } from "../types/database-config-types.js";
import { joinPath, normalizePath } from "../utils/path.js";

export type SourceCollectionSelection = "all" | ReadonlyArray<string>;

export type SourceStrictness = "error";
export type UnknownCollectionPolicy = "error" | "preserve";

export interface DocumentSourceConfig {
	readonly id: string;
	readonly kind: "documents";
	readonly root: string;
	readonly include?: string | ReadonlyArray<string>;
	readonly exclude?: string | ReadonlyArray<string>;
	readonly format?: string;
	readonly collections?: SourceCollectionSelection;
	readonly unknownCollections?: UnknownCollectionPolicy;
	readonly duplicates?: SourceStrictness;
	readonly outbox: string;
	readonly optional?: boolean;
}

export interface FileSourceConfig {
	readonly id: string;
	readonly kind: "file";
	readonly collection: string;
	readonly file: string;
	readonly format?: string;
}

export interface DirectorySourceConfig {
	readonly id: string;
	readonly kind: "directory";
	readonly collection: string;
	readonly directory: string;
	readonly format: string;
}

export interface AppendOnlyLogSourceConfig {
	readonly id: string;
	readonly kind: "appendOnly";
	readonly collection: string;
	readonly file: string;
	readonly format?: string;
}

export type DatabaseSourceConfig =
	| DocumentSourceConfig
	| FileSourceConfig
	| DirectorySourceConfig
	| AppendOnlyLogSourceConfig;

export interface NormalizedDocumentSourceConfig {
	readonly id: string;
	readonly kind: "documents";
	readonly root: string;
	readonly include: ReadonlyArray<string>;
	readonly exclude: ReadonlyArray<string>;
	readonly format: string;
	readonly collections: ReadonlyArray<string>;
	readonly unknownCollections: UnknownCollectionPolicy;
	readonly duplicates: SourceStrictness;
	readonly outbox: string;
	readonly optional: boolean;
}

export type NormalizedDatabaseSourceConfig = NormalizedDocumentSourceConfig;

export interface SourceOrientedConfigInput {
	readonly collections: Record<string, CollectionConfig>;
	readonly sources?: ReadonlyArray<DatabaseSourceConfig>;
}

export interface NormalizedSourceConfig {
	readonly collections: ReadonlyArray<string>;
	readonly collectionConfigs: Record<string, CollectionConfig>;
	readonly sources: ReadonlyArray<NormalizedDatabaseSourceConfig>;
}

const toArray = (
	value: string | ReadonlyArray<string> | undefined,
	fallback: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	if (value === undefined) return fallback;
	return typeof value === "string" ? [value] : [...value];
};

const defaultIncludesForFormat = (format: string): ReadonlyArray<string> =>
	format === "yaml" ? ["**/*.yaml", "**/*.yml"] : [`**/*.${format}`];

const normalizeRoot = (root: string): string =>
	normalizePath(root).replace(/\/$/, "");

export const relativeToRoot = (root: string, path: string): string => {
	const normalizedRoot = normalizeRoot(root);
	const normalizedPath = normalizePath(path);
	if (normalizedPath === normalizedRoot) return "";
	const prefix = `${normalizedRoot}/`;
	return normalizedPath.startsWith(prefix)
		? normalizedPath.slice(prefix.length)
		: normalizedPath;
};

export const matchesDocumentSourcePattern = (
	source: Pick<NormalizedDocumentSourceConfig, "root" | "include" | "exclude">,
	path: string,
): boolean => {
	const relative = relativeToRoot(source.root, path);
	if (relative.startsWith("../") || relative === "..") return false;
	const included = source.include.some((pattern) =>
		matchesPattern(pattern, relative),
	);
	if (!included) return false;
	return !source.exclude.some((pattern) => matchesPattern(pattern, relative));
};

const matchesPattern = (pattern: string, relativePath: string): boolean => {
	const normalizedPattern = normalizePath(pattern);
	if (normalizedPattern === "**/*") return relativePath.length > 0;
	if (normalizedPattern.startsWith("**/*.")) {
		return relativePath.endsWith(normalizedPattern.slice(4));
	}
	if (normalizedPattern.startsWith("*.")) {
		return (
			!relativePath.includes("/") &&
			relativePath.endsWith(normalizedPattern.slice(1))
		);
	}
	if (normalizedPattern.endsWith("/*")) {
		const prefix = normalizedPattern.slice(0, -1);
		const rest = relativePath.startsWith(prefix)
			? relativePath.slice(prefix.length)
			: "";
		return rest.length > 0 && !rest.includes("/");
	}
	return relativePath === normalizedPattern;
};

export const normalizeSourceConfig = (
	config: SourceOrientedConfigInput,
): NormalizedSourceConfig => {
	const collectionNames = Object.keys(config.collections).sort();
	for (const collectionName of collectionNames) {
		const collectionConfig = config.collections[collectionName];
		if (
			collectionConfig.file !== undefined ||
			collectionConfig.directory !== undefined ||
			collectionConfig.path !== undefined ||
			collectionConfig.appendOnly !== undefined
		) {
			throw new SourceConfigError({
				message: `Collection '${collectionName}' uses old-style persistence fields; configure persistence through database sources`,
				collection: collectionName,
			});
		}
	}
	const collectionNameSet = new Set(collectionNames);
	const sourceIds = new Set<string>();
	const outboxes = new Map<string, string>();
	const collectionSourceOwners = new Map<string, string>();
	const sources: Array<NormalizedDatabaseSourceConfig> = [];

	for (const source of config.sources ?? []) {
		if (sourceIds.has(source.id)) {
			throw new SourceConfigError({
				message: `Duplicate source id '${source.id}'`,
				sourceId: source.id,
			});
		}
		sourceIds.add(source.id);

		if (source.kind !== "documents") {
			const collection = source.collection;
			if (!collectionNameSet.has(collection)) {
				throw new SourceConfigError({
					message: `Source '${source.id}' references undeclared collection '${collection}'`,
					sourceId: source.id,
					collection,
				});
			}
			throw new SourceConfigError({
				message: `Source '${source.id}' uses unsupported source kind '${source.kind}'; only 'documents' sources are supported in source-oriented configs`,
				sourceId: source.id,
				collection,
			});
		}

		const selectedCollections =
			source.collections === undefined || source.collections === "all"
				? collectionNames
				: [...source.collections].sort();

		for (const collection of selectedCollections) {
			if (!collectionNameSet.has(collection)) {
				throw new SourceConfigError({
					message: `Source '${source.id}' references undeclared collection '${collection}'`,
					sourceId: source.id,
					collection,
				});
			}
			const existingOwner = collectionSourceOwners.get(collection);
			if (existingOwner !== undefined) {
				throw new SourceConfigError({
					message: `Collection '${collection}' is backed by both document sources '${existingOwner}' and '${source.id}'`,
					sourceId: source.id,
					collection,
				});
			}
			collectionSourceOwners.set(collection, source.id);
		}

		const format = source.format ?? "yaml";
		const normalized: NormalizedDocumentSourceConfig = {
			id: source.id,
			kind: "documents",
			root: normalizeRoot(source.root),
			include: toArray(source.include, defaultIncludesForFormat(format)),
			exclude: toArray(source.exclude, []),
			format,
			collections: selectedCollections,
			unknownCollections: source.unknownCollections ?? "error",
			duplicates: source.duplicates ?? "error",
			outbox: normalizePath(source.outbox),
			optional: source.optional ?? false,
		};

		const outboxPath = normalized.outbox.startsWith("/")
			? normalized.outbox
			: joinPath(normalized.root, normalized.outbox);
		const normalizedWithOutbox = { ...normalized, outbox: outboxPath };

		if (!matchesDocumentSourcePattern(normalizedWithOutbox, outboxPath)) {
			throw new SourceConfigError({
				message: `Document source '${source.id}' outbox '${outboxPath}' is not rediscoverable by its include patterns`,
				sourceId: source.id,
				path: outboxPath,
			});
		}

		const existingOutboxOwner = outboxes.get(outboxPath);
		if (existingOutboxOwner !== undefined) {
			throw new SourceConfigError({
				message: `Document source outbox '${outboxPath}' is owned by both '${existingOutboxOwner}' and '${source.id}'`,
				sourceId: source.id,
				path: outboxPath,
			});
		}
		outboxes.set(outboxPath, source.id);
		sources.push(normalizedWithOutbox);
	}

	return {
		collections: collectionNames,
		collectionConfigs: config.collections,
		sources,
	};
};
