import type {
	CollectionConfig,
	DatabaseConfig,
	HooksConfig,
	Migration,
	PluginRegistry,
} from "@proseql/core";
import {
	getCollectionConfigs,
	isSourceOrientedDatabaseConfig,
} from "@proseql/core";
import type { Schema } from "effect";
import { Effect } from "effect";

export interface CallbackRegistrar {
	registerDefault(callback: () => unknown, prefix: string): string;
	registerComputed(
		callback: (entity: unknown) => unknown,
		prefix: string,
	): string;
	registerBeforeCreateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerBeforeUpdateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerBeforeDeleteHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerAfterCreateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerAfterUpdateHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerAfterDeleteHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerOnChangeHook(
		callback: (ctx: unknown) => unknown,
		prefix: string,
	): string;
	registerMigration(
		callback: (data: Record<string, unknown>) => Record<string, unknown>,
		prefix: string,
	): string;
	registerIdGenerator(name: string, generate: () => string): void;
	registerCustomOperator(
		name: string,
		supportedTypes: ReadonlyArray<string>,
		evaluate: (field: unknown, operand: unknown) => boolean,
	): Promise<void>;
	registerCollator(callback: (left: string, right: string) => number): void;
}

export interface CompiledDatabaseDescriptor {
	readonly descriptor: {
		readonly collections: ReadonlyArray<Record<string, unknown>>;
		readonly sources: ReadonlyArray<unknown>;
	};
	readonly sourceOriented: boolean;
}

export const compileDatabaseDescriptor = async <Config extends DatabaseConfig>(
	config: Config,
	plugins: PluginRegistry,
	registrar: CallbackRegistrar,
): Promise<CompiledDatabaseDescriptor> => {
	registrar.registerCollator((left, right) => left.localeCompare(right));
	for (const operator of plugins.operators.values()) {
		await registrar.registerCustomOperator(
			operator.name,
			operator.types,
			operator.evaluate,
		);
	}
	for (const generator of plugins.idGenerators.values()) {
		registrar.registerIdGenerator(generator.name, generator.generate);
	}

	const collections = Object.entries(getCollectionConfigs(config)).map(
		([name, collection]) =>
			compileCollectionDescriptor(name, collection, plugins, registrar),
	);
	return {
		descriptor: {
			collections,
			sources: [],
		},
		sourceOriented: isSourceOrientedDatabaseConfig(config),
	};
};

function compileCollectionDescriptor(
	name: string,
	collection: CollectionConfig,
	plugins: PluginRegistry,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	const hooks = mergeHooks(plugins, collection.hooks);
	return {
		name,
		schema: compileStructLikeSchema(
			collection.schema,
			`${name}.schema`,
			registrar,
		),
		id_strategy: compileIdStrategy(collection),
		relationships: Object.entries(
			collection.relationships as Record<
				string,
				{
					readonly type: "ref" | "inverse";
					readonly target: string;
					readonly foreignKey?: string;
				}
			>,
		).map(([relationshipName, relationship]) => [
			relationshipName,
			{
				kind: relationship.type,
				target: relationship.target,
				...(relationship.foreignKey
					? { foreign_key: relationship.foreignKey }
					: {}),
			},
		]),
		indexes: collection.indexes ? [...collection.indexes] : [],
		unique_fields: collection.uniqueFields ? [...collection.uniqueFields] : [],
		before_create_hooks: registerHookArray(
			hooks.beforeCreate as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerBeforeCreateHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.beforeCreate`,
		),
		after_create_hooks: registerHookArray(
			hooks.afterCreate as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerAfterCreateHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.afterCreate`,
		),
		before_update_hooks: registerHookArray(
			hooks.beforeUpdate as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerBeforeUpdateHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.beforeUpdate`,
		),
		after_update_hooks: registerHookArray(
			hooks.afterUpdate as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerAfterUpdateHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.afterUpdate`,
		),
		before_delete_hooks: registerHookArray(
			hooks.beforeDelete as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerBeforeDeleteHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.beforeDelete`,
		),
		after_delete_hooks: registerHookArray(
			hooks.afterDelete as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerAfterDeleteHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.afterDelete`,
		),
		on_change_hooks: registerHookArray(
			hooks.onChange as
				| ReadonlyArray<(ctx: any) => Effect.Effect<unknown>>
				| undefined,
			(prefix, hook) =>
				registrar.registerOnChangeHook(
					(ctx) => runEffect(hook(ctx as never)),
					prefix,
				),
			`${name}.onChange`,
		),
		computed_fields: Object.entries(
			(collection.computed ?? {}) as Record<
				string,
				(entity: unknown) => unknown
			>,
		).map(([fieldName, callback]) => ({
			name: fieldName,
			callback_id: registrar.registerComputed(
				callback,
				`${name}.computed.${fieldName}`,
			),
		})),
		search_index: collection.searchIndex ? [...collection.searchIndex] : [],
		...(collection.idGenerator ? { id_generator: collection.idGenerator } : {}),
		...(collection.version !== undefined
			? { version: collection.version }
			: {}),
		migrations: ((collection.migrations ?? []) as ReadonlyArray<Migration>).map(
			(migration, index) => compileMigration(name, migration, index, registrar),
		),
		append_only: collection.appendOnly ?? false,
		validation_mode: collection.validation ?? "strict",
	};
}

