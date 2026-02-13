/**
 * Full-Text Search Example
 *
 * Demonstrates field-level $search, multi-field search across columns,
 * all-fields search, and searchIndex configuration for performance.
 */

import { createEffectDatabase } from "@proseql/core";
import { Effect, Schema } from "effect";

// ============================================================================
// 1. Schema
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	description: Schema.String,
});

// ============================================================================
// 2. Seed Data
// ============================================================================

const books = [
	{
		id: "1",
		title: "Dune",
		author: "Frank Herbert",
		year: 1965,
		description: "A desert planet story about spice and sandworms",
	},
	{
		id: "2",
		title: "Neuromancer",
		author: "William Gibson",
		year: 1984,
		description: "The sky above the port was the color of television",
	},
	{
		id: "3",
		title: "The Left Hand of Darkness",
		author: "Ursula K. Le Guin",
		year: 1969,
		description: "A story exploring gender and society on a winter planet",
	},
	{
		id: "4",
		title: "Foundation",
		author: "Isaac Asimov",
		year: 1951,
		description: "Psychohistory and the fall of a galactic empire",
	},
	{
		id: "5",
		title: "Snow Crash",
		author: "Neal Stephenson",
		year: 1992,
		description: "Virtual reality and pizza delivery in a cyberpunk future",
	},
];

// ============================================================================
// 3. Examples
// ============================================================================

async function main() {
	// === Without Search Index (scans all entities) ===
	console.log("=== Field-Level Search ===");

	const db = await Effect.runPromise(
		createEffectDatabase(
			{ books: { schema: BookSchema, relationships: {} } },
			{ books },
		),
	);

	// Search a single field
	const duneResults = await db.books.query({
		where: { title: { $search: "dune" } },
	}).runPromise;
	console.log(
		`title $search "dune": ${duneResults.length} result — ${duneResults[0]?.title}`,
	);

	// Multi-term search — all terms must match
	const leftHand = await db.books.query({
		where: { title: { $search: "left hand darkness" } },
	}).runPromise;
	console.log(
		`title $search "left hand darkness": ${leftHand.length} result — ${leftHand[0]?.title}`,
	);

	// === Multi-Field Search ===
	console.log("\n=== Multi-Field Search ===");

	// Terms can span across fields — "herbert" is in author, "dune" is in title
	const multiField = await db.books.query({
		where: {
			$search: { query: "herbert dune", fields: ["title", "author"] },
		},
	}).runPromise;
	console.log(
		`$search "herbert dune" across [title, author]: ${multiField.length} result — ${multiField[0]?.title}`,
	);

	// === All-Fields Search ===
	console.log("\n=== All-Fields Search (no fields specified) ===");

	// Search all string fields when fields is omitted
	const allFields = await db.books.query({
		where: { $search: { query: "cyberpunk" } },
	}).runPromise;
	console.log(
		`$search "cyberpunk" (all fields): ${allFields.length} result — ${allFields[0]?.title}`,
	);

	// Description field is also searched
	const desertSearch = await db.books.query({
		where: { $search: { query: "desert planet" } },
	}).runPromise;
	console.log(
		`$search "desert planet" (all fields): ${desertSearch.length} result — ${desertSearch[0]?.title}`,
	);

	// === With Search Index (faster for large collections) ===
	console.log("\n=== With Search Index ===");

	const dbIndexed = await Effect.runPromise(
		createEffectDatabase(
			{
				books: {
					schema: BookSchema,
					relationships: {},
					searchIndex: ["title", "author", "description"] as const,
				},
			},
			{ books },
		),
	);

	// Same queries, but backed by inverted index for O(tokens) lookup
	const indexed = await dbIndexed.books.query({
		where: { title: { $search: "foundation" } },
	}).runPromise;
	console.log(
		`Indexed search "foundation": ${indexed.length} result — ${indexed[0]?.title}`,
	);

	const indexedMulti = await dbIndexed.books.query({
		where: {
			$search: { query: "gibson neuromancer", fields: ["title", "author"] },
		},
	}).runPromise;
	console.log(
		`Indexed multi-field "gibson neuromancer": ${indexedMulti.length} result — ${indexedMulti[0]?.title}`,
	);
}

main().catch(console.error);
