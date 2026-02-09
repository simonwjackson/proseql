import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import { isOk, type Result } from "../../core/errors/crud-errors";
import { collect } from "../../core/utils/async-iterable.js";
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
const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	companyId: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// Test configuration
const testConfig = {
	companies: {
		schema: CompanySchema,
		relationships: {},
	},
	users: {
		schema: UserSchema,
		relationships: {
			company: {
				type: "ref" as const,
				target: "companies" as const,
				foreignKey: "companyId",
			},
		},
	},
} as const;

describe("Debug Connect", () => {
	let testData: {
		companies: z.infer<typeof CompanySchema>[];
		users: z.infer<typeof UserSchema>[];
	};
	let db: GenerateDatabase<typeof testConfig>;

	beforeEach(() => {
		testData = {
			companies: [],
			users: [],
		};
		db = createDatabase(testConfig, testData);
	});

	it("should debug connect and query", async () => {
		// Create company
		const companyResult = await db.companies.create({
			name: "Test Company",
		});
		expect(isOk(companyResult)).toBe(true);
		if (!isOk(companyResult)) return;

		// Create user with company connection
		const userResult = await db.users.createWithRelationships({
			name: "John Doe",
			email: "john@example.com",
			company: {
				$connect: { id: companyResult.data.id },
			},
		} as Parameters<typeof db.users.createWithRelationships>[0]);

		expect(isOk(userResult)).toBe(true);
		if (!isOk(userResult)) return;

		console.log("Created user:", userResult.data);

		// Test query with populate
		const queryResult = await collect(
			db.users.query({
				where: { id: userResult.data.id },
				populate: { company: true },
			}),
		);

		console.log("Query result:", queryResult);

		// Check if company is populated
		expect(queryResult).toHaveLength(1);
		const user = queryResult[0] as (typeof queryResult)[0] & {
			company?: z.infer<typeof CompanySchema>;
		};
		if (user) {
			console.log("User company:", user.company);
			// Verify the user has the expected properties
			expect(user.id).toBe(userResult.data.id);
			expect(user.name).toBe("John Doe");
			// Verify the company relationship is populated
			expect(user.company).toBeDefined();
			expect(user.company?.id).toBe(companyResult.data.id);
		}
	});
});
