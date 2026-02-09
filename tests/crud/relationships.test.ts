import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import type { GenerateDatabase } from "../../core/types/types";
import { isOk, isErr, type Result } from "../../core/errors/crud-errors";
import { collect } from "../../core/utils/async-iterable.js";

/**
 * Safely unwrap a Result type after checking success
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
}

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	companyId: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	industry: z.string(),
	addressId: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const AddressSchema = z.object({
	id: z.string(),
	street: z.string(),
	city: z.string(),
	country: z.string(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	categoryId: z.string().nullable().optional(),
	published: z.boolean().default(false),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	description: z.string().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const TagSchema = z.object({
	id: z.string(),
	name: z.string(),
	postId: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const RoleSchema = z.object({
	id: z.string(),
	name: z.string(),
	userId: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// ============================================================================
// Test Database Configuration
// ============================================================================

const testConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			company: {
				type: "ref" as const,
				target: "companies",
				foreignKey: "companyId",
			},
			posts: { type: "inverse" as const, target: "posts" },
			roles: { type: "inverse" as const, target: "roles" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users" },
			address: {
				type: "ref" as const,
				target: "addresses",
				foreignKey: "addressId",
			},
		},
	},
	addresses: {
		schema: AddressSchema,
		relationships: {
			company: { type: "inverse" as const, target: "companies" },
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users", foreignKey: "authorId" },
			category: {
				type: "ref" as const,
				target: "categories",
				foreignKey: "categoryId",
			},
			tags: { type: "inverse" as const, target: "tags" },
		},
	},
	categories: {
		schema: CategorySchema,
		relationships: {
			posts: { type: "inverse" as const, target: "posts" },
		},
	},
	tags: {
		schema: TagSchema,
		relationships: {
			post: { type: "ref" as const, target: "posts", foreignKey: "postId" },
		},
	},
	roles: {
		schema: RoleSchema,
		relationships: {
			user: { type: "ref" as const, target: "users", foreignKey: "userId" },
		},
	},
};

// ============================================================================
// Tests
// ============================================================================

describe("CRUD with Relationships", () => {
	let testData: ReturnType<typeof createTestData>;
	let db: GenerateDatabase<typeof testConfig>;

	function createTestData() {
		return {
			users: [] as z.infer<typeof UserSchema>[],
			companies: [] as z.infer<typeof CompanySchema>[],
			addresses: [] as z.infer<typeof AddressSchema>[],
			posts: [] as z.infer<typeof PostSchema>[],
			categories: [] as z.infer<typeof CategorySchema>[],
			tags: [] as z.infer<typeof TagSchema>[],
			roles: [] as z.infer<typeof RoleSchema>[],
		};
	}

	beforeEach(() => {
		testData = createTestData();
		db = createDatabase(testConfig, testData);
	});

	describe("Create with Relationships", () => {
		describe("Connect Existing Relationships", () => {
			it("should connect to existing entity by ID", async () => {
				// First create a company
				const companyResult = await db.companies.create({
					name: "Acme Corp",
					industry: "Technology",
				});
				const company = unwrapResult(companyResult);

				// Create user connected to company
				const userResult = await db.users.createWithRelationships({
					name: "John Doe",
					email: "john@example.com",
					company: {
						$connect: { id: company.id },
					},
				} as Parameters<typeof db.users.createWithRelationships>[0]);

				const user = unwrapResult(userResult);

				expect(user.companyId).toBe(company.id);

				// Verify the relationship
				const foundUsers = await collect(
					db.users.query({
						where: { id: user.id },
						populate: { company: true },
					}),
				);

				expect(foundUsers).toHaveLength(1);
				const foundUser = foundUsers[0] as (typeof foundUsers)[0] & {
					company?: z.infer<typeof CompanySchema>;
				};
				expect(foundUser?.company?.id).toBe(company.id);
			});

			it("should connect to existing entity by unique field", async () => {
				// Create a category
				const categoryResult = await db.categories.create({
					name: "Technology",
					slug: "technology",
					description: "Tech articles",
				});
				expect(isOk(categoryResult)).toBe(true);
				if (!isOk(categoryResult)) return;

				// Create an author
				const authorResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(authorResult)).toBe(true);
				if (!isOk(authorResult)) return;

				// Create post connected by slug
				const postResult = await db.posts.createWithRelationships({
					title: "My Post",
					content: "Post content",
					author: {
						$connect: { id: authorResult.data.id },
					},
					category: {
						$connect: { slug: "technology" },
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]);

				expect(isOk(postResult)).toBe(true);
				if (!isOk(postResult)) return;
				const post = postResult.data;

				expect(post.categoryId).toBe(categoryResult.data.id);
			});

			it("should connect multiple entities for many-to-many relationships", async () => {
				// Create roles
				const role1Result = await db.roles.create({ name: "Admin" });
				const role2Result = await db.roles.create({ name: "Editor" });
				expect(isOk(role1Result)).toBe(true);
				expect(isOk(role2Result)).toBe(true);
				if (!isOk(role1Result) || !isOk(role2Result)) return;

				// Create user with multiple roles
				const userResult = await db.users.createWithRelationships({
					name: "John Doe",
					email: "john@example.com",
					roles: {
						$connect: [
							{ id: role1Result.data.id },
							{ id: role2Result.data.id },
						],
					},
				} as Parameters<typeof db.users.createWithRelationships>[0]);

				expect(isOk(userResult)).toBe(true);
				if (!isOk(userResult)) return;

				// Verify roles are connected
				const roles = await collect(
					db.roles.query({
						where: { userId: userResult.data.id },
					}),
				);

				expect(roles).toHaveLength(2);
				expect(roles.map((r) => r.name).sort()).toEqual(["Admin", "Editor"]);
			});
		});

		describe("Create Nested Relationships", () => {
			it("should create nested single entity", async () => {
				const companyResult = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					address: {
						$create: {
							street: "123 Main St",
							city: "San Francisco",
							country: "USA",
						},
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0]);

				expect(isOk(companyResult)).toBe(true);
				if (!isOk(companyResult)) return;
				const company = companyResult.data;

				expect(company.addressId).toBeDefined();

				// Verify address was created
				const addresses = await collect(
					db.addresses.query({
						where: { id: company.addressId! },
					}),
				);
				expect(addresses).toHaveLength(1);
				const address = addresses[0]!;

				expect(address.street).toBe("123 Main St");
				expect(address.city).toBe("San Francisco");
			});

			it("should create nested multiple entities", async () => {
				const companyResult = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					employees: {
						$create: [
							{
								name: "John CEO",
								email: "john@acme.com",
							},
							{
								name: "Jane CTO",
								email: "jane@acme.com",
							},
						],
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0]);

				expect(isOk(companyResult)).toBe(true);
				if (!isOk(companyResult)) return;

				// Verify employees were created
				const employees = await collect(
					db.users.query({
						where: { companyId: companyResult.data.id },
					}),
				);

				expect(employees).toHaveLength(2);
				expect(employees.map((e) => e.name).sort()).toEqual([
					"Jane CTO",
					"John CEO",
				]);
			});
		});

		describe("Connect or Create Pattern", () => {
			it("should connect to existing entity if found", async () => {
				// Create a tag
				const tagResult = await db.tags.create({ name: "javascript" });
				expect(isOk(tagResult)).toBe(true);
				if (!isOk(tagResult)) return;

				// Create author
				const authorResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(authorResult)).toBe(true);
				if (!isOk(authorResult)) return;

				const initialTagCount = testData.tags.length;

				// Create post with connectOrCreate
				const postResult = await db.posts.createWithRelationships({
					title: "New Post",
					content: "Post content",
					author: { $connect: { id: authorResult.data.id } },
					tags: {
						$connectOrCreate: [
							{
								where: { name: "javascript" },
								create: { name: "javascript" },
							},
						],
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]);

				expect(isOk(postResult)).toBe(true);
				if (!isOk(postResult)) return;

				// Should not create a new tag
				expect(testData.tags.length).toBe(initialTagCount);
			});

			it("should create new entity if not found", async () => {
				// Create author
				const authorResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(authorResult)).toBe(true);
				if (!isOk(authorResult)) return;

				const initialTagCount = testData.tags.length;

				// Create post with connectOrCreate
				const postResult = await db.posts.createWithRelationships({
					title: "New Post",
					content: "Post content",
					author: { $connect: { id: authorResult.data.id } },
					tags: {
						$connectOrCreate: [
							{
								where: { name: "typescript" },
								create: { name: "typescript" },
							},
						],
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]);

				expect(isOk(postResult)).toBe(true);
				if (!isOk(postResult)) return;

				// Should create a new tag
				expect(testData.tags.length).toBe(initialTagCount + 1);

				const newTag = testData.tags.find((t) => t.name === "typescript");
				expect(newTag).toBeDefined();
				expect(newTag?.postId).toBe(postResult.data.id);
			});
		});
	});

	describe("Update with Relationships", () => {
		describe("Update Relationship Connections", () => {
			it("should change a belongs-to relationship", async () => {
				// Create companies
				const company1Result = await db.companies.create({
					name: "Company 1",
					industry: "Tech",
				});
				const company2Result = await db.companies.create({
					name: "Company 2",
					industry: "Finance",
				});
				expect(isOk(company1Result)).toBe(true);
				expect(isOk(company2Result)).toBe(true);
				if (!isOk(company1Result) || !isOk(company2Result)) return;

				// Create user with company1
				const userResult = await db.users.create({
					name: "John",
					email: "john@example.com",
					companyId: company1Result.data.id,
				});
				expect(isOk(userResult)).toBe(true);
				if (!isOk(userResult)) return;

				// Update to company2
				const updateResult = await db.users.updateWithRelationships(
					userResult.data.id,
					{
						company: {
							$connect: { id: company2Result.data.id },
						},
					} as Parameters<typeof db.users.updateWithRelationships>[1],
				);

				expect(isOk(updateResult)).toBe(true);
				if (!isOk(updateResult)) return;

				expect(updateResult.data.companyId).toBe(company2Result.data.id);
			});

			it("should disconnect a relationship", async () => {
				// Create company and user
				const companyResult = await db.companies.create({
					name: "Company",
					industry: "Tech",
				});
				expect(isOk(companyResult)).toBe(true);
				if (!isOk(companyResult)) return;

				const userResult = await db.users.create({
					name: "John",
					email: "john@example.com",
					companyId: companyResult.data.id,
				});
				expect(isOk(userResult)).toBe(true);
				if (!isOk(userResult)) return;

				// Disconnect company
				const updateResult = await db.users.updateWithRelationships(
					userResult.data.id,
					{
						company: {
							$disconnect: true,
						},
					} as Parameters<typeof db.users.updateWithRelationships>[1],
				);

				expect(isOk(updateResult)).toBe(true);
				if (!isOk(updateResult)) return;

				expect(updateResult.data.companyId).toBe(null);
			});

			it("should update many-to-many relationships with $set", async () => {
				// Create user and roles
				const userResult = await db.users.create({
					name: "John",
					email: "john@example.com",
				});
				expect(isOk(userResult)).toBe(true);
				if (!isOk(userResult)) return;

				const role1Result = await db.roles.create({
					name: "Admin",
					userId: userResult.data.id,
				});
				const role2Result = await db.roles.create({
					name: "Editor",
					userId: userResult.data.id,
				});
				const role3Result = await db.roles.create({ name: "Viewer" });
				expect(isOk(role1Result)).toBe(true);
				expect(isOk(role2Result)).toBe(true);
				expect(isOk(role3Result)).toBe(true);
				if (
					!isOk(userResult) ||
					!isOk(role1Result) ||
					!isOk(role2Result) ||
					!isOk(role3Result)
				)
					return;

				// Replace all roles
				const updateResult = await db.users.updateWithRelationships(
					userResult.data.id,
					{
						roles: {
							$set: [{ id: role2Result.data.id }, { id: role3Result.data.id }],
						},
					} as Parameters<typeof db.users.updateWithRelationships>[1],
				);

				expect(isOk(updateResult)).toBe(true);
				if (!isOk(updateResult)) return;

				// Verify roles
				const userRoles = await collect(
					db.roles.query({
						where: { userId: userResult.data.id },
					}),
				);

				expect(userRoles).toHaveLength(2);
				expect(userRoles.map((r) => r.name).sort()).toEqual([
					"Editor",
					"Viewer",
				]);
			});
		});

		describe("Update Nested Entities", () => {
			it("should update nested entity through parent", async () => {
				// Create company with address
				const companyResult = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					address: {
						$create: {
							street: "123 Main St",
							city: "San Francisco",
							country: "USA",
						},
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0]);
				expect(isOk(companyResult)).toBe(true);
				if (!isOk(companyResult)) return;

				// Update nested address
				const updateResult = await db.companies.updateWithRelationships(
					companyResult.data.id,
					{
						name: "Updated Corp",
						address: {
							$update: {
								street: "456 New St",
								city: "New York",
							},
						},
					} as Parameters<typeof db.companies.updateWithRelationships>[1],
				);

				expect(isOk(updateResult)).toBe(true);
				if (!isOk(updateResult)) return;

				// Verify address was updated
				const addresses = await collect(
					db.addresses.query({
						where: { id: companyResult.data.addressId! },
					}),
				);
				expect(addresses).toHaveLength(1);
				const address = addresses[0]!;

				expect(address.street).toBe("456 New St");
				expect(address.city).toBe("New York");
				expect(address.country).toBe("USA"); // Unchanged
			});
		});
	});

	describe("Delete with Relationships", () => {
		describe("Cascade Delete", () => {
			it("should cascade delete related entities", async () => {
				// Create company with employees
				const companyResult = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					employees: {
						$create: [
							{ name: "John", email: "john@acme.com" },
							{ name: "Jane", email: "jane@acme.com" },
						],
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0]);
				expect(isOk(companyResult)).toBe(true);
				if (!isOk(companyResult)) return;

				const initialUserCount = testData.users.length;

				// Delete company with cascade
				const deleteResult = await db.companies.deleteWithRelationships(
					companyResult.data.id,
					{
						include: {
							employees: "cascade",
						},
					},
				);

				expect(isOk(deleteResult)).toBe(true);
				if (!isOk(deleteResult)) return;

				// Verify employees were deleted
				expect(testData.users.length).toBe(initialUserCount - 2);
				expect(deleteResult.data.cascaded?.users).toEqual({
					count: 2,
					ids: expect.arrayContaining([expect.any(String), expect.any(String)]),
				});
			});
		});

		describe("Restrict Delete", () => {
			it("should prevent deletion if related entities exist", async () => {
				// Create category with posts
				const categoryResult = await db.categories.create({
					name: "Technology",
					slug: "technology",
				});
				expect(isOk(categoryResult)).toBe(true);
				if (!isOk(categoryResult)) return;

				const authorResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(authorResult)).toBe(true);
				if (!isOk(authorResult)) return;

				const postResult = await db.posts.create({
					title: "Post 1",
					content: "Content",
					authorId: authorResult.data.id,
					categoryId: categoryResult.data.id,
				});
				expect(isOk(postResult)).toBe(true);
				if (!isOk(postResult)) return;

				// Try to delete category with restrict
				const deleteResult = await db.categories.deleteWithRelationships(
					categoryResult.data.id,
					{
						include: {
							posts: "restrict",
						},
					},
				);

				expect(isErr(deleteResult)).toBe(true);
				if (!isErr(deleteResult)) return;

				expect(deleteResult.error.code).toBe("VALIDATION_ERROR");
			});
		});

		describe("Set Null on Delete", () => {
			it("should set foreign keys to null", async () => {
				// Create user with posts
				const userResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(userResult)).toBe(true);
				if (!isOk(userResult)) return;

				const post1Result = await db.posts.create({
					title: "Post 1",
					content: "Content 1",
					authorId: userResult.data.id,
				});
				const post2Result = await db.posts.create({
					title: "Post 2",
					content: "Content 2",
					authorId: userResult.data.id,
				});
				expect(isOk(post1Result)).toBe(true);
				expect(isOk(post2Result)).toBe(true);
				if (!isOk(post1Result) || !isOk(post2Result)) return;

				// Delete user with set_null
				const deleteResult = await db.users.deleteWithRelationships(
					userResult.data.id,
					{
						include: {
							posts: "set_null",
						},
					},
				);

				expect(isOk(deleteResult)).toBe(true);
				if (!isOk(deleteResult)) return;

				// Verify posts still exist but authorId is null
				const posts = await collect(
					db.posts.query({
						where: { id: { $in: [post1Result.data.id, post2Result.data.id] } },
					}),
				);

				expect(posts).toHaveLength(2);
				expect(posts.every((p) => p.authorId === null)).toBe(true);
			});
		});

		describe("Delete Many with Relationships", () => {
			it("should delete many with cascade", async () => {
				// Create categories with posts
				const cat1Result = await db.categories.create({
					name: "Cat1",
					slug: "cat1",
				});
				const cat2Result = await db.categories.create({
					name: "Cat2",
					slug: "cat2",
				});
				expect(isOk(cat1Result)).toBe(true);
				expect(isOk(cat2Result)).toBe(true);
				if (!isOk(cat1Result) || !isOk(cat2Result)) return;

				const authorResult = await db.users.create({
					name: "Author",
					email: "author@example.com",
				});
				expect(isOk(authorResult)).toBe(true);
				if (!isOk(authorResult)) return;

				// Create posts for each category
				await db.posts.create({
					title: "Post 1",
					content: "Content",
					authorId: authorResult.data.id,
					categoryId: cat1Result.data.id,
				});
				await db.posts.create({
					title: "Post 2",
					content: "Content",
					authorId: authorResult.data.id,
					categoryId: cat2Result.data.id,
				});

				const initialPostCount = testData.posts.length;

				// Delete all categories with cascade
				const deleteResult = await db.categories.deleteManyWithRelationships(
					{},
					{
						include: {
							posts: "cascade",
						},
					},
				);

				expect(isOk(deleteResult)).toBe(true);
				if (!isOk(deleteResult)) return;

				expect(deleteResult.data.count).toBe(2);
				expect(testData.posts.length).toBe(initialPostCount - 2);
			});
		});
	});

	describe("Complex Relationship Scenarios", () => {
		it("should handle deep nested creation", async () => {
			// Create a company with address and employees, where employees have roles
			const companyResult = await db.companies.createWithRelationships({
				name: "Tech Corp",
				industry: "Technology",
				address: {
					$create: {
						street: "789 Tech Ave",
						city: "Silicon Valley",
						country: "USA",
					},
				},
				employees: {
					$create: [
						{
							name: "Alice CEO",
							email: "alice@techcorp.com",
						},
						{
							name: "Bob CTO",
							email: "bob@techcorp.com",
						},
					],
				},
			} as Parameters<typeof db.companies.createWithRelationships>[0]);

			expect(isOk(companyResult)).toBe(true);
			if (!isOk(companyResult)) return;

			// Verify all entities were created
			const companies = await collect(
				db.companies.query({
					where: { id: companyResult.data.id },
					populate: {
						address: true,
						employees: true,
					},
				}),
			);

			expect(companies).toHaveLength(1);
			const company = companies[0] as (typeof companies)[0] & {
				address?: { street: string; city: string; country: string };
				employees?: Array<{ name: string; email: string }>;
			};

			expect(company.address?.street).toBe("789 Tech Ave");
			expect(company.employees).toHaveLength(2);
			expect(company.employees?.map((e) => e.name).sort()).toEqual([
				"Alice CEO",
				"Bob CTO",
			]);
		});

		it("should handle complex update with multiple operations", async () => {
			// Setup initial data
			const companyResult = await db.companies.create({
				name: "Old Corp",
				industry: "Finance",
			});
			const user1Result = await db.users.create({
				name: "User 1",
				email: "user1@example.com",
				companyId: isOk(companyResult) ? companyResult.data.id : "",
			});
			const user2Result = await db.users.create({
				name: "User 2",
				email: "user2@example.com",
				companyId: isOk(companyResult) ? companyResult.data.id : "",
			});
			const user3Result = await db.users.create({
				name: "User 3",
				email: "user3@example.com",
			});

			expect(isOk(companyResult)).toBe(true);
			expect(isOk(user1Result)).toBe(true);
			expect(isOk(user2Result)).toBe(true);
			expect(isOk(user3Result)).toBe(true);
			if (
				!isOk(companyResult) ||
				!isOk(user1Result) ||
				!isOk(user2Result) ||
				!isOk(user3Result)
			)
				return;

			// Complex update
			const updateResult = await db.companies.updateWithRelationships(
				companyResult.data.id,
				{
					name: "New Corp",
					employees: {
						$disconnect: [{ id: user1Result.data.id }],
						$connect: [{ id: user3Result.data.id }],
					},
				} as Parameters<typeof db.companies.updateWithRelationships>[1],
			);

			expect(isOk(updateResult)).toBe(true);
			if (!isOk(updateResult)) return;

			// Verify changes
			const employees = await collect(
				db.users.query({
					where: { companyId: companyResult.data.id },
				}),
			);

			expect(employees).toHaveLength(2);
			expect(employees.map((e) => e.name).sort()).toEqual(["User 2", "User 3"]);
		});
	});
});
