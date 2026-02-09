/**
 * ID generation utility with uniqueness guarantees
 * Provides various ID generation strategies for database entities
 */

// ============================================================================
// ID Generation Strategies
// ============================================================================

/**
 * Counter for sequential IDs within a process
 * Reset on process restart
 */
let sequentialCounter = 0;

/**
 * Generate a timestamp-based ID with microsecond precision
 * Format: timestamp-random-counter
 * Example: "1704067200000-a3f2-0001"
 */
export function generateTimestampId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 6);
	const counter = (++sequentialCounter).toString().padStart(4, "0");
	return `${timestamp}-${random}-${counter}`;
}

/**
 * Generate a nano ID - URL-safe, short, unique identifier
 * Uses a larger alphabet for better uniqueness in shorter strings
 */
export function generateNanoId(length: number = 21): string {
	const alphabet =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
	let id = "";

	// Use crypto for better randomness if available
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);
		for (let i = 0; i < length; i++) {
			id += alphabet[bytes[i] % alphabet.length];
		}
	} else {
		// Fallback to Math.random
		for (let i = 0; i < length; i++) {
			id += alphabet[Math.floor(Math.random() * alphabet.length)];
		}
	}

	return id;
}

/**
 * Generate a UUID v4 compliant identifier
 * Standard format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}

	// Fallback implementation
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Generate a prefixed ID for better organization
 * Format: prefix_id
 * Example: "user_1704067200000-a3f2-0001"
 */
export function generatePrefixedId(prefix: string): string {
	const id = generateTimestampId();
	return `${prefix}_${id}`;
}

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Sortable by creation time, case-insensitive
 */
export function generateULID(): string {
	const timestamp = Date.now();
	const timestampChars = encodeTime(timestamp, 10);
	const randomChars = encodeRandom(16);
	return timestampChars + randomChars;
}

// ULID helper functions
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's Base32

function encodeTime(timestamp: number, length: number): string {
	let str = "";
	for (let i = length - 1; i >= 0; i--) {
		const mod = timestamp % ENCODING.length;
		str = ENCODING[mod] + str;
		timestamp = Math.floor(timestamp / ENCODING.length);
	}
	return str;
}

function encodeRandom(length: number): string {
	let str = "";
	for (let i = 0; i < length; i++) {
		str += ENCODING[Math.floor(Math.random() * ENCODING.length)];
	}
	return str;
}

/**
 * Generate a sortable ID that includes type information
 * Format: type:timestamp:random
 * Example: "user:1704067200000:a3f2"
 */
export function generateTypedId(type: string): string {
	const timestamp = Date.now();
	const random = generateNanoId(4);
	return `${type}:${timestamp}:${random}`;
}

// ============================================================================
// ID Validation
// ============================================================================

/**
 * Check if a string is a valid ID format
 */
export function isValidId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && !id.includes("\0");
}

/**
 * Check if ID matches expected format
 */
export function isValidIdFormat(
	id: string,
	format: "uuid" | "ulid" | "timestamp" | "nano",
): boolean {
	switch (format) {
		case "uuid":
			return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				id,
			);
		case "ulid":
			return /^[0-9A-Z]{26}$/i.test(id);
		case "timestamp":
			return /^\d{13}-[a-z0-9]{4}-\d{4}$/.test(id);
		case "nano":
			return /^[0-9A-Za-z_-]+$/.test(id);
		default:
			return false;
	}
}

// ============================================================================
// ID Generator Configuration
// ============================================================================

export type IdGeneratorConfig = {
	strategy: "timestamp" | "nano" | "uuid" | "ulid" | "prefixed" | "typed";
	prefix?: string; // For prefixed strategy
	type?: string; // For typed strategy
	length?: number; // For nano strategy
};

/**
 * Default ID generator configuration
 */
export const defaultIdConfig: IdGeneratorConfig = {
	strategy: "nano",
	length: 21,
};

/**
 * Create an ID generator with specific configuration
 */
export function createIdGenerator(
	config: IdGeneratorConfig = defaultIdConfig,
): () => string {
	switch (config.strategy) {
		case "timestamp":
			return generateTimestampId;
		case "nano":
			return () => generateNanoId(config.length);
		case "uuid":
			return generateUUID;
		case "ulid":
			return generateULID;
		case "prefixed":
			if (!config.prefix) {
				throw new Error("Prefix required for prefixed ID strategy");
			}
			return () => generatePrefixedId(config.prefix!);
		case "typed":
			if (!config.type) {
				throw new Error("Type required for typed ID strategy");
			}
			return () => generateTypedId(config.type!);
		default:
			throw new Error(
				`Unknown ID strategy: ${(config as IdGeneratorConfig).strategy}`,
			);
	}
}

// ============================================================================
// Default Export
// ============================================================================

/**
 * Default ID generator using nano ID strategy
 */
export const generateId = createIdGenerator(defaultIdConfig);

/**
 * Collection-specific ID generators
 * Allows different ID strategies per collection
 */
export class CollectionIdGenerators {
	private generators: Map<string, () => string> = new Map();
	private defaultGenerator: () => string;

	constructor(defaultConfig: IdGeneratorConfig = defaultIdConfig) {
		this.defaultGenerator = createIdGenerator(defaultConfig);
	}

	/**
	 * Register a custom ID generator for a collection
	 */
	register(collection: string, config: IdGeneratorConfig): void {
		this.generators.set(collection, createIdGenerator(config));
	}

	/**
	 * Get ID generator for a collection
	 */
	getGenerator(collection: string): () => string {
		return this.generators.get(collection) || this.defaultGenerator;
	}

	/**
	 * Generate ID for a collection
	 */
	generateFor(collection: string): string {
		return this.getGenerator(collection)();
	}
}

// ============================================================================
// ID Utilities
// ============================================================================

/**
 * Extract timestamp from timestamp-based IDs
 */
export function extractTimestamp(id: string): number | null {
	// Handle timestamp format
	const timestampMatch = id.match(/^(\d{13})-/);
	if (timestampMatch) {
		return parseInt(timestampMatch[1], 10);
	}

	// Handle typed format
	const typedMatch = id.match(/:(\d{13}):/);
	if (typedMatch) {
		return parseInt(typedMatch[1], 10);
	}

	return null;
}

/**
 * Extract type from typed IDs
 */
export function extractType(id: string): string | null {
	const match = id.match(/^([^:]+):/);
	return match ? match[1] : null;
}

/**
 * Compare IDs for sorting (works with timestamp-based IDs)
 */
export function compareIds(a: string, b: string): number {
	const timestampA = extractTimestamp(a);
	const timestampB = extractTimestamp(b);

	if (timestampA !== null && timestampB !== null) {
		return timestampA - timestampB;
	}

	// Fallback to string comparison
	return a.localeCompare(b);
}
