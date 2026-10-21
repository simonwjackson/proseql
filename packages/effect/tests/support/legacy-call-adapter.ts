import { saveData } from "../../../engine/src/host/persistence-effect.js";
import { makeInMemoryStorageLayer } from "../../../engine/src/host/in-memory-adapter-layer.js";
import { jsonCodec, makeSerializerLayer } from "@proseql/core";
/** Call-shape translation only. Every database operation runs through @proseql/effect and Rust/WASM. */
import {
	createEffectDatabase,
	type CollectionConfig,
	type DatabaseConfig,
	type EffectCollection,
	type GenerateDatabase,
	type LegacyDatabaseConfig,
	type CursorConfig,
	type QueryConfig,
} from "@proseql/effect";
import { Effect, Option, Schema, Stream, Layer } from "effect";

type Row = { readonly id: string; readonly [key: string]: unknown };
type Rows = ReadonlyMap<string, Row>;
type Handle = {
	readonly initial: Rows;
	database?: GenerateDatabase<FixtureConfig>;
	name?: string;
};
type Handles = Record<string, Handle>;
type FixtureConfig = Record<
	string,
	Omit<CollectionConfig, "schema"> & {
		readonly schema: Schema.Codec<Row, unknown>;
	}
>;

type RefOperations = {
	readonly make: (initial: Rows) => Effect.Effect<Handle>;
	readonly get: (handle: Handle) => Effect.Effect<Rows, unknown>;
	set: (handle: Handle, rows: Rows) => Effect.Effect<void, unknown>;
	update: (
		handle: Handle,
		update: (rows: Rows) => Rows,
	) => Effect.Effect<void, unknown>;
};
export const TestRef: RefOperations = {
	make: (initial: Rows): Effect.Effect<Handle> => Effect.succeed({ initial }),
	get: (handle: Handle): Effect.Effect<Rows, unknown> =>
		handle.database && handle.name
			? Stream.runCollect(
					handle.database[handle.name].query({}) as Stream.Stream<
						Record<string, unknown>,
						unknown
					>,
				).pipe(
					Effect.map(
						(rows) => new Map(rows.map((row) => [String(row.id), row as Row])),
					),
				)
			: Effect.succeed(handle.initial),
	set: (handle, rows) => replaceRows(handle, rows),
	update: (handle, update) =>
		Effect.gen(function* () {
			const rows = yield* TestRef.get(handle);
			yield* TestRef.set(handle, update(rows));
		}),
};

const fixtureSchema = (rows: ReadonlyArray<unknown>) =>
	Schema.Struct(
		Object.fromEntries(
			[
				...new Set(
					rows.flatMap((row) =>
						typeof row === "object" && row !== null
							? Object.keys(row)
							: ["value"],
					),
				),
			].map((key) => [key, Schema.optional(Schema.Unknown)]),
		),
	);

const replaceRows = (handle: Handle, rows: Rows) =>
	Effect.gen(function* () {
		if (!handle.database) {
			yield* setup("rows", fixtureSchema([...rows.values()]), {}, handle, {});
		}
		yield* handle.database!.$transaction((ctx) =>
			Effect.gen(function* () {
				yield* ctx[handle.name!].deleteMany(() => true);
				yield* ctx[handle.name!].createMany([...rows.values()]);
			}),
		);
	});

const collection = (handle: Handle) =>
	handle.database![handle.name!] as EffectCollection<Row>;

const setup = (
	name: string,
	schema: Schema.Top,
	relationships: CollectionConfig["relationships"],
	handle: Handle,
	handles: Handles,
	config?: LegacyDatabaseConfig,
	unique?: CollectionConfig["uniqueFields"],
	softDelete?: boolean,
) =>
	Effect.gen(function* () {
		if (handle.database) return collection(handle);
		const all = { ...handles, [name]: handle };
		const configs = Object.fromEntries(
			Object.keys(all).map((key) => [
				key,
				{
					schema: fixtureSchema([...all[key].initial.values()]),
					relationships: {},
					...(config?.[key] ?? {}),
					...(key === name
						? {
								schema,
								relationships,
								uniqueFields: unique,
								...(softDelete ? { softDelete: true } : {}),
							}
						: {}),
				},
			]),
		) as FixtureConfig;
		const db = yield* createEffectDatabase(
			configs,
			Object.fromEntries(
				Object.entries(all).map(([key, value]) => [
					key,
					[...value.initial.values()],
				]),
			),
		);
		for (const [key, value] of Object.entries(all)) {
			value.database = db;
			value.name = key;
			if (handles[key]) {
				handles[key].database = db;
				handles[key].name = key;
			}
		}
		return collection(handle);
	});

