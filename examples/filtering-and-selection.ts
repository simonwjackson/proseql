/**
 * Filtering and Selection Example
 *
 * Demonstrates all query operators using the database API: comparison,
 * string matching, set operators, array operators, logical operators,
 * field selection, and multi-field sorting.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.String,
	inStock: Schema.Boolean,
	tags: Schema.Array(Schema.String),
	description: Schema.String,
})

// ============================================================================
// 2. Config and Seed Data
// ============================================================================

const config = {
	products: {
		schema: ProductSchema,
		relationships: {},
	},
} as const

const initialData = {
	products: [
		{ id: "p1", name: "Mechanical Keyboard", price: 149, category: "electronics", inStock: true, tags: ["typing", "ergonomic", "usb"], description: "Cherry MX switches with backlight" },
		{ id: "p2", name: "Wireless Mouse", price: 59, category: "electronics", inStock: true, tags: ["wireless", "ergonomic"], description: "Bluetooth mouse with silent clicks" },
		{ id: "p3", name: "USB-C Hub", price: 39, category: "electronics", inStock: false, tags: ["usb", "portable"], description: "7-in-1 hub with HDMI output" },
		{ id: "p4", name: "Standing Desk", price: 599, category: "furniture", inStock: true, tags: ["ergonomic", "adjustable"], description: "Electric sit-stand desk" },
		{ id: "p5", name: "Monitor Arm", price: 89, category: "furniture", inStock: true, tags: ["ergonomic", "adjustable"], description: "Single monitor mount with gas spring" },
		{ id: "p6", name: "Desk Pad", price: 25, category: "accessories", inStock: true, tags: ["leather", "portable"], description: "Large leather desk mat" },
		{ id: "p7", name: "Webcam", price: 79, category: "electronics", inStock: false, tags: ["usb", "streaming"], description: "1080p webcam with microphone" },
	],
}

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// === Comparison Operators ===
	console.log("=== Comparison Operators ===")

	// $eq (implicit — just pass a value)
	const electronics = await db.products.query({
		where: { category: "electronics" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`category = "electronics": ${electronics.length} results`)

	// $ne
	const notElectronics = await db.products.query({
		where: { category: { $ne: "electronics" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`category != "electronics": ${notElectronics.length} results`)

	// $gt, $gte, $lt, $lte
	const midRange = await db.products.query({
		where: { price: { $gte: 50, $lt: 200 } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`price >= 50 and < 200: ${midRange.length} results`)

	// === String Operators ===
	console.log("\n=== String Operators ===")

	const startsWithW = await db.products.query({
		where: { name: { $startsWith: "W" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`name starts with "W": ${startsWithW.length} results`)

	const endsWithArm = await db.products.query({
		where: { name: { $endsWith: "Arm" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`name ends with "Arm": ${endsWithArm.length} results`)

	const containsDesk = await db.products.query({
		where: { name: { $contains: "Desk" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`name contains "Desk": ${containsDesk.length} results`)

	// === Set Operators ===
	console.log("\n=== Set Operators ===")

	const inCategories = await db.products.query({
		where: { category: { $in: ["electronics", "accessories"] } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`category in [electronics, accessories]: ${inCategories.length} results`)

	const notInCategories = await db.products.query({
		where: { category: { $nin: ["furniture"] } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`category not in [furniture]: ${notInCategories.length} results`)

	// === Array Operators ===
	console.log("\n=== Array Operators ===")

	const hasErgo = await db.products.query({
		where: { tags: { $contains: "ergonomic" } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`tags contains "ergonomic": ${hasErgo.length} results`)

	const hasAllTags = await db.products.query({
		where: { tags: { $all: ["ergonomic", "adjustable"] } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`tags has all [ergonomic, adjustable]: ${hasAllTags.length} results`)

	const exactTagCount = await db.products.query({
		where: { tags: { $size: 2 } },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`tags size = 2: ${exactTagCount.length} results`)

	// === Logical Operators ===
	console.log("\n=== Logical Operators ===")

	// $or
	const cheapOrFurniture = await db.products.query({
		where: {
			$or: [
				{ price: { $lt: 50 } },
				{ category: "furniture" },
			],
		},
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`price < 50 OR furniture: ${cheapOrFurniture.length} results`)

	// $and (explicit)
	const expensiveAndInStock = await db.products.query({
		where: {
			$and: [
				{ price: { $gte: 100 } },
				{ inStock: true },
			],
		},
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`price >= 100 AND in stock: ${expensiveAndInStock.length} results`)

	// $not
	const notAccessories = await db.products.query({
		where: {
			$not: { category: "accessories" },
		},
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`NOT accessories: ${notAccessories.length} results`)

	// nested logical: (electronics OR furniture) AND in stock
	const nested = await db.products.query({
		where: {
			$and: [
				{ $or: [{ category: "electronics" }, { category: "furniture" }] },
				{ inStock: true },
			],
		},
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`(electronics OR furniture) AND in stock: ${nested.length} results`)

	// === Field Selection ===
	console.log("\n=== Field Selection ===")

	const nameAndPrice = await db.products.query({
		select: ["name", "price"],
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log("Selected fields:", JSON.stringify(nameAndPrice[0]))

	// === Multi-Field Sorting ===
	console.log("\n=== Multi-Field Sorting ===")

	const sorted = await db.products.query({
		sort: { category: "asc", price: "desc" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log("Sorted by category asc, price desc:")
	for (const p of sorted) {
		console.log(`  ${p.category} — $${p.price} — ${p.name}`)
	}
}

main().catch(console.error)
