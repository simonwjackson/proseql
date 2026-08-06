import {
	type CollectionConfig,
	type ConfiguredCollections,
	type DatabaseConfig,
	getCollectionConfigs,
} from "@proseql/core";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
	DanglingReferenceErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	InvalidRpcRequestErrorSchema,
	NotFoundErrorSchema,
	OperationErrorSchema,
	PopulationErrorSchema,
	UniqueConstraintErrorSchema,
	ValidationErrorSchema,
} from "./rpc-errors.js";
import {
	AggregatePayloadSchema,
	AggregateRpcResultSchema,
	CollectedQueryResultSchema,
	CreateManyPayloadSchema,
	CreateManyResultSchema,
	CreatePayloadSchema,
	DeleteManyPayloadSchema,
	DeleteManyResultSchema,
	DeletePayloadSchema,
	QueryPayloadSchema,
	QueryRowSchema,
	UpdateManyPayloadSchema,
	UpdateManyResultSchema,
	UpdatePayloadSchema,
	UpsertManyPayloadSchema,
	UpsertManyResultSchema,
	UpsertPayloadSchema,
	UpsertResultSchema,
} from "./rpc-schemas.js";

const QueryErrorSchema = Schema.Union([
	DanglingReferenceErrorSchema,
	PopulationErrorSchema,
	ValidationErrorSchema,
	InvalidRpcRequestErrorSchema,
]);
const CreateErrorSchema = Schema.Union([
	ValidationErrorSchema,
	DuplicateKeyErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
	InvalidRpcRequestErrorSchema,
]);
const UpdateErrorSchema = Schema.Union([
	ValidationErrorSchema,
	NotFoundErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
	InvalidRpcRequestErrorSchema,
]);
const DeleteErrorSchema = Schema.Union([
	NotFoundErrorSchema,
	OperationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
]);
const BulkMutationErrorSchema = Schema.Union([
	ValidationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
	OperationErrorSchema,
	InvalidRpcRequestErrorSchema,
]);
const UpsertErrorSchema = Schema.Union([
	ValidationErrorSchema,
	ForeignKeyErrorSchema,
	HookErrorSchema,
	UniqueConstraintErrorSchema,
	InvalidRpcRequestErrorSchema,
]);

const validCollectionName = /^[A-Za-z][A-Za-z0-9_-]*$/;

const assertCollectionName = (collectionName: string): void => {
	if (!validCollectionName.test(collectionName)) {
		throw new TypeError(
			`Invalid RPC collection name ${JSON.stringify(collectionName)}; expected ${validCollectionName}`,
		);
	}
};

export const makeCollectionRpcs = <
	const CollectionName extends string,
	EntitySchema extends Schema.Top,
>(
	collectionName: CollectionName,
	entitySchema: EntitySchema,
) => {
	assertCollectionName(collectionName);
	const prefix = `${collectionName}.` as const;
	const findById = Rpc.make(`${prefix}findById`, {
		payload: { id: Schema.String },
		success: entitySchema,
		error: NotFoundErrorSchema,
	});
	const query = Rpc.make(`${prefix}query`, {
		payload: QueryPayloadSchema,
		success: CollectedQueryResultSchema,
		error: QueryErrorSchema,
	});
	const queryStream = Rpc.make(`${prefix}queryStream`, {
		payload: QueryPayloadSchema,
		success: QueryRowSchema,
		error: QueryErrorSchema,
		stream: true,
	});
	const create = Rpc.make(`${prefix}create`, {
		payload: CreatePayloadSchema,
		success: entitySchema,
		error: CreateErrorSchema,
	});
	const update = Rpc.make(`${prefix}update`, {
		payload: UpdatePayloadSchema,
		success: entitySchema,
		error: UpdateErrorSchema,
	});
	const deleteRpc = Rpc.make(`${prefix}delete`, {
		payload: DeletePayloadSchema,
		success: entitySchema,
		error: DeleteErrorSchema,
	});
	const aggregate = Rpc.make(`${prefix}aggregate`, {
		payload: AggregatePayloadSchema,
		success: AggregateRpcResultSchema,
		error: InvalidRpcRequestErrorSchema,
	});
	const createMany = Rpc.make(`${prefix}createMany`, {
		payload: CreateManyPayloadSchema,
		success: CreateManyResultSchema,
		error: CreateErrorSchema,
	});
	const updateMany = Rpc.make(`${prefix}updateMany`, {
		payload: UpdateManyPayloadSchema,
		success: UpdateManyResultSchema,
		error: BulkMutationErrorSchema,
	});
	const deleteMany = Rpc.make(`${prefix}deleteMany`, {
		payload: DeleteManyPayloadSchema,
		success: DeleteManyResultSchema,
		error: BulkMutationErrorSchema,
	});
	const upsert = Rpc.make(`${prefix}upsert`, {
		payload: UpsertPayloadSchema,
		success: UpsertResultSchema,
		error: UpsertErrorSchema,
	});
	const upsertMany = Rpc.make(`${prefix}upsertMany`, {
		payload: UpsertManyPayloadSchema,
		success: UpsertManyResultSchema,
		error: UpsertErrorSchema,
	});

	return {
		collectionName,
		entitySchema,
		findById,
		query,
		queryStream,
		create,
		update,
		delete: deleteRpc,
		aggregate,
		createMany,
		updateMany,
		deleteMany,
		upsert,
		upsertMany,
		group: RpcGroup.make(
			findById,
			query,
			queryStream,
			create,
			update,
			deleteRpc,
			aggregate,
			createMany,
			updateMany,
			deleteMany,
			upsert,
			upsertMany,
		),
	} as const;
};

export type CollectionRpcDefinitions<
	CollectionName extends string,
	EntitySchema extends Schema.Top,
> = ReturnType<typeof makeCollectionRpcs<CollectionName, EntitySchema>>;

type ExtractCollectionSchema<C extends CollectionConfig> =
	C["schema"] extends Schema.Top ? C["schema"] : Schema.Schema<unknown>;

type CollectionDefinitionsFromConfig<Config extends DatabaseConfig> = {
	[K in keyof ConfiguredCollections<Config> & string]: CollectionRpcDefinitions<
		K,
		ExtractCollectionSchema<ConfiguredCollections<Config>[K]>
	>;
};

type CollectionRpcUnion<Config extends DatabaseConfig> = {
	[K in keyof CollectionDefinitionsFromConfig<Config>]: CollectionDefinitionsFromConfig<Config>[K]["group"] extends RpcGroup.RpcGroup<
		infer Rpcs
	>
		? Rpcs
		: never;
}[keyof CollectionDefinitionsFromConfig<Config>];

export type RpcGroupFromConfig<Config extends DatabaseConfig> =
	RpcGroup.RpcGroup<CollectionRpcUnion<Config>>;

export const makeRpcGroup = <Config extends DatabaseConfig>(
	config: Config,
): RpcGroupFromConfig<Config> => {
	const groups: Array<unknown> = [];
	for (const [collectionName, collection] of Object.entries(
		getCollectionConfigs(config),
	)) {
		groups.push(makeCollectionRpcs(collectionName, collection.schema).group);
	}
	if (groups.length === 0) {
		return RpcGroup.make() as unknown as RpcGroupFromConfig<Config>;
	}
	const typedGroups = groups as Array<RpcGroup.RpcGroup<Rpc.Any>>;
	const first = typedGroups[0];
	if (first === undefined)
		throw new Error("RPC group construction invariant failed");
	return first.merge(
		...typedGroups.slice(1),
	) as unknown as RpcGroupFromConfig<Config>;
};

export type { CollectionConfig, DatabaseConfig };
