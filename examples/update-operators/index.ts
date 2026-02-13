/**
 * Update Operators Example
 *
 * Demonstrates atomic, type-safe mutation operators: $increment, $decrement,
 * $multiply, $append, $prepend, $remove, $toggle, and $set.
 */

import { createEffectDatabase } from "@proseql/core";
import { Effect, Schema } from "effect";

// ============================================================================
// 1. Schema
// ============================================================================

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	quantity: Schema.Number,
	featured: Schema.Boolean,
	tags: Schema.mutable(Schema.Array(Schema.String)),
	description: Schema.String,
});

// ============================================================================
// 2. Config and Seed Data
// ============================================================================

const config = {
	products: {
		schema: ProductSchema,
		relationships: {},
	},
} as const;

const initialData = {
	products: [
		{
			id: "p1",
			name: "Mechanical Keyboard",
			price: 149,
			quantity: 50,
			featured: false,
			tags: ["electronics", "typing"],
			description: "Cherry MX switches",
		},
	],
};

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData));

	// === Number Operators ===
	console.log("=== Number Operators ===");

	// $increment
	const inc = await db.products.update("p1", {
		quantity: { $increment: 10 },
	}).runPromise;
	console.log(`$increment quantity by 10: ${inc.quantity}`); // 60

	// $decrement
	const dec = await db.products.update("p1", {
		quantity: { $decrement: 5 },
	}).runPromise;
	console.log(`$decrement quantity by 5: ${dec.quantity}`); // 55

	// $multiply
	const mul = await db.products.update("p1", {
		price: { $multiply: 2 },
	}).runPromise;
	console.log(`$multiply price by 2: ${mul.price}`); // 298

	// === String Operators ===
	console.log("\n=== String Operators ===");

	// $append to string
	const appStr = await db.products.update("p1", {
		name: { $append: " (RGB)" },
	}).runPromise;
	console.log(`$append to name: "${appStr.name}"`); // "Mechanical Keyboard (RGB)"

	// $prepend to string
	const preStr = await db.products.update("p1", {
		description: { $prepend: "Premium " },
	}).runPromise;
	console.log(`$prepend to description: "${preStr.description}"`); // "Premium Cherry MX switches"

	// === Array Operators ===
	console.log("\n=== Array Operators ===");

	// $append to array
	const appArr = await db.products.update("p1", {
		tags: { $append: "mechanical" },
	}).runPromise;
	console.log(`$append to tags: [${appArr.tags.join(", ")}]`);

	// $prepend to array
	const preArr = await db.products.update("p1", {
		tags: { $prepend: "featured" },
	}).runPromise;
	console.log(`$prepend to tags: [${preArr.tags.join(", ")}]`);

	// $remove from array
	const remArr = await db.products.update("p1", {
		tags: { $remove: "typing" },
	}).runPromise;
	console.log(`$remove "typing" from tags: [${remArr.tags.join(", ")}]`);

	// === Boolean Operators ===
	console.log("\n=== Boolean Operators ===");

	// $toggle
	const toggled = await db.products.update("p1", {
		featured: { $toggle: true },
	}).runPromise;
	console.log(`$toggle featured: ${toggled.featured}`); // true

	const toggledBack = await db.products.update("p1", {
		featured: { $toggle: true },
	}).runPromise;
	console.log(`$toggle again: ${toggledBack.featured}`); // false

	// === Explicit $set ===
	console.log("\n=== Explicit $set ===");

	const setResult = await db.products.update("p1", {
		name: { $set: "Premium Keyboard" },
	}).runPromise;
	console.log(`$set name: "${setResult.name}"`);

	// === Combining Multiple Operators ===
	console.log("\n=== Combining Multiple Operators ===");

	const combined = await db.products.update("p1", {
		price: { $decrement: 50 },
		quantity: { $increment: 100 },
		featured: { $toggle: true },
		tags: { $append: "sale" },
	}).runPromise;
	console.log("Combined update:");
	console.log(`  price: ${combined.price}`);
	console.log(`  quantity: ${combined.quantity}`);
	console.log(`  featured: ${combined.featured}`);
	console.log(`  tags: [${combined.tags.join(", ")}]`);
}

main().catch(console.error);
