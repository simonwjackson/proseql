/**
 * Cursor Pagination Example
 *
 * Demonstrates offset-based (recap) and cursor-based pagination
 * with pageInfo.endCursor and hasNextPage.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import type { CursorPageResult } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const ItemSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.String,
})

// ============================================================================
// 2. Config and Seed Data
// ============================================================================

const config = {
	items: {
		schema: ItemSchema,
		relationships: {},
	},
} as const

const initialData = {
	items: [
		{ id: "i01", name: "Alpha", price: 10, category: "a" },
		{ id: "i02", name: "Bravo", price: 20, category: "b" },
		{ id: "i03", name: "Charlie", price: 30, category: "a" },
		{ id: "i04", name: "Delta", price: 40, category: "b" },
		{ id: "i05", name: "Echo", price: 50, category: "a" },
		{ id: "i06", name: "Foxtrot", price: 60, category: "b" },
		{ id: "i07", name: "Golf", price: 70, category: "a" },
		{ id: "i08", name: "Hotel", price: 80, category: "b" },
		{ id: "i09", name: "India", price: 90, category: "a" },
		{ id: "i10", name: "Juliet", price: 100, category: "b" },
	],
}

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// === Offset-Based Pagination (recap) ===
	console.log("=== Offset-Based Pagination ===")

	const page1Offset = await db.items.query({
		sort: { name: "asc" },
		limit: 3,
		offset: 0,
	}).runPromise
	console.log(`Page 1: ${page1Offset.map((i) => i.name).join(", ")}`)

	const page2Offset = await db.items.query({
		sort: { name: "asc" },
		limit: 3,
		offset: 3,
	}).runPromise
	console.log(`Page 2: ${page2Offset.map((i) => i.name).join(", ")}`)

	// === Cursor-Based Pagination ===
	console.log("\n=== Cursor-Based Pagination ===")

	// Helper to cast cursor query results (query returns a union type)
	type CursorResult = CursorPageResult<Record<string, unknown>>

	// First page — no "after" cursor
	const page1 = await db.items.query({
		sort: { name: "asc" },
		cursor: { key: "name", limit: 3 },
	}).runPromise as unknown as CursorResult
	console.log(`Page 1: ${page1.items.map((i) => i.name).join(", ")}`)
	console.log(`  endCursor: ${page1.pageInfo.endCursor}`)
	console.log(`  hasNextPage: ${page1.pageInfo.hasNextPage}`)

	// Second page — pass the endCursor from page 1
	const page2 = await db.items.query({
		sort: { name: "asc" },
		cursor: { key: "name", after: page1.pageInfo.endCursor as string, limit: 3 },
	}).runPromise as unknown as CursorResult
	console.log(`\nPage 2: ${page2.items.map((i) => i.name).join(", ")}`)
	console.log(`  endCursor: ${page2.pageInfo.endCursor}`)
	console.log(`  hasNextPage: ${page2.pageInfo.hasNextPage}`)

	// Third page
	const page3 = await db.items.query({
		sort: { name: "asc" },
		cursor: { key: "name", after: page2.pageInfo.endCursor as string, limit: 3 },
	}).runPromise as unknown as CursorResult
	console.log(`\nPage 3: ${page3.items.map((i) => i.name).join(", ")}`)
	console.log(`  endCursor: ${page3.pageInfo.endCursor}`)
	console.log(`  hasNextPage: ${page3.pageInfo.hasNextPage}`)

	// Last page (only 1 item left)
	const page4 = await db.items.query({
		sort: { name: "asc" },
		cursor: { key: "name", after: page3.pageInfo.endCursor as string, limit: 3 },
	}).runPromise as unknown as CursorResult
	console.log(`\nPage 4: ${page4.items.map((i) => i.name).join(", ")}`)
	console.log(`  hasNextPage: ${page4.pageInfo.hasNextPage}`)

	// === Cursor with Filter ===
	console.log("\n=== Cursor with Filter ===")

	const filtered = await db.items.query({
		where: { category: "a" },
		sort: { name: "asc" },
		cursor: { key: "name", limit: 3 },
	}).runPromise as unknown as CursorResult
	console.log(`Category "a" page 1: ${filtered.items.map((i) => i.name).join(", ")}`)
	console.log(`  hasNextPage: ${filtered.pageInfo.hasNextPage}`)
}

main().catch(console.error)