const ordinary =
	(method: keyof EffectCollection<Row>) =>
	(
		name: string,
		schema: Schema.Top,
		relationships: CollectionConfig["relationships"],
		handle: Handle,
		handles: Handles,
		_indexes?: unknown,
		_hooks?: unknown,
		unique?: CollectionConfig["uniqueFields"],
	) =>
	(...args: ReadonlyArray<unknown>) =>
		Effect.gen(function* () {
			const target = yield* setup(
				name,
				schema,
				relationships,
				handle,
				handles,
				undefined,
				unique,
			);
			return yield* (
				target[method] as (
					...args: ReadonlyArray<unknown>
				) => Effect.Effect<unknown, unknown>
			)(...args);
		});
export const create = ordinary("create");
export const createMany = ordinary("createMany");
export const update = ordinary("update");
export const updateMany = ordinary("updateMany");
export const upsert = ordinary("upsert");
export const upsertMany = ordinary("upsertMany");

const deletion =
	(method: "delete" | "deleteMany") =>
	(
		name: string,
		relationships: Record<string, CollectionConfig["relationships"]>,
		handle: Handle,
		handles: Handles,
		softDelete = false,
	) =>
	(...args: ReadonlyArray<unknown>) =>
		Effect.gen(function* () {
			const config = Object.fromEntries(
				Object.entries(relationships).map(([key, relationships]) => [
					key,
					{
						schema: fixtureSchema([...(handles[key]?.initial.values() ?? [])]),
						relationships,
					},
				]),
			);
			const target = yield* setup(
				name,
				fixtureSchema([...handle.initial.values()]),
				relationships[name] ?? {},
				handle,
				handles,
				config,
				undefined,
				softDelete,
			);
			return yield* (
				target[method] as (
					...args: ReadonlyArray<unknown>
				) => Effect.Effect<unknown, unknown>
			)(...args);
		});
export const del = deletion("delete");
export const deleteMany = deletion("deleteMany");

const relationshipOperation =
	(method: "createWithRelationships" | "updateWithRelationships") =>
	(
		name: string,
		schema: Schema.Top,
		relationships: CollectionConfig["relationships"],
		handle: Handle,
		handles: Handles,
		config: LegacyDatabaseConfig,
	) =>
	(...args: ReadonlyArray<unknown>) =>
		Effect.gen(function* () {
			const target = yield* setup(
				name,
				schema,
				relationships,
				handle,
				handles,
				config,
			);
			return yield* (
				target[method] as (
					...args: ReadonlyArray<unknown>
				) => Effect.Effect<unknown, unknown>
			)(...args);
		});
export const createWithRelationships = relationshipOperation(
	"createWithRelationships",
);
export const updateWithRelationships = relationshipOperation(
	"updateWithRelationships",
);
const relationshipDeletion =
	(method: "deleteWithRelationships" | "deleteManyWithRelationships") =>
	(
		name: string,
		relationships: CollectionConfig["relationships"],
		handle: Handle,
		handles: Handles,
		config: LegacyDatabaseConfig,
	) =>
	(...args: ReadonlyArray<unknown>) =>
		Effect.gen(function* () {
			const target = yield* setup(
				name,
				config[name].schema,
				relationships,
				handle,
				handles,
				config,
			);
			return yield* (
				target[method] as (
					...args: ReadonlyArray<unknown>
				) => Effect.Effect<unknown, unknown>
			)(...args);
		});
export const deleteWithRelationships = relationshipDeletion(
	"deleteWithRelationships",
);
export const deleteManyWithRelationships = relationshipDeletion(
	"deleteManyWithRelationships",
);

