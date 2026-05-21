/**
 * Schema introspection: extract field names, types, relationships, and operators
 * from a DatabaseConfig by walking Effect Schema ASTs.
 */

import {
	type CollectionConfig,
	type DatabaseConfig,
	getCollectionConfigs,
} from "@proseql/core";
import type { Schema } from "effect";
import type { AST } from "effect/SchemaAST";
import type { CollectionDescription, SchemaDescription } from "./types.js";

const OPERATORS_BY_TYPE: Record<string, ReadonlyArray<string>> = {
	string: [
		"$eq",
		"$ne",
		"$gt",
		"$gte",
		"$lt",
		"$lte",
		"$contains",
		"$startsWith",
		"$endsWith",
		"$search",
		"$in",
		"$nin",
	],
	number: ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"],
	boolean: ["$eq", "$ne"],
	array: ["$eq", "$ne", "$contains", "$all", "$size", "$in", "$nin"],
};

function getTypeString(ast: AST): string {
	switch (ast._tag) {
		case "String":
			return "string";
		case "Number":
			return "number";
		case "Boolean":
			return "boolean";
		case "BigInt":
			return "bigint";
		case "Arrays":
			return "array";
		case "Objects":
			return "object";
		case "Union":
			return getUnionTypeString(ast);
		case "Suspend":
			return getTypeString(ast.thunk());
		case "Declaration":
			// Declarations like Date, etc.
			return "string";
		default:
			return "unknown";
	}
}

function getUnionTypeString(ast: AST & { readonly _tag: "Union" }): string {
	// Filter out Undefined optionals.
	const nonUndefined = ast.types.filter((type) => type._tag !== "Undefined");
	if (nonUndefined.length === 1) {
		return getTypeString(nonUndefined[0]);
	}
	// Multiple types — check if all are literals (enum)
	const allLiterals = nonUndefined.every((type) => type._tag === "Literal");
	if (allLiterals) {
		// Infer type from first literal
		const first = nonUndefined[0];
		if (first?._tag === "Literal") {
			return typeof first.literal;
		}
	}
	return "string";
}

function extractFieldsFromAST(ast: AST): Record<string, string> {
	if (ast._tag === "Suspend") {
		return extractFieldsFromAST(ast.thunk());
	}
	if (ast._tag !== "Objects") {
		return {};
	}

	const fields: Record<string, string> = {};
	for (const prop of ast.propertySignatures) {
		const name = String(prop.name);
		fields[name] = getTypeString(prop.type);
	}
	return fields;
}

export function describeCollection(
	config: CollectionConfig,
): CollectionDescription {
	const schema = config.schema as Schema.Top;
	const fields = extractFieldsFromAST(schema.ast);

	return {
		fields,
		relationships: config.relationships,
		searchIndex: config.searchIndex ?? [],
	};
}

export function describeConfig(config: DatabaseConfig): SchemaDescription {
	const collections: Record<string, CollectionDescription> = {};

	for (const [name, collectionConfig] of Object.entries(
		getCollectionConfigs(config),
	)) {
		collections[name] = describeCollection(collectionConfig);
	}

	return {
		collections,
		operators: OPERATORS_BY_TYPE,
	};
}
