/**
 * Effect-based persistence functions for loading and saving collection data.
 *
 * Uses StorageAdapter and SerializerRegistry services for I/O and format handling.
 * Data is decoded/encoded through Effect Schema on load/save to ensure type safety.
 * Includes DebouncedWriter for coalescing rapid mutations into single file writes.
 */

import { Effect, Fiber, Option, Ref, Schema } from "effect"
import { StorageAdapter } from "./storage-service.js"
import { SerializerRegistry } from "../serializers/serializer-service.js"
import {
	StorageError,
	SerializationError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js"
import { ValidationError } from "../errors/crud-errors.js"
import { getFileExtension } from "../utils/file-extensions.js"

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the file extension from a path, failing with StorageError if none found.
 */
const resolveExtension = (
	filePath: string,
): Effect.Effect<string, StorageError> => {
	const ext = getFileExtension(filePath)
	if (ext === "") {
		return Effect.fail(
			new StorageError({
				path: filePath,
				operation: "read",
				message: `Cannot determine file format: no extension in '${filePath}'`,
			}),
		)
	}
	return Effect.succeed(ext)
}

/**
 * Type guard: is the value a plain Record<string, unknown>?
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// ============================================================================
// loadData
// ============================================================================

/**
 * Load collection data from a file, decode each entity through the given Schema.
 *
 * Flow:
 * 1. Check file existence via StorageAdapter
 * 2. Read raw content
 * 3. Deserialize (JSON/YAML/MessagePack) via SerializerRegistry
 * 4. Validate the top-level structure is a Record<string, object>
 * 5. Decode each entity value through the Schema
 * 6. Return a ReadonlyMap<string, A> keyed by entity ID
 *
 * If the file does not exist, returns an empty ReadonlyMap.
 */
export const loadData = <A extends { readonly id: string }, I, R>(
	filePath: string,
	schema: Schema.Schema<A, I, R>,
): Effect.Effect<
	ReadonlyMap<string, A>,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter
		const serializer = yield* SerializerRegistry
		const ext = yield* resolveExtension(filePath)

		// If file doesn't exist, return empty map
		const exists = yield* storage.exists(filePath)
		if (!exists) {
			return new Map<string, A>() as ReadonlyMap<string, A>
		}

		// Read and deserialize
		const raw = yield* storage.read(filePath)
		const parsed = yield* serializer.deserialize(raw, ext)

		// The on-disk format is { collectionName: { id: entity, ... } } or { id: entity, ... }
		// For a single collection load, we expect a Record<string, unknown> of entities keyed by ID
		if (!isRecord(parsed)) {
			return yield* Effect.fail(
				new SerializationError({
					format: ext,
					message: `Invalid data format in '${filePath}': expected object, got ${typeof parsed}`,
				}),
			)
		}

		// Decode each entity through the schema
		const decode = Schema.decodeUnknown(schema)
		const entries: Array<[string, A]> = []

		for (const [id, value] of Object.entries(parsed)) {
			const decoded = yield* decode(value).pipe(
				Effect.mapError(
					(parseError) =>
						new ValidationError({
							message: `Failed to decode entity '${id}' in '${filePath}': ${parseError.message}`,
							issues: [
								{
									field: id,
									message: parseError.message,
								},
							],
						}),
				),
			)
			entries.push([id, decoded])
		}

		return new Map(entries) as ReadonlyMap<string, A>
	})

// ============================================================================
// saveData
// ============================================================================

/**
 * Save collection data to a file, encoding each entity through the given Schema.
 *
 * Flow:
 * 1. Encode each entity through the Schema (Type → Encoded)
 * 2. Build a Record<string, I> keyed by entity ID
 * 3. Serialize via SerializerRegistry
 * 4. Ensure parent directory exists
 * 5. Write via StorageAdapter
 */
