#!/usr/bin/env -S nix shell nixpkgs#nodejs --command node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [coach, destination] = process.argv.slice(2);
const ts = (
	await import(
		pathToFileURL(`${coach}/node_modules/typescript/lib/typescript.js`).href
	)
).default;
const raw = execFileSync(
	"git",
	["-C", coach, "show", "legacy:src/app/data/db-config.ts"],
	{ encoding: "utf8" },
);
const source = ts.createSourceFile(
	"db-config.ts",
	raw,
	ts.ScriptTarget.Latest,
	true,
);
const values = new Map();
function evaluate(node) {
	if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
		return evaluate(node.expression);
	if (ts.isStringLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (ts.isIdentifier(node) && values.has(node.text))
		return values.get(node.text);
	if (ts.isArrayLiteralExpression(node))
		return node.elements.flatMap((element) =>
			ts.isSpreadElement(element)
				? evaluate(element.expression)
				: [evaluate(element)],
		);
	if (ts.isObjectLiteralExpression(node))
		return Object.fromEntries(
			node.properties.map((property) => {
				if (!ts.isPropertyAssignment(property))
					throw new Error("Unsupported object member");
				return [property.name.text, evaluate(property.initializer)];
			}),
		);
	if (
		ts.isPropertyAccessExpression(node) &&
		node.expression.getText(source) === "Schema"
	) {
		const kinds = { String: "str", Number: "num", Boolean: "bool" };
		if (kinds[node.name.text]) return { kind: kinds[node.name.text] };
	}
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText(source) === "Schema"
	) {
		const args = node.arguments.map(evaluate);
		switch (node.expression.name.text) {
			case "Struct":
				return {
					kind: "struct",
					fields: Object.entries(args[0]).map(([name, schema]) => ({
						name,
						schema,
					})),
				};
			case "Array":
				return { kind: "array", item: args[0] };
			case "optional":
				return { kind: "optional", inner: args[0] };
			case "Literal":
				return { kind: "literal", value: args[0] };
			case "Literals":
				return { kind: "literalUnion", values: args[0] };
		}
	}
	throw new Error(`Unsupported schema expression: ${node.getText(source)}`);
}
for (const statement of source.statements) {
	if (!ts.isVariableStatement(statement)) continue;
	for (const declaration of statement.declarationList.declarations) {
		if (declaration.name.text === "OURA_COLLECTION_NAMES") continue;
		values.set(declaration.name.text, evaluate(declaration.initializer));
	}
}
const collections = Object.entries(values.get("coachDbConfig").collections).map(
	([name, config]) => {
		if (config.id.kind !== "derivedFromKey" || config.id.field !== "id")
			throw new Error("Unexpected ID configuration");
		return {
			name,
			schema: config.schema,
			id_strategy: { kind: "derivedFromKey" },
			relationships: Object.entries(config.relationships).map(
				([name, relationship]) => [
					name,
					{
						kind: relationship.type,
						target: relationship.target,
						foreign_key: relationship.foreignKey,
					},
				],
			),
			indexes: [],
			unique_fields: [],
			before_create_hooks: [],
			after_create_hooks: [],
			before_update_hooks: [],
			after_update_hooks: [],
			before_delete_hooks: [],
			after_delete_hooks: [],
			on_change_hooks: [],
			computed_fields: [],
			search_index: [],
			id_generator: null,
			version: null,
			migrations: [],
			append_only: false,
			validation_mode: "strict",
		};
	},
);
if (collections.length !== 42)
	throw new Error("Expected 42 legacy collections");
writeFileSync(
	destination,
	`${JSON.stringify({ legacySchemaSha256: createHash("sha256").update(raw).digest("hex"), collections, ouraFiles: values.get("OURA_COLLECTION_FILES") }, null, 2)}\n`,
);
console.log(`Exported ${collections.length} legacy schemas, without data.`);
