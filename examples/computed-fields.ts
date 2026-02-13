/**
 * Computed Fields Example
 *
 * Demonstrates derived values that exist only at query time: computed
 * fields in results, filtering, sorting, and selection. Computed fields
 * are never persisted and have zero overhead when not selected.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import type { ComputedFieldsConfig } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	pages: Schema.Number,
	genre: Schema.String,
	authorId: Schema.optional(Schema.String),
})

type Book = typeof BookSchema.Type

// ============================================================================
// 2. Config with Computed Fields
// ============================================================================

// Computed fields are defined separately and cast to satisfy the generic config type.
// At runtime, the entity passed to each function is the full Book.
const bookComputed = {
	displayName: (book: Book) => `${book.title} (${book.year})`,
	isClassic: (book: Book) => book.year < 1980,
	pageCategory: (book: Book) =>
		book.pages < 200 ? "short" : book.pages < 400 ? "medium" : "long",
} as ComputedFieldsConfig<unknown>

const config = {
	books: {
		schema: BookSchema,
		relationships: {},
		computed: bookComputed,
	},
} as const

const initialData = {
	books: [
		{ id: "b1", title: "Dune", year: 1965, pages: 412, genre: "sci-fi" },
		{ id: "b2", title: "Neuromancer", year: 1984, pages: 271, genre: "sci-fi" },
		{ id: "b3", title: "The Left Hand of Darkness", year: 1969, pages: 286, genre: "sci-fi" },
		{ id: "b4", title: "Project Hail Mary", year: 2021, pages: 476, genre: "sci-fi" },
		{ id: "b5", title: "The Hobbit", year: 1937, pages: 310, genre: "fantasy" },
	],
}

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// === Computed Fields in Results ===
	console.log("=== Computed Fields in Results ===")

	const allBooks = await db.books.query().runPromise as ReadonlyArray<Record<string, unknown>>
	for (const b of allBooks) {
		console.log(`  ${b.displayName} — classic: ${b.isClassic}, length: ${b.pageCategory}`)
	}

	// === Filter on Computed Fields ===
	console.log("\n=== Filter on Computed Fields ===")

	const classics = await db.books.query({
		where: { isClassic: true },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`Classics (year < 1980): ${classics.length} books`)
	for (const b of classics) {
		console.log(`  ${b.displayName}`)
	}

	const longBooks = await db.books.query({
		where: { pageCategory: "long" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`Long books (400+ pages): ${longBooks.length} books`)

	// === Sort by Computed Fields ===
	console.log("\n=== Sort by Computed Fields ===")

	const sortedByDisplay = await db.books.query({
		sort: { displayName: "asc" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log("Sorted by displayName (asc):")
	for (const b of sortedByDisplay) {
		console.log(`  ${b.displayName}`)
	}

	// === Select Computed Fields ===
	console.log("\n=== Select Computed Fields ===")

	const labels = await db.books.query({
		select: ["displayName", "isClassic"],
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log("Selected displayName + isClassic:")
	for (const b of labels) {
		console.log(`  ${JSON.stringify(b)}`)
	}
}

main().catch(console.error)
