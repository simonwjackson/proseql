/**
 * File Persistence Example
 *
 * A bookshelf tracker that persists each collection to a different file format.
 * Run it twice — the second run loads existing data from the files.
 *
 * Usage:
 *   bun run examples/12-file-persistence/index.ts
 */

import {
	createPersistentEffectDatabase,
	makeNodePersistenceLayer,
} from "@proseql/node";
import { Chunk, Effect, Schema, Stream } from "effect";

// ============================================================================
// Schemas
// ============================================================================

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	born: Schema.Number,
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	authorId: Schema.String,
	year: Schema.Number,
	genreId: Schema.String,
});

const GenreSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
});

const PublisherSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	founded: Schema.Number,
});

const ReviewSchema = Schema.Struct({
	id: Schema.String,
	bookId: Schema.String,
	rating: Schema.Number,
	text: Schema.String,
});

const SeriesSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	authorId: Schema.String,
});

const TagSchema = Schema.Struct({
	id: Schema.String,
	bookId: Schema.String,
	label: Schema.String,
});

const ReadingLogSchema = Schema.Struct({
	id: Schema.String,
	bookId: Schema.String,
	date: Schema.String,
	pagesRead: Schema.Number,
});

const QuoteSchema = Schema.Struct({
	id: Schema.String,
	bookId: Schema.String,
	text: Schema.String,
	page: Schema.Number,
});

// ============================================================================
// Config — each collection persists to a different format
// ============================================================================

const dir = "./examples/data";

const config = {
	authors: {
		schema: AuthorSchema,
		file: `${dir}/authors.yaml`,
		relationships: {
			books: {
				type: "inverse" as const,
				target: "books" as const,
				foreignKey: "authorId",
			},
		},
	},
	books: {
		schema: BookSchema,
		file: `${dir}/books.json`,
		relationships: {
			author: {
				type: "ref" as const,
				target: "authors" as const,
				foreignKey: "authorId",
			},
			genre: {
				type: "ref" as const,
				target: "genres" as const,
				foreignKey: "genreId",
			},
			reviews: {
				type: "inverse" as const,
				target: "reviews" as const,
				foreignKey: "bookId",
			},
			tags: {
				type: "inverse" as const,
				target: "tags" as const,
				foreignKey: "bookId",
			},
		},
	},
	genres: {
		schema: GenreSchema,
		file: `${dir}/genres.json5`,
		relationships: {},
	},
	publishers: {
		schema: PublisherSchema,
		file: `${dir}/publishers.toml`,
		relationships: {},
	},
	reviews: {
		schema: ReviewSchema,
		file: `${dir}/reviews.jsonc`,
		relationships: {
			book: {
				type: "ref" as const,
				target: "books" as const,
				foreignKey: "bookId",
			},
		},
	},
	series: {
		schema: SeriesSchema,
		file: `${dir}/series.hjson`,
		relationships: {
			author: {
				type: "ref" as const,
				target: "authors" as const,
				foreignKey: "authorId",
			},
		},
	},
	tags: {
		schema: TagSchema,
		file: `${dir}/tags.toon`,
		relationships: {
			book: {
				type: "ref" as const,
				target: "books" as const,
				foreignKey: "bookId",
			},
		},
	},
	readingLog: {
		schema: ReadingLogSchema,
		file: `${dir}/reading-log.jsonl`,
		relationships: {
			book: {
				type: "ref" as const,
				target: "books" as const,
				foreignKey: "bookId",
			},
		},
	},
	quotes: {
		schema: QuoteSchema,
		file: `${dir}/quotes.prose`,
		relationships: {
			book: {
				type: "ref" as const,
				target: "books" as const,
				foreignKey: "bookId",
			},
		},
	},
} as const;

// Helper: collect a query stream into an array
const collect = <A, E>(stream: Stream.Stream<A, E, never>) =>
	Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray));

// ============================================================================
// Layer — auto-inferred from config file extensions (handles all 9 formats)
// ============================================================================

const PersistenceLayer = makeNodePersistenceLayer(config);

// ============================================================================
// Main
// ============================================================================

