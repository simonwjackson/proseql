import { describe, it, expect } from "vitest"
import { tomlCodec } from "../src/serializers/codecs/toml.js"

/**
 * TOML-specific null stripping tests.
 *
 * TOML has no null type, so the tomlCodec strips null/undefined values
 * recursively before encoding. These tests cover edge cases:
 * - Nested nulls
 * - Arrays with nulls
 * - Empty objects after stripping
 * - Deeply nested structures
 */

describe("tomlCodec null stripping", () => {
	const codec = tomlCodec()

	describe("nested nulls", () => {
		it("strips null at root level", () => {
			const input = { a: 1, b: null, c: 3 }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ a: 1, c: 3 })
		})

		it("strips null in nested objects", () => {
			const input = {
				user: {
					name: "Alice",
					nickname: null,
					age: 30,
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				user: {
					name: "Alice",
					age: 30,
				},
			})
		})

		it("strips undefined values", () => {
			const input = {
				a: 1,
				b: undefined,
				c: {
					d: undefined,
					e: 2,
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				a: 1,
				c: { e: 2 },
			})
		})

		it("strips mixed null and undefined", () => {
			const input = {
				a: null,
				b: undefined,
				c: "kept",
				nested: {
					d: null,
					e: undefined,
					f: "also kept",
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				c: "kept",
				nested: { f: "also kept" },
			})
		})
	})

	describe("arrays with nulls", () => {
		it("removes null elements from arrays", () => {
			const input = { items: [1, null, 2, null, 3] }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ items: [1, 2, 3] })
		})

		it("removes undefined elements from arrays", () => {
			const input = { items: [1, undefined, 2, undefined, 3] }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ items: [1, 2, 3] })
		})

		it("handles array of objects with null fields", () => {
			const input = {
				users: [
					{ id: 1, name: "Alice", nickname: null },
					{ id: 2, name: "Bob", nickname: "Bobby" },
				],
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				users: [
					{ id: 1, name: "Alice" },
					{ id: 2, name: "Bob", nickname: "Bobby" },
				],
			})
		})

		it("handles arrays containing null objects", () => {
			// Note: null elements are removed from the array
			const input = { items: [{ a: 1 }, null, { b: 2 }] }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ items: [{ a: 1 }, { b: 2 }] })
		})

		it("handles nested arrays with nulls", () => {
			const input = {
				matrix: [
					[1, null, 2],
					[null, 3, 4],
				],
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				matrix: [
					[1, 2],
					[3, 4],
				],
			})
		})

		it("returns empty array when all elements are null", () => {
			const input = { items: [null, null, null] }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ items: [] })
		})
	})

	describe("empty objects after stripping", () => {
		it("keeps empty objects after null removal", () => {
			const input = {
				config: {
					setting1: null,
					setting2: null,
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			// TOML tables that become empty after null stripping remain as empty tables
			expect(decoded).toEqual({ config: {} })
		})

		it("keeps nested empty objects", () => {
			const input = {
				outer: {
					inner: {
						value: null,
					},
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ outer: { inner: {} } })
		})

		it("handles mix of empty and non-empty objects", () => {
			const input = {
				empty: { a: null, b: null },
				notEmpty: { a: null, b: 1 },
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				empty: {},
				notEmpty: { b: 1 },
			})
		})

		it("handles originally empty objects", () => {
			const input = { config: {} }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ config: {} })
		})
	})

	describe("deeply nested structures", () => {
		it("strips nulls at all levels", () => {
			const input = {
				level1: {
					keep: 1,
					remove: null,
					level2: {
						keep: 2,
						remove: null,
						level3: {
							keep: 3,
							remove: null,
							level4: {
								keep: 4,
								remove: null,
							},
						},
					},
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				level1: {
					keep: 1,
					level2: {
						keep: 2,
						level3: {
							keep: 3,
							level4: {
								keep: 4,
							},
						},
					},
				},
			})
		})

		it("handles deeply nested arrays with nulls", () => {
			const input = {
				data: {
					items: [
						{
							subitems: [
								{ value: 1, meta: null },
								{ value: 2, meta: "kept" },
							],
						},
					],
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				data: {
					items: [
						{
							subitems: [
								{ value: 1 },
								{ value: 2, meta: "kept" },
							],
						},
					],
				},
			})
		})

		it("handles complex mixed structure", () => {
			const input = {
				users: [
					{
						id: 1,
						profile: {
							name: "Alice",
							bio: null,
							settings: {
								theme: "dark",
								notifications: null,
								preferences: {
									language: "en",
									timezone: null,
								},
							},
						},
						deletedAt: null,
					},
				],
				metadata: {
					version: 1,
					deprecated: null,
				},
			}
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({
				users: [
					{
						id: 1,
						profile: {
							name: "Alice",
							settings: {
								theme: "dark",
								preferences: {
									language: "en",
								},
							},
						},
					},
				],
				metadata: {
					version: 1,
				},
			})
		})
	})

	describe("edge cases", () => {
		it("handles root-level null (returns empty object)", () => {
			// When the entire input is null, stripNulls returns undefined
			// but smol-toml expects an object, so this tests the edge case
			const input = { data: null }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({})
		})

		it("preserves empty strings (not null)", () => {
			const input = { name: "", value: null }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ name: "" })
		})

		it("preserves zero (not null)", () => {
			const input = { count: 0, removed: null }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ count: 0 })
		})

		it("preserves false (not null)", () => {
			const input = { active: false, removed: null }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({ active: false })
		})

		it("handles object with only null values", () => {
			const input = { a: null, b: null, c: null }
			const encoded = codec.encode(input)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual({})
		})
	})
})
