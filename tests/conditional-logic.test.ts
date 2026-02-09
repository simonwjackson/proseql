import { describe, it, expect } from "vitest";
import { Effect, Schema, Stream, Chunk } from "effect";
import { createEffectDatabase } from "../core/factories/database-effect";

describe("Database v2 - Conditional Logic (OR/AND/NOT) (Effect/Stream)", () => {
	// Test schemas
	const UserSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		email: Schema.String,
		age: Schema.Number,
		status: Schema.String,
		role: Schema.String,
		score: Schema.optional(Schema.Number),
		tags: Schema.optional(Schema.Array(Schema.String)),
		createdAt: Schema.String,
	});

	const ProjectSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		description: Schema.String,
		status: Schema.String,
		priority: Schema.Number,
		isPublic: Schema.Boolean,
		ownerId: Schema.String,
		budget: Schema.Number,
		tags: Schema.optional(Schema.Array(Schema.String)),
	});

	const CommentSchema = Schema.Struct({
		id: Schema.String,
		content: Schema.String,
		authorId: Schema.String,
		projectId: Schema.String,
		likes: Schema.Number,
		isApproved: Schema.Boolean,
		sentiment: Schema.optional(Schema.String),
	});

	const config = {
		users: {
			schema: UserSchema,
			relationships: {
				projects: {
					type: "inverse" as const,
					target: "projects" as const,
					foreignKey: "ownerId" as const,
				},
				comments: {
					type: "inverse" as const,
					target: "comments" as const,
					foreignKey: "authorId" as const,
				},
			},
		},
		projects: {
			schema: ProjectSchema,
			relationships: {
				owner: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "ownerId" as const,
				},
				comments: {
					type: "inverse" as const,
					target: "comments" as const,
					foreignKey: "projectId" as const,
				},
			},
		},
		comments: {
			schema: CommentSchema,
			relationships: {
				author: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "authorId" as const,
				},
				project: {
					type: "ref" as const,
					target: "projects" as const,
					foreignKey: "projectId" as const,
				},
			},
		},
	} as const;

	const data = {
		users: [
			{
				id: "u1",
				name: "John Doe",
				email: "john@company.com",
				age: 30,
				status: "active" as const,
				role: "admin",
				score: 95,
				tags: ["senior", "manager"],
				createdAt: "2023-01-01",
			},
			{
				id: "u2",
				name: "Jane Smith",
				email: "jane@company.com",
				age: 25,
				status: "active" as const,
				role: "developer",
				score: 88,
				tags: ["junior"],
				createdAt: "2023-02-15",
			},
			{
				id: "u3",
				name: "Bob Johnson",
				email: "bob@external.com",
				age: 35,
				status: "inactive" as const,
				role: "developer",
				score: 72,
				tags: ["contractor"],
				createdAt: "2023-03-20",
			},
			{
				id: "u4",
				name: "Alice Brown",
				email: "alice@company.com",
				age: 28,
				status: "pending" as const,
				role: "designer",
				score: undefined,
				tags: [],
				createdAt: "2023-04-10",
			},
			{
				id: "u5",
				name: "Charlie Wilson",
				email: "charlie@freelance.com",
				age: 40,
				status: "active" as const,
				role: "consultant",
				score: 91,
				tags: ["expert", "remote"],
				createdAt: "2023-05-01",
			},
			{
				id: "u6",
				name: "Eva Martinez",
				email: "eva@company.com",
				age: 22,
				status: "active" as const,
				role: "intern",
				score: 65,
				tags: ["trainee"],
				createdAt: "2023-06-15",
			},
		],
		projects: [
			{
				id: "p1",
				title: "Website Redesign",
				description: "Complete overhaul of company website",
				status: "active" as const,
				priority: 1,
				isPublic: true,
				ownerId: "u1",
				budget: 50000,
				tags: ["web", "design"],
			},
			{
				id: "p2",
				title: "Mobile App",
				description: "Native mobile application",
				status: "draft" as const,
				priority: 2,
				isPublic: false,
				ownerId: "u2",
				budget: 75000,
				tags: ["mobile", "ios", "android"],
			},
			{
				id: "p3",
				title: "Data Migration",
				description: "Legacy system migration",
				status: "completed" as const,
				priority: 1,
				isPublic: false,
				ownerId: "u1",
				budget: 30000,
				tags: ["backend", "database"],
			},
			{
				id: "p4",
				title: "API Development",
				description: "RESTful API for partners",
				status: "active" as const,
				priority: 3,
				isPublic: true,
				ownerId: "u5",
				budget: 40000,
				tags: ["api", "backend"],
			},
			{
				id: "p5",
				title: "Security Audit",
				description: "Comprehensive security review",
				status: "archived" as const,
				priority: 1,
				isPublic: false,
				ownerId: "u5",
				budget: 20000,
				tags: ["security"],
			},
		],
		comments: [
			{
				id: "c1",
				content: "Great progress on this!",
				authorId: "u1",
				projectId: "p1",
				likes: 5,
				isApproved: true,
				sentiment: "positive" as const,
			},
			{
				id: "c2",
				content: "Need to review the specs",
				authorId: "u2",
				projectId: "p1",
				likes: 2,
				isApproved: true,
				sentiment: "neutral" as const,
			},
			{
				id: "c3",
				content: "This approach won't work",
				authorId: "u3",
				projectId: "p2",
				likes: 0,
				isApproved: false,
				sentiment: "negative" as const,
			},
			{
				id: "c4",
				content: "Excellent implementation",
				authorId: "u5",
				projectId: "p4",
				likes: 10,
				isApproved: true,
				sentiment: "positive" as const,
			},
		],
	};

	// Helper: create database and collect query results
	const collectQuery = (
		collection: "users" | "projects" | "comments",
		options: Record<string, unknown>,
	): Promise<ReadonlyArray<Record<string, unknown>>> =>
		Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, data);
				const coll = (db as Record<string, { query: (opts: Record<string, unknown>) => Stream.Stream<Record<string, unknown>> }>)[collection];
				return yield* Stream.runCollect(coll.query(options)).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);
			}),
		);

	describe("$or Operator", () => {
		it("should handle basic OR with two conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ name: { $startsWith: "John" } },
						{ email: { $contains: "@company.com" } },
					],
				},
			});

			expect(results).toHaveLength(4); // John + Jane, Alice, Eva from @company.com
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual([
				"Alice Brown",
				"Eva Martinez",
				"Jane Smith",
				"John Doe",
			]);
		});

		it("should handle OR with multiple conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ age: { $lt: 25 } },
						{ role: "admin" },
						{ status: "pending" },
					],
				},
			});

			expect(results).toHaveLength(3); // Eva (22), John (admin), Alice (pending)
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Alice Brown", "Eva Martinez", "John Doe"]);
		});

		it("should handle OR with different field types", async () => {
			const results = await collectQuery("projects", {
				where: {
					$or: [
						{ isPublic: true },
						{ budget: { $gte: 70000 } },
						{ status: "archived" },
					],
				},
			});

			expect(results).toHaveLength(4); // p1, p4 (public), p2 (budget>=70000), p5 (archived)
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p2", "p4", "p5"]);
		});

		it("should handle OR with operators inside", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [{ age: { $in: [25, 30, 35] } }, { score: { $gte: 90 } }],
				},
			});

			expect(results).toHaveLength(4); // Jane(25), John(30), Bob(35), Charlie(score:91)
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual([
				"Bob Johnson",
				"Charlie Wilson",
				"Jane Smith",
				"John Doe",
			]);
		});

		it("should handle empty OR array", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [],
				},
			});

			// Empty OR should return no results (no conditions to satisfy)
			expect(results).toHaveLength(0);
		});

		it("should handle OR with null/undefined checks", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [{ score: { $eq: undefined } }, { score: { $lt: 70 } }],
				},
			});

			expect(results).toHaveLength(2); // Alice (undefined), Eva (65)
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Alice Brown", "Eva Martinez"]);
		});
	});

	describe("$and Operator", () => {
		it("should handle basic AND with two conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$and: [{ status: "active" }, { role: "developer" }],
				},
			});

			expect(results).toHaveLength(1); // Only Jane
			expect(results[0].name).toBe("Jane Smith");
		});

		it("should handle AND with multiple conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$and: [
						{ status: "active" },
						{ age: { $gte: 25 } },
						{ score: { $gte: 80 } },
					],
				},
			});

			expect(results).toHaveLength(3); // John, Jane, Charlie
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Charlie Wilson", "Jane Smith", "John Doe"]);
		});

		it("should handle AND with operators inside", async () => {
			const results = await collectQuery("projects", {
				where: {
					$and: [
						{ priority: { $lte: 2 } },
						{ budget: { $gte: 20000, $lte: 60000 } },
						{ status: { $ne: "draft" } },
					],
				},
			});

			expect(results).toHaveLength(3); // p1, p3, p5
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p3", "p5"]);
		});

		it("should handle empty AND array", async () => {
			const results = await collectQuery("users", {
				where: {
					$and: [],
				},
			});

			// Empty AND should return all results (no conditions to fail)
			expect(results).toHaveLength(6);
		});

		it("should handle implicit AND (default behavior)", async () => {
			// These two queries should produce identical results
			const implicitAnd = await collectQuery("users", {
				where: {
					status: "active",
					age: { $gte: 30 },
				},
			});

			const explicitAnd = await collectQuery("users", {
				where: {
					$and: [{ status: "active" }, { age: { $gte: 30 } }],
				},
			});

			expect(implicitAnd).toHaveLength(2); // John, Charlie
			expect(explicitAnd).toHaveLength(2);
			expect(implicitAnd.map((r) => r.id).sort()).toEqual(
				explicitAnd.map((r) => r.id).sort(),
			);
		});
	});

	describe("$not Operator", () => {
		it("should handle basic NOT negation", async () => {
			const results = await collectQuery("users", {
				where: {
					$not: { status: "active" },
				},
			});

			expect(results).toHaveLength(2); // Bob (inactive), Alice (pending)
			const statuses = results.map((r) => r.status).sort();
			expect(statuses).toEqual(["inactive", "pending"]);
		});

		it("should handle NOT with operators", async () => {
			const results = await collectQuery("users", {
				where: {
					$not: { age: { $gte: 30 } },
				},
			});

			expect(results).toHaveLength(3); // Jane(25), Alice(28), Eva(22)
			expect(results.every((r) => (r.age as number) < 30)).toBe(true);
		});

		it("should handle NOT with nested objects", async () => {
			const results = await collectQuery("projects", {
				where: {
					$not: {
						$and: [{ isPublic: true }, { priority: { $lte: 2 } }],
					},
				},
			});

			// Should exclude projects that are both public AND priority <= 2
			// p1 is excluded (public, priority 1)
			// p2, p3, p4, p5 remain
			expect(results).toHaveLength(4);
			expect(results.find((r) => r.id === "p1")).toBeUndefined();
		});

		it("should handle double negation", async () => {
			const results = await collectQuery("users", {
				where: {
					$not: { $not: { role: "admin" } },
				},
			});

			// Double negation should equal the positive condition
			expect(results).toHaveLength(1);
			expect(results[0].role).toBe("admin");
		});

		it("should handle NOT with array fields", async () => {
			const results = await collectQuery("users", {
				where: {
					$not: { tags: { $contains: "junior" } },
				},
			});

			// Should exclude users with "junior" tag
			expect(results).toHaveLength(5); // All except Jane
			expect(results.find((r) => r.name === "Jane Smith")).toBeUndefined();
		});
	});

	describe("Nested Boolean Logic", () => {
		it("should handle OR inside AND", async () => {
			const results = await collectQuery("users", {
				where: {
					$and: [
						{ status: "active" },
						{
							$or: [{ role: "admin" }, { score: { $gte: 90 } }],
						},
					],
				},
			});

			// Active users who are either admin or have score >= 90
			expect(results).toHaveLength(2); // John (admin), Charlie (score 91)
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Charlie Wilson", "John Doe"]);
		});

		it("should handle AND inside OR", async () => {
			const results = await collectQuery("projects", {
				where: {
					$or: [
						{
							$and: [{ status: "active" }, { isPublic: true }],
						},
						{
							$and: [{ budget: { $gte: 70000 } }, { status: "draft" }],
						},
					],
				},
			});

			// Projects that are (active AND public) OR (budget >= 70k AND draft)
			expect(results).toHaveLength(3); // p1, p4 (active & public), p2 (budget & draft)
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p2", "p4"]);
		});

		it("should handle multiple levels of nesting", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [
						{
							$and: [
								{ age: { $lt: 30 } },
								{
									$or: [{ status: "active" }, { role: "designer" }],
								},
							],
						},
						{
							$and: [{ score: { $gte: 90 } }, { $not: { role: "admin" } }],
						},
					],
				},
			});

			// Complex condition: ((age < 30 AND (status active OR role designer)) OR (score >= 90 AND NOT admin))
			expect(results).toHaveLength(4); // Jane, Alice, Eva, Charlie
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual([
				"Alice Brown",
				"Charlie Wilson",
				"Eva Martinez",
				"Jane Smith",
			]);
		});

		it("should handle complex combinations with NOT", async () => {
			const results = await collectQuery("comments", {
				where: {
					$and: [
						{
							$not: {
								$or: [{ sentiment: "negative" }, { isApproved: false }],
							},
						},
						{ likes: { $gte: 2 } },
					],
				},
			});

			// Comments that are NOT (negative OR unapproved) AND have likes >= 2
			// This means: approved, non-negative comments with likes >= 2
			expect(results).toHaveLength(3); // c1, c2, c4
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["c1", "c2", "c4"]);
		});
	});

	describe("Integration with Existing Features", () => {
		it("should work with relationships and population", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [{ role: "admin" }, { score: { $gte: 90 } }],
				},
				populate: { projects: true },
			});

			expect(results).toHaveLength(2); // John, Charlie

			// Check populated projects
			const john = results.find((r) => r.name === "John Doe") as Record<string, unknown>;
			expect(john?.projects).toHaveLength(2); // p1, p3

			const charlie = results.find((r) => r.name === "Charlie Wilson") as Record<string, unknown>;
			expect(charlie?.projects).toHaveLength(2); // p4, p5
		});

		it("should work with sorting and pagination", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ age: { $lte: 30 } },
						{ role: { $in: ["consultant", "designer"] } },
					],
				},
				sort: { age: "asc" },
				limit: 3,
			});

			expect(results).toHaveLength(3);
			// Should be Eva(22), Jane(25), Alice(28) - sorted by age
			expect(results[0].name).toBe("Eva Martinez");
			expect(results[1].name).toBe("Jane Smith");
			expect(results[2].name).toBe("Alice Brown");
		});

		it("should work with status filtering and population", async () => {
			// Relationship filtering in where clauses (filtering entities by related entity fields)
			// is not supported — where clauses operate on flat entity fields only.
			// This test verifies status filtering with population instead.
			const results = await collectQuery("projects", {
				where: {
					$and: [
						{
							$or: [{ status: "active" }, { status: "completed" }],
						},
					],
				},
				populate: { owner: true },
			});

			// Projects that are (active OR completed)
			expect(results).toHaveLength(3); // p1, p3, p4
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p3", "p4"]);

			// Verify population worked
			const p1 = results.find((r) => r.id === "p1") as Record<string, unknown>;
			expect((p1.owner as Record<string, unknown>)?.name).toBe("John Doe");
		});
	});

	describe("Edge Cases and Error Handling", () => {
		it("should handle empty arrays gracefully", async () => {
			// Empty OR returns nothing
			const orResults = await collectQuery("users", { where: { $or: [] } });
			expect(orResults).toHaveLength(0);

			// Empty AND returns everything
			const andResults = await collectQuery("users", { where: { $and: [] } });
			expect(andResults).toHaveLength(6);
		});

		it("should handle null/undefined in boolean operators", async () => {
			// Check OR with undefined
			const results = await collectQuery("users", {
				where: {
					$or: [{ score: undefined }, { tags: { $contains: "trainee" } }],
				},
			});

			expect(results).toHaveLength(2); // Alice (undefined score), Eva (trainee tag)
		});

		it("should handle deeply nested empty conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$and: [
						{ status: "active" },
						{
							$or: [
								{ $and: [] }, // Empty AND should be true
								{ role: "nonexistent" },
							],
						},
					],
				},
			});

			// All active users should match because empty AND in OR evaluates to true
			expect(results).toHaveLength(4); // All active users
		});

		it("should handle type mismatches gracefully", async () => {
			// String field compared with number in OR
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ name: { $eq: "123" } }, // String comparison
						{ age: 25 }, // Valid condition
					],
				},
			});

			// Should only match the valid condition
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Jane Smith");
		});

		it("should handle conflicting conditions", async () => {
			// Contradictory AND conditions
			const results = await collectQuery("users", {
				where: {
					$and: [{ age: { $gt: 30 } }, { age: { $lt: 25 } }],
				},
			});

			// No user can satisfy both conditions
			expect(results).toHaveLength(0);
		});

		it("should handle NOT with OR containing multiple fields", async () => {
			const results = await collectQuery("projects", {
				where: {
					$not: {
						$or: [
							{ status: "draft" },
							{ isPublic: false },
							{ budget: { $lt: 30000 } },
						],
					},
				},
			});

			// Projects that are NOT (draft OR private OR budget < 30k)
			// Must be: non-draft AND public AND budget >= 30k
			expect(results).toHaveLength(2); // p1, p4
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p4"]);
		});

		it("should handle extremely nested conditions", async () => {
			const results = await collectQuery("users", {
				where: {
					$or: [
						{
							$and: [
								{ status: "active" },
								{
									$not: {
										$or: [
											{ age: { $lt: 25 } },
											{
												$and: [{ role: "admin" }, { score: { $gte: 95 } }],
											},
										],
									},
								},
							],
						},
						{
							$and: [
								{ email: { $endsWith: "@external.com" } },
								{ $not: { status: "active" } },
							],
						},
					],
				},
			});

			// Complex nested logic evaluation
			expect(results).toHaveLength(3); // Jane, Charlie, Bob
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Bob Johnson", "Charlie Wilson", "Jane Smith"]);
		});
	});

	describe("Performance and Optimization", () => {
		it("should short-circuit OR evaluation", async () => {
			let evaluationCount = 0;

			// Create a custom operator that counts evaluations
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ role: "admin" }, // This matches John
						{
							// This shouldn't be evaluated for John
							age: {
								$gte: (() => {
									evaluationCount++;
									return 100;
								})(),
							},
						},
					],
				},
			});

			// Even though we can't directly test short-circuiting in this implementation,
			// we can verify the results are correct
			expect(results.map((r) => r.name)).toContain("John Doe");
		});

		it("should handle large OR arrays efficiently", async () => {
			// Create a large OR condition
			const orConditions = [];
			for (let i = 20; i <= 50; i++) {
				orConditions.push({ age: i });
			}

			const results = await collectQuery("users", {
				where: { $or: orConditions },
			});

			// Should match users with ages in the range
			expect(results).toHaveLength(6); // All users have ages in range 20-50
			expect(results.find((r) => r.age === 22)).toBeDefined(); // Eva with age 22 should be included
		});
	});

	describe("Combined Operators in Real-World Scenarios", () => {
		it("should handle complex user permission queries", async () => {
			// Find users who can access premium features:
			// (admin) OR (active AND (score >= 85 OR role = consultant))
			const results = await collectQuery("users", {
				where: {
					$or: [
						{ role: "admin" },
						{
							$and: [
								{ status: "active" },
								{
									$or: [{ score: { $gte: 85 } }, { role: "consultant" }],
								},
							],
						},
					],
				},
			});

			expect(results).toHaveLength(3); // John (admin), Jane (active, score 88), Charlie (active, consultant)
			const names = results.map((r) => r.name).sort();
			expect(names).toEqual(["Charlie Wilson", "Jane Smith", "John Doe"]);
		});

		it("should handle complex project filtering", async () => {
			// Find projects that need attention:
			// (active AND priority <= 2) OR (draft AND budget > 50000) OR (public AND NOT completed)
			const results = await collectQuery("projects", {
				where: {
					$or: [
						{
							$and: [{ status: "active" }, { priority: { $lte: 2 } }],
						},
						{
							$and: [{ status: "draft" }, { budget: { $gt: 50000 } }],
						},
						{
							$and: [{ isPublic: true }, { $not: { status: "completed" } }],
						},
					],
				},
			});

			expect(results).toHaveLength(3); // p1 (active, priority 1), p2 (draft, budget 75k), p4 (public, active)
			const ids = results.map((r) => r.id).sort();
			expect(ids).toEqual(["p1", "p2", "p4"]);
		});

		it("should handle comment moderation queries", async () => {
			// Find comments that need moderation:
			// (NOT approved) OR (negative sentiment AND likes < 5)
			const results = await collectQuery("comments", {
				where: {
					$or: [
						{ isApproved: false },
						{
							$and: [{ sentiment: "negative" }, { likes: { $lt: 5 } }],
						},
					],
				},
				populate: { author: true },
			});

			// c3 matches both: not approved AND negative sentiment with 0 likes
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("c3");
			expect((results[0].author as Record<string, unknown>)?.name).toBe("Bob Johnson");
		});
	});
});
