/**
 * Plugin System Tests — Task 9.1+
 *
 * Tests for the ProseQL plugin system: registration, validation,
 * custom codecs, operators, ID generators, and global hooks.
 */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/factories/database-effect.js";
import { PluginError } from "../src/errors/plugin-errors.js";
import type {
	CustomIdGenerator,
	CustomOperator,
	GlobalHooksConfig,
	ProseQLPlugin,
} from "../src/plugins/plugin-types.js";
import type { FormatCodec } from "../src/serializers/format-codec.js";

// ============================================================================
// Test Schemas
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type Book = typeof BookSchema.Type;

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

// ============================================================================
// Test Configuration
// ============================================================================

const baseConfig = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {},
	},
} as const;

const initialData = {
	books: [
		{
			id: "b1",
			title: "The Great Gatsby",
			author: "F. Scott Fitzgerald",
			year: 1925,
			genre: "fiction",
		},
		{
			id: "b2",
			title: "1984",
			author: "George Orwell",
			year: 1949,
			genre: "dystopian",
		},
		{
			id: "b3",
			title: "Dune",
			author: "Frank Herbert",
			year: 1965,
			genre: "sci-fi",
		},
	],
	authors: [
		{ id: "a1", name: "F. Scott Fitzgerald" },
		{ id: "a2", name: "George Orwell" },
		{ id: "a3", name: "Frank Herbert" },
	],
};

// ============================================================================
// Test Helpers — Minimal Plugin Factory
// ============================================================================

/**
 * Creates a minimal valid plugin with only a name.
 * Use this as a starting point and add fields as needed.
 */
const createMinimalPlugin = (name: string): ProseQLPlugin => ({
	name,
});

/**
 * Creates a plugin with a custom operator.
 */
const createOperatorPlugin = (
	name: string,
	operator: CustomOperator,
): ProseQLPlugin => ({
	name,
	operators: [operator],
});

/**
 * Creates a plugin with a custom ID generator.
 */
const createIdGeneratorPlugin = (
	name: string,
	generator: CustomIdGenerator,
): ProseQLPlugin => ({
	name,
	idGenerators: [generator],
});

/**
 * Creates a plugin with global hooks.
 */
const createHooksPlugin = (
	name: string,
	hooks: GlobalHooksConfig,
): ProseQLPlugin => ({
	name,
	hooks,
});

/**
 * Creates a plugin with custom codecs.
 */
const createCodecPlugin = (
	name: string,
	codecs: ReadonlyArray<FormatCodec>,
): ProseQLPlugin => ({
	name,
	codecs,
});

/**
 * Creates a plugin with initialize/shutdown lifecycle hooks.
 */
const createLifecyclePlugin = (
	name: string,
	options: {
		readonly initialize?: () => Effect.Effect<void>;
		readonly shutdown?: () => Effect.Effect<void>;
	},
): ProseQLPlugin => ({
	name,
	...options,
});

/**
 * Creates a plugin with dependencies on other plugins.
 */
const createDependentPlugin = (
	name: string,
	dependencies: ReadonlyArray<string>,
): ProseQLPlugin => ({
	name,
	dependencies,
});

/**
 * Creates a full-featured plugin for integration testing.
 */
const createFullPlugin = (
	name: string,
	options: {
		readonly version?: string;
		readonly codecs?: ReadonlyArray<FormatCodec>;
		readonly operators?: ReadonlyArray<CustomOperator>;
		readonly idGenerators?: ReadonlyArray<CustomIdGenerator>;
		readonly hooks?: GlobalHooksConfig;
		readonly dependencies?: ReadonlyArray<string>;
		readonly initialize?: () => Effect.Effect<void>;
		readonly shutdown?: () => Effect.Effect<void>;
	},
): ProseQLPlugin => ({
	name,
	...options,
});

// ============================================================================
// Test Helpers — Common Custom Operators
// ============================================================================

/**
 * A $regex operator for testing custom operator functionality.
 */
const regexOperator: CustomOperator = {
	name: "$regex",
	types: ["string"],
	evaluate: (fieldValue, operand) => {
		if (typeof fieldValue !== "string" || typeof operand !== "string") {
			return false;
		}
		try {
			return new RegExp(operand).test(fieldValue);
		} catch {
			return false;
		}
	},
};

/**
 * A $between operator for testing numeric range queries.
 */
const betweenOperator: CustomOperator = {
	name: "$between",
	types: ["number"],
	evaluate: (fieldValue, operand) => {
		if (typeof fieldValue !== "number") {
			return false;
		}
		if (
			!Array.isArray(operand) ||
			operand.length !== 2 ||
			typeof operand[0] !== "number" ||
			typeof operand[1] !== "number"
		) {
			return false;
		}
		const [min, max] = operand;
		return fieldValue >= min && fieldValue <= max;
	},
};

