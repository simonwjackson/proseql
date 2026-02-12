/**
 * Deterministic data generators for ProseQL benchmarks.
 *
 * All generators use a seeded pseudo-random number generator to ensure
 * reproducible output across benchmark runs.
 */

// ============================================================================
// Seeded Pseudo-Random Number Generator
// ============================================================================

/**
 * A seeded pseudo-random number generator using the Mulberry32 algorithm.
 *
 * Mulberry32 is a simple 32-bit generator with good statistical properties
 * and fast execution. It's suitable for benchmark data generation where
 * cryptographic security is not required.
 *
 * @example
 * ```ts
 * const rng = createSeededRng(12345);
 * const a = rng(); // 0.0 <= a < 1.0
 * const b = rng(); // different value, but deterministic
 *
 * // Same seed produces same sequence
 * const rng2 = createSeededRng(12345);
 * rng2() === a; // true
 * rng2() === b; // true
 * ```
 */
export function createSeededRng(seed: number): () => number {
	let state = seed >>> 0; // Ensure unsigned 32-bit

	return (): number => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Default seed for benchmark data generation.
 * Using a fixed seed ensures all benchmark runs operate on identical data.
 */
export const DEFAULT_SEED = 42;

// ============================================================================
// Random Value Helpers
// ============================================================================

/**
 * Pick a random element from an array using the provided RNG.
 *
 * @param rng - Seeded random number generator
 * @param arr - Array to pick from
 * @returns A random element from the array
 */
export function pickRandom<T>(rng: () => number, arr: ReadonlyArray<T>): T {
	const index = Math.floor(rng() * arr.length);
	return arr[index];
}

/**
 * Generate a random integer in the range [min, max] (inclusive).
 *
 * @param rng - Seeded random number generator
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer in range
 */
export function randomInt(rng: () => number, min: number, max: number): number {
	return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Generate a random float in the range [min, max).
 *
 * @param rng - Seeded random number generator
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (exclusive)
 * @returns Random float in range
 */
export function randomFloat(
	rng: () => number,
	min: number,
	max: number,
): number {
	return rng() * (max - min) + min;
}

/**
 * Generate a random string of specified length using alphanumeric characters.
 *
 * @param rng - Seeded random number generator
 * @param length - Length of the string to generate
 * @returns Random alphanumeric string
 */
export function randomString(rng: () => number, length: number): string {
	const chars =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars[Math.floor(rng() * chars.length)];
	}
	return result;
}

/**
 * Generate a random date within a specified range.
 *
 * @param rng - Seeded random number generator
 * @param startYear - Start year (inclusive)
 * @param endYear - End year (inclusive)
 * @returns ISO date string
 */
export function randomDate(
	rng: () => number,
	startYear: number,
	endYear: number,
): string {
	const start = new Date(startYear, 0, 1).getTime();
	const end = new Date(endYear, 11, 31).getTime();
	const timestamp = Math.floor(rng() * (end - start)) + start;
	return new Date(timestamp).toISOString();
}

/**
 * Generate a random boolean with optional probability.
 *
 * @param rng - Seeded random number generator
 * @param probability - Probability of returning true (default 0.5)
 * @returns Random boolean
 */
export function randomBoolean(rng: () => number, probability = 0.5): boolean {
	return rng() < probability;
}

// ============================================================================
// Standard Collection Sizes
// ============================================================================

/**
 * Standard collection sizes for benchmarking.
 * Used to test scaling behavior across different data volumes.
 */
export const STANDARD_SIZES = [100, 1_000, 10_000, 100_000] as const;

/**
 * Type for standard collection sizes.
 */
export type StandardSize = (typeof STANDARD_SIZES)[number];

// ============================================================================
// Entity Types
// ============================================================================

/**
 * User entity type for benchmarks.
 */
export interface User {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly age: number;
	readonly role: "admin" | "moderator" | "user";
	readonly createdAt: string;
}

// ============================================================================
// Data Pools for Realistic Generation
// ============================================================================

/**
 * Pool of first names for user generation.
 */
const FIRST_NAMES = [
	"Alice",
	"Bob",
	"Carol",
	"David",
	"Eve",
	"Frank",
	"Grace",
	"Henry",
	"Iris",
	"Jack",
	"Kate",
	"Leo",
	"Mia",
	"Noah",
	"Olivia",
	"Paul",
	"Quinn",
	"Rose",
	"Sam",
	"Tara",
	"Uma",
	"Victor",
	"Wendy",
	"Xavier",
	"Yara",
	"Zach",
] as const;

/**
 * Pool of last names for user generation.
 */
const LAST_NAMES = [
	"Anderson",
	"Brown",
	"Chen",
	"Davis",
	"Edwards",
	"Foster",
	"Garcia",
	"Harris",
	"Ivanov",
	"Johnson",
	"Kim",
	"Lee",
	"Martinez",
	"Nguyen",
	"O'Brien",
	"Patel",
	"Quinn",
	"Roberts",
	"Smith",
	"Taylor",
	"Ueda",
	"Vance",
	"Williams",
	"Xu",
	"Young",
	"Zhang",
] as const;

/**
 * Pool of email domains for user generation.
 */
const EMAIL_DOMAINS = [
	"example.com",
	"test.org",
	"mail.net",
	"demo.io",
	"sample.co",
] as const;

/**
 * Pool of roles for user generation.
 */
const ROLES = ["admin", "moderator", "user"] as const;

// ============================================================================
// Entity Generators
// ============================================================================

/**
 * Generate an array of User entities with deterministic, reproducible data.
 *
 * Users have realistic-looking names, emails, ages, and roles. The same
 * seed will always produce the same sequence of users.
 *
 * @param count - Number of users to generate
 * @param seed - Optional seed for the RNG (default: DEFAULT_SEED)
 * @returns Array of User entities
 *
 * @example
 * ```ts
 * const users = generateUsers(1000);
 * // Always produces the same 1000 users
 *
 * const customUsers = generateUsers(100, 12345);
 * // Uses custom seed for different but still reproducible data
 * ```
 */
export function generateUsers(count: number, seed: number = DEFAULT_SEED): ReadonlyArray<User> {
	const rng = createSeededRng(seed);
	const users: User[] = [];

	for (let i = 0; i < count; i++) {
		const firstName = pickRandom(rng, FIRST_NAMES);
		const lastName = pickRandom(rng, LAST_NAMES);
		const domain = pickRandom(rng, EMAIL_DOMAINS);
		const emailSuffix = randomInt(rng, 1, 9999);

		users.push({
			id: `user_${String(i + 1).padStart(6, "0")}`,
			name: `${firstName} ${lastName}`,
			email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${emailSuffix}@${domain}`,
			age: randomInt(rng, 18, 80),
			role: pickRandom(rng, ROLES),
			createdAt: randomDate(rng, 2020, 2024),
		});
	}

	return users;
}
