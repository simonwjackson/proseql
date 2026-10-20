import { Effect, Schema } from "effect";
import { SourceConfigError } from "../errors/source-errors.js";
import { proseCodec } from "../serializers/codecs/prose.js";
import { makeSerializerLayer } from "../serializers/format-codec.js";
import { SerializerRegistry } from "../serializers/serializer-service.js";
import { joinPath, normalizePath } from "../utils/path.js";
import type { HasId } from "./derived-id.js";
import { makeInMemoryStorageLayer } from "./in-memory-adapter-layer.js";
import { loadData, saveData } from "./persistence-effect.js";
import {
	matchesDocumentSourcePattern,
	type NormalizedSourceConfig,
	type PartitionedSourceConfig,
	type PartitionTimeBucket,
} from "./source-config.js";
import { StorageAdapter } from "./storage-service.js";

export interface LoadedPartitions {
	readonly files: ReadonlyMap<string, ReadonlyMap<string, HasId>>;
	readonly contents: ReadonlyMap<string, string>;
	readonly records: ReadonlyMap<string, HasId>;
}

const sourceError = (
	source: PartitionedSourceConfig,
	path: string,
	message: string,
) =>
	new SourceConfigError({
		sourceId: source.id,
		collection: source.collection,
		path,
		message,
	});

const UTC_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

/**
 * The bucket key of a UTC timestamp `YYYY-MM-DDTHH:MM:SS(.f+)?Z`, or
 * `undefined` when the value does not match or names an invalid date or time.
 * Matches the native `time_bucket_key`.
 */
export const timeBucketKey = (
	value: string,
	bucket: PartitionTimeBucket,
): string | undefined => {
	const match = UTC_TIMESTAMP.exec(value);
	if (match === null) return undefined;
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map(Number) as [number, number, number, number, number, number];
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
		month - 1
	];
	if (
		days === undefined ||
		day < 1 ||
		day > days ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	)
		return undefined;
	return value.slice(0, bucket === "year" ? 4 : bucket === "month" ? 7 : 10);
};

export const partitionPath = (
	source: PartitionedSourceConfig,
	record: HasId,
): string => {
	const value = (record as Record<string, unknown>)[source.partitionBy.field];
	if (typeof value !== "string")
		throw sourceError(
			source,
			source.root,
			`Partition field '${source.partitionBy.field}' must be a string`,
		);
	let key = value;
	if (source.partitionBy.kind === "timeBucket") {
		const bucketKey = timeBucketKey(value, source.partitionBy.bucket);
		if (bucketKey === undefined)
			throw sourceError(
				source,
				source.root,
				`Partition field '${source.partitionBy.field}' must be a UTC timestamp YYYY-MM-DDTHH:MM:SS(.fff)Z`,
			);
		key = bucketKey;
	}
	if (source.partitionBy.kind === "prefix") {
		const position = value.indexOf(source.partitionBy.delimiter);
		if (position < 0)
			throw sourceError(
				source,
				source.root,
				`Partition field '${source.partitionBy.field}' has no delimiter '${source.partitionBy.delimiter}'`,
			);
		key = value.slice(0, position);
	}
	if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(key))
		throw sourceError(source, source.root, `Unsafe partition key '${key}'`);
	return joinPath(source.root, `${key}.${source.format}`);
};

export const matchesPartitionPath = (
	source: PartitionedSourceConfig,
	path: string,
): boolean => {
	const prefix = `${source.root.replace(/\/$/, "")}/`;
	const normalized = normalizePath(path);
	const currentRoot = source.root === "." && !normalized.startsWith("/");
	if (!currentRoot && !normalized.startsWith(prefix)) return false;
	const relative = currentRoot ? normalized : normalized.slice(prefix.length);
	return !relative.includes("/") && relative.endsWith(`.${source.format}`);
};

export const assertPartitionOwnership = (
	config: NormalizedSourceConfig,
	source: PartitionedSourceConfig,
	path: string,
): void => {
	const contains = (root: string) =>
		root === "."
			? !normalizePath(path).startsWith("/") &&
				!normalizePath(path).startsWith("../")
			: normalizePath(path).startsWith(`${root.replace(/\/$/, "")}/`);
	for (const other of config.sources) {
		if (other.id === source.id) continue;
		const overlap =
			other.kind === "partitioned"
				? matchesPartitionPath(other, path)
				: other.kind === "documents"
					? contains(other.root) && matchesDocumentSourcePattern(other, path)
					: other.roots.some(
							(root) =>
								contains(root.root) && matchesDocumentSourcePattern(root, path),
						);
		if (overlap)
			throw sourceError(source, path, "Partition path overlaps another source");
	}
};

const withCodec = <A, E, R>(
	source: PartitionedSourceConfig,
	effect: Effect.Effect<A, E, R | SerializerRegistry>,
) =>
	source.prose === undefined
		? effect
		: Effect.provide(effect, makeSerializerLayer([proseCodec(source.prose)]));

const schemaFor = (
	config: NormalizedSourceConfig,
	source: PartitionedSourceConfig,
) =>
	config.collectionConfigs[source.collection].schema as Schema.Codec<
		HasId,
		unknown,
		never,
		never
	>;
