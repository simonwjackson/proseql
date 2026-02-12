/**
 * ProseQL CLI - Migrate Command
 *
 * Manages schema migrations: shows status, performs dry runs, and executes migrations.
 * Supports subcommands: `migrate status`, `migrate --dry-run`, `migrate` (run).
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
import {
	NodeStorageLayer,
	makeSerializerLayer,
	jsonCodec,
	yamlCodec,
	tomlCodec,
	StorageAdapterService,
	SerializerRegistryService,
	getFileExtension,
	type DatabaseConfig,
	type DryRunResult,
	type DryRunCollectionResult,
	type DryRunStatus,
	type DryRunMigration,
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
 * Build the persistence layer for storage and serializer operations.
 */
function buildPersistenceLayer() {
	return Layer.merge(
		NodeStorageLayer,
		makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
	)
}

/**
 * Read the _version from a data file.
 * Returns 0 if the file doesn't exist or has no _version field.
 *
 * @param filePath - Path to the data file
 * @returns Effect yielding the file version and existence status
 */
function readFileVersion(
	filePath: string,
): Effect.Effect<
	{ version: number; exists: boolean },
	never,
	typeof StorageAdapterService.Service | typeof SerializerRegistryService.Service
> {
	return Effect.gen(function* () {
		const storage = yield* StorageAdapterService
		const serializer = yield* SerializerRegistryService

		// Check if file exists
		const exists = yield* storage.exists(filePath)
		if (!exists) {
			return { version: 0, exists: false }
		}

		// Read and parse the file
		const raw = yield* storage.read(filePath)
		const ext = getFileExtension(filePath) || "json"

		const parsed = yield* serializer.deserialize(raw, ext).pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		)

		// Extract _version from parsed data
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			const maybeVersion = (parsed as Record<string, unknown>)._version
			if (typeof maybeVersion === "number") {
				return { version: maybeVersion, exists: true }
			}
		}

		// Default to version 0 if no _version field
		return { version: 0, exists: true }
	}).pipe(
		// Catch any storage/serialization errors and return version 0
		Effect.catchAll(() => Effect.succeed({ version: 0, exists: true })),
	)
}

/**
 * Determine the migration status based on file and config versions.
 *
 * @param fileVersion - Current version from the file
 * @param targetVersion - Target version from config
 * @param fileExists - Whether the data file exists
 * @returns The appropriate DryRunStatus
 */
function determineStatus(
	fileVersion: number,
	targetVersion: number,
	fileExists: boolean,
): DryRunStatus {
	if (!fileExists) {
		return "no-file"
	}
	if (fileVersion > targetVersion) {
		return "ahead"
	}
	if (fileVersion === targetVersion) {
		return "up-to-date"
	}
	return "needs-migration"
}

/**
 * Get the list of migrations that would be applied for a collection.
 *
 * @param collectionConfig - The collection configuration
 * @param fileVersion - Current version from the file
 * @param targetVersion - Target version from config
 * @returns Array of migrations to apply
 */
function getMigrationsToApply(
	collectionConfig: DatabaseConfig[string],
	fileVersion: number,
	targetVersion: number,
): ReadonlyArray<DryRunMigration> {
	const migrations = collectionConfig.migrations ?? []
	return migrations
		.filter((m) => m.from >= fileVersion && m.to <= targetVersion)
		.sort((a, b) => a.from - b.from)
		.map((m): DryRunMigration => {
			const result: DryRunMigration = {
				from: m.from,
				to: m.to,
			}
			if (m.description !== undefined) {
				return { ...result, description: m.description }
			}
			return result
		})
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
	const resolvedConfig = resolveConfigPaths(config, configPath)

	const program = Effect.gen(function* () {
		const collections: DryRunCollectionResult[] = []

		for (const [name, collectionConfig] of Object.entries(resolvedConfig)) {
			// Only include versioned collections
			if (collectionConfig.version === undefined) {
				continue
			}

			const targetVersion = collectionConfig.version
			const filePath = collectionConfig.file ?? "(in-memory)"

			// Skip in-memory collections (no file to check)
			if (!collectionConfig.file) {
				collections.push({
					name,
					filePath: "(in-memory)",
					currentVersion: 0,
					targetVersion,
					migrationsToApply: [],
					status: "no-file",
				})
				continue
			}

			// Read the file version
			const { version: fileVersion, exists: fileExists } =
				yield* readFileVersion(collectionConfig.file)

			// Determine the status
			const status = determineStatus(fileVersion, targetVersion, fileExists)

			// Get migrations to apply (only if needs migration)
			const migrationsToApply =
				status === "needs-migration"
					? getMigrationsToApply(collectionConfig, fileVersion, targetVersion)
					: []

			collections.push({
				name,
				filePath,
				currentVersion: fileVersion,
				targetVersion,
				migrationsToApply,
				status,
			})
		}

		return {
			success: true as const,
			data: { collections } as DryRunResult,
		}
	})

	// Run with the persistence layer
	return program.pipe(
		Effect.provide(buildPersistenceLayer()),
		Effect.catchAll((error) => {
			const message = error instanceof Error ? error.message : String(error)
			return Effect.succeed({
				success: false as const,
				message: `Failed to check migration status: ${message}`,
			})
		}),
	)
}

