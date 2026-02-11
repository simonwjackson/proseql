import { describe, it, expect } from "vitest"
import {
	arrayToMap,
	mapToObject,
	objectToMap,
	mapToArray,
	extractCollectionsFromMaps,
	mergeFileDataIntoMaps,
	arrayToObject,
	objectToArray,
	groupByFile,
	getConfigFilePaths,
	isCollectionPersistent,
	extractCollectionsForFile,
	mergeFileDataIntoDataset,
} from "../core/storage/transforms.js"

// ============================================================================
// Test data
// ============================================================================

type User = { readonly id: string; readonly name: string; readonly age: number }

const alice: User = { id: "user-1", name: "Alice", age: 30 }
const bob: User = { id: "user-2", name: "Bob", age: 25 }
const charlie: User = { id: "user-3", name: "Charlie", age: 35 }

// ============================================================================
// ReadonlyMap-aware transforms
// ============================================================================

describe("arrayToMap", () => {
	it("converts an array of entities to a ReadonlyMap keyed by id", () => {
		const result = arrayToMap([alice, bob])
		expect(result).toBeInstanceOf(Map)
		expect(result.size).toBe(2)
		expect(result.get("user-1")).toEqual(alice)
		expect(result.get("user-2")).toEqual(bob)
	})

	it("returns an empty map for an empty array", () => {
		const result = arrayToMap([])
		expect(result.size).toBe(0)
	})

	it("handles a single element", () => {
		const result = arrayToMap([alice])
		expect(result.size).toBe(1)
		expect(result.get("user-1")).toEqual(alice)
	})

	it("last entry wins when duplicate ids exist", () => {
		const alice2 = { id: "user-1", name: "Alice2", age: 99 }
		const result = arrayToMap([alice, alice2])
		expect(result.size).toBe(1)
		expect(result.get("user-1")).toEqual(alice2)
	})
})

describe("mapToObject", () => {
	it("converts a ReadonlyMap to a Record keyed by id", () => {
		const map: ReadonlyMap<string, typeof alice> = new Map([
			["user-1", alice],
			["user-2", bob],
		])
		const result = mapToObject(map)
		expect(result).toEqual({
			"user-1": alice,
			"user-2": bob,
		})
	})

	it("returns an empty object for an empty map", () => {
		const result = mapToObject(new Map())
		expect(result).toEqual({})
	})
})

describe("objectToMap", () => {
	it("converts a Record to a ReadonlyMap", () => {
		const obj = { "user-1": alice, "user-2": bob }
		const result = objectToMap(obj)
		expect(result).toBeInstanceOf(Map)
		expect(result.size).toBe(2)
		expect(result.get("user-1")).toEqual(alice)
		expect(result.get("user-2")).toEqual(bob)
	})

	it("returns an empty map for an empty object", () => {
		const result = objectToMap({})
		expect(result.size).toBe(0)
	})
})

describe("mapToArray", () => {
	it("converts a ReadonlyMap to an array of values", () => {
		const map: ReadonlyMap<string, typeof alice> = new Map([
			["user-1", alice],
			["user-2", bob],
		])
		const result = mapToArray(map)
		expect(result).toEqual([alice, bob])
	})

	it("returns an empty array for an empty map", () => {
		const result = mapToArray(new Map())
		expect(result).toEqual([])
	})
})

describe("round-trip conversions", () => {
	it("arrayToMap → mapToObject preserves data (equivalent to arrayToObject)", () => {
		const items = [alice, bob, charlie]
		const viaMap = mapToObject(arrayToMap(items))
		const viaLegacy = arrayToObject(items)
		expect(viaMap).toEqual(viaLegacy)
	})

	it("objectToMap → mapToArray preserves data (equivalent to objectToArray)", () => {
		const obj = { "user-1": alice, "user-2": bob }
		const viaMap = mapToArray(objectToMap(obj))
		const viaLegacy = objectToArray(obj)
		expect(viaMap).toEqual(viaLegacy)
	})

	it("arrayToMap → mapToArray round-trips", () => {
		const items = [alice, bob, charlie]
		const result = mapToArray(arrayToMap(items))
		expect(result).toEqual(items)
	})

	it("objectToMap → mapToObject round-trips", () => {
		const obj = { "user-1": alice, "user-2": bob }
		const result = mapToObject(objectToMap(obj))
		expect(result).toEqual(obj)
	})
})

// ============================================================================
// extractCollectionsFromMaps
// ============================================================================

describe("extractCollectionsFromMaps", () => {
	type NamedEntity = { readonly id: string; readonly name: string }

	const usersMap: ReadonlyMap<string, NamedEntity> = new Map([
		["user-1", { id: "user-1", name: "Alice" }],
		["user-2", { id: "user-2", name: "Bob" }],
	])
	const productsMap: ReadonlyMap<string, NamedEntity> = new Map([
		["prod-1", { id: "prod-1", name: "Widget" }],
	])

	it("extracts specified collections to nested Record format", () => {
		const stateMaps = { users: usersMap, products: productsMap }
		const result = extractCollectionsFromMaps(stateMaps, ["users"])
		expect(result).toEqual({
			users: {
				"user-1": { id: "user-1", name: "Alice" },
				"user-2": { id: "user-2", name: "Bob" },
			},
		})
		expect(result.products).toBeUndefined()
	})

	it("extracts multiple collections", () => {
		const stateMaps = { users: usersMap, products: productsMap }
		const result = extractCollectionsFromMaps(stateMaps, ["users", "products"])
		expect(Object.keys(result)).toEqual(["users", "products"])
	})

	it("skips collection names not in stateMaps", () => {
		const stateMaps = { users: usersMap }
		const result = extractCollectionsFromMaps(stateMaps, ["users", "nonexistent"])
		expect(Object.keys(result)).toEqual(["users"])
	})

	it("returns empty Record when no collections match", () => {
		const result = extractCollectionsFromMaps({}, ["users"])
		expect(result).toEqual({})
	})
})