const queryRows = <T>(
	rows: ReadonlyArray<T>,
	query: Record<string, unknown>,
	computed?: CollectionConfig["computed"],
) =>
	Effect.gen(function* () {
		const input = rows.map((value, index) =>
			typeof value === "object" && value !== null
				? {
						...value,
						id:
							typeof (value as { readonly id?: unknown }).id === "string"
								? (value as { readonly id?: unknown }).id
								: typeof (value as { readonly id?: unknown }).id === "number"
									? String((value as { readonly id?: unknown }).id)
									: `test:${index}`,
					}
				: { id: `test:${index}`, value },
		);
		const db = yield* createEffectDatabase(
			{ rows: { schema: fixtureSchema(input), relationships: {}, computed } },
			{ rows: input },
		);
		const originals = new Map(
			input.map((value, index) => [value.id, rows[index]]),
		);
		const results = yield* Stream.runCollect(
			db.rows.query(
				query as QueryConfig<Row, Record<string, never>, Record<string, never>>,
			) as Stream.Stream<Record<string, unknown>, unknown>,
		);
		return results.map((row) => {
			const original = originals.get(typeof row.id === "string" ? row.id : "");
			if (
				original !== undefined &&
				(typeof original !== "object" || original === null)
			)
				return row.value;
			if (typeof row.id === "string" && row.id.startsWith("test:")) {
				const { id: _, ...value } = row;
				return value;
			}
			if (
				typeof original === "object" &&
				original !== null &&
				typeof (original as { readonly id?: unknown }).id === "number"
			)
				return { ...row, id: (original as { readonly id?: unknown }).id };
			return row;
		}) as ReadonlyArray<T>;
	});
const pipeline =
	(query: Record<string, unknown>) =>
	<T, E, R>(stream: Stream.Stream<T, E, R>) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const input = yield* Stream.runCollect(stream);
				return Stream.fromIterable(yield* queryRows(input, query));
			}),
		);
export const applyFilter = <T>(where: unknown) => pipeline({ where });
export const applySort = <T>(sort: unknown) => pipeline({ sort });
export const applySelect = <T>(select: unknown) => pipeline({ select });
export const applyPagination = (offset?: number, limit?: number) =>
	pipeline({ offset, limit });
export const filterData = <T>(data: ReadonlyArray<T>, where: unknown) =>
	Effect.runPromise(queryRows(data, { where }));
export const sortData = <T>(data: ReadonlyArray<T>, sort: unknown) =>
	Effect.runPromise(queryRows(data, { sort }));
export const applyObjectSelection = <T>(data: T, select: unknown) =>
	Effect.runPromise(queryRows([data], { select })).then((rows) => rows[0]);
export const applySelectionSafe = <T>(
	data: T | null | undefined,
	select: unknown,
) =>
	data === null || data === undefined
		? Promise.resolve(data)
		: applyObjectSelection(data, select);
export const applySelectionToArray = <T>(
	data: ReadonlyArray<T>,
	select: unknown,
) => Effect.runPromise(queryRows(data, { select }));
export const createFieldSelector =
	(select: unknown) =>
	<T>(data: T) =>
		applyObjectSelection(data, select);
export const applySelectToArray = applySelectionToArray;
export const resolveComputedFields = <T>(
	data: T,
	computed: CollectionConfig["computed"],
) => Effect.runPromise(queryRows([data], {}, computed)).then((rows) => rows[0]);
export const resolveComputedStream =
	<T>(computed: CollectionConfig["computed"]) =>
	<E, R>(stream: Stream.Stream<T, E, R>) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const rows = yield* Stream.runCollect(stream);
				return Stream.fromIterable(yield* queryRows(rows, {}, computed));
			}),
		);
export const resolveComputedStreamWithLazySkip =
	<T>(computed: CollectionConfig["computed"], select: unknown) =>
	<E, R>(stream: Stream.Stream<T, E, R>) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const rows = yield* Stream.runCollect(stream);
				return Stream.fromIterable(yield* queryRows(rows, {}, computed));
			}),
		);
export const applyCursor =
	(cursor: unknown, sort?: unknown) =>
	<T, E, R>(stream: Stream.Stream<T, E, R>) =>
		Effect.gen(function* () {
			const rows = yield* Stream.runCollect(stream);
			const db = yield* createEffectDatabase(
				{ rows: { schema: fixtureSchema(rows), relationships: {} } },
				{ rows: rows as ReadonlyArray<Row> },
			);
			return yield* db.rows.query({
				cursor: cursor as CursorConfig,
				sort: sort as Record<string, "asc" | "desc">,
			});
		});
export const evaluateQuery = (handle: Handle, query: Record<string, unknown>) =>
	Effect.gen(function* () {
		const rows = yield* TestRef.get(handle);
		return yield* queryRows([...rows.values()], query);
	});
