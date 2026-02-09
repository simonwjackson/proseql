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

describe("Simple Relationship Test", () => {
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

	it("should have createWithRelationships method", () => {
		console.log("DB methods:", Object.keys(db.users));
		expect(typeof db.users.createWithRelationships).toBe("function");
	});

	it("should create a simple entity without relationships", async () => {
		const result = await db.companies.create({
			name: "Test Company",
		});

		console.log("Create result:", result);
		expect(isOk(result)).toBe(true);
		if (isOk(result)) {
			expect(result.data.name).toBe("Test Company");
		}
	});

	it("should create entity with relationship", async () => {
		// First create a company
		const companyResult = await db.companies.create({
			name: "Acme Corp",
		});

		console.log("Company result:", companyResult);
		expect(isOk(companyResult)).toBe(true);
		if (!isOk(companyResult)) return;

		// Check if createWithRelationships exists
		console.log("User methods:", Object.keys(db.users));

		// Try to create user with relationship
		if (typeof db.users.createWithRelationships === "function") {
			const userResult = await db.users.createWithRelationships({
				name: "John",
				email: "john@example.com",
				company: {
					$connect: { id: companyResult.data.id },
				},
			});

			console.log("User result:", userResult);
			expect(isOk(userResult)).toBe(true);
		} else {
			console.error("createWithRelationships method not found!");
		}
	});
});
