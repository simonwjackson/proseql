import { describe, it, expect } from "vitest";
import { Effect, Schema, Stream, Chunk } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect";

describe("Database v2 - Field Selection/Projection (Effect/Stream)", () => {
	// ============================================================================
	// Test Schemas and Configuration
	// ============================================================================

	const AddressSchema = Schema.Struct({
		id: Schema.String,
		street: Schema.String,
		city: Schema.String,
		state: Schema.String,
		zipCode: Schema.String,
		country: Schema.String,
	});

	const CompanySchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		industry: Schema.String,
		foundedYear: Schema.Number,
		revenue: Schema.Number,
		employeeCount: Schema.Number,
		isPublic: Schema.Boolean,
		addressId: Schema.String,
	});

	const ProfileSchema = Schema.Struct({
		bio: Schema.String,
		avatar: Schema.String,
		location: Schema.String,
	});

	const UserSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		email: Schema.String,
		age: Schema.Number,
		companyId: Schema.String,
		isActive: Schema.Boolean,
		tags: Schema.Array(Schema.String),
		profile: ProfileSchema,
		createdAt: Schema.String,
		updatedAt: Schema.String,
	});

	const MetadataSchema = Schema.Struct({
		views: Schema.Number,
		likes: Schema.Number,
		shares: Schema.Number,
	});

	const PostSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		content: Schema.String,
		authorId: Schema.String,
		publishedAt: Schema.String,
		tags: Schema.Array(Schema.String),
		metadata: MetadataSchema,
	});

	const config = {
		addresses: {
			schema: AddressSchema,
			relationships: {
				companies: { type: "inverse" as const, target: "companies" },
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				address: { type: "ref" as const, target: "addresses" },
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
				author: {
					type: "ref" as const,
					target: "users" as const,
					foreignKey: "authorId" as const,
				},
			},
		},
	} as const;

	// ============================================================================
	// Test Data
	// ============================================================================

	const testData = {
		addresses: [
			{
				id: "addr1",
				street: "123 Tech Street",
				city: "San Francisco",
				state: "CA",
				zipCode: "94105",
				country: "USA",
			},
			{
				id: "addr2",
				street: "456 Startup Ave",
				city: "New York",
				state: "NY",
				zipCode: "10001",
				country: "USA",
			},
		],
		companies: [
			{
				id: "comp1",
				name: "TechCorp",
				industry: "Technology",
				foundedYear: 2010,
				revenue: 1000000,
				employeeCount: 100,
				isPublic: true,
				addressId: "addr1",
			},
			{
				id: "comp2",
				name: "StartupInc",
				industry: "Finance",
				foundedYear: 2020,
				revenue: 500000,
				employeeCount: 50,
				isPublic: false,
				addressId: "addr2",
			},
		],
		users: [
			{
				id: "user1",
				name: "Alice Johnson",
				email: "alice@techcorp.com",
				age: 30,
				companyId: "comp1",
				isActive: true,
				tags: ["developer", "senior", "frontend"],
				profile: {
					bio: "Senior developer at TechCorp",
					avatar: "alice.jpg",
					location: "San Francisco, CA",
				},
				createdAt: "2020-01-01",
				updatedAt: "2023-01-01",
			},
			{
				id: "user2",
				name: "Bob Smith",
				email: "bob@techcorp.com",
				age: 25,
				companyId: "comp1",
				isActive: true,
				tags: ["developer", "junior", "backend"],
				profile: {
					bio: "Junior developer at TechCorp",
					avatar: "bob.jpg",
					location: "San Francisco, CA",
				},
				createdAt: "2021-01-01",
				updatedAt: "2023-01-01",
			},
			{
				id: "user3",
				name: "Charlie Davis",
				email: "charlie@startupinc.com",
				age: 35,
				companyId: "comp2",
				isActive: false,
				tags: ["manager", "product"],
				profile: {
					bio: "Product manager at StartupInc",
					avatar: "charlie.jpg",
					location: "New York, NY",
				},
				createdAt: "2019-01-01",
				updatedAt: "2022-01-01",
			},
		],
		posts: [
			{
				id: "post1",
				title: "Getting Started with TypeScript",
				content: "TypeScript is a powerful language...",
				authorId: "user1",
				publishedAt: "2023-01-15",
				tags: ["typescript", "tutorial", "programming"],
				metadata: {
					views: 1000,
					likes: 100,
					shares: 50,
				},
			},
			{
				id: "post2",
				title: "React Best Practices",
				content: "When building React applications...",
				authorId: "user1",
				publishedAt: "2023-02-15",
				tags: ["react", "javascript", "frontend"],
				metadata: {
					views: 2000,
					likes: 200,
					shares: 100,
				},
			},
			{
				id: "post3",
				title: "Node.js Performance Tips",
				content: "Optimizing Node.js applications...",
				authorId: "user2",
				publishedAt: "2023-03-15",
				tags: ["nodejs", "performance", "backend"],
				metadata: {
					views: 500,
					likes: 50,
					shares: 25,
				},
			},
		],
	};

	// Helper: create database and collect query results
	const collectQuery = (
		collection: string,
		options: Record<string, unknown>,
		data = testData,
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

	const collectFirst = (
		collection: string,
		options: Record<string, unknown>,
		data = testData,
	): Promise<Record<string, unknown> | undefined> =>
		collectQuery(collection, options, data).then((arr) => arr[0]);

	// ============================================================================
	// Basic Field Selection Tests
	// ============================================================================

	describe("Basic Field Selection", () => {
		it("should select specific fields from a collection", async () => {
			const result = await collectQuery("users", {
				select: { name: true, email: true },
			});

			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({
				name: "Alice Johnson",
				email: "alice@techcorp.com",
			});
			expect(result[1]).toEqual({
				name: "Bob Smith",
				email: "bob@techcorp.com",
			});
			expect(result[2]).toEqual({
				name: "Charlie Davis",
				email: "charlie@startupinc.com",
			});

			// Verify only selected fields are present
			expect(Object.keys(result[0])).toEqual(["name", "email"]);
		});

		it("should select single field", async () => {
			const result = await collectQuery("companies", {
				select: { name: true },
			});

			expect(result).toEqual([{ name: "TechCorp" }, { name: "StartupInc" }]);
		});

		it("should select all fields when no select is provided", async () => {
			const result = await collectFirst("users", {});

			expect(result).toBeDefined();
			expect(result).toHaveProperty("id");
			expect(result).toHaveProperty("name");
			expect(result).toHaveProperty("email");
			expect(result).toHaveProperty("age");
			expect(result).toHaveProperty("companyId");
			expect(result).toHaveProperty("isActive");
			expect(result).toHaveProperty("tags");
			expect(result).toHaveProperty("profile");
			expect(result).toHaveProperty("createdAt");
			expect(result).toHaveProperty("updatedAt");
		});
	});

	// ============================================================================
	// Field Selection with Arrays and Nested Objects
	// ============================================================================

	describe("Field Selection with Complex Types", () => {
		it("should select array fields", async () => {
			const result = await collectQuery("users", {
				select: { name: true, tags: true },
			});

			expect(result[0]).toEqual({
				name: "Alice Johnson",
				tags: ["developer", "senior", "frontend"],
			});
		});

		it("should select nested object fields", async () => {
			const result = await collectFirst("users", {
				select: { name: true, profile: true },
				where: { id: "user1" },
			});

			expect(result).toEqual({
				name: "Alice Johnson",
				profile: {
					bio: "Senior developer at TechCorp",
					avatar: "alice.jpg",
					location: "San Francisco, CA",
				},
			});
		});

		it("should select metadata object from posts", async () => {
			const result = await collectQuery("posts", {
				select: { title: true, metadata: true },
			});

			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({
				title: "Getting Started with TypeScript",
				metadata: {
					views: 1000,
					likes: 100,
					shares: 50,
				},
			});
		});
	});

	// ============================================================================
	// Field Selection with Populated Relationships
	// ============================================================================

	describe("Field Selection with Population", () => {
		it("should select fields with populated single relationship", async () => {
			const result = await collectFirst("users", {
				select: { name: true, email: true, company: true },
				populate: { company: true },
				where: { id: "user1" },
			});

			expect(result).toBeDefined();
			if (!result) return;

			expect(result.name).toBe("Alice Johnson");
			expect(result.email).toBe("alice@techcorp.com");

			const company = result.company as Record<string, unknown>;
			expect(company).toBeDefined();
			expect(company.name).toBe("TechCorp");

			// Verify only selected fields are present (plus populated)
			const keys = Object.keys(result);
			expect(keys).toContain("name");
			expect(keys).toContain("email");
			expect(keys).toContain("company");
			expect(keys).not.toContain("age");
			expect(keys).not.toContain("id");
		});

		it("should select fields with populated array relationship", async () => {
			const result = await collectFirst("companies", {
				select: { name: true, industry: true, users: true },
				populate: { users: true },
				where: { id: "comp1" },
			});

			expect(result).toBeDefined();
			if (!result) return;

			expect(result.name).toBe("TechCorp");
			expect(result.industry).toBe("Technology");

			const users = result.users as Array<Record<string, unknown>>;
			expect(users).toHaveLength(2);
			expect(users[0].name).toBe("Alice Johnson");
		});

		it("should handle nested selection with deep population", async () => {
			const result = await collectFirst("posts", {
				select: { title: true, tags: true, author: true },
				populate: { author: true },
				where: { id: "post1" },
			});

			expect(result).toBeDefined();
			if (!result) return;

			expect(result.title).toBe("Getting Started with TypeScript");
			expect(result.tags).toEqual(["typescript", "tutorial", "programming"]);

			const author = result.author as Record<string, unknown> | undefined;
			if (author) {
				expect(author.name).toBe("Alice Johnson");
				expect(author.email).toBe("alice@techcorp.com");
			}
		});
	});

	// ============================================================================
	// Field Selection Combined with Other Operations
	// ============================================================================

	describe("Field Selection with Filtering and Sorting", () => {
		it("should select fields with where clause", async () => {
			const result = await collectQuery("users", {
				select: { name: true, age: true },
				where: { age: { $gte: 30 } },
			});

			expect(result).toHaveLength(2);
			expect(result).toEqual([
				{ name: "Alice Johnson", age: 30 },
				{ name: "Charlie Davis", age: 35 },
			]);
		});

		it("should select fields with sorting", async () => {
			const result = await collectQuery("users", {
				select: { name: true, age: true },
				sort: { age: "desc" },
			});

			expect(result).toEqual([
				{ name: "Charlie Davis", age: 35 },
				{ name: "Alice Johnson", age: 30 },
				{ name: "Bob Smith", age: 25 },
			]);
		});

		it("should select fields with limit and offset", async () => {
			const result = await collectQuery("posts", {
				select: { title: true },
				limit: 2,
				offset: 1,
			});

			expect(result).toHaveLength(2);
			expect(result).toEqual([
				{ title: "React Best Practices" },
				{ title: "Node.js Performance Tips" },
			]);
		});

		it("should combine selection, filtering, sorting, and population", async () => {
			const result = await collectQuery("users", {
				select: { name: true, email: true, age: true, company: true },
				populate: { company: true },
				where: {
					companyId: "comp1",
					age: { $gte: 25 },
				},
				sort: { name: "asc" },
			});

			expect(result).toHaveLength(2);

			expect(result[0].name).toBe("Alice Johnson");
			expect(result[0].email).toBe("alice@techcorp.com");
			expect(result[0].age).toBe(30);
			const company0 = result[0].company as Record<string, unknown> | undefined;
			if (company0) {
				expect(company0.name).toBe("TechCorp");
				expect(company0.industry).toBe("Technology");
			}

			expect(result[1].name).toBe("Bob Smith");
			expect(result[1].email).toBe("bob@techcorp.com");
			expect(result[1].age).toBe(25);
			const company1 = result[1].company as Record<string, unknown> | undefined;
			if (company1) {
				expect(company1.name).toBe("TechCorp");
				expect(company1.industry).toBe("Technology");
			}
		});
	});

	// ============================================================================
	// Edge Cases
	// ============================================================================

	describe("Edge Cases", () => {
		it("should handle selection on empty collection", async () => {
			const emptyData = {
				addresses: [],
				companies: [],
				users: [],
				posts: [],
			};

			const result = await collectQuery("users", {
				select: { name: true, email: true },
			}, emptyData);

			expect(result).toEqual([]);
		});

		it("should handle selection on collections with many fields", async () => {
			const result = await collectQuery("companies", {
				select: { id: true, name: true },
			});

			expect(result).toHaveLength(2);
			for (const company of result) {
				expect(Object.keys(company)).toHaveLength(2);
				expect(company).toHaveProperty("id");
				expect(company).toHaveProperty("name");
			}
		});
	});

	// ============================================================================
	// Performance Considerations
	// ============================================================================

	describe("Performance Considerations", () => {
		it("should efficiently select large nested objects", async () => {
			const largeProfileData = {
				...testData,
				users: [
					{
						...testData.users[0],
						profile: {
							bio: "A".repeat(10000),
							avatar: "avatar.jpg",
							location: "Location",
						},
					},
				],
			};

			const result = await collectFirst("users", {
				select: { name: true, email: true },
			}, largeProfileData);

			expect(result).toBeDefined();
			if (!result) return;

			expect(result.name).toBe("Alice Johnson");
			expect(result.email).toBe("alice@techcorp.com");
			expect(result).not.toHaveProperty("profile");
		});
	});
});
