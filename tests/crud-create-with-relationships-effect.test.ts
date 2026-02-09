import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { createWithRelationships } from "../core/operations/crud/create-with-relationships.js"
import {
	ForeignKeyError,
	ValidationError,
} from "../core/errors/crud-errors.js"

// ============================================================================
// Test Schemas
// ============================================================================

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Company = typeof CompanySchema.Type

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	authorId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Post = typeof PostSchema.Type

// ============================================================================
// Helpers
// ============================================================================

type HasId = { readonly id: string }

const makeRef = <T extends HasId>(
	items: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> =>
	Ref.make(
		new Map(items.map((item) => [item.id, item])) as ReadonlyMap<string, T>,
	)

const makeStateRefs = (
	collections: Record<string, ReadonlyArray<HasId>>,
): Effect.Effect<Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>> =>
	Effect.gen(function* () {
		const refs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {}
		for (const [name, items] of Object.entries(collections)) {
			refs[name] = yield* makeRef(items)
		}
		return refs
	})

// ============================================================================
// Test Data & Config
// ============================================================================

const companies: ReadonlyArray<Company> = [
	{ id: "comp1", name: "TechCorp" },
	{ id: "comp2", name: "DataInc" },
]

const userRelationships = {
	company: { type: "ref" as const, target: "companies" },
	posts: { type: "inverse" as const, target: "posts" },
}

const dbConfig = {
	companies: {
		schema: CompanySchema as unknown as Schema.Schema<HasId, unknown>,
		relationships: {},
	},
	users: {
		schema: UserSchema as unknown as Schema.Schema<HasId, unknown>,
		relationships: userRelationships,
	},
	posts: {
		schema: PostSchema as unknown as Schema.Schema<HasId, unknown>,
		relationships: {
			author: { type: "ref" as const, target: "users" },
		},
	},
}

// ============================================================================
// Tests
// ============================================================================

describe("Effect-based createWithRelationships", () => {
	describe("$connect (ref relationship)", () => {
		it("should create entity with $connect to existing entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "John Doe",
						email: "john@example.com",
						companyId: "comp1",
						company: { $connect: { id: "comp1" } },
					})

					return { user, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.user.name).toBe("John Doe")
			expect(result.user.companyId).toBe("comp1")
			expect(result.user.id).toBeDefined()
			expect(result.user.createdAt).toBeDefined()
			expect(result.map.size).toBe(1)
		})

		it("should create entity with shorthand connect syntax", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Jane Smith",
						email: "jane@example.com",
						companyId: "comp2",
						company: { id: "comp2" },
					})

					return user
				}),
			)

			expect(result.name).toBe("Jane Smith")
			expect(result.companyId).toBe("comp2")
		})

		it("should fail with ForeignKeyError when connecting to non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doCreate({
						name: "Nobody",
						email: "nobody@example.com",
						companyId: "comp1",
						company: { $connect: { id: "nonexistent" } },
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ForeignKeyError")
		})

		it("should resolve connect by unique fields (not just id)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "By Name Connect",
						email: "byname@example.com",
						companyId: "comp1",
						company: { $connect: { name: "TechCorp" } },
					})

					return user
				}),
			)

			expect(result.companyId).toBe("comp1")
		})
	})

	describe("$create (ref relationship)", () => {
		it("should create parent with nested entity creation for ref relationship", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies: [],
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					// companyId is omitted because $create on the company ref will set it
					const user = yield* doCreate({
						name: "New User",
						email: "new@example.com",
						company: { $create: { name: "NewCorp" } },
					} as unknown as Parameters<typeof doCreate>[0])

					const companiesMap = yield* Ref.get(stateRefs.companies!)
					return { user, companiesMap }
				}),
			)

			// Parent created
			expect(result.user.name).toBe("New User")
			expect(result.user.companyId).toBeDefined()
			expect(result.user.companyId.length).toBeGreaterThan(0)

			// Nested company was created
			expect(result.companiesMap.size).toBe(1)
			const company = Array.from(result.companiesMap.values())[0]!
			expect(company).toBeDefined()
			expect((company as Company).name).toBe("NewCorp")

			// Foreign key points to the created company
			expect(result.user.companyId).toBe(company.id)
		})

		it("should fail with ValidationError when nested entity is invalid", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies: [],
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doCreate({
						name: "User",
						email: "user@example.com",
						company: { $create: { name: 123 as unknown as string } },
					} as unknown as Parameters<typeof doCreate>[0]).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})
	})

	describe("$create (inverse relationship)", () => {
		it("should create parent with nested entities for inverse relationship", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Author",
						email: "author@example.com",
						companyId: "comp1",
						posts: {
							$create: [
								{ title: "Post 1" },
								{ title: "Post 2" },
							],
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { user, postsMap }
				}),
			)

			// Parent created
			expect(result.user.name).toBe("Author")

			// Posts were created with inverse FK pointing back to user
			expect(result.postsMap.size).toBe(2)
			const posts = Array.from(result.postsMap.values()) as Post[]
			expect(posts[0]!.authorId).toBe(result.user.id)
			expect(posts[1]!.authorId).toBe(result.user.id)
			expect(new Set(posts.map(p => p.title))).toEqual(new Set(["Post 1", "Post 2"]))
		})

		it("should support $createMany for inverse relationships", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Author2",
						email: "author2@example.com",
						companyId: "comp1",
						posts: {
							$createMany: [
								{ title: "Batch 1" },
								{ title: "Batch 2" },
								{ title: "Batch 3" },
							],
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { user, postsMap }
				}),
			)

			expect(result.postsMap.size).toBe(3)
			const posts = Array.from(result.postsMap.values()) as Post[]
			for (const post of posts) {
				expect(post.authorId).toBe(result.user.id)
			}
		})
	})

	describe("$connectOrCreate", () => {
		it("should connect to existing entity when found", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					// companyId is omitted because $connectOrCreate will resolve/create the FK
					const user = yield* doCreate({
						name: "ConnectOrCreate User",
						email: "coc@example.com",
						company: {
							$connectOrCreate: {
								where: { name: "TechCorp" },
								create: { name: "TechCorp" },
							},
						},
					} as unknown as Parameters<typeof doCreate>[0])

					const companiesMap = yield* Ref.get(stateRefs.companies!)
					return { user, companiesMap }
				}),
			)

			// Should connect to existing TechCorp
			expect(result.user.companyId).toBe("comp1")
			// No new company created
			expect(result.companiesMap.size).toBe(2)
		})

		it("should create new entity when not found", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "ConnectOrCreate User 2",
						email: "coc2@example.com",
						company: {
							$connectOrCreate: {
								where: { name: "BrandNewCorp" },
								create: { name: "BrandNewCorp" },
							},
						},
					} as unknown as Parameters<typeof doCreate>[0])

					const companiesMap = yield* Ref.get(stateRefs.companies!)
					return { user, companiesMap }
				}),
			)

			// New company was created
			expect(result.companiesMap.size).toBe(3)
			// User's companyId points to the new company
			const newCompany = Array.from(result.companiesMap.values()).find(
				(c) => (c as Company).name === "BrandNewCorp",
			) as Company
			expect(newCompany).toBeDefined()
			expect(result.user.companyId).toBe(newCompany.id)
		})
	})

	describe("$connect (inverse relationship)", () => {
		it("should update target entity FK when connecting inverse relationship", async () => {
			const existingPosts: ReadonlyArray<Post> = [
				{ id: "post1", title: "Existing Post", authorId: "" },
			]

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: existingPosts,
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Author Connect",
						email: "ac@example.com",
						companyId: "comp1",
						posts: {
							$connect: { id: "post1" },
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { user, postsMap }
				}),
			)

			// Verify the post's FK was updated
			const post = result.postsMap.get("post1") as Post
			expect(post.authorId).toBe(result.user.id)
		})

		it("should handle connecting multiple inverse entities", async () => {
			const existingPosts: ReadonlyArray<Post> = [
				{ id: "post1", title: "Post 1", authorId: "" },
				{ id: "post2", title: "Post 2", authorId: "" },
			]

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: existingPosts,
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Multi Connect",
						email: "mc@example.com",
						companyId: "comp1",
						posts: {
							$connect: [{ id: "post1" }, { id: "post2" }],
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { user, postsMap }
				}),
			)

			const post1 = result.postsMap.get("post1") as Post
			const post2 = result.postsMap.get("post2") as Post
			expect(post1.authorId).toBe(result.user.id)
			expect(post2.authorId).toBe(result.user.id)
		})
	})

	describe("validation and error handling", () => {
		it("should fail with ValidationError for invalid parent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doCreate({
						name: 123 as unknown as string,
						email: "bad@example.com",
						companyId: "comp1",
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should fail with ValidationError for duplicate parent ID", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([
						{ id: "existing", name: "Existing", email: "e@e.com", companyId: "comp1" },
					])
					const stateRefs = yield* makeStateRefs({
						users: [{ id: "existing" }],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doCreate({
						id: "existing",
						name: "Dup",
						email: "dup@example.com",
						companyId: "comp1",
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
			if (result._tag === "ValidationError") {
				expect(result.message).toContain("already exists")
			}
		})

		it("should not mutate parent state on validation failure", async () => {
			const mapSize = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doCreate({
						name: 123 as unknown as string,
						email: "bad@example.com",
						companyId: "comp1",
					}).pipe(Effect.ignore)

					return (yield* Ref.get(usersRef)).size
				}),
			)

			expect(mapSize).toBe(0)
		})

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doCreate({
						name: "Nobody",
						email: "nobody@example.com",
						companyId: "comp1",
						company: { $connect: { id: "nonexistent" } },
					}).pipe(
						Effect.catchTag("ForeignKeyError", (e) =>
							Effect.succeed(`caught fk: ${e.targetCollection}`),
						),
						Effect.catchTag("ValidationError", () =>
							Effect.succeed("caught: validation"),
						),
						Effect.catchTag("OperationError", () =>
							Effect.succeed("caught: operation"),
						),
					)
				}),
			)

			expect(result).toBe("caught fk: companies")
		})
	})

	describe("entity without relationship operations", () => {
		it("should create entity with no relationship ops (plain create)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([])
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
						posts: [],
					})

					const doCreate = createWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const user = yield* doCreate({
						name: "Plain User",
						email: "plain@example.com",
						companyId: "comp1",
					})

					return { user, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.user.name).toBe("Plain User")
			expect(result.user.companyId).toBe("comp1")
			expect(result.map.size).toBe(1)
		})
	})
})
