/**
 * Example demonstrating sorting functionality in Database v2
 *
 * This example shows how to use the sorting feature with type safety,
 * including basic sorting, multiple field sorting, and relationship sorting.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types";

// Define schemas
const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	revenue: z.number(),
	active: z.boolean(),
	foundedYear: z.number(),
});

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	age: z.number(),
	score: z.number().optional(),
	active: z.boolean(),
	createdAt: z.string(),
	companyId: z.string().optional(),
	role: z.string(),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	likes: z.number(),
	published: z.boolean(),
	publishedAt: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

// Database configuration with relationships
const dbConfig = {
	companies: {
		schema: CompanySchema,
		relationships: {
			users: { type: "inverse" as const, target: "users" },
		},
	},
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" },
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

// Sample data
const data: DatasetFor<typeof dbConfig> = {
	companies: [
		{
			id: "c1",
			name: "TechCorp",
			revenue: 5000000,
			active: true,
			foundedYear: 2010,
		},
		{
			id: "c2",
			name: "StartupHub",
			revenue: 500000,
			active: true,
			foundedYear: 2020,
		},
		{
			id: "c3",
			name: "OldCo",
			revenue: 2000000,
			active: false,
			foundedYear: 1995,
		},
	],
	users: [
		{
			id: "u1",
			name: "Alice Johnson",
			email: "alice@techcorp.com",
			age: 28,
			score: 95,
			active: true,
			createdAt: "2023-01-15T10:00:00Z",
			companyId: "c1",
			role: "developer",
		},
		{
			id: "u2",
			name: "Bob Smith",
			email: "bob@startuphub.com",
			age: 35,
			score: 82,
			active: true,
			createdAt: "2023-03-20T14:30:00Z",
			companyId: "c2",
			role: "manager",
		},
		{
			id: "u3",
			name: "Charlie Brown",
			email: "charlie@oldco.com",
			age: 42,
			score: undefined,
			active: false,
			createdAt: "2022-12-01T08:00:00Z",
			companyId: "c3",
			role: "developer",
		},
		{
			id: "u4",
			name: "Diana Prince",
			email: "diana@techcorp.com",
			age: 31,
			score: 88,
			active: true,
			createdAt: "2023-02-10T11:45:00Z",
			companyId: "c1",
			role: "designer",
		},
		{
			id: "u5",
			name: "Eve Wilson",
			email: "eve@independent.com",
			age: 25,
			score: 76,
			active: true,
			createdAt: "2023-06-05T09:15:00Z",
			companyId: undefined,
			role: "developer",
		},
	],
	posts: [
		{
			id: "p1",
			title: "Getting Started with TypeScript",
			content: "TypeScript is amazing for type safety...",
			authorId: "u1",
			likes: 42,
			published: true,
			publishedAt: "2023-07-01T10:00:00Z",
			tags: ["typescript", "programming"],
		},
		{
			id: "p2",
			title: "Advanced Database Patterns",
			content: "Let's explore some advanced patterns...",
			authorId: "u1",
			likes: 89,
			published: true,
			publishedAt: "2023-07-15T14:00:00Z",
			tags: ["database", "advanced"],
		},
		{
			id: "p3",
			title: "Draft: Future of Web Development",
			content: "This is still a work in progress...",
			authorId: "u2",
			likes: 5,
			published: false,
			publishedAt: undefined,
			tags: ["web", "future"],
		},
		{
			id: "p4",
			title: "Design Systems at Scale",
			content: "Building consistent design systems...",
			authorId: "u4",
			likes: 67,
			published: true,
			publishedAt: "2023-08-01T09:00:00Z",
			tags: ["design", "systems"],
		},
	],
};

async function demonstrateSorting() {
	const db = createDatabase(dbConfig, data);

	console.log("=== Database v2 Sorting Examples ===\n");

	// Example 1: Basic sorting by a single field
	console.log("1. Sort users by name (ascending):");
	const usersByName = await collect(
		db.users.query({
			sort: { name: "asc" },
		}),
	);
	usersByName.forEach((user) => {
		console.log(`   ${user.name} (${user.email})`);
	});

	// Example 2: Sort by numeric field descending
	console.log("\n2. Sort users by score (highest first):");
	const usersByScore = await collect(
		db.users.query({
			where: { score: { $ne: undefined } }, // Filter out users without scores
			sort: { score: "desc" },
		}),
	);
	usersByScore.forEach((user) => {
		console.log(`   ${user.name}: ${user.score} points`);
	});

	// Example 3: Multiple field sorting
	console.log("\n3. Sort users by role, then by age:");
	const usersByRoleAndAge = await collect(
		db.users.query({
			sort: { role: "asc", age: "asc" },
		}),
	);
	usersByRoleAndAge.forEach((user) => {
		console.log(`   ${user.role}: ${user.name} (age ${user.age})`);
	});

	// Example 4: Sort by date field
	console.log("\n4. Sort posts by publication date (newest first):");
	const postsByDate = await collect(
		db.posts.query({
			where: { published: true },
			sort: { publishedAt: "desc" },
		}),
	);
	postsByDate.forEach((post) => {
		console.log(`   ${post.publishedAt}: "${post.title}"`);
	});

	// Example 5: Sort by populated relationship field
	console.log("\n5. Sort users by company name:");
	const usersByCompany = await collect(
		db.users.query({
			populate: { company: true },
			sort: { "company.name": "asc" } as any, // Type assertion needed for relationship paths
		}),
	);
	usersByCompany.forEach((user) => {
		const company = (user as any).company;
		console.log(`   ${user.name} works at ${company?.name || "No Company"}`);
	});

	// Example 6: Complex sorting with relationships
	console.log(
		"\n6. Sort users by company revenue (highest first), then by name:",
	);
	const usersByCompanyRevenue = await collect(
		db.users.query({
			populate: { company: true },
			sort: { "company.revenue": "desc", name: "asc" } as any,
		}),
	);
	usersByCompanyRevenue.forEach((user) => {
		const company = (user as any).company;
		console.log(
			`   ${user.name} - ${company?.name || "No Company"} ($${
				company?.revenue?.toLocaleString() || 0
			})`,
		);
	});

	// Example 7: Sorting with filtering and pagination
	console.log(
		"\n7. Active users sorted by creation date (page 1, 3 per page):",
	);
	const recentActiveUsers = await collect(
		db.users.query({
			where: { active: true },
			sort: { createdAt: "desc" },
			limit: 3,
			offset: 0,
		}),
	);
	recentActiveUsers.forEach((user) => {
		console.log(`   ${user.createdAt}: ${user.name}`);
	});

	// Example 8: Sort posts by author's score (requires nested populate)
	console.log("\n8. Sort posts by author's score:");
	const postsByAuthorScore = await collect(
		db.posts.query({
			populate: { author: true },
			sort: { "author.score": "desc" } as any,
		}),
	);
	postsByAuthorScore.forEach((post) => {
		const author = (post as any).author;
		console.log(
			`   "${post.title}" by ${author?.name} (score: ${author?.score || "N/A"})`,
		);
	});

	// Example 9: Handle undefined values in sorting
	console.log("\n9. Sort users by score (undefined values last):");
	const allUsersByScore = await collect(
		db.users.query({
			sort: { score: "desc" },
		}),
	);
	allUsersByScore.forEach((user) => {
		console.log(`   ${user.name}: ${user.score ?? "No score"}`);
	});

	// Example 10: Sort by boolean field
	console.log("\n10. Sort companies by active status, then by revenue:");
	const companiesByStatus = await collect(
		db.companies.query({
			sort: { active: "desc", revenue: "desc" },
		}),
	);
	companiesByStatus.forEach((company) => {
		console.log(
			`   ${company.name}: ${company.active ? "Active" : "Inactive"} - $${company.revenue.toLocaleString()}`,
		);
	});
}

// Run the demonstration
demonstrateSorting().catch(console.error);
