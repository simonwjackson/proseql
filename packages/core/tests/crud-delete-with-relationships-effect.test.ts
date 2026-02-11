import { describe, it, expect } from "vitest"
import { Effect, Ref, Schema } from "effect"
import {
	deleteWithRelationships,
	deleteManyWithRelationships,
} from "../src/operations/crud/delete-with-relationships.js"
import {
	NotFoundError,
	ValidationError,
} from "../src/errors/crud-errors.js"

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
	deletedAt: Schema.optional(Schema.NullOr(Schema.String)),
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
	{ id: "user1", name: "Alice", email: "alice@example.com", companyId: "comp1" },
	{ id: "user2", name: "Bob", email: "bob@example.com", companyId: "comp1" },
	{ id: "user3", name: "Charlie", email: "charlie@example.com", companyId: "comp2" },
]

const posts: ReadonlyArray<Post> = [
	{ id: "post1", title: "Post One", authorId: "user1" },
	{ id: "post2", title: "Post Two", authorId: "user1" },
	{ id: "post3", title: "Post Three", authorId: "user2" },
	{ id: "post4", title: "Post Four", authorId: null },
]

const userRelationships = {
	company: { type: "ref" as const, target: "companies" },
	posts: { type: "inverse" as const, target: "posts" },
}

const dbConfig = {
	companies: {
		schema: CompanySchema,
		relationships: {},
	},
	users: {
		schema: UserSchema,
		relationships: userRelationships,
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" },
		},
	},
}

// ============================================================================
// Tests: deleteWithRelationships (single)
// ============================================================================

