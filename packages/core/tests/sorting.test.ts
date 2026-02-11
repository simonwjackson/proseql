import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { applyFilter } from "../src/operations/query/filter-stream";
import { applySort } from "../src/operations/query/sort-stream";

const collectSorted = <T extends Record<string, unknown>>(
	data: T[],
	sort: Partial<Record<string, "asc" | "desc">> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applySort<T>(sort),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

const collectFilteredSorted = <T extends Record<string, unknown>>(
	data: T[],
	where: Record<string, unknown> | undefined,
	sort: Partial<Record<string, "asc" | "desc">> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyFilter<T>(where),
			applySort<T>(sort),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("Database v2 - Sorting (Stream-based)", () => {
	// ============================================================================
	// Test Data
	// ============================================================================

	const users = [
		{
			id: "u1",
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 30,
			score: 95 as number | undefined,
			active: true,
			createdAt: "2023-01-15T10:00:00Z",
			companyId: "c1" as string | undefined,
			role: "admin",
		},
		{
			id: "u2",
			name: "Bob Smith",
			email: "bob@example.com",
			age: 25,
			score: 82 as number | undefined,
			active: true,
			createdAt: "2023-02-20T14:30:00Z",
			companyId: "c2" as string | undefined,
			role: "user",
		},
		{
			id: "u3",
			name: "Charlie Brown",
			email: "charlie@example.com",
			age: 35,
			score: undefined as number | undefined,
			active: false,
			createdAt: "2023-01-10T08:00:00Z",
			companyId: "c3" as string | undefined,
			role: "moderator",
		},
		{
			id: "u4",
			name: "Diana Prince",
			email: "diana@example.com",
			age: 28,
			score: 90 as number | undefined,
			active: true,
			createdAt: "2023-03-05T16:45:00Z",
			companyId: "c1" as string | undefined,
			role: "user",
		},
		{
			id: "u5",
			name: "Eve Wilson",
			email: "eve@example.com",
			age: 32,
			score: 88 as number | undefined,
			active: true,
			createdAt: "2023-02-01T12:00:00Z",
			companyId: undefined as string | undefined,
			role: "admin",
		},
		{
			id: "u6",
			name: "Frank Miller",
			email: "frank@example.com",
			age: 25,
			score: 75 as number | undefined,
			active: false,
			createdAt: "2023-01-20T09:30:00Z",
			companyId: "c4" as string | undefined,
			role: "user",
		},
	];

	const companies = [
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
	];

	const posts = [
		{
			id: "p1",
			title: "Getting Started with TypeScript",
			content: "TypeScript is amazing...",
			authorId: "u1",
			likes: 42,
			published: true,
			publishedAt: "2023-04-01T10:00:00Z" as string | undefined,
			tags: ["typescript", "programming"] as string[],
		},
		{
			id: "p2",
			title: "Advanced React Patterns",
			content: "Let's explore advanced patterns...",
			authorId: "u1",
			likes: 38,
			published: true,
			publishedAt: "2023-04-15T14:00:00Z" as string | undefined,
			tags: ["react", "javascript"] as string[],
		},
		{
			id: "p3",
			title: "Draft: CSS Grid Layout",
			content: "Work in progress...",
			authorId: "u2",
			likes: 5,
			published: false,
			publishedAt: undefined as string | undefined,
			tags: ["css"] as string[],
		},
		{
			id: "p4",
			title: "Database Design Best Practices",
			content: "When designing databases...",
			authorId: "u3",
			likes: 28,
			published: true,
			publishedAt: "2023-03-20T11:30:00Z" as string | undefined,
			tags: ["database", "sql"] as string[],
		},
		{
			id: "p5",
			title: "Microservices Architecture",
			content: "Breaking down monoliths...",
			authorId: "u4",
			likes: 65,
			published: true,
			publishedAt: "2023-05-01T09:00:00Z" as string | undefined,
			tags: ["architecture", "microservices"] as string[],
		},
		{
			id: "p6",
			title: "Draft: AI and Machine Learning",
			content: "The future of AI...",
			authorId: "u5",
			likes: 12,
			published: false,
			publishedAt: undefined as string | undefined,
			tags: [] as string[],
		},
	];

	// ============================================================================
	// Basic Sorting Tests
	// ============================================================================

	describe("Basic field sorting", () => {
		it("should sort by string field ascending", async () => {
			const results = await collectSorted(users, { name: "asc" });

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
			const results = await collectSorted(users, { name: "desc" });

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
			const results = await collectSorted(users, { age: "asc" });

			expect(results).toHaveLength(6);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([25, 25, 28, 30, 32, 35]);

			// Verify stable sort - users with same age maintain order
			const sameAgeUsers = results.filter((r) => r.age === 25);
			expect(sameAgeUsers[0].name).toBe("Bob Smith");
			expect(sameAgeUsers[1].name).toBe("Frank Miller");
		});

		it("should sort by number field descending", async () => {
			const results = await collectSorted(users, { age: "desc" });

			expect(results).toHaveLength(6);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([35, 32, 30, 28, 25, 25]);
		});

		it("should sort by boolean field", async () => {
			const results = await collectSorted(users, { active: "asc" });

			// false comes before true in ascending order
			const activeStates = results.map((r) => r.active);
			expect(activeStates).toEqual([false, false, true, true, true, true]);
		});

		it("should sort by boolean field descending", async () => {
			const results = await collectSorted(users, { active: "desc" });

			// true comes before false in descending order
			const activeStates = results.map((r) => r.active);
			expect(activeStates).toEqual([true, true, true, true, false, false]);
		});

		it("should sort by date string field", async () => {
			const results = await collectSorted(users, { createdAt: "asc" });

			const dates = results.map((r) => r.createdAt);
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
			const results = await collectFilteredSorted(
				users,
				{ role: "nonexistent" },
				{ name: "asc" },
			);

			expect(results).toHaveLength(0);
		});

		it("should sort with single result", async () => {
			const results = await collectFilteredSorted(
				users,
				{ email: "alice@example.com" },
				{ name: "asc" },
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
			const results = await collectSorted(users, {
				age: "asc",
				name: "asc",
			});

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
			const results = await collectSorted(users, {
				active: "desc",
				score: "desc",
			});

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
			const results = await collectSorted(companies, {
				active: "desc",
				revenue: "desc",
			});

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
			const results = await collectSorted(posts, {
				published: "desc",
				likes: "desc",
				title: "asc",
			});

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
			const results = await collectSorted(users, { score: "asc" });

			// Undefined values should come last in ascending sort
			const scores = results.map((r) => r.score);
			expect(scores[scores.length - 1]).toBeUndefined();

			// Verify defined values are sorted correctly
			const definedScores = scores.filter((s) => s !== undefined);
			expect(definedScores).toEqual([75, 82, 88, 90, 95]);
		});

		it("should handle undefined values in descending sort", async () => {
			const results = await collectSorted(users, { score: "desc" });

			// Undefined values should come last in descending sort
			const scores = results.map((r) => r.score);
			expect(scores[scores.length - 1]).toBeUndefined();

			// Verify defined values are sorted correctly
			const definedScores = scores.filter((s) => s !== undefined);
			expect(definedScores).toEqual([95, 90, 88, 82, 75]);
		});

		it("should handle undefined values in relationship fields", async () => {
			const results = await collectSorted(users, { companyId: "asc" });

			// Users without companyId should come last
			const companyIds = results.map((r) => r.companyId);
			expect(companyIds[companyIds.length - 1]).toBeUndefined();
		});

		it("should handle mixed undefined/valid values", async () => {
			const results = await collectSorted(posts, { publishedAt: "asc" });

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
			const results = await collectFilteredSorted(
				users,
				{ active: true },
				{ age: "asc" },
			);

			expect(results).toHaveLength(4);
			const ages = results.map((r) => r.age);
			expect(ages).toEqual([25, 28, 30, 32]);
		});

		it("should handle complex queries with where + sort", async () => {
			const results = await collectFilteredSorted(
				posts,
				{
					published: true,
					likes: { $gte: 30 },
				},
				{ likes: "desc", title: "asc" },
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
			const results = await collectFilteredSorted(
				users,
				{
					role: { $in: ["admin", "moderator"] },
				},
				{ name: "asc" },
			);

			expect(results).toHaveLength(3);
			const names = results.map((r) => r.name);
			expect(names).toEqual(["Alice Johnson", "Charlie Brown", "Eve Wilson"]);
		});

		it("should filter with string operators and sort", async () => {
			const results = await collectFilteredSorted(
				posts,
				{
					title: { $contains: "Draft" },
				},
				{ likes: "desc" },
			);

			expect(results).toHaveLength(2);
			expect(results[0].likes).toBe(12);
			expect(results[1].likes).toBe(5);
		});
	});

	// ============================================================================
	// Sorting by Nested (Populated) Fields Tests
	// ============================================================================

	describe("Sorting by nested/populated fields", () => {
		// Simulate populated data (users with resolved company objects)
		const companyMap = new Map(companies.map((c) => [c.id, c]));

		const usersWithCompany = users.map((u) => ({
			...u,
			company: u.companyId ? companyMap.get(u.companyId) : undefined,
		}));

		it("should sort by nested ref field (dot notation)", async () => {
			const results = await collectSorted(
				usersWithCompany as Record<string, unknown>[],
				{ "company.name": "asc" },
			);

			// Extract company names in order
			const companyNames: string[] = [];
			for (const r of results) {
				const company = r.company as { name: string } | undefined;
				if (company?.name) {
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
			expect(results[results.length - 1].company).toBeUndefined();
		});

		it("should sort by nested numeric field (dot notation)", async () => {
			const results = await collectSorted(
				usersWithCompany as Record<string, unknown>[],
				{ "company.revenue": "desc" },
			);

			const revenues: number[] = [];
			for (const r of results) {
				const company = r.company as { revenue: number } | undefined;
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

		it("should handle sort on unpopulated nested path gracefully", async () => {
			// Sort by company.name on data without populated company objects
			const results = await collectSorted(users as Record<string, unknown>[], {
				"company.name": "asc",
			});

			// Should return all users (companyId is a string, not an object)
			expect(results).toHaveLength(6);
		});

		it("should handle multiple sorts with nested fields", async () => {
			const results = await collectSorted(
				usersWithCompany as Record<string, unknown>[],
				{ "company.active": "desc", age: "asc" },
			);

			const sorted = results.map((r) => ({
				name: r.name,
				companyActive: (r.company as { active: boolean } | undefined)?.active,
				age: r.age,
			}));

			const withActiveCompanies = sorted.filter(
				(u) => u.companyActive === true,
			);
			const withInactiveCompanies = sorted.filter(
				(u) => u.companyActive === false,
			);
			const withoutCompany = sorted.filter(
				(u) => u.companyActive === undefined,
			);

			expect(withActiveCompanies.length).toBeGreaterThan(0);
			expect(withInactiveCompanies.length).toBeGreaterThan(0);
			expect(withoutCompany.length).toBe(1);

			// Within each group, should be sorted by age
			const activeAges = withActiveCompanies.map((u) => u.age);
			expect(activeAges).toEqual(
				[...activeAges].sort((a, b) => (a as number) - (b as number)),
			);
		});
	});

	// ============================================================================
	// Edge Cases Tests
	// ============================================================================

	describe("Edge cases", () => {
		it("should handle empty sort object", async () => {
			const results = await collectSorted(users, {});

			// Should return all users in original order
			expect(results).toHaveLength(6);
		});

		it("should handle undefined sort", async () => {
			const results = await collectSorted(users, undefined);

			// Should return all users in original order
			expect(results).toHaveLength(6);
		});

		it("should handle sort on non-existent fields", async () => {
			const results = await collectSorted(users as Record<string, unknown>[], {
				nonExistentField: "asc",
			});

			// Should return all users
			expect(results).toHaveLength(6);
		});

		it("should handle sort on array fields", async () => {
			const results = await collectSorted(posts as Record<string, unknown>[], {
				tags: "asc",
			});

			// Should return all posts
			expect(results).toHaveLength(6);
		});

		it("should combine sort with Stream.drop/Stream.take for pagination", async () => {
			const results = await Effect.runPromise(
				Stream.fromIterable(users).pipe(
					applySort<(typeof users)[number]>({ score: "desc" }),
					Stream.take(3),
					Stream.runCollect,
					Effect.map(Chunk.toReadonlyArray),
				),
			);

			expect(results).toHaveLength(3);
			const scores = results.map((r) => r.score);
			expect(scores).toEqual([95, 90, 88]);
		});

		it("should combine sort with Stream.drop for offset + limit", async () => {
			const results = await Effect.runPromise(
				Stream.fromIterable(users).pipe(
					applySort<(typeof users)[number]>({ name: "asc" }),
					Stream.drop(2),
					Stream.take(2),
					Stream.runCollect,
					Effect.map(Chunk.toReadonlyArray),
				),
			);

			expect(results).toHaveLength(2);
			const names = results.map((r) => r.name);
			expect(names).toEqual(["Charlie Brown", "Diana Prince"]);
		});

		it("should handle invalid sort directions", async () => {
			const results = await collectSorted(users as Record<string, unknown>[], {
				name: "invalid" as "asc" | "desc",
			});

			// Should return all users
			expect(results).toBeDefined();
		});
	});

	// ============================================================================
	// Performance Tests
	// ============================================================================

	describe("Performance considerations", () => {
		it("should efficiently sort large datasets", async () => {
			const generatedUsers = Array.from({ length: 100 }, (_, i) => ({
				id: `u${i + 100}`,
				name: `User ${String(i).padStart(3, "0")}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 50),
				score: (i % 2 === 0 ? 50 + (i % 50) : undefined) as number | undefined,
				active: i % 3 !== 0,
				createdAt: new Date(2023, 0, 1 + i).toISOString(),
				companyId: companies[i % 4].id as string | undefined,
				role: ["user", "admin", "moderator"][i % 3],
			}));
			const largeUsers = [...generatedUsers, ...users];

			const startTime = Date.now();

			const results = await collectSorted(largeUsers, {
				age: "asc",
				score: "desc",
				name: "asc",
			});

			const endTime = Date.now();

			expect(results).toHaveLength(106);
			// Should complete in reasonable time (< 100ms for 100+ records)
			expect(endTime - startTime).toBeLessThan(100);

			// Verify sorting is correct
			for (let i = 1; i < results.length; i++) {
				const prev = results[i - 1];
				const curr = results[i];

				if (prev.age !== curr.age) {
					expect(prev.age).toBeLessThanOrEqual(curr.age as number);
				} else if (prev.score !== undefined && curr.score !== undefined) {
					expect(prev.score).toBeGreaterThanOrEqual(curr.score);
				}
			}
		});

		it("should handle multiple sort fields on large dataset efficiently", async () => {
			const largeCompanies = Array.from({ length: 20 }, (_, i) => ({
				id: `c${i + 100}`,
				name: `Company ${String(i).padStart(2, "0")}`,
				revenue: 100000 * (i + 1),
				foundedYear: 2000 + i,
				active: i % 4 !== 0,
			}));

			const results = await collectSorted(largeCompanies, {
				active: "desc",
				revenue: "desc",
				name: "asc",
			});

			expect(results.length).toBeGreaterThanOrEqual(20);

			// Verify complex sorting is maintained
			const activeCompanies = results.filter((c) => c.active);
			const inactiveCompanies = results.filter((c) => !c.active);

			// All active should come before inactive
			const lastActiveIndex = results.findIndex(
				(c) => c === activeCompanies[activeCompanies.length - 1],
			);
			const firstInactiveIndex = results.indexOf(inactiveCompanies[0]);
			expect(lastActiveIndex).toBeLessThan(firstInactiveIndex);
		});
	});

	// ============================================================================
	// Type Safety Tests
	// ============================================================================

	describe("Type safety", () => {
		it("should accept valid sort field keys", async () => {
			const validSorts: Array<Partial<Record<string, "asc" | "desc">>> = [
				{ name: "asc" },
				{ age: "desc" },
				{ active: "asc" },
				{ score: "desc" },
				{ createdAt: "asc" },
			];

			for (const sort of validSorts) {
				const results = await collectSorted(users, sort);
				expect(results).toBeDefined();
			}
		});

		it("should handle sort on pre-populated nested fields", async () => {
			const companyMap = new Map(companies.map((c) => [c.id, c]));
			const usersWithCompany = users.map((u) => ({
				...u,
				company: u.companyId ? companyMap.get(u.companyId) : undefined,
			}));

			const results = await collectSorted(
				usersWithCompany as Record<string, unknown>[],
				{
					"company.name": "asc",
					"company.revenue": "desc",
				},
			);

			expect(results).toBeDefined();
		});
	});
});
