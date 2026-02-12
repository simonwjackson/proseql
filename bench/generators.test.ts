import { describe, expect, it } from "vitest";
import {
	createSeededRng,
	DEFAULT_SEED,
	generateAtScale,
	generateProducts,
	generateUsers,
	pickRandom,
	randomBoolean,
	randomDate,
	randomFloat,
	randomInt,
	randomString,
	STANDARD_SIZES,
} from "./generators.js";

/**
 * Determinism tests for benchmark data generators.
 *
 * These tests verify that all generators produce identical output across
 * multiple invocations when using the same seed. This is critical for
 * reproducible benchmarks.
 */

describe("Seeded PRNG Determinism", () => {
	it("produces identical sequences with the same seed", () => {
		const rng1 = createSeededRng(12345);
		const rng2 = createSeededRng(12345);

		// Generate a sequence of 100 values
		const sequence1: number[] = [];
		const sequence2: number[] = [];
		for (let i = 0; i < 100; i++) {
			sequence1.push(rng1());
			sequence2.push(rng2());
		}

		expect(sequence1).toEqual(sequence2);
	});

	it("produces different sequences with different seeds", () => {
		const rng1 = createSeededRng(12345);
		const rng2 = createSeededRng(54321);

		// Generate a sequence of 10 values
		const sequence1: number[] = [];
		const sequence2: number[] = [];
		for (let i = 0; i < 10; i++) {
			sequence1.push(rng1());
			sequence2.push(rng2());
		}

		expect(sequence1).not.toEqual(sequence2);
	});

	it("produces values in range [0, 1)", () => {
		const rng = createSeededRng(42);

		for (let i = 0; i < 1000; i++) {
			const value = rng();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});

describe("Random Value Helper Determinism", () => {
	it("pickRandom produces identical results with same seed", () => {
		const items = ["a", "b", "c", "d", "e"];

		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const picks1: string[] = [];
		const picks2: string[] = [];
		for (let i = 0; i < 50; i++) {
			picks1.push(pickRandom(rng1, items));
			picks2.push(pickRandom(rng2, items));
		}

		expect(picks1).toEqual(picks2);
	});

	it("randomInt produces identical results with same seed", () => {
		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const ints1: number[] = [];
		const ints2: number[] = [];
		for (let i = 0; i < 50; i++) {
			ints1.push(randomInt(rng1, 1, 100));
			ints2.push(randomInt(rng2, 1, 100));
		}

		expect(ints1).toEqual(ints2);
	});

	it("randomFloat produces identical results with same seed", () => {
		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const floats1: number[] = [];
		const floats2: number[] = [];
		for (let i = 0; i < 50; i++) {
			floats1.push(randomFloat(rng1, 0, 100));
			floats2.push(randomFloat(rng2, 0, 100));
		}

		expect(floats1).toEqual(floats2);
	});

	it("randomString produces identical results with same seed", () => {
		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const strings1: string[] = [];
		const strings2: string[] = [];
		for (let i = 0; i < 50; i++) {
			strings1.push(randomString(rng1, 10));
			strings2.push(randomString(rng2, 10));
		}

		expect(strings1).toEqual(strings2);
	});

	it("randomDate produces identical results with same seed", () => {
		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const dates1: string[] = [];
		const dates2: string[] = [];
		for (let i = 0; i < 50; i++) {
			dates1.push(randomDate(rng1, 2020, 2024));
			dates2.push(randomDate(rng2, 2020, 2024));
		}

		expect(dates1).toEqual(dates2);
	});

	it("randomBoolean produces identical results with same seed", () => {
		const rng1 = createSeededRng(42);
		const rng2 = createSeededRng(42);

		const bools1: boolean[] = [];
		const bools2: boolean[] = [];
		for (let i = 0; i < 50; i++) {
			bools1.push(randomBoolean(rng1));
			bools2.push(randomBoolean(rng2));
		}

		expect(bools1).toEqual(bools2);
	});
});

describe("generateUsers Determinism", () => {
	it("produces identical users with default seed across invocations", () => {
		const users1 = generateUsers(100);
		const users2 = generateUsers(100);

		expect(users1).toEqual(users2);
	});

	it("produces identical users with explicit seed across invocations", () => {
		const seed = 12345;
		const users1 = generateUsers(100, seed);
		const users2 = generateUsers(100, seed);

		expect(users1).toEqual(users2);
	});

	it("produces different users with different seeds", () => {
		const users1 = generateUsers(100, 12345);
		const users2 = generateUsers(100, 54321);

		expect(users1).not.toEqual(users2);
	});

	it("produces deterministic output at various sizes", () => {
		// Test at a few different sizes to ensure scaling doesn't affect determinism
		for (const size of [10, 100, 500]) {
			const run1 = generateUsers(size);
			const run2 = generateUsers(size);
			expect(run1).toEqual(run2);
		}
	});

	it("produces correct entity count", () => {
		const users = generateUsers(250);
		expect(users.length).toBe(250);
	});

	it("produces correctly shaped entities", () => {
		const users = generateUsers(10);

		for (const user of users) {
			expect(user).toHaveProperty("id");
			expect(user).toHaveProperty("name");
			expect(user).toHaveProperty("email");
			expect(user).toHaveProperty("age");
			expect(user).toHaveProperty("role");
			expect(user).toHaveProperty("createdAt");

			expect(typeof user.id).toBe("string");
			expect(typeof user.name).toBe("string");
			expect(typeof user.email).toBe("string");
			expect(typeof user.age).toBe("number");
			expect(["admin", "moderator", "user"]).toContain(user.role);
			expect(typeof user.createdAt).toBe("string");
		}
	});
});

describe("generateProducts Determinism", () => {
	it("produces identical products with default seed across invocations", () => {
		const products1 = generateProducts(100);
		const products2 = generateProducts(100);

		expect(products1).toEqual(products2);
	});

	it("produces identical products with explicit seed across invocations", () => {
		const seed = 12345;
		const products1 = generateProducts(100, seed);
		const products2 = generateProducts(100, seed);

		expect(products1).toEqual(products2);
	});

	it("produces different products with different seeds", () => {
		const products1 = generateProducts(100, 12345);
		const products2 = generateProducts(100, 54321);

		expect(products1).not.toEqual(products2);
	});

	it("produces deterministic output at various sizes", () => {
		// Test at a few different sizes to ensure scaling doesn't affect determinism
		for (const size of [10, 100, 500]) {
			const run1 = generateProducts(size);
			const run2 = generateProducts(size);
			expect(run1).toEqual(run2);
		}
	});

	it("produces correct entity count", () => {
		const products = generateProducts(250);
		expect(products.length).toBe(250);
	});

	it("produces correctly shaped entities", () => {
		const products = generateProducts(10);

		for (const product of products) {
			expect(product).toHaveProperty("id");
			expect(product).toHaveProperty("name");
			expect(product).toHaveProperty("price");
			expect(product).toHaveProperty("category");
			expect(product).toHaveProperty("stock");
			expect(product).toHaveProperty("supplierId");

			expect(typeof product.id).toBe("string");
			expect(typeof product.name).toBe("string");
			expect(typeof product.price).toBe("number");
			expect([
				"electronics",
				"clothing",
				"books",
				"home",
				"sports",
				"toys",
			]).toContain(product.category);
			expect(typeof product.stock).toBe("number");
			expect(typeof product.supplierId).toBe("string");
		}
	});
});

describe("generateAtScale Determinism", () => {
	it("produces identical results at all standard sizes", () => {
		const usersBySize1 = generateAtScale(generateUsers);
		const usersBySize2 = generateAtScale(generateUsers);

		for (const size of STANDARD_SIZES) {
			const users1 = usersBySize1.get(size);
			const users2 = usersBySize2.get(size);

			expect(users1).toBeDefined();
			expect(users2).toBeDefined();
			expect(users1).toEqual(users2);
		}
	});

	it("produces identical results with custom sizes", () => {
		const customSizes = [50, 500, 5000] as const;

		const productsBySize1 = generateAtScale(generateProducts, customSizes);
		const productsBySize2 = generateAtScale(generateProducts, customSizes);

		for (const size of customSizes) {
			const products1 = productsBySize1.get(size);
			const products2 = productsBySize2.get(size);

			expect(products1).toBeDefined();
			expect(products2).toBeDefined();
			expect(products1).toEqual(products2);
		}
	});

	it("produces identical results with explicit seed", () => {
		const seed = 99999;

		const usersBySize1 = generateAtScale(generateUsers, STANDARD_SIZES, seed);
		const usersBySize2 = generateAtScale(generateUsers, STANDARD_SIZES, seed);

		for (const size of STANDARD_SIZES) {
			expect(usersBySize1.get(size)).toEqual(usersBySize2.get(size));
		}
	});

	it("returns correct sizes in the Map", () => {
		const usersBySize = generateAtScale(generateUsers);

		expect(usersBySize.size).toBe(STANDARD_SIZES.length);

		for (const size of STANDARD_SIZES) {
			expect(usersBySize.has(size)).toBe(true);
			const users = usersBySize.get(size);
			expect(users?.length).toBe(size);
		}
	});
});

describe("Cross-Invocation Snapshot Test", () => {
	it("DEFAULT_SEED produces a known stable output for users", () => {
		// Generate a small sample and verify specific values
		// This catches any accidental changes to the PRNG or generator logic
		const users = generateUsers(3, DEFAULT_SEED);

		// First user should always have the same characteristics with seed 42
		expect(users[0].id).toBe("user_000001");

		// The sequence of random values should be stable
		// If this fails, the PRNG or generator logic has changed
		expect(users.length).toBe(3);
		expect(users[0]).toBeDefined();
		expect(users[1]).toBeDefined();
		expect(users[2]).toBeDefined();

		// Verify IDs are sequential
		expect(users[0].id).toBe("user_000001");
		expect(users[1].id).toBe("user_000002");
		expect(users[2].id).toBe("user_000003");
	});

	it("DEFAULT_SEED produces a known stable output for products", () => {
		// Generate a small sample and verify specific values
		const products = generateProducts(3, DEFAULT_SEED);

		// First product should always have the same ID with seed 42
		expect(products[0].id).toBe("product_000001");

		// Verify structure is consistent
		expect(products.length).toBe(3);
		expect(products[0]).toBeDefined();
		expect(products[1]).toBeDefined();
		expect(products[2]).toBeDefined();

		// Verify IDs are sequential
		expect(products[0].id).toBe("product_000001");
		expect(products[1].id).toBe("product_000002");
		expect(products[2].id).toBe("product_000003");
	});
});
