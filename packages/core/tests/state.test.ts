import { describe, expect, it } from "vitest"
import { Effect, Option, Ref } from "effect"
import { createCollectionState } from "../src/state/collection-state.js"
import {
	getEntity,
	getEntityOrFail,
	getAllEntities,
	setEntity,
	removeEntity,
	updateEntity,
} from "../src/state/state-operations.js"
import { NotFoundError } from "../src/errors/crud-errors.js"

type User = {
	readonly id: string
	readonly name: string
	readonly age: number
}

const alice: User = { id: "1", name: "Alice", age: 30 }
const bob: User = { id: "2", name: "Bob", age: 25 }
const charlie: User = { id: "3", name: "Charlie", age: 35 }

describe("createCollectionState", () => {
	it("creates state from an array of entities keyed by id", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob])
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(2)
		expect(result.get("1")).toEqual(alice)
		expect(result.get("2")).toEqual(bob)
	})

	it("creates empty state when no initial data is provided", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState<User>()
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(0)
	})

	it("creates empty state when empty array is provided", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState<User>([])
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(0)
	})

	it("deduplicates by id (last wins)", async () => {
		const aliceDup: User = { id: "1", name: "Alice Updated", age: 31 }
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, aliceDup])
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(1)
		expect(result.get("1")).toEqual(aliceDup)
	})
})

describe("getEntity", () => {
	it("returns Option.some for existing entity", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob])
				return yield* getEntity(ref, "1")
			}),
		)
		expect(Option.isSome(result)).toBe(true)
		expect(Option.getOrThrow(result)).toEqual(alice)
	})

	it("returns Option.none for missing entity", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				return yield* getEntity(ref, "999")
			}),
		)
		expect(Option.isNone(result)).toBe(true)
	})
})

describe("getEntityOrFail", () => {
	it("returns entity when found", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob])
				return yield* getEntityOrFail(ref, "1", "users")
			}),
		)
		expect(result).toEqual(alice)
	})

	it("fails with NotFoundError when entity is missing", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				return yield* getEntityOrFail(ref, "999", "users").pipe(
					Effect.catchTag("NotFoundError", (err) =>
						Effect.succeed({ caught: true, id: err.id, collection: err.collection }),
					),
				)
			}),
		)
		expect(result).toEqual({ caught: true, id: "999", collection: "users" })
	})
})

describe("getAllEntities", () => {
	it("returns all entities as an array", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob, charlie])
				return yield* getAllEntities(ref)
			}),
		)
		expect(result).toHaveLength(3)
		expect(result).toContainEqual(alice)
		expect(result).toContainEqual(bob)
		expect(result).toContainEqual(charlie)
	})

	it("returns empty array for empty state", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState<User>()
				return yield* getAllEntities(ref)
			}),
		)
		expect(result).toEqual([])
	})
})

describe("setEntity", () => {
	it("adds a new entity to state", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				yield* setEntity(ref, bob)
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(2)
		expect(result.get("2")).toEqual(bob)
	})

	it("replaces an existing entity with the same id", async () => {
		const updatedAlice: User = { id: "1", name: "Alice Updated", age: 31 }
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				yield* setEntity(ref, updatedAlice)
				const map = yield* Ref.get(ref)
				return map
			}),
		)
		expect(result.size).toBe(1)
		expect(result.get("1")).toEqual(updatedAlice)
	})
})

describe("removeEntity", () => {
	it("removes an existing entity and returns true", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob])
				const removed = yield* removeEntity(ref, "1")
				const map = yield* Ref.get(ref)
				return { removed, size: map.size, hasAlice: map.has("1") }
			}),
		)
		expect(result.removed).toBe(true)
		expect(result.size).toBe(1)
		expect(result.hasAlice).toBe(false)
	})

	it("returns false when entity does not exist", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				const removed = yield* removeEntity(ref, "999")
				const map = yield* Ref.get(ref)
				return { removed, size: map.size }
			}),
		)
		expect(result.removed).toBe(false)
		expect(result.size).toBe(1)
	})
})

