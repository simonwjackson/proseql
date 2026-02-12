/**
 * Serialization Format Comparison Benchmarks
 *
 * Measures serialization and deserialization performance for all supported formats:
 * - JSON (.json)
 * - YAML (.yaml)
 * - TOML (.toml)
 * - JSON5 (.json5)
 * - JSONC (.jsonc)
 * - TOON (.toon)
 * - Hjson (.hjson)
 *
 * Also includes debounced write coalescing measurement.
 * Uses a 1K-entity dataset for consistent measurements.
 */

import { Effect, Layer, Schema } from "effect";
import { Bench } from "tinybench";
import {
	jsonCodec,
	yamlCodec,
	tomlCodec,
	json5Codec,
	jsoncCodec,
	toonCodec,
	hjsonCodec,
	createPersistentEffectDatabase,
	StorageAdapterService,
	makeSerializerLayer,
	type StorageAdapterShape,
} from "@proseql/core";
import { generateUsers, type User } from "./generators.js";
import { defaultBenchOptions, formatResultsTable } from "./utils.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Dataset size for serialization benchmarks.
 * 1K entities provides a meaningful workload while keeping benchmark time reasonable.
 */
const DATASET_SIZE = 1_000;

// ============================================================================
// Codec Instances
// ============================================================================

/**
 * All 7 format codecs to benchmark.
 * Each codec provides encode/decode functions for its format.
 */
const CODECS = [
	{ name: "JSON", codec: jsonCodec() },
	{ name: "YAML", codec: yamlCodec() },
	{ name: "TOML", codec: tomlCodec() },
	{ name: "JSON5", codec: json5Codec() },
	{ name: "JSONC", codec: jsoncCodec() },
	{ name: "TOON", codec: toonCodec() },
	{ name: "Hjson", codec: hjsonCodec() },
] as const;

// ============================================================================
// Benchmark Suite Export
// ============================================================================

/**
 * Benchmark suite name for identification in runner output.
 */
export const suiteName = "serialization";

/**
 * Creates and configures the serialization benchmark suite.
 *
 * This function pre-generates test data and sets up benchmarks for
 * each format's serialize and deserialize operations.
 * Individual benchmarks are added in subsequent tasks (6.2-6.4).
 */
