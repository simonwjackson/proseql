/**
 * Basic CRUD Example - Effect API
 *
 * Demonstrates creating an in-memory database with Effect Schema,
 * performing CRUD operations via .runPromise, and handling typed errors
 * with Effect.catchTag.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect"
import { NotFoundError } from "../core/errors/crud-errors"

// ============================================================================
// 1. Define Schemas using Effect Schema
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
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

// ============================================================================
// 2. Configure the Database
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: { type: "ref" as const, target: "companies" as const },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users" as const },
		},
	},
} as const

// ============================================================================
// 3. Create the Database and Perform Operations
// ============================================================================

async function main() {
	// Create the database with initial data
	const db = await Effect.runPromise(
		createEffectDatabase(config, {
			users: [],
			companies: [
				{ id: "c1", name: "TechCorp", industry: "Technology" },
				{ id: "c2", name: "FinanceInc", industry: "Finance" },
			],
		}),
	)

	// --- CREATE ---
	// .runPromise converts the Effect into a Promise
	const alice = await db.users.create({
		name: "Alice",
		email: "alice@example.com",
		age: 30,
		companyId: "c1",
	}).runPromise

	console.log("Created:", alice.name, alice.id)

	// Batch create
	const batch = await db.users.createMany([
		{ name: "Bob", email: "bob@example.com", age: 25, companyId: "c1" },
		{ name: "Charlie", email: "charlie@example.com", age: 35, companyId: "c2" },
	]).runPromise

	console.log(`Batch created ${batch.created.length} users`)

	// --- READ ---
	// O(1) lookup by ID
	const found = await db.users.findById(alice.id).runPromise
	console.log("Found by ID:", found.name)

	// Query all users (stream mode, no cursor)
	const allUsers = await db.users.query().runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`Total users: ${allUsers.length}`)

	// Query with filter and sort (stream mode, no cursor)
	const filtered = await db.users.query({
		where: { age: { $gte: 30 } },
		sort: { name: "asc" },
	}).runPromise as ReadonlyArray<Record<string, unknown>>
	console.log(`Users >= 30: ${filtered.length}`)

	// --- UPDATE ---
	const updated = await db.users.update(alice.id, { age: 31 }).runPromise
	console.log("Updated age:", updated.age)

	// --- UPSERT ---
	const upserted = await db.users.upsert({
		where: { id: "new-user" },
		create: { name: "Diana", email: "diana@example.com", age: 28, companyId: "c2" },
		update: { age: 29 },
	}).runPromise
	console.log("Upserted:", upserted.name, upserted.__action)

	// --- DELETE ---
	const deleted = await db.users.delete(alice.id).runPromise
	console.log("Deleted:", deleted.name)

	// ============================================================================
	// 4. Error Handling with Effect
	// ============================================================================

	// Using Effect.runPromise — errors become rejected promises
	try {
		await db.users.findById("nonexistent").runPromise
	} catch (err) {
		if (err instanceof NotFoundError) {
			console.log(`Not found: ${err.collection}/${err.id}`)
		}
	}

	// Using Effect directly for typed error handling with catchTag
	const result = await Effect.runPromise(
		db.users.findById("nonexistent").pipe(
			Effect.catchTag("NotFoundError", (err) =>
				Effect.succeed({ fallback: true, message: err.message }),
			),
		),
	)
	console.log("Caught with catchTag:", result)
}

main().catch(console.error)
