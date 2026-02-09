/**
 * Example demonstrating fully type-safe usage of Database v2
 *
 * This example shows how to use the database without any type casting,
 * unknown types, or type assertions. Everything is inferred from the
 * Zod schemas.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect, map, first } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types";

// Define schemas - these drive all type inference
const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	age: z.number(),
	isActive: z.boolean(),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	likes: z.number(),
	tags: z.array(z.string()),
});

// Database configuration
const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			posts: { type: "inverse" as const, target: "posts" },
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" },
		},
	},
} as const;

// Type-safe data that matches schemas
const data: DatasetFor<typeof dbConfig> = {
	users: [
		{
			id: "u1",
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 28,
			isActive: true,
		},
		{
			id: "u2",
			name: "Bob Smith",
			email: "bob@example.com",
			age: 35,
			isActive: false,
		},
		{
			id: "u3",
			name: "Charlie Brown",
			email: "charlie@example.com",
			age: 42,
			isActive: true,
		},
	],
	posts: [
		{
			id: "p1",
			title: "Getting Started with TypeScript",
			content: "TypeScript is amazing for type safety...",
			authorId: "u1",
			likes: 42,
			tags: ["typescript", "programming", "tutorial"],
		},
		{
			id: "p2",
			title: "Advanced TypeScript Patterns",
			content: "Let's explore some advanced patterns...",
			authorId: "u1",
			likes: 89,
			tags: ["typescript", "advanced", "patterns"],
		},
		{
			id: "p3",
			title: "Introduction to Database Design",
			content: "Database design is crucial for applications...",
			authorId: "u2",
			likes: 23,
			tags: ["database", "design", "tutorial"],
		},
	],
};

async function demonstrateTypeSafety() {
	const db = createDatabase(dbConfig, data);

	console.log("=== Type-Safe Query Examples ===\n");

	// Example 1: Basic query with automatic type inference
	console.log("1. Basic query - all users:");
	const allUsers = await collect(db.users.query());
	// allUsers is User[] - fully typed!
	allUsers.forEach((user) => {
		console.log(`   ${user.name} (${user.email}) - Age: ${user.age}`);
	});

	// Example 2: Filtering with operators - no casting needed
	console.log("\n2. Active users over 30:");
	const activeUsersOver30 = await collect(
		db.users.query({
			where: {
				isActive: true,
				age: { $gt: 30 },
			},
		}),
	);
	activeUsersOver30.forEach((user) => {
		console.log(`   ${user.name} - ${user.age} years old`);
	});

	// Example 3: String operators with type safety
	console.log("\n3. Users with example.com email:");
	const exampleUsers = await collect(
		db.users.query({
			where: {
				email: { $endsWith: "example.com" },
			},
		}),
	);
	console.log(`   Found ${exampleUsers.length} users`);

	// Example 4: Complex filtering on posts
	console.log("\n4. Popular TypeScript posts:");
	const popularTsPosts = await collect(
		db.posts.query({
			where: {
				likes: { $gte: 40 },
				tags: { $contains: "typescript" }, // This would need array operator support
			},
		}),
	);
	popularTsPosts.forEach((post) => {
		console.log(`   "${post.title}" - ${post.likes} likes`);
	});

	// Example 5: Using utility functions with type inference
	console.log("\n5. Extract just post titles:");
	const postTitles = await map(db.posts.query(), (post) => post.title);
	// postTitles is string[] - inferred from the selector function
	postTitles.forEach((title) => console.log(`   - ${title}`));

	// Example 6: Get first matching user
	console.log("\n6. First user named Alice:");
	const alice = await first(
		db.users.query({
			where: { name: { $startsWith: "Alice" } },
		}),
	);
	if (alice) {
		// alice is User | undefined - properly typed
		console.log(`   Found: ${alice.name} (ID: ${alice.id})`);
	}

	// Example 7: Combining multiple operators
	console.log("\n7. Posts with specific criteria:");
	const filteredPosts = await collect(
		db.posts.query({
			where: {
				likes: { $gte: 20, $lte: 50 },
				title: { $contains: "Started" },
			},
		}),
	);
	filteredPosts.forEach((post) => {
		console.log(`   "${post.title}" by author ${post.authorId}`);
	});

	// Type safety benefits:
	// 1. No need to declare result types - they're inferred
	// 2. IntelliSense shows all available fields
	// 3. Typos in field names are caught at compile time
	// 4. Operators are validated based on field types
	// 5. Results are properly typed for safe property access

	// The following would cause TypeScript errors:
	// db.users.query({ where: { unknownField: "value" } }); // Error: unknownField doesn't exist
	// db.users.query({ where: { age: { $startsWith: "30" } } }); // Error: $startsWith not valid for numbers
	// const user = await first(db.users.query());
	// console.log(user.unknownProp); // Error: Property doesn't exist
}

// Run the demonstration
demonstrateTypeSafety().catch(console.error);
