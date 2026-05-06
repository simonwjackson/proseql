/**
 * Schema introspection: extract field names, types, relationships, and operators
 * from a DatabaseConfig by walking Effect Schema ASTs.
 */

import type { DatabaseConfig } from "@proseql/core";
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
		case "StringKeyword":
			return "string";
		case "NumberKeyword":
			return "number";
		case "BooleanKeyword":
			return "boolean";
		case "BigIntKeyword":
			return "bigint";
		case "TupleType":
			return "array";
		case "TypeLiteral":
			// Could be an empty object {} or a nested struct
			if (
				ast.propertySignatures.length === 0 &&
				ast.indexSignatures.length === 0
			) {
				return "object";
			}
			return "object";
		case "Union":
			// Check for optionals (undefined | T) and enums
			return getUnionTypeString(ast);
		case "Transformation":
			return getTypeString(ast.from);
		case "Refinement":
			return getTypeString(ast.from);
		case "Suspend":
			return getTypeString(ast.f());
		case "Declaration":
			// Declarations like Date, etc.
			return "string";
		default:
			return "unknown";
	}
}

function getUnionTypeString(ast: AST & { _tag: "Union" }): string {
	// Filter out UndefinedKeyword (optionals)
	const nonUndefined = ast.types.filter((t) => t._tag !== "UndefinedKeyword");
	if (nonUndefined.length === 1) {
		return getTypeString(nonUndefined[0]);
	}
	// Multiple types — check if all are literals (enum)
	const allLiterals = nonUndefined.every((t) => t._tag === "Literal");
	if (allLiterals) {
		// Infer type from first literal
		const first = nonUndefined[0];
		if (first._tag === "Literal") {
			return typeof first.literal as string;
		}
	}
	return "string";
}

function extractFieldsFromAST(ast: AST): Record<string, string> {
	// Unwrap Transformation (Schema.Struct with transforms wraps in Transformation)
	if (ast._tag === "Transformation") {
		return extractFieldsFromAST(ast.from);
	}
	if (ast._tag === "Refinement") {
		return extractFieldsFromAST(ast.from);
	}
	if (ast._tag !== "TypeLiteral") {
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
	config: DatabaseConfig[string],
): CollectionDescription {
	const schema = config.schema as Schema.Schema.All;
	const fields = extractFieldsFromAST(schema.ast);

	return {
		fields,
		relationships: config.relationships,
		searchIndex: config.searchIndex ?? [],
	};
}

export function describeConfig(config: DatabaseConfig): SchemaDescription {
	const collections: Record<string, CollectionDescription> = {};

	for (const [name, collectionConfig] of Object.entries(config)) {
		collections[name] = describeCollection(collectionConfig);
	}

	return {
		collections,
		operators: OPERATORS_BY_TYPE,
	};
}
