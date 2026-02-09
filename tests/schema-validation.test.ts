import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { validateEntity, encodeEntity } from "../core/validators/schema-validator.js"
import { ValidationError } from "../core/errors/index.js"

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
})

const WithTransform = Schema.Struct({
	id: Schema.String,
	count: Schema.NumberFromString,
})

describe("validateEntity", () => {
	it("decodes valid data", async () => {
		const result = await Effect.runPromise(
			validateEntity(UserSchema, { id: "1", name: "Alice", age: 30 }),
		)
		expect(result).toEqual({ id: "1", name: "Alice", age: 30 })
	})

	it("decodes data with transformations", async () => {
		const result = await Effect.runPromise(
			validateEntity(WithTransform, { id: "1", count: "42" }),
		)
		expect(result).toEqual({ id: "1", count: 42 })
	})

	it("fails with ValidationError for invalid data", async () => {
		const effect = validateEntity(UserSchema, { id: "1", name: 123, age: "not a number" })
		const result = await Effect.runPromise(Effect.either(effect))

		expect(result._tag).toBe("Left")
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(ValidationError)
			expect(result.left._tag).toBe("ValidationError")
			expect(result.left.issues.length).toBeGreaterThan(0)
		}
	})

	it("fails with ValidationError for missing required fields", async () => {
		const effect = validateEntity(UserSchema, { id: "1" })
		const result = await Effect.runPromise(Effect.either(effect))

		expect(result._tag).toBe("Left")
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("ValidationError")
			expect(result.left.issues.length).toBeGreaterThan(0)
			expect(result.left.issues[0].message).toBe("is missing")
		}
	})

	it("fails with ValidationError for completely wrong input", async () => {
		const effect = validateEntity(UserSchema, "not an object")
		const result = await Effect.runPromise(Effect.either(effect))

		expect(result._tag).toBe("Left")
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("ValidationError")
			expect(result.left.message).toBeTruthy()
		}
	})

	it("can be caught with Effect.catchTag", async () => {
		const effect = validateEntity(UserSchema, {}).pipe(
			Effect.catchTag("ValidationError", (err) =>
				Effect.succeed(`caught: ${err.issues.length} issues`),
			),
		)
		const result = await Effect.runPromise(effect)
		expect(result).toMatch(/^caught: \d+ issues$/)
	})
})

describe("encodeEntity", () => {
	it("encodes valid entity to encoded form", async () => {
		const result = await Effect.runPromise(
			encodeEntity(UserSchema, { id: "1", name: "Alice", age: 30 }),
		)
		expect(result).toEqual({ id: "1", name: "Alice", age: 30 })
	})

	it("encodes entity with transformations", async () => {
		const result = await Effect.runPromise(
			encodeEntity(WithTransform, { id: "1", count: 42 }),
		)
		expect(result).toEqual({ id: "1", count: "42" })
	})

	it("fails with ValidationError for invalid entity", async () => {
		const effect = encodeEntity(UserSchema, { id: 123, name: null, age: "bad" } as never)
		const result = await Effect.runPromise(Effect.either(effect))

		expect(result._tag).toBe("Left")
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("ValidationError")
		}
	})
})

describe("round-trip encode/decode", () => {
	it("preserves data for simple schema", async () => {
		const original = { id: "1", name: "Alice", age: 30 }
		const encoded = await Effect.runPromise(encodeEntity(UserSchema, original))
		const decoded = await Effect.runPromise(validateEntity(UserSchema, encoded))
		expect(decoded).toEqual(original)
	})

	it("preserves data for schema with transformations", async () => {
		const original = { id: "1", count: 42 }
		const encoded = await Effect.runPromise(encodeEntity(WithTransform, original))
		expect(encoded).toEqual({ id: "1", count: "42" })
		const decoded = await Effect.runPromise(validateEntity(WithTransform, encoded))
		expect(decoded).toEqual(original)
	})

	it("preserves data for schema with optional fields", async () => {
		const OptionalSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			bio: Schema.optional(Schema.String),
		})
		const original = { id: "1", name: "Alice" }
		const encoded = await Effect.runPromise(encodeEntity(OptionalSchema, original))
		const decoded = await Effect.runPromise(validateEntity(OptionalSchema, encoded))
		expect(decoded).toEqual(original)
	})
})
