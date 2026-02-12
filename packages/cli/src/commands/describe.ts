/**
 * ProseQL CLI - Describe Command
 *
 * Boots the database from config, reads the schema for the named collection,
 * and displays field names, types, optional/required status, indexes,
 * relationships, and constraints.
 */

import { Effect, Schema, SchemaAST } from "effect"
import type { DatabaseConfig, CollectionConfig } from "@proseql/core"

/**
 * Options for the describe command.
 */
export interface DescribeOptions {
	/** The database configuration */
	readonly config: DatabaseConfig
	/** The name of the collection to describe */
	readonly collection: string
}

/**
 * Information about a single field in the schema.
 */
export interface FieldInfo {
	readonly name: string
	readonly type: string
	readonly required: boolean
	readonly indexed: boolean
	readonly unique: boolean
}

/**
 * Information about a relationship.
 */
export interface RelationshipInfo {
	readonly name: string
	readonly type: "ref" | "inverse"
	readonly target: string
	readonly foreignKey: string | undefined
}

/**
 * Result of the describe command.
 */
export interface DescribeResult {
	readonly success: boolean
	readonly message?: string
	readonly data?: {
		readonly collection: string
		readonly fields: ReadonlyArray<FieldInfo>
		readonly relationships: ReadonlyArray<RelationshipInfo>
		readonly indexes: ReadonlyArray<string | ReadonlyArray<string>>
		readonly uniqueConstraints: ReadonlyArray<string | ReadonlyArray<string>>
		readonly hasSearchIndex: boolean
		readonly searchIndexFields: ReadonlyArray<string>
		readonly version: number | undefined
		readonly appendOnly: boolean
	}
}

/**
 * Convert an AST type to a human-readable type name.
 */
function astTypeToString(ast: SchemaAST.AST): string {
	switch (ast._tag) {
		case "StringKeyword":
			return "string"
		case "NumberKeyword":
			return "number"
		case "BooleanKeyword":
			return "boolean"
		case "BigIntKeyword":
			return "bigint"
		case "SymbolKeyword":
			return "symbol"
		case "UndefinedKeyword":
			return "undefined"
		case "VoidKeyword":
			return "void"
		case "NeverKeyword":
			return "never"
		case "UnknownKeyword":
			return "unknown"
		case "AnyKeyword":
			return "any"
		case "ObjectKeyword":
			return "object"
		case "Literal": {
			const value = ast.literal
			if (typeof value === "string") {
				return `"${value}"`
			}
			return String(value)
		}
		case "UniqueSymbol":
			return `unique symbol`
		case "Enums":
			return `enum(${ast.enums.map(([name]) => name).join(" | ")})`
		case "TemplateLiteral":
			return "template literal"
		case "TupleType": {
			const elements = ast.elements.map((e) => astTypeToString(e.type))
			const rest = ast.rest.map((r) => `...${astTypeToString(r.type)}`)
			return `[${[...elements, ...rest].join(", ")}]`
		}
		case "TypeLiteral": {
			if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
				return "{}"
			}
			if (ast.propertySignatures.length > 0) {
				return "object"
			}
			return "Record"
		}
		case "Union": {
			const types = ast.types.map((t) => astTypeToString(t))
			// Simplify common patterns
			if (types.length === 2 && types.includes("undefined")) {
				const other = types.find((t) => t !== "undefined")
				return `${other} | undefined`
			}
			if (types.length <= 4) {
				return types.join(" | ")
			}
			return `union(${types.length} types)`
		}
		case "Suspend":
			return "recursive"
		case "Refinement":
			return astTypeToString(ast.from)
		case "Transformation":
			return astTypeToString(ast.to)
		case "Declaration":
			// Try to get identifier annotation
			const identifier = ast.annotations[SchemaAST.IdentifierAnnotationId]
			if (typeof identifier === "string") {
				return identifier
			}
			return "declaration"
		default:
			return "unknown"
	}
}

/**
 * Check if a field is in any of the indexes (single or compound).
 */
function isFieldIndexed(
	fieldName: string,
	indexes: ReadonlyArray<string | ReadonlyArray<string>> | undefined,
): boolean {
	if (!indexes) return false
	return indexes.some((index) => {
		if (typeof index === "string") {
			return index === fieldName
		}
		return index.includes(fieldName)
	})
}

/**
 * Check if a field has a unique constraint (single or compound).
 */
function isFieldUnique(
	fieldName: string,
	uniqueFields: ReadonlyArray<string | ReadonlyArray<string>> | undefined,
): boolean {
	if (!uniqueFields) return false
	return uniqueFields.some((constraint) => {
		if (typeof constraint === "string") {
			return constraint === fieldName
		}
		// For compound constraints, only mark as unique if it's the only field
		return constraint.length === 1 && constraint[0] === fieldName
	})
}

/**
 * Extract field information from a schema.
 */
function extractFieldInfo(
	schema: Schema.Schema.All,
	config: CollectionConfig,
): ReadonlyArray<FieldInfo> {
	const ast = schema.ast
	const propertySignatures = SchemaAST.getPropertySignatures(ast)

	return propertySignatures.map((ps) => ({
		name: String(ps.name),
		type: astTypeToString(ps.type),
		required: !ps.isOptional,
		indexed: isFieldIndexed(String(ps.name), config.indexes),
		unique: isFieldUnique(String(ps.name), config.uniqueFields),
	}))
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
	}))
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
	return Effect.gen(function* () {
		const { config, collection } = options

		// Check if the collection exists
		const collectionConfig = config[collection]
		if (!collectionConfig) {
			const availableCollections = Object.keys(config)
			return {
				success: false,
				message: `Collection "${collection}" not found. Available collections: ${availableCollections.join(", ") || "(none)"}`,
			}
		}

		// Extract field information from the schema
		const fields = extractFieldInfo(collectionConfig.schema, collectionConfig)

		// Extract relationships
		const relationships = extractRelationships(collectionConfig.relationships)

		// Get other config properties
		const indexes = collectionConfig.indexes ?? []
		const uniqueConstraints = collectionConfig.uniqueFields ?? []
		const searchIndexFields = collectionConfig.searchIndex ?? []
		const hasSearchIndex = searchIndexFields.length > 0
		const version = collectionConfig.version
		const appendOnly = collectionConfig.appendOnly ?? false

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
		}
	})
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
	const result = await Effect.runPromise(runDescribe(options))
	return result
}
