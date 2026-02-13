/**
 * Persistence Setup Example - Effect API
 *
 * Demonstrates three ways to set up file persistence, from simplest to most
 * configurable:
 *   1. createNodeDatabase() — zero-config convenience wrapper
 *   2. makeNodePersistenceLayer() — explicit layer from config
 *   3. Manual Layer.merge() — full control over codecs and storage
 */

import { createNodeDatabase } from "@proseql/node";
import { Effect, Schema } from "effect";

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
});

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	tags: Schema.optional(Schema.Array(Schema.String)),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

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
} as const;

// ============================================================================
// 3. Approach A: createNodeDatabase() — the simplest path
// ============================================================================
// Codecs are inferred from file extensions. No manual layer wiring needed.
// The returned Effect only requires Scope.

const program = Effect.gen(function* () {
	const db = yield* createNodeDatabase(
		config,
		{
			users: [],
			posts: [],
		},
		{
			writeDebounce: 50, // 50ms debounce for demo
		},
	);

	// --- Create some data (automatically persisted to ./data/users.json) ---
	const alice = yield* db.users.create({
		name: "Alice Johnson",
		email: "alice@example.com",
		age: 28,
	});
	console.log("Created user:", alice.name, alice.id);

	const bob = yield* db.users.create({
		name: "Bob Smith",
		email: "bob@example.com",
		age: 35,
	});
	console.log("Created user:", bob.name, bob.id);

	// --- Create posts (automatically persisted to ./data/posts.json) ---
	const post = yield* db.posts.create({
		title: "Getting Started with Effect",
		content: "Effect is a powerful library for TypeScript...",
		authorId: alice.id,
		tags: ["effect", "typescript"],
	});
	console.log("Created post:", post.title);

	yield* db.posts.create({
		title: "Database Design",
		content: "Choosing the right persistence strategy...",
		authorId: bob.id,
		tags: ["database", "design"],
	});

	// --- Update (triggers debounced save) ---
	yield* db.users.update(alice.id, { age: 29 });
	console.log("Updated Alice's age to 29");

	// --- Query with population ---
	const postsWithAuthors = yield* Effect.promise(
		() => db.posts.query({ populate: { author: true } }).runPromise,
	);

	console.log("\nAll posts with authors:");
	for (const p of postsWithAuthors) {
		console.log(`  "${p.title}" by ${p.author?.name ?? "unknown"}`);
	}

	// --- Flush: force all pending writes to disk immediately ---
	yield* Effect.promise(() => db.flush());
	console.log("\nFlushed pending writes");
	console.log(`Pending count after flush: ${db.pendingCount()}`);

	console.log("\nData persisted to:");
	console.log("  ./data/users.json");
	console.log("  ./data/posts.json");
});

// ============================================================================
// 4. Run — Effect.scoped closes the scope and flushes pending writes
// ============================================================================

Effect.runPromise(Effect.scoped(program)).catch(console.error);

// ============================================================================
// Alternative Approaches (for reference)
// ============================================================================

// --- Approach B: makeNodePersistenceLayer() for explicit layer control ---
// Useful when you need to add extra codecs or customize the layer.
//
// const PersistenceLayer = makeNodePersistenceLayer(config)
//
// const programB = Effect.gen(function* () {
//   const db = yield* createPersistentEffectDatabase(config, {
//     users: [],
//     posts: [],
//   })
//   // ... same operations as above
// })
//
// Effect.runPromise(
//   programB.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
// ).catch(console.error)

// --- Approach C: Manual Layer.merge() for full control ---
// When you need custom codec options, plugin codecs, etc.
//
// import { Layer } from "effect"
// import { NodeStorageLayer, makeSerializerLayer, jsonCodec } from "@proseql/node"
//
// const ManualLayer = Layer.merge(
//   NodeStorageLayer,
//   makeSerializerLayer([jsonCodec()]),
// )
//
// Effect.runPromise(
//   programB.pipe(Effect.provide(ManualLayer), Effect.scoped),
// ).catch(console.error)