describe("Effect-based deleteWithRelationships", () => {
	describe("basic delete", () => {
		it("should delete entity by ID with no related entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [{ id: "post4", title: "Post Four", authorId: null }],
					})

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDelete("user3")
					const map = yield* Ref.get(usersRef)
					return { deleted, mapSize: map.size }
				}),
			)

			expect(result.deleted.deleted.id).toBe("user3")
			expect(result.deleted.deleted.name).toBe("Charlie")
			expect(result.mapSize).toBe(2) // user1 and user2 remain
		})

		it("should fail with NotFoundError for non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDelete("nonexistent").pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("NotFoundError")
			expect((result as NotFoundError).id).toBe("nonexistent")
		})
	})

	describe("cascade option", () => {
		it("should cascade delete related entities (hard)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDelete("user1", {
						include: { posts: "cascade" },
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { deleted, postsMapSize: postsMap.size }
				}),
			)

			expect(result.deleted.deleted.id).toBe("user1")
			expect(result.deleted.cascaded).toBeDefined()
			expect(result.deleted.cascaded!.posts.count).toBe(2) // post1, post2
			expect(result.deleted.cascaded!.posts.ids).toContain("post1")
			expect(result.deleted.cascaded!.posts.ids).toContain("post2")
			// post3 (user2) and post4 (null) remain
			expect(result.postsMapSize).toBe(2)
		})
	})

	describe("cascade_soft option", () => {
		it("should soft delete cascaded related entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDelete("user1", {
						include: { posts: "cascade_soft" },
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { deleted, postsMap }
				}),
			)

			expect(result.deleted.cascaded).toBeDefined()
			expect(result.deleted.cascaded!.posts.count).toBe(2)
			// Posts should still exist but with deletedAt set
			expect(result.postsMap.size).toBe(4)
			const post1 = result.postsMap.get("post1") as Record<string, unknown>
			expect(post1.deletedAt).toBeDefined()
		})
	})

	describe("restrict option", () => {
		it("should fail with ValidationError when restrict violations exist", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDelete("user1", {
						include: { posts: "restrict" },
					}).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
			const err = result as ValidationError
			expect(err.issues.length).toBeGreaterThan(0)
			expect(err.issues[0].message).toContain("Cannot delete")
		})

		it("should not mutate state on restrict failure", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doDelete("user1", {
						include: { posts: "restrict" },
					}).pipe(Effect.ignore)

					const usersMap = yield* Ref.get(usersRef)
					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { usersMapSize: usersMap.size, postsMapSize: postsMap.size }
				}),
			)

			expect(result.usersMapSize).toBe(3) // All users still present
			expect(result.postsMapSize).toBe(4) // All posts still present
		})
	})

	describe("set_null option", () => {
		it("should set foreign keys to null on related entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDelete("user1", {
						include: { posts: "set_null" },
					})

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { deleted, postsMap }
				}),
			)

			expect(result.deleted.deleted.id).toBe("user1")
			// Posts should still exist but with authorId set to null
			expect(result.postsMap.size).toBe(4)
			const post1 = result.postsMap.get("post1") as Post
			expect(post1.authorId).toBeNull()
			const post2 = result.postsMap.get("post2") as Post
			expect(post2.authorId).toBeNull()
			// post3 should be unaffected (belongs to user2)
			const post3 = result.postsMap.get("post3") as Post
			expect(post3.authorId).toBe("user2")
		})
	})

	describe("preserve option (default)", () => {
		it("should leave related entities untouched", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					// No options = default preserve
					const deleted = yield* doDelete("user1")

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { deleted, postsMap }
				}),
			)

			expect(result.deleted.deleted.id).toBe("user1")
			expect(result.deleted.cascaded).toBeUndefined()
			// Posts still reference user1 (dangling)
			const post1 = result.postsMap.get("post1") as Post
			expect(post1.authorId).toBe("user1")
		})
	})

	describe("soft delete", () => {
		it("should soft delete the entity itself", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDelete("user1", { soft: true })

					const usersMap = yield* Ref.get(usersRef)
					return { deleted, usersMap }
				}),
			)

			expect(result.deleted.deleted.id).toBe("user1")
			// Entity still in map but with deletedAt
			expect(result.usersMap.size).toBe(3)
			const user = result.usersMap.get("user1") as Record<string, unknown>
			expect(user.deletedAt).toBeDefined()
		})
	})

	describe("error handling with Effect.catchTag", () => {
		it("should support Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDelete = deleteWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDelete("nonexistent").pipe(
						Effect.catchTag("NotFoundError", (e) =>
							Effect.succeed(`caught: ${e.collection}/${e.id}`),
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

// ============================================================================
// Tests: deleteManyWithRelationships
// ============================================================================

describe("Effect-based deleteManyWithRelationships", () => {
	describe("basic delete many", () => {
		it("should delete multiple entities matching predicate", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [{ id: "post4", title: "Post Four", authorId: null }],
					})

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDeleteMany(
						(u) => u.companyId === "comp1",
					)

					const usersMap = yield* Ref.get(usersRef)
					return { deleted, usersMapSize: usersMap.size }
				}),
			)

			expect(result.deleted.count).toBe(2) // user1, user2
			expect(result.deleted.deleted.length).toBe(2)
			expect(result.usersMapSize).toBe(1) // only user3
		})

		it("should return empty result when no entities match", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDeleteMany((u) => u.companyId === "nonexistent")
				}),
			)

			expect(result.count).toBe(0)
			expect(result.deleted.length).toBe(0)
		})

		it("should apply limit", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					})

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDeleteMany(
						() => true,
						{ limit: 2 },
					)
				}),
			)

			expect(result.count).toBe(2)
		})
	})

	describe("cascade with delete many", () => {
		it("should cascade delete related entities for all matched", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDeleteMany(
						(u) => u.companyId === "comp1",
						{ include: { posts: "cascade" } },
					)

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return { deleted, postsMapSize: postsMap.size }
				}),
			)

			expect(result.deleted.count).toBe(2) // user1, user2
			expect(result.deleted.cascaded).toBeDefined()
			expect(result.deleted.cascaded!.posts.count).toBe(3) // post1, post2, post3
			// Only post4 (authorId: null) remains
			expect(result.postsMapSize).toBe(1)
		})
	})

	describe("restrict with delete many", () => {
		it("should fail if any entity has restrict violations", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					return yield* doDeleteMany(
						(u) => u.companyId === "comp1",
						{ include: { posts: "restrict" } },
					).pipe(Effect.flip)
				}),
			)

			expect(result._tag).toBe("ValidationError")
		})

		it("should not mutate state on restrict failure", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doDeleteMany(
						(u) => u.companyId === "comp1",
						{ include: { posts: "restrict" } },
					).pipe(Effect.ignore)

					const usersMap = yield* Ref.get(usersRef)
					return usersMap.size
				}),
			)

			expect(result).toBe(3) // All users still present
		})
	})

	describe("set_null with delete many", () => {
		it("should set foreign keys to null for all related entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({ users, companies, posts })

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					yield* doDeleteMany(
						(u) => u.companyId === "comp1",
						{ include: { posts: "set_null" } },
					)

					const postsMap = yield* Ref.get(stateRefs.posts!)
					return postsMap
				}),
			)

			// All posts for user1 and user2 should have null authorId
			expect((result.get("post1") as Post).authorId).toBeNull()
			expect((result.get("post2") as Post).authorId).toBeNull()
			expect((result.get("post3") as Post).authorId).toBeNull()
			// post4 was already null
			expect((result.get("post4") as Post).authorId).toBeNull()
		})
	})

	describe("soft delete many", () => {
		it("should soft delete all matching entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users)
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					})

					const doDeleteMany = deleteManyWithRelationships(
						"users",
						userRelationships,
						usersRef,
						stateRefs,
						dbConfig,
					)

					const deleted = yield* doDeleteMany(
						(u) => u.companyId === "comp1",
						{ soft: true },
					)

					const usersMap = yield* Ref.get(usersRef)
					return { deleted, usersMap }
				}),
			)

			expect(result.deleted.count).toBe(2)
			// Entities still in map
			expect(result.usersMap.size).toBe(3)
			const user1 = result.usersMap.get("user1") as Record<string, unknown>
			expect(user1.deletedAt).toBeDefined()
		})
	})
})