// ============================================================================
// mergeFileDataIntoMaps
// ============================================================================

describe("mergeFileDataIntoMaps", () => {
	it("merges file data into existing state maps", () => {
		const existingMaps = {
			users: new Map([["user-1", { id: "user-1", name: "Old Alice" }]]) as ReadonlyMap<string, { readonly id: string; readonly name: string }>,
		}

		const fileData = {
			users: {
				"user-1": { id: "user-1", name: "New Alice" },
				"user-2": { id: "user-2", name: "Bob" },
			},
		}

		const result = mergeFileDataIntoMaps(existingMaps, fileData, ["users"])
		expect(result.users.size).toBe(2)
		expect(result.users.get("user-1")).toEqual({ id: "user-1", name: "New Alice" })
		expect(result.users.get("user-2")).toEqual({ id: "user-2", name: "Bob" })
	})

	it("preserves collections not listed in collectionsFromFile", () => {
		const existingMaps = {
			users: new Map([["user-1", { id: "user-1", name: "Alice" }]]) as ReadonlyMap<string, { readonly id: string; readonly name: string }>,
			products: new Map([["prod-1", { id: "prod-1", name: "Widget" }]]) as ReadonlyMap<string, { readonly id: string; readonly name: string }>,
		}

		const fileData = {
			users: {
				"user-1": { id: "user-1", name: "Updated Alice" },
			},
		}

		const result = mergeFileDataIntoMaps(existingMaps, fileData, ["users"])
		// users updated
		expect(result.users.get("user-1")).toEqual({ id: "user-1", name: "Updated Alice" })
		// products preserved
		expect(result.products).toBe(existingMaps.products)
	})

	it("skips collections not present in fileData", () => {
		const existingMaps = {
			users: new Map([["user-1", { id: "user-1", name: "Alice" }]]) as ReadonlyMap<string, { readonly id: string; readonly name: string }>,
		}

		const result = mergeFileDataIntoMaps(existingMaps, {}, ["users"])
		// users should remain unchanged since fileData has no "users" key
		expect(result.users).toBe(existingMaps.users)
	})

	it("handles empty existing state", () => {
		const fileData = {
			users: {
				"user-1": { id: "user-1", name: "Alice" },
			},
		}

		const result = mergeFileDataIntoMaps({}, fileData, ["users"])
		expect(result.users.size).toBe(1)
		expect(result.users.get("user-1")).toEqual({ id: "user-1", name: "Alice" })
	})
})

// ============================================================================
// Legacy transforms (existing functionality, ensure no regressions)
// ============================================================================

describe("arrayToObject (legacy)", () => {
	it("converts an array to an object keyed by id", () => {
		const result = arrayToObject([alice, bob])
		expect(result).toEqual({
			"user-1": alice,
			"user-2": bob,
		})
	})

	it("returns empty object for empty array", () => {
		expect(arrayToObject([])).toEqual({})
	})
})

describe("objectToArray (legacy)", () => {
	it("converts an object back to an array", () => {
		const result = objectToArray({ "user-1": alice, "user-2": bob })
		expect(result).toEqual([alice, bob])
	})

	it("returns empty array for empty object", () => {
		expect(objectToArray({})).toEqual([])
	})
})

describe("groupByFile", () => {
	it("groups collections by their file paths", () => {
		const config = {
			users: { file: "/data/users.json" },
			products: { file: "/data/db.json" },
			categories: { file: "/data/db.json" },
			sessions: {},
		}
		const result = groupByFile(config)
		expect(result.get("/data/users.json")).toEqual(["users"])
		expect(result.get("/data/db.json")).toEqual(["products", "categories"])
		expect(result.size).toBe(2)
	})

	it("returns empty map when no collections have files", () => {
		const result = groupByFile({ sessions: {} })
		expect(result.size).toBe(0)
	})
})

describe("getConfigFilePaths", () => {
	it("returns unique file paths", () => {
		const config = {
			users: { file: "/data/users.json" },
			products: { file: "/data/db.json" },
			categories: { file: "/data/db.json" },
		}
		const result = getConfigFilePaths(config)
		expect(result.sort()).toEqual(["/data/db.json", "/data/users.json"])
	})
})

describe("isCollectionPersistent", () => {
	it("returns true when collection has a file path", () => {
		const config = { users: { file: "/data/users.json" } }
		expect(isCollectionPersistent(config, "users")).toBe(true)
	})

	it("returns false when collection has no file path", () => {
		const config = { sessions: {} }
		expect(isCollectionPersistent(config, "sessions")).toBe(false)
	})
})
