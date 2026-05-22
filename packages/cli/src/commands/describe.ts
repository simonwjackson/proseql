/**
 * ProseQL CLI - Describe Command
 *
 * Boots the database from config, reads the schema for the named collection,
 * and displays field names, types, optional/required status, indexes,
 * relationships, and constraints.
 */

import type { CollectionConfig, DatabaseConfig } from "@proseql/core";
import { Effect, type Schema } from "effect";
import {
	getCliCollectionConfig,
	listCollectionNames,
} from "../config/paths.js";

/**
 * Options for the describe command.
 */
export interface DescribeOptions {
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The name of the collection to describe */
	readonly collection: string;
}

/**
 * Information about a single field in the schema.
 */
export interface FieldInfo {
	readonly name: string;
	readonly type: string;
	readonly required: boolean;
	readonly indexed: boolean;
	readonly unique: boolean;
}

/**
 * Information about a relationship.
 */
export interface RelationshipInfo {
	readonly name: string;
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey: string | undefined;
}

/**
 * Result of the describe command.
 */
export interface DescribeResult {
	readonly success: boolean;
	readonly message?: string;
	readonly data?: {
		readonly collection: string;
		readonly fields: ReadonlyArray<FieldInfo>;
		readonly relationships: ReadonlyArray<RelationshipInfo>;
		readonly indexes: ReadonlyArray<string | ReadonlyArray<string>>;
		readonly uniqueConstraints: ReadonlyArray<string | ReadonlyArray<string>>;
		readonly hasSearchIndex: boolean;
		readonly searchIndexFields: ReadonlyArray<string>;
		readonly version: number | undefined;
		readonly appendOnly: boolean;
	};
}

type AstElement = AstNode | { readonly type?: AstNode };

type AstNode = {
	readonly _tag?: string;
	readonly literal?: unknown;
	readonly enums?: ReadonlyArray<readonly [string, unknown]>;
	readonly elements?: ReadonlyArray<AstElement>;
	readonly rest?: ReadonlyArray<AstElement>;
	readonly types?: ReadonlyArray<AstNode>;
	readonly propertySignatures?: ReadonlyArray<PropertySignatureNode>;
	readonly indexSignatures?: ReadonlyArray<unknown>;
	readonly from?: AstNode;
	readonly to?: AstNode;
	readonly annotations?: {
		readonly identifier?: unknown;
		readonly title?: unknown;
	};
	readonly context?: { readonly isOptional?: boolean };
};

type PropertySignatureNode = {
	readonly name: PropertyKey;
	readonly type?: AstNode;
	readonly isOptional?: boolean;
	readonly context?: { readonly isOptional?: boolean };
};

/**
 * Convert an AST type to a human-readable type name.
 */
function astTypeToString(ast: AstNode | undefined): string {
	if (!ast) return "unknown";
	switch (ast._tag) {
		case "String":
		case "StringKeyword":
			return "string";
		case "Number":
		case "NumberKeyword":
			return "number";
		case "Boolean":
		case "BooleanKeyword":
			return "boolean";
		case "BigInt":
		case "BigIntKeyword":
			return "bigint";
		case "Symbol":
		case "SymbolKeyword":
			return "symbol";
		case "Undefined":
		case "UndefinedKeyword":
			return "undefined";
		case "Void":
		case "VoidKeyword":
			return "void";
		case "Never":
		case "NeverKeyword":
			return "never";
		case "Unknown":
		case "UnknownKeyword":
			return "unknown";
		case "Any":
		case "AnyKeyword":
			return "any";
		case "ObjectKeyword":
		case "Objects":
			return "object";
		case "Literal": {
			const value = ast.literal;
			if (typeof value === "string") return `"${value}"`;
			return String(value);
		}
		case "UniqueSymbol":
			return "unique symbol";
		case "Enums":
			return `enum(${(ast.enums ?? []).map(([name]) => name).join(" | ")})`;
		case "TemplateLiteral":
			return "template literal";
		case "TupleType":
		case "Tuple": {
			const elements = (ast.elements ?? []).map((element) =>
				astTypeToString(getElementType(element)),
			);
			const rest = (ast.rest ?? []).map(
				(element) => `...${astTypeToString(getElementType(element))}`,
			);
			return `[${[...elements, ...rest].join(", ")}]`;
		}
		case "TypeLiteral":
		case "Struct": {
			if ((ast.propertySignatures ?? []).length > 0) return "object";
			if ((ast.indexSignatures ?? []).length > 0) return "Record";
			return "{}";
		}
		case "Union": {
			const types = (ast.types ?? []).map((type) => astTypeToString(type));
			if (types.length === 2 && types.includes("undefined")) {
				return `${types.find((t: string) => t !== "undefined")} | undefined`;
			}
			return types.length <= 4
				? types.join(" | ")
				: `union(${types.length} types)`;
		}
		case "Suspend":
			return "recursive";
		case "Refinement":
			return astTypeToString(ast.from);
		case "Transformation":
			return astTypeToString(ast.to);
		case "Declaration": {
			const identifier = ast.annotations?.identifier ?? ast.annotations?.title;
			return typeof identifier === "string" ? identifier : "declaration";
		}
		default:
			return "unknown";
	}
}

