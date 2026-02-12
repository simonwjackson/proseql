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

	// ============================================================================
	// Tests — Plugin Validation (Task 10.1-10.5)
	// ============================================================================

	describe("plugin validation", () => {
		it("should fail with PluginError when two plugins register operators with the same name", async () => {
			// Task 10.1: Test operator name conflict between two plugins fails with PluginError
			const duplicateOperator1: CustomOperator = {
				name: "$duplicate",
				types: ["string"],
				evaluate: (fieldValue, operand) => fieldValue === operand,
			};

			const duplicateOperator2: CustomOperator = {
				name: "$duplicate",
				types: ["number"],
				evaluate: (fieldValue, operand) => fieldValue === operand,
			};

			const plugin1 = createOperatorPlugin("plugin-one", duplicateOperator1);
			const plugin2 = createOperatorPlugin("plugin-two", duplicateOperator2);

			const result = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [plugin1, plugin2],
				}).pipe(Effect.flip),
			);

			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.reason).toBe("operator_conflict");
				expect(result.message).toContain("$duplicate");
				expect(result.message).toContain("plugin-one");
			}
		});

		it("should fail with PluginError when operator name conflicts with built-in operator", async () => {
			// Task 10.2: Test operator name conflicting with built-in operator fails with PluginError
			const builtInConflictOperator: CustomOperator = {
				name: "$eq", // $eq is a built-in operator
				types: ["string"],
				evaluate: (fieldValue, operand) => fieldValue === operand,
			};

			const conflictPlugin = createOperatorPlugin(
				"builtin-conflict-plugin",
				builtInConflictOperator,
			);

			const result = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [conflictPlugin],
				}).pipe(Effect.flip),
			);

			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.reason).toBe("operator_conflict");
				expect(result.message).toContain("$eq");
				expect(result.message).toContain("built-in");
			}
		});

		it("should fail with PluginError when plugin has missing dependency", async () => {
			// Task 10.3: Test missing dependency fails with PluginError listing the missing plugin
			const dependentPlugin = createDependentPlugin("dependent-plugin", [
				"non-existent-plugin",
			]);

			const result = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [dependentPlugin],
				}).pipe(Effect.flip),
			);

			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.plugin).toBe("dependent-plugin");
				expect(result.reason).toBe("missing_dependencies");
				expect(result.message).toContain("non-existent-plugin");
			}
		});

		it("should pass validation when plugin dependencies are satisfied", async () => {
			// Task 10.4: Test satisfied dependency passes validation
			const basePlugin = createMinimalPlugin("base-plugin");
			const dependentPlugin = createDependentPlugin("dependent-plugin", [
				"base-plugin",
			]);

			// Order matters: dependent plugin depends on base plugin
			// Both orderings should work since we validate against the full set
			const db = await createDatabaseWithPlugins([basePlugin, dependentPlugin]);

			expect(db).toBeDefined();
			expect(db.books).toBeDefined();

			// Also verify reverse order works (dependency resolution is not order-dependent)
			const db2 = await createDatabaseWithPlugins([dependentPlugin, basePlugin]);

			expect(db2).toBeDefined();
			expect(db2.books).toBeDefined();
		});

		it("should fail with PluginError when codec is missing encode/decode", async () => {
			// Task 10.5: Test invalid codec (missing encode/decode) fails with PluginError

			// Test missing encode
			const codecMissingEncode = {
				name: "broken-codec",
				extensions: [".broken"],
				// missing encode
				decode: () => ({}),
			} as unknown as FormatCodec;

			const pluginMissingEncode = createCodecPlugin("missing-encode-plugin", [
				codecMissingEncode,
			]);

			const resultMissingEncode = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [pluginMissingEncode],
				}).pipe(Effect.flip),
			);

			expect(resultMissingEncode._tag).toBe("PluginError");
			if (resultMissingEncode._tag === "PluginError") {
				expect(resultMissingEncode.reason).toBe("invalid_codec");
				expect(resultMissingEncode.message).toContain("encode");
			}

			// Test missing decode
			const codecMissingDecode = {
				name: "broken-codec",
				extensions: [".broken"],
				encode: () => "",
				// missing decode
			} as unknown as FormatCodec;

			const pluginMissingDecode = createCodecPlugin("missing-decode-plugin", [
				codecMissingDecode,
			]);

			const resultMissingDecode = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [pluginMissingDecode],
				}).pipe(Effect.flip),
			);

			expect(resultMissingDecode._tag).toBe("PluginError");
			if (resultMissingDecode._tag === "PluginError") {
				expect(resultMissingDecode.reason).toBe("invalid_codec");
				expect(resultMissingDecode.message).toContain("decode");
			}

			// Test missing both encode and decode
			const codecMissingBoth = {
				name: "broken-codec",
				extensions: [".broken"],
				// missing both encode and decode
			} as unknown as FormatCodec;

			const pluginMissingBoth = createCodecPlugin("missing-both-plugin", [
				codecMissingBoth,
			]);

			const resultMissingBoth = await Effect.runPromise(
				createEffectDatabase(baseConfig, initialData, {
					plugins: [pluginMissingBoth],
				}).pipe(Effect.flip),
			);

			expect(resultMissingBoth._tag).toBe("PluginError");
			if (resultMissingBoth._tag === "PluginError") {
				expect(resultMissingBoth.reason).toBe("invalid_codec");
				// Should fail on encode first (since it's validated before decode)
				expect(resultMissingBoth.message).toContain("encode");
			}
		});
	});

	// ============================================================================
	// Tests — Custom Codecs (Task 11.1-11.3)
	// ============================================================================

	describe("custom codecs", () => {
		it("should register plugin codec for new extension and serialize/deserialize correctly", async () => {
			// Task 11.1: Test plugin codec registers for new extension,
			// collection with that extension serializes/deserializes correctly
			//
			// We create a simple CSV-like codec that stores data as "id,title,author,year,genre"
			// one line per entry. This is a new extension not built into proseql.

			const csvCodec: FormatCodec = {
				name: "csv",
				extensions: ["csv"],
				encode: (data: unknown): string => {
					// Data is { [id]: entity } object format
					const obj = data as Record<string, Record<string, unknown>>;
					const lines: string[] = [];
					// Header
					lines.push("id,title,author,year,genre");
					// Data rows
					for (const [id, entity] of Object.entries(obj)) {
						const title = String(entity.title ?? "");
						const author = String(entity.author ?? "");
						const year = String(entity.year ?? "");
						const genre = String(entity.genre ?? "");
						lines.push(`${id},${title},${author},${year},${genre}`);
					}
					return lines.join("\n");
				},
				decode: (raw: string): unknown => {
					const lines = raw.trim().split("\n");
					if (lines.length === 0) return {};
					// Skip header
					const dataLines = lines.slice(1);
					const result: Record<string, Record<string, unknown>> = {};
					for (const line of dataLines) {
						if (!line.trim()) continue;
						const [id, title, author, yearStr, genre] = line.split(",");
						result[id] = {
							id,
							title,
							author,
							year: Number.parseInt(yearStr, 10),
							genre,
						};
					}
					return result;
				},
			};

			const csvPlugin = createCodecPlugin("csv-plugin", [csvCodec]);

			// Use in-memory storage and create a persistent database with CSV file
			const store = new Map<string, string>();
			const { makeInMemoryStorageLayer } = await import(
				"../src/storage/in-memory-adapter-layer.js"
			);
			const { makeSerializerLayer } = await import(
				"../src/serializers/format-codec.js"
			);
			const { createPersistentEffectDatabase } = await import(
				"../src/factories/database-effect.js"
			);
			const { Layer } = await import("effect");

			// Create layer with NO base codecs - only the plugin codec will be available
			const baseLayer = Layer.merge(
				makeInMemoryStorageLayer(store),
				makeSerializerLayer([], [csvCodec]), // Empty base codecs, plugin codec provided
			);

			const persistentConfig = {
				books: {
					schema: BookSchema,
					file: "/data/books.csv",
					relationships: {},
				},
			} as const;

			const persistentInitialData = {
				books: [
					{
						id: "b1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
					{
						id: "b2",
						title: "1984",
						author: "George Orwell",
						year: 1949,
						genre: "dystopian",
					},
				],
			};

			// Create the database with plugin
			const db = await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const database = yield* createPersistentEffectDatabase(
								persistentConfig,
								persistentInitialData,
								{ writeDebounce: 10 },
								{ plugins: [csvPlugin] },
							);
							return database;
						}),
					),
					baseLayer,
				),
			);

			// Verify database was created and we can query books
			expect(db).toBeDefined();
			expect(db.books).toBeDefined();

			// Query existing books
			const allBooks = await db.books.query().runPromise;
			expect(allBooks.length).toBe(2);

			// Create a new book
			const newBook = await db.books
				.create({
					id: "b3",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "cyberpunk",
				})
				.runPromise;

			expect(newBook.id).toBe("b3");
			expect(newBook.title).toBe("Neuromancer");

			// Flush to trigger persistence
			await db.flush();

			// Verify the CSV file was written correctly
			const csvContent = store.get("/data/books.csv");
			expect(csvContent).toBeDefined();
			expect(csvContent).toContain("id,title,author,year,genre");
			expect(csvContent).toContain("b1,Dune,Frank Herbert,1965,sci-fi");
			expect(csvContent).toContain("b2,1984,George Orwell,1949,dystopian");
			expect(csvContent).toContain("b3,Neuromancer,William Gibson,1984,cyberpunk");

			// Now test deserialization by creating a new database from the same store
			// This verifies the codec can load the data it wrote
			const db2 = await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							// Don't provide initial data - load from file
							const database = yield* createPersistentEffectDatabase(
								persistentConfig,
								{}, // No initial data - load from CSV file
								{ writeDebounce: 10 },
								{ plugins: [csvPlugin] },
							);
							return database;
						}),
					),
					baseLayer,
				),
			);

			// Verify all 3 books were loaded from the CSV file
			const loadedBooks = await db2.books.query().runPromise;
			expect(loadedBooks.length).toBe(3);

			// Find the specific books to verify data integrity
			const dune = await db2.books.findById("b1").runPromise;
			expect(dune.title).toBe("Dune");
			expect(dune.author).toBe("Frank Herbert");
			expect(dune.year).toBe(1965);

			const neuromancer = await db2.books.findById("b3").runPromise;
			expect(neuromancer.title).toBe("Neuromancer");
			expect(neuromancer.author).toBe("William Gibson");
			expect(neuromancer.year).toBe(1984);
		});

		it("should allow plugin codec to override built-in extension (last wins) and log warning", async () => {
			// Task 11.2: Test plugin codec overrides built-in extension (last wins), warning is logged
			//
			// We create a custom JSON codec that adds a special marker to the output.
			// When we serialize data, the marker presence proves the plugin codec was used.

			// Custom JSON codec that adds a marker to prove it was used
			const customJsonCodec: FormatCodec = {
				name: "custom-json",
				extensions: ["json"], // Same as built-in JSON codec
				encode: (data: unknown): string => {
					// Wrap the data with a marker to prove this codec was used
					const wrapper = {
						__customCodec: true,
						data,
					};
					return JSON.stringify(wrapper, null, 2);
				},
				decode: (raw: string): unknown => {
					const parsed = JSON.parse(raw);
					// If the wrapper exists, unwrap it
					if (
						parsed &&
						typeof parsed === "object" &&
						"__customCodec" in parsed &&
						"data" in parsed
					) {
						return parsed.data;
					}
					// Otherwise, return as-is (for compatibility)
					return parsed;
				},
			};

			const customJsonPlugin = createCodecPlugin("custom-json-plugin", [
				customJsonCodec,
			]);

			// Spy on console.warn to capture the warning
			const warnings: string[] = [];
			const originalWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				warnings.push(args.map(String).join(" "));
			};

			try {
				// Use in-memory storage
				const store = new Map<string, string>();
				const { makeInMemoryStorageLayer } = await import(
					"../src/storage/in-memory-adapter-layer.js"
				);
				const { makeSerializerLayer } = await import(
					"../src/serializers/format-codec.js"
				);
				const { jsonCodec } = await import(
					"../src/serializers/codecs/json.js"
				);
				const { createPersistentEffectDatabase } = await import(
					"../src/factories/database-effect.js"
				);
				const { Layer } = await import("effect");

				// Create layer with base JSON codec AND plugin codec (plugin overrides)
				const baseLayer = Layer.merge(
					makeInMemoryStorageLayer(store),
					makeSerializerLayer([jsonCodec()], [customJsonCodec]),
				);

				const persistentConfig = {
					books: {
						schema: BookSchema,
						file: "/data/books.json", // Use .json extension that will be overridden
						relationships: {},
					},
				} as const;

				const persistentInitialData = {
					books: [
						{
							id: "b1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
						},
					],
				};

				// Create the database with plugin
				const db = await Effect.runPromise(
					Effect.provide(
						Effect.scoped(
							Effect.gen(function* () {
								const database = yield* createPersistentEffectDatabase(
									persistentConfig,
									persistentInitialData,
									{ writeDebounce: 10 },
									{ plugins: [customJsonPlugin] },
								);
								return database;
							}),
						),
						baseLayer,
					),
				);

				// Verify database was created
				expect(db).toBeDefined();
				expect(db.books).toBeDefined();

				// Perform a CRUD operation to trigger persistence scheduling
				await db.books
					.update("b1", { genre: "science-fiction" })
					.runPromise;

				// Flush to trigger persistence
				await db.flush();

				// Verify the custom JSON codec was used (check for wrapper marker)
				const jsonContent = store.get("/data/books.json");
				expect(jsonContent).toBeDefined();

				const parsed = JSON.parse(jsonContent!);
				expect(parsed.__customCodec).toBe(true);
				expect(parsed.data).toBeDefined();

				// Verify the warning was logged about duplicate extension
				expect(warnings.length).toBeGreaterThan(0);
				const duplicateWarning = warnings.find(
					(w) =>
						w.includes("json") &&
						w.includes("overwritten") &&
						w.includes("custom-json"),
				);
				expect(duplicateWarning).toBeDefined();
			} finally {
				// Restore console.warn
				console.warn = originalWarn;
			}
		});

		it("should make all extensions available when multiple plugins provide codecs", async () => {
			// Task 11.3: Test multiple plugins providing codecs, all extensions are available
			//
			// We create two plugins, each providing a different codec for a different extension.
			// Then we create a database with two collections, each using a different extension.
			// Both should work correctly.

			// Plugin 1: Provides a custom CSV-like codec for .csv extension
			const csvCodec: FormatCodec = {
				name: "csv-codec",
				extensions: ["csv"],
				encode: (data: unknown): string => {
					const obj = data as Record<string, Record<string, unknown>>;
					const lines: string[] = [];
					lines.push("id,title,author,year,genre");
					for (const [id, entity] of Object.entries(obj)) {
						const title = String(entity.title ?? "");
						const author = String(entity.author ?? "");
						const year = String(entity.year ?? "");
						const genre = String(entity.genre ?? "");
						lines.push(`${id},${title},${author},${year},${genre}`);
					}
					return lines.join("\n");
				},
				decode: (raw: string): unknown => {
					const lines = raw.trim().split("\n");
					if (lines.length === 0) return {};
					const dataLines = lines.slice(1);
					const result: Record<string, Record<string, unknown>> = {};
					for (const line of dataLines) {
						if (!line.trim()) continue;
						const [id, title, author, yearStr, genre] = line.split(",");
						result[id] = {
							id,
							title,
							author,
							year: Number.parseInt(yearStr, 10),
							genre,
						};
					}
					return result;
				},
			};

			// Plugin 2: Provides a custom TSV (tab-separated) codec for .tsv extension
			const tsvCodec: FormatCodec = {
				name: "tsv-codec",
				extensions: ["tsv"],
				encode: (data: unknown): string => {
					const obj = data as Record<string, Record<string, unknown>>;
					const lines: string[] = [];
					lines.push("id\tname");
					for (const [id, entity] of Object.entries(obj)) {
						const name = String(entity.name ?? "");
						lines.push(`${id}\t${name}`);
					}
					return lines.join("\n");
				},
				decode: (raw: string): unknown => {
					const lines = raw.trim().split("\n");
					if (lines.length === 0) return {};
					const dataLines = lines.slice(1);
					const result: Record<string, Record<string, unknown>> = {};
					for (const line of dataLines) {
						if (!line.trim()) continue;
						const [id, name] = line.split("\t");
						result[id] = { id, name };
					}
					return result;
				},
			};

			const csvPlugin = createCodecPlugin("csv-plugin", [csvCodec]);
			const tsvPlugin = createCodecPlugin("tsv-plugin", [tsvCodec]);

			// Use in-memory storage
			const store = new Map<string, string>();
			const { makeInMemoryStorageLayer } = await import(
				"../src/storage/in-memory-adapter-layer.js"
			);
			const { makeSerializerLayer } = await import(
				"../src/serializers/format-codec.js"
			);
			const { createPersistentEffectDatabase } = await import(
				"../src/factories/database-effect.js"
			);
			const { Layer } = await import("effect");

			// Create layer with BOTH plugin codecs (no base codecs needed)
			const baseLayer = Layer.merge(
				makeInMemoryStorageLayer(store),
				makeSerializerLayer([], [csvCodec, tsvCodec]),
			);

			// Use both extensions in different collections
			const persistentConfig = {
				books: {
					schema: BookSchema,
					file: "/data/books.csv", // Uses CSV codec from first plugin
					relationships: {},
				},
				authors: {
					schema: AuthorSchema,
					file: "/data/authors.tsv", // Uses TSV codec from second plugin
					relationships: {},
				},
			} as const;

			const persistentInitialData = {
				books: [
					{
						id: "b1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
				],
				authors: [{ id: "a1", name: "Frank Herbert" }],
			};

			// Create the database with BOTH plugins
			const db = await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const database = yield* createPersistentEffectDatabase(
								persistentConfig,
								persistentInitialData,
								{ writeDebounce: 10 },
								{ plugins: [csvPlugin, tsvPlugin] },
							);
							return database;
						}),
					),
					baseLayer,
				),
			);

			// Verify database was created with both collections
			expect(db).toBeDefined();
			expect(db.books).toBeDefined();
			expect(db.authors).toBeDefined();

			// Verify we can query both collections
			const books = await db.books.query().runPromise;
			expect(books.length).toBe(1);
			expect(books[0].title).toBe("Dune");

			const authors = await db.authors.query().runPromise;
			expect(authors.length).toBe(1);
			expect(authors[0].name).toBe("Frank Herbert");

			// Create records in both collections
			const newBook = await db.books
				.create({
					id: "b2",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "cyberpunk",
				})
				.runPromise;
			expect(newBook.id).toBe("b2");

			const newAuthor = await db.authors
				.create({
					id: "a2",
					name: "William Gibson",
				})
				.runPromise;
			expect(newAuthor.id).toBe("a2");

			// Flush to trigger persistence
			await db.flush();

			// Verify the CSV file was written with correct format
			const csvContent = store.get("/data/books.csv");
			expect(csvContent).toBeDefined();
			expect(csvContent).toContain("id,title,author,year,genre");
			expect(csvContent).toContain("b1,Dune,Frank Herbert,1965,sci-fi");
			expect(csvContent).toContain("b2,Neuromancer,William Gibson,1984,cyberpunk");

			// Verify the TSV file was written with correct format
			const tsvContent = store.get("/data/authors.tsv");
			expect(tsvContent).toBeDefined();
			expect(tsvContent).toContain("id\tname");
			expect(tsvContent).toContain("a1\tFrank Herbert");
			expect(tsvContent).toContain("a2\tWilliam Gibson");

			// Verify we can load the data back (test deserialization)
			const db2 = await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const database = yield* createPersistentEffectDatabase(
								persistentConfig,
								{}, // No initial data - load from files
								{ writeDebounce: 10 },
								{ plugins: [csvPlugin, tsvPlugin] },
							);
							return database;
						}),
					),
					baseLayer,
				),
			);

			// Verify both collections loaded correctly from their respective formats
			const loadedBooks = await db2.books.query().runPromise;
			expect(loadedBooks.length).toBe(2);

			const loadedAuthors = await db2.authors.query().runPromise;
			expect(loadedAuthors.length).toBe(2);

			// Verify specific data integrity across both formats
			const dune = await db2.books.findById("b1").runPromise;
			expect(dune.title).toBe("Dune");
			expect(dune.year).toBe(1965);

			const herbert = await db2.authors.findById("a1").runPromise;
			expect(herbert.name).toBe("Frank Herbert");
		});
	});
});
