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

import { Bench } from "tinybench";
import {
	jsonCodec,
	yamlCodec,
	tomlCodec,
	json5Codec,
	jsoncCodec,
	toonCodec,
	hjsonCodec,
} from "@proseql/core";
import { generateUsers } from "./generators.js";
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

	// TODO (task 6.4): Add debounced write coalescing benchmark

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
}

// Run when executed directly
if (import.meta.main) {
	run();
}
