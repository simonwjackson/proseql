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

// Test schemas
const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	industry: z.string(),
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

const testConfig = {
	companies: {
		schema: CompanySchema,
		relationships: {
			employees: { type: "inverse" as const, target: "users" as const },
		},
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

describe("Cascade Debug", () => {
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

	it("should debug cascade delete", async () => {
		// Create company with employees
		const companyResult = await db.companies.createWithRelationships({
			name: "Acme Corp",
			industry: "Technology",
			employees: {
				$create: [
					{ name: "John", email: "john@acme.com" },
					{ name: "Jane", email: "jane@acme.com" },
				],
			},
		});
		expect(isOk(companyResult)).toBe(true);
		if (!isOk(companyResult)) return;

		console.log("Company created:", companyResult.data);
		console.log("Initial users:", testData.users);

		const initialUserCount = testData.users.length;

		// Delete company with cascade
		const deleteResult = await db.companies.deleteWithRelationships(
			companyResult.data.id,
			{
				include: {
					employees: "cascade",
				},
			},
		);

		console.log("Delete result:", deleteResult);
		if (isErr(deleteResult)) {
			console.log("Error:", deleteResult.error);
		} else {
			console.log("Delete data:", deleteResult.data);
			console.log("Cascaded:", deleteResult.data.cascaded);
		}

		console.log("Final users:", testData.users);
		console.log(
			"User count change:",
			initialUserCount,
			"->",
			testData.users.length,
		);
	});
});