const program = Effect.gen(function* () {
	const db = yield* createPersistentEffectDatabase(config, undefined, {
		writeDebounce: 10,
	});

	// Check if data already exists from a previous run
	const existingAuthors = yield* collect(db.authors.query());

	if (existingAuthors.length > 0) {
		console.log("Found existing data from a previous run!\n");
	} else {
		console.log("First run — seeding data...\n");

		// Genres (.json5)
		const scifi = yield* db.genres.create({
			id: "sci-fi",
			name: "Science Fiction",
			description: "Speculative worlds and futures",
		});
		const cyber = yield* db.genres.create({
			id: "cyberpunk",
			name: "Cyberpunk",
			description: "High tech, low life",
		});

		// Publishers (.toml)
		yield* db.publishers.create({
			id: "ace",
			name: "Ace Books",
			founded: 1952,
		});
		yield* db.publishers.create({
			id: "harper",
			name: "Harper Voyager",
			founded: 1817,
		});

		// Authors (.yaml)
		const herbert = yield* db.authors.create({
			name: "Frank Herbert",
			born: 1920,
		});
		const leguin = yield* db.authors.create({
			name: "Ursula K. Le Guin",
			born: 1929,
		});
		const gibson = yield* db.authors.create({
			name: "William Gibson",
			born: 1948,
		});

		// Series (.hjson)
		yield* db.series.create({ name: "Dune Chronicles", authorId: herbert.id });
		yield* db.series.create({ name: "Sprawl Trilogy", authorId: gibson.id });

		// Books (.json)
		const dune = yield* db.books.create({
			title: "Dune",
			authorId: herbert.id,
			year: 1965,
			genreId: scifi.id,
		});
		const leftHand = yield* db.books.create({
			title: "The Left Hand of Darkness",
			authorId: leguin.id,
			year: 1969,
			genreId: scifi.id,
		});
		const neuro = yield* db.books.create({
			title: "Neuromancer",
			authorId: gibson.id,
			year: 1984,
			genreId: cyber.id,
		});
		const countZero = yield* db.books.create({
			title: "Count Zero",
			authorId: gibson.id,
			year: 1986,
			genreId: cyber.id,
		});

		// Reviews (.jsonc)
		yield* db.reviews.create({
			bookId: dune.id,
			rating: 5,
			text: "The spice must flow",
		});
		yield* db.reviews.create({
			bookId: dune.id,
			rating: 4,
			text: "Dense but rewarding",
		});
		yield* db.reviews.create({
			bookId: neuro.id,
			rating: 5,
			text: "Invented the genre",
		});
		yield* db.reviews.create({
			bookId: leftHand.id,
			rating: 5,
			text: "Masterpiece of imagination",
		});

		// Tags (.toon)
		yield* db.tags.create({ bookId: dune.id, label: "desert" });
		yield* db.tags.create({ bookId: dune.id, label: "politics" });
		yield* db.tags.create({ bookId: neuro.id, label: "hacking" });
		yield* db.tags.create({ bookId: countZero.id, label: "hacking" });
		yield* db.tags.create({ bookId: leftHand.id, label: "gender" });

		// Reading log (.jsonl)
		yield* db.readingLog.create({
			bookId: dune.id,
			date: "2024-01-15",
			pagesRead: 50,
		});
		yield* db.readingLog.create({
			bookId: dune.id,
			date: "2024-01-16",
			pagesRead: 75,
		});
		yield* db.readingLog.create({
			bookId: neuro.id,
			date: "2024-01-17",
			pagesRead: 120,
		});

		// Quotes (.prose)
		yield* db.quotes.create({
			bookId: dune.id,
			text: "The spice must flow",
			page: 42,
		});
		yield* db.quotes.create({
			bookId: neuro.id,
			text: "The sky above the port was the color of television",
			page: 1,
		});
	}

	// ── Queries ──────────────────────────────────────────────────────────

	// Books with their author populated
	console.log("Books with authors:");
	const books = yield* collect(
		db.books.query({
			populate: { author: true },
			sort: { year: "asc" },
		}),
	);
	for (const b of books) {
		console.log(`  ${b.year} — "${b.title}" by ${b.author?.name}`);
	}

	// Reviews with book populated
	console.log("\nTop reviews:");
	const reviews = yield* collect(
		db.reviews.query({
			where: { rating: 5 },
			populate: { book: true },
		}),
	);
	for (const r of reviews) {
		console.log(`  ★★★★★ "${r.book?.title}" — ${r.text}`);
	}

	// Aggregation across formats
	const stats = yield* db.books.aggregate({ count: true });
	const tagStats = yield* db.tags.aggregate({ count: true });
	const reviewStats = yield* db.reviews.aggregate({ count: true });
	const logStats = yield* db.readingLog.aggregate({ count: true });
	const quoteStats = yield* db.quotes.aggregate({ count: true });
	console.log(
		`\n${stats.count} books, ${reviewStats.count} reviews, ${tagStats.count} tags, ${logStats.count} reading logs, ${quoteStats.count} quotes`,
	);

	// Flush writes to disk
	yield* Effect.promise(() => db.flush());

	console.log("\nData saved to 9 different formats:");
	console.log(`  ${dir}/authors.yaml      ← YAML`);
	console.log(`  ${dir}/books.json        ← JSON`);
	console.log(`  ${dir}/genres.json5      ← JSON5`);
	console.log(`  ${dir}/publishers.toml   ← TOML`);
	console.log(`  ${dir}/reviews.jsonc     ← JSONC`);
	console.log(`  ${dir}/series.hjson      ← Hjson`);
	console.log(`  ${dir}/tags.toon         ← TOON`);
	console.log(`  ${dir}/reading-log.jsonl ← JSONL`);
	console.log(`  ${dir}/quotes.prose      ← Prose`);
	console.log("\nOpen any of them — they're all plain text.");
});

// Run with persistence layer + scope for managed lifecycle
Effect.runPromise(
	program.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
).catch(console.error);
