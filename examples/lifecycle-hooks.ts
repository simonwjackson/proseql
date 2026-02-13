/**
 * Lifecycle Hooks Example
 *
 * Demonstrates beforeCreate, afterCreate, beforeUpdate, afterUpdate,
 * afterDelete, onChange, and hook rejection with HookError.
 */

import { Effect, Schema } from "effect"
import { createEffectDatabase, HookError } from "@proseql/core"
import type { HooksConfig } from "@proseql/core"

// ============================================================================
// 1. Schema
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = typeof UserSchema.Type

// ============================================================================
// 2. Define Hooks
// ============================================================================

// Hooks are defined with typed User context, then cast to the generic config type.
// At runtime, the context receives the full User entity.
const userHooks = {
	// --- beforeCreate: transform data before insertion ---
	beforeCreate: [
		(ctx: { data: User; collection: string; operation: string }) =>
			Effect.succeed({
				...ctx.data,
				name: ctx.data.name.trim(),
				email: ctx.data.email.toLowerCase(),
				createdAt: new Date().toISOString(),
			}),
	],

	// --- afterCreate: side-effect logging ---
	afterCreate: [
		(ctx: { entity: User; collection: string; operation: string }) => {
			console.log(`  [afterCreate] New user: "${ctx.entity.name}" (${ctx.entity.id})`)
			return Effect.void
		},
	],

	// --- beforeUpdate: inject updatedAt ---
	beforeUpdate: [
		(ctx: { update: Record<string, unknown>; collection: string; operation: string }) =>
			Effect.succeed({
				...ctx.update,
				updatedAt: new Date().toISOString(),
			}),
	],

	// --- afterUpdate: logging ---
	afterUpdate: [
		(ctx: { previous: User; current: User; collection: string; operation: string }) => {
			console.log(`  [afterUpdate] "${ctx.previous.name}" → "${ctx.current.name}"`)
			return Effect.void
		},
	],

	// --- afterDelete: logging ---
	afterDelete: [
		(ctx: { entity: User; collection: string; operation: string }) => {
			console.log(`  [afterDelete] Removed "${ctx.entity.name}"`)
			return Effect.void
		},
	],

	// --- onChange: unified handler for all mutations ---
	onChange: [
		(ctx: { type: string; collection: string }) => {
			console.log(`  [onChange] ${ctx.type} on ${ctx.collection}`)
			return Effect.void
		},
	],
} as unknown as HooksConfig<unknown>

// ============================================================================
// 3. Config
// ============================================================================

const config = {
	users: {
		schema: UserSchema,
		hooks: userHooks,
		relationships: {},
	},
} as const

// ============================================================================
// 4. Examples
// ============================================================================

async function main() {
	const db = await Effect.runPromise(
		createEffectDatabase(config, { users: [] }),
	)

	// === beforeCreate transforms data ===
	console.log("=== Create with beforeCreate hook ===")
	const alice = await db.users.create({
		name: "  Alice  ",
		email: "ALICE@EXAMPLE.COM",
		age: 30,
	}).runPromise
	console.log(`  Name trimmed: "${alice.name}"`)
	console.log(`  Email lowered: "${alice.email}"`)
	console.log(`  createdAt set: ${alice.createdAt}`)

	// === beforeUpdate injects updatedAt ===
	console.log("\n=== Update with beforeUpdate hook ===")
	const updated = await db.users.update(alice.id, { name: "Alice Smith" }).runPromise
	console.log(`  updatedAt set: ${updated.updatedAt}`)

	// === afterDelete ===
	console.log("\n=== Delete with afterDelete hook ===")
	await db.users.delete(alice.id).runPromise

	// === Hook Rejection ===
	console.log("\n=== Hook Rejection ===")

	// Create a separate database with a rejecting hook
	const rejectingHooks = {
		beforeCreate: [
			(ctx: { data: User; collection: string }) =>
				ctx.data.age < 18
					? Effect.fail(
							new HookError({
								hook: "beforeCreate",
								collection: ctx.collection,
								operation: "create",
								reason: "Must be 18 or older",
								message: "Must be 18 or older",
							}),
						)
					: Effect.succeed(ctx.data),
		],
	} as HooksConfig<unknown>

	const strictConfig = {
		users: {
			schema: UserSchema,
			hooks: rejectingHooks,
			relationships: {},
		},
	} as const

	const strictDb = await Effect.runPromise(
		createEffectDatabase(strictConfig, { users: [] }),
	)

	try {
		await strictDb.users.create({
			name: "Young User",
			email: "young@test.com",
			age: 16,
		}).runPromise
	} catch (err) {
		if (err instanceof HookError) {
			console.log(`  Rejected: ${err.reason}`)
			console.log(`  Hook: ${err.hook}, Operation: ${err.operation}`)
		}
	}
}

main().catch(console.error)
