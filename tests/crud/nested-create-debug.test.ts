import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import { isOk, isErr, type Result } from "../../core/errors/legacy";
import type { GenerateDatabase } from "../../core/types/types";

/**
 * Safely unwrap a Result type after checking success
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
}

// Simple test schemas
const AddressSchema = z.object({
	id: z.string(),
	street: z.string(),
	city: z.string(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	addressId: z.string().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// Test configuration
const testConfig = {
	addresses: {
		schema: AddressSchema,
		relationships: {},
	},
	companies: {
		schema: CompanySchema,
		relationships: {
			address: {
				type: "ref" as const,
				target: "addresses" as const,
				foreignKey: "addressId",
			},
		},
	},
} as const;

describe("Debug Nested Create", () => {
	let testData: {
		addresses: z.infer<typeof AddressSchema>[];
		companies: z.infer<typeof CompanySchema>[];
	};
	let db: GenerateDatabase<typeof testConfig>;

	beforeEach(() => {
		testData = {
			addresses: [],
			companies: [],
		};
		db = createDatabase(testConfig, testData);
	});

	it("should debug nested address creation", async () => {
		const result = await db.companies.createWithRelationships({
			name: "Test Company",
			address: {
				$create: {
					street: "123 Main St",
					city: "San Francisco",
				},
			},
		});

		console.log("Create result:", result);

		if (isErr(result)) {
			console.log("Error:", result.error);
		} else {
			console.log("Company data:", result.data);
			console.log("Test data addresses:", testData.addresses);
			console.log("Test data companies:", testData.companies);
		}

		expect(isOk(result)).toBe(true);
		if (isOk(result)) {
			expect(result.data.addressId).toBeDefined();
			expect(testData.addresses).toHaveLength(1);
		}
	});
});