// ============================================================================
// Test Helpers — Common ID Generators
// ============================================================================

/**
 * A simple counter-based ID generator for testing.
 */
const createCounterGenerator = (prefix: string): CustomIdGenerator => {
	let counter = 0;
	return {
		name: `${prefix}-counter`,
		generate: () => {
			counter += 1;
			return `${prefix}-${counter}`;
		},
	};
};

/**
 * A static ID generator for predictable testing.
 */
const createStaticGenerator = (name: string, id: string): CustomIdGenerator => ({
	name,
	generate: () => id,
});

// ============================================================================
// Test Helpers — Database Creation with Plugins
// ============================================================================

/**
 * Creates a database with the given plugins.
 * Returns both the database and any side effects captured during creation.
 */
const createDatabaseWithPlugins = async (
	plugins: ReadonlyArray<ProseQLPlugin>,
	config = baseConfig,
	data = initialData,
) => {
	const db = await Effect.runPromise(
		createEffectDatabase(config, data, { plugins }),
	);
	return db;
};

// ============================================================================
// Tests — Plugin Registration (Task 9.2-9.6)
// ============================================================================

describe("Plugin System", () => {
	describe("plugin registration", () => {
		it("should register a plugin with no contributions (name only)", async () => {
			// Task 9.2: Test registering a plugin with no contributions (name only) succeeds
			const minimalPlugin = createMinimalPlugin("empty-plugin");

			const db = await createDatabaseWithPlugins([minimalPlugin]);

			expect(db).toBeDefined();
			expect(db.books).toBeDefined();
			expect(db.authors).toBeDefined();
		});

		it("should register multiple plugins and merge all contributions", async () => {
			// Task 9.3: Test registering multiple plugins succeeds, all contributions are merged
			// We need to verify that each plugin's contributions are actually usable

			// Track hook execution
			let hookCalled = false;

			const operatorPlugin = createOperatorPlugin("regex-plugin", regexOperator);
			const generatorPlugin = createIdGeneratorPlugin(
				"counter-plugin",
				createCounterGenerator("test"),
			);
			const hooksPlugin = createHooksPlugin("hooks-plugin", {
				beforeCreate: [
					(ctx) => {
						hookCalled = true;
						return Effect.succeed(ctx.data);
					},
				],
			});

			// Create database with all three plugins
			const db = await createDatabaseWithPlugins([
				operatorPlugin,
				generatorPlugin,
				hooksPlugin,
			]);

			expect(db).toBeDefined();
			expect(db.books).toBeDefined();

			// Verify custom operator is merged and functional
			// The $regex operator should be able to query books
			const regexResults = await db.books
				.query({
					where: { title: { $regex: "^The.*" } } as Record<string, unknown>,
				})
				.runPromise;

			// Should match "The Great Gatsby" but not "1984" or "Dune"
			expect(regexResults.length).toBe(1);
			expect(regexResults[0].title).toBe("The Great Gatsby");

			// Verify global hooks are merged and functional
			// Create a new book to trigger beforeCreate hook
			hookCalled = false;
			await db.books
				.create({
					id: "b4",
					title: "New Book",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			expect(hookCalled).toBe(true);
		});

		it("should run plugin initialize() during database creation", async () => {
			// Task 9.4: Test plugin initialize() runs during database creation
			let initializeCalled = false;

			const lifecyclePlugin = createLifecyclePlugin("lifecycle-plugin", {
				initialize: () =>
					Effect.sync(() => {
						initializeCalled = true;
					}),
			});

			await createDatabaseWithPlugins([lifecyclePlugin]);

			expect(initializeCalled).toBe(true);
		});

		it("should fail with PluginError when plugin has missing name", async () => {
			// Task 9.5: Test plugin with missing name fails with PluginError
			const invalidPlugin = { name: "" } as ProseQLPlugin;

			const result = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [invalidPlugin],
				}).pipe(Effect.flip),
			);

			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.reason).toContain("name");
			}
		});

		it("should fail with PluginError when operator is missing evaluate function", async () => {
			// Task 9.6: Test plugin with malformed operator (missing evaluate) fails with PluginError
			const malformedOperator = {
				name: "$malformed",
				types: ["string"],
				// missing evaluate function
			} as unknown as CustomOperator;

			const invalidPlugin = createOperatorPlugin("invalid-plugin", malformedOperator);

			const result = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [invalidPlugin],
				}).pipe(Effect.flip),
			);

			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.reason).toBe("invalid_operator");
				expect(result.message).toContain("evaluate");
			}
		});
	});
});