const loadOptions = (
	config: NormalizedSourceConfig,
	source: PartitionedSourceConfig,
) => {
	const collection = config.collectionConfigs[source.collection];
	return {
		format: source.format,
		validation: "strict" as const,
		collectionName: source.collection,
		...(collection.id === undefined ? {} : { derivedId: collection.id }),
		...(collection.version === undefined
			? {}
			: { version: collection.version }),
		...(collection.migrations === undefined
			? {}
			: { migrations: collection.migrations }),
	};
};

export const loadPartitionedSource = (
	config: NormalizedSourceConfig,
	source: PartitionedSourceConfig,
) =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const files = new Map<string, ReadonlyMap<string, HasId>>();
		const contents = new Map<string, string>();
		const records = new Map<string, HasId>();
		if (!(yield* storage.exists(source.root)))
			return { files, contents, records };
		for (const path of [
			...(yield* storage.listDirectory(source.root)),
		].sort()) {
			if (!matchesPartitionPath(source, path)) continue;
			yield* Effect.try({
				try: () => assertPartitionOwnership(config, source, path),
				catch: (cause) => sourceError(source, path, String(cause)),
			});
			const raw = yield* storage.read(path);
			const decoded = yield* withCodec(
				source,
				Effect.gen(function* () {
					const serializer = yield* SerializerRegistry;
					return yield* serializer.deserialize(raw, source.format);
				}),
			);
			if (Array.isArray(decoded)) {
				const ids = new Set<string>();
				for (const record of decoded as ReadonlyArray<unknown>) {
					const id: unknown =
						typeof record === "object" && record !== null
							? (record as Record<string, unknown>).id
							: undefined;
					if (typeof id !== "string" || ids.has(id))
						return yield* Effect.fail(
							sourceError(
								source,
								path,
								"Partition records need unique string IDs",
							),
						);
					ids.add(id);
				}
			}
			const loaded = yield* withCodec(
				source,
				loadData(path, schemaFor(config, source), loadOptions(config, source)),
			);
			for (const [id, record] of loaded) {
				if (records.has(id))
					return yield* Effect.fail(
						sourceError(source, path, `Duplicate partition record '${id}'`),
					);
				const routed = yield* Effect.try({
					try: () => partitionPath(source, record),
					catch: (cause) => sourceError(source, path, String(cause)),
				});
				if (routed !== path)
					return yield* Effect.fail(
						sourceError(
							source,
							path,
							`Record '${id}' is in the wrong partition`,
						),
					);
				records.set(id, record);
			}
			files.set(path, loaded);
			contents.set(path, raw);
		}
		return { files, contents, records };
	});

const sameRecords = (
	left: ReadonlyMap<string, HasId> | undefined,
	right: ReadonlyMap<string, HasId>,
	equivalent: (left: HasId, right: HasId) => boolean,
) =>
	left !== undefined &&
	left.size === right.size &&
	[...right].every(([id, record]) => {
		const previous = left.get(id);
		return previous !== undefined && equivalent(previous, record);
	});

export const savePartitionedSource = (
	config: NormalizedSourceConfig,
	source: PartitionedSourceConfig,
	previous: LoadedPartitions,
	records: ReadonlyMap<string, HasId>,
) =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const files = new Map<string, Map<string, HasId>>(
			[...previous.files.keys()].map((path) => [path, new Map()]),
		);
		for (const [id, record] of records) {
			const path = yield* Effect.try({
				try: () => partitionPath(source, record),
				catch: (cause) => sourceError(source, source.root, String(cause)),
			});
			const group = files.get(path) ?? new Map<string, HasId>();
			group.set(id, record);
			files.set(path, group);
		}
		const writes = new Map<string, string>();
		const collection = config.collectionConfigs[source.collection];
		const equivalent = Schema.toEquivalence(schemaFor(config, source));
		// Encode every changed file before any disk writes. Reuse the real in-memory adapter.
		for (const [path, group] of [...files].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			if (sameRecords(previous.files.get(path), group, equivalent)) continue;
			const encoded = new Map<string, string>();
			yield* withCodec(
				source,
				saveData(path, schemaFor(config, source), group, {
					format: source.format,
					...(collection.id === undefined ? {} : { derivedId: collection.id }),
					...(collection.version === undefined
						? {}
						: { version: collection.version }),
				}),
			).pipe(Effect.provide(makeInMemoryStorageLayer(encoded)));
			const content = encoded.get(path);
			if (content === undefined)
				return yield* Effect.fail(
					sourceError(source, path, "Partition encoder produced no file"),
				);
			writes.set(path, content);
		}
		for (const path of writes.keys()) {
			yield* Effect.try({
				try: () => assertPartitionOwnership(config, source, path),
				catch: (cause) => sourceError(source, path, String(cause)),
			});
			const current = (yield* storage.exists(path))
				? yield* storage.read(path)
				: undefined;
			if (current !== previous.contents.get(path))
				return yield* Effect.fail(
					sourceError(
						source,
						path,
						"Partition file changed since load; reopen before retrying",
					),
				);
		}
		const contents = new Map(previous.contents);
		for (const [path, content] of writes) {
			yield* storage.ensureDir(path);
			yield* storage.write(path, content);
			contents.set(path, content);
		}
		return { files, contents, records } satisfies LoadedPartitions;
	});