function compileMigration(
	collectionName: string,
	migration: Migration,
	index: number,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	return {
		from: migration.from,
		to: migration.to,
		...(migration.description ? { description: migration.description } : {}),
		callback_id: registrar.registerMigration(
			(data) => migration.transform(data),
			`${collectionName}.migration.${index}`,
		),
	};
}

function compileIdStrategy(
	collection: CollectionConfig,
): Record<string, unknown> {
	if (collection.id?.kind === "derivedFromKey") {
		return { kind: "derivedFromKey" };
	}
	if (collection.idGenerator) {
		return { kind: "namedGenerator", name: collection.idGenerator };
	}
	return { kind: "provided" };
}

function mergeHooks<T>(
	plugins: PluginRegistry,
	collectionHooks: HooksConfig<T> | undefined,
): HooksConfig<T> {
	const globalHooks = plugins.globalHooks as HooksConfig<T> | undefined;
	const merge = <A>(
		a: ReadonlyArray<A> | undefined,
		b: ReadonlyArray<A> | undefined,
	) => {
		const values = [...(a ?? []), ...(b ?? [])].filter(
			(value) => value !== undefined,
		);
		return values.length > 0 ? values : undefined;
	};
	return {
		beforeCreate: merge(
			globalHooks?.beforeCreate,
			collectionHooks?.beforeCreate,
		),
		afterCreate: merge(globalHooks?.afterCreate, collectionHooks?.afterCreate),
		beforeUpdate: merge(
			globalHooks?.beforeUpdate,
			collectionHooks?.beforeUpdate,
		),
		afterUpdate: merge(globalHooks?.afterUpdate, collectionHooks?.afterUpdate),
		beforeDelete: merge(
			globalHooks?.beforeDelete,
			collectionHooks?.beforeDelete,
		),
		afterDelete: merge(globalHooks?.afterDelete, collectionHooks?.afterDelete),
		onChange: merge(globalHooks?.onChange, collectionHooks?.onChange),
	};
}

function registerHookArray<T>(
	hooks: ReadonlyArray<T> | undefined,
	register: (prefix: string, hook: T) => string,
	prefix: string,
): ReadonlyArray<string> {
	return (hooks ?? []).map((hook: T, index) =>
		register(`${prefix}.${index}`, hook),
	);
}

function compileStructLikeSchema(
	schema: Schema.Top,
	path: string,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	const anySchema = schema as any;
	const ast = anySchema.ast;
	if (ast?._tag === "Objects" && anySchema.fields) {
		return compileTypeLiteralFields(anySchema.fields, path, registrar);
	}
	if (
		ast?._tag === "Transformation" &&
		ast.from?._tag === "TypeLiteral" &&
		ast.to?._tag === "TypeLiteral"
	) {
		return compileTypeLiteralFields(anySchema.fields ?? {}, path, registrar);
	}
	if (ast?._tag === "TypeLiteral" && anySchema.fields) {
		return compileTypeLiteralFields(anySchema.fields, path, registrar);
	}
	throw new Error(
		`Unsupported root schema at '${path}': expected Schema.Struct, got ${describeAst(ast)}`,
	);
}