describe("updateEntity", () => {
	it("updates an existing entity with updater function", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob])
				const updated = yield* updateEntity(
					ref,
					"1",
					(user) => ({ ...user, age: user.age + 1 }),
					"users",
				)
				const map = yield* Ref.get(ref)
				return { updated, stored: map.get("1") }
			}),
		)
		expect(result.updated).toEqual({ id: "1", name: "Alice", age: 31 })
		expect(result.stored).toEqual({ id: "1", name: "Alice", age: 31 })
	})

	it("fails with NotFoundError when entity does not exist", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				return yield* updateEntity(
					ref,
					"999",
					(user) => ({ ...user, age: 99 }),
					"users",
				).pipe(
					Effect.catchTag("NotFoundError", (err) =>
						Effect.succeed({ caught: true, id: err.id }),
					),
				)
			}),
		)
		expect(result).toEqual({ caught: true, id: "999" })
	})

	it("does not mutate state when entity is not found", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				yield* updateEntity(ref, "999", (u) => u, "users").pipe(
					Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
				)
				const map = yield* Ref.get(ref)
				return { size: map.size, alice: map.get("1") }
			}),
		)
		expect(result.size).toBe(1)
		expect(result.alice).toEqual(alice)
	})
})

describe("O(1) lookup by ID", () => {
	it("looks up entities from a large collection efficiently", async () => {
		const entities: ReadonlyArray<User> = Array.from({ length: 10_000 }, (_, i) => ({
			id: String(i),
			name: `User ${i}`,
			age: 20 + (i % 50),
		}))

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState(entities)
				// Look up several entities — these are O(1) Map.get calls
				const first = yield* getEntity(ref, "0")
				const middle = yield* getEntity(ref, "5000")
				const last = yield* getEntity(ref, "9999")
				const missing = yield* getEntity(ref, "99999")
				return { first, middle, last, missing }
			}),
		)
		expect(Option.isSome(result.first)).toBe(true)
		expect(Option.getOrThrow(result.first).name).toBe("User 0")
		expect(Option.isSome(result.middle)).toBe(true)
		expect(Option.getOrThrow(result.middle).name).toBe("User 5000")
		expect(Option.isSome(result.last)).toBe(true)
		expect(Option.getOrThrow(result.last).name).toBe("User 9999")
		expect(Option.isNone(result.missing)).toBe(true)
	})
})

describe("atomic updates and snapshot consistency", () => {
	it("multiple sequential updates produce correct final state", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				yield* setEntity(ref, bob)
				yield* setEntity(ref, charlie)
				yield* removeEntity(ref, "1")
				yield* updateEntity(ref, "2", (u) => ({ ...u, name: "Bobby" }), "users")
				return yield* getAllEntities(ref)
			}),
		)
		expect(result).toHaveLength(2)
		expect(result.find((u) => u.id === "2")?.name).toBe("Bobby")
		expect(result.find((u) => u.id === "3")).toEqual(charlie)
		expect(result.find((u) => u.id === "1")).toBeUndefined()
	})

	it("concurrent creates do not lose data", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState<User>([])
				// Run two setEntity calls concurrently via Effect.all
				yield* Effect.all([
					setEntity(ref, alice),
					setEntity(ref, bob),
				], { concurrency: 2 })
				return yield* getAllEntities(ref)
			}),
		)
		expect(result).toHaveLength(2)
		expect(result).toContainEqual(alice)
		expect(result).toContainEqual(bob)
	})

	it("state change produces a new map reference (referential inequality)", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice])
				const before = yield* Ref.get(ref)
				yield* setEntity(ref, bob)
				const after = yield* Ref.get(ref)
				return { same: before === after, beforeSize: before.size, afterSize: after.size }
			}),
		)
		expect(result.same).toBe(false)
		expect(result.beforeSize).toBe(1)
		expect(result.afterSize).toBe(2)
	})

	it("read during write sees consistent state (snapshot)", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ref = yield* createCollectionState([alice, bob, charlie])
				// Take a snapshot before mutation
				const snapshot = yield* Ref.get(ref)
				// Mutate state
				yield* removeEntity(ref, "1")
				yield* setEntity(ref, { id: "4", name: "Diana", age: 28 })
				// The snapshot should be unchanged
				const current = yield* Ref.get(ref)
				return {
					snapshotSize: snapshot.size,
					snapshotHas1: snapshot.has("1"),
					snapshotHas4: snapshot.has("4"),
					currentSize: current.size,
					currentHas1: current.has("1"),
					currentHas4: current.has("4"),
				}
			}),
		)
		// Snapshot remains unchanged
		expect(result.snapshotSize).toBe(3)
		expect(result.snapshotHas1).toBe(true)
		expect(result.snapshotHas4).toBe(false)
		// Current state reflects mutations
		expect(result.currentSize).toBe(3) // removed 1, added 4
		expect(result.currentHas1).toBe(false)
		expect(result.currentHas4).toBe(true)
	})
})