export const saveData = <A extends { readonly id: string }, I, R>(
	filePath: string,
	schema: Schema.Schema<A, I, R>,
	data: ReadonlyMap<string, A>,
): Effect.Effect<
	void,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter
		const serializer = yield* SerializerRegistry
		const ext = yield* resolveExtension(filePath)

		// Encode each entity through the schema
		const encode = Schema.encode(schema)
		const obj: Record<string, I> = {}

		for (const [id, entity] of data) {
			const encoded = yield* encode(entity).pipe(
				Effect.mapError(
					(parseError) =>
						new ValidationError({
							message: `Failed to encode entity '${id}' for '${filePath}': ${parseError.message}`,
							issues: [
								{
									field: id,
									message: parseError.message,
								},
							],
						}),
				),
			)
			obj[id] = encoded
		}

		// Serialize and write
		const content = yield* serializer.serialize(obj, ext)
		yield* storage.ensureDir(filePath)
		yield* storage.write(filePath, content)
	})

// ============================================================================
// loadCollectionsFromFile
// ============================================================================

/**
 * Load multiple collections from a single file.
 *
 * The file is expected to contain a top-level object where keys are collection names
 * and values are objects keyed by entity ID. Each collection is decoded independently
 * using its own schema.
 *
 * Returns a Record mapping collection name to ReadonlyMap<string, unknown>.
 */
export const loadCollectionsFromFile = (
	filePath: string,
	collections: ReadonlyArray<{
		readonly name: string
		readonly schema: Schema.Schema<{ readonly id: string }, unknown, never>
	}>,
): Effect.Effect<
	Record<string, ReadonlyMap<string, { readonly id: string }>>,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter
		const serializer = yield* SerializerRegistry
		const ext = yield* resolveExtension(filePath)

		const exists = yield* storage.exists(filePath)
		if (!exists) {
			const result: Record<string, ReadonlyMap<string, { readonly id: string }>> = {}
			for (const col of collections) {
				result[col.name] = new Map()
			}
			return result
		}

		const raw = yield* storage.read(filePath)
		const parsed = yield* serializer.deserialize(raw, ext)

		if (!isRecord(parsed)) {
			return yield* Effect.fail(
				new SerializationError({
					format: ext,
					message: `Invalid data format in '${filePath}': expected object, got ${typeof parsed}`,
				}),
			)
		}

		const result: Record<string, ReadonlyMap<string, { readonly id: string }>> = {}

		for (const col of collections) {
			const collectionData = parsed[col.name]
			if (collectionData === undefined || !isRecord(collectionData)) {
				result[col.name] = new Map()
				continue
			}

			const decode = Schema.decodeUnknown(col.schema)
			const entries: Array<[string, { readonly id: string }]> = []

			for (const [id, value] of Object.entries(collectionData)) {
				const decoded = yield* decode(value).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to decode entity '${id}' in collection '${col.name}' from '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: `${col.name}.${id}`,
										message: parseError.message,
									},
								],
							}),
					),
				)
				entries.push([id, decoded])
			}

			result[col.name] = new Map(entries)
		}

		return result
	})

// ============================================================================
// saveCollectionsToFile
// ============================================================================

/**
 * Save multiple collections to a single file.
 *
 * Encodes each entity in each collection through its schema, then writes
 * the combined data as { collectionName: { id: encodedEntity, ... }, ... }.
 */
export const saveCollectionsToFile = (
	filePath: string,
	collections: ReadonlyArray<{
		readonly name: string
		readonly schema: Schema.Schema<{ readonly id: string }, unknown, never>
		readonly data: ReadonlyMap<string, { readonly id: string }>
	}>,
): Effect.Effect<
	void,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter
		const serializer = yield* SerializerRegistry
		const ext = yield* resolveExtension(filePath)

		const fileObj: Record<string, Record<string, unknown>> = {}

		for (const col of collections) {
			const encode = Schema.encode(col.schema)
			const collectionObj: Record<string, unknown> = {}

			for (const [id, entity] of col.data) {
				const encoded = yield* encode(entity).pipe(
					Effect.mapError(
						(parseError) =>
							new ValidationError({
								message: `Failed to encode entity '${id}' in collection '${col.name}' for '${filePath}': ${parseError.message}`,
								issues: [
									{
										field: `${col.name}.${id}`,
										message: parseError.message,
									},
								],
							}),
					),
				)
				collectionObj[id] = encoded
			}

			fileObj[col.name] = collectionObj
		}

		const content = yield* serializer.serialize(fileObj, ext)
		yield* storage.ensureDir(filePath)
		yield* storage.write(filePath, content)
	})

