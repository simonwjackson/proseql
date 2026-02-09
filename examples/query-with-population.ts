/**
 * Query with Population Example - Effect API
 *
 * Demonstrates the Stream-based query pipeline: filtering, sorting,
 * pagination, field selection, and relationship population using the
 * .runPromise convenience API.
 */

import { Effect, Schema, Stream, Chunk } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect"

// ============================================================================
// 1. Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	role: Schema.String,
	companyId: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	industry: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	tags: Schema.optional(Schema.Array(Schema.String)),
	published: Schema.optional(Schema.Boolean),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

// ============================================================================
// 2. Config with Relationships
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: {
				type: "ref" as const,
				target: "companies" as const,
				foreignKey: "companyId",
			},
			posts: {
				type: "inverse" as const,
				target: "posts" as const,
				foreignKey: "authorId",
			},
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: {
				type: "inverse" as const,
				target: "users" as const,
				foreignKey: "companyId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "authorId",
			},
		},
	},
} as const

// ============================================================================
// 3. Seed Data
// ============================================================================

const initialData = {
	companies: [
		{ id: "c1", name: "TechCorp", industry: "Technology" },
		{ id: "c2", name: "DesignLab", industry: "Design" },
	],
	users: [
		{ id: "u1", name: "Alice", email: "alice@tech.com", role: "engineer", companyId: "c1" },
		{ id: "u2", name: "Bob", email: "bob@tech.com", role: "manager", companyId: "c1" },
		{ id: "u3", name: "Charlie", email: "charlie@design.com", role: "designer", companyId: "c2" },
		{ id: "u4", name: "Diana", email: "diana@design.com", role: "engineer", companyId: "c2" },
	],
	posts: [
		{ id: "p1", title: "Intro to TypeScript", content: "TS is great", authorId: "u1", tags: ["typescript", "tutorial"], published: true },
		{ id: "p2", title: "Effect Streams", content: "Composable pipelines", authorId: "u1", tags: ["effect", "streams"], published: true },
		{ id: "p3", title: "Design Systems", content: "Building components", authorId: "u3", tags: ["design", "ui"], published: true },
		{ id: "p4", title: "Draft Post", content: "Work in progress", authorId: "u2", tags: ["draft"], published: false },
	],
}

// ============================================================================
// 4. Query Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(createEffectDatabase(config, initialData))

	// --- Basic filter + sort ---
	console.log("=== Engineers sorted by name ===")
	const engineers = await db.users.query({
		where: { role: "engineer" },
		sort: { name: "asc" },
	}).runPromise

	for (const u of engineers) {
		console.log(`  ${(u as Record<string, unknown>).name}`)
	}

	// --- Pagination ---
	console.log("\n=== Posts page 1 (limit 2) ===")
	const page1 = await db.posts.query({
		where: { published: true },
		sort: { title: "asc" },
		limit: 2,
		offset: 0,
	}).runPromise

	for (const p of page1) {
		console.log(`  ${(p as Record<string, unknown>).title}`)
	}

	console.log("=== Posts page 2 (limit 2) ===")
	const page2 = await db.posts.query({
		where: { published: true },
		sort: { title: "asc" },
		limit: 2,
		offset: 2,
	}).runPromise

	for (const p of page2) {
		console.log(`  ${(p as Record<string, unknown>).title}`)
	}

	// --- Population: resolve ref relationships ---
	console.log("\n=== Posts with populated author ===")
	const postsWithAuthor = await db.posts.query({
		where: { published: true },
		populate: { author: true },
	}).runPromise

	for (const p of postsWithAuthor) {
		const post = p as Record<string, unknown>
		const author = post.author as Record<string, unknown> | undefined
		console.log(`  "${post.title}" by ${author?.name ?? "unknown"}`)
	}

	// --- Population: resolve inverse relationships ---
	console.log("\n=== Companies with employees ===")
	const companiesWithEmployees = await db.companies.query({
		populate: { employees: true },
	}).runPromise

	for (const c of companiesWithEmployees) {
		const company = c as Record<string, unknown>
		const employees = company.employees as ReadonlyArray<Record<string, unknown>>
		console.log(`  ${company.name}: ${employees.map((e) => e.name).join(", ")}`)
	}

	// --- Nested population: post -> author -> company ---
	console.log("\n=== Posts with author and their company ===")
	const deepPopulated = await db.posts.query({
		where: { published: true },
		populate: {
			author: {
				populate: { company: true },
			},
		},
	}).runPromise

	for (const p of deepPopulated) {
		const post = p as Record<string, unknown>
		const author = post.author as Record<string, unknown> | undefined
		const company = author?.company as Record<string, unknown> | undefined
		console.log(`  "${post.title}" by ${author?.name} @ ${company?.name ?? "N/A"}`)
	}

	// --- Field selection (array syntax) ---
	console.log("\n=== Users with selected fields ===")
	const selectedUsers = await db.users.query({
		select: ["id", "name", "email"],
	}).runPromise

	for (const u of selectedUsers) {
		console.log(`  ${JSON.stringify(u)}`)
	}

	// --- Using Effect directly (for Effect-native consumers) ---
	console.log("\n=== Using Effect directly with Stream.runCollect ===")
	const stream = db.posts.query({ where: { published: true } })
	const results = await Effect.runPromise(
		Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
	)
	console.log(`  Found ${results.length} published posts via Stream.runCollect`)

	// --- Complex filter with $or and $and ---
	console.log("\n=== Complex filter: engineers OR name starts with 'D' ===")
	const complex = await db.users.query({
		where: {
			$or: [
				{ role: "engineer" },
				{ name: { $startsWith: "D" } },
			],
		},
		sort: { name: "asc" },
	}).runPromise

	for (const u of complex) {
		console.log(`  ${(u as Record<string, unknown>).name} (${(u as Record<string, unknown>).role})`)
	}
}

main().catch(console.error)