function compileTypeLiteralFields(
	fields: Record<string, unknown>,
	path: string,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	return {
		kind: "struct",
		fields: Object.entries(fields).map(([name, fieldSchema]) => ({
			name,
			schema: compileFieldSchema(
				fieldSchema as any,
				`${path}.${name}`,
				registrar,
			),
		})),
	};
}

function compileTypeLiteralAstFields(
	propertySignatures: ReadonlyArray<{
		readonly name: unknown;
		readonly type: unknown;
		readonly isOptional?: boolean;
	}>,
	path: string,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	return {
		kind: "struct",
		fields: propertySignatures.map((propertySignature) => {
			const name = String(propertySignature.name);
			const compiled = compileSchemaNode(
				{ ast: propertySignature.type },
				`${path}.${name}`,
				registrar,
			);
			return {
				name,
				schema: propertySignature.isOptional
					? { kind: "optional", inner: compiled }
					: compiled,
			};
		}),
	};
}

function compileFieldSchema(
	schema: any,
	path: string,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	const ast = schema.ast;
	const context = ast?.context;
	const inner = schema.schema ?? schema.from ?? schema;
	if (context?.isOptional) {
		if (typeof context.defaultValue === "function") {
			return {
				kind: "optionalWithDefault",
				inner: compileSchemaNode(inner, path, registrar),
				defaultCallbackId: registrar.registerDefault(
					context.defaultValue,
					`${path}.default`,
				),
			};
		}
		return {
			kind: "optional",
			inner: compileSchemaNode(inner, path, registrar),
		};
	}
	if (ast?._tag === "PropertySignatureDeclaration") {
		if (ast.isOptional) {
			return {
				kind: "optional",
				inner: compileSchemaNode(schema.from, path, registrar),
			};
		}
		return compileSchemaNode(schema.from ?? { ast: ast.type }, path, registrar);
	}
	if (ast?._tag === "PropertySignatureTransformation") {
		const defaultValue = ast.to?.defaultValue;
		if (typeof defaultValue === "function") {
			return {
				kind: "optionalWithDefault",
				inner: compileSchemaNode(schema.from, path, registrar),
				defaultCallbackId: registrar.registerDefault(
					defaultValue,
					`${path}.default`,
				),
			};
		}
		if (ast.from?.isOptional) {
			return {
				kind: "optional",
				inner: compileSchemaNode(schema.from, path, registrar),
			};
		}
	}
	return compileSchemaNode(schema, path, registrar);
}

