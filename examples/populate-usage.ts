/**
 * Example: Using Database v2 with Type-Safe Populate
 *
 * This example demonstrates how to use the populate functionality
 * with full TypeScript type safety.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database";

// ============================================================================
// Define Your Schemas
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	companyId: z.string(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	industry: z.string(),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	createdAt: z.string(),
});

// ============================================================================
// Define Your Configuration
// IMPORTANT: Use 'as const' on target strings to preserve literal types!
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
			posts: { type: "inverse" as const, target: "posts" as const },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users" as const },
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "authorId",
			},
		},
	},
} as const; // <-- Important: 'as const' on the entire config!

// ============================================================================
// Create Your Database
// ============================================================================

const data = {
	users: [
		{ id: "u1", name: "Alice", email: "alice@example.com", companyId: "c1" },
		{ id: "u2", name: "Bob", email: "bob@example.com", companyId: "c1" },
		{
			id: "u3",
			name: "Charlie",
			email: "charlie@example.com",
			companyId: "c2",
		},
	],
	companies: [
		{ id: "c1", name: "TechCorp", industry: "Technology" },
		{ id: "c2", name: "FinanceInc", industry: "Finance" },
	],
	posts: [
		{
			id: "p1",
			title: "Hello World",
			content: "My first post",
			authorId: "u1",
			createdAt: "2024-01-01",
		},
		{
			id: "p2",
			title: "TypeScript Tips",
			content: "Type safety is awesome",
			authorId: "u1",
			createdAt: "2024-01-02",
		},
		{
			id: "p3",
			title: "Database Design",
			content: "Relationships matter",
			authorId: "u2",
			createdAt: "2024-01-03",
		},
	],
};

const db = createDatabase(config, data);

// ============================================================================
// Usage Examples with Full Type Safety
// ============================================================================

async function examples() {
	// 1. Basic query without populate - returns base entity type
	for await (const user of db.users.query({ where: { id: "u1" } })) {
		console.log(user.name); // ✅ Works
		console.log(user.email); // ✅ Works
		// console.log(user.company); // ❌ Type error: Property 'company' does not exist
		// console.log(user.posts); // ❌ Type error: Property 'posts' does not exist
	}

	// 2. Query with single populate - adds the populated field
	for await (const user of db.users.query({
		populate: { company: true },
		where: { id: "u1" },
	})) {
		console.log(user.name); // ✅ Works
		console.log(user.company?.name); // ✅ Works - company is now available
		// console.log(user.posts); // ❌ Type error: 'posts' not populated
	}

	// 3. Query with multiple populate - adds all populated fields
	for await (const user of db.users.query({
		populate: {
			company: true,
			posts: true,
		},
		where: { id: "u1" },
	})) {
		console.log(user.name); // ✅ Works
		console.log(user.company?.name); // ✅ Works
		console.log(user.posts.length); // ✅ Works - posts is an array
		user.posts.forEach((post) => {
			console.log(post.title); // ✅ Full type inference
		});
	}

	// 4. Nested populate - populate relationships of relationships
	for await (const post of db.posts.query({
		populate: {
			author: {
				company: true, // Populate the author's company
				posts: true, // Populate the author's other posts
			},
		},
		where: { id: "p1" },
	})) {
		console.log(post.title); // ✅ Works
		console.log(post.author?.name); // ✅ Works
		console.log(post.author?.company?.name); // ✅ Works - nested populate
		console.log(post.author?.posts.length); // ✅ Works - author's posts
	}

	// 5. Type errors are caught at compile time
	// The following would cause TypeScript errors:

	// db.users.query({
	//   populate: {
	//     invalidField: true // ❌ Type error: 'invalidField' is not a relationship
	//   }
	// });

	// db.users.query({
	//   populate: {
	//     company: {
	//       invalidNested: true // ❌ Type error: 'invalidNested' not on company
	//     }
	//   }
	// });

	// 6. Inverse relationships return arrays
	for await (const company of db.companies.query({
		populate: { employees: true },
	})) {
		console.log(company.name); // ✅ Works
		console.log(company.employees.length); // ✅ Works - array of users
		company.employees.forEach((employee) => {
			console.log(employee.email); // ✅ Full type inference
		});
	}

	// 7. Complex filtering with populated fields
	for await (const user of db.users.query({
		populate: {
			company: true,
			posts: true,
		},
		where: {
			company: {
				industry: "Technology", // Filter by related company's field
			},
		},
	})) {
		console.log(`${user.name} works at ${user.company?.name}`);
		console.log(`They have ${user.posts.length} posts`);
	}
}

// ============================================================================
// Helper Functions with Type Safety
// ============================================================================

// The return type is automatically inferred based on the populate config
async function getUserWithCompany(userId: string) {
	const users = [];
	for await (const user of db.users.query({
		populate: { company: true },
		where: { id: userId },
	})) {
		users.push(user);
	}
	return users[0]; // Type: { id: string; name: string; email: string; companyId: string; company?: Company }
}

// Complex return type with nested populate
async function getPostWithFullAuthor(postId: string) {
	const posts = [];
	for await (const post of db.posts.query({
		populate: {
			author: {
				company: true,
				posts: true,
			},
		},
		where: { id: postId },
	})) {
		posts.push(post);
	}
	return posts[0]; // Return type includes nested populated fields!
}

// Run examples
examples().catch(console.error);
