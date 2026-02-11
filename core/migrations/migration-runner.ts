/**
 * Migration Runner
 *
 * Core migration logic: validate migration registries, run migrations,
 * and preview migrations via dry-run.
 */

import { Effect } from "effect"
import { MigrationError } from "../errors/migration-errors.js"
import type { Migration } from "./migration-types.js"

// ============================================================================
// Migration Registry Validation
// ============================================================================

/**
 * Validate that a migration registry forms a valid, contiguous chain.
 *
 * Validation rules:
 * - Migrations must form a contiguous chain (no gaps in `from`/`to`)
 * - Each migration's `to` must equal `from + 1`
 * - No duplicate `from` values
 * - The last migration's `to` must equal the collection's `version`
 * - Version 0 with no migrations is valid
 * - Version > 0 with empty migrations is invalid
 *
 * @param collectionName - Name of the collection (for error messages)
 * @param version - Target schema version from collection config
 * @param migrations - Array of migrations to validate
 * @returns Effect<void, MigrationError> - succeeds if valid, fails with MigrationError if invalid
 */
export const validateMigrationRegistry = (
	collectionName: string,
	version: number,
	migrations: ReadonlyArray<Migration>,
): Effect.Effect<void, MigrationError> => {
	// Version 0 with no migrations is valid (no migrations needed)
	if (version === 0 && migrations.length === 0) {
		return Effect.void
	}

	// Version > 0 with empty migrations is invalid (no path from 0 to current)
	if (version > 0 && migrations.length === 0) {
		return Effect.fail(
			new MigrationError({
				collection: collectionName,
				fromVersion: 0,
				toVersion: version,
				step: -1,
				reason: "empty-registry",
				message: `Collection "${collectionName}" has version ${version} but no migrations defined. Cannot migrate from version 0 to ${version}.`,
			}),
		)
	}

	// Check each migration's to === from + 1
	for (let i = 0; i < migrations.length; i++) {
		const migration = migrations[i]
		if (migration.to !== migration.from + 1) {
			return Effect.fail(
				new MigrationError({
					collection: collectionName,
					fromVersion: migration.from,
					toVersion: migration.to,
					step: i,
					reason: "invalid-increment",
					message: `Migration at index ${i} has from=${migration.from} and to=${migration.to}, but to must equal from + 1.`,
				}),
			)
		}
	}

	// Check for duplicate `from` values
	const fromValues = new Set<number>()
	for (let i = 0; i < migrations.length; i++) {
		const migration = migrations[i]
		if (fromValues.has(migration.from)) {
			return Effect.fail(
				new MigrationError({
					collection: collectionName,
					fromVersion: migration.from,
					toVersion: migration.to,
					step: i,
					reason: "duplicate-from",
					message: `Duplicate migration from version ${migration.from}. Each version can only have one migration.`,
				}),
			)
		}
		fromValues.add(migration.from)
	}

	// Sort migrations by `from` to check for contiguous chain
	const sortedMigrations = [...migrations].sort((a, b) => a.from - b.from)

	// Check that first migration starts from version 0
	// (data without _version is treated as version 0, so we need a path from 0)
	const firstMigration = sortedMigrations[0]
	if (firstMigration.from !== 0) {
		return Effect.fail(
			new MigrationError({
				collection: collectionName,
				fromVersion: 0,
				toVersion: firstMigration.from,
				step: -1,
				reason: "missing-start",
				message: `First migration starts at version ${firstMigration.from}, but must start at version 0. No path from version 0 to ${firstMigration.from}.`,
			}),
		)
	}

	// Check for contiguous chain (no gaps)
	for (let i = 1; i < sortedMigrations.length; i++) {
		const prev = sortedMigrations[i - 1]
		const curr = sortedMigrations[i]
		if (curr.from !== prev.to) {
			return Effect.fail(
				new MigrationError({
					collection: collectionName,
					fromVersion: prev.to,
					toVersion: curr.from,
					step: -1,
					reason: "gap-in-chain",
					message: `Gap in migration chain: no migration from version ${prev.to} to ${curr.from}.`,
				}),
			)
		}
	}

	// Check that last migration's `to` matches the version
	const lastMigration = sortedMigrations[sortedMigrations.length - 1]
	if (lastMigration.to !== version) {
		return Effect.fail(
			new MigrationError({
				collection: collectionName,
				fromVersion: lastMigration.from,
				toVersion: lastMigration.to,
				step: -1,
				reason: "version-mismatch",
				message: `Last migration goes to version ${lastMigration.to}, but collection version is ${version}.`,
			}),
		)
	}

	return Effect.void
}