function getElementType(element: AstElement): AstNode | undefined {
	return "type" in element ? element.type : (element as AstNode);
}

/**
 * Check if a field is in any of the indexes (single or compound).
 */
function isFieldIndexed(
	fieldName: string,
	indexes: ReadonlyArray<string | ReadonlyArray<string>> | undefined,
): boolean {
	if (!indexes) return false;
	return indexes.some((index) => {
		if (typeof index === "string") {
			return index === fieldName;
		}
		return index.includes(fieldName);
	});
}

/**
 * Check if a field has a unique constraint (single or compound).
 */
function isFieldUnique(
	fieldName: string,
	uniqueFields: ReadonlyArray<string | ReadonlyArray<string>> | undefined,
): boolean {
	if (!uniqueFields) return false;
	return uniqueFields.some((constraint) => {
		if (typeof constraint === "string") {
			return constraint === fieldName;
		}
		// For compound constraints, only mark as unique if it's the only field
		return constraint.length === 1 && constraint[0] === fieldName;
	});
}

/**
 * Extract field information from a schema.
 */
function extractFieldInfo(
	schema: Schema.Schema<unknown>,
	config: CollectionConfig,
): ReadonlyArray<FieldInfo> {
	const ast = schema.ast as unknown as AstNode;
	const propertySignatures = ast.propertySignatures ?? [];

	return propertySignatures.map((ps) => {
		const name = String(ps.name);
		const optional =
			ps.isOptional === true ||
			ps.context?.isOptional === true ||
			ps.type?.context?.isOptional === true ||
			(ps.type?._tag === "Union" &&
				Array.isArray(ps.type.types) &&
				ps.type.types.some((type) => type._tag === "Undefined"));

		return {
			name,
			type: astTypeToString(ps.type),
			required: !optional,
			indexed: isFieldIndexed(name, config.indexes),
			unique: isFieldUnique(name, config.uniqueFields),
		};
	});
}

/**
 * Extract relationship information from the config.
 */
function extractRelationships(
	relationships: CollectionConfig["relationships"],
): ReadonlyArray<RelationshipInfo> {
	return Object.entries(relationships).map(([name, rel]) => ({
		name,
		type: rel.type,
		target: rel.target,
		foreignKey: rel.foreignKey,
	}));
}

/**
 * Execute the describe command.
 *
 * Reads the schema from the config for the named collection and extracts
 * detailed information about fields, types, indexes, relationships, etc.
 *
 * @param options - Describe command options
 * @returns Result with collection schema information or error message
 */
export function runDescribe(
	options: DescribeOptions,
): Effect.Effect<DescribeResult> {
	// This is a pure synchronous operation - no effects needed
	return Effect.sync(() => {
		const { config, collection } = options;

		// Check if the collection exists
		const collectionConfig = getCliCollectionConfig(config, collection);
		if (!collectionConfig) {
			const availableCollections = listCollectionNames(config);
			return {
				success: false,
				message: `Collection "${collection}" not found. Available collections: ${availableCollections.join(", ") || "(none)"}`,
			};
		}

		// Extract field information from the schema
		const fields = extractFieldInfo(collectionConfig.schema, collectionConfig);

		// Extract relationships
		const relationships = extractRelationships(collectionConfig.relationships);

		// Get other config properties
		const indexes = collectionConfig.indexes ?? [];
		const uniqueConstraints = collectionConfig.uniqueFields ?? [];
		const searchIndexFields = collectionConfig.searchIndex ?? [];
		const hasSearchIndex = searchIndexFields.length > 0;
		const version = collectionConfig.version;
		const appendOnly = collectionConfig.appendOnly ?? false;

		return {
			success: true,
			data: {
				collection,
				fields,
				relationships,
				indexes,
				uniqueConstraints,
				hasSearchIndex,
				searchIndexFields,
				version,
				appendOnly,
			},
		};
	});
}

/**
 * Handle the describe command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Describe command options
 * @returns Promise that resolves to the describe result or rejects on error
 */
export async function handleDescribe(
	options: DescribeOptions,
): Promise<DescribeResult> {
	const result = await Effect.runPromise(runDescribe(options));
	return result;
}
