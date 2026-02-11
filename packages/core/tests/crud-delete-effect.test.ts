import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { del, deleteMany } from "../src/operations/crud/delete.js";

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string };

type RelationshipConfig = {
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey?: string;
};

type User = {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly age: number;
	readonly companyId: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly deletedAt?: string;
};

type Company = {
	readonly id: string;
	readonly name: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
};

type Post = {
	readonly id: string;
	readonly title: string;
	readonly authorId: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly deletedAt?: string;
};

type Category = {
	readonly id: string;
	readonly name: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
};

// ============================================================================
// Helpers
// ============================================================================

const makeRef = <T extends HasId>(
	items: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> =>
	Ref.make(
		new Map(items.map((item) => [item.id, item])) as ReadonlyMap<string, T>,
	);

const makeStateRefs = (
	collections: Record<string, ReadonlyArray<HasId>>,
): Effect.Effect<Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>> =>
	Effect.gen(function* () {
		const refs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {};
		for (const [name, items] of Object.entries(collections)) {
			refs[name] = yield* makeRef(items);
		}
		return refs;
	});

// ============================================================================
// Test Data
// ============================================================================

const companies: ReadonlyArray<Company> = [
	{ id: "comp1", name: "TechCorp" },
	{ id: "comp2", name: "DataInc" },
];

const users: ReadonlyArray<User> = [
	{
		id: "user1",
		name: "John Doe",
		email: "john@example.com",
		age: 30,
		companyId: "comp1",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		deletedAt: undefined, // present for hasSoftDelete detection
	},
	{
		id: "user2",
		name: "Jane Smith",
		email: "jane@example.com",
		age: 25,
		companyId: "comp2",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		deletedAt: undefined,
	},
	{
		id: "user3",
		name: "Bob Johnson",
		email: "bob@example.com",
		age: 35,
		companyId: "comp1",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		deletedAt: "2024-06-01T00:00:00.000Z", // already soft deleted
	},
];

const posts: ReadonlyArray<Post> = [
	{ id: "post1", title: "First Post", authorId: "user1", deletedAt: undefined },
	{
		id: "post2",
		title: "Second Post",
		authorId: "user2",
		deletedAt: undefined,
	},
];

const categories: ReadonlyArray<Category> = [
	{ id: "cat1", name: "Technology" },
	{ id: "cat2", name: "Science" },
];

// Relationship configs for all collections
const allRelationships: Record<string, Record<string, RelationshipConfig>> = {
	users: {
		company: { type: "ref", target: "companies" },
	},
	companies: {
		users: { type: "inverse", target: "users", foreignKey: "companyId" },
	},
	posts: {
		author: { type: "ref", target: "users", foreignKey: "authorId" },
	},
	categories: {},
};

// ============================================================================
// Tests
// ============================================================================

describe("Effect-based CRUD Delete Operations", () => {
	describe("del (single entity)", () => {
		it("should hard delete an entity and return it", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({
						categories,
					});

					const doDelete = del(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					);

					const deleted = yield* doDelete("cat1");
					return { deleted, map: yield* Ref.get(catsRef) };
				}),
			);

			expect(result.deleted.id).toBe("cat1");
			expect(result.deleted.name).toBe("Technology");
			// Verify removed from state
			expect(result.map.size).toBe(1);
			expect(result.map.has("cat1")).toBe(false);
			expect(result.map.has("cat2")).toBe(true);
		});

		it("should fail with NotFoundError for non-existent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					return yield* del(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)("nonexistent").pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("NotFoundError");
			if (result._tag === "NotFoundError") {
				expect(result.id).toBe("nonexistent");
				expect(result.collection).toBe("categories");
			}
		});

		it("should fail with ForeignKeyError when entity is referenced", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					return yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)("user1").pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ForeignKeyError");
			if (result._tag === "ForeignKeyError") {
				expect(result.collection).toBe("users");
				expect(result.message).toContain("Cannot delete");
				expect(result.message).toContain("posts");
			}
		});

		it("should delete entity when no references exist", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					// user3 has no posts referencing it
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					const deleted = yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)("user3");

					return { deleted, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.deleted.id).toBe("user3");
			expect(result.map.size).toBe(2);
			expect(result.map.has("user3")).toBe(false);
		});

		it("should soft delete entity with deletedAt field", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					// Remove posts referencing user1 to avoid FK constraint
					const usersRef = yield* makeRef<User>(users);
					const _postsRef = yield* makeRef<Post>([]);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					});

					const deleted = yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)("user1", { soft: true });

					return { deleted, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.deleted.id).toBe("user1");
			expect(result.deleted.deletedAt).toBeDefined();
			expect(result.deleted.updatedAt).toBeDefined();
			expect(result.deleted.updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
			// Verify entity still exists in state (but marked as deleted)
			expect(result.map.size).toBe(3);
			expect(result.map.has("user1")).toBe(true);
			expect(result.map.get("user1")?.deletedAt).toBeDefined();
		});

		it("should preserve original deletedAt on already soft-deleted entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					// user3 is already soft deleted with deletedAt = "2024-06-01..."
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					});

					return yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)("user3", { soft: true });
				}),
			);

			expect(result.id).toBe("user3");
			expect(result.deletedAt).toBe("2024-06-01T00:00:00.000Z");
		});

		it("should fail with OperationError for soft delete on entity without deletedAt", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					return yield* del(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)("cat1", { soft: true }).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("OperationError");
			if (result._tag === "OperationError") {
				expect(result.operation).toBe("soft delete");
				expect(result.message).toContain("deletedAt");
			}
		});

		it("should not mutate state on NotFoundError", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					yield* del(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)("nonexistent").pipe(Effect.ignore);

					return yield* Ref.get(catsRef);
				}),
			);

			expect(mapAfter.size).toBe(2);
		});

		it("should not mutate state on ForeignKeyError", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)("user1").pipe(Effect.ignore);

					return yield* Ref.get(usersRef);
				}),
			);

			expect(mapAfter.size).toBe(3);
			expect(mapAfter.has("user1")).toBe(true);
		});

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					return yield* del(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)("nonexistent").pipe(
						Effect.catchTag("NotFoundError", (e) =>
							Effect.succeed(`caught: ${e.id}`),
						),
						Effect.catchTag("OperationError", () =>
							Effect.succeed("caught: operation"),
						),
						Effect.catchTag("ForeignKeyError", () =>
							Effect.succeed("caught: fk"),
						),
					);
				}),
			);

			expect(result).toBe("caught: nonexistent");
		});

		it("should discriminate ForeignKeyError with catchTag", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					return yield* del(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)("user1").pipe(
						Effect.catchTag("NotFoundError", () =>
							Effect.succeed("caught: not found"),
						),
						Effect.catchTag("OperationError", () =>
							Effect.succeed("caught: operation"),
						),
						Effect.catchTag("ForeignKeyError", (e) =>
							Effect.succeed(`caught: fk ${e.targetCollection}`),
						),
					);
				}),
			);

			expect(result).toBe("caught: fk posts");
		});
	});

	// ============================================================================
	// deleteMany (batch)
	// ============================================================================

	describe("deleteMany (batch)", () => {
		it("should hard delete all matching entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					const doDeleteMany = deleteMany(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					);

					const batch = yield* doDeleteMany(() => true);
					return { batch, map: yield* Ref.get(catsRef) };
				}),
			);

			expect(result.batch.count).toBe(2);
			expect(result.batch.deleted).toHaveLength(2);
			expect(result.map.size).toBe(0);
		});

		it("should delete only matching entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					const batch = yield* deleteMany(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)((cat) => cat.name === "Technology");

					return { batch, map: yield* Ref.get(catsRef) };
				}),
			);

			expect(result.batch.count).toBe(1);
			expect(result.batch.deleted[0]?.id).toBe("cat1");
			expect(result.map.size).toBe(1);
			expect(result.map.has("cat2")).toBe(true);
		});

		it("should return empty result when no entities match", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					return yield* deleteMany(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)(() => false);
				}),
			);

			expect(result.count).toBe(0);
			expect(result.deleted).toHaveLength(0);
		});

		it("should respect limit option", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					const batch = yield* deleteMany(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)(() => true, { limit: 1 });

					return { batch, map: yield* Ref.get(catsRef) };
				}),
			);

			expect(result.batch.count).toBe(1);
			expect(result.batch.deleted).toHaveLength(1);
			expect(result.map.size).toBe(1);
		});

		it("should soft delete multiple entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					});

					const batch = yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)((u) => u.companyId === "comp1", { soft: true });

					return { batch, map: yield* Ref.get(usersRef) };
				}),
			);

			// user1 and user3 are in comp1
			expect(result.batch.count).toBe(2);
			expect(result.batch.deleted).toHaveLength(2);
			// All deleted entities should have deletedAt
			for (const entity of result.batch.deleted) {
				expect((entity as User).deletedAt).toBeDefined();
			}
			// Entities still exist in state (soft deleted)
			expect(result.map.size).toBe(3);
			expect(result.map.get("user1")?.deletedAt).toBeDefined();
		});

		it("should preserve original deletedAt for already soft-deleted entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					});

					const batch = yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)((u) => u.companyId === "comp1", { soft: true });

					return batch;
				}),
			);

			// user3 was already soft deleted
			const user3 = result.deleted.find(
				(u) => (u as User).id === "user3",
			) as User;
			expect(user3.deletedAt).toBe("2024-06-01T00:00:00.000Z");

			// user1 gets a new deletedAt
			const user1 = result.deleted.find(
				(u) => (u as User).id === "user1",
			) as User;
			expect(user1.deletedAt).toBeDefined();
			expect(user1.deletedAt).not.toBe("2024-06-01T00:00:00.000Z");
		});

		it("should fail with OperationError for soft delete on entities without deletedAt", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const catsRef = yield* makeRef<Category>(categories);
					const stateRefs = yield* makeStateRefs({ categories });

					return yield* deleteMany(
						"categories",
						{ categories: {} },
						catsRef,
						stateRefs,
					)(() => true, { soft: true }).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("OperationError");
			if (result._tag === "OperationError") {
				expect(result.operation).toBe("soft delete");
				expect(result.message).toContain("deletedAt");
			}
		});

		it("should fail with ForeignKeyError when deleting referenced entities", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					// Try to delete users that have posts referencing them
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					return yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)((u) => u.id === "user1").pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ForeignKeyError");
			if (result._tag === "ForeignKeyError") {
				expect(result.message).toContain("Cannot delete");
				expect(result.message).toContain("posts");
			}
		});

		it("should not mutate state on ForeignKeyError", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
					)((u) => u.id === "user1").pipe(Effect.ignore);

					return yield* Ref.get(usersRef);
				}),
			);

			expect(mapAfter.size).toBe(3);
			expect(mapAfter.has("user1")).toBe(true);
		});

		it("should handle limit with soft delete", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts: [],
					});

					const batch = yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)(() => true, { soft: true, limit: 1 });

					return { batch, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.batch.count).toBe(1);
			expect(result.batch.deleted).toHaveLength(1);
			// All entities still in state
			expect(result.map.size).toBe(3);
		});

		it("should skip FK check for soft delete (entities remain in state)", async () => {
			// Soft delete doesn't remove entities, so FK references remain valid
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(users);
					const stateRefs = yield* makeStateRefs({
						users,
						companies,
						posts,
					});

					// This should succeed because soft delete doesn't violate FK constraints
					return yield* deleteMany(
						"users",
						allRelationships,
						usersRef,
						stateRefs,
						true,
					)((u) => u.id === "user1", { soft: true });
				}),
			);

			expect(result.count).toBe(1);
			expect(result.deleted[0]?.id).toBe("user1");
		});
	});
});
