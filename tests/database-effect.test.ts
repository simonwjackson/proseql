import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase, type RunnableEffect, type RunnableStream } from "../core/factories/database-effect.js"

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
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	industry: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

// ============================================================================
// Config
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" },
			posts: { type: "inverse" as const, target: "posts", foreignKey: "authorId" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users", foreignKey: "companyId" },
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" },
		},
	},
} as const

// ============================================================================
// Test Data
// ============================================================================

const initialData = {
	users: [
		{ id: "u1", name: "Alice", email: "alice@test.com", age: 30, companyId: "c1" },
		{ id: "u2", name: "Bob", email: "bob@test.com", age: 25, companyId: "c1" },
		{ id: "u3", name: "Charlie", email: "charlie@test.com", age: 35, companyId: "c2" },
	],
	companies: [
		{ id: "c1", name: "TechCorp", industry: "Technology" },
		{ id: "c2", name: "DataInc", industry: "Data" },
	],
	posts: [
		{ id: "p1", title: "Hello World", content: "First post", authorId: "u1" },
		{ id: "p2", title: "Effect TS", content: "Great library", authorId: "u1" },
		{ id: "p3", title: "TypeScript Tips", content: "Type safety", authorId: "u2" },
	],
}

// ============================================================================
// Tests
// ============================================================================

