import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { updateWithRelationships } from "../core/operations/crud/update-with-relationships.js"
import {
	NotFoundError,
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
	companyId: Schema.NullOr(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	authorId: Schema.NullOr(Schema.String),
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

const users: ReadonlyArray<User> = [
	{ id: "user1", name: "John Doe", email: "john@example.com", companyId: "comp1" },
]

const posts: ReadonlyArray<Post> = [
	{ id: "post1", title: "Post One", authorId: "user1" },
	{ id: "post2", title: "Post Two", authorId: "user1" },
	{ id: "post3", title: "Post Three", authorId: null },
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

describe("Effect-based updateWithRelationships", () => {
	describe("base entity update (no relationship ops)", () => {
		it("should update entity fields without relationship operations", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						name: "John Updated",
						email: "john.updated@example.com",
					})

					return { updated, map: yield* Ref.get(usersRef) }
				}),
			)

			expect(result.updated.name).toBe("John Updated")
			expect(result.updated.email).toBe("john.updated@example.com")
			expect(result.updated.companyId).toBe("comp1")
			expect(result.updated.updatedAt).toBeDefined()
			expect(result.map.get("user1")!.name).toBe("John Updated")
		})

		it("should fail with NotFoundError for non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doUpdate("nonexistent", {
						name: "Nobody",
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("NotFoundError")
		})
	})

	describe("$connect (ref relationship)", () => {
		it("should update entity with $connect to different company", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						company: { $connect: { id: "comp2" } },
					})

					return updated
				}),
			)

			expect(result.companyId).toBe("comp2")
		})

		it("should support shorthand connect syntax", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						company: { id: "comp2" },
					})

					return updated
				}),
			)

			expect(result.companyId).toBe("comp2")
		})

		it("should resolve connect by unique fields", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						company: { $connect: { name: "DataInc" } },
					})

					return updated
				}),
			)

			expect(result.companyId).toBe("comp2")
		})

		it("should fail with ForeignKeyError when connecting to non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doUpdate("user1", {
						company: { $connect: { id: "nonexistent" } },
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ForeignKeyError")
		})
	})

	describe("$disconnect (ref relationship)", () => {
		it("should disconnect ref relationship (set FK to null)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						company: { $disconnect: true },
					})

					return updated
				}),
			)

			expect(result.companyId).toBeNull()
		})
	})

	describe("$connect (inverse relationship)", () => {
		it("should connect an inverse entity by updating its FK", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						posts: {
							$connect: { id: "post3" },
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { updated, postsMap }
				}),
			)

			// post3 should now point to user1
			const post3 = result.postsMap.get("post3") as Post
			expect(post3.authorId).toBe("user1")
		})

		it("should connect multiple inverse entities", async () => {
			const extraPosts: ReadonlyArray<Post> = [
				...posts,
				{ id: "post4", title: "Post Four", authorId: null },
			]

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: extraPosts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doUpdate("user1", {
						posts: {
							$connect: [{ id: "post3" }, { id: "post4" }],
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return postsMap
				}),
			)

			expect((result.get("post3") as Post).authorId).toBe("user1")
			expect((result.get("post4") as Post).authorId).toBe("user1")
		})
	})

	describe("$disconnect (inverse relationship)", () => {
		it("should disconnect all inverse entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doUpdate("user1", {
						posts: {
							$disconnect: true,
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return postsMap
				}),
			)

			// post1 and post2 were connected to user1, should now be null
			expect((result.get("post1") as Post).authorId).toBeNull()
			expect((result.get("post2") as Post).authorId).toBeNull()
			// post3 was already null
			expect((result.get("post3") as Post).authorId).toBeNull()
		})
	})

	describe("$update (ref relationship — nested update)", () => {
		it("should update a related entity through ref relationship", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doUpdate("user1", {
						company: { $update: { name: "TechCorp Updated" } },
					})

					const companiesMap = yield* Ref.get(stateRefs.companies!)
					return companiesMap
				}),
			)

			const company = result.get("comp1") as Company
			expect(company.name).toBe("TechCorp Updated")
		})

		it("should fail with ValidationError when nested update produces invalid entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doUpdate("user1", {
						company: { $update: { name: 123 as unknown as string } },
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})
	})

	describe("$set (inverse relationship — replace all)", () => {
		it("should replace all inverse relationships", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					// Replace user1's posts: remove post1 and post2, add post3
					yield* doUpdate("user1", {
						posts: {
							$set: [{ id: "post3" }],
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return postsMap
				}),
			)

			// post1 and post2 were previously connected, should now be disconnected
			expect((result.get("post1") as Post).authorId).toBeNull()
			expect((result.get("post2") as Post).authorId).toBeNull()
			// post3 should now be connected
			expect((result.get("post3") as Post).authorId).toBe("user1")
		})
	})

	describe("$delete (inverse relationship — disconnect specific)", () => {
		it("should disconnect specific inverse entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doUpdate("user1", {
						posts: {
							$delete: { id: "post1" },
						},
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return postsMap
				}),
			)

			// post1 should be disconnected
			expect((result.get("post1") as Post).authorId).toBeNull()
			// post2 should still be connected
			expect((result.get("post2") as Post).authorId).toBe("user1")
		})
	})

	describe("combined operations", () => {
		it("should update base fields and relationship operations together", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const updated = yield* doUpdate("user1", {
						name: "John Updated",
						company: { $connect: { id: "comp2" } },
						posts: { $connect: { id: "post3" } },
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { updated, postsMap }
				}),
			)

			expect(result.updated.name).toBe("John Updated")
			expect(result.updated.companyId).toBe("comp2")
			expect((result.postsMap.get("post3") as Post).authorId).toBe("user1")
		})
	})

	describe("error handling", () => {
		it("should not mutate state on validation failure", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doUpdate("user1", {
						name: 123 as unknown as string,
					}).pipe(Effect.ignore)

					const usersMap = yield* Ref.get(usersRef)
					return usersMap.get("user1")!
				}),
			)

			// Original name should be preserved
			expect(result.name).toBe("John Doe")
		})

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					})

					const doUpdate = updateWithRelationships(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doUpdate("nonexistent", {
						name: "Nobody",
					}).pipe(
						Effect.catchTag("NotFoundError", (e) =>
							Effect.succeed(`caught: ${e.collection}/${e.id}`),
						),
						Effect.catchTag("ForeignKeyError", () =>
							Effect.succeed("caught: fk"),
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

			expect(result).toBe("caught: users/nonexistent")
		})
	})
})
