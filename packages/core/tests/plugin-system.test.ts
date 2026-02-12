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

	// ============================================================================
	// Tests — Custom Operators (Task 12.1-12.4)
	// ============================================================================

	describe("custom operators", () => {
		it("should match correctly with custom $regex operator", async () => {
			// Task 12.1: Test custom `$regex` operator: `where: { title: { $regex: "^The.*" } }` matches correctly
			const regexPlugin = createOperatorPlugin("regex-plugin", regexOperator);

			const db = await createDatabaseWithPlugins([regexPlugin]);

			// Query using the custom $regex operator
			// Our test data has: "The Great Gatsby", "1984", "Dune"
			// Only "The Great Gatsby" starts with "The"
			const startsWithThe = await db.books
				.query({
					where: { title: { $regex: "^The.*" } } as Record<string, unknown>,
				})
				.runPromise;

			expect(startsWithThe.length).toBe(1);
			expect(startsWithThe[0].title).toBe("The Great Gatsby");

			// Test another regex pattern: contains numbers
			const containsNumbers = await db.books
				.query({
					where: { title: { $regex: "\\d+" } } as Record<string, unknown>,
				})
				.runPromise;

			expect(containsNumbers.length).toBe(1);
			expect(containsNumbers[0].title).toBe("1984");

			// Test pattern that matches multiple books
			const containsE = await db.books
				.query({
					where: { title: { $regex: "e" } } as Record<string, unknown>,
				})
				.runPromise;

			// "The Great Gatsby" contains 'e', "Dune" contains 'e'
			expect(containsE.length).toBe(2);
			const titles = containsE.map((b) => b.title).sort();
			expect(titles).toEqual(["Dune", "The Great Gatsby"]);

			// Test pattern that matches nothing
			const noMatch = await db.books
				.query({
					where: { title: { $regex: "^ZZZZZ" } } as Record<string, unknown>,
				})
				.runPromise;

			expect(noMatch.length).toBe(0);

			// Test case-insensitive pattern using regex flags
			const caseInsensitive = await db.books
				.query({
					where: { title: { $regex: "^the" } } as Record<string, unknown>,
				})
				.runPromise;

			// Should NOT match because regex is case-sensitive by default
			expect(caseInsensitive.length).toBe(0);

			// Test with explicit case-insensitive flag in the pattern
			const caseInsensitiveWithFlag = await db.books
				.query({
					where: {
						title: { $regex: "(?i)^the" },
					} as Record<string, unknown>,
				})
				.runPromise;

			// JavaScript regex doesn't support inline flags like (?i), so this won't match
			// The $regex operator passes the pattern directly to new RegExp()
			expect(caseInsensitiveWithFlag.length).toBe(0);
		});

		it("should apply type-constrained operator only to matching field types", async () => {
			// Task 12.2: Test custom operator with type constraint: operator declared for
			// "string" only, applied to string field works, applied to number field is ignored
			//
			// The $regex operator is declared with types: ["string"]
			// When applied to a string field (title), it should work
			// When applied to a number field (year), it should be ignored (match everything)

			const regexPlugin = createOperatorPlugin("regex-plugin", regexOperator);
			const db = await createDatabaseWithPlugins([regexPlugin]);

			// Test 1: $regex on string field (title) - should work normally
			const stringFieldMatch = await db.books
				.query({
					where: { title: { $regex: "^The.*" } } as Record<string, unknown>,
				})
				.runPromise;

			expect(stringFieldMatch.length).toBe(1);
			expect(stringFieldMatch[0].title).toBe("The Great Gatsby");

			// Test 2: $regex on number field (year) - should be ignored
			// Since the operator is ignored for number fields, all records match
			const numberFieldMatch = await db.books
				.query({
					where: { year: { $regex: "^19.*" } } as Record<string, unknown>,
				})
				.runPromise;

			// Since $regex is declared for "string" only, it's silently ignored for number fields
			// This means no filter is applied and all 3 books are returned
			expect(numberFieldMatch.length).toBe(3);

			// Test 3: Combine with a built-in operator to verify the type-constraint behavior
			// $regex on number should be ignored, $gte on number should work
			const combinedQuery = await db.books
				.query({
					where: {
						year: {
							$regex: "^19.*", // This is ignored for number fields
							$gte: 1960, // This should work (only Dune with year 1965 matches)
						},
					} as Record<string, unknown>,
				})
				.runPromise;

			// Only Dune (1965) should match the $gte: 1960 filter
			// The $regex is ignored because year is a number, not a string
			expect(combinedQuery.length).toBe(1);
			expect(combinedQuery[0].title).toBe("Dune");
			expect(combinedQuery[0].year).toBe(1965);

			// Test 4: Create a custom operator that supports numbers only
			const numericOnlyOperator: CustomOperator = {
				name: "$isEven",
				types: ["number"], // Only works on numbers
				evaluate: (fieldValue, _operand) => {
					if (typeof fieldValue !== "number") return false;
					return fieldValue % 2 === 0;
				},
			};

			const numericPlugin = createOperatorPlugin("numeric-plugin", numericOnlyOperator);
			const db2 = await createDatabaseWithPlugins([numericPlugin]);

			// Test $isEven on number field (year) - should work
			const evenYears = await db2.books
				.query({
					where: { year: { $isEven: true } } as Record<string, unknown>,
				})
				.runPromise;

			// 1925 is odd, 1949 is odd, 1965 is odd - none are even
			expect(evenYears.length).toBe(0);

			// Test $isEven on string field (genre) - should be ignored
			const evenOnString = await db2.books
				.query({
					where: { genre: { $isEven: true } } as Record<string, unknown>,
				})
				.runPromise;

			// Since $isEven only supports "number", it's ignored for string fields
			// All 3 books are returned
			expect(evenOnString.length).toBe(3);

			// Test 5: Verify boolean fields are handled correctly
			// Create a custom operator that supports booleans
			const boolOnlyOperator: CustomOperator = {
				name: "$isTrue",
				types: ["boolean"],
				evaluate: (fieldValue, _operand) => {
					return fieldValue === true;
				},
			};

			const boolPlugin = createOperatorPlugin("bool-plugin", boolOnlyOperator);
			const db3 = await createDatabaseWithPlugins([boolPlugin]);

			// Apply $isTrue to string field - should be ignored
			const boolOnString = await db3.books
				.query({
					where: { title: { $isTrue: true } } as Record<string, unknown>,
				})
				.runPromise;

			// Since $isTrue only supports "boolean", it's ignored for string fields
			// All 3 books are returned
			expect(boolOnString.length).toBe(3);
		});

		it("should support multiple custom operators from different plugins in same query", async () => {
			// Task 12.3: Test multiple custom operators from different plugins work in same query
			//
			// We register two plugins, each providing a different custom operator:
			// - Plugin 1: $regex operator (string matching)
			// - Plugin 2: $between operator (numeric range)
			//
			// Then we use both operators in the same query to verify they work together.

			const regexPlugin = createOperatorPlugin("regex-plugin", regexOperator);
			const betweenPlugin = createOperatorPlugin("between-plugin", betweenOperator);

			const db = await createDatabaseWithPlugins([regexPlugin, betweenPlugin]);

			// Test 1: Use both custom operators in the same where clause
			// $regex on title (string field) AND $between on year (number field)
			// Our test data:
			// - "The Great Gatsby", 1925, fiction
			// - "1984", 1949, dystopian
			// - "Dune", 1965, sci-fi
			//
			// Query: title contains "e" AND year between 1940 and 1970
			// Expected: "1984" (year 1949, has 'e' in... wait no, 1984 doesn't have 'e')
			// Let's re-check: "The Great Gatsby" has 'e', "Dune" has 'e', "1984" has no 'e'
			// So: title contains 'e' matches Gatsby and Dune
			// year between 1940-1970 matches 1984 (1949) and Dune (1965)
			// Intersection: Dune (1965, contains 'e')

			const combinedQuery = await db.books
				.query({
					where: {
						title: { $regex: "e" },
						year: { $between: [1940, 1970] },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(combinedQuery.length).toBe(1);
			expect(combinedQuery[0].title).toBe("Dune");
			expect(combinedQuery[0].year).toBe(1965);

			// Test 2: Use both operators but with no results matching both
			// $regex for titles starting with "The" AND year between 1960-1980
			// "The Great Gatsby" has year 1925 (outside range)
			// No books match both conditions

			const noMatchQuery = await db.books
				.query({
					where: {
						title: { $regex: "^The" },
						year: { $between: [1960, 1980] },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(noMatchQuery.length).toBe(0);

			// Test 3: Each operator alone returns multiple results, combined returns subset
			// $regex for any title (matches all) AND $between for all years (matches all)
			// Should return all books

			const allMatchQuery = await db.books
				.query({
					where: {
						title: { $regex: ".*" },
						year: { $between: [1900, 2000] },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(allMatchQuery.length).toBe(3);

			// Test 4: Register a third operator and use all three in one query
			const containsDigitOperator: CustomOperator = {
				name: "$hasDigit",
				types: ["string"],
				evaluate: (fieldValue, _operand) => {
					if (typeof fieldValue !== "string") return false;
					return /\d/.test(fieldValue);
				},
			};

			const digitPlugin = createOperatorPlugin("digit-plugin", containsDigitOperator);

			const db2 = await createDatabaseWithPlugins([
				regexPlugin,
				betweenPlugin,
				digitPlugin,
			]);

			// Query using all three custom operators:
			// $regex on genre, $between on year, $hasDigit on title
			// Only "1984" has digits in the title
			// Filter: genre matches ".*", year between 1940-1970, title has digit
			// Expected: "1984" (year 1949, title has digit "1984", genre "dystopian")

			const threeOperatorQuery = await db2.books
				.query({
					where: {
						genre: { $regex: ".*" }, // matches all
						year: { $between: [1940, 1970] }, // matches 1984 (1949) and Dune (1965)
						title: { $hasDigit: true }, // matches only "1984"
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(threeOperatorQuery.length).toBe(1);
			expect(threeOperatorQuery[0].title).toBe("1984");
			expect(threeOperatorQuery[0].year).toBe(1949);
		});

		it("should work with custom operator combined with built-in operators in same where clause", async () => {
			// Task 12.4: Test custom operator combined with built-in operators in same where clause
			//
			// We use the $regex custom operator alongside various built-in operators
			// to verify they all work together correctly with AND logic.

			const regexPlugin = createOperatorPlugin("regex-plugin", regexOperator);
			const db = await createDatabaseWithPlugins([regexPlugin]);

			// Test data:
			// - "The Great Gatsby", 1925, fiction
			// - "1984", 1949, dystopian
			// - "Dune", 1965, sci-fi

			// Test 1: Custom $regex + built-in $gt on different fields
			// Query: title matches regex ".*e.*" AND year > 1940
			// "The Great Gatsby" has 'e' and year 1925 (fails year > 1940)
			// "1984" has no 'e' (fails regex)
			// "Dune" has 'e' and year 1965 (passes both)
			const regexAndGt = await db.books
				.query({
					where: {
						title: { $regex: ".*e.*" },
						year: { $gt: 1940 },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndGt.length).toBe(1);
			expect(regexAndGt[0].title).toBe("Dune");

			// Test 2: Custom $regex + built-in $eq on different fields
			// Query: title matches regex "^D" AND genre equals "sci-fi"
			// Only "Dune" starts with "D" and has genre "sci-fi"
			const regexAndEq = await db.books
				.query({
					where: {
						title: { $regex: "^D" },
						genre: { $eq: "sci-fi" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndEq.length).toBe(1);
			expect(regexAndEq[0].title).toBe("Dune");

			// Test 3: Custom $regex + built-in $in
			// Query: title matches regex ".*" (all) AND genre in ["fiction", "dystopian"]
			// "The Great Gatsby" - genre "fiction" (matches)
			// "1984" - genre "dystopian" (matches)
			// "Dune" - genre "sci-fi" (doesn't match $in)
			const regexAndIn = await db.books
				.query({
					where: {
						title: { $regex: ".*" },
						genre: { $in: ["fiction", "dystopian"] },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndIn.length).toBe(2);
			const genresMatched = regexAndIn.map((b) => b.genre).sort();
			expect(genresMatched).toEqual(["dystopian", "fiction"]);

			// Test 4: Custom $regex + built-in $gte and $lte (range query)
			// Query: title matches "^The" AND year between 1920 and 1930
			// Only "The Great Gatsby" matches both conditions
			const regexAndRange = await db.books
				.query({
					where: {
						title: { $regex: "^The" },
						year: { $gte: 1920, $lte: 1930 },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndRange.length).toBe(1);
			expect(regexAndRange[0].title).toBe("The Great Gatsby");
			expect(regexAndRange[0].year).toBe(1925);

			// Test 5: Custom $regex + built-in $ne
			// Query: title matches "e" AND genre is NOT "fiction"
			// "The Great Gatsby" has 'e' but genre is "fiction" (fails $ne)
			// "Dune" has 'e' and genre is "sci-fi" (passes both)
			const regexAndNe = await db.books
				.query({
					where: {
						title: { $regex: "e" },
						genre: { $ne: "fiction" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndNe.length).toBe(1);
			expect(regexAndNe[0].title).toBe("Dune");

			// Test 6: Custom $regex + built-in $nin
			// Query: title matches ".*" (all) AND genre NOT in ["sci-fi", "dystopian"]
			// Only "The Great Gatsby" with genre "fiction" should match
			const regexAndNin = await db.books
				.query({
					where: {
						title: { $regex: ".*" },
						genre: { $nin: ["sci-fi", "dystopian"] },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndNin.length).toBe(1);
			expect(regexAndNin[0].title).toBe("The Great Gatsby");

			// Test 7: Custom $regex + built-in $contains (string contains)
			// Query: title matches regex "\\d" (has digit) AND author contains "George"
			// Only "1984" has digits in title and author "George Orwell" contains "George"
			const regexAndContains = await db.books
				.query({
					where: {
						title: { $regex: "\\d" },
						author: { $contains: "George" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndContains.length).toBe(1);
			expect(regexAndContains[0].title).toBe("1984");
			expect(regexAndContains[0].author).toBe("George Orwell");

			// Test 8: Custom $regex + built-in $startsWith
			// Query: title matches regex ".*a.*" AND author starts with "F"
			// "The Great Gatsby" has 'a' and author "F. Scott Fitzgerald" starts with 'F'
			// "1984" has no 'a' in title
			// "Dune" has no 'a' in title
			const regexAndStartsWith = await db.books
				.query({
					where: {
						title: { $regex: ".*a.*" },
						author: { $startsWith: "F" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndStartsWith.length).toBe(1);
			expect(regexAndStartsWith[0].title).toBe("The Great Gatsby");

			// Test 9: Multiple built-in operators + custom operator on same field
			// Query: year > 1940, year < 1970, AND title matches "^D"
			// This tests operators on same field (year) combined with custom operator on another
			// "Dune" has year 1965 (between 1940 and 1970) and title starts with "D"
			const multiBuiltInAndCustom = await db.books
				.query({
					where: {
						year: { $gt: 1940, $lt: 1970 },
						title: { $regex: "^D" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(multiBuiltInAndCustom.length).toBe(1);
			expect(multiBuiltInAndCustom[0].title).toBe("Dune");

			// Test 10: Custom $regex + built-in $endsWith on different fields
			// Query: genre ends with "fi" AND title matches regex ".*u.*"
			// "sci-fi" ends with "fi", "Dune" contains 'u'
			const regexAndEndsWith = await db.books
				.query({
					where: {
						genre: { $endsWith: "fi" },
						title: { $regex: ".*u.*" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(regexAndEndsWith.length).toBe(1);
			expect(regexAndEndsWith[0].title).toBe("Dune");
			expect(regexAndEndsWith[0].genre).toBe("sci-fi");

			// Test 11: No results when custom and built-in operators both filter out everything
			// Query: title matches "^Z" (nothing) AND year > 0 (everything)
			const noResults = await db.books
				.query({
					where: {
						title: { $regex: "^Z" },
						year: { $gt: 0 },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(noResults.length).toBe(0);

			// Test 12: Custom operator with multiple built-in operators across many fields
			// Query: title matches regex ".*", genre equals "dystopian", year > 1945, author contains "Orwell"
			// Only "1984" by George Orwell (1949, dystopian) matches all conditions
			const complexQuery = await db.books
				.query({
					where: {
						title: { $regex: ".*" },
						genre: { $eq: "dystopian" },
						year: { $gt: 1945 },
						author: { $contains: "Orwell" },
					} as Record<string, unknown>,
				})
				.runPromise;

			expect(complexQuery.length).toBe(1);
			expect(complexQuery[0].title).toBe("1984");
			expect(complexQuery[0].author).toBe("George Orwell");
			expect(complexQuery[0].year).toBe(1949);
			expect(complexQuery[0].genre).toBe("dystopian");
		});
	});

	// ============================================================================
	// Tests — Global Hooks (Task 14.1-14.5)
	// ============================================================================

	describe("global hooks", () => {
		it("should fire global beforeCreate hook for all collections", async () => {
			// Task 14.1: Test global beforeCreate hook fires for all collections
			//
			// We create a plugin with a global beforeCreate hook that tracks
			// which collections it was called for. Then we create entities in
			// multiple collections (books and authors) and verify the hook
			// was called for BOTH collections.

			// Track hook invocations
			const hookCalls: Array<{ collection: string; data: Record<string, unknown> }> = [];

			const globalHooksPlugin = createHooksPlugin("global-hooks-plugin", {
				beforeCreate: [
					(ctx) => {
						hookCalls.push({
							collection: ctx.collection,
							data: ctx.data as Record<string, unknown>,
						});
						return Effect.succeed(ctx.data);
					},
				],
			});

			const db = await createDatabaseWithPlugins([globalHooksPlugin]);

			// Verify hook hasn't been called yet
			expect(hookCalls.length).toBe(0);

			// Create a book - should trigger global hook for books collection
			const book = await db.books
				.create({
					id: "b-test-1",
					title: "Test Book",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// Verify hook was called for books collection
			expect(hookCalls.length).toBe(1);
			expect(hookCalls[0].collection).toBe("books");
			expect(hookCalls[0].data.title).toBe("Test Book");
			expect(book.title).toBe("Test Book");

			// Create an author - should trigger global hook for authors collection
			const author = await db.authors
				.create({
					id: "a-test-1",
					name: "New Author",
				})
				.runPromise;

			// Verify hook was called for authors collection
			expect(hookCalls.length).toBe(2);
			expect(hookCalls[1].collection).toBe("authors");
			expect(hookCalls[1].data.name).toBe("New Author");
			expect(author.name).toBe("New Author");

			// Create another book - should trigger again for books
			await db.books
				.create({
					id: "b-test-2",
					title: "Another Book",
					author: "Another Author",
					year: 2025,
					genre: "fiction",
				})
				.runPromise;

			// Verify hook was called a third time for books
			expect(hookCalls.length).toBe(3);
			expect(hookCalls[2].collection).toBe("books");
			expect(hookCalls[2].data.title).toBe("Another Book");

			// Verify all collections triggered the hook
			const collections = hookCalls.map((c) => c.collection);
			expect(collections).toContain("books");
			expect(collections).toContain("authors");
			expect(collections.filter((c) => c === "books").length).toBe(2);
			expect(collections.filter((c) => c === "authors").length).toBe(1);
		});

		it("should fire global afterCreate hook for all collections", async () => {
			// Task 14.2: Test global afterCreate hook fires for all collections
			//
			// We create a plugin with a global afterCreate hook that tracks
			// which collections it was called for and the created entities.
			// Then we create entities in multiple collections (books and authors)
			// and verify the hook was called for BOTH collections with the correct
			// entity data (post-creation, including ID).

			// Track hook invocations
			const hookCalls: Array<{
				collection: string;
				entity: Record<string, unknown>;
			}> = [];

			const globalHooksPlugin = createHooksPlugin("global-after-hooks-plugin", {
				afterCreate: [
					(ctx) => {
						hookCalls.push({
							collection: ctx.collection,
							entity: ctx.entity as Record<string, unknown>,
						});
						return Effect.void;
					},
				],
			});

			const db = await createDatabaseWithPlugins([globalHooksPlugin]);

			// Verify hook hasn't been called yet
			expect(hookCalls.length).toBe(0);

			// Create a book - should trigger global afterCreate hook for books collection
			const book = await db.books
				.create({
					id: "b-after-1",
					title: "Test Book After",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// Verify afterCreate hook was called for books collection
			expect(hookCalls.length).toBe(1);
			expect(hookCalls[0].collection).toBe("books");
			expect(hookCalls[0].entity.id).toBe("b-after-1");
			expect(hookCalls[0].entity.title).toBe("Test Book After");
			expect(book.title).toBe("Test Book After");

			// Create an author - should trigger global afterCreate hook for authors collection
			const author = await db.authors
				.create({
					id: "a-after-1",
					name: "New Author After",
				})
				.runPromise;

			// Verify afterCreate hook was called for authors collection
			expect(hookCalls.length).toBe(2);
			expect(hookCalls[1].collection).toBe("authors");
			expect(hookCalls[1].entity.id).toBe("a-after-1");
			expect(hookCalls[1].entity.name).toBe("New Author After");
			expect(author.name).toBe("New Author After");

			// Create another book - should trigger afterCreate again for books
			await db.books
				.create({
					id: "b-after-2",
					title: "Another Book After",
					author: "Another Author",
					year: 2025,
					genre: "fiction",
				})
				.runPromise;

			// Verify afterCreate hook was called a third time for books
			expect(hookCalls.length).toBe(3);
			expect(hookCalls[2].collection).toBe("books");
			expect(hookCalls[2].entity.id).toBe("b-after-2");
			expect(hookCalls[2].entity.title).toBe("Another Book After");

			// Verify all collections triggered the afterCreate hook
			const collections = hookCalls.map((c) => c.collection);
			expect(collections).toContain("books");
			expect(collections).toContain("authors");
			expect(collections.filter((c) => c === "books").length).toBe(2);
			expect(collections.filter((c) => c === "authors").length).toBe(1);

			// Verify the hook received the complete entity (post-creation state)
			// The entity should include the ID and all fields
			const bookHookCalls = hookCalls.filter((c) => c.collection === "books");
			expect(bookHookCalls[0].entity.id).toBe("b-after-1");
			expect(bookHookCalls[0].entity.title).toBe("Test Book After");
			expect(bookHookCalls[0].entity.year).toBe(2024);

			const authorHookCalls = hookCalls.filter((c) => c.collection === "authors");
			expect(authorHookCalls[0].entity.id).toBe("a-after-1");
			expect(authorHookCalls[0].entity.name).toBe("New Author After");
		});

		it("should run global hooks before collection-specific hooks (ordering)", async () => {
			// Task 14.3: Test global hooks run before collection-specific hooks (ordering)
			//
			// We create a plugin with a global beforeCreate hook AND configure
			// collection-specific beforeCreate hooks on the books collection.
			// Both hooks append to a shared array to track execution order.
			// The global hook should run FIRST, then the collection hook.

			// Track hook execution order
			const executionOrder: string[] = [];

			const globalHooksPlugin = createHooksPlugin("global-order-plugin", {
				beforeCreate: [
					(ctx) => {
						executionOrder.push("global-beforeCreate");
						return Effect.succeed(ctx.data);
					},
				],
				afterCreate: [
					() => {
						executionOrder.push("global-afterCreate");
						return Effect.void;
					},
				],
				beforeUpdate: [
					(ctx) => {
						executionOrder.push("global-beforeUpdate");
						return Effect.succeed(ctx.update);
					},
				],
				afterUpdate: [
					() => {
						executionOrder.push("global-afterUpdate");
						return Effect.void;
					},
				],
				beforeDelete: [
					() => {
						executionOrder.push("global-beforeDelete");
						return Effect.void;
					},
				],
				afterDelete: [
					() => {
						executionOrder.push("global-afterDelete");
						return Effect.void;
					},
				],
			});

			// Create config with collection-specific hooks that also track execution
			const configWithHooks = {
				books: {
					schema: BookSchema,
					relationships: {},
					hooks: {
						beforeCreate: [
							(ctx: { data: Book }) => {
								executionOrder.push("collection-beforeCreate");
								return Effect.succeed(ctx.data);
							},
						],
						afterCreate: [
							() => {
								executionOrder.push("collection-afterCreate");
								return Effect.void;
							},
						],
						beforeUpdate: [
							(ctx: { update: Partial<Book> }) => {
								executionOrder.push("collection-beforeUpdate");
								return Effect.succeed(ctx.update);
							},
						],
						afterUpdate: [
							() => {
								executionOrder.push("collection-afterUpdate");
								return Effect.void;
							},
						],
						beforeDelete: [
							() => {
								executionOrder.push("collection-beforeDelete");
								return Effect.void;
							},
						],
						afterDelete: [
							() => {
								executionOrder.push("collection-afterDelete");
								return Effect.void;
							},
						],
					},
				},
			} as const;

			// Create database with plugin and collection hooks
			const db = await Effect.runPromise(
				createEffectDatabase(configWithHooks, { books: [] }, { plugins: [globalHooksPlugin] }),
			);

			// Test 1: CREATE - global beforeCreate should run before collection beforeCreate
			executionOrder.length = 0; // Reset

			await db.books
				.create({
					id: "order-test-1",
					title: "Order Test Book",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// Verify beforeCreate order: global first, then collection
			const createBeforeIndex = executionOrder.indexOf("global-beforeCreate");
			const collectionBeforeIndex = executionOrder.indexOf("collection-beforeCreate");
			expect(createBeforeIndex).toBeLessThan(collectionBeforeIndex);
			expect(executionOrder).toContain("global-beforeCreate");
			expect(executionOrder).toContain("collection-beforeCreate");

			// Verify afterCreate order: global first, then collection
			const createAfterIndex = executionOrder.indexOf("global-afterCreate");
			const collectionAfterIndex = executionOrder.indexOf("collection-afterCreate");
			expect(createAfterIndex).toBeLessThan(collectionAfterIndex);
			expect(executionOrder).toContain("global-afterCreate");
			expect(executionOrder).toContain("collection-afterCreate");

			// Test 2: UPDATE - global beforeUpdate should run before collection beforeUpdate
			executionOrder.length = 0; // Reset

			await db.books
				.update("order-test-1", { genre: "updated" })
				.runPromise;

			// Verify beforeUpdate order: global first, then collection
			const updateBeforeGlobalIndex = executionOrder.indexOf("global-beforeUpdate");
			const updateBeforeCollectionIndex = executionOrder.indexOf("collection-beforeUpdate");
			expect(updateBeforeGlobalIndex).toBeLessThan(updateBeforeCollectionIndex);
			expect(executionOrder).toContain("global-beforeUpdate");
			expect(executionOrder).toContain("collection-beforeUpdate");

			// Verify afterUpdate order: global first, then collection
			const updateAfterGlobalIndex = executionOrder.indexOf("global-afterUpdate");
			const updateAfterCollectionIndex = executionOrder.indexOf("collection-afterUpdate");
			expect(updateAfterGlobalIndex).toBeLessThan(updateAfterCollectionIndex);
			expect(executionOrder).toContain("global-afterUpdate");
			expect(executionOrder).toContain("collection-afterUpdate");

			// Test 3: DELETE - global beforeDelete should run before collection beforeDelete
			executionOrder.length = 0; // Reset

			await db.books.delete("order-test-1").runPromise;

			// Verify beforeDelete order: global first, then collection
			const deleteBeforeGlobalIndex = executionOrder.indexOf("global-beforeDelete");
			const deleteBeforeCollectionIndex = executionOrder.indexOf("collection-beforeDelete");
			expect(deleteBeforeGlobalIndex).toBeLessThan(deleteBeforeCollectionIndex);
			expect(executionOrder).toContain("global-beforeDelete");
			expect(executionOrder).toContain("collection-beforeDelete");

			// Verify afterDelete order: global first, then collection
			const deleteAfterGlobalIndex = executionOrder.indexOf("global-afterDelete");
			const deleteAfterCollectionIndex = executionOrder.indexOf("collection-afterDelete");
			expect(deleteAfterGlobalIndex).toBeLessThan(deleteAfterCollectionIndex);
			expect(executionOrder).toContain("global-afterDelete");
			expect(executionOrder).toContain("collection-afterDelete");
		});

		it("should run multiple plugins' global hooks in plugin registration order", async () => {
			// Task 14.4: Test multiple plugins' global hooks run in plugin registration order
			//
			// We create THREE plugins, each with global hooks that track their execution order.
			// The hooks from plugin1 should run first, then plugin2, then plugin3.
			// This verifies that global hooks from multiple plugins are merged and executed
			// in the order the plugins were registered.

			// Track hook execution order
			const executionOrder: string[] = [];

			// Plugin 1: First registered - should run its hooks first
			const plugin1 = createHooksPlugin("plugin-order-1", {
				beforeCreate: [
					(ctx) => {
						executionOrder.push("plugin1-beforeCreate");
						return Effect.succeed(ctx.data);
					},
				],
				afterCreate: [
					() => {
						executionOrder.push("plugin1-afterCreate");
						return Effect.void;
					},
				],
				beforeUpdate: [
					(ctx) => {
						executionOrder.push("plugin1-beforeUpdate");
						return Effect.succeed(ctx.update);
					},
				],
				afterUpdate: [
					() => {
						executionOrder.push("plugin1-afterUpdate");
						return Effect.void;
					},
				],
				beforeDelete: [
					() => {
						executionOrder.push("plugin1-beforeDelete");
						return Effect.void;
					},
				],
				afterDelete: [
					() => {
						executionOrder.push("plugin1-afterDelete");
						return Effect.void;
					},
				],
			});

			// Plugin 2: Second registered - should run its hooks after plugin1
			const plugin2 = createHooksPlugin("plugin-order-2", {
				beforeCreate: [
					(ctx) => {
						executionOrder.push("plugin2-beforeCreate");
						return Effect.succeed(ctx.data);
					},
				],
				afterCreate: [
					() => {
						executionOrder.push("plugin2-afterCreate");
						return Effect.void;
					},
				],
				beforeUpdate: [
					(ctx) => {
						executionOrder.push("plugin2-beforeUpdate");
						return Effect.succeed(ctx.update);
					},
				],
				afterUpdate: [
					() => {
						executionOrder.push("plugin2-afterUpdate");
						return Effect.void;
					},
				],
				beforeDelete: [
					() => {
						executionOrder.push("plugin2-beforeDelete");
						return Effect.void;
					},
				],
				afterDelete: [
					() => {
						executionOrder.push("plugin2-afterDelete");
						return Effect.void;
					},
				],
			});

			// Plugin 3: Third registered - should run its hooks after plugin1 and plugin2
			const plugin3 = createHooksPlugin("plugin-order-3", {
				beforeCreate: [
					(ctx) => {
						executionOrder.push("plugin3-beforeCreate");
						return Effect.succeed(ctx.data);
					},
				],
				afterCreate: [
					() => {
						executionOrder.push("plugin3-afterCreate");
						return Effect.void;
					},
				],
				beforeUpdate: [
					(ctx) => {
						executionOrder.push("plugin3-beforeUpdate");
						return Effect.succeed(ctx.update);
					},
				],
				afterUpdate: [
					() => {
						executionOrder.push("plugin3-afterUpdate");
						return Effect.void;
					},
				],
				beforeDelete: [
					() => {
						executionOrder.push("plugin3-beforeDelete");
						return Effect.void;
					},
				],
				afterDelete: [
					() => {
						executionOrder.push("plugin3-afterDelete");
						return Effect.void;
					},
				],
			});

			// Create database with plugins in specific order: plugin1, plugin2, plugin3
			const db = await createDatabaseWithPlugins([plugin1, plugin2, plugin3]);

			// Test 1: CREATE - verify beforeCreate and afterCreate hook ordering
			executionOrder.length = 0; // Reset

			await db.books
				.create({
					id: "order-test-1",
					title: "Order Test Book",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// Verify beforeCreate hooks ran in plugin registration order: 1, 2, 3
			const beforeCreate1 = executionOrder.indexOf("plugin1-beforeCreate");
			const beforeCreate2 = executionOrder.indexOf("plugin2-beforeCreate");
			const beforeCreate3 = executionOrder.indexOf("plugin3-beforeCreate");
			expect(beforeCreate1).toBeLessThan(beforeCreate2);
			expect(beforeCreate2).toBeLessThan(beforeCreate3);

			// Verify afterCreate hooks ran in plugin registration order: 1, 2, 3
			const afterCreate1 = executionOrder.indexOf("plugin1-afterCreate");
			const afterCreate2 = executionOrder.indexOf("plugin2-afterCreate");
			const afterCreate3 = executionOrder.indexOf("plugin3-afterCreate");
			expect(afterCreate1).toBeLessThan(afterCreate2);
			expect(afterCreate2).toBeLessThan(afterCreate3);

			// Verify all hooks were called
			expect(executionOrder).toContain("plugin1-beforeCreate");
			expect(executionOrder).toContain("plugin2-beforeCreate");
			expect(executionOrder).toContain("plugin3-beforeCreate");
			expect(executionOrder).toContain("plugin1-afterCreate");
			expect(executionOrder).toContain("plugin2-afterCreate");
			expect(executionOrder).toContain("plugin3-afterCreate");

			// Test 2: UPDATE - verify beforeUpdate and afterUpdate hook ordering
			executionOrder.length = 0; // Reset

			await db.books
				.update("order-test-1", { genre: "updated" })
				.runPromise;

			// Verify beforeUpdate hooks ran in plugin registration order: 1, 2, 3
			const beforeUpdate1 = executionOrder.indexOf("plugin1-beforeUpdate");
			const beforeUpdate2 = executionOrder.indexOf("plugin2-beforeUpdate");
			const beforeUpdate3 = executionOrder.indexOf("plugin3-beforeUpdate");
			expect(beforeUpdate1).toBeLessThan(beforeUpdate2);
			expect(beforeUpdate2).toBeLessThan(beforeUpdate3);

			// Verify afterUpdate hooks ran in plugin registration order: 1, 2, 3
			const afterUpdate1 = executionOrder.indexOf("plugin1-afterUpdate");
			const afterUpdate2 = executionOrder.indexOf("plugin2-afterUpdate");
			const afterUpdate3 = executionOrder.indexOf("plugin3-afterUpdate");
			expect(afterUpdate1).toBeLessThan(afterUpdate2);
			expect(afterUpdate2).toBeLessThan(afterUpdate3);

			// Verify all hooks were called
			expect(executionOrder).toContain("plugin1-beforeUpdate");
			expect(executionOrder).toContain("plugin2-beforeUpdate");
			expect(executionOrder).toContain("plugin3-beforeUpdate");
			expect(executionOrder).toContain("plugin1-afterUpdate");
			expect(executionOrder).toContain("plugin2-afterUpdate");
			expect(executionOrder).toContain("plugin3-afterUpdate");

			// Test 3: DELETE - verify beforeDelete and afterDelete hook ordering
			executionOrder.length = 0; // Reset

			await db.books.delete("order-test-1").runPromise;

			// Verify beforeDelete hooks ran in plugin registration order: 1, 2, 3
			const beforeDelete1 = executionOrder.indexOf("plugin1-beforeDelete");
			const beforeDelete2 = executionOrder.indexOf("plugin2-beforeDelete");
			const beforeDelete3 = executionOrder.indexOf("plugin3-beforeDelete");
			expect(beforeDelete1).toBeLessThan(beforeDelete2);
			expect(beforeDelete2).toBeLessThan(beforeDelete3);

			// Verify afterDelete hooks ran in plugin registration order: 1, 2, 3
			const afterDelete1 = executionOrder.indexOf("plugin1-afterDelete");
			const afterDelete2 = executionOrder.indexOf("plugin2-afterDelete");
			const afterDelete3 = executionOrder.indexOf("plugin3-afterDelete");
			expect(afterDelete1).toBeLessThan(afterDelete2);
			expect(afterDelete2).toBeLessThan(afterDelete3);

			// Verify all hooks were called
			expect(executionOrder).toContain("plugin1-beforeDelete");
			expect(executionOrder).toContain("plugin2-beforeDelete");
			expect(executionOrder).toContain("plugin3-beforeDelete");
			expect(executionOrder).toContain("plugin1-afterDelete");
			expect(executionOrder).toContain("plugin2-afterDelete");
			expect(executionOrder).toContain("plugin3-afterDelete");

			// Test 4: Verify the reverse order also works correctly
			// Register plugins in reverse order and verify hooks run in that order
			const reverseDb = await createDatabaseWithPlugins([plugin3, plugin2, plugin1]);

			executionOrder.length = 0; // Reset

			await reverseDb.books
				.create({
					id: "reverse-test-1",
					title: "Reverse Order Test",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// Now plugin3's hooks should run first, then plugin2, then plugin1
			const reverseBeforeCreate3 = executionOrder.indexOf("plugin3-beforeCreate");
			const reverseBeforeCreate2 = executionOrder.indexOf("plugin2-beforeCreate");
			const reverseBeforeCreate1 = executionOrder.indexOf("plugin1-beforeCreate");
			expect(reverseBeforeCreate3).toBeLessThan(reverseBeforeCreate2);
			expect(reverseBeforeCreate2).toBeLessThan(reverseBeforeCreate1);

			// Verify afterCreate also follows reverse registration order
			const reverseAfterCreate3 = executionOrder.indexOf("plugin3-afterCreate");
			const reverseAfterCreate2 = executionOrder.indexOf("plugin2-afterCreate");
			const reverseAfterCreate1 = executionOrder.indexOf("plugin1-afterCreate");
			expect(reverseAfterCreate3).toBeLessThan(reverseAfterCreate2);
			expect(reverseAfterCreate2).toBeLessThan(reverseAfterCreate1);
		});
	});

	// ============================================================================
	// Tests — Custom ID Generators (Task 13.1-13.4)
	// ============================================================================

	describe("custom ID generators", () => {
		it("should use plugin generator when collection has idGenerator and no id is provided", async () => {
			// Task 13.1: Test collection with `idGenerator: "custom"` uses plugin generator when no id provided
			//
			// We create a plugin with a custom ID generator that produces predictable IDs.
			// Then we configure a collection to use that generator.
			// When we create entities without providing an ID, the generator should be used.

			// Create a counter-based ID generator that produces predictable IDs
			let counter = 0;
			const customGenerator: CustomIdGenerator = {
				name: "test-counter",
				generate: () => {
					counter += 1;
					return `custom-id-${counter}`;
				},
			};

			const generatorPlugin = createIdGeneratorPlugin("id-gen-plugin", customGenerator);

			// Create config that references the custom ID generator
			const configWithIdGenerator = {
				books: {
					schema: BookSchema,
					relationships: {},
					idGenerator: "test-counter", // Reference the plugin's generator
				},
			} as const;

			// Create database with the plugin and custom config
			const db = await Effect.runPromise(
				createEffectDatabase(configWithIdGenerator, { books: [] }, { plugins: [generatorPlugin] }),
			);

			// Reset counter for predictable test results
			counter = 0;

			// Create first book WITHOUT providing an id
			const book1 = await db.books
				.create({
					title: "Book One",
					author: "Author One",
					year: 2024,
					genre: "test",
				} as Parameters<typeof db.books.create>[0])
				.runPromise;

			// The ID should come from the custom generator
			expect(book1.id).toBe("custom-id-1");

			// Create second book WITHOUT providing an id
			const book2 = await db.books
				.create({
					title: "Book Two",
					author: "Author Two",
					year: 2024,
					genre: "test",
				} as Parameters<typeof db.books.create>[0])
				.runPromise;

			// The ID should be the next value from the generator
			expect(book2.id).toBe("custom-id-2");

			// Create third book WITHOUT providing an id
			const book3 = await db.books
				.create({
					title: "Book Three",
					author: "Author Three",
					year: 2024,
					genre: "test",
				} as Parameters<typeof db.books.create>[0])
				.runPromise;

			expect(book3.id).toBe("custom-id-3");

			// Verify all books are in the database with their custom IDs
			const allBooks = await db.books.query().runPromise;
			expect(allBooks.length).toBe(3);

			const ids = allBooks.map((b) => b.id).sort();
			expect(ids).toEqual(["custom-id-1", "custom-id-2", "custom-id-3"]);

			// Verify we can find books by their custom IDs
			const foundBook1 = await db.books.findById("custom-id-1").runPromise;
			expect(foundBook1.title).toBe("Book One");

			const foundBook2 = await db.books.findById("custom-id-2").runPromise;
			expect(foundBook2.title).toBe("Book Two");
		});

		it("should use provided id when explicit, even with idGenerator configured", async () => {
			// Task 13.2: Test collection with `idGenerator: "custom"` still uses provided id when explicit
			//
			// When a collection has an idGenerator configured, but the user provides an explicit ID
			// when creating an entity, the explicit ID should be used instead of the generator.

			// Create a counter-based ID generator
			let counter = 0;
			const customGenerator: CustomIdGenerator = {
				name: "test-counter-explicit",
				generate: () => {
					counter += 1;
					return `generated-id-${counter}`;
				},
			};

			const generatorPlugin = createIdGeneratorPlugin("id-gen-explicit-plugin", customGenerator);

			// Create config that references the custom ID generator
			const configWithIdGenerator = {
				books: {
					schema: BookSchema,
					relationships: {},
					idGenerator: "test-counter-explicit", // Reference the plugin's generator
				},
			} as const;

			// Create database with the plugin
			const db = await Effect.runPromise(
				createEffectDatabase(configWithIdGenerator, { books: [] }, { plugins: [generatorPlugin] }),
			);

			// Reset counter
			counter = 0;

			// Create a book WITH an explicit id - should use the provided id, not the generator
			const book1 = await db.books
				.create({
					id: "my-explicit-id-1",
					title: "Book With Explicit ID",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			// The explicit ID should be used, not the generator
			expect(book1.id).toBe("my-explicit-id-1");
			// Counter should still be 0 because generator was not called
			expect(counter).toBe(0);

			// Create another book WITHOUT an id - should use the generator
			const book2 = await db.books
				.create({
					title: "Book Without ID",
					author: "Test Author",
					year: 2024,
					genre: "test",
				} as Parameters<typeof db.books.create>[0])
				.runPromise;

			// This one should use the generator
			expect(book2.id).toBe("generated-id-1");
			expect(counter).toBe(1);

			// Create another book WITH an explicit id - should use provided id
			const book3 = await db.books
				.create({
					id: "my-explicit-id-2",
					title: "Another Explicit ID Book",
					author: "Test Author",
					year: 2024,
					genre: "test",
				})
				.runPromise;

			expect(book3.id).toBe("my-explicit-id-2");
			// Counter should still be 1 because generator was not called again
			expect(counter).toBe(1);

			// Verify all books are in the database with correct IDs
			const allBooks = await db.books.query().runPromise;
			expect(allBooks.length).toBe(3);

			const ids = allBooks.map((b) => b.id).sort();
			expect(ids).toEqual(["generated-id-1", "my-explicit-id-1", "my-explicit-id-2"]);

			// Verify we can find books by their IDs
			const foundExplicit = await db.books.findById("my-explicit-id-1").runPromise;
			expect(foundExplicit.title).toBe("Book With Explicit ID");

			const foundGenerated = await db.books.findById("generated-id-1").runPromise;
			expect(foundGenerated.title).toBe("Book Without ID");
		});

		it("should fail at init with PluginError when referencing non-existent idGenerator", async () => {
			// Task 13.3: Test referencing non-existent idGenerator name fails at init with PluginError
			//
			// When a collection config references an idGenerator name that doesn't exist in
			// any registered plugin, the database creation should fail with a PluginError
			// at init time (before any collections are built).

			// Create config that references an idGenerator that doesn't exist
			const configWithMissingGenerator = {
				books: {
					schema: BookSchema,
					relationships: {},
					idGenerator: "non-existent-generator", // This generator is not registered
				},
			} as const;

			// Try to create database WITHOUT registering a plugin that provides this generator
			const result = await Effect.runPromise(
				createEffectDatabase(configWithMissingGenerator, { books: [] }, { plugins: [] }).pipe(
					Effect.flip,
				),
			);

			// Should fail with PluginError
			expect(result._tag).toBe("PluginError");
			if (result._tag === "PluginError") {
				expect(result.reason).toBe("missing_id_generator");
				expect(result.message).toContain("non-existent-generator");
				expect(result.message).toContain("books");
				expect(result.message).toContain("not registered");
			}
		});

		it("should use generator per entity when createMany is called", async () => {
			// Task 13.4: Test createMany uses generator per entity
			//
			// When using createMany with a custom ID generator, the generator should be
			// called once for each entity that doesn't have an explicit ID. This test
			// verifies that:
			// 1. Each entity gets a unique ID from the generator
			// 2. Entities with explicit IDs use those IDs instead
			// 3. The generator is called the correct number of times

			// Create a counter-based ID generator that produces predictable IDs
			let counter = 0;
			const customGenerator: CustomIdGenerator = {
				name: "batch-counter",
				generate: () => {
					counter += 1;
					return `batch-id-${counter}`;
				},
			};

			const generatorPlugin = createIdGeneratorPlugin("batch-gen-plugin", customGenerator);

			// Create config that references the custom ID generator
			const configWithIdGenerator = {
				books: {
					schema: BookSchema,
					relationships: {},
					idGenerator: "batch-counter",
				},
			} as const;

			// Create database with the plugin
			const db = await Effect.runPromise(
				createEffectDatabase(configWithIdGenerator, { books: [] }, { plugins: [generatorPlugin] }),
			);

			// Reset counter for predictable test results
			counter = 0;

			// Test 1: createMany with all entities missing IDs
			// Generator should be called 3 times, once per entity
			const result1 = await db.books
				.createMany([
					{
						title: "Book One",
						author: "Author One",
						year: 2024,
						genre: "test",
					} as Parameters<typeof db.books.create>[0],
					{
						title: "Book Two",
						author: "Author Two",
						year: 2024,
						genre: "test",
					} as Parameters<typeof db.books.create>[0],
					{
						title: "Book Three",
						author: "Author Three",
						year: 2024,
						genre: "test",
					} as Parameters<typeof db.books.create>[0],
				])
				.runPromise;

			// Verify 3 books were created
			expect(result1.created.length).toBe(3);

			// Verify each book got a unique ID from the generator
			const ids1 = result1.created.map((b) => b.id).sort();
			expect(ids1).toEqual(["batch-id-1", "batch-id-2", "batch-id-3"]);

			// Verify the counter was incremented 3 times
			expect(counter).toBe(3);

			// Verify each book can be found by its ID
			const foundBook1 = await db.books.findById("batch-id-1").runPromise;
			expect(foundBook1.title).toBe("Book One");

			const foundBook2 = await db.books.findById("batch-id-2").runPromise;
			expect(foundBook2.title).toBe("Book Two");

			const foundBook3 = await db.books.findById("batch-id-3").runPromise;
			expect(foundBook3.title).toBe("Book Three");

			// Test 2: createMany with a mix of explicit IDs and missing IDs
			// Only entities without IDs should use the generator
			const result2 = await db.books
				.createMany([
					{
						id: "explicit-id-1", // Explicit ID - should use this
						title: "Book Four",
						author: "Author Four",
						year: 2024,
						genre: "test",
					},
					{
						title: "Book Five", // No ID - should use generator
						author: "Author Five",
						year: 2024,
						genre: "test",
					} as Parameters<typeof db.books.create>[0],
					{
						id: "explicit-id-2", // Explicit ID - should use this
						title: "Book Six",
						author: "Author Six",
						year: 2024,
						genre: "test",
					},
					{
						title: "Book Seven", // No ID - should use generator
						author: "Author Seven",
						year: 2024,
						genre: "test",
					} as Parameters<typeof db.books.create>[0],
				])
				.runPromise;

			// Verify 4 books were created
			expect(result2.created.length).toBe(4);

			// Counter should have been incremented 2 more times (for books 5 and 7)
			expect(counter).toBe(5);

			// Verify the IDs are correct - explicit IDs used where provided,
			// generator used where not provided
			const ids2 = result2.created.map((b) => b.id).sort();
			expect(ids2).toEqual([
				"batch-id-4",
				"batch-id-5",
				"explicit-id-1",
				"explicit-id-2",
			]);

			// Verify books with explicit IDs have correct titles
			const foundExplicit1 = await db.books.findById("explicit-id-1").runPromise;
			expect(foundExplicit1.title).toBe("Book Four");

			const foundExplicit2 = await db.books.findById("explicit-id-2").runPromise;
			expect(foundExplicit2.title).toBe("Book Six");

			// Verify books with generated IDs have correct titles
			const foundGenerated4 = await db.books.findById("batch-id-4").runPromise;
			expect(foundGenerated4.title).toBe("Book Five");

			const foundGenerated5 = await db.books.findById("batch-id-5").runPromise;
			expect(foundGenerated5.title).toBe("Book Seven");

			// Test 3: createMany with all explicit IDs - generator should not be called
			const counterBefore = counter;
			const result3 = await db.books
				.createMany([
					{
						id: "explicit-id-3",
						title: "Book Eight",
						author: "Author Eight",
						year: 2024,
						genre: "test",
					},
					{
						id: "explicit-id-4",
						title: "Book Nine",
						author: "Author Nine",
						year: 2024,
						genre: "test",
					},
				])
				.runPromise;

			// Verify 2 books were created
			expect(result3.created.length).toBe(2);

			// Counter should NOT have been incremented
			expect(counter).toBe(counterBefore);

			// Verify the explicit IDs were used
			const ids3 = result3.created.map((b) => b.id).sort();
			expect(ids3).toEqual(["explicit-id-3", "explicit-id-4"]);

			// Final verification: query all books to ensure total count is correct
			const allBooks = await db.books.query().runPromise;
			expect(allBooks.length).toBe(9); // 3 + 4 + 2
		});
	});
});
