import { describe, it, expect } from "vitest"
import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
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
// Test Config
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts" as const,
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: { type: "ref" as const, target: "users" as const },
		},
	},
} as const

// ============================================================================
// Initial Data
// ============================================================================

const initialData = {
	users: [
		{ id: "u1", name: "Alice", email: "alice@test.com", age: 30 },
		{ id: "u2", name: "Bob", email: "bob@test.com", age: 25 },
	],
	posts: [
		{ id: "p1", title: "Hello World", content: "First post", authorId: "u1" },
		{ id: "p2", title: "TypeScript Tips", content: "Type safety", authorId: "u2" },
	],
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a fresh test database with initial data.
 * Returns the database ready for transaction testing.
 */
const createTestDb = () => createEffectDatabase(config, initialData)

// ============================================================================
// Transaction Callback Tests
// ============================================================================

describe("$transaction", () => {
	describe("successful transactions", () => {
		it("should have $transaction method on the database", async () => {
			const db = await Effect.runPromise(createTestDb())
			expect(typeof db.$transaction).toBe("function")
		})
	})
})
