import { Effect, type Schema } from "effect";
import {
	type CollectionConfig,
	createEffectDatabase as createCoreEffectDatabase,
	type EffectDatabase,
} from "../packages/core/src/index.js";
import { createEffectDatabase as createWasmEffectDatabase } from "../packages/effect/src/index.js";
import type { EngineId } from "./comparison.js";

export type BenchSchemaConfig = Record<
	string,
	{
		readonly schema: Schema.Schema<{ readonly id: string }, unknown>;
		readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>;
		readonly relationships?: Record<
			string,
			{
				readonly type: "ref" | "inverse";
				readonly target: string;
				readonly foreignKey?: string;
			}
		>;
	}
>;

type ConvertToDbConfig<T extends BenchSchemaConfig> = {
	readonly [K in keyof T]: {
		readonly schema: T[K]["schema"];
		readonly indexes: T[K]["indexes"];
		readonly relationships: T[K]["relationships"] extends undefined
			? Record<string, never>
			: NonNullable<T[K]["relationships"]>;
	};
};

export type ScalarEqualityCriterion = Readonly<
	Record<string, string | number | boolean>
>;

export interface BenchCollectionMutationAdapter<Row> {
	readonly updateManyEquality: (
		collection: {
			readonly updateMany: (
				selector: ((row: Row) => boolean) | Record<string, unknown>,
				updates: Record<string, unknown>,
			) => { readonly runPromise: Promise<unknown> };
		},
		where: ScalarEqualityCriterion,
		updates: Record<string, unknown>,
	) => Promise<unknown>;
	readonly deleteManyEquality: (
		collection: {
			readonly deleteMany: (
				selector: ((row: Row) => boolean) | Record<string, unknown>,
				options?: Record<string, unknown>,
			) => { readonly runPromise: Promise<unknown> };
		},
		where: ScalarEqualityCriterion,
	) => Promise<unknown>;
}

export interface BenchDatabaseHandle<T> {
	readonly db: T;
	readonly close: () => Promise<void>;
	readonly projectionMaterialization?: () =>
		| {
				readonly descriptors: number;
				readonly descriptorBytes: number;
				readonly cacheHits: number;
				readonly cacheMisses: number;
				readonly resynchronizations: number;
				readonly fullValueBytesAvoided: number;
				readonly materializationMilliseconds: number;
				readonly materializedRows: number;
				readonly trackedProxies: number;
				readonly peakMaterializedRows: number;
				readonly peakTrackedProxies: number;
		  }
		| undefined;
	readonly collectionMutationAdapter: BenchCollectionMutationAdapter<
		Record<string, unknown>
	>;
}

export interface BenchEngine {
	readonly id: EngineId;
	readonly label: string;
	createDatabase: <T extends BenchSchemaConfig>(
		schemaConfig: T,
		initialData?: {
			readonly [K in keyof T]?: ReadonlyArray<Record<string, unknown>>;
		},
	) => Promise<BenchDatabaseHandle<EffectDatabase<ConvertToDbConfig<T>>>>;
}

const compileScalarEqualityPredicate = <Row extends Record<string, unknown>>(
	where: ScalarEqualityCriterion,
) => {
	const entries = Object.entries(where);
	return (row: Row) =>
		entries.every(([key, value]) => Object.is(row[key], value));
};

const createCollectionMutationAdapter = (
	engineId: EngineId,
): BenchCollectionMutationAdapter<Record<string, unknown>> => ({
	updateManyEquality: (collection, where, updates) =>
		engineId === "wasm"
			? collection.updateMany(where, updates).runPromise
			: collection.updateMany(compileScalarEqualityPredicate(where), updates)
					.runPromise,
	deleteManyEquality: (collection, where) =>
		engineId === "wasm"
			? collection.deleteMany(where).runPromise
			: collection.deleteMany(compileScalarEqualityPredicate(where)).runPromise,
});

const buildConfig = <T extends BenchSchemaConfig>(schemaConfig: T) => {
	const dbConfig: Record<string, CollectionConfig> = {};
	for (const [name, config] of Object.entries(schemaConfig)) {
		dbConfig[name] = {
			schema: config.schema,
			indexes: config.indexes,
			relationships: config.relationships ?? {},
		};
	}
	return dbConfig as ConvertToDbConfig<T>;
};

const closeBenchDatabase = async (db: unknown): Promise<void> => {
	const close = (db as { close?: () => Promise<void> }).close;
	if (typeof close === "function") {
		await close();
	}
};

const createCoreDatabase = async <T extends BenchSchemaConfig>(
	schemaConfig: T,
	initialData?: {
		readonly [K in keyof T]?: ReadonlyArray<Record<string, unknown>>;
	},
): Promise<BenchDatabaseHandle<EffectDatabase<ConvertToDbConfig<T>>>> => {
	const db = await Effect.runPromise(
		createCoreEffectDatabase(
			buildConfig(schemaConfig),
			initialData as
				| Record<string, ReadonlyArray<Record<string, unknown>>>
				| undefined,
		),
	);
	return {
		db: db as EffectDatabase<ConvertToDbConfig<T>>,
		close: () => closeBenchDatabase(db),
		collectionMutationAdapter: createCollectionMutationAdapter("typescript"),
	};
};

const createWasmDatabase = async <T extends BenchSchemaConfig>(
	schemaConfig: T,
	initialData?: {
		readonly [K in keyof T]?: ReadonlyArray<Record<string, unknown>>;
	},
): Promise<BenchDatabaseHandle<EffectDatabase<ConvertToDbConfig<T>>>> => {
	const db = await Effect.runPromise(
		createWasmEffectDatabase(
			buildConfig(schemaConfig),
			initialData as
				| Record<string, ReadonlyArray<Record<string, unknown>>>
				| undefined,
		),
	);
	const diagnostics = (
		db as unknown as {
			__proseqlMaterializationDiagnostics?: () => ReturnType<
				NonNullable<BenchDatabaseHandle<unknown>["projectionMaterialization"]>
			>;
		}
	).__proseqlMaterializationDiagnostics;
	return {
		db: db as EffectDatabase<ConvertToDbConfig<T>>,
		close: () => closeBenchDatabase(db),
		projectionMaterialization: diagnostics,
		collectionMutationAdapter: createCollectionMutationAdapter("wasm"),
	};
};

export const typescriptBenchEngine: BenchEngine = {
	id: "typescript",
	label: "TypeScript @proseql/core",
	createDatabase: createCoreDatabase,
};

export const wasmBenchEngine: BenchEngine = {
	id: "wasm",
	label: "Rust/WASM @proseql/effect",
	createDatabase: createWasmDatabase,
};

export const defaultBenchEngines = [
	typescriptBenchEngine,
	wasmBenchEngine,
] as const satisfies ReadonlyArray<BenchEngine>;

export const selectBenchEngines = (
	engines: ReadonlyArray<EngineId> | undefined,
): ReadonlyArray<BenchEngine> =>
	engines === undefined
		? defaultBenchEngines
		: engines.flatMap((id) =>
				defaultBenchEngines.filter((engine) => engine.id === id),
			);

export const compileEqualityCriterionForTests = compileScalarEqualityPredicate;
