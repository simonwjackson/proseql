/**
 * Advanced Features Example
 *
 * Combines 7 features in one file: ID Generation, Indexing, Unique
 * Constraints, Transactions, Schema Migrations, Plugin System, and
 * Foreign Key Enforcement.
 */

import type {
	CustomIdGenerator,
	CustomOperator,
	Migration,
	ProseQLPlugin,
} from "@proseql/core";
import {
	createEffectDatabase,
	ForeignKeyError,
	generateNanoId,
	generatePrefixedId,
	generateTimestampId,
	generateTypedId,
	generateULID,
	generateUUID,
	UniqueConstraintError,
} from "@proseql/core";
import { Effect, Schema } from "effect";

// ============================================================================
// 1. ID Generation
// ============================================================================

async function idGenerationExample() {
	console.log("=== ID Generation ===");
	console.log(`  UUID:        ${generateUUID()}`);
	console.log(`  NanoId:      ${generateNanoId()}`);
	console.log(`  ULID:        ${generateULID()}`);
	console.log(`  Timestamp:   ${generateTimestampId()}`);
	console.log(`  Prefixed:    ${generatePrefixedId("book")}`);
	console.log(`  Typed:       ${generateTypedId("book")}`);
}

// ============================================================================
// 2. Indexing
// ============================================================================

async function indexingExample() {
	console.log("\n=== Indexing ===");

	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		genre: Schema.String,
		year: Schema.Number,
		metadata: Schema.Struct({
			rating: Schema.Number,
		}),
	});

	const config = {
		books: {
			schema: BookSchema,
			// Single, compound, and nested field indexes
			indexes: ["genre", "metadata.rating", ["genre", "year"]] as const,
			relationships: {},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(config, {
			books: [
				{
					id: "b1",
					title: "Dune",
					genre: "sci-fi",
					year: 1965,
					metadata: { rating: 5 },
				},
				{
					id: "b2",
					title: "Neuromancer",
					genre: "sci-fi",
					year: 1984,
					metadata: { rating: 4 },
				},
				{
					id: "b3",
					title: "The Hobbit",
					genre: "fantasy",
					year: 1937,
					metadata: { rating: 5 },
				},
			],
		}),
	);

	// These queries hit the index for fast lookups
	const scifi = await db.books.query({
		where: { genre: "sci-fi" },
	}).runPromise;
	console.log(`  Indexed query (genre = "sci-fi"): ${scifi.length} results`);

	const scifi1984 = await db.books.query({
		where: { genre: "sci-fi", year: 1984 },
	}).runPromise;
	console.log(
		`  Compound index (genre + year): ${scifi1984.length} result — ${scifi1984[0]?.title}`,
	);

	const highRated = await db.books.query({
		where: { "metadata.rating": 5 },
	}).runPromise;
	console.log(
		`  Nested index (metadata.rating = 5): ${highRated.length} results`,
	);
}

// ============================================================================
// 3. Unique Constraints
// ============================================================================

async function uniqueConstraintsExample() {
	console.log("\n=== Unique Constraints ===");

	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		isbn: Schema.String,
	});

	const ReviewSchema = Schema.Struct({
		id: Schema.String,
		userId: Schema.String,
		bookId: Schema.String,
		rating: Schema.Number,
	});

	const config = {
		books: {
			schema: BookSchema,
			uniqueFields: ["isbn"] as const,
			relationships: {},
		},
		reviews: {
			schema: ReviewSchema,
			uniqueFields: [["userId", "bookId"]] as const,
			relationships: {},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(config, { books: [], reviews: [] }),
	);

	// First create succeeds
	await db.books.create({
		title: "Dune",
		isbn: "978-0441172719",
	}).runPromise;
	console.log('  Created "Dune" with ISBN 978-0441172719');

	// Duplicate ISBN fails
	try {
		await db.books.create({
			title: "Dune (duplicate)",
			isbn: "978-0441172719",
		}).runPromise;
	} catch (err) {
		if (err instanceof UniqueConstraintError) {
			console.log(`  UniqueConstraintError: ${err.message}`);
		}
	}

	// Compound unique — one review per user per book
	await db.reviews.create({ userId: "u1", bookId: "b1", rating: 5 }).runPromise;
	console.log("  Created review (u1, b1)");

	try {
		await db.reviews.create({ userId: "u1", bookId: "b1", rating: 3 })
			.runPromise;
	} catch (err) {
		if (err instanceof UniqueConstraintError) {
			console.log(`  Compound UniqueConstraintError: ${err.message}`);
		}
	}
}

// ============================================================================
// 4. Transactions
// ============================================================================

