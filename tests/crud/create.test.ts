import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import { isOk, isErr } from "../../core/errors/legacy";
import { collect } from "../../core/utils/async-iterable.js";
import type { LegacyCrudError as CrudError } from "../../core/errors/legacy";
import type {
	CreateInput,
	CreateManyResult,
} from "../../core/types/crud-types";
import type { CrudMethods } from "../../core/factories/crud-factory";
import type { RelationshipDef } from "../../core/types/types";

// Test schemas
const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	age: z.number().min(0).max(150),
	companyId: z.string(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

const CompanySchema = z.object({
	id: z.string(),
	name: z.string(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// Type for our test entities
type User = z.infer<typeof UserSchema>;
type Company = z.infer<typeof CompanySchema>;

// Ensure our test entities satisfy BaseEntity constraint
type UserEntity = User & { id: string };
type CompanyEntity = Company & { id: string };

// Type for collections with CRUD methods - using simplified types
type UserCollection = {
	query: (config?: {
		where?: unknown;
		sort?: unknown;
		select?: unknown;
		limit?: number;
		offset?: number;
	}) => AsyncIterable<User>;
} & CrudMethods<UserEntity, Record<string, RelationshipDef<unknown>>, unknown>;

type CompanyCollection = {
	query: (config?: {
		where?: unknown;
		sort?: unknown;
		select?: unknown;
		limit?: number;
		offset?: number;
	}) => AsyncIterable<Company>;
} & CrudMethods<
	CompanyEntity,
	Record<string, RelationshipDef<unknown>>,
	unknown
>;

// Database type with properly typed collections
type TestDatabase = {
	users: UserCollection;
	companies: CompanyCollection;
};

describe("CRUD Create Operations", () => {
	// Test configuration
	const config = {
		users: {
			schema: UserSchema,
			relationships: {
				company: { type: "ref" as const, target: "companies" as const },
			},
		},
		companies: {
			schema: CompanySchema,
			relationships: {
				users: { type: "inverse" as const, target: "users" as const },
			},
		},
	} as const;

	// Test data
	let testData: {
		users: User[];
		companies: Company[];
	};

	beforeEach(() => {
		testData = {
			users: [],
			companies: [
				{ id: "comp1", name: "TechCorp" },
				{ id: "comp2", name: "DataInc" },
			],
		};
	});

	describe("create method", () => {
		it("should create a new entity with auto-generated ID", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.create({
				name: "John Doe",
				email: "john@example.com",
				age: 30,
				companyId: "comp1",
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.name).toBe("John Doe");
				expect(result.data.email).toBe("john@example.com");
				expect(result.data.age).toBe(30);
				expect(result.data.companyId).toBe("comp1");
				expect(result.data.id).toBeDefined();
				expect(result.data.createdAt).toBeDefined();
				expect(result.data.updatedAt).toBeDefined();
				expect(result.data.createdAt).toBe(result.data.updatedAt);
			}

			// Verify entity was added to database
			const allUsers = await collect(db.users.query());
			expect(allUsers).toHaveLength(1);
			expect(allUsers[0]?.name).toBe("John Doe");
		});

		it("should create entity with custom ID", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.create({
				id: "custom-user-id",
				name: "Jane Smith",
				email: "jane@example.com",
				age: 25,
				companyId: "comp2",
			});

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.id).toBe("custom-user-id");
				expect(result.data.name).toBe("Jane Smith");
			}
		});

		it("should fail with duplicate ID", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			// Create first user
			const result1 = await db.users.create({
				id: "user123",
				name: "User One",
				email: "user1@example.com",
				age: 30,
				companyId: "comp1",
			});

			expect(isOk(result1)).toBe(true);

			// Try to create with same ID
			const result2 = await db.users.create({
				id: "user123",
				name: "User Two",
				email: "user2@example.com",
				age: 35,
				companyId: "comp1",
			});

			expect(isErr(result2)).toBe(true);
			if (isErr(result2)) {
				expect(result2.error.code).toBe("DUPLICATE_KEY");
				if (result2.error.code === "DUPLICATE_KEY") {
					expect(result2.error.field).toBe("id");
					expect(result2.error.value).toBe("user123");
				}
			}
		});

		it("should validate required fields", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			// Missing required field - create an object with missing email field
			// We use a type that explicitly omits the required email field
			type IncompleteUserInput = Omit<CreateInput<UserEntity>, "email">;
			const incompleteUser: IncompleteUserInput = {
				name: "Invalid User",
				// email is missing
				age: 30,
				companyId: "comp1",
			};

			// TypeScript will still complain here because create expects a complete user,
			// but we're intentionally testing validation, so we use a properly typed incomplete input
			// This is the only acceptable use of type assertion in this file for testing validation
			const result = await db.users.create(
				incompleteUser as CreateInput<UserEntity>,
			);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("VALIDATION_ERROR");
				if (result.error.code === "VALIDATION_ERROR") {
					expect(result.error.errors).toHaveLength(1);
					expect(result.error.errors[0]?.field).toBe("email");
				}
			}
		});

		it("should validate field types", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.create({
				name: "Invalid User",
				email: "not-an-email", // Invalid email format
				age: 30,
				companyId: "comp1",
			});

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("VALIDATION_ERROR");
				if (
					result.error.code === "VALIDATION_ERROR" &&
					result.error.errors &&
					result.error.errors[0]
				) {
					expect(result.error.errors[0].field).toBe("email");
				}
			}
		});

		it("should validate foreign key constraints", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.create({
				name: "John Doe",
				email: "john@example.com",
				age: 30,
				companyId: "non-existent-company",
			});

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("VALIDATION_ERROR");
				if (
					result.error.code === "VALIDATION_ERROR" &&
					result.error.errors &&
					result.error.errors[0]
				) {
					expect(result.error.errors[0].field).toBe("companyId");
					// Note: individual error fields don't have a code property in this version
				}
			}
		});
	});

	describe("createMany method", () => {
		it("should create multiple entities", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.createMany([
				{
					name: "User 1",
					email: "user1@example.com",
					age: 25,
					companyId: "comp1",
				},
				{
					name: "User 2",
					email: "user2@example.com",
					age: 30,
					companyId: "comp2",
				},
				{
					name: "User 3",
					email: "user3@example.com",
					age: 35,
					companyId: "comp1",
				},
			]);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(3);
				expect(result.data.skipped).toBeUndefined();

				// Verify all have unique IDs
				const ids = result.data.created.map((u) => u.id);
				expect(new Set(ids).size).toBe(3);

				// Verify all have timestamps
				result.data.created.forEach((user) => {
					expect(user.createdAt).toBeDefined();
					expect(user.updatedAt).toBeDefined();
				});
			}

			// Verify in database
			const allUsers = await collect(db.users.query());
			expect(allUsers).toHaveLength(3);
		});

		it("should skip duplicates when option is set", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			// Create first user
			await db.users.create({
				id: "existing-user",
				name: "Existing User",
				email: "existing@example.com",
				age: 40,
				companyId: "comp1",
			});

			// Try to create with duplicate ID
			const result = await db.users.createMany(
				[
					{
						id: "existing-user", // Duplicate
						name: "Duplicate User",
						email: "duplicate@example.com",
						age: 45,
						companyId: "comp1",
					},
					{
						name: "New User",
						email: "new@example.com",
						age: 30,
						companyId: "comp2",
					},
				],
				{ skipDuplicates: true },
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result) && result.data) {
				expect(result.data.created).toHaveLength(1);
				expect(result.data.created[0].name).toBe("New User");
				expect(result.data.skipped).toHaveLength(1);
				expect(result.data.skipped![0].reason).toContain("Duplicate ID");
			}
		});

		it("should fail fast without skipDuplicates", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			// Create first user
			await db.users.create({
				id: "existing-user",
				name: "Existing User",
				email: "existing@example.com",
				age: 40,
				companyId: "comp1",
			});

			// Try to create with duplicate ID
			const result = await db.users.createMany([
				{
					name: "Valid User",
					email: "valid@example.com",
					age: 30,
					companyId: "comp1",
				},
				{
					id: "existing-user", // Duplicate
					name: "Duplicate User",
					email: "duplicate@example.com",
					age: 45,
					companyId: "comp1",
				},
			]);

			expect(isErr(result)).toBe(true);
			if (isErr(result)) {
				expect(result.error.code).toBe("DUPLICATE_KEY");
			}

			// Verify no users were created
			const allUsers = await collect(db.users.query());
			expect(allUsers).toHaveLength(1); // Only the existing user
		});

		it("should validate all foreign keys", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.createMany(
				[
					{
						name: "User 1",
						email: "user1@example.com",
						age: 25,
						companyId: "comp1", // Valid
					},
					{
						name: "User 2",
						email: "user2@example.com",
						age: 30,
						companyId: "invalid-company", // Invalid
					},
				],
				{ skipDuplicates: true },
			);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(1);
				expect(result.data.created[0]?.name).toBe("User 1");
				expect(result.data.skipped).toHaveLength(1);
				const firstSkipped = result.data.skipped?.[0];
				if (firstSkipped) {
					expect(firstSkipped.reason).toContain("Foreign key violation");
				}
			}
		});

		it("should handle empty array", async () => {
			const db = createDatabase(config, testData) as TestDatabase;

			const result = await db.users.createMany([]);

			expect(isOk(result)).toBe(true);
			if (isOk(result)) {
				expect(result.data.created).toHaveLength(0);
				expect(result.data.skipped).toBeUndefined();
			}
		});
	});
});
