/**
 * Reactive Queries Example
 *
 * Demonstrates watch() and watchById() for live query results.
 * Mutations automatically push updates through streams.
 * Uses Effect.scoped + Fiber to run watch in background while mutating.
 */

import { Chunk, Effect, Fiber, Schema, Stream } from "effect"
import { createEffectDatabase } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
})

// ============================================================================
// 2. Config and Seed Data
// ============================================================================

const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const

const initialData = {
	books: [
		{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
		{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi" },
		{ id: "3", title: "The Hobbit", author: "J.R.R. Tolkien", year: 1937, genre: "fantasy" },
	],
}

// ============================================================================
// 3. Watch with Filter — emits on matching mutations
// ============================================================================

const watchFilteredExample = Effect.gen(function* () {
	const db = yield* createEffectDatabase(config, initialData)

	console.log("=== watch() with filter ===")

	// Watch sci-fi books sorted by year
	const stream = yield* db.books.watch({
		where: { genre: "sci-fi" },
		sort: { year: "desc" },
	})

	// Take 3 emissions: initial + 2 mutations
	// Run the watcher in a background fiber
	const fiber = yield* Stream.take(stream, 3).pipe(
		Stream.runCollect,
		Effect.fork,
	)

	// Mutate — add a sci-fi book (triggers emission)
	yield* db.books.create({
		title: "Snow Crash",
		author: "Neal Stephenson",
		year: 1992,
		genre: "sci-fi",
	})

	// Mutate — update a sci-fi book (triggers emission)
	yield* db.books.update("1", { year: 1966 })

	// Collect results
	const emissions = Chunk.toReadonlyArray(yield* Fiber.join(fiber))

	console.log(`Received ${emissions.length} emissions:`)
	for (let i = 0; i < emissions.length; i++) {
		const books = emissions[i]
		console.log(`  Emission ${i + 1}: ${books.length} sci-fi books`)
	}
})

// ============================================================================
// 4. WatchById — emits entity, updated entity, null on delete
// ============================================================================

const watchByIdExample = Effect.gen(function* () {
	const db = yield* createEffectDatabase(config, initialData)

	console.log("\n=== watchById() ===")

	// Watch a single book by ID
	const stream = yield* db.books.watchById("1")

	// Take 3 emissions: initial + update + delete
	const fiber = yield* Stream.take(stream, 3).pipe(
		Stream.runCollect,
		Effect.fork,
	)

	// Update the book (triggers emission with updated entity)
	yield* db.books.update("1", { title: "Dune (Revised)" })

	// Delete the book (triggers emission with null)
	yield* db.books.delete("1")

	// Collect results
	const emissions = Chunk.toReadonlyArray(yield* Fiber.join(fiber))

	for (let i = 0; i < emissions.length; i++) {
		const book = emissions[i]
		if (book) {
			console.log(`  Emission ${i + 1}: "${book.title}"`)
		} else {
			console.log(`  Emission ${i + 1}: null (deleted)`)
		}
	}
})

// ============================================================================
// 5. Run with scope (stream cleans up automatically)
// ============================================================================

const program = Effect.gen(function* () {
	yield* watchFilteredExample
	yield* watchByIdExample
})

Effect.runPromise(Effect.scoped(program)).catch(console.error)