export async function createSuite(): Promise<Bench> {
	const bench = new Bench(defaultBenchOptions);

	// Pre-generate dataset for serialization benchmarks
	const dataset = generateUsers(DATASET_SIZE);

	// -------------------------------------------------------------------------
	// 6.2: Serialization benchmarks for each format
	// -------------------------------------------------------------------------

	// For JSON-compatible formats (JSON, YAML, JSON5, JSONC, TOON, Hjson),
	// we serialize the array directly as most formats support top-level arrays.
	// For TOML, we wrap in an object since TOML requires a table at the top level.

	// Helper to get the data in the appropriate shape for each format
	const getDataForCodec = (codecName: string): unknown => {
		// TOML requires top-level to be a table (object), not an array
		// Use { users: [...] } wrapper for TOML
		if (codecName === "TOML") {
			return { users: dataset };
		}
		// All other formats can handle top-level arrays directly
		return dataset;
	};

	// Add serialization benchmarks for each codec
	for (const { name, codec } of CODECS) {
		const data = getDataForCodec(name);

		bench.add(`serialize ${name}`, () => {
			codec.encode(data);
		});
	}

	// -------------------------------------------------------------------------
	// 6.3: Deserialization benchmarks for each format
	// -------------------------------------------------------------------------

	// Pre-serialize data for each format to benchmark decoding
	const serializedData = new Map<string, string>();
	for (const { name, codec } of CODECS) {
		const data = getDataForCodec(name);
		serializedData.set(name, codec.encode(data));
	}

	// Add deserialization benchmarks for each codec
	for (const { name, codec } of CODECS) {
		const encoded = serializedData.get(name)!;

		bench.add(`deserialize ${name}`, () => {
			codec.decode(encoded);
		});
	}

	// -------------------------------------------------------------------------
	// 6.4: Debounced write coalescing benchmark
	// -------------------------------------------------------------------------

	// Note: This benchmark doesn't fit the typical ops/sec pattern.
	// It measures coalescing behavior rather than throughput.
	// We include it as a single-iteration "benchmark" that reports the ratio.

	// Track coalescing statistics across iterations for reporting
	const coalescingStats = {
		totalMutations: 0,
		totalWrites: 0,
		iterations: 0,
	};

	bench.add("debounced write coalescing (100 mutations)", async () => {
		// Create a counting storage adapter to track actual writes
		let writeCount = 0;
		const store = new Map<string, string>();

		const countingAdapter: StorageAdapterShape = {
			read: (path: string) =>
				Effect.suspend(() => {
					const content = store.get(path);
					if (content === undefined) {
						// Return empty collection format for new files
						return Effect.succeed("{}");
					}
					return Effect.succeed(content);
				}),
			write: (path: string, data: string) =>
				Effect.sync(() => {
					store.set(path, data);
					writeCount++;
				}),
			append: (path: string, data: string) =>
				Effect.sync(() => {
					const existing = store.get(path) ?? "";
					store.set(path, existing + data);
					writeCount++;
				}),
			exists: (path: string) => Effect.sync(() => store.has(path)),
			remove: (_path: string) => Effect.void,
			ensureDir: (_path: string) => Effect.void,
			watch: (_path: string, _onChange: () => void) =>
				Effect.succeed(() => {}),
		};

		const CountingStorageLayer = Layer.succeed(
			StorageAdapterService,
			countingAdapter,
		);
		const SerializerLayer = makeSerializerLayer([jsonCodec()]);
		const PersistenceLayer = Layer.merge(CountingStorageLayer, SerializerLayer);

		// Schema for benchmark users
		const BenchUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			email: Schema.String,
			age: Schema.Number,
			role: Schema.Literal("admin", "moderator", "user"),
			createdAt: Schema.String,
		});

		const config = {
			users: {
				schema: BenchUserSchema,
				file: "./data/users.json",
				relationships: {},
			},
		} as const;

		// Create database with short debounce for testing
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(
				config,
				{ users: [] },
				{ writeDebounce: 10 }, // Short debounce for testing
			);

			// Perform 100 rapid mutations
			for (let i = 0; i < 100; i++) {
				yield* db.users.create({
					id: `bench_user_${i}`,
					name: `User ${i}`,
					email: `user${i}@example.com`,
					age: 25 + (i % 50),
					role: "user",
					createdAt: new Date().toISOString(),
				});
			}

			// Flush to ensure all writes complete
			yield* Effect.promise(() => db.flush());

			return writeCount;
		});

		// Run the program
		const actualWrites = await Effect.runPromise(
			program.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
		);

		// Track statistics for reporting
		coalescingStats.totalMutations += 100;
		coalescingStats.totalWrites += actualWrites;
		coalescingStats.iterations++;

		// The coalescing ratio indicates how effective debouncing is
		// 100 mutations should result in far fewer than 100 writes
		// Ideal: 1-5 writes for 100 mutations
		const coalescingRatio = 100 / actualWrites;

		// If coalescing isn't working well, throw to make it visible
		if (actualWrites > 0 && coalescingRatio < 2) {
			throw new Error(
				`Poor coalescing: ${actualWrites} writes for 100 mutations (ratio: ${coalescingRatio.toFixed(2)})`,
			);
		}
	});

	// Store the stats reference on the bench object for later retrieval
	(bench as unknown as { coalescingStats: typeof coalescingStats }).coalescingStats =
		coalescingStats;

	return bench;
}

/**
 * Run the benchmark suite and print results.
 * This is called when the file is executed directly.
 */
export async function run(): Promise<void> {
	console.log("Running Serialization Format Comparison Benchmarks\n");

	const bench = await createSuite();

	if (bench.tasks.length === 0) {
		console.log(
			"No benchmarks configured yet. Benchmarks will be added in tasks 6.2-6.4.",
		);
		return;
	}

	await bench.run();

	console.log("\nResults:\n");
	console.log(formatResultsTable(bench.tasks));

	// Report coalescing statistics if available
	const stats = (
		bench as unknown as {
			coalescingStats?: {
				totalMutations: number;
				totalWrites: number;
				iterations: number;
			};
		}
	).coalescingStats;

	if (stats && stats.iterations > 0) {
		const avgWrites = stats.totalWrites / stats.iterations;
		const coalescingRatio = stats.totalMutations / stats.totalWrites;
		console.log("\n--- Debounced Write Coalescing Report ---");
		console.log(`Total iterations: ${stats.iterations}`);
		console.log(`Mutations per iteration: 100`);
		console.log(`Average writes per iteration: ${avgWrites.toFixed(2)}`);
		console.log(`Coalescing ratio: ${coalescingRatio.toFixed(2)}x`);
		console.log(
			`(${stats.totalMutations} mutations coalesced into ${stats.totalWrites} writes)`,
		);
	}
}

// Run when executed directly
if (import.meta.main) {
	run();
}
