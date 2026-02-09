/**
 * Persistence Setup Example - Effect API
 *
 * Demonstrates creating a persistent database backed by JSON files on disk.
 * Uses Effect Service/Layer for dependency injection:
 *   - StorageAdapter: filesystem I/O (Node.js adapter)
 *   - SerializerRegistry: JSON/YAML/MessagePack encoding
 *
 * CRUD mutations automatically trigger debounced writes to disk.
 * On shutdown, pending writes are flushed via the Scope finalizer.
 */

import { Effect, Layer, Schema, Scope } from "effect"
import {
	createPersistentEffectDatabase,
	type EffectDatabaseWithPersistence,
} from "../core/factories/database-effect"
import { NodeStorageLayer } from "../core/storage/node-adapter-layer"
import { JsonSerializerLayer } from "../core/serializers/json"
import { StorageAdapter } from "../core/storage/storage-service"
import { SerializerRegistry } from "../core/serializers/serializer-service"

// ============================================================================
// 1. Schemas
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
	tags: Schema.optional(Schema.Array(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

// ============================================================================
// 2. Config — the `file` field enables persistence for that collection
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		file: "./data/users.json",
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
		file: "./data/posts.json",
		relationships: {
			author: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "authorId",
			},
		},
	},
} as const

// ============================================================================
// 3. Compose the Layer
// ============================================================================

// Merge the Node.js filesystem adapter with the JSON serializer.
// This satisfies the StorageAdapter + SerializerRegistry services
// required by createPersistentEffectDatabase.
const PersistenceLayer = Layer.merge(NodeStorageLayer, JsonSerializerLayer)

// ============================================================================
// 4. Main Program
// ============================================================================

const program = Effect.gen(function* () {
	// Create a persistent database — CRUD mutations trigger debounced saves.
	// The Scope finalizer flushes pending writes on shutdown.
	const db = yield* createPersistentEffectDatabase(config, {
		users: [],
		posts: [],
	}, {
		writeDebounce: 50, // 50ms debounce for demo
	})

	// --- Create some data (automatically persisted to ./data/users.json) ---
	const alice = yield* db.users.create({
		name: "Alice Johnson",
		email: "alice@example.com",
		age: 28,
	})
	console.log("Created user:", alice.name, alice.id)

	const bob = yield* db.users.create({
		name: "Bob Smith",
		email: "bob@example.com",
		age: 35,
	})
	console.log("Created user:", bob.name, bob.id)

	// --- Create posts (automatically persisted to ./data/posts.json) ---
	const post = yield* db.posts.create({
		title: "Getting Started with Effect",
		content: "Effect is a powerful library for TypeScript...",
		authorId: alice.id,
		tags: ["effect", "typescript"],
	})
	console.log("Created post:", post.title)

	yield* db.posts.create({
		title: "Database Design",
		content: "Choosing the right persistence strategy...",
		authorId: bob.id,
		tags: ["database", "design"],
	})

	// --- Update (triggers debounced save) ---
	yield* db.users.update(alice.id, { age: 29 })
	console.log("Updated Alice's age to 29")

	// --- Query with population ---
	const postsWithAuthors = yield* Effect.promise(() =>
		db.posts.query({ populate: { author: true } }).runPromise,
	)

	console.log("\nAll posts with authors:")
	for (const p of postsWithAuthors) {
		const entry = p as Record<string, unknown>
		const author = entry.author as Record<string, unknown> | undefined
		console.log(`  "${entry.title}" by ${author?.name ?? "unknown"}`)
	}

	// --- Flush: force all pending writes to disk immediately ---
	yield* Effect.promise(() => db.flush())
	console.log("\nFlushed pending writes")
	console.log(`Pending count after flush: ${db.pendingCount()}`)

	console.log("\nData persisted to:")
	console.log("  ./data/users.json")
	console.log("  ./data/posts.json")
})

// ============================================================================
// 5. Run with Layer + Scope
// ============================================================================

// Provide the persistence services and a Scope for managed lifecycle.
// Effect.scoped closes the scope when the program ends, triggering the
// finalizer that flushes any remaining pending writes.
const runnable = program.pipe(
	Effect.provide(PersistenceLayer),
	Effect.scoped,
)

Effect.runPromise(runnable).catch(console.error)