export const createCollectionState = <T extends Row>(
	rows: ReadonlyArray<T> = [],
	schema = fixtureSchema(rows),
	name = "users",
) =>
	Effect.gen(function* () {
		const handle = yield* TestRef.make(
			new Map(rows.map((row) => [String(row.id), row as Row])),
		);
		yield* setup(name, schema, {}, handle, {});
		return handle;
	});
export const getEntity = (handle: Handle, id: string) =>
	collection(handle)
		.findById(id)
		.pipe(
			Effect.map(Option.some),
			Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
		);
export const getEntityOrFail = (handle: Handle, id: string) =>
	collection(handle).findById(id);
export const getAllEntities = (handle: Handle) =>
	Stream.runCollect(
		collection(handle).query({}) as Stream.Stream<
			Record<string, unknown>,
			unknown
		>,
	);
export const setEntity = (handle: Handle, entity: Row) =>
	collection(handle)
		.upsert({
			where: { id: entity.id },
			create: entity,
			update: Object.fromEntries(
				Object.entries(entity).filter(
					([key]) => key !== "id" && key !== "createdAt",
				),
			),
		} as never)
		.pipe(Effect.asVoid);
export const removeEntity = (handle: Handle, id: string) =>
	collection(handle)
		.delete(id)
		.pipe(
			Effect.as(true),
			Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
		);
export const updateEntity = (
	handle: Handle,
	id: string,
	update: (entity: Row) => Row,
) =>
	Effect.gen(function* () {
		const entity = yield* collection(handle).findById(id);
		return yield* collection(handle).update(
			id,
			Object.fromEntries(
				Object.entries(update(entity)).filter(
					([key]) => key !== "id" && key !== "createdAt",
				),
			),
		);
	});

export const createChangePubSub = () => Effect.succeed({});
// Publishing an old test event has no effect: Rust emits events from the actual mutation.
export const TestPubSub = {
	publish: (_bus: unknown, _event: unknown) => Effect.succeed(true),
};
export const watch = (
	_bus: unknown,
	handle: Handle,
	name: string,
	config?: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		yield* setup(
			name,
			fixtureSchema([...handle.initial.values()]),
			{},
			handle,
			{},
		);
		return yield* collection(handle).watch(config);
	});
export const watchById = (
	_bus: unknown,
	handle: Handle,
	name: string,
	id: string,
) =>
	Effect.gen(function* () {
		yield* setup(
			name,
			fixtureSchema([...handle.initial.values()]),
			{},
			handle,
			{},
		);
		return yield* collection(handle).watchById(id);
	});
export const applyPopulate =
	(
		populate: unknown,
		handles: Handles,
		config: LegacyDatabaseConfig,
		name: string,
	) =>
	<T extends Record<string, unknown>, E, R>(stream: Stream.Stream<T, E, R>) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const input = yield* Stream.runCollect(stream);
				const data = Object.fromEntries(
					Object.entries(handles).map(([key, handle]) => [
						key,
						[...handle.initial.values()],
					]),
				);
				const schemas = Object.fromEntries(
					Object.entries(config).map(([key, value]) => [
						key,
						{
							...value,
							schema: fixtureSchema(key === name ? input : (data[key] ?? [])),
						},
					]),
				);
				const db = yield* createEffectDatabase(schemas, {
					...data,
					[name]: input,
				});
				return db[name].query({ populate } as never);
			}),
		);
export const createArrayFieldSelector =
	(select: unknown) =>
	<T>(data: ReadonlyArray<T>) =>
		applySelectionToArray(data, select);

export const validateEntity = (schema: Schema.Top, input: unknown) =>
	Effect.gen(function* () {
		const db = yield* createEffectDatabase({
			rows: { schema: schema as CollectionConfig["schema"], relationships: {} },
		});
		return yield* db.rows.create(input as never);
	});

export const encodeEntity = (schema: Schema.Top, input: Row) =>
	Effect.gen(function* () {
		const store = new Map<string, string>();
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([jsonCodec()]),
		);
		yield* saveData(
			"/fixture.json",
			schema as Schema.Codec<Row, unknown>,
			new Map([[input.id, input]]),
		).pipe(Effect.provide(layer));
		return (JSON.parse(store.get("/fixture.json")!) as Record<string, unknown>)[
			input.id
		];
	});
