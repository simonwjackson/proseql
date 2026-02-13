import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import type { GenerateDatabase } from "../../src/types/types";

// ============================================================================
// Effect Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	companyId: Schema.optional(Schema.NullOr(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	industry: Schema.String,
	addressId: Schema.optional(Schema.NullOr(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const AddressSchema = Schema.Struct({
	id: Schema.String,
	street: Schema.String,
	city: Schema.String,
	country: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.optional(Schema.String),
	categoryId: Schema.optional(Schema.NullOr(Schema.String)),
	published: Schema.optional(Schema.Boolean, { default: () => false }),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const CategorySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	description: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const TagSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	postId: Schema.optional(Schema.NullOr(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const RoleSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	userId: Schema.optional(Schema.NullOr(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
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
				target: "companies" as const,
				foreignKey: "companyId",
			},
			posts: {
				type: "inverse" as const,
				target: "posts" as const,
				foreignKey: "authorId",
			},
			roles: {
				type: "inverse" as const,
				target: "roles" as const,
				foreignKey: "userId",
			},
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: {
				type: "inverse" as const,
				target: "users" as const,
				foreignKey: "companyId",
			},
			address: {
				type: "ref" as const,
				target: "addresses" as const,
				foreignKey: "addressId",
			},
		},
	},
	addresses: {
		schema: AddressSchema,
		relationships: {
			company: {
				type: "inverse" as const,
				target: "companies" as const,
				foreignKey: "addressId",
			},
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
			category: {
				type: "ref" as const,
				target: "categories" as const,
				foreignKey: "categoryId",
			},
			tags: {
				type: "inverse" as const,
				target: "tags" as const,
				foreignKey: "postId",
			},
		},
	},
	categories: {
		schema: CategorySchema,
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts" as const,
				foreignKey: "categoryId",
			},
		},
	},
	tags: {
		schema: TagSchema,
		relationships: {
			post: {
				type: "ref" as const,
				target: "posts" as const,
				foreignKey: "postId",
			},
		},
	},
	roles: {
		schema: RoleSchema,
		relationships: {
			user: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "userId",
			},
		},
	},
} as const;

// ============================================================================
// Tests
// ============================================================================

describe("CRUD with Relationships (Effect-based)", () => {
	let db: GenerateDatabase<typeof testConfig>;

	beforeEach(async () => {
		db = await Effect.runPromise(
			createEffectDatabase(testConfig, {
				users: [],
				companies: [],
				addresses: [],
				posts: [],
				categories: [],
				tags: [],
				roles: [],
			}),
		);
	});

	describe("Create with Relationships", () => {
		describe("Connect Existing Relationships", () => {
			it("should connect to existing entity by ID", async () => {
				// First create a company
				const company = await db.companies.create({
					name: "Acme Corp",
					industry: "Technology",
					addressId: null,
				}).runPromise;

				// Create user connected to company
				const user = await db.users.createWithRelationships({
					name: "John Doe",
					email: "john@example.com",
					company: {
						$connect: { id: company.id },
					},
				} as Parameters<typeof db.users.createWithRelationships>[0]).runPromise;

				expect(user.companyId).toBe(company.id);

				// Verify the relationship via query with populate
				const foundUsers = await db.users.query({
					where: { id: user.id },
					populate: { company: true },
				}).runPromise;

				expect(foundUsers).toHaveLength(1);
				const foundUser = foundUsers[0] as Record<string, unknown>;
				expect((foundUser?.company as Record<string, unknown>)?.id).toBe(
					company.id,
				);
			});

			it("should connect to existing entity by unique field", async () => {
				// Create a category
				const category = await db.categories.create({
					name: "Technology",
					slug: "technology",
					description: "Tech articles",
				}).runPromise;

				// Create an author
				const author = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				// Create post connected by slug
				const post = await db.posts.createWithRelationships({
					title: "My Post",
					content: "Post content",
					author: {
						$connect: { id: author.id },
					},
					category: {
						$connect: { slug: "technology" },
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]).runPromise;

				expect(post.categoryId).toBe(category.id);
			});

			it("should connect multiple entities for many-to-many relationships", async () => {
				// Create roles
				const role1 = await db.roles.create({ name: "Admin", userId: null })
					.runPromise;
				const role2 = await db.roles.create({ name: "Editor", userId: null })
					.runPromise;

				// Create user with multiple roles
				const user = await db.users.createWithRelationships({
					name: "John Doe",
					email: "john@example.com",
					roles: {
						$connect: [{ id: role1.id }, { id: role2.id }],
					},
				} as Parameters<typeof db.users.createWithRelationships>[0]).runPromise;

				// Verify roles are connected
				const roles = await db.roles.query({
					where: { userId: user.id },
				}).runPromise;

				expect(roles).toHaveLength(2);
				expect(
					roles.map((r) => (r as Record<string, unknown>).name).sort(),
				).toEqual(["Admin", "Editor"]);
			});
		});

		describe("Create Nested Relationships", () => {
			it("should create nested single entity", async () => {
				const company = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					address: {
						$create: {
							street: "123 Main St",
							city: "San Francisco",
							country: "USA",
						},
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0])
					.runPromise;

				expect(company.addressId).toBeDefined();

				// Verify address was created
				const addresses = await db.addresses.query({
					where: { id: company.addressId! },
				}).runPromise;
				expect(addresses).toHaveLength(1);
				const address = addresses[0] as Record<string, unknown>;

				expect(address.street).toBe("123 Main St");
				expect(address.city).toBe("San Francisco");
			});

			it("should create nested multiple entities", async () => {
				const company = await db.companies.createWithRelationships({
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
				} as Parameters<typeof db.companies.createWithRelationships>[0])
					.runPromise;

				// Verify employees were created
				const employees = await db.users.query({
					where: { companyId: company.id },
				}).runPromise;

				expect(employees).toHaveLength(2);
				expect(
					employees.map((e) => (e as Record<string, unknown>).name).sort(),
				).toEqual(["Jane CTO", "John CEO"]);
			});
		});

		describe("Connect or Create Pattern", () => {
			it("should connect to existing entity if found", async () => {
				// Create a tag
				const _tag = await db.tags.create({ name: "javascript", postId: null })
					.runPromise;

				// Create author
				const author = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				// Count tags before
				const tagsBefore = await db.tags.query().runPromise;
				const initialTagCount = tagsBefore.length;

				// Create post with connectOrCreate
				await db.posts.createWithRelationships({
					title: "New Post",
					content: "Post content",
					author: { $connect: { id: author.id } },
					tags: {
						$connectOrCreate: [
							{
								where: { name: "javascript" },
								create: { name: "javascript" },
							},
						],
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]).runPromise;

				// Should not create a new tag
				const tagsAfter = await db.tags.query().runPromise;
				expect(tagsAfter.length).toBe(initialTagCount);
			});

			it("should create new entity if not found", async () => {
				// Create author
				const author = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				// Count tags before
				const tagsBefore = await db.tags.query().runPromise;
				const initialTagCount = tagsBefore.length;

				// Create post with connectOrCreate
				const post = await db.posts.createWithRelationships({
					title: "New Post",
					content: "Post content",
					author: { $connect: { id: author.id } },
					tags: {
						$connectOrCreate: [
							{
								where: { name: "typescript" },
								create: { name: "typescript" },
							},
						],
					},
				} as Parameters<typeof db.posts.createWithRelationships>[0]).runPromise;

				// Should create a new tag
				const tagsAfter = await db.tags.query().runPromise;
				expect(tagsAfter.length).toBe(initialTagCount + 1);

				const newTag = tagsAfter.find(
					(t) => (t as Record<string, unknown>).name === "typescript",
				) as Record<string, unknown> | undefined;
				expect(newTag).toBeDefined();
				expect(newTag?.postId).toBe(post.id);
			});
		});
	});

	describe("Update with Relationships", () => {
		describe("Update Relationship Connections", () => {
			it("should change a belongs-to relationship", async () => {
				// Create companies
				const company1 = await db.companies.create({
					name: "Company 1",
					industry: "Tech",
					addressId: null,
				}).runPromise;
				const company2 = await db.companies.create({
					name: "Company 2",
					industry: "Finance",
					addressId: null,
				}).runPromise;

				// Create user with company1
				const user = await db.users.create({
					name: "John",
					email: "john@example.com",
					companyId: company1.id,
				}).runPromise;

				// Update to company2
				const updated = await db.users.updateWithRelationships(user.id, {
					company: {
						$connect: { id: company2.id },
					},
				} as Parameters<typeof db.users.updateWithRelationships>[1]).runPromise;

				expect(updated.companyId).toBe(company2.id);
			});

			it("should disconnect a relationship", async () => {
				// Create company and user
				const company = await db.companies.create({
					name: "Company",
					industry: "Tech",
					addressId: null,
				}).runPromise;

				const user = await db.users.create({
					name: "John",
					email: "john@example.com",
					companyId: company.id,
				}).runPromise;

				// Disconnect company
				const updated = await db.users.updateWithRelationships(user.id, {
					company: {
						$disconnect: true,
					},
				} as Parameters<typeof db.users.updateWithRelationships>[1]).runPromise;

				expect(updated.companyId).toBe(null);
			});

			it("should update many-to-many relationships with $set", async () => {
				// Create user and roles
				const user = await db.users.create({
					name: "John",
					email: "john@example.com",
					companyId: null,
				}).runPromise;

				const _role1 = await db.roles.create({
					name: "Admin",
					userId: user.id,
				}).runPromise;
				const role2 = await db.roles.create({
					name: "Editor",
					userId: user.id,
				}).runPromise;
				const role3 = await db.roles.create({ name: "Viewer", userId: null })
					.runPromise;

				// Replace all roles
				await db.users.updateWithRelationships(user.id, {
					roles: {
						$set: [{ id: role2.id }, { id: role3.id }],
					},
				} as Parameters<typeof db.users.updateWithRelationships>[1]).runPromise;

				// Verify roles
				const userRoles = await db.roles.query({
					where: { userId: user.id },
				}).runPromise;

				expect(userRoles).toHaveLength(2);
				expect(
					userRoles.map((r) => (r as Record<string, unknown>).name).sort(),
				).toEqual(["Editor", "Viewer"]);
			});
		});

		describe("Update Nested Entities", () => {
			it("should update nested entity through parent", async () => {
				// Create company with address
				const company = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					address: {
						$create: {
							street: "123 Main St",
							city: "San Francisco",
							country: "USA",
						},
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0])
					.runPromise;

				// Update nested address
				await db.companies.updateWithRelationships(company.id, {
					name: "Updated Corp",
					address: {
						$update: {
							street: "456 New St",
							city: "New York",
						},
					},
				} as Parameters<typeof db.companies.updateWithRelationships>[1])
					.runPromise;

				// Verify address was updated
				const addresses = await db.addresses.query({
					where: { id: company.addressId! },
				}).runPromise;
				expect(addresses).toHaveLength(1);
				const address = addresses[0] as Record<string, unknown>;

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
				const company = await db.companies.createWithRelationships({
					name: "Acme Corp",
					industry: "Technology",
					employees: {
						$create: [
							{ name: "John", email: "john@acme.com" },
							{ name: "Jane", email: "jane@acme.com" },
						],
					},
				} as Parameters<typeof db.companies.createWithRelationships>[0])
					.runPromise;

				// Verify employees exist
				const usersBefore = await db.users.query().runPromise;

				// Delete company with cascade
				const deleteResult = await db.companies.deleteWithRelationships(
					company.id,
					{
						include: {
							employees: "cascade",
						},
					},
				).runPromise;

				// Verify employees were deleted
				const usersAfter = await db.users.query().runPromise;
				expect(usersAfter.length).toBe(usersBefore.length - 2);
				expect(deleteResult.cascaded?.users).toEqual({
					count: 2,
					ids: expect.arrayContaining([expect.any(String), expect.any(String)]),
				});
			});
		});

		describe("Restrict Delete", () => {
			it("should prevent deletion if related entities exist", async () => {
				// Create category with posts
				const category = await db.categories.create({
					name: "Technology",
					slug: "technology",
				}).runPromise;

				const author = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				await db.posts.create({
					title: "Post 1",
					content: "Content",
					authorId: author.id,
					categoryId: category.id,
				}).runPromise;

				// Try to delete category with restrict — should fail
				const result = await Effect.runPromise(
					Effect.either(
						db.categories.deleteWithRelationships(category.id, {
							include: {
								posts: "restrict",
							},
						}),
					),
				);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left._tag).toBe("ValidationError");
				}
			});
		});

		describe("Set Null on Delete", () => {
			it("should set foreign keys to null", async () => {
				// Create user with posts
				const user = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				const post1 = await db.posts.create({
					title: "Post 1",
					content: "Content 1",
					authorId: user.id,
					categoryId: null,
				}).runPromise;
				const post2 = await db.posts.create({
					title: "Post 2",
					content: "Content 2",
					authorId: user.id,
					categoryId: null,
				}).runPromise;

				// Delete user with set_null
				await db.users.deleteWithRelationships(user.id, {
					include: {
						posts: "set_null",
					},
				}).runPromise;

				// Verify posts still exist but authorId is null
				const posts = await db.posts.query({
					where: { id: { $in: [post1.id, post2.id] } },
				}).runPromise;

				expect(posts).toHaveLength(2);
				expect(
					posts.every((p) => (p as Record<string, unknown>).authorId === null),
				).toBe(true);
			});
		});

		describe("Delete Many with Relationships", () => {
			it("should delete many with cascade", async () => {
				// Create categories with posts
				const cat1 = await db.categories.create({
					name: "Cat1",
					slug: "cat1",
				}).runPromise;
				const cat2 = await db.categories.create({
					name: "Cat2",
					slug: "cat2",
				}).runPromise;

				const author = await db.users.create({
					name: "Author",
					email: "author@example.com",
					companyId: null,
				}).runPromise;

				// Create posts for each category
				await db.posts.create({
					title: "Post 1",
					content: "Content",
					authorId: author.id,
					categoryId: cat1.id,
				}).runPromise;
				await db.posts.create({
					title: "Post 2",
					content: "Content",
					authorId: author.id,
					categoryId: cat2.id,
				}).runPromise;

				const postsBefore = await db.posts.query().runPromise;
				const initialPostCount = postsBefore.length;

				// Delete all categories with cascade (predicate matches all)
				const deleteResult = await db.categories.deleteManyWithRelationships(
					() => true,
					{
						include: {
							posts: "cascade",
						},
					},
				).runPromise;

				expect(deleteResult.count).toBe(2);
				const postsAfter = await db.posts.query().runPromise;
				expect(postsAfter.length).toBe(initialPostCount - 2);
			});
		});
	});

	describe("Complex Relationship Scenarios", () => {
		it("should handle deep nested creation", async () => {
			// Create a company with address and employees
			const company = await db.companies.createWithRelationships({
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
			} as Parameters<typeof db.companies.createWithRelationships>[0])
				.runPromise;

			// Verify all entities were created via populate
			const companies = await db.companies.query({
				where: { id: company.id },
				populate: {
					address: true,
					employees: true,
				},
			}).runPromise;

			expect(companies).toHaveLength(1);
			const result = companies[0] as Record<string, unknown>;

			const address = result.address as Record<string, unknown> | undefined;
			expect(address?.street).toBe("789 Tech Ave");

			const employees = result.employees as
				| Array<Record<string, unknown>>
				| undefined;
			expect(employees).toHaveLength(2);
			expect(employees?.map((e) => e.name).sort()).toEqual([
				"Alice CEO",
				"Bob CTO",
			]);
		});

		it("should handle complex update with multiple operations", async () => {
			// Setup initial data
			const company = await db.companies.create({
				name: "Old Corp",
				industry: "Finance",
				addressId: null,
			}).runPromise;

			const user1 = await db.users.create({
				name: "User 1",
				email: "user1@example.com",
				companyId: company.id,
			}).runPromise;
			const _user2 = await db.users.create({
				name: "User 2",
				email: "user2@example.com",
				companyId: company.id,
			}).runPromise;
			const user3 = await db.users.create({
				name: "User 3",
				email: "user3@example.com",
				companyId: null,
			}).runPromise;

			// Complex update: disconnect user1, connect user3
			await db.companies.updateWithRelationships(company.id, {
				name: "New Corp",
				employees: {
					$disconnect: [{ id: user1.id }],
					$connect: [{ id: user3.id }],
				},
			} as Parameters<typeof db.companies.updateWithRelationships>[1])
				.runPromise;

			// Verify changes
			const employees = await db.users.query({
				where: { companyId: company.id },
			}).runPromise;

			expect(employees).toHaveLength(2);
			expect(
				employees.map((e) => (e as Record<string, unknown>).name).sort(),
			).toEqual(["User 2", "User 3"]);
		});
	});
});
