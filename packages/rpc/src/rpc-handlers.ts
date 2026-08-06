import {
	createEffectDatabase,
	type DatabaseConfig,
	type DatasetFor,
	type GenerateDatabase,
	getCollectionConfigs,
} from "@proseql/effect";
import { Effect, Stream } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import type { InvalidRpcRequestError, RpcErrorSchema } from "./rpc-errors.js";
import { makeRpcGroup, type RpcGroupFromConfig } from "./rpc-group.js";
import type {
	AggregatePayload,
	CreateManyPayload,
	CreatePayload,
	DeleteManyPayload,
	DeletePayload,
	QueryPayload,
	UpdateManyPayload,
	UpdatePayload,
	UpsertManyPayload,
	UpsertPayload,
} from "./rpc-schemas.js";

type RpcFailure = typeof RpcErrorSchema.Type;
type RpcRecord = Readonly<Record<string, unknown>>;
type RpcRows = ReadonlyArray<RpcRecord>;

type DynamicCollection = {
	readonly findById: (id: string) => Effect.Effect<RpcRecord, RpcFailure>;
	readonly query: (
		config: QueryPayload,
	) =>
		| Stream.Stream<RpcRecord, RpcFailure>
		| Effect.Effect<unknown, RpcFailure>;
	readonly create: (data: RpcRecord) => Effect.Effect<RpcRecord, RpcFailure>;
	readonly createMany: (
		data: RpcRows,
		options?: CreateManyPayload["options"],
	) => Effect.Effect<unknown, RpcFailure>;
	readonly update: (
		id: string,
		updates: RpcRecord,
	) => Effect.Effect<RpcRecord, RpcFailure>;
	readonly updateMany: (
		where: RpcRecord,
		updates: RpcRecord,
	) => Effect.Effect<unknown, RpcFailure>;
	readonly delete: (id: string) => Effect.Effect<RpcRecord, RpcFailure>;
	readonly deleteMany: (
		where: RpcRecord,
		options?: DeleteManyPayload["options"],
	) => Effect.Effect<unknown, RpcFailure>;
	readonly aggregate: (
		config: AggregatePayload,
	) => Effect.Effect<unknown, RpcFailure>;
	readonly upsert: (input: {
		readonly where: RpcRecord;
		readonly create: RpcRecord;
		readonly update: RpcRecord;
	}) => Effect.Effect<unknown, RpcFailure>;
	readonly upsertMany: (
		input: ReadonlyArray<{
			readonly where: RpcRecord;
			readonly create: RpcRecord;
			readonly update: RpcRecord;
		}>,
	) => Effect.Effect<unknown, RpcFailure>;
};

const invalid = (
	operation: string,
	message: string,
	path?: string,
): InvalidRpcRequestError => ({
	_tag: "InvalidRpcRequestError",
	operation,
	message,
	...(path ? { path } : {}),
});

const isRecord = (value: unknown): value is RpcRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): boolean => {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
};

const fieldOperators = new Set([
	"$eq",
	"$ne",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
	"$in",
	"$nin",
	"$startsWith",
	"$endsWith",
	"$contains",
	"$search",
	"$all",
	"$size",
	"$some",
	"$every",
	"$none",
]);

const findWhereError = (
	where: RpcRecord,
	operation: string,
	path = "where",
): InvalidRpcRequestError | undefined => {
	for (const [key, value] of Object.entries(where)) {
		const currentPath = `${path}.${key}`;
		if (key === "$or" || key === "$and") {
			if (!Array.isArray(value) || !value.every(isRecord)) {
				return invalid(
					operation,
					`${key} must be an array of filter objects`,
					currentPath,
				);
			}
			for (const item of value) {
				const error = findWhereError(item, operation, currentPath);
				if (error) return error;
			}
			continue;
		}
		if (key === "$not") {
			if (!isRecord(value)) {
				return invalid(operation, "$not must be a filter object", currentPath);
			}
			const error = findWhereError(value, operation, currentPath);
			if (error) return error;
			continue;
		}
		if (key === "$search") {
			if (
				!isRecord(value) ||
				typeof value.query !== "string" ||
				(value.fields !== undefined &&
					(!Array.isArray(value.fields) ||
						!value.fields.every((field) => typeof field === "string")))
			) {
				return invalid(
					operation,
					"$search requires query and optional string fields",
					currentPath,
				);
			}
			continue;
		}
		if (key.startsWith("$")) {
			return invalid(
				operation,
				`unsupported filter operator ${key}`,
				currentPath,
			);
		}
		if (!isRecord(value)) continue;
		const operatorKeys = Object.keys(value).filter((candidate) =>
			candidate.startsWith("$"),
		);
		if (operatorKeys.length === 0) {
			const error = findWhereError(value, operation, currentPath);
			if (error) return error;
			continue;
		}
		for (const operator of operatorKeys) {
			if (!fieldOperators.has(operator)) {
				return invalid(
					operation,
					`unsupported filter operator ${operator}`,
					`${currentPath}.${operator}`,
				);
			}
		}
	}
	return undefined;
};

const validateWhere = (
	where: RpcRecord | undefined,
	operation: string,
): Effect.Effect<void, InvalidRpcRequestError> => {
	if (where === undefined) return Effect.void;
	if (!isJsonValue(where)) {
		return Effect.fail(
			invalid(operation, "where must contain only JSON values", "where"),
		);
	}
	const error = findWhereError(where, operation);
	return error ? Effect.fail(error) : Effect.void;
};

const validatePayload = (
	operation: string,
	payload: unknown,
): Effect.Effect<void, InvalidRpcRequestError> =>
	isJsonValue(payload)
		? Effect.void
		: Effect.fail(invalid(operation, "payload must contain only JSON values"));