describe("createEffectDatabase", () => {
	describe("database creation", () => {
		it("should create a database with all collections", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
			expect(db.companies).toBeDefined()
			expect(db.posts).toBeDefined()
		})

		it("should create a database with empty initial data", async () => {
			const db = await Effect.runPromise(createEffectDatabase(config))
			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
		})

		it("should have all CRUD methods on each collection", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const users = db.users
			expect(typeof users.query).toBe("function")
			expect(typeof users.create).toBe("function")
			expect(typeof users.createMany).toBe("function")
			expect(typeof users.update).toBe("function")
			expect(typeof users.updateMany).toBe("function")
			expect(typeof users.delete).toBe("function")
			expect(typeof users.deleteMany).toBe("function")
			expect(typeof users.upsert).toBe("function")
			expect(typeof users.upsertMany).toBe("function")
			expect(typeof users.createWithRelationships).toBe("function")
			expect(typeof users.updateWithRelationships).toBe("function")
			expect(typeof users.deleteWithRelationships).toBe("function")
			expect(typeof users.deleteManyWithRelationships).toBe("function")
		})
	})

	describe("query pipeline", () => {
		it("should return all entities with no options", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(db.users.query())
				}),
			)
			expect(Chunk.toArray(result)).toHaveLength(3)
		})

		it("should filter with where clause", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ where: { age: { $gt: 28 } } }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(2)
			expect(items.map((i) => i.name)).toContain("Alice")
			expect(items.map((i) => i.name)).toContain("Charlie")
		})

		it("should filter with exact match", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ where: { name: "Alice" } }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(1)
			expect(items[0].name).toBe("Alice")
		})

		it("should sort results", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ sort: { age: "asc" } }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(3)
			expect(items[0].name).toBe("Bob")
			expect(items[1].name).toBe("Alice")
			expect(items[2].name).toBe("Charlie")
		})

		it("should paginate with offset and limit", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ sort: { age: "asc" }, offset: 1, limit: 1 }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(1)
			expect(items[0].name).toBe("Alice")
		})

		it("should select specific fields (array form)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ select: ["name", "age"] }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(3)
			for (const item of items) {
				expect(Object.keys(item)).toContain("name")
				expect(Object.keys(item)).toContain("age")
				expect(Object.keys(item)).not.toContain("email")
			}
		})

		it("should select specific fields (object form)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({ select: { name: true, email: true } }),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(3)
			for (const item of items) {
				expect(Object.keys(item)).toContain("name")
				expect(Object.keys(item)).toContain("email")
				expect(Object.keys(item)).not.toContain("age")
			}
		})

		it("should combine filter, sort, and pagination", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({
							where: { companyId: "c1" },
							sort: { age: "desc" },
							limit: 1,
						}),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(1)
			expect(items[0].name).toBe("Alice") // age 30 > 25
		})

		it("should populate ref relationships", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.users.query({
							where: { id: "u1" },
							populate: { company: true },
						}),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(1)
			const user = items[0] as Record<string, unknown>
			expect(user.name).toBe("Alice")
			const company = user.company as Record<string, unknown>
			expect(company).toBeDefined()
			expect(company.name).toBe("TechCorp")
		})

		it("should populate inverse relationships", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* Stream.runCollect(
						db.companies.query({
							where: { id: "c1" },
							populate: { employees: true },
						}),
					)
				}),
			)
			const items = Chunk.toArray(result)
			expect(items).toHaveLength(1)
			const company = items[0] as Record<string, unknown>
			expect(company.name).toBe("TechCorp")
			const employees = company.employees as Array<Record<string, unknown>>
			expect(employees).toHaveLength(2)
			expect(employees.map((e) => e.name)).toContain("Alice")
			expect(employees.map((e) => e.name)).toContain("Bob")
		})
	})

	describe("CRUD operations", () => {
		it("should create an entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.companies.create({
						name: "NewCo",
						industry: "Finance",
					})
				}),
			)
			expect(result.name).toBe("NewCo")
			expect(result.id).toBeDefined()
			expect(result.createdAt).toBeDefined()
		})

		it("should create and then query the created entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					const company = yield* db.companies.create({
						name: "NewCo",
						industry: "Finance",
					})
					const all = yield* Stream.runCollect(db.companies.query())
					return { company, count: Chunk.size(all) }
				}),
			)
			expect(result.company.name).toBe("NewCo")
			expect(result.count).toBe(3) // 2 initial + 1 created
		})

		it("should update an entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users.update("u1", { name: "Alice Updated" })
				}),
			)
			expect(result.name).toBe("Alice Updated")
			expect(result.id).toBe("u1")
		})

		it("should update with operators", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users.update("u1", {
						age: { $increment: 5 } as unknown as undefined,
					})
				}),
			)
			expect(result.age).toBe(35) // 30 + 5
		})

		it("should delete an entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					// Delete post p3 (no FK references to it)
					const deleted = yield* db.posts.delete("p3")
					const all = yield* Stream.runCollect(db.posts.query())
					return { deleted, count: Chunk.size(all) }
				}),
			)
			expect(result.deleted.title).toBe("TypeScript Tips")
			expect(result.count).toBe(2)
		})

		it("should upsert: create when not found", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.companies.upsert({
						where: { id: "c99" },
						create: { name: "UpsertCo", industry: "New" },
						update: { name: "Updated" },
					})
				}),
			)
			expect(result.name).toBe("UpsertCo")
			expect(result.__action).toBe("created")
		})

		it("should upsert: update when found", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.companies.upsert({
						where: { id: "c1" },
						create: { name: "ShouldNotCreate" },
						update: { name: "TechCorp Updated" },
					})
				}),
			)
			expect(result.name).toBe("TechCorp Updated")
			expect(result.__action).toBe("updated")
		})

		it("should createMany", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.companies.createMany([
						{ name: "Co1" },
						{ name: "Co2" },
					])
				}),
			)
			expect(result.created).toHaveLength(2)
		})
	})

	describe("cross-collection consistency", () => {
		it("should share state across collections for foreign key validation", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					// Create a user with valid companyId
					const user = yield* db.users.create({
						name: "Dave",
						email: "dave@test.com",
						age: 40,
						companyId: "c1",
					})
					return user
				}),
			)
			expect(result.name).toBe("Dave")
			expect(result.companyId).toBe("c1")
		})

		it("should fail on invalid foreign key", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users
						.create({
							name: "Eve",
							email: "eve@test.com",
							age: 28,
							companyId: "nonexistent",
						})
						.pipe(
							Effect.catchTag("ForeignKeyError", (e) =>
								Effect.succeed({ error: e }),
							),
						)
				}),
			)
			expect("error" in result).toBe(true)
		})

		it("mutations in one collection should be visible to queries in others", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					// Create a new company
					const company = yield* db.companies.create({
						name: "NewCorp",
					})
					// Create a user referencing the new company
					const user = yield* db.users.create({
						name: "Frank",
						email: "frank@test.com",
						age: 33,
						companyId: company.id,
					})
					// Query with population should find the new company
					const users = yield* Stream.runCollect(
						db.users.query({
							where: { id: user.id },
							populate: { company: true },
						}),
					)
					return Chunk.toArray(users)
				}),
			)
			expect(result).toHaveLength(1)
			const user = result[0] as Record<string, unknown>
			const company = user.company as Record<string, unknown>
			expect(company.name).toBe("NewCorp")
		})
	})

	describe("error handling", () => {
		it("should fail with NotFoundError on update of nonexistent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users
						.update("nonexistent", { name: "X" })
						.pipe(
							Effect.catchTag("NotFoundError", (e) =>
								Effect.succeed({ tag: e._tag, id: e.id }),
							),
						)
				}),
			)
			expect(result).toEqual({ tag: "NotFoundError", id: "nonexistent" })
		})

		it("should fail with DuplicateKeyError on duplicate ID", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users
						.create({
							id: "u1",
							name: "Duplicate",
							email: "dup@test.com",
							age: 20,
							companyId: "c1",
						})
						.pipe(
							Effect.catchTag("DuplicateKeyError", (e) =>
								Effect.succeed({ tag: e._tag }),
							),
						)
				}),
			)
			expect(result).toEqual({ tag: "DuplicateKeyError" })
		})

		it("should fail with NotFoundError on delete of nonexistent entity", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					return yield* db.users
						.delete("nonexistent")
						.pipe(
							Effect.catchTag("NotFoundError", (e) =>
								Effect.succeed({ tag: e._tag }),
							),
						)
				}),
			)
			expect(result).toEqual({ tag: "NotFoundError" })
		})
	})

	describe("runPromise convenience API", () => {
		it("query().runPromise should return an array of entities", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const users = await db.users.query().runPromise
			expect(Array.isArray(users)).toBe(true)
			expect(users).toHaveLength(3)
			expect(users.map((u) => u.name)).toContain("Alice")
		})

		it("query().runPromise with filter should return filtered array", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const users = await db.users.query({ where: { age: { $gt: 28 } } }).runPromise
			expect(users).toHaveLength(2)
			expect(users.map((u) => u.name)).toContain("Alice")
			expect(users.map((u) => u.name)).toContain("Charlie")
		})

		it("query().runPromise with sort/limit should return sorted subset", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const users = await db.users.query({
				sort: { age: "asc" },
				limit: 2,
			}).runPromise
			expect(users).toHaveLength(2)
			expect(users[0].name).toBe("Bob")
			expect(users[1].name).toBe("Alice")
		})

		it("create().runPromise should return the created entity", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const company = await db.companies.create({
				name: "RunPromiseCo",
				industry: "Testing",
			}).runPromise
			expect(company.name).toBe("RunPromiseCo")
			expect(company.id).toBeDefined()
		})

		it("update().runPromise should return the updated entity", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const user = await db.users.update("u1", { name: "Alice V2" }).runPromise
			expect(user.name).toBe("Alice V2")
			expect(user.id).toBe("u1")
		})

		it("delete().runPromise should return the deleted entity", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const post = await db.posts.delete("p3").runPromise
			expect(post.title).toBe("TypeScript Tips")
		})

		it("upsert().runPromise should return the upserted entity", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const result = await db.companies.upsert({
				where: { id: "c99" },
				create: { name: "UpsertRunPromise" },
				update: { name: "Updated" },
			}).runPromise
			expect(result.name).toBe("UpsertRunPromise")
			expect(result.__action).toBe("created")
		})

		it("create().runPromise should reject on error", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			await expect(
				db.users.create({
					id: "u1",
					name: "Duplicate",
					email: "dup@test.com",
					age: 20,
					companyId: "c1",
				}).runPromise,
			).rejects.toThrow()
		})

		it("runPromise on query should be cached (same promise instance)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const stream = db.users.query()
			const p1 = stream.runPromise
			const p2 = stream.runPromise
			expect(p1).toBe(p2)
		})

		it("runPromise on effect should be cached (same promise instance)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			const effect = db.companies.create({ name: "CacheCo" })
			const p1 = effect.runPromise
			const p2 = effect.runPromise
			expect(p1).toBe(p2)
		})

		it("query result should still work as a Stream with Effect.gen", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			)
			// Use .runPromise for convenience
			const viaPromise = await db.users.query().runPromise
			// Also use as Stream (native Effect)
			const viaStream = await Effect.runPromise(
				Stream.runCollect(db.users.query()).pipe(Effect.map(Chunk.toArray)),
			)
			expect(viaPromise).toHaveLength(3)
			expect(viaStream).toHaveLength(3)
		})

		it("CRUD result should still work as an Effect with pipe", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const db = yield* createEffectDatabase(config, initialData)
					// Use as Effect with pipe (native)
					const company = yield* db.companies.create({ name: "PipeCo" })
					return company
				}),
			)
			expect(result.name).toBe("PipeCo")
		})
	})
})
