/**
 * Append-Only JSONL Example
 *
 * Demonstrates append-only collections for event logs, audit trails, and
 * write-once data. Each create() appends a single JSONL line instead of
 * rewriting the file. Updates and deletes throw OperationError.
 */

import { createNodeDatabase } from "@proseql/node";
import { Effect, Schema } from "effect";

// ============================================================================
// 1. Schema
// ============================================================================

const EventSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	target: Schema.String,
	timestamp: Schema.String,
});

// ============================================================================
// 2. Config — appendOnly: true with .jsonl file
// ============================================================================

const config = {
	events: {
		schema: EventSchema,
		file: "./examples/data/events.jsonl",
		appendOnly: true,
		relationships: {},
	},
} as const;

// ============================================================================
// 3. Main
// ============================================================================

const program = Effect.gen(function* () {
	const db = yield* createNodeDatabase(config, {
		events: [],
	});

	// === Create events (each appends one line to the .jsonl file) ===
	console.log("=== Append-Only Creates ===");

	const evt1 = yield* db.events.create({
		type: "click",
		target: "button-1",
		timestamp: "2024-01-15T10:00:00Z",
	});
	console.log(`  Created: ${evt1.type} on ${evt1.target}`);

	const evt2 = yield* db.events.create({
		type: "pageview",
		target: "/dashboard",
		timestamp: "2024-01-15T10:01:00Z",
	});
	console.log(`  Created: ${evt2.type} on ${evt2.target}`);

	yield* db.events.create({
		type: "click",
		target: "nav-link",
		timestamp: "2024-01-15T10:02:00Z",
	});

	// === Query and findById work normally ===
	console.log("\n=== Querying ===");

	const clicks = yield* Effect.promise(
		() => db.events.query({ where: { type: "click" } }).runPromise,
	);
	console.log(`  Click events: ${clicks.length}`);

	const found = yield* Effect.promise(
		() => db.events.findById(evt1.id).runPromise,
	);
	console.log(`  Found by ID: ${found.type} on ${found.target}`);

	// === Aggregation works normally ===
	const stats = yield* db.events.aggregate({ count: true });
	console.log(`  Total events: ${stats.count}`);

	// === Update throws OperationError ===
	console.log("\n=== Append-Only Restrictions ===");

	yield* db.events.update(evt1.id, { type: "tap" }).pipe(
		Effect.catchAll((err) => {
			console.log(`  Update blocked: ${err.message}`);
			return Effect.void;
		}),
	);

	// === Delete throws OperationError ===
	yield* db.events.delete(evt1.id).pipe(
		Effect.catchAll((err) => {
			console.log(`  Delete blocked: ${err.message}`);
			return Effect.void;
		}),
	);

	// === Flush for clean rewrite ===
	yield* Effect.promise(() => db.flush());
	console.log("\n  Flushed — open examples/data/events.jsonl to see the log");
});

Effect.runPromise(Effect.scoped(program)).catch(console.error);
