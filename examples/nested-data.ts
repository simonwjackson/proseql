/**
 * Nested Data Example
 *
 * Demonstrates nested Schema.Struct, shape-mirroring vs dot-notation filtering,
 * sorting on nested fields, deep merge updates, nested operators, and
 * aggregation on nested fields.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import type { GroupResult } from "@proseql/core"

// ============================================================================
// 1. Schema with Nested Objects
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	genre: Schema.String,
	metadata: Schema.Struct({
		views: Schema.Number,
		rating: Schema.Number,
		tags: Schema.Array(Schema.String),
		description: Schema.String,
	}),
	author: Schema.Struct({
		name: Schema.String,
		country: Schema.String,
	}),
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
		{
			id: "b1", title: "Dune", genre: "sci-fi",
			metadata: { views: 1200, rating: 5, tags: ["classic", "desert"], description: "Spice and sandworms" },
			author: { name: "Frank Herbert", country: "USA" },
		},
		{
			id: "b2", title: "Neuromancer", genre: "sci-fi",
			metadata: { views: 800, rating: 4, tags: ["cyberpunk", "hacking"], description: "The sky above the port" },
			author: { name: "William Gibson", country: "USA" },
		},
		{
			id: "b3", title: "The Left Hand of Darkness", genre: "sci-fi",
			metadata: { views: 600, rating: 5, tags: ["gender", "anthropology"], description: "A winter planet" },
			author: { name: "Ursula K. Le Guin", country: "USA" },
		},
		{
			id: "b4", title: "Solaris", genre: "sci-fi",
			metadata: { views: 400, rating: 4, tags: ["philosophy", "alien"], description: "An ocean planet" },
			author: { name: "Stanislaw Lem", country: "Poland" },
		},
		{
			id: "b5", title: "The Hitchhiker's Guide", genre: "comedy",
			metadata: { views: 1500, rating: 5, tags: ["humor", "classic"], description: "Don't panic" },
			author: { name: "Douglas Adams", country: "UK" },
		},
	],
}

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// === Shape-Mirroring vs Dot-Notation ===
	console.log("=== Nested Filtering ===")

	// shape-mirroring — mirrors the object structure
	const highRated = await db.books.query({
		where: { metadata: { rating: 5 } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`rating = 5 (shape-mirroring): ${highRated.length} books`)

	// dot-notation — flat string path (equivalent)
	const highRatedDot = await db.books.query({
		where: { "metadata.rating": 5 },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`rating = 5 (dot-notation): ${highRatedDot.length} books`)

	// nested field with comparison operator
	const popular = await db.books.query({
		where: { metadata: { views: { $gt: 700 } } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`views > 700: ${popular.length} books`)

	// filter by nested author field
	const fromUSA = await db.books.query({
		where: { author: { country: "USA" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`author.country = "USA": ${fromUSA.length} books`)

	// === Sorting on Nested Fields ===
	console.log("\n=== Sorting on Nested Fields ===")

	const byViews = await db.books.query({
		sort: { "metadata.views": "desc" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log("Sorted by views (desc):")
	for (const b of byViews) {
		const meta = b.metadata as Record<string, unknown>
		console.log(`  ${meta.views} views — ${b.title}`)
	}

	// === Deep Merge Updates ===
	console.log("\n=== Deep Merge Updates ===")

	// Update a nested field — sibling fields are preserved
	const updated = await db.books.update("b1", {
		metadata: { views: 1500 },
	}).runPromise
	const meta = updated.metadata as Record<string, unknown>
	console.log(`Updated views: ${meta.views}`)
	console.log(`Rating preserved: ${meta.rating}`)
	console.log(`Description preserved: ${meta.description}`)

	// === Nested Operators ===
	console.log("\n=== Nested Operators ===")

	// $increment on a nested field
	const incremented = await db.books.update("b2", {
		metadata: { views: { $increment: 100 } },
	}).runPromise
	const incMeta = incremented.metadata as Record<string, unknown>
	console.log(`$increment views by 100: ${incMeta.views}`) // 900

	// Update multiple nested paths at once
	const multi = await db.books.update("b3", {
		metadata: { rating: 5, views: { $increment: 200 } },
		author: { country: "US" },
	}).runPromise
	const multiMeta = multi.metadata as Record<string, unknown>
	const multiAuthor = multi.author as Record<string, unknown>
	console.log(`Multi-path update — views: ${multiMeta.views}, rating: ${multiMeta.rating}, country: ${multiAuthor.country}`)

	// === Aggregation on Nested Fields ===
	console.log("\n=== Aggregation on Nested Fields ===")

	// Sum and average nested fields
	const stats = await db.books.aggregate({
		count: true,
		sum: "metadata.views",
		avg: "metadata.rating",
	}).runPromise
	console.log(`Total books: ${stats.count}`)
	console.log(`Total views: ${(stats as Record<string, Record<string, unknown>>).sum["metadata.views"]}`)
	console.log(`Avg rating: ${(stats as Record<string, Record<string, unknown>>).avg["metadata.rating"]}`)

	// Group by nested field
	const byCountry = await db.books.aggregate({
		groupBy: "author.country",
		count: true,
	}).runPromise
	console.log("\nBooks by country:")
	for (const entry of byCountry as ReadonlyArray<GroupResult>) {
		console.log(`  ${entry.group["author.country"]}: ${entry.count}`)
	}
}

main().catch(console.error)
