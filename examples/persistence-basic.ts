/**
 * Basic persistence example showing how to use the database with file-based storage.
 * This example demonstrates JSON persistence with automatic saving and loading.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database.js";
import { createNodeStorageAdapter } from "../core/storage/node-adapter.js";
import { createJsonSerializer } from "../core/serializers/json.js";
import { createSerializerRegistry } from "../core/utils/file-extensions.js";
import { collect } from "../core/utils/async-iterable.js";
import type { Result } from "../core/errors/crud-errors.js";

/**
 * Unwraps a Result type, throwing an error if the operation failed
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
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
	createdAt: z.preprocess((arg) => {
		if (typeof arg === "string") return new Date(arg);
		if (arg instanceof Date) return arg;
		return new Date();
	}, z.date()),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	publishedAt: z.preprocess((arg) => {
		if (typeof arg === "string") return new Date(arg);
		if (arg instanceof Date) return arg;
		return undefined;
	}, z.date()).optional(),
	tags: z.array(z.string()).default([]),
});

type User = z.infer<typeof UserSchema>;
type Post = z.infer<typeof PostSchema>;

// ============================================================================
// Database Configuration with Persistence
// ============================================================================

const dbConfig = {
	users: {
		schema: UserSchema,
		file: "./data/users.json", // Users will be persisted to this file
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
		file: "./data/posts.json", // Posts will be persisted to this file
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

// ============================================================================
// Main Example
// ============================================================================

async function basicPersistenceExample(): Promise<void> {
	console.log("🚀 Basic Persistence Example");
	console.log("=============================");

	// Create persistence configuration
	const storageAdapter = createNodeStorageAdapter();
	const jsonSerializer = createJsonSerializer({
		reviver: (key: string, value: unknown) => {
			// Convert ISO date strings back to Date objects
			if (typeof value === "string" && key.endsWith("At") && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
				return new Date(value);
			}
			return value;
		}
	});
	const serializerRegistry = createSerializerRegistry([jsonSerializer]);

	// Create database with persistence
	const db = await createDatabase(dbConfig, undefined, {
		persistence: {
			adapter: storageAdapter,
			serializerRegistry,
			writeDebounce: 50, // Shorter debounce for demo
			watchFiles: true, // Watch files for external changes
		},
	});

	console.log("✅ Database created with persistence enabled");

	// ============================================================================
	// Create Users (automatically persisted)
	// ============================================================================

	console.log("\n📝 Creating users...");

	const alice = unwrapResult(
		await db.users.create({
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 28,
		}),
	);

	const bob = unwrapResult(
		await db.users.create({
			name: "Bob Smith",
			email: "bob@example.com",
			age: 35,
		}),
	);

	console.log("✅ Created users:", alice.name, "and", bob.name);
	console.log("   Data automatically saved to ./data/users.json");

	// ============================================================================
	// Create Posts (automatically persisted)
	// ============================================================================

	console.log("\n📄 Creating posts...");

	const post1 = unwrapResult(
		await db.posts.create({
			title: "Getting Started with TypeScript",
			content:
				"TypeScript is a powerful language that adds static typing to JavaScript...",
			authorId: alice.id,
			tags: ["typescript", "javascript", "programming"],
		}),
	);

	const post2 = unwrapResult(
		await db.posts.create({
			title: "Database Design Best Practices",
			content:
				"When designing databases, it's important to consider normalization...",
			authorId: bob.id,
			tags: ["database", "design", "best-practices"],
		}),
	);

	console.log("✅ Created posts:", post1.title, "and", post2.title);
	console.log("   Data automatically saved to ./data/posts.json");

	// ============================================================================
	// Query Data (loaded from files if available)
	// ============================================================================

	console.log("\n🔍 Querying data...");

	// Query all users
	const allUsers = await collect(db.users.query());
	console.log(`📊 Found ${allUsers.length} users`);

	// Query posts with populated authors
	const postsWithAuthors = await collect(
		db.posts.query({
			populate: {
				author: true,
			},
		}),
	);

	console.log(`📊 Found ${postsWithAuthors.length} posts with authors:`);
	for (const post of postsWithAuthors) {
		console.log(`   • "${post.title}" by ${post.author?.name}`);
	}

	// ============================================================================
	// Update Data (automatically persisted)
	// ============================================================================

	console.log("\n✏️ Updating data...");

	await db.users.update(alice.id, {
		age: 29, // Alice had a birthday
	});

	console.log("✅ Updated Alice's age");
	console.log("   Changes automatically saved to ./data/users.json");

	// ============================================================================
	// Filter and Search
	// ============================================================================

	console.log("\n🔎 Filtering data...");

	// Find posts by tag
	const typescriptPosts = await collect(
		db.posts.query({
			where: {
				tags: { $contains: "typescript" },
			},
		}),
	);

	console.log(`📊 Found ${typescriptPosts.length} TypeScript posts`);

	// Find active users over 30
	const matureUsers = await collect(
		db.users.query({
			where: {
				age: { $gte: 30 },
				isActive: true,
			},
		}),
	);

	console.log(`📊 Found ${matureUsers.length} active users over 30`);

	// ============================================================================
	// Cleanup
	// ============================================================================

	console.log("\n🧹 Cleaning up...");

	// Wait a bit to ensure all debounced writes complete
	await new Promise(resolve => setTimeout(resolve, 200));

	// Stop file watching and cleanup resources
	if ("cleanup" in db && typeof db.cleanup === "function") {
		db.cleanup();
	}

	console.log("✅ Cleanup complete");
	console.log("\n💾 All data has been persisted to files:");
	console.log("   • ./data/users.json");
	console.log("   • ./data/posts.json");
	console.log("\n🎉 Basic persistence example complete!");
}

// ============================================================================
// Error Handling
// ============================================================================

async function runExample(): Promise<void> {
	try {
		await basicPersistenceExample();
	} catch (error) {
		console.error("❌ Example failed:", error);
		process.exit(1);
	}
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
	runExample();
}

export { basicPersistenceExample };
