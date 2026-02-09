/**
 * Demo of array operators in Database v2
 * Shows how to use $contains, $all, and $size operators with arrays
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types";

// Schema with array fields
const ProductSchema = z.object({
	id: z.string(),
	name: z.string(),
	tags: z.array(z.string()),
	categories: z.array(z.string()),
	features: z.array(z.string()),
});

const dbConfig = {
	products: {
		schema: ProductSchema,
		relationships: {},
	},
} as const;

const data: DatasetFor<typeof dbConfig> = {
	products: [
		{
			id: "p1",
			name: "Gaming Laptop",
			tags: ["gaming", "laptop", "portable", "high-performance"],
			categories: ["electronics", "computers", "gaming"],
			features: ["RGB keyboard", "144Hz display", "RTX graphics"],
		},
		{
			id: "p2",
			name: "Office Laptop",
			tags: ["office", "laptop", "business", "portable"],
			categories: ["electronics", "computers", "business"],
			features: ["lightweight", "long battery", "fingerprint reader"],
		},
		{
			id: "p3",
			name: "Gaming Desktop",
			tags: ["gaming", "desktop", "high-performance", "customizable"],
			categories: ["electronics", "computers", "gaming"],
			features: ["liquid cooling", "RTX graphics", "expandable"],
		},
	],
};

async function demonstrateArrayOperators() {
	const db = createDatabase(dbConfig, data);

	console.log("=== Array Operator Examples ===\n");

	// Example 1: $contains - find products with a specific tag
	console.log("1. Products with 'gaming' tag:");
	const gamingProducts = await collect(
		db.products.query({
			where: {
				tags: { $contains: "gaming" },
			},
		}),
	);
	gamingProducts.forEach((product) => {
		console.log(`   ${product.name} - Tags: [${product.tags.join(", ")}]`);
	});

	// Example 2: $all - find products with ALL specified tags
	console.log("\n2. Products with both 'gaming' AND 'portable' tags:");
	const gamingPortable = await collect(
		db.products.query({
			where: {
				tags: { $all: ["gaming", "portable"] },
			},
		}),
	);
	gamingPortable.forEach((product) => {
		console.log(`   ${product.name}`);
	});

	// Example 3: $size - find products with exactly 3 categories
	console.log("\n3. Products with exactly 3 categories:");
	const threeCategories = await collect(
		db.products.query({
			where: {
				categories: { $size: 3 },
			},
		}),
	);
	threeCategories.forEach((product) => {
		console.log(
			`   ${product.name} - Categories: [${product.categories.join(", ")}]`,
		);
	});

	// Example 4: Combining array operators with other filters
	console.log("\n4. Gaming products with RTX graphics:");
	const rtxGaming = await collect(
		db.products.query({
			where: {
				tags: { $contains: "gaming" },
				features: { $contains: "RTX graphics" },
			},
		}),
	);
	rtxGaming.forEach((product) => {
		console.log(`   ${product.name}`);
	});

	// Example 5: Multiple conditions on the same array
	console.log("\n5. Products in 'electronics' and 'computers' categories:");
	const electronicsComputers = await collect(
		db.products.query({
			where: {
				categories: { $all: ["electronics", "computers"] },
			},
		}),
	);
	console.log(`   Found ${electronicsComputers.length} products`);

	// Type safety demonstration:
	// The following would cause TypeScript errors:
	// db.products.query({ where: { tags: { $contains: 123 } } }); // Error: number not assignable to string
	// db.products.query({ where: { name: { $contains: "laptop" } } }); // This is valid - string $contains for string field
	// db.products.query({ where: { tags: { $gt: 5 } } }); // Error: $gt not available for arrays
}

demonstrateArrayOperators().catch(console.error);