async function transactionsExample() {
	console.log("\n=== Transactions ===");

	const UserSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		email: Schema.String,
		age: Schema.Number,
	});

	const PostSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		content: Schema.String,
		authorId: Schema.String,
	});

	const config = {
		users: {
			schema: UserSchema,
			relationships: {},
		},
		posts: {
			schema: PostSchema,
			relationships: {},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(config, { users: [], posts: [] }),
	);

	// Successful transaction — all or nothing
	await db
		.$transaction((ctx) =>
			Effect.gen(function* () {
				const user = yield* ctx.users.create({
					name: "Alice",
					email: "alice@test.com",
					age: 30,
				});

				yield* ctx.posts.create({
					title: "Hello World",
					content: "First post",
					authorId: user.id,
				});
			}),
		)
		.pipe(Effect.runPromise);

	const users = await db.users.query().runPromise;
	const posts = await db.posts.query().runPromise;
	console.log(`  After commit: ${users.length} user, ${posts.length} post`);

	// Failed transaction — rolls back
	const result = await db
		.$transaction((ctx) =>
			Effect.gen(function* () {
				yield* ctx.users.create({
					name: "Bob",
					email: "bob@test.com",
					age: 25,
				});
				// Force a rollback
				return yield* Effect.fail(new Error("Something went wrong"));
			}),
		)
		.pipe(
			Effect.catchAll(() => Effect.succeed("rolled back")),
			Effect.runPromise,
		);
	console.log(`  Transaction failed: ${result}`);

	const usersAfter = await db.users.query().runPromise;
	console.log(`  After rollback: ${usersAfter.length} user (Bob not added)`);
}

// ============================================================================
// 5. Schema Migrations
// ============================================================================

async function migrationsExample() {
	console.log("\n=== Schema Migrations ===");

	const BookSchemaV3 = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		year: Schema.Number,
		genre: Schema.String,
		rating: Schema.Number,
	});

	const migrations: ReadonlyArray<Migration> = [
		{
			from: 0,
			to: 1,
			transform: (book: Record<string, unknown>) => ({
				...book,
				genre: (book.genre as string) ?? "uncategorized",
			}),
		},
		{
			from: 1,
			to: 2,
			transform: (book: Record<string, unknown>) => ({
				...book,
				rating: (book.rating as number) ?? 0,
			}),
		},
	];

	const config = {
		books: {
			schema: BookSchemaV3,
			version: 2,
			migrations,
			relationships: {},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(config, {
			books: [
				{
					id: "b1",
					title: "Dune",
					year: 1965,
					genre: "uncategorized",
					rating: 0,
				},
			],
		}),
	);

	const books = await db.books.query().runPromise;
	console.log(
		`  Migrated book: ${books[0]?.title}, genre: ${books[0]?.genre}, rating: ${books[0]?.rating}`,
	);
}

// ============================================================================
// 6. Plugin System
// ============================================================================

async function pluginExample() {
	console.log("\n=== Plugin System ===");

	// Custom $regex operator
	const regexOperator: CustomOperator = {
		name: "$regex",
		types: ["string"],
		evaluate: (value, pattern) =>
			typeof value === "string" && new RegExp(pattern as string).test(value),
	};

	// Counter-based ID generator for testing
	let counter = 0;
	const counterGenerator: CustomIdGenerator = {
		name: "counter",
		generate: () => `id-${++counter}`,
	};

	const regexPlugin: ProseQLPlugin = {
		name: "regex-search",
		operators: [regexOperator],
	};

	const idPlugin: ProseQLPlugin = {
		name: "counter-ids",
		idGenerators: [counterGenerator],
	};

	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		author: Schema.String,
		year: Schema.Number,
		genre: Schema.String,
	});

	const config = {
		books: {
			schema: BookSchema,
			relationships: {},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(
			config,
			{
				books: [
					{
						id: "b1",
						title: "The Great Gatsby",
						author: "F. Scott Fitzgerald",
						year: 1925,
						genre: "fiction",
					},
					{
						id: "b2",
						title: "1984",
						author: "George Orwell",
						year: 1949,
						genre: "dystopian",
					},
					{
						id: "b3",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
				],
			},
			{ plugins: [regexPlugin, idPlugin] },
		),
	);

	// Use the custom $regex operator
	const theBooks = await db.books.query({
		// biome-ignore lint/suspicious/noExplicitAny: custom plugin operators are outside the type system
		where: { title: { $regex: "^The.*" } } as any,
	}).runPromise;
	console.log(
		`  $regex "^The.*": ${theBooks.length} result — ${theBooks[0]?.title}`,
	);
}

// ============================================================================
// 7. Foreign Key Enforcement
// ============================================================================

async function foreignKeyExample() {
	console.log("\n=== Foreign Key Enforcement ===");

	const AuthorSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
	});

	const BookSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		authorId: Schema.String,
	});

	const config = {
		authors: {
			schema: AuthorSchema,
			relationships: {},
		},
		books: {
			schema: BookSchema,
			relationships: {
				author: {
					type: "ref" as const,
					target: "authors" as const,
					foreignKey: "authorId",
				},
			},
		},
	} as const;

	const db = await Effect.runPromise(
		createEffectDatabase(config, {
			authors: [{ id: "a1", name: "Frank Herbert" }],
			books: [],
		}),
	);

	// Valid foreign key — works fine
	await db.books.create({ title: "Dune", authorId: "a1" }).runPromise;
	console.log('  Created "Dune" with valid authorId');

	// Invalid foreign key — ForeignKeyError
	try {
		await db.books.create({ title: "Ghost Book", authorId: "nonexistent" })
			.runPromise;
	} catch (err) {
		if (err instanceof ForeignKeyError) {
			console.log(`  ForeignKeyError: ${err.message}`);
		}
	}
}

// ============================================================================
// 8. Run All
// ============================================================================

async function main() {
	await idGenerationExample();
	await indexingExample();
	await uniqueConstraintsExample();
	await transactionsExample();
	await migrationsExample();
	await pluginExample();
	await foreignKeyExample();
}

main().catch(console.error);
