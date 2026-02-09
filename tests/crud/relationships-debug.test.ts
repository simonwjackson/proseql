import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import { isOk, isErr } from "../../core/errors/legacy";
import type { GenerateDatabase } from "../../core/types/types";

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
	companyId: z.string().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// Test configuration
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

describe("Debug Relationship Creation", () => {
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

	it("should debug createWithRelationships", async () => {
		// First create a company
		const companyResult = await db.companies.create({
			name: "Test Company",
		});

		console.log("Company create result:", companyResult);
		expect(isOk(companyResult)).toBe(true);
		if (!isOk(companyResult)) return;

		// Try to create user with relationship
		const userResult = await db.users.createWithRelationships({
			name: "John",
			email: "john@example.com",
			company: {
				$connect: { id: companyResult.data.id },
			},
		});

		console.log("User create result:", userResult);

		if (isErr(userResult)) {
			console.log("Error details:", userResult.error);
			console.log("Error code:", userResult.error.code);
			console.log("Error message:", userResult.error.message);
			if ("errors" in userResult.error) {
				console.log("Validation errors:", userResult.error.errors);
			}
		}

		expect(isOk(userResult)).toBe(true);
	});

	it("should test nested creation", async () => {
		const result = await db.companies.createWithRelationships({
			name: "Acme Corp",
			employees: {
				$create: [
					{
						name: "Alice",
						email: "alice@acme.com",
					},
				],
			},
		});

		console.log("Nested create result:", result);

		if (isErr(result)) {
			console.log("Error details:", result.error);
			console.log("Error code:", result.error.code);
			console.log("Error message:", result.error.message);
			if ("errors" in result.error) {
				console.log("Validation errors:", result.error.errors);
			}
		}

		expect(isOk(result)).toBe(true);
	});
});
