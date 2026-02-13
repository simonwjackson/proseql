/**
 * Prose Format Example
 *
 * Demonstrates the prose file format — data that reads like English.
 * Shows self-describing .prose files with @prose directives, template-less
 * codec initialization, explicit templates, and format overrides.
 */

import { createNodeDatabase } from "@proseql/node";
import { Effect, Schema } from "effect";

// ============================================================================
// 1. Schema
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});

const QuoteSchema = Schema.Struct({
	id: Schema.String,
	text: Schema.String,
	author: Schema.String,
});

// ============================================================================
// 2. Config — prose file + format override for a .md file
// ============================================================================

const config = {
	books: {
		schema: BookSchema,
		file: "./examples/13-prose-format/data/books.prose",
		relationships: {},
	},
	quotes: {
		schema: QuoteSchema,
		file: "./examples/13-prose-format/data/quotes.md",
		format: "prose", // ← use prose codec, not markdown
		relationships: {},
	},
} as const;

// ============================================================================
// 3. Main — uses createNodeDatabase() for zero-config setup
// ============================================================================

const program = Effect.gen(function* () {
	// createNodeDatabase infers the prose codec from the .prose extension.
	// The codec learns the template from the file's @prose directive on load.
	const db = yield* createNodeDatabase(config);

	// === Read existing prose data ===
	console.log("=== Books loaded from .prose file ===");
	const books = yield* Effect.promise(
		() => db.books.query({ sort: { year: "asc" } }).runPromise,
	);
	for (const b of books) {
		console.log(
			`  [${b.id}] "${b.title}" by ${b.author} (${b.year}) — ${b.genre}`,
		);
	}

	// === Add a new book ===
	const newBook = yield* db.books.create({
		title: "Snow Crash",
		author: "Neal Stephenson",
		year: 1992,
		genre: "sci-fi",
	});
	console.log(`\nCreated: [${newBook.id}] "${newBook.title}"`);

	// === Query ===
	const pre1970 = yield* Effect.promise(
		() => db.books.query({ where: { year: { $lt: 1970 } } }).runPromise,
	);
	console.log(`\nBooks before 1970: ${pre1970.length}`);
	for (const b of pre1970) {
		console.log(`  "${b.title}" (${b.year})`);
	}

	// ============================================================================
	// Format Override — prose data inside a .md file
	// ============================================================================
	// The quotes collection uses format: "prose" to override the .md extension.
	// The @prose directive inside the file tells the codec how to parse it.

	console.log("\n=== Quotes loaded from .md file (format override) ===");
	const quotes = yield* Effect.promise(() => db.quotes.query().runPromise);
	for (const q of quotes) {
		console.log(`  [${q.id}] "${q.text}" — ${q.author}`);
	}

	// === Flush to see the file updates ===
	yield* Effect.promise(() => db.flush());
	console.log("\nFlushed — open the data files to see the result");

	// ============================================================================
	// Explicit Template (alternative)
	// ============================================================================
	// If you prefer to specify the template in code rather than in the file:
	//
	// const explicitCodec = proseCodec({
	//   template: '[{id}] "{title}" by {author} ({year}) — {genre}',
	// })
	//
	// This is useful when the .prose file doesn't have a @prose directive,
	// or when you want to override the file's template.
});

Effect.runPromise(Effect.scoped(program)).catch(console.error);
