/**
 * ProseQL CLI - Migrate Command
 *
 * Manages schema migrations: shows status, performs dry runs, and executes migrations.
 * Supports subcommands: `migrate status`, `migrate --dry-run`, `migrate` (run).
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
import {
	createPersistentEffectDatabase,
	NodeStorageLayer,
	makeSerializerLayer,
	jsonCodec,
	yamlCodec,
	tomlCodec,
	type DatabaseConfig,
	type DryRunResult,
	type DryRunCollectionResult,
} from "@proseql/node"
import { confirm } from "../prompt.js"

/**
 * Subcommand for the migrate command.
 * - "status": Display migration status for all collections
 * - "dry-run": Show what migrations would run without executing
 * - "run": Execute pending migrations
 */
export type MigrateSubcommand = "status" | "dry-run" | "run"

/**
 * Options for the migrate command.
 */
export interface MigrateOptions {
	/** The database configuration */
	readonly config: DatabaseConfig
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string
	/** Subcommand to execute */
	readonly subcommand: MigrateSubcommand
	/** Skip confirmation prompt if true (for run subcommand) */
	readonly force?: boolean
}

/**
 * Result of the migrate command.
 */
export interface MigrateResult {
	readonly success: boolean
	readonly message?: string
	/** Whether the operation was aborted by the user */
	readonly aborted?: boolean
	/** Dry-run or status result data */
	readonly data?: DryRunResult
}

/**
 * Detect which subcommand is being requested based on positional args and flags.
 *
 * @param positionalArgs - Positional arguments after "migrate"
 * @param dryRun - Whether --dry-run flag was passed
 * @returns The detected subcommand
 */
export function detectSubcommand(
	positionalArgs: readonly string[],
	dryRun: boolean,
): MigrateSubcommand {
	// Check for "status" subcommand
	if (positionalArgs.length > 0 && positionalArgs[0] === "status") {
		return "status"
	}

	// Check for --dry-run flag
	if (dryRun) {
		return "dry-run"
	}

	// Default to "run" - actually execute migrations
	return "run"
}

/**
 * Resolve relative file paths in the config to absolute paths
 * based on the config file's directory.
 */
function resolveConfigPaths(
	config: DatabaseConfig,
	configPath: string,
): DatabaseConfig {
	const configDir = path.dirname(configPath)
	const resolved: Record<string, (typeof config)[string]> = {}

	for (const [collectionName, collectionConfig] of Object.entries(config)) {
		if (collectionConfig.file && !path.isAbsolute(collectionConfig.file)) {
			resolved[collectionName] = {
				...collectionConfig,
				file: path.resolve(configDir, collectionConfig.file),
			}
		} else {
			resolved[collectionName] = collectionConfig
		}
	}

	return resolved as DatabaseConfig
}

/**
 * Execute the migrate status subcommand.
 *
 * Displays each collection's current file version vs config version,
 * highlighting collections that need migration.
 */
function runMigrateStatus(
	config: DatabaseConfig,
	configPath: string,
): Effect.Effect<MigrateResult, never> {
	return Effect.gen(function* () {
		const resolvedConfig = resolveConfigPaths(config, configPath)

		// Build collection status from config
		// For now, just extract version info from config
		// The actual file version reading will be implemented in task 7.2
		const collections: DryRunCollectionResult[] = []

		for (const [name, collectionConfig] of Object.entries(resolvedConfig)) {
			// Only include versioned collections
			if (collectionConfig.version !== undefined) {
				collections.push({
					name,
					filePath: collectionConfig.file ?? "(in-memory)",
					currentVersion: 0, // Placeholder - will read from file in task 7.2
					targetVersion: collectionConfig.version,
					migrationsToApply: [],
					status: "needs-migration", // Placeholder - will determine in task 7.2
				})
			}
		}

		return {
			success: true,
			data: { collections },
		}
	})
}

/**
 * Execute the migrate dry-run subcommand.
 *
 * Shows what migrations would run without executing them.
 */
function runMigrateDryRun(
	config: DatabaseConfig,
	configPath: string,
): Effect.Effect<MigrateResult, never> {
	return Effect.gen(function* () {
		// For task 7.1, return placeholder result
		// Full implementation in task 7.3
		const resolvedConfig = resolveConfigPaths(config, configPath)

		const collections: DryRunCollectionResult[] = []

		for (const [name, collectionConfig] of Object.entries(resolvedConfig)) {
			if (collectionConfig.version !== undefined) {
				collections.push({
					name,
					filePath: collectionConfig.file ?? "(in-memory)",
					currentVersion: 0,
					targetVersion: collectionConfig.version,
					migrationsToApply: [],
					status: "needs-migration",
				})
			}
		}

		return {
			success: true,
			data: { collections },
		}
	})
}

/**
 * Execute migrations (the "run" subcommand).
 *
 * Prompts for confirmation (unless --force), executes all pending migrations,
 * and reports results.
 */
function runMigrate(
	config: DatabaseConfig,
	configPath: string,
	force: boolean,
): Effect.Effect<MigrateResult, never> {
	return Effect.gen(function* () {
		// For task 7.1, return placeholder result
		// Full implementation in task 7.4
		const resolvedConfig = resolveConfigPaths(config, configPath)

		// Check if there are any versioned collections
		const versionedCollections = Object.entries(resolvedConfig).filter(
			([_, cfg]) => cfg.version !== undefined,
		)

		if (versionedCollections.length === 0) {
			return {
				success: true,
				message: "No versioned collections found. Nothing to migrate.",
			}
		}

		// Prompt for confirmation
		const confirmResult = yield* Effect.promise(() =>
			confirm({
				message: `Run migrations on ${versionedCollections.length} collection(s)?`,
				force,
			}),
		)

		if (!confirmResult.confirmed) {
			return {
				success: false,
				message: "Migration cancelled.",
				aborted: true,
			}
		}

		// Placeholder - actual migration will be implemented in task 7.4
		return {
			success: true,
			message: "Migration complete. (not yet implemented)",
		}
	})
}

/**
 * Execute the migrate command.
 *
 * Routes to the appropriate subcommand handler based on options.
 *
 * @param options - Migrate command options
 * @returns Effect that resolves to the migrate result
 */
export function runMigrateCommand(
	options: MigrateOptions,
): Effect.Effect<MigrateResult, never> {
	const { config, configPath, subcommand, force = false } = options

	switch (subcommand) {
		case "status":
			return runMigrateStatus(config, configPath)
		case "dry-run":
			return runMigrateDryRun(config, configPath)
		case "run":
			return runMigrate(config, configPath, force)
	}
}

/**
 * Handle the migrate command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Migrate command options
 * @returns Promise that resolves to the migrate result
 */
export async function handleMigrate(options: MigrateOptions): Promise<MigrateResult> {
	return Effect.runPromise(runMigrateCommand(options))
}
