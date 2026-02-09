/**
 * Comprehensive persistence usage examples showing different serializers and patterns.
 * This example demonstrates various persistence configurations and error handling strategies.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database.js";
import { createNodeStorageAdapter } from "../core/storage/node-adapter.js";
import {
	defaultJsonSerializer,
	compactJsonSerializer,
} from "../core/serializers/json.js";
import { defaultYamlSerializer } from "../core/serializers/yaml.js";
import { defaultMessagePackSerializer } from "../core/serializers/messagepack.js";
import { createSerializerRegistry } from "../core/utils/file-extensions.js";
import { collect } from "../core/utils/async-iterable.js";
import type { Result } from "../core/errors/legacy.js";
import { SerializationError } from "../core/serializers/types.js";
import { StorageError } from "../core/storage/types.js";

/**
 * Unwraps a Result type, throwing an error if the operation failed
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	// Handle the error case - TypeScript should narrow the type here
	const errorResult = result as Extract<Result<T>, { success: false }>;
	throw new Error(`Operation failed: ${JSON.stringify(errorResult.error)}`);
}

// ============================================================================
// Schema Definitions
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	age: z.number().min(0),
	isActive: z.boolean().default(true),
	preferences: z
		.object({
			theme: z.enum(["light", "dark"]).default("light"),
			notifications: z.boolean().default(true),
			language: z.string().default("en"),
		})
		.default({}),
	metadata: z.record(z.string(), z.unknown()).default({}),
	createdAt: z.date().default(() => new Date()),
	updatedAt: z.date().default(() => new Date()),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	publishedAt: z.date().optional(),
	tags: z.array(z.string()).default([]),
	status: z.enum(["draft", "published", "archived"]).default("draft"),
	metadata: z.record(z.string(), z.unknown()).default({}),
	createdAt: z.date().default(() => new Date()),
	updatedAt: z.date().default(() => new Date()),
});

const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	parentId: z.string().optional(),
	isActive: z.boolean().default(true),
	sortOrder: z.number().default(0),
	metadata: z.record(z.string(), z.unknown()).default({}),
});

type User = z.infer<typeof UserSchema>;
type Post = z.infer<typeof PostSchema>;
type Category = z.infer<typeof CategorySchema>;

// ============================================================================
// Database Configuration Examples
// ============================================================================

/**
 * Configuration using JSON serialization with different formatters
 */
