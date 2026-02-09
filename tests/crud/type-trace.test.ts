import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../core/factories/database";
import type { DeleteOptions } from "../../core/types/crud-types";

describe("Type Trace", () => {
	it("should trace type through database creation", () => {
		// Define schema
		const UserSchema = z.object({
			id: z.string(),
			name: z.string(),
			deletedAt: z.string().optional(),
		});

		const config = {
			users: {
				schema: UserSchema,
				relationships: {},
			},
		} as const;

		const testData = {
			users: [
				{
					id: "user1",
					name: "John Doe",
					deletedAt: undefined,
				},
			],
		};

		const db = createDatabase(config, testData);

		// Let's try to understand what type db.users.delete expects
		type DBType = typeof db;
		type UsersCollection = DBType["users"];

		// Check if we can call delete with soft option
		const testDelete = async () => {
			// This should work but TypeScript complains
			const result = await db.users.delete("user1", { soft: true });
			return result;
		};

		// Let's manually check the conditional type
		type User = z.infer<typeof UserSchema>;
		type UserDeleteOpts = DeleteOptions<User>;

		// This should allow soft option
		const opts: UserDeleteOpts = { soft: true, returnDeleted: false };

		console.log("Type trace complete");
	});
});
