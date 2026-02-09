/**
 * Storage adapter types for the persistence system.
 * Provides a pluggable interface for different storage backends.
 */

/**
 * Storage adapter interface that abstracts filesystem and other storage operations.
 * This allows the persistence system to work with different storage backends
 * (filesystem, S3, browser localStorage, etc.)
 */
export type StorageAdapter = {
	/**
	 * Read data from the specified path
	 *
	 * @param path - The path to read from
	 * @returns Promise resolving to the raw data as Buffer or string
	 * @throws {StorageError} If the file cannot be read
	 */
	read: (path: string) => Promise<Buffer | string>;

	/**
	 * Write data to the specified path atomically
	 *
	 * @param path - The path to write to
	 * @param data - The data to write (Buffer or string)
	 * @returns Promise that resolves when write is complete
	 * @throws {StorageError} If the write operation fails
	 */
	write: (path: string, data: Buffer | string) => Promise<void>;

	/**
	 * Check if a file or path exists
	 *
	 * @param path - The path to check
	 * @returns Promise resolving to true if the path exists, false otherwise
	 */
	exists: (path: string) => Promise<boolean>;

	/**
	 * Watch a file for changes and call the callback when it changes
	 *
	 * @param path - The path to watch
	 * @param callback - Function to call when the file changes
	 * @returns Function to call to stop watching
	 */
	watch: (path: string, callback: () => void) => () => void;

	/**
	 * Ensure that the directory for the given path exists
	 *
	 * @param path - The file path (directory will be extracted from this)
	 * @returns Promise that resolves when the directory exists
	 * @throws {StorageError} If the directory cannot be created
	 */
	ensureDir: (path: string) => Promise<void>;
};

/**
 * Error thrown by storage operations
 */
export class StorageError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly cause?: unknown,
		public readonly operation?:
			| "read"
			| "write"
			| "exists"
			| "watch"
			| "ensureDir",
	) {
		super(message);
		this.name = "StorageError";
	}
}

/**
 * Configuration options for storage adapters
 */
export type StorageAdapterOptions = {
	/**
	 * Maximum number of retry attempts for failed operations
	 */
	readonly maxRetries?: number;

	/**
	 * Delay between retry attempts in milliseconds
	 */
	readonly retryDelay?: number;

	/**
	 * Whether to create missing directories automatically
	 */
	readonly createMissingDirectories?: boolean;

	/**
	 * File permissions to use when creating files (Node.js specific)
	 */
	readonly fileMode?: number;

	/**
	 * Directory permissions to use when creating directories (Node.js specific)
	 */
	readonly dirMode?: number;
};