const jsonDbConfig = {
	users: {
		schema: UserSchema,
		file: "./data/json/users.json", // Pretty-formatted JSON
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./data/json/posts-compact.json", // Compact JSON for smaller files
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

/**
 * Configuration using YAML serialization (human-readable)
 */
const yamlDbConfig = {
	users: {
		schema: UserSchema,
		file: "./data/yaml/users.yaml",
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./data/yaml/posts.yml", // Both .yaml and .yml extensions supported
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

/**
 * Configuration using MessagePack serialization (binary, performance)
 */
const messagePackDbConfig = {
	users: {
		schema: UserSchema,
		file: "./data/msgpack/users.msgpack",
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./data/msgpack/posts.mp", // Both .msgpack and .mp extensions supported
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

/**
 * Mixed configuration - some collections persisted, others in-memory
 */
const mixedDbConfig = {
	users: {
		schema: UserSchema,
		file: "./data/mixed/users.json", // Persistent
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./data/mixed/posts.json", // Persistent
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
			category: {
				type: "ref" as const,
				target: "categories",
				foreignKey: "categoryId",
			},
		},
	},
	categories: {
		schema: CategorySchema,
		// No file property = in-memory only
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "categoryId",
			},
			parent: {
				type: "ref" as const,
				target: "categories",
				foreignKey: "parentId",
			},
			children: {
				type: "inverse" as const,
				target: "categories",
				foreignKey: "parentId",
			},
		},
	},
} as const;

// ============================================================================
// Example Functions
// ============================================================================

/**
 * Example 1: Basic JSON persistence with standard and compact serializers
 */
async function jsonPersistenceExample(): Promise<void> {
	console.log("\n🔹 Example 1: JSON Persistence");
	console.log("================================");

	try {
		// Create storage adapter
		const storageAdapter = createNodeStorageAdapter();

		// Create multiple JSON serializers with different formatting
		const prettyJsonSerializer = defaultJsonSerializer; // 2-space indentation
		const compactSerializer = compactJsonSerializer; // No indentation

		// Create registry with both serializers (compact wins for conflicts)
		const serializerRegistry = createSerializerRegistry([
			prettyJsonSerializer,
			compactSerializer,
		]);

		// Create database
		const db = await createDatabase(jsonDbConfig, undefined, {
			persistence: {
				adapter: storageAdapter,
				serializerRegistry,
				writeDebounce: 50,
				watchFiles: true,
			},
		});

		console.log("✅ Database created with JSON persistence");

		// Create sample data
		const alice = unwrapResult(
			await db.users.create({
				name: "Alice Johnson",
				email: "alice@example.com",
				age: 28,
				preferences: {
					theme: "dark",
					notifications: true,
					language: "en",
				},
				metadata: { source: "json-example", version: "1.0" },
			}),
		);

		const post = unwrapResult(
			await db.posts.create({
				title: "Working with JSON Persistence",
				content:
					"This post demonstrates how to use JSON for data persistence...",
				authorId: alice.id,
				tags: ["json", "persistence", "database"],
				status: "published",
				metadata: { featured: true, wordCount: 1500 },
			}),
		);

		console.log("✅ Created user and post with JSON serialization");
		console.log(
			`   Users saved to: ${jsonDbConfig.users.file} (pretty format)`,
		);
		console.log(
			`   Posts saved to: ${jsonDbConfig.posts.file} (compact format)`,
		);

		// Query with relationships
		const postsWithAuthors = await collect(
			db.posts.query({
				populate: { author: true },
			}),
		);

		console.log(
			`📊 Retrieved ${postsWithAuthors.length} posts with populated authors`,
		);

		// Cleanup
		if ("cleanup" in db && typeof db.cleanup === "function") {
			db.cleanup();
		}
	} catch (error) {
		console.error("❌ JSON persistence example failed:", error);
		throw error;
	}
}

/**
 * Example 2: YAML persistence (demonstrates handling missing dependencies)
 */
async function yamlPersistenceExample(): Promise<void> {
	console.log("\n🔹 Example 2: YAML Persistence");
	console.log("===============================");

	try {
		const storageAdapter = createNodeStorageAdapter();

		// Note: This will fail with a helpful error about missing js-yaml dependency
		const yamlSerializer = defaultYamlSerializer;
		const serializerRegistry = createSerializerRegistry([yamlSerializer]);

		const db = await createDatabase(yamlDbConfig, undefined, {
			persistence: {
				adapter: storageAdapter,
				serializerRegistry,
				writeDebounce: 100,
				watchFiles: false, // Disable watching for this example
			},
		});

		console.log("✅ Database created with YAML persistence");

		// This will trigger the serialization error
		await db.users.create({
			name: "Bob Wilson",
			email: "bob@example.com",
			age: 32,
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes("js-yaml")) {
			console.log("⚠️  Expected error: Missing js-yaml dependency");
			console.log("   Install with: npm install js-yaml @types/js-yaml");
			console.log("   This demonstrates proper dependency error handling");
		} else {
			console.error("❌ Unexpected error in YAML example:", error);
			throw error;
		}
	}
}

/**
 * Example 3: MessagePack persistence (demonstrates binary serialization)
 */
async function messagePackPersistenceExample(): Promise<void> {
	console.log("\n🔹 Example 3: MessagePack Persistence");
	console.log("=====================================");

	try {
		const storageAdapter = createNodeStorageAdapter();

		// Note: This will fail with a helpful error about missing msgpackr dependency
		const msgpackSerializer = defaultMessagePackSerializer;
		const serializerRegistry = createSerializerRegistry([msgpackSerializer]);

		const db = await createDatabase(messagePackDbConfig, undefined, {
			persistence: {
				adapter: storageAdapter,
				serializerRegistry,
				writeDebounce: 25, // Faster writes for binary format
				watchFiles: true,
			},
		});

		console.log("✅ Database created with MessagePack persistence");

		// This will trigger the serialization error
		await db.users.create({
			name: "Carol Martinez",
			email: "carol@example.com",
			age: 26,
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes("msgpackr")) {
			console.log("⚠️  Expected error: Missing msgpackr dependency");
			console.log("   Install with: npm install msgpackr");
			console.log(
				"   MessagePack provides excellent performance for binary data",
			);
		} else {
			console.error("❌ Unexpected error in MessagePack example:", error);
			throw error;
		}
	}
}

/**
 * Example 4: Mixed persistence (some collections persisted, others in-memory)
 */
async function mixedPersistenceExample(): Promise<void> {
	console.log("\n🔹 Example 4: Mixed Persistence");
	console.log("===============================");

	try {
		const storageAdapter = createNodeStorageAdapter();
		const jsonSerializer = defaultJsonSerializer;
		const serializerRegistry = createSerializerRegistry([jsonSerializer]);

		const db = await createDatabase(mixedDbConfig, undefined, {
			persistence: {
				adapter: storageAdapter,
				serializerRegistry,
				writeDebounce: 100,
				watchFiles: true,
			},
		});

		console.log("✅ Database created with mixed persistence");

		// Create data in persistent collections
		const user = unwrapResult(
			await db.users.create({
				name: "David Chen",
				email: "david@example.com",
				age: 29,
			}),
		);

		// Create data in in-memory collection (categories)
		const category = unwrapResult(
			await db.categories.create({
				name: "Technology",
				description: "Posts about technology and programming",
				isActive: true,
				sortOrder: 1,
			}),
		);

		const post = unwrapResult(
			await db.posts.create({
				title: "Mixed Persistence Patterns",
				content: "This post demonstrates mixed persistence configurations...",
				authorId: user.id,
				status: "published",
				metadata: { categoryId: category.id }, // Reference to in-memory category
			}),
		);

		console.log("✅ Created data across persistent and in-memory collections");
		console.log("   Users and posts: persisted to files");
		console.log("   Categories: stored in memory only");

		// Query data
		const allUsers = await collect(db.users.query());
		const allPosts = await collect(db.posts.query());
		const allCategories = await collect(db.categories.query());

		console.log(
			`📊 Retrieved: ${allUsers.length} users, ${allPosts.length} posts, ${allCategories.length} categories`,
		);

		// Note: After restart, users and posts will be loaded from files,
		// but categories will be empty (in-memory only)

		if ("cleanup" in db && typeof db.cleanup === "function") {
			db.cleanup();
		}
	} catch (error) {
		console.error("❌ Mixed persistence example failed:", error);
		throw error;
	}
}

/**
 * Example 5: Loading existing data from files
 */
async function loadExistingDataExample(): Promise<void> {
	console.log("\n🔹 Example 5: Loading Existing Data");
	console.log("===================================");

	try {
		const storageAdapter = createNodeStorageAdapter();
		const jsonSerializer = defaultJsonSerializer;
		const serializerRegistry = createSerializerRegistry([jsonSerializer]);

		// Create database without initial data
		// It will automatically load any existing data from files
		const db = await createDatabase(jsonDbConfig, undefined, {
			persistence: {
				adapter: storageAdapter,
				serializerRegistry,
				writeDebounce: 100,
				watchFiles: true,
			},
		});

		console.log("✅ Database created and existing data loaded");

		// Check what data was loaded
		const existingUsers = await collect(db.users.query());
		const existingPosts = await collect(db.posts.query());

		console.log(
			`📊 Loaded from files: ${existingUsers.length} users, ${existingPosts.length} posts`,
		);

		if (existingUsers.length > 0) {
			console.log("   Existing users:");
			for (const user of existingUsers) {
				console.log(`   • ${user.name} (${user.email})`);
			}
		}

		if (existingPosts.length > 0) {
			console.log("   Existing posts:");
			for (const post of existingPosts) {
				console.log(`   • "${post.title}" [${post.status}]`);
			}
		}

		// Add new data to existing
		if (existingUsers.length === 0) {
			console.log("   No existing data found, creating sample data...");

			const newUser = unwrapResult(
				await db.users.create({
					name: "Emma Davis",
					email: "emma@example.com",
					age: 24,
				}),
			);

			console.log(`   Created new user: ${newUser.name}`);
		}

		if ("cleanup" in db && typeof db.cleanup === "function") {
			db.cleanup();
		}
	} catch (error) {
		console.error("❌ Loading existing data example failed:", error);
		throw error;
	}
}

/**
 * Example 6: Error handling patterns
 */
async function errorHandlingExample(): Promise<void> {
	console.log("\n🔹 Example 6: Error Handling Patterns");
	console.log("=====================================");

	try {
		const storageAdapter = createNodeStorageAdapter();
		const jsonSerializer = defaultJsonSerializer;
		const serializerRegistry = createSerializerRegistry([jsonSerializer]);

		// Example of handling various persistence errors
		const testConfig = {
			test: {
				schema: UserSchema,
				file: "/invalid/path/that/should/fail.json", // This will cause storage errors
				relationships: {},
			},
		} as const;

		try {
			const db = await createDatabase(testConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 100,
					watchFiles: false,
				},
			});

			// This should fail due to invalid path
			await db.test.create({
				name: "Test User",
				email: "test@example.com",
				age: 25,
			});
		} catch (error) {
			if (error instanceof StorageError) {
				console.log("⚠️  Caught StorageError:", error.message);
				console.log("   Operation:", error.operation);
				console.log("   File path:", error.path);
			} else if (error instanceof SerializationError) {
				console.log("⚠️  Caught SerializationError:", error.message);
				console.log("   Operation:", error.operation);
			} else {
				console.log("⚠️  Caught unexpected error:", error);
			}
		}

		console.log("✅ Error handling demonstration complete");
	} catch (error) {
		console.error("❌ Error handling example failed:", error);
		throw error;
	}
}

// ============================================================================
// Main Example Runner
// ============================================================================

async function runAllPersistenceExamples(): Promise<void> {
	console.log("🚀 Comprehensive Persistence Usage Examples");
	console.log("============================================");

	try {
		await jsonPersistenceExample();
		await yamlPersistenceExample();
		await messagePackPersistenceExample();
		await mixedPersistenceExample();
		await loadExistingDataExample();
		await errorHandlingExample();

		console.log("\n🎉 All persistence examples completed!");
		console.log("\n📝 Summary of demonstrated features:");
		console.log("   • JSON persistence with different formatters");
		console.log("   • YAML serialization (with dependency error handling)");
		console.log("   • MessagePack binary serialization");
		console.log("   • Mixed persistence (some persistent, some in-memory)");
		console.log("   • Loading existing data from files");
		console.log("   • Comprehensive error handling patterns");
		console.log("\n💡 Tips:");
		console.log("   • Use JSON for human-readable configuration files");
		console.log("   • Use YAML for complex configuration with comments");
		console.log("   • Use MessagePack for high-performance binary storage");
		console.log("   • Mix persistence patterns based on data access patterns");
	} catch (error) {
		console.error("❌ Persistence examples failed:", error);
		process.exit(1);
	}
}

// ============================================================================
// Error Handling
// ============================================================================

async function runExamples(): Promise<void> {
	try {
		await runAllPersistenceExamples();
	} catch (error) {
		console.error("❌ Examples failed:", error);
		process.exit(1);
	}
}

// Run the examples if this module is executed directly
// Note: This check works in ES modules with proper module settings
const isMainModule =
	typeof process !== "undefined" &&
	process.argv.length >= 2 &&
	process.argv[1]?.endsWith("persistence-usage.js");

if (isMainModule) {
	runExamples();
}

export {
	runAllPersistenceExamples,
	jsonPersistenceExample,
	yamlPersistenceExample,
	messagePackPersistenceExample,
	mixedPersistenceExample,
	loadExistingDataExample,
	errorHandlingExample,
};
