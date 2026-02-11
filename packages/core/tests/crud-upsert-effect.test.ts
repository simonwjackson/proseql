import { Effect, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { upsert, upsertMany } from "../src/operations/crud/upsert.js";

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type User = typeof UserSchema.Type;

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type Company = typeof CompanySchema.Type;

// ============================================================================
// Helpers
// ============================================================================

type HasId = { readonly id: string };

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

const userRelationships = {
	company: { type: "ref" as const, target: "companies" as const },
};

const existingUser: User = {
	id: "user1",
	name: "John Doe",
	email: "john@example.com",
	age: 30,
	companyId: "comp1",
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
};

const existingUsers: ReadonlyArray<User> = [
	existingUser,
	{
		id: "user2",
		name: "Jane Smith",
		email: "jane@example.com",
		age: 25,
		companyId: "comp2",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	},
];

// ============================================================================
// Tests: upsert (single entity)
// ============================================================================

describe("Effect-based CRUD Upsert Operations", () => {
	describe("upsert (single entity)", () => {
		it("should create a new entity when no match found (by id)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const doUpsert = upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					);

					const entity = yield* doUpsert({
						where: { id: "new-user" },
						create: {
							name: "New User",
							email: "new@example.com",
							age: 28,
							companyId: "comp1",
						},
						update: { name: "Updated Name" },
					});

					return { entity, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.entity.__action).toBe("created");
			expect(result.entity.name).toBe("New User");
			expect(result.entity.id).toBe("new-user");
			expect(result.entity.createdAt).toBeDefined();
			expect(result.entity.updatedAt).toBeDefined();
			expect(result.map.size).toBe(3); // 2 existing + 1 new
			expect(result.map.has("new-user")).toBe(true);
		});

		it("should update existing entity when match found (by id)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const entity = yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "user1" },
						create: {
							name: "Should Not Use",
							email: "x@x.com",
							age: 99,
							companyId: "comp1",
						},
						update: { name: "Updated John" },
					});

					return { entity, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.entity.__action).toBe("updated");
			expect(result.entity.name).toBe("Updated John");
			expect(result.entity.email).toBe("john@example.com"); // unchanged
			expect(result.entity.id).toBe("user1");
			expect(result.entity.updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
			expect(result.map.size).toBe(2); // no new entity
			expect(result.map.get("user1")?.name).toBe("Updated John");
		});

		it("should auto-generate ID on create when where has no id", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "auto-gen-test" },
						create: {
							name: "Auto ID",
							email: "auto@example.com",
							age: 20,
							companyId: "comp1",
						},
						update: {},
					});
				}),
			);

			expect(result.__action).toBe("created");
			expect(result.id).toBe("auto-gen-test");
		});

		it("should apply update operators on update path", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "user1" },
						create: {
							name: "X",
							email: "x@x.com",
							age: 0,
							companyId: "comp1",
						},
						update: { age: { $increment: 5 } } as Record<string, unknown>,
					});
				}),
			);

			expect(result.__action).toBe("updated");
			expect(result.age).toBe(35); // 30 + 5
		});

		it("should fail with ValidationError for invalid create data", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "bad-user" },
						create: {
							name: "Bad",
							email: "bad@x.com",
							age: "not a number" as unknown as number,
							companyId: "comp1",
						},
						update: {},
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ValidationError");
		});

		it("should fail with ValidationError for invalid update result", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "user1" },
						create: {
							name: "X",
							email: "x@x.com",
							age: 0,
							companyId: "comp1",
						},
						update: { age: "not a number" as unknown as number },
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ValidationError");
		});

		it("should fail with ForeignKeyError on create path with invalid FK", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "new-user" },
						create: {
							name: "FK Fail",
							email: "fk@x.com",
							age: 25,
							companyId: "nonexistent",
						},
						update: {},
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ForeignKeyError");
			if (result._tag === "ForeignKeyError") {
				expect(result.field).toBe("companyId");
				expect(result.value).toBe("nonexistent");
			}
		});

		it("should fail with ForeignKeyError on update path with invalid FK", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "user1" },
						create: {
							name: "X",
							email: "x@x.com",
							age: 0,
							companyId: "comp1",
						},
						update: { companyId: "nonexistent" },
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ForeignKeyError");
			if (result._tag === "ForeignKeyError") {
				expect(result.field).toBe("companyId");
				expect(result.value).toBe("nonexistent");
			}
		});

		it("should not mutate state on validation failure", async () => {
			const mapSize = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "user1" },
						create: {
							name: "X",
							email: "x@x.com",
							age: 0,
							companyId: "comp1",
						},
						update: { age: "bad" as unknown as number },
					}).pipe(Effect.ignore);

					const map = yield* Ref.get(usersRef);
					return { size: map.size, age: map.get("user1")?.age };
				}),
			);

			expect(mapSize.size).toBe(2);
			expect(mapSize.age).toBe(30); // unchanged
		});

		it("should not mutate state on FK failure", async () => {
			const mapSize = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "new-user" },
						create: {
							name: "FK Fail",
							email: "fk@x.com",
							age: 25,
							companyId: "nonexistent",
						},
						update: {},
					}).pipe(Effect.ignore);

					const map = yield* Ref.get(usersRef);
					return map.size;
				}),
			);

			expect(mapSize).toBe(0);
		});

		it("should use Effect.catchTag for error discrimination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsert(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)({
						where: { id: "new-user" },
						create: {
							name: "FK Fail",
							email: "fk@x.com",
							age: 25,
							companyId: "nonexistent",
						},
						update: {},
					}).pipe(
						Effect.catchTag("ForeignKeyError", (e) =>
							Effect.succeed(`caught: ${e.field}`),
						),
						Effect.catchTag("ValidationError", () =>
							Effect.succeed("caught: validation"),
						),
					);
				}),
			);

			expect(result).toBe("caught: companyId");
		});
	});

	// ============================================================================
	// Tests: upsertMany (batch)
	// ============================================================================

	describe("upsertMany (batch)", () => {
		it("should create new entities that don't exist", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					const doUpsertMany = upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					);

					const batch = yield* doUpsertMany([
						{
							where: { id: "u1" },
							create: {
								name: "User 1",
								email: "u1@x.com",
								age: 25,
								companyId: "comp1",
							},
							update: {},
						},
						{
							where: { id: "u2" },
							create: {
								name: "User 2",
								email: "u2@x.com",
								age: 30,
								companyId: "comp2",
							},
							update: {},
						},
					]);

					return { batch, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.batch.created).toHaveLength(2);
			expect(result.batch.updated).toHaveLength(0);
			expect(result.batch.unchanged).toHaveLength(0);
			expect(result.map.size).toBe(2);
		});

		it("should update existing entities that match", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const batch = yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { name: "Updated John" },
						},
						{
							where: { id: "user2" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { name: "Updated Jane" },
						},
					]);

					return { batch, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.batch.created).toHaveLength(0);
			expect(result.batch.updated).toHaveLength(2);
			expect(result.batch.unchanged).toHaveLength(0);
			expect(result.map.get("user1")?.name).toBe("Updated John");
			expect(result.map.get("user2")?.name).toBe("Updated Jane");
		});

		it("should mix create and update in one batch", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const batch = yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { name: "Updated John" },
						},
						{
							where: { id: "new-user" },
							create: {
								name: "New User",
								email: "new@x.com",
								age: 28,
								companyId: "comp2",
							},
							update: {},
						},
					]);

					return { batch, map: yield* Ref.get(usersRef) };
				}),
			);

			expect(result.batch.created).toHaveLength(1);
			expect(result.batch.updated).toHaveLength(1);
			expect(result.batch.unchanged).toHaveLength(0);
			expect(result.batch.created[0]?.name).toBe("New User");
			expect(result.batch.updated[0]?.name).toBe("Updated John");
			expect(result.map.size).toBe(3); // 2 existing + 1 new
		});

		it("should report unchanged entities when no fields differ", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const batch = yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { name: "John Doe" }, // same value as existing
						},
					]);

					return batch;
				}),
			);

			expect(result.created).toHaveLength(0);
			expect(result.updated).toHaveLength(0);
			expect(result.unchanged).toHaveLength(1);
			expect(result.unchanged[0]?.id).toBe("user1");
		});

		it("should treat operator-based updates as always changed", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					const batch = yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { age: { $increment: 0 } } as Record<string, unknown>,
						},
					]);

					return batch;
				}),
			);

			expect(result.updated).toHaveLength(1);
			expect(result.unchanged).toHaveLength(0);
		});

		it("should fail with ValidationError for invalid data", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "bad-user" },
							create: {
								name: "Bad",
								email: "bad@x.com",
								age: "not a number" as unknown as number,
								companyId: "comp1",
							},
							update: {},
						},
					]).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ValidationError");
		});

		it("should fail with ForeignKeyError for invalid FK in batch", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "u1" },
							create: {
								name: "Good",
								email: "good@x.com",
								age: 25,
								companyId: "comp1",
							},
							update: {},
						},
						{
							where: { id: "u2" },
							create: {
								name: "Bad FK",
								email: "bad@x.com",
								age: 30,
								companyId: "nonexistent",
							},
							update: {},
						},
					]).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("ForeignKeyError");
		});

		it("should not mutate state on validation failure", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { age: "bad" as unknown as number },
						},
					]).pipe(Effect.ignore);

					return yield* Ref.get(usersRef);
				}),
			);

			expect(mapAfter.get("user1")?.age).toBe(30); // unchanged
		});

		it("should handle empty array", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({
						users: [],
						companies,
					});

					return yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([]);
				}),
			);

			expect(result.created).toHaveLength(0);
			expect(result.updated).toHaveLength(0);
			expect(result.unchanged).toHaveLength(0);
		});

		it("should atomically apply all changes", async () => {
			const mapAfter = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>(existingUsers);
					const stateRefs = yield* makeStateRefs({
						users: existingUsers,
						companies,
					});

					yield* upsertMany(
						"users",
						UserSchema,
						userRelationships,
						usersRef,
						stateRefs,
					)([
						{
							where: { id: "user1" },
							create: {
								name: "X",
								email: "x@x.com",
								age: 0,
								companyId: "comp1",
							},
							update: { name: "Batch Updated" },
						},
						{
							where: { id: "user3" },
							create: {
								name: "User 3",
								email: "u3@x.com",
								age: 35,
								companyId: "comp1",
							},
							update: {},
						},
					]);

					return yield* Ref.get(usersRef);
				}),
			);

			expect(mapAfter.size).toBe(3); // 2 existing + 1 new
			expect(mapAfter.get("user1")?.name).toBe("Batch Updated");
			expect(mapAfter.has("user3")).toBe(true);
		});
	});
});
