import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import type { DatasetFor } from "../core/types/types";

// Example showing the new object-based select syntax

// Define schemas
const userSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	age: z.number(),
	isActive: z.boolean(),
	companyId: z.string().optional(),
	profileData: z
		.object({
			bio: z.string(),
			website: z.string().optional(),
			socialMedia: z.record(z.string()),
		})
		.optional(),
});

const postSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	publishedAt: z.date(),
	tags: z.array(z.string()),
	metadata: z.object({
		views: z.number(),
		likes: z.number(),
		featured: z.boolean(),
	}),
});

const companySchema = z.object({
	id: z.string(),
	name: z.string(),
	industry: z.string(),
	foundedYear: z.number(),
	employees: z.number(),
});

// Define database configuration with relationships
const config = {
	users: {
		schema: userSchema,
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
			company: {
				type: "ref" as const,
				target: "companies",
				foreignKey: "companyId",
			},
		},
	},
	posts: {
		schema: postSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
	companies: {
		schema: companySchema,
		relationships: {
			employees: {
				type: "inverse" as const,
				target: "users",
				foreignKey: "companyId",
			},
		},
	},
} as const;

// Sample data
const testData: DatasetFor<typeof config> = {
	users: [
		{
			id: "1",
			name: "Alice Johnson",
			email: "alice@techcorp.com",
			age: 30,
			isActive: true,
			companyId: "c1",
			profileData: {
				bio: "Senior developer with expertise in TypeScript and databases",
				website: "https://alice.dev",
				socialMedia: {
					twitter: "@alice_dev",
					linkedin: "alice-johnson-dev",
				},
			},
		},
		{
			id: "2",
			name: "Bob Smith",
			email: "bob@startup.io",
			age: 25,
			isActive: false,
			companyId: "c2",
			profileData: {
				bio: "Full-stack developer and startup enthusiast",
				socialMedia: {
					github: "bobsmith",
				},
			},
		},
	],
	posts: [
		{
			id: "p1",
			title: "Advanced TypeScript Patterns",
			content: "In this post, we explore advanced TypeScript patterns...",
			authorId: "1",
			publishedAt: new Date("2024-01-15"),
			tags: ["typescript", "programming", "patterns"],
			metadata: {
				views: 1250,
				likes: 89,
				featured: true,
			},
		},
		{
			id: "p2",
			title: "Database Design Best Practices",
			content: "Let's discuss the fundamental principles of database design...",
			authorId: "1",
			publishedAt: new Date("2024-02-01"),
			tags: ["database", "design", "sql"],
			metadata: {
				views: 850,
				likes: 45,
				featured: false,
			},
		},
		{
			id: "p3",
			title: "Building Scalable APIs",
			content: "API design is crucial for modern applications...",
			authorId: "2",
			publishedAt: new Date("2024-01-28"),
			tags: ["api", "scalability", "backend"],
			metadata: {
				views: 650,
				likes: 32,
				featured: false,
			},
		},
	],
	companies: [
		{
			id: "c1",
			name: "TechCorp",
			industry: "Technology",
			foundedYear: 2010,
			employees: 150,
		},
		{
			id: "c2",
			name: "StartupIO",
			industry: "Software",
			foundedYear: 2020,
			employees: 12,
		},
	],
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of iterable) {
		results.push(item);
	}
	return results;
}

export async function demonstrateObjectBasedSelect() {
	const db = createDatabase(config, testData);

	console.log("=== Object-Based Select Examples ===\\n");

	// Example 1: Basic object-based field selection
	console.log("1. Basic object-based field selection:");
	const basicSelect = await collect(
		db.users.query({
			select: {
				name: true,
				email: true,
				age: true,
			},
		}),
	);
	console.log("Selected fields: name, email, age");
	console.log(JSON.stringify(basicSelect, null, 2));
	console.log();

	// Example 2: Nested object field selection
	console.log("2. Nested object field selection:");
	const nestedSelect = await collect(
		db.users.query({
			select: {
				name: true,
				profileData: true, // Select entire nested object
			},
		}),
	);
	console.log("Selected fields: name, entire profileData object");
	console.log(JSON.stringify(nestedSelect[0], null, 2));
	console.log();

	// Example 3: Object-based selection with population
	console.log("3. Object-based selection with automatic population:");
	const selectWithPopulation = await collect(
		db.posts.query({
			select: {
				title: true,
				tags: true,
				author: {
					name: true,
					email: true,
				},
			},
		}),
	);
	console.log(
		"Selected: title, tags from post + name, email from populated author",
	);
	console.log(JSON.stringify(selectWithPopulation[0], null, 2));
	console.log();

	// Example 4: Deep nested selection with population
	console.log("4. Deep nested selection with population:");
	const deepNestedSelect = await collect(
		db.posts.query({
			select: {
				title: true,
				metadata: {
					views: true,
					likes: true,
				},
				author: {
					name: true,
					profileData: {
						bio: true,
						socialMedia: true,
					},
				},
			},
		}),
	);
	console.log("Selected: title, metadata subset + author with profile data");
	console.log(JSON.stringify(deepNestedSelect[0], null, 2));
	console.log();

	// Example 5: Comparison with legacy array-based selection
	console.log("5. Object-based selection with minimal fields:");
	const minimalSelect = await collect(
		db.users.query({
			select: { name: true, email: true },
		}),
	);
	console.log("Object-based select: { name: true, email: true }");
	console.log(JSON.stringify(minimalSelect[0], null, 2));
	console.log();

	// Example 6: Complex query with object selection, filtering, and sorting
	console.log(
		"6. Complex query with object selection, filtering, and sorting:",
	);
	const complexQuery = await collect(
		db.posts.query({
			where: {
				"metadata.featured": true,
			},
			select: {
				title: true,
				publishedAt: true,
				metadata: {
					views: true,
					likes: true,
				},
				author: {
					name: true,
				},
			},
			sort: {
				"metadata.views": "desc",
			},
		}),
	);
	console.log(
		"Complex query: featured posts, selected fields, sorted by views",
	);
	console.log(JSON.stringify(complexQuery, null, 2));
	console.log();

	console.log("=== Type Safety Benefits ===");
	console.log("The object-based select syntax provides:");
	console.log("✓ Full type safety with IntelliSense support");
	console.log("✓ Nested field selection for populated relationships");
	console.log("✓ Compile-time validation of field names");
	console.log("✓ Automatic inference of result types");
	console.log("✓ Backward compatibility with array-based selection");
}

// Run the demonstration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	demonstrateObjectBasedSelect().catch(console.error);
}
