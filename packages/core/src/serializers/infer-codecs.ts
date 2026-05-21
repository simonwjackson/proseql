/**
 * Infer which codecs are needed from a database config's file extensions and format overrides.
 */

import {
	type DatabaseConfig,
	getCollectionConfigs,
	isSourceOrientedDatabaseConfig,
} from "../types/database-config-types.js";
import { getFileExtension } from "../utils/path.js";
import { hjsonCodec } from "./codecs/hjson.js";
import { jsonCodec } from "./codecs/json.js";
import { json5Codec } from "./codecs/json5.js";
import { jsoncCodec } from "./codecs/jsonc.js";
import { jsonlCodec } from "./codecs/jsonl.js";
import { proseCodec } from "./codecs/prose.js";
import { tomlCodec } from "./codecs/toml.js";
import { toonCodec } from "./codecs/toon.js";
import { yamlCodec } from "./codecs/yaml.js";
import type { FormatCodec } from "./format-codec.js";

const CODEC_FACTORIES: Record<string, () => FormatCodec> = {
	json: () => jsonCodec(),
	yaml: () => yamlCodec(),
	yml: () => yamlCodec(),
	json5: () => json5Codec(),
	jsonc: () => jsoncCodec(),
	jsonl: () => jsonlCodec(),
	ndjson: () => jsonlCodec(),
	toml: () => tomlCodec(),
	toon: () => toonCodec(),
	hjson: () => hjsonCodec(),
	prose: () => proseCodec(),
};

/**
 * Infer which FormatCodec instances are needed based on a database config.
 *
 * Examines each collection's `format` override (if present) or file extension
 * to determine which codecs are required. Returns a deduped array of codec instances.
 *
 * Collections without a `file` field (in-memory only) are skipped.
 * Unknown extensions are silently skipped.
 *
 * @param config - The database configuration to analyze
 * @returns A deduplicated array of FormatCodec instances
 */
export const inferCodecsFromConfig = (
	config: DatabaseConfig,
): ReadonlyArray<FormatCodec> => {
	const seen = new Set<string>();
	const codecs: FormatCodec[] = [];

	const addFormat = (format: string): void => {
		if (!format) return;
		const factory = CODEC_FACTORIES[format];
		if (!factory) return;

		const codec = factory();
		if (!seen.has(codec.name)) {
			seen.add(codec.name);
			codecs.push(codec);
		}
	};

	if (isSourceOrientedDatabaseConfig(config)) {
		for (const source of config.sources ?? []) {
			if (source.kind === "documents") {
				addFormat(source.format ?? "yaml");
			} else if (source.kind === "directory") {
				addFormat(source.format);
			} else {
				addFormat(source.format ?? getFileExtension(source.file));
			}
		}
	}

	for (const collectionConfig of Object.values(getCollectionConfigs(config))) {
		const format =
			collectionConfig.format ??
			(collectionConfig.file ? getFileExtension(collectionConfig.file) : "");
		addFormat(format);
	}

	return codecs;
};
