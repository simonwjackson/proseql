import { Context, type Effect } from "effect";
import type {
	StorageError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js";

// ============================================================================
// StorageAdapter Effect Service
// ============================================================================

/**
 * Error types that can occur during storage read/write operations.
 * Includes StorageError for I/O failures and UnsupportedFormatError
 * for format validation (e.g., when allowedFormats config is set).
 */
export type StorageReadWriteError = StorageError | UnsupportedFormatError;

export interface StorageAdapterShape {
	readonly read: (path: string) => Effect.Effect<string, StorageReadWriteError>;
	readonly write: (
		path: string,
		data: string,
	) => Effect.Effect<void, StorageReadWriteError>;
	readonly append: (
		path: string,
		data: string,
	) => Effect.Effect<void, StorageReadWriteError>;
	readonly exists: (path: string) => Effect.Effect<boolean, StorageError>;
	readonly remove: (path: string) => Effect.Effect<void, StorageError>;
	readonly ensureDir: (path: string) => Effect.Effect<void, StorageError>;
	readonly watch: (
		path: string,
		onChange: () => void,
	) => Effect.Effect</** stop watching */ () => void, StorageError>;
}

export class StorageAdapter extends Context.Tag("StorageAdapter")<
	StorageAdapter,
	StorageAdapterShape
>() {}