function compileSchemaNode(
	schema: any,
	path: string,
	registrar: CallbackRegistrar,
): Record<string, unknown> {
	const ast = schema.ast ?? schema;
	switch (ast?._tag) {
		case "String":
		case "StringKeyword":
			return { kind: "str" };
		case "Number":
			if (
				Array.isArray(ast.encoding) &&
				ast.encoding.some((entry: any) => entry.to?._tag === "String")
			) {
				return { kind: "numFromStr" };
			}
			return { kind: "num" };
		case "NumberKeyword":
			return { kind: "num" };
		case "Boolean":
		case "BooleanKeyword":
			return { kind: "bool" };
		case "Unknown":
		case "UnknownKeyword":
		case "AnyKeyword":
			return { kind: "unknown" };
		case "Arrays":
		case "TupleType": {
			if (ast.elements.length === 0 && ast.rest?.length === 1) {
				const restEntry = ast.rest[0];
				return {
					kind: "array",
					item: compileSchemaNode(
						{ ast: restEntry.type ?? restEntry },
						`${path}[]`,
						registrar,
					),
				};
			}
			throw new Error(
				`Unsupported tuple schema at '${path}': only homogeneous arrays are supported`,
			);
		}
		case "Objects":
		case "TypeLiteral": {
			if (schema.fields) {
				return compileTypeLiteralFields(schema.fields, path, registrar);
			}
			if (
				ast.propertySignatures.length > 0 &&
				ast.indexSignatures.length === 0
			) {
				return compileTypeLiteralAstFields(
					ast.propertySignatures,
					path,
					registrar,
				);
			}
			if (
				ast.propertySignatures.length === 0 &&
				ast.indexSignatures.length === 1
			) {
				const indexSignature = ast.indexSignatures[0];
				return {
					kind: "record",
					key: compileSchemaNode(
						{ ast: indexSignature.parameter },
						`${path}.[key]`,
						registrar,
					),
					value: compileSchemaNode(
						{ ast: indexSignature.type },
						`${path}.[value]`,
						registrar,
					),
				};
			}
			if (
				ast.propertySignatures.length === 0 &&
				ast.indexSignatures.length === 0
			) {
				return { kind: "struct", fields: [] };
			}
			throw new Error(
				`Unsupported type literal at '${path}': mixed property/index signatures are not supported`,
			);
		}
		case "Transformation": {
			if (
				ast.from?._tag === "StringKeyword" &&
				ast.to?._tag === "NumberKeyword"
			) {
				return { kind: "numFromStr" };
			}
			if (
				ast.from?._tag === "TypeLiteral" &&
				ast.to?._tag === "TypeLiteral" &&
				schema.fields
			) {
				return compileTypeLiteralFields(schema.fields, path, registrar);
			}
			throw new Error(
				`Unsupported transformation at '${path}': ${describeAst(ast.from)} -> ${describeAst(ast.to)}`,
			);
		}
		case "Null":
			return { kind: "literal", value: null };
		case "Undefined":
			return { kind: "optional", inner: { kind: "unknown" } };
		case "Union": {
			const nullMembers = ast.types.filter(
				(member: any) =>
					(member._tag === "Literal" && member.literal === null) ||
					member._tag === "Null",
			);
			const undefinedMembers = ast.types.filter(
				(member: any) =>
					member._tag === "UndefinedKeyword" || member._tag === "Undefined",
			);
			const otherMembers = ast.types.filter(
				(member: any) =>
					!(
						(member._tag === "Literal" && member.literal === null) ||
						member._tag === "Null"
					) &&
					member._tag !== "UndefinedKeyword" &&
					member._tag !== "Undefined",
			);
			const literalValues = ast.types
				.map((member: any) => literalValueFromAst(member))
				.filter(
					(value: unknown): value is string | number | boolean | null =>
						value !== undefined,
				);
			if (
				literalValues.length === ast.types.length &&
				literalValues.length > 0
			) {
				return literalValues.length === 1
					? { kind: "literal", value: literalValues[0] }
					: { kind: "literalUnion", values: literalValues };
			}
			if (
				nullMembers.length === 1 &&
				undefinedMembers.length === 0 &&
				otherMembers.length === 1
			) {
				return {
					kind: "nullOr",
					inner: compileSchemaNode({ ast: otherMembers[0] }, path, registrar),
				};
			}
			if (
				undefinedMembers.length === 1 &&
				nullMembers.length === 0 &&
				otherMembers.length === 1
			) {
				return {
					kind: "optional",
					inner: compileSchemaNode({ ast: otherMembers[0] }, path, registrar),
				};
			}
			throw new Error(
				`Unsupported union at '${path}': only null/undefined unions and literal unions are supported`,
			);
		}
		case "Literal": {
			const literal = literalValueFromAst(ast);
			if (literal !== undefined) return { kind: "literal", value: literal };
			throw new Error(`Unsupported literal at '${path}'`);
		}
		default:
			throw new Error(
				`Unsupported schema combinator at '${path}': ${describeAst(ast)}`,
			);
	}
}

function runEffect(effect: Effect.Effect<unknown>): unknown {
	try {
		return Effect.runSync(effect);
	} catch (error) {
		if (isAsyncEffectSuspension(error)) {
			throw new Error(
				"Async Effect callbacks are not supported by @proseql/engine's synchronous WASM callback boundary. Use synchronous callbacks here; async orchestration is deferred to the U9 Effect adapter.",
			);
		}
		throw error;
	}
}

function literalValueFromAst(
	ast: any,
): string | number | boolean | null | undefined {
	if (ast?._tag === "Literal") {
		const literal = ast.literal;
		if (
			typeof literal === "string" ||
			typeof literal === "number" ||
			typeof literal === "boolean" ||
			literal === null
		) {
			return literal;
		}
	}
	if (ast?._tag === "Null") return null;
	return undefined;
}

function isAsyncEffectSuspension(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/synchronous|runSync|async/i.test(message) && /effect|fiber/i.test(message)
	);
}

function describeAst(ast: any): string {
	return ast?._tag ?? "unknown";
}
