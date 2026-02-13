/**
 * Aggregation Example
 *
 * Demonstrates scalar aggregation (count, sum, min, max, avg),
 * filtered aggregation with where, and groupBy.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import type { GroupResult } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const OrderSchema = Schema.Struct({
	id: Schema.String,
	product: Schema.String,
	category: Schema.String,
	quantity: Schema.Number,
	price: Schema.Number,
	status: Schema.String,
})

// ============================================================================
// 2. Config and Seed Data
// ============================================================================

const config = {
	orders: {
		schema: OrderSchema,
		relationships: {},
	},
} as const

const initialData = {
	orders: [
		{ id: "o1", product: "Keyboard", category: "electronics", quantity: 2, price: 149, status: "shipped" },
		{ id: "o2", product: "Mouse", category: "electronics", quantity: 5, price: 59, status: "shipped" },
		{ id: "o3", product: "Desk", category: "furniture", quantity: 1, price: 599, status: "delivered" },
		{ id: "o4", product: "Chair", category: "furniture", quantity: 1, price: 449, status: "shipped" },
		{ id: "o5", product: "Monitor", category: "electronics", quantity: 3, price: 399, status: "delivered" },
		{ id: "o6", product: "Headphones", category: "electronics", quantity: 4, price: 79, status: "pending" },
		{ id: "o7", product: "Lamp", category: "furniture", quantity: 2, price: 89, status: "delivered" },
	],
}

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// === Scalar Aggregation ===
	console.log("=== Scalar Aggregation ===")

	const stats = await db.orders.aggregate({
		count: true,
		sum: "price",
		min: "price",
		max: "price",
		avg: "price",
	}).runPromise

	console.log(`Total orders: ${stats.count}`)
	console.log(`Sum of prices: $${(stats as Record<string, Record<string, number>>).sum.price}`)
	console.log(`Min price: $${(stats as Record<string, Record<string, number>>).min.price}`)
	console.log(`Max price: $${(stats as Record<string, Record<string, number>>).max.price}`)
	console.log(`Avg price: $${(stats as Record<string, Record<string, number>>).avg.price}`)

	// === Filtered Aggregation ===
	console.log("\n=== Filtered Aggregation ===")

	const delivered = await db.orders.aggregate({
		where: { status: "delivered" },
		count: true,
		sum: "price",
	}).runPromise
	console.log(`Delivered orders: ${delivered.count}`)
	console.log(`Delivered total: $${(delivered as Record<string, Record<string, number>>).sum.price}`)

	// === GroupBy ===
	console.log("\n=== GroupBy Category ===")

	const byCategory = await db.orders.aggregate({
		groupBy: "category",
		count: true,
	}).runPromise

	for (const entry of byCategory as ReadonlyArray<GroupResult>) {
		console.log(`  ${entry.group.category}: ${entry.count} orders`)
	}

	// === GroupBy with Aggregation ===
	console.log("\n=== GroupBy Status with Sum ===")

	const byStatus = await db.orders.aggregate({
		groupBy: "status",
		count: true,
		sum: "price",
		avg: "quantity",
	}).runPromise

	for (const entry of byStatus as ReadonlyArray<GroupResult>) {
		const sum = entry.sum as Record<string, number>
		const avg = entry.avg as Record<string, number>
		console.log(`  ${entry.group.status}: ${entry.count} orders, total $${sum.price}, avg qty ${avg.quantity}`)
	}
}

main().catch(console.error)