const validateQuery = (
	operation: string,
	payload: QueryPayload,
	stream: boolean,
): Effect.Effect<void, InvalidRpcRequestError> =>
	Effect.gen(function* () {
		yield* validatePayload(operation, payload);
		yield* validateWhere(payload.where, operation);
		if (payload.cursor !== undefined && stream) {
			return yield* Effect.fail(
				invalid(operation, "cursor queries cannot be streamed", "cursor"),
			);
		}
		if (
			payload.cursor !== undefined &&
			(payload.limit !== undefined || payload.offset !== undefined)
		) {
			return yield* Effect.fail(
				invalid(
					operation,
					"cursor cannot be combined with limit or offset",
					"cursor",
				),
			);
		}
		if (
			(payload.limit !== undefined &&
				(!Number.isInteger(payload.limit) || payload.limit < 0)) ||
			(payload.offset !== undefined &&
				(!Number.isInteger(payload.offset) || payload.offset < 0))
		) {
			return yield* Effect.fail(
				invalid(operation, "limit and offset must be non-negative integers"),
			);
		}
	});

const dynamicCollections = <Config extends DatabaseConfig>(
	db: GenerateDatabase<Config>,
): Readonly<Record<string, DynamicCollection>> =>
	db as unknown as Readonly<Record<string, DynamicCollection>>;

const makeHandlerFunctions = <Config extends DatabaseConfig>(
	config: Config,
	db: GenerateDatabase<Config>,
): Readonly<Record<string, (payload: never) => unknown>> => {
	const handlers: Record<string, (payload: never) => unknown> = {};
	const collections = dynamicCollections(db);
	for (const collectionName of Object.keys(getCollectionConfigs(config))) {
		const collection = collections[collectionName];
		if (collection === undefined) {
			throw new Error(
				`Database is missing configured collection ${collectionName}`,
			);
		}
		const tag = (operation: string) => `${collectionName}.${operation}`;
		handlers[tag("findById")] = (({ id }: DeletePayload) =>
			collection.findById(id)) as never;
		handlers[tag("query")] = ((payload: QueryPayload) =>
			Effect.flatMap(validateQuery(tag("query"), payload, false), () => {
				const result = collection.query(payload);
				return payload.cursor === undefined
					? Stream.runCollect(result as Stream.Stream<RpcRecord, RpcFailure>)
					: (result as Effect.Effect<unknown, RpcFailure>);
			})) as never;
		handlers[tag("queryStream")] = ((payload: QueryPayload) =>
			Stream.unwrap(
				Effect.map(
					validateQuery(tag("queryStream"), payload, true),
					() =>
						collection.query(payload) as Stream.Stream<RpcRecord, RpcFailure>,
				),
			)) as never;
		handlers[tag("create")] = (({ data }: CreatePayload) =>
			collection.create(data)) as never;
		handlers[tag("update")] = (({ id, updates }: UpdatePayload) =>
			collection.update(id, updates)) as never;
		handlers[tag("delete")] = (({ id }: DeletePayload) =>
			collection.delete(id)) as never;
		handlers[tag("aggregate")] = ((payload: AggregatePayload) =>
			Effect.andThen(
				validateWhere(payload.where, tag("aggregate")),
				collection.aggregate(payload),
			)) as never;
		handlers[tag("createMany")] = (({ data, options }: CreateManyPayload) =>
			collection.createMany(data, options)) as never;
		handlers[tag("updateMany")] = (({ where, updates }: UpdateManyPayload) =>
			Effect.andThen(
				validateWhere(where, tag("updateMany")),
				collection.updateMany(where, updates),
			)) as never;
		handlers[tag("deleteMany")] = (({ where, options }: DeleteManyPayload) =>
			Effect.andThen(
				validateWhere(where, tag("deleteMany")),
				collection.deleteMany(where, options),
			)) as never;
		handlers[tag("upsert")] = ((payload: UpsertPayload) =>
			Effect.andThen(
				validateWhere(payload.where, tag("upsert")),
				collection.upsert(payload),
			)) as never;
		handlers[tag("upsertMany")] = (({ data }: UpsertManyPayload) =>
			Effect.andThen(
				Effect.forEach(
					data,
					(item) => validateWhere(item.where, tag("upsertMany")),
					{
						discard: true,
					},
				),
				collection.upsertMany(data),
			)) as never;
	}
	return handlers;
};

type HandlerMap<Config extends DatabaseConfig> = RpcGroup.HandlersFrom<
	RpcGroupFromConfig<Config> extends RpcGroup.RpcGroup<infer Rpcs>
		? Rpcs
		: never
>;

export const makeRpcHandlersFromDatabase = <Config extends DatabaseConfig>(
	config: Config,
	db: GenerateDatabase<Config>,
) => {
	const group = makeRpcGroup(config);
	const handlers = makeHandlerFunctions(
		config,
		db,
	) as unknown as HandlerMap<Config>;
	return group.toLayer(handlers);
};

export const makeRpcHandlers = <Config extends DatabaseConfig>(
	config: Config,
	initialData?: Partial<DatasetFor<Config>>,
) => {
	const group = makeRpcGroup(config);
	return group.toLayer(
		Effect.map(
			createEffectDatabase(config, initialData as never),
			(db) => makeHandlerFunctions(config, db) as unknown as HandlerMap<Config>,
		),
	);
};

export type RpcHandlers<Config extends DatabaseConfig> = HandlerMap<Config>;
export type RpcHandlerServices<Config extends DatabaseConfig> = Rpc.ToHandler<
	RpcGroupFromConfig<Config> extends RpcGroup.RpcGroup<infer Rpcs>
		? Rpcs
		: never
>;