/**
 * Execute the migrate dry-run subcommand.
 *
 * Shows what migrations would run without executing them.
 * This reads the current file versions and determines which migrations
 * would be applied, but does not actually execute any transforms or write files.
 */
function runMigrateDryRun(
	config: DatabaseConfig,
	configPath: string,
): Effect.Effect<MigrateResult, never> {
	const resolvedConfig = resolveConfigPaths(config, configPath)

	const program = Effect.gen(function* () {
		const collections: DryRunCollectionResult[] = []

		for (const [name, collectionConfig] of Object.entries(resolvedConfig)) {
			// Only include versioned collections
			if (collectionConfig.version === undefined) {
				continue
			}

			const targetVersion = collectionConfig.version
			const filePath = collectionConfig.file ?? "(in-memory)"

			// Skip in-memory collections (no file to migrate)
			if (!collectionConfig.file) {
				collections.push({
					name,
					filePath: "(in-memory)",
					currentVersion: 0,
					targetVersion,
					migrationsToApply: [],
					status: "no-file",
				})
				continue
			}

			// Read the file version
			const { version: fileVersion, exists: fileExists } =
				yield* readFileVersion(collectionConfig.file)

			// Determine the status
			const status = determineStatus(fileVersion, targetVersion, fileExists)

			// Get migrations to apply (only if needs migration)
			const migrationsToApply =
				status === "needs-migration"
					? getMigrationsToApply(collectionConfig, fileVersion, targetVersion)
					: []

			collections.push({
				name,
				filePath,
				currentVersion: fileVersion,
				targetVersion,
				migrationsToApply,
				status,
			})
		}

		return {
			success: true as const,
			data: { collections } as DryRunResult,
		}
	})

	// Run with the persistence layer
	return program.pipe(
		Effect.provide(buildPersistenceLayer()),
		Effect.catchAll((error) => {
			const message = error instanceof Error ? error.message : String(error)
			return Effect.succeed({
				success: false as const,
				message: `Failed to check dry-run status: ${message}`,
			})
		}),
	)
}

/**
 * Result of a single collection migration.
 */
interface CollectionMigrationResult {
	readonly name: string
	readonly success: boolean
	readonly fromVersion: number
	readonly toVersion: number
	readonly migrationsApplied: number
	readonly error?: string
}

/**
 * Result of the full migration run.
 */
interface MigrationRunResult {
	readonly collectionsProcessed: number
	readonly collectionsSucceeded: number
	readonly collectionsFailed: number
	readonly details: ReadonlyArray<CollectionMigrationResult>
}

/**
 * Execute migrations for a single collection.
 *
 * - Reads the file
 * - Parses it
 * - Runs the migrations on each entity
 * - Updates the `_version` field
 * - Writes the file back
 */
function migrateCollection(
	name: string,
	collectionConfig: DatabaseConfig[string],
	fileVersion: number,
): Effect.Effect<
	CollectionMigrationResult,
	never,
	typeof StorageAdapterService.Service | typeof SerializerRegistryService.Service