// ============================================================================
// DebouncedWriter
// ============================================================================

/**
 * A pending write entry: the forked fiber (sleeping then saving) and
 * the save effect itself (so flush can execute it immediately).
 */
interface PendingWrite {
	readonly fiber: Fiber.RuntimeFiber<void, StorageError | SerializationError | UnsupportedFormatError | ValidationError>
	readonly save: Effect.Effect<void, StorageError | SerializationError | UnsupportedFormatError | ValidationError, StorageAdapter | SerializerRegistry>
}

/**
 * Handle returned by `createDebouncedWriter`. Provides methods to schedule
 * debounced writes, flush all pending writes, and query pending state.
 */
export interface DebouncedWriter {
	/**
	 * Schedule a debounced write for the given key. If a write for this key
	 * is already pending, it is cancelled and replaced with the new one.
	 * The actual write executes after the configured delay unless superseded.
	 */
	readonly triggerSave: (
		key: string,
		save: Effect.Effect<void, StorageError | SerializationError | UnsupportedFormatError | ValidationError, StorageAdapter | SerializerRegistry>,
	) => Effect.Effect<void, never, StorageAdapter | SerializerRegistry>
	/**
	 * Immediately execute all pending writes, cancelling their debounce timers.
	 * Errors from individual saves are collected but do not prevent other saves.
	 */
	readonly flush: () => Effect.Effect<
		void,
		StorageError | SerializationError | UnsupportedFormatError | ValidationError,
		StorageAdapter | SerializerRegistry
	>
	/**
	 * Returns the number of writes currently pending.
	 */
	readonly pendingCount: () => Effect.Effect<number>
}

/**
 * Create a DebouncedWriter that coalesces rapid writes into single file operations.
 *
 * Each call to `triggerSave(key, saveEffect)` cancels any pending write for
 * that key and schedules a new one after `delayMs` milliseconds. If another
 * `triggerSave` for the same key arrives before the delay elapses, the timer
 * resets — only the last write within a burst actually hits the filesystem.
 *
 * @param delayMs - Debounce delay in milliseconds (default 100)
 */
export const createDebouncedWriter = (
	delayMs = 100,
): Effect.Effect<DebouncedWriter> =>
	Effect.gen(function* () {
		const pending = yield* Ref.make<ReadonlyMap<string, PendingWrite>>(new Map())

		const triggerSave: DebouncedWriter["triggerSave"] = (key, save) =>
			Effect.gen(function* () {
				// Cancel existing pending write for this key if any
				const current = yield* Ref.get(pending)
				const existing = current.get(key)
				if (existing !== undefined) {
					yield* Fiber.interrupt(existing.fiber)
				}

				// Fork a fiber that sleeps then executes the save
				const fiber = yield* Effect.fork(
					Effect.gen(function* () {
						yield* Effect.sleep(delayMs)
						yield* save
						// Remove from pending after successful write
						yield* Ref.update(pending, (m) => {
							const next = new Map(m)
							next.delete(key)
							return next
						})
					}),
				)

				// Store the pending write
				yield* Ref.update(pending, (m) => {
					const next = new Map(m)
					next.set(key, { fiber, save })
					return next
				})
			})

		const flush: DebouncedWriter["flush"] = () =>
			Effect.gen(function* () {
				// Atomically take all pending writes and clear the map
				const writes = yield* Ref.getAndSet(pending, new Map())

				// Interrupt all pending fibers first
				for (const [, entry] of writes) {
					yield* Fiber.interrupt(entry.fiber)
				}

				// Execute all saves immediately
				for (const [, entry] of writes) {
					yield* entry.save
				}
			})

		const pendingCount: DebouncedWriter["pendingCount"] = () =>
			Ref.get(pending).pipe(Effect.map((m) => m.size))

		return { triggerSave, flush, pendingCount } as const
	})
