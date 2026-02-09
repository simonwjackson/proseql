import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect, map, first, count } from "../core/utils/async-iterable.js";

describe("Database v2 - Sorting", () => {
	// ============================================================================
	// Test Schemas and Configuration
	// ============================================================================

	// User Schema with various field types for sorting
	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		age: z.number(),
		score: z.number().optional(),
		active: z.boolean(),
		createdAt: z.string(), // ISO date string
		companyId: z.string().optional(),
		role: z.string(),
	});

	// Company Schema for relationship sorting
	const CompanySchema = z.object({
		id: z.string(),
		name: z.string(),
		revenue: z.number(),
		foundedYear: z.number(),
		active: z.boolean(),
	});

	// Post Schema for additional sorting scenarios
	const PostSchema = z.object({
		id: z.string(),
		title: z.string(),
		content: z.string(),
		authorId: z.string(),
		likes: z.number(),
		published: z.boolean(),
		publishedAt: z.string().optional(), // ISO date string
		tags: z.array(z.string()).optional(),
	});

	// Configuration with relationships
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
				users: { type: "inverse" as const, target: "users" as const },
			},
		},
		posts: {
			schema: PostSchema,
			relationships: {
				author: { type: "ref" as const, target: "users" as const },
			},
		},
	};

	// Test data
	const data = {
		companies: [
			{
				id: "c1",
				name: "Tech Corp",
				revenue: 1000000,
				foundedYear: 2010,
				active: true,
			},
			{
				id: "c2",
				name: "Design Studio",
				revenue: 500000,
				foundedYear: 2015,
				active: true,
			},
			{
				id: "c3",
				name: "Old Industries",
				revenue: 2000000,
				foundedYear: 1995,
				active: false,
			},
			{
				id: "c4",
				name: "Startup Inc",
				revenue: 100000,
				foundedYear: 2023,
				active: true,
			},
		],
		users: [
			{
				id: "u1",
				name: "Alice Johnson",
				email: "alice@example.com",
				age: 30,
				score: 95,
				active: true,
				createdAt: "2023-01-15T10:00:00Z",
				companyId: "c1",
				role: "admin",
			},
			{
				id: "u2",
				name: "Bob Smith",
				email: "bob@example.com",
				age: 25,
				score: 82,
				active: true,
				createdAt: "2023-02-20T14:30:00Z",
				companyId: "c2",
				role: "user",
			},
			{
				id: "u3",
				name: "Charlie Brown",
				email: "charlie@example.com",
				age: 35,
				score: undefined,
				active: false,
				createdAt: "2023-01-10T08:00:00Z",
				companyId: "c3",
				role: "moderator",
			},
			{
				id: "u4",
				name: "Diana Prince",
				email: "diana@example.com",
				age: 28,
				score: 90,
				active: true,
				createdAt: "2023-03-05T16:45:00Z",
				companyId: "c1",
				role: "user",
			},
			{
				id: "u5",
				name: "Eve Wilson",
				email: "eve@example.com",
				age: 32,
				score: 88,
				active: true,
				createdAt: "2023-02-01T12:00:00Z",
				companyId: undefined,
				role: "admin",
			},
			{
				id: "u6",
				name: "Frank Miller",
				email: "frank@example.com",
				age: 25,
				score: 75,
				active: false,
				createdAt: "2023-01-20T09:30:00Z",
				companyId: "c4",
				role: "user",
			},
		],
		posts: [
			{
				id: "p1",
				title: "Getting Started with TypeScript",
				content: "TypeScript is amazing...",
				authorId: "u1",
				likes: 42,
				published: true,
				publishedAt: "2023-04-01T10:00:00Z",
				tags: ["typescript", "programming"],
			},
			{
				id: "p2",
				title: "Advanced React Patterns",
				content: "Let's explore advanced patterns...",
				authorId: "u1",
				likes: 38,
				published: true,
				publishedAt: "2023-04-15T14:00:00Z",
				tags: ["react", "javascript"],
			},
			{
				id: "p3",
				title: "Draft: CSS Grid Layout",
				content: "Work in progress...",
				authorId: "u2",
				likes: 5,
				published: false,
				publishedAt: undefined,
				tags: ["css"],
			},
			{
				id: "p4",
				title: "Database Design Best Practices",
				content: "When designing databases...",
				authorId: "u3",
				likes: 28,
				published: true,
				publishedAt: "2023-03-20T11:30:00Z",
				tags: ["database", "sql"],
			},
			{
				id: "p5",
				title: "Microservices Architecture",
				content: "Breaking down monoliths...",
				authorId: "u4",
				likes: 65,
				published: true,
				publishedAt: "2023-05-01T09:00:00Z",
				tags: ["architecture", "microservices"],
			},
			{
				id: "p6",
				title: "Draft: AI and Machine Learning",
				content: "The future of AI...",
				authorId: "u5",
				likes: 12,
				published: false,
				publishedAt: undefined,
				tags: [],
			},
		],
	};

	// ============================================================================
	// Basic Sorting Tests
	// ============================================================================

	describe("Basic field sorting", () => {
		it("should sort by string field ascending", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { name: "asc" },
				}),
			);

			expect(results).toHaveLength(6);
			const names = results.map((r) => r.name);
			expect(names).toEqual([
				"Alice Johnson",
				"Bob Smith",
				"Charlie Brown",
				"Diana Prince",
				"Eve Wilson",
				"Frank Miller",
			]);
		});

		it("should sort by string field descending", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { name: "desc" },
				}),
			);

			expect(results).toHaveLength(6);
			const names = results.map((r) => r.name);
			expect(names).toEqual([
				"Frank Miller",
				"Eve Wilson",
				"Diana Prince",
				"Charlie Brown",
				"Bob Smith",
				"Alice Johnson",
			]);
		});

		it("should sort by number field ascending", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { age: "asc" },
				}),
			);

			expect(results).toHaveLength(6);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([25, 25, 28, 30, 32, 35]);

			// Verify stable sort - users with same age maintain order
			const sameAgeUsers = results.filter((r) => r.age === 25);
			expect(sameAgeUsers[0].name).toBe("Bob Smith");
			expect(sameAgeUsers[1].name).toBe("Frank Miller");
		});

		it("should sort by number field descending", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { age: "desc" },
				}),
			);

			expect(results).toHaveLength(6);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([35, 32, 30, 28, 25, 25]);
		});

		it("should sort by boolean field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { active: "asc" },
				}),
			);

			// false comes before true in ascending order
			const activeStates = results.map((r) => r.active);
			expect(activeStates).toEqual([false, false, true, true, true, true]);
		});

		it("should sort by boolean field descending", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { active: "desc" },
				}),
			);

			// true comes before false in descending order
			const activeStates = results.map((r) => r.active);
			expect(activeStates).toEqual([true, true, true, true, false, false]);
		});

		it("should sort by date string field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { createdAt: "asc" },
				}),
			);

			const dates = results.map((r) => r.createdAt);
			// Verify chronological order
			expect(dates).toEqual([
				"2023-01-10T08:00:00Z",
				"2023-01-15T10:00:00Z",
				"2023-01-20T09:30:00Z",
				"2023-02-01T12:00:00Z",
				"2023-02-20T14:30:00Z",
				"2023-03-05T16:45:00Z",
			]);
		});

		it("should sort with no results", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { role: "nonexistent" },
					sort: { name: "asc" },
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should sort with single result", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { email: "alice@example.com" },
					sort: { name: "asc" },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Alice Johnson");
		});
	});

	// ============================================================================
	// Multiple Field Sorting Tests
	// ============================================================================

	describe("Multiple field sorting", () => {
		it("should sort by two fields with same direction", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { age: "asc", name: "asc" },
				}),
			);

			// Should sort by age first, then by name for same ages
			const sorted = results.map((r) => ({ age: r.age, name: r.name }));
			expect(sorted).toEqual([
				{ age: 25, name: "Bob Smith" },
				{ age: 25, name: "Frank Miller" },
				{ age: 28, name: "Diana Prince" },
				{ age: 30, name: "Alice Johnson" },
				{ age: 32, name: "Eve Wilson" },
				{ age: 35, name: "Charlie Brown" },
			]);
		});

		it("should sort by two fields with different directions", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { active: "desc", score: "desc" },
				}),
			);

			// Active users first (desc), then by score (desc)
			const sorted = results.map((r) => ({
				active: r.active,
				score: r.score,
				name: r.name,
			}));

			// All active users should come first, sorted by score
			const activeUsers = sorted.filter((u) => u.active);
			expect(activeUsers[0].score).toBe(95); // Alice
			expect(activeUsers[1].score).toBe(90); // Diana
			expect(activeUsers[2].score).toBe(88); // Eve
			expect(activeUsers[3].score).toBe(82); // Bob

			// Inactive users should come last
			const inactiveUsers = sorted.filter((u) => !u.active);
			expect(inactiveUsers).toHaveLength(2);
		});

		it("should respect sort priority order", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.companies.query({
					sort: { active: "desc", revenue: "desc" },
				}),
			);

			// First sort by active status, then by revenue
			const sorted = results.map((r) => ({
				name: r.name,
				active: r.active,
				revenue: r.revenue,
			}));

			// Active companies should come first
			expect(sorted[0].active).toBe(true);
			expect(sorted[1].active).toBe(true);
			expect(sorted[2].active).toBe(true);
			expect(sorted[3].active).toBe(false);

			// Within active companies, should be sorted by revenue desc
			expect(sorted[0].revenue).toBe(1000000); // Tech Corp
			expect(sorted[1].revenue).toBe(500000); // Design Studio
			expect(sorted[2].revenue).toBe(100000); // Startup Inc
		});

		it("should handle three or more sort fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					sort: { published: "desc", likes: "desc", title: "asc" },
				}),
			);

			const sorted = results.map((r) => ({
				published: r.published,
				likes: r.likes,
				title: r.title,
			}));

			// Published posts should come first
			expect(sorted.slice(0, 4).every((p) => p.published)).toBe(true);
			expect(sorted.slice(4).every((p) => !p.published)).toBe(true);

			// Within published posts, should be sorted by likes desc
			expect(sorted[0].likes).toBe(65); // Microservices
			expect(sorted[1].likes).toBe(42); // Getting Started
			expect(sorted[2].likes).toBe(38); // Advanced React
			expect(sorted[3].likes).toBe(28); // Database Design
		});
	});

	// ============================================================================
	// Undefined/Null Handling Tests
	// ============================================================================

	describe("Undefined/null value handling", () => {
		it("should handle undefined values in ascending sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { score: "asc" },
				}),
			);

			// Undefined values should come last in ascending sort
			const scores = results.map((r) => r.score);
			expect(scores[scores.length - 1]).toBeUndefined();

			// Verify defined values are sorted correctly
			const definedScores = scores.filter((s) => s !== undefined);
			expect(definedScores).toEqual([75, 82, 88, 90, 95]);
		});

		it("should handle undefined values in descending sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { score: "desc" },
				}),
			);

			// Undefined values should come last in descending sort
			const scores = results.map((r) => r.score);
			expect(scores[scores.length - 1]).toBeUndefined();

			// Verify defined values are sorted correctly
			const definedScores = scores.filter((s) => s !== undefined);
			expect(definedScores).toEqual([95, 90, 88, 82, 75]);
		});

		it("should handle undefined values in relationship fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { companyId: "asc" },
				}),
			);

			// Users without companyId should come last
			const companyIds = results.map((r) => r.companyId);
			expect(companyIds[companyIds.length - 1]).toBeUndefined();
		});

		it("should handle mixed undefined/null/valid values", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					sort: { publishedAt: "asc" },
				}),
			);

			const publishedDates = results.map((r) => r.publishedAt);

			// Undefined values should come last
			const undefinedCount = publishedDates.filter(
				(d) => d === undefined,
			).length;
			expect(undefinedCount).toBe(2);
			expect(publishedDates[4]).toBeUndefined();
			expect(publishedDates[5]).toBeUndefined();

			// Defined values should be sorted chronologically
			const definedDates = publishedDates.slice(0, 4);
			expect(definedDates).toEqual([
				"2023-03-20T11:30:00Z",
				"2023-04-01T10:00:00Z",
				"2023-04-15T14:00:00Z",
				"2023-05-01T09:00:00Z",
			]);
		});
	});

	// ============================================================================
	// Combined with Filtering Tests
	// ============================================================================

	describe("Sorting combined with filtering", () => {
		it("should filter then sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { active: true },
					sort: { age: "asc" },
				}),
			);

			expect(results).toHaveLength(4);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([25, 28, 30, 32]);
		});

		it("should handle complex queries with where + sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					where: {
						published: true,
						likes: { $gte: 30 },
					},
					sort: { likes: "desc", title: "asc" },
				}),
			);

			expect(results).toHaveLength(3);
			const sorted = results.map((r) => ({ title: r.title, likes: r.likes }));
			expect(sorted).toEqual([
				{ title: "Microservices Architecture", likes: 65 },
				{ title: "Getting Started with TypeScript", likes: 42 },
				{ title: "Advanced React Patterns", likes: 38 },
			]);
		});

		it("should filter with $in operator and sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: {
						role: { $in: ["admin", "moderator"] },
					},
					sort: { name: "asc" },
				}),
			);

			expect(results).toHaveLength(3);
			const names = results.map((r) => r.name);
			expect(names).toEqual(["Alice Johnson", "Charlie Brown", "Eve Wilson"]);
		});

		it("should filter with string operators and sort", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					where: {
						title: { $contains: "Draft" },
					},
					sort: { likes: "desc" },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results[0].likes).toBe(12);
			expect(results[1].likes).toBe(5);
		});
	});

	// ============================================================================
	// Relationship Sorting Tests
	// ============================================================================

	describe("Sorting by relationship fields", () => {
		it("should sort by populated ref relationship field", async () => {
			const db = createDatabase(config, data);
			const query = db.users.query({
				populate: { company: true },
				sort: { "company.name": "asc" } as any,
			});
			const results = await collect(query);

			// Extract company names in order
			const companyNames: string[] = [];
			for (const r of results) {
				const company = (r as any).company;
				if (company && company.name) {
					companyNames.push(company.name);
				}
			}

			// Should be alphabetically sorted
			expect(companyNames).toEqual([
				"Design Studio",
				"Old Industries",
				"Startup Inc",
				"Tech Corp",
				"Tech Corp", // Two users from Tech Corp
			]);

			// User without company should come last
			expect((results[results.length - 1] as any).company).toBeUndefined();
		});

		it("should sort by populated ref relationship numeric field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					populate: { company: true },
					sort: { "company.revenue": "desc" } as any,
				}),
			);

			// Users should be sorted by their company's revenue
			const revenues: number[] = [];
			for (const r of results) {
				const company = (r as any).company;
				if (company && company.revenue !== undefined) {
					revenues.push(company.revenue);
				}
			}

			expect(revenues).toEqual([
				2000000, // Old Industries
				1000000, // Tech Corp
				1000000, // Tech Corp (second user)
				500000, // Design Studio
				100000, // Startup Inc
			]);
		});

		it("should sort by populated inverse relationship count", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					populate: { posts: true },
					sort: { id: "asc" }, // Placeholder - would need post count
				}),
			);

			// Verify posts are populated
			expect((results[0] as any).posts).toBeDefined();
			expect(Array.isArray((results[0] as any).posts)).toBe(true);
		});

		it("should handle nested relationship sorting", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					populate: {
						author: {
							populate: { company: true },
						} as any,
					},
					sort: { "author.company.name": "asc" } as any,
				}),
			);

			// Posts should be sorted by author's company name
			const companyNames: string[] = [];
			for (const r of results) {
				const author = (r as any).author;
				if (author && author.company && author.company.name) {
					companyNames.push(author.company.name);
				}
			}

			// Verify alphabetical order
			const uniqueCompanies = Array.from(new Set(companyNames));
			expect(uniqueCompanies).toEqual(
				["Design Studio", "Old Industries", "Startup Inc", "Tech Corp"].filter(
					(company) => companyNames.includes(company),
				),
			);
		});

		it("should ignore sort by relationship when not populated", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					// Not populating company
					sort: { "company.name": "asc" } as any,
				}),
			);

			// Should return all users, but sorting by company.name won't work
			expect(results).toHaveLength(6);
			// Results should fall back to default order or be unsorted by company
		});

		it("should handle multiple sorts with relationship fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					populate: { company: true },
					sort: { "company.active": "desc", age: "asc" } as any,
				}),
			);

			// First sort by company active status, then by age
			// Using a for loop to avoid complex union type issues
			const sorted = [];
			for (const r of results) {
				sorted.push({
					name: r.name,
					companyActive: (r as any).company?.active,
					age: r.age,
				});
			}

			// Users with active companies should come first
			const withActiveCompanies = [];
			const withInactiveCompanies = [];
			const withoutCompany = [];

			for (const u of sorted) {
				if (u.companyActive === true) {
					withActiveCompanies.push(u);
				} else if (u.companyActive === false) {
					withInactiveCompanies.push(u);
				} else if (u.companyActive === undefined) {
					withoutCompany.push(u);
				}
			}

			expect(withActiveCompanies.length).toBeGreaterThan(0);
			expect(withInactiveCompanies.length).toBeGreaterThan(0);
			expect(withoutCompany.length).toBe(1);

			// Within each group, should be sorted by age
			const activeAges = [];
			for (const u of withActiveCompanies) {
				activeAges.push(u.age);
			}
			expect(activeAges).toEqual([...activeAges].sort((a, b) => a - b));
		});
	});

	// ============================================================================
	// Edge Cases Tests
	// ============================================================================

	describe("Edge cases", () => {
		it("should handle empty sort object", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: {},
				}),
			);

			// Should return all users in default order
			expect(results).toHaveLength(6);
		});

		it("should handle sort on non-existent fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { nonExistentField: "asc" } as any,
				}),
			);

			// Should return all users, ignoring invalid sort field
			expect(results).toHaveLength(6);
		});

		it("should handle sort on array fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.posts.query({
					sort: { tags: "asc" } as any,
				}),
			);

			// Should return all posts, but array sorting behavior is undefined
			expect(results).toHaveLength(6);
		});

		it("should combine sort with limit", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { score: "desc" },
					limit: 3,
				}),
			);

			expect(results).toHaveLength(3);
			// Should get top 3 scores
			const scores = results.map((r) => r.score);
			expect(scores).toEqual([95, 90, 88]);
		});

		it("should combine sort with offset", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { name: "asc" },
					offset: 2,
					limit: 2,
				}),
			);

			expect(results).toHaveLength(2);
			// Should skip first 2 and get next 2
			const names = results.map((r) => r.name);
			expect(names).toEqual(["Charlie Brown", "Diana Prince"]);
		});

		it("should handle invalid sort directions", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					sort: { name: "invalid" as any },
				}),
			);

			// Should either throw error or fall back to default
			// Implementation will determine behavior
			expect(results).toBeDefined();
		});
	});

	// ============================================================================
	// Performance Tests
	// ============================================================================

	describe("Performance considerations", () => {
		it("should efficiently sort large datasets", async () => {
			// Create a larger dataset
			const generatedUsers = Array.from({ length: 100 }, (_, i) => ({
				id: `u${i + 100}`,
				name: `User ${String(i).padStart(3, "0")}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 50),
				score: i % 2 === 0 ? 50 + (i % 50) : undefined,
				active: i % 3 !== 0,
				createdAt: new Date(2023, 0, 1 + i).toISOString(),
				companyId: data.companies[i % 4].id,
				role: ["user", "admin", "moderator"][i % 3],
			}));
			const largeData = {
				companies: data.companies,
				users: [...generatedUsers, ...data.users],
				posts: data.posts,
			};

			const db = createDatabase(config, largeData);
			const startTime = Date.now();

			const results = await collect(
				db.users.query({
					sort: { age: "asc", score: "desc", name: "asc" },
				}),
			);

			const endTime = Date.now();

			expect(results).toHaveLength(106);
			// Should complete in reasonable time (< 100ms for 100+ records)
			expect(endTime - startTime).toBeLessThan(100);

			// Verify sorting is correct
			for (let i = 1; i < results.length; i++) {
				const prev = results[i - 1];
				const curr = results[i];

				// First sort by age
				if (prev.age !== curr.age) {
					expect(prev.age).toBeLessThanOrEqual(curr.age);
				} else if (prev.score !== undefined && curr.score !== undefined) {
					// Then by score (desc)
					expect(prev.score).toBeGreaterThanOrEqual(curr.score);
				}
				// Name comparison would be the final tiebreaker
			}
		});

		it("should handle multiple sort fields on large dataset efficiently", async () => {
			const largeData = {
				companies: Array.from({ length: 20 }, (_, i) => ({
					id: `c${i + 100}`,
					name: `Company ${String(i).padStart(2, "0")}`,
					revenue: 100000 * (i + 1),
					foundedYear: 2000 + i,
					active: i % 4 !== 0,
				})),
				users: data.users,
				posts: data.posts,
			};

			const db = createDatabase(config, largeData);

			const results = await collect(
				db.companies.query({
					sort: { active: "desc", revenue: "desc", name: "asc" },
				}),
			);

			expect(results.length).toBeGreaterThanOrEqual(20);

			// Verify complex sorting is maintained
			const activeCompanies = results.filter((c) => c.active);
			const inactiveCompanies = results.filter((c) => !c.active);

			// All active should come before inactive
			const lastActiveIndex = results.findIndex(
				(c) => c === activeCompanies[activeCompanies.length - 1],
			);
			const firstInactiveIndex = results.findIndex(
				(c) => c === inactiveCompanies[0],
			);
			expect(lastActiveIndex).toBeLessThan(firstInactiveIndex);
		});
	});

	// ============================================================================
	// Type Safety Tests (these would be compile-time checks in actual usage)
	// ============================================================================

	describe("Type safety", () => {
		it("should accept valid sort field keys", async () => {
			const db = createDatabase(config, data);

			// These should all be valid
			const validQueries = [
				{ sort: { name: "asc" } },
				{ sort: { age: "desc" } },
				{ sort: { active: "asc" } },
				{ sort: { score: "desc" } },
				{ sort: { createdAt: "asc" } },
			];

			for (const query of validQueries) {
				const results = await collect(db.users.query(query as any));
				expect(results).toBeDefined();
			}
		});

		it("should handle populated field sort keys", async () => {
			const db = createDatabase(config, data);

			// Valid populated field sorts
			const results = await collect(
				db.users.query({
					populate: { company: true },
					sort: {
						"company.name": "asc",
						"company.revenue": "desc",
					} as any,
				}),
			);

			expect(results).toBeDefined();
		});
	});
});
