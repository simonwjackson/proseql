/**
 * Tool definition generators in OpenAI function-calling JSON Schema format.
 */

import type { ToolDefinition } from "./types.js";

const describeDefinition: ToolDefinition = {
	name: "proseql_describe",
	description:
		"Describe the database schema: collections, fields, types, relationships, and available query operators.",
	parameters: {
		type: "object",
		properties: {},
	},
};

const queryDefinition: ToolDefinition = {
	name: "proseql_query",
	description:
		"Query a ProseQL collection with optional filters, sorting, field selection, and pagination.",
	parameters: {
		type: "object",
		properties: {
			collection: {
				type: "string",
				description: "Collection name",
			},
			where: {
				type: "object",
				description:
					"Filter using WhereClause operators (e.g. { age: { $gt: 18 } })",
			},
			sort: {
				type: "object",
				description: 'Sort config, e.g. { "createdAt": "desc" }',
			},
			select: {
				type: "array",
				description: "Fields to include in results",
				items: { type: "string" },
			},
			limit: {
				type: "number",
				description: "Max records to return (default 50)",
			},
			offset: {
				type: "number",
				description: "Skip N records for pagination",
			},
		},
		required: ["collection"],
	},
};

const findByIdDefinition: ToolDefinition = {
	name: "proseql_find_by_id",
	description: "Find a single record by its ID.",
	parameters: {
		type: "object",
		properties: {
			collection: {
				type: "string",
				description: "Collection name",
			},
			id: {
				type: "string",
				description: "The record ID",
			},
		},
		required: ["collection", "id"],
	},
};

const createDefinition: ToolDefinition = {
	name: "proseql_create",
	description: "Create a new record in a collection.",
	parameters: {
		type: "object",
		properties: {
			collection: {
				type: "string",
				description: "Collection name",
			},
			data: {
				type: "object",
				description: "The record data to create",
			},
		},
		required: ["collection", "data"],
	},
};

const updateDefinition: ToolDefinition = {
	name: "proseql_update",
	description: "Update an existing record by ID.",
	parameters: {
		type: "object",
		properties: {
			collection: {
				type: "string",
				description: "Collection name",
			},
			id: {
				type: "string",
				description: "The record ID to update",
			},
			data: {
				type: "object",
				description: "The fields to update",
			},
		},
		required: ["collection", "id", "data"],
	},
};

const deleteDefinition: ToolDefinition = {
	name: "proseql_delete",
	description: "Delete a record by ID.",
	parameters: {
		type: "object",
		properties: {
			collection: {
				type: "string",
				description: "Collection name",
			},
			id: {
				type: "string",
				description: "The record ID to delete",
			},
		},
		required: ["collection", "id"],
	},
};

export function buildReadOnlyDefinitions(): ReadonlyArray<ToolDefinition> {
	return [describeDefinition, queryDefinition, findByIdDefinition];
}

export function buildFullDefinitions(): ReadonlyArray<ToolDefinition> {
	return [
		describeDefinition,
		queryDefinition,
		findByIdDefinition,
		createDefinition,
		updateDefinition,
		deleteDefinition,
	];
}