> {
	const targetVersion = collectionConfig.version ?? 0
	const filePath = collectionConfig.file

	// This should not happen as we filter before calling this
	if (!filePath) {
		return Effect.succeed({
			name,
			success: false,
			fromVersion: fileVersion,
			toVersion: targetVersion,
			migrationsApplied: 0,
			error: "No file path configured",
		})
	}

	return Effect.gen(function* () {
		const storage = yield* StorageAdapterService
		const serializer = yield* SerializerRegistryService

		const ext = getFileExtension(filePath) || "json"

		// Read the file
		const raw = yield* storage.read(filePath).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to read file: ${err}`)),
			),
		)

		// Parse the file
		const parsed = yield* serializer.deserialize(raw, ext).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to parse file: ${err}`)),
			),
		)

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return yield* Effect.fail(
				new Error("File does not contain a valid object"),
			)
		}

		const data = parsed as Record<string, unknown>

		// Get the migrations to apply
		const migrations = collectionConfig.migrations ?? []
		const applicableMigrations = migrations
			.filter((m) => m.from >= fileVersion && m.to <= targetVersion)
			.sort((a, b) => a.from - b.from)

		// Run the migrations by chaining transforms
		let migratedData = data
		for (const migration of applicableMigrations) {
			try {
				migratedData = migration.transform(migratedData)
			} catch (err) {
				return {
					name,
					success: false,
					fromVersion: fileVersion,
					toVersion: targetVersion,
					migrationsApplied: applicableMigrations.indexOf(migration),
					error: `Migration ${migration.from}→${migration.to} failed: ${err instanceof Error ? err.message : String(err)}`,
				}
			}
		}

		// Update the _version field
		migratedData = {
			...migratedData,
			_version: targetVersion,
		}

		// Serialize the data
		const serialized = yield* serializer.serialize(migratedData, ext).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to serialize data: ${err}`)),
			),
		)

		// Write the file
		yield* storage.write(filePath, serialized).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to write file: ${err}`)),
			),
		)

		return {
			name,
			success: true,
			fromVersion: fileVersion,
			toVersion: targetVersion,
			migrationsApplied: applicableMigrations.length,
		}
	}).pipe(
		Effect.catchAll((err) =>
			Effect.succeed({
				name,
				success: false,
				fromVersion: fileVersion,
				toVersion: targetVersion,
				migrationsApplied: 0,
				error: err instanceof Error ? err.message : String(err),
			}),
		),
	)
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
	const resolvedConfig = resolveConfigPaths(config, configPath)

	const program = Effect.gen(function* () {
		// First, do a dry-run to determine which collections need migration
		const dryRunCollections: DryRunCollectionResult[] = []

		for (const [name, collectionConfig] of Object.entries(resolvedConfig)) {
			// Only include versioned collections
			if (collectionConfig.version === undefined) {
				continue
			}

			const targetVersion = collectionConfig.version
			const filePath = collectionConfig.file ?? "(in-memory)"

			// Skip in-memory collections (no file to migrate)
			if (!collectionConfig.file) {
				continue
			}

			// Read the file version
			const { version: fileVersion, exists: fileExists } =
				yield* readFileVersion(collectionConfig.file)

			// Determine the status
			const status = determineStatus(fileVersion, targetVersion, fileExists)

			// Get migrations to apply (only if needs migration)
			const migrationsToApply =
				status === "needs-migration"
					? getMigrationsToApply(collectionConfig, fileVersion, targetVersion)
					: []

			dryRunCollections.push({
				name,
				filePath,
				currentVersion: fileVersion,
				targetVersion,
				migrationsToApply,
				status,
			})
		}

		// Filter to collections that need migration
		const collectionsToMigrate = dryRunCollections.filter(
			(c) => c.status === "needs-migration",
		)

		if (collectionsToMigrate.length === 0) {
			// Check if there are any versioned collections at all
			const versionedCount = dryRunCollections.length
			if (versionedCount === 0) {
				return {
					success: true,
					message: "No versioned collections found. Nothing to migrate.",
				}
			}
			return {
				success: true,
				message: "All collections are up-to-date. Nothing to migrate.",
				data: { collections: dryRunCollections } as DryRunResult,
			}
		}

		// Prompt for confirmation
		const totalMigrations = collectionsToMigrate.reduce(
			(sum, c) => sum + c.migrationsToApply.length,
			0,
		)
		const confirmResult = yield* Effect.promise(() =>
			confirm({
				message: `Run ${totalMigrations} migration(s) on ${collectionsToMigrate.length} collection(s)?`,
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

		// Execute migrations for each collection
		const migrationResults: CollectionMigrationResult[] = []

		for (const collectionDryRun of collectionsToMigrate) {
			const collectionConfig = resolvedConfig[collectionDryRun.name]
			const result = yield* migrateCollection(
				collectionDryRun.name,
				collectionConfig,
				collectionDryRun.currentVersion,
			)
			migrationResults.push(result)
		}

		// Build the summary
		const succeeded = migrationResults.filter((r) => r.success).length
		const failed = migrationResults.filter((r) => !r.success).length
		const totalApplied = migrationResults.reduce(
			(sum, r) => sum + r.migrationsApplied,
			0,
		)

		const runResult: MigrationRunResult = {
			collectionsProcessed: migrationResults.length,
			collectionsSucceeded: succeeded,
			collectionsFailed: failed,
			details: migrationResults,
		}

		// Build message
		let message: string
		if (failed === 0) {
			message = `Migration complete. Applied ${totalApplied} migration(s) to ${succeeded} collection(s).`
		} else {
			message = `Migration completed with errors. ${succeeded}/${migrationResults.length} collection(s) succeeded.`
		}

		// Build updated dry-run result showing post-migration state
		const updatedCollections: DryRunCollectionResult[] = dryRunCollections.map(
			(c) => {
				const migrationResult = migrationResults.find((r) => r.name === c.name)
				if (migrationResult?.success) {
					return {
						...c,
						currentVersion: migrationResult.toVersion,
						migrationsToApply: [],
						status: "up-to-date" as DryRunStatus,
					}
				}
				return c
			},
		)

		return {
			success: failed === 0,
			message,
			data: { collections: updatedCollections } as DryRunResult,
		}
	})

	// Run with the persistence layer
	return program.pipe(
		Effect.provide(buildPersistenceLayer()),
		Effect.catchAll((error) => {
			const message = error instanceof Error ? error.message : String(error)
			return Effect.succeed({
				success: false as const,
				message: `Failed to run migrations: ${message}`,
			})
		}),
	)
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
