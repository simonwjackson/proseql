/**
 * Type definitions for AI tool integration.
 * Uses the OpenAI function-calling format, which is also consumed by Anthropic and others.
 */

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: {
		readonly type: "object";
		readonly properties: Record<string, JsonSchemaProperty>;
		readonly required?: ReadonlyArray<string>;
	};
}

export type JsonSchemaProperty = {
	readonly type: string;
	readonly description?: string;
	readonly enum?: ReadonlyArray<string>;
	readonly items?: JsonSchemaProperty;
	readonly properties?: Record<string, JsonSchemaProperty>;
	readonly required?: ReadonlyArray<string>;
};

export interface ProseQLToolKit {
	readonly definitions: ReadonlyArray<ToolDefinition>;
	readonly execute: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<string>;
}

export interface CollectionDescription {
	readonly fields: Record<string, string>;
	readonly relationships: Record<
		string,
		{
			readonly type: "ref" | "inverse";
			readonly target: string;
			readonly foreignKey?: string;
		}
	>;
	readonly searchIndex: ReadonlyArray<string>;
}

export interface SchemaDescription {
	readonly collections: Record<string, CollectionDescription>;
	readonly operators: Record<string, ReadonlyArray<string>>;
}
