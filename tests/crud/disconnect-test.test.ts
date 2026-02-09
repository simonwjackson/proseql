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
	industry: z.string().optional(),
	addressId: z.string().nullable().optional(),
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

describe("Disconnect Test", () => {
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

	it("should disconnect a relationship", async () => {
		const company = unwrapResult(
			await db.companies.create({
				name: "Tech Corp",
				industry: "Technology",
			}),
		);

		const user = unwrapResult(
			await db.users.create({
				name: "John",
				email: "john@example.com",
				companyId: company.id,
			}),
		);

		console.log("User before disconnect:", user);

		// Disconnect company
		const updateResult = await db.users.updateWithRelationships(user.id, {
			company: {
				$disconnect: true,
			},
		});

		console.log("Update result:", updateResult);
		if (isErr(updateResult)) {
			console.log("Error details:", updateResult.error);
		}

		const updatedUser = unwrapResult(updateResult);
		expect(updatedUser.companyId).toBe(null);
	});
});
