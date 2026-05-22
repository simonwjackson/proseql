import * as path from "node:path";
import type {
	CollectionConfig,
	DatabaseConfig,
	DatabaseSourceConfig,
} from "@proseql/core";
import {
	getCollectionConfigs,
	isSourceOrientedDatabaseConfig,
} from "@proseql/core";

const resolvePathFrom = (baseDir: string, filePath: string): string =>
	path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

const resolveCollectionConfigPaths = (
	collections: Record<string, CollectionConfig>,
	configDir: string,
): Record<string, CollectionConfig> => {
	const resolved: Record<string, CollectionConfig> = {};

	for (const [collectionName, collectionConfig] of Object.entries(
		collections,
	)) {
		resolved[collectionName] = {
			...collectionConfig,
			...(collectionConfig.file !== undefined
				? { file: resolvePathFrom(configDir, collectionConfig.file) }
				: {}),
			...(collectionConfig.directory !== undefined
				? { directory: resolvePathFrom(configDir, collectionConfig.directory) }
				: {}),
		};
	}

	return resolved;
};

const resolveSourceConfigPaths = (
	source: DatabaseSourceConfig,
	configDir: string,
): DatabaseSourceConfig => {
	switch (source.kind) {
		case "documents": {
			const root = resolvePathFrom(configDir, source.root);
			return {
				...source,
				root,
				outbox: resolvePathFrom(root, source.outbox),
			};
		}
		case "file":
		case "appendOnly":
			return {
				...source,
				file: resolvePathFrom(configDir, source.file),
			};
		case "directory":
			return {
				...source,
				directory: resolvePathFrom(configDir, source.directory),
			};
	}
};

/**
 * Resolve persistence paths in a CLI-loaded config relative to the config file.
 * Legacy collection file/directory paths resolve from the config directory;
 * document source outboxes resolve from their source root so core receives a
 * rediscoverable absolute outbox path.
 */
export const resolveConfigPaths = (
	config: DatabaseConfig,
	configPath: string,
): DatabaseConfig => {
	const configDir = path.dirname(configPath);

	if (isSourceOrientedDatabaseConfig(config)) {
		return {
			...config,
			collections: resolveCollectionConfigPaths(
				config.collections as Record<string, CollectionConfig>,
				configDir,
			),
			sources: (config.sources ?? []).map((source) =>
				resolveSourceConfigPaths(source, configDir),
			),
		};
	}

	return resolveCollectionConfigPaths(
		config as Record<string, CollectionConfig>,
		configDir,
	) as DatabaseConfig;
};

export const getCliCollectionConfigs = (
	config: DatabaseConfig,
): Record<string, CollectionConfig> =>
	getCollectionConfigs(config) as Record<string, CollectionConfig>;

export const listCollectionNames = (
	config: DatabaseConfig,
): ReadonlyArray<string> => Object.keys(getCliCollectionConfigs(config));

export const getCliCollectionConfig = (
	config: DatabaseConfig,
	collection: string,
): CollectionConfig | undefined => getCliCollectionConfigs(config)[collection];

export interface CollectionPersistenceInfo {
	readonly file: string;
	readonly format: string;
	readonly sizeLabel: string;
	readonly sizeBytes: number;
}

const extensionToFormat = (filePath: string | undefined): string => {
	if (filePath === undefined) return "(in-memory)";
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".json":
			return "json";
		case ".jsonl":
			return "jsonl";
		case ".yaml":
		case ".yml":
			return "yaml";
		case ".toml":
			return "toml";
		case ".json5":
			return "json5";
		case ".jsonc":
			return "jsonc";
		case ".hjson":
			return "hjson";
		case ".toon":
			return "toon";
		default:
			return ext ? ext.slice(1) : "unknown";
	}
};

export const formatBytes = (
	bytes: number,
	emptyLabel = "(in-memory)",
): string => {
	if (bytes === 0) return emptyLabel;

	const units = ["B", "KB", "MB", "GB"];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return unitIndex === 0
		? `${size} ${units[unitIndex]}`
		: `${size.toFixed(2)} ${units[unitIndex]}`;
};

export const getCollectionPersistenceInfo = (
	config: DatabaseConfig,
	collection: string,
	configPath: string,
	getFileSize: (filePath: string | undefined) => number,
): CollectionPersistenceInfo => {
	const collectionConfig = getCliCollectionConfig(config, collection);
	const configDir = path.dirname(configPath);

	if (isSourceOrientedDatabaseConfig(config)) {
		for (const source of config.sources ?? []) {
			if (source.kind === "documents") {
				const selected = source.collections ?? "all";
				const includesCollection =
					selected === "all" || selected.includes(collection);
				if (includesCollection) {
					const root = path.relative(configDir, source.root) || source.root;
					const outbox =
						path.relative(configDir, source.outbox) || source.outbox;
					return {
						file: `document source '${source.id}' (root: ${root}, outbox: ${outbox})`,
						format: source.format ?? "yaml",
						sizeLabel: "(document source)",
						sizeBytes: 0,
					};
				}
			}
			if (
				(source.kind === "file" || source.kind === "appendOnly") &&
				source.collection === collection
			) {
				const displayPath =
					path.relative(configDir, source.file) || source.file;
				const sizeBytes = getFileSize(source.file);
				return {
					file: displayPath,
					format: source.format ?? extensionToFormat(source.file),
					sizeLabel: formatBytes(sizeBytes),
					sizeBytes,
				};
			}
			if (source.kind === "directory" && source.collection === collection) {
				const displayPath =
					path.relative(configDir, source.directory) || source.directory;
				return {
					file: displayPath,
					format: source.format,
					sizeLabel: "(directory)",
					sizeBytes: 0,
				};
			}
		}
	}

	const filePath = collectionConfig?.file;
	const sizeBytes = getFileSize(filePath);
	return {
		file: filePath
			? path.relative(configDir, filePath) || filePath
			: "(in-memory)",
		format: extensionToFormat(filePath),
		sizeLabel: formatBytes(sizeBytes),
		sizeBytes,
	};
};
