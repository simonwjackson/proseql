/**
 * Convenience wrappers that eliminate manual codec/layer wiring.
 *
 * These functions infer codecs from the database config's file extensions
 * and format overrides, so users don't need to manually select and wire codecs.
 */

import type { PluginError } from "@proseql/core";
import {
	createPersistentEffectDatabase,
	type DatabaseConfig,
	type EffectDatabaseOptions,
	type EffectDatabasePersistenceConfig,
	type FormatCodec,
	type GenerateDatabaseWithPersistence,
	inferCodecsFromConfig,
	type MigrationError,
	makeSerializerLayer,
	type SerializationError,
	type SerializerRegistryService,
	type StorageAdapterService,
	type StorageError,
	type UnsupportedFormatError,
	type ValidationError,
} from "@proseql/core";
import { Effect, Layer, type Scope } from "effect";
import { NodeStorageLayer } from "./node-adapter-layer.js";

/**
 * Build a persistence Layer from a database config.
 *
 * Infers codecs from file extensions and `format` overrides, combines with
 * NodeStorageLayer. Optionally accepts extra codecs to merge in.
 *
 * @param config - Database configuration to infer codecs from
 * @param options - Optional extra codecs to include alongside inferred ones
 * @returns A Layer providing StorageAdapter + SerializerRegistry
 */
export const makeNodePersistenceLayer = <Config extends DatabaseConfig>(
	config: Config,
	options?: { readonly codecs?: ReadonlyArray<FormatCodec> },
): Layer.Layer<StorageAdapterService | SerializerRegistryService> => {
	const codecs = options?.codecs ?? inferCodecsFromConfig(config);
	return Layer.merge(NodeStorageLayer, makeSerializerLayer(codecs));
};

/**
 * Create a persistent database with Node.js file storage — no manual layer wiring.
 *
 * Codecs are inferred from file extensions and `format` overrides in the config.
 * The returned Effect only requires `Scope` (for cleanup); storage and serialization
 * are provided internally.
 *
 * @param config - Database configuration (schemas, file paths, relationships, etc.)
 * @param initialData - Optional initial data arrays per collection
 * @param persistenceConfig - Optional persistence tuning (debounce, plugin codecs)
 * @param options - Optional database options (plugins)
 * @returns Effect yielding a fully wired persistent database
 */
export const createNodeDatabase = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: {
		readonly [K in keyof Config]?: ReadonlyArray<Record<string, unknown>>;
	},
	persistenceConfig?: EffectDatabasePersistenceConfig,
	options?: EffectDatabaseOptions,
): Effect.Effect<
	GenerateDatabaseWithPersistence<Config>,
	| MigrationError
	| StorageError
	| SerializationError
	| UnsupportedFormatError
	| ValidationError
	| PluginError,
	Scope.Scope
> => {
	const layer = makeNodePersistenceLayer(config);
	return createPersistentEffectDatabase(
		config,
		initialData,
		persistenceConfig,
		options,
	).pipe(Effect.provide(layer));
};
