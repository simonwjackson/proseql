import { Context, Effect } from "effect"
import type { StorageError } from "../errors/storage-errors.js"

// ============================================================================
// StorageAdapter Effect Service
// ============================================================================

export interface StorageAdapterShape {
	readonly read: (path: string) => Effect.Effect<string, StorageError>
	readonly write: (path: string, data: string) => Effect.Effect<void, StorageError>
	readonly exists: (path: string) => Effect.Effect<boolean, StorageError>
	readonly remove: (path: string) => Effect.Effect<void, StorageError>
	readonly ensureDir: (path: string) => Effect.Effect<void, StorageError>
	readonly watch: (
		path: string,
		onChange: () => void,
	) => Effect.Effect</** stop watching */ () => void, StorageError>
}

export class StorageAdapter extends Context.Tag("StorageAdapter")<
	StorageAdapter,
	StorageAdapterShape
>() {}
