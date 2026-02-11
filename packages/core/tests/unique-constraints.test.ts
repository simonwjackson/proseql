import { Effect, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UniqueConstraintError } from "../src/errors/crud-errors.js";
import { create, createMany } from "../src/operations/crud/create.js";
import { normalizeConstraints } from "../src/operations/crud/unique-check.js";
import { update } from "../src/operations/crud/update.js";

// ============================================================================
// Test Schemas
// ============================================================================

/**
 * User schema with email and username as unique fields.
 * This is the primary test subject for unique constraint enforcement.
 */
const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	username: Schema.String,
	age: Schema.Number,
	role: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type User = typeof UserSchema.Type;

// ============================================================================
// Test Helpers
// ============================================================================

type HasId = { readonly id: string };

/**
 * Create a Ref<ReadonlyMap> from an array of entities.
 */
const makeRef = <T extends HasId>(
	items: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, T>>> =>
	Ref.make(
		new Map(items.map((item) => [item.id, item])) as ReadonlyMap<string, T>,
	);

/**
 * Create state refs from a record of collection names to entity arrays.
 */
const makeStateRefs = (
	collections: Record<string, ReadonlyArray<HasId>>,
): Effect.Effect<Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>> =>
	Effect.gen(function* () {
		const refs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>> = {};
		for (const [name, items] of Object.entries(collections)) {
			refs[name] = yield* makeRef(items);
		}
		return refs;
	});

/**
 * Normalized unique constraints for the User schema.
 * ["email", "username"] normalized to [["email"], ["username"]]
 */
const userUniqueFields = normalizeConstraints(["email", "username"]);

/**
 * No relationships configured for the User schema in these tests.
 */
const noRelationships = {};

// ============================================================================
// Test Data
// ============================================================================

const existingUser: User = {
	id: "user1",
	name: "Alice",
	email: "alice@example.com",
	username: "alice",
	age: 30,
};

const anotherUser: User = {
	id: "user2",
	name: "Bob",
	email: "bob@example.com",
	username: "bob",
	age: 25,
};

// ============================================================================
// Tests
// ============================================================================

// ============================================================================
// Compound Constraint Test Schema
// ============================================================================

/**
 * Settings schema with compound unique constraint on [userId, settingKey].
 * This tests uniqueness across multiple fields where the combination must be unique.
 */
const SettingSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	settingKey: Schema.String,
	value: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type Setting = typeof SettingSchema.Type;

/**
 * Normalized unique constraints for compound [userId, settingKey].
 */
const settingUniqueFields = normalizeConstraints([["userId", "settingKey"]]);

// ============================================================================
// Compound Constraint Test Data
// ============================================================================

const existingSetting: Setting = {
	id: "setting1",
	userId: "user1",
	settingKey: "theme",
	value: "dark",
};

const _anotherSetting: Setting = {
	id: "setting2",
	userId: "user1",
	settingKey: "language",
	value: "en",
};

// ============================================================================
// Tests
// ============================================================================

describe("Unique Constraints - Single Field", () => {
	describe("create", () => {
		it("should fail with UniqueConstraintError when email already exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser]);
					const stateRefs = yield* makeStateRefs({ users: [existingUser] });

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined, // indexes
						undefined, // hooks
						userUniqueFields,
					);

					return yield* doCreate({
						name: "Duplicate",
						email: "alice@example.com", // same as existingUser
						username: "newuser",
						age: 25,
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("UniqueConstraintError");
			if (result._tag === "UniqueConstraintError") {
				expect(result.collection).toBe("users");
				expect(result.constraint).toBe("unique_email");
				expect(result.fields).toEqual(["email"]);
				expect(result.values).toEqual({ email: "alice@example.com" });
				expect(result.existingId).toBe("user1");
			}
		});

		it("should fail with UniqueConstraintError when username already exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser]);
					const stateRefs = yield* makeStateRefs({ users: [existingUser] });

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					return yield* doCreate({
						name: "Duplicate",
						email: "new@example.com",
						username: "alice", // same as existingUser
						age: 25,
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("UniqueConstraintError");
			if (result._tag === "UniqueConstraintError") {
				expect(result.constraint).toBe("unique_username");
				expect(result.fields).toEqual(["username"]);
				expect(result.values).toEqual({ username: "alice" });
			}
		});

		it("should succeed when all unique values are different", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser]);
					const stateRefs = yield* makeStateRefs({ users: [existingUser] });

					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					return yield* doCreate({
						name: "New User",
						email: "new@example.com",
						username: "newuser",
						age: 28,
					});
				}),
			);

			expect(result.name).toBe("New User");
			expect(result.email).toBe("new@example.com");
			expect(result.username).toBe("newuser");
		});

		it("should succeed when unique field is null (nulls not checked)", async () => {
			// Schema with optional email to allow null
			const UserWithOptionalEmail = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				email: Schema.NullOr(Schema.String),
				username: Schema.String,
				age: Schema.Number,
				createdAt: Schema.optional(Schema.String),
				updatedAt: Schema.optional(Schema.String),
			});

			type UserOptEmail = typeof UserWithOptionalEmail.Type;

			const existingWithNullEmail: UserOptEmail = {
				id: "user1",
				name: "Alice",
				email: null,
				username: "alice",
				age: 30,
			};

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<UserOptEmail>([
						existingWithNullEmail,
					]);
					const stateRefs = yield* makeStateRefs({
						users: [existingWithNullEmail],
					});

					const doCreate = create(
						"users",
						UserWithOptionalEmail,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						normalizeConstraints(["email", "username"]),
					);

					// Create another user with null email - should succeed
					return yield* doCreate({
						name: "New User",
						email: null,
						username: "newuser",
						age: 25,
					});
				}),
			);

			expect(result.name).toBe("New User");
			expect(result.email).toBe(null);
		});
	});

	describe("createMany", () => {
		it("should fail on inter-batch duplicates", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([]);
					const stateRefs = yield* makeStateRefs({ users: [] });

					const doCreateMany = createMany(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					return yield* doCreateMany([
						{
							name: "User 1",
							email: "same@example.com",
							username: "user1",
							age: 25,
						},
						{
							name: "User 2",
							email: "same@example.com",
							username: "user2",
							age: 30,
						}, // duplicate email
					]).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("UniqueConstraintError");
			if (result._tag === "UniqueConstraintError") {
				expect(result.values).toEqual({ email: "same@example.com" });
			}
		});

		it("should skip unique violations when skipDuplicates is true", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser]);
					const stateRefs = yield* makeStateRefs({ users: [existingUser] });

					const doCreateMany = createMany(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					return yield* doCreateMany(
						[
							{
								name: "Duplicate",
								email: "alice@example.com",
								username: "dup",
								age: 25,
							}, // conflicts with existingUser
							{
								name: "Valid",
								email: "valid@example.com",
								username: "valid",
								age: 30,
							},
						],
						{ skipDuplicates: true },
					);
				}),
			);

			expect(result.created).toHaveLength(1);
			expect(result.created[0]?.name).toBe("Valid");
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped?.[0]?.reason).toContain(
				"Unique constraint violation",
			);
		});
	});

	describe("update", () => {
		it("should fail when changing unique field to conflicting value", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser]);
					const stateRefs = yield* makeStateRefs({
						users: [existingUser, anotherUser],
					});

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined, // indexes
						undefined, // hooks
						userUniqueFields,
					);

					// Try to change Bob's email to Alice's email
					return yield* doUpdate("user2", { email: "alice@example.com" }).pipe(
						Effect.flip,
					);
				}),
			);

			expect(result._tag).toBe("UniqueConstraintError");
			if (result._tag === "UniqueConstraintError") {
				expect(result.existingId).toBe("user1");
				expect(result.values).toEqual({ email: "alice@example.com" });
			}
		});

		it("should succeed when changing unique field to non-conflicting value", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser]);
					const stateRefs = yield* makeStateRefs({
						users: [existingUser, anotherUser],
					});

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					// Change Bob's email to a new unique email
					return yield* doUpdate("user2", { email: "newemail@example.com" });
				}),
			);

			expect(result.email).toBe("newemail@example.com");
		});

		it("should succeed when changing non-unique field", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser, anotherUser]);
					const stateRefs = yield* makeStateRefs({
						users: [existingUser, anotherUser],
					});

					const doUpdate = update(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						userUniqueFields,
					);

					// Change Bob's age (non-unique field)
					return yield* doUpdate("user2", { age: 100 });
				}),
			);

			expect(result.age).toBe(100);
			expect(result.email).toBe("bob@example.com");
		});
	});

	describe("collection without uniqueFields", () => {
		it("should only enforce ID uniqueness", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* makeRef<User>([existingUser]);
					const stateRefs = yield* makeStateRefs({ users: [existingUser] });

					// No uniqueFields configured (empty array)
					const doCreate = create(
						"users",
						UserSchema,
						noRelationships,
						usersRef,
						stateRefs,
						undefined,
						undefined,
						[], // empty uniqueFields
					);

					// Same email should be allowed since no uniqueFields configured
					return yield* doCreate({
						name: "Duplicate Email",
						email: "alice@example.com", // same as existingUser
						username: "differentuser",
						age: 25,
					});
				}),
			);

			expect(result.name).toBe("Duplicate Email");
			expect(result.email).toBe("alice@example.com");
		});
	});
});

// ============================================================================
// Compound Unique Constraints Tests
// ============================================================================

describe("Unique Constraints - Compound Fields", () => {
	describe("create", () => {
		it("should fail with UniqueConstraintError when compound tuple already exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const settingsRef = yield* makeRef<Setting>([existingSetting]);
					const stateRefs = yield* makeStateRefs({
						settings: [existingSetting],
					});

					const doCreate = create(
						"settings",
						SettingSchema,
						noRelationships,
						settingsRef,
						stateRefs,
						undefined,
						undefined,
						settingUniqueFields,
					);

					// Try to create with same userId + settingKey combo
					return yield* doCreate({
						userId: "user1",
						settingKey: "theme", // same as existingSetting
						value: "light",
					}).pipe(Effect.flip);
				}),
			);

			expect(result._tag).toBe("UniqueConstraintError");
			if (result._tag === "UniqueConstraintError") {
				expect(result.collection).toBe("settings");
				expect(result.constraint).toBe("unique_userId_settingKey");
				expect(result.fields).toEqual(["userId", "settingKey"]);
				expect(result.values).toEqual({ userId: "user1", settingKey: "theme" });
				expect(result.existingId).toBe("setting1");
			}
		});

		it("should succeed when one field of compound differs (partial overlap)", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const settingsRef = yield* makeRef<Setting>([existingSetting]);
					const stateRefs = yield* makeStateRefs({
						settings: [existingSetting],
					});

					const doCreate = create(
						"settings",
						SettingSchema,
						noRelationships,
						settingsRef,
						stateRefs,
						undefined,
						undefined,
						settingUniqueFields,
					);

					// Same userId, different settingKey → should succeed
					return yield* doCreate({
						userId: "user1",
						settingKey: "notifications", // different from existingSetting
						value: "enabled",
					});
				}),
			);

			expect(result.userId).toBe("user1");
			expect(result.settingKey).toBe("notifications");
		});

		it("should succeed when compound field has null (nulls not checked)", async () => {
			// Schema with optional userId to allow null
			const SettingWithOptionalUser = Schema.Struct({
				id: Schema.String,
				userId: Schema.NullOr(Schema.String),
				settingKey: Schema.String,
				value: Schema.String,
				createdAt: Schema.optional(Schema.String),
				updatedAt: Schema.optional(Schema.String),
			});

			type SettingOptUser = typeof SettingWithOptionalUser.Type;

			const existingWithNullUser: SettingOptUser = {
				id: "setting1",
				userId: null,
				settingKey: "theme",
				value: "dark",
			};

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const settingsRef = yield* makeRef<SettingOptUser>([
						existingWithNullUser,
					]);
					const stateRefs = yield* makeStateRefs({
						settings: [existingWithNullUser],
					});

					const doCreate = create(
						"settings",
						SettingWithOptionalUser,
						noRelationships,
						settingsRef,
						stateRefs,
						undefined,
						undefined,
						normalizeConstraints([["userId", "settingKey"]]),
					);

					// Another setting with null userId + same settingKey → should succeed (nulls not checked)
					return yield* doCreate({
						userId: null,
						settingKey: "theme",
						value: "light",
					});
				}),
			);

			expect(result.userId).toBe(null);
			expect(result.settingKey).toBe("theme");
		});
	});

	describe("error shape", () => {
		it("should have constraint name, fields array, and values reflecting compound key", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const settingsRef = yield* makeRef<Setting>([existingSetting]);
					const stateRefs = yield* makeStateRefs({
						settings: [existingSetting],
					});

					const doCreate = create(
						"settings",
						SettingSchema,
						noRelationships,
						settingsRef,
						stateRefs,
						undefined,
						undefined,
						settingUniqueFields,
					);

					// Create a duplicate compound tuple to trigger the error
					return yield* doCreate({
						userId: "user1",
						settingKey: "theme", // same as existingSetting
						value: "light",
					}).pipe(Effect.flip);
				}),
			);

			// Verify it's a UniqueConstraintError
			expect(result._tag).toBe("UniqueConstraintError");
			expect(result).toBeInstanceOf(UniqueConstraintError);

			if (result._tag === "UniqueConstraintError") {
				// Verify constraint name follows pattern: "unique_" + fields.join("_")
				expect(result.constraint).toBe("unique_userId_settingKey");
				expect(result.constraint).toMatch(/^unique_/);
				expect(result.constraint.replace("unique_", "").split("_")).toEqual([
					"userId",
					"settingKey",
				]);

				// Verify fields array contains all compound key fields
				expect(result.fields).toEqual(["userId", "settingKey"]);
				expect(result.fields).toHaveLength(2);
				expect(result.fields).toContain("userId");
				expect(result.fields).toContain("settingKey");

				// Verify values object contains the conflicting values for ALL compound fields
				expect(result.values).toEqual({ userId: "user1", settingKey: "theme" });
				expect(Object.keys(result.values)).toEqual(["userId", "settingKey"]);
				expect(result.values.userId).toBe("user1");
				expect(result.values.settingKey).toBe("theme");

				// Verify collection and existingId are also correct
				expect(result.collection).toBe("settings");
				expect(result.existingId).toBe("setting1");

				// Verify message contains useful information
				expect(result.message).toContain("Unique constraint");
				expect(result.message).toContain("settings");
			}
		});
	});

	describe("mixed single + compound constraints", () => {
		/**
		 * Member schema with both single-field (email) and compound ([teamId, role]) unique constraints.
		 * This tests that both types of constraints are enforced simultaneously.
		 */
		const MemberSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			email: Schema.String,
			teamId: Schema.String,
			role: Schema.String,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String),
		});

		type Member = typeof MemberSchema.Type;

		/**
		 * Mixed constraints: single "email" + compound ["teamId", "role"]
		 */
		const memberUniqueFields = normalizeConstraints([
			"email",
			["teamId", "role"],
		]);

		const existingMember: Member = {
			id: "member1",
			name: "Alice",
			email: "alice@example.com",
			teamId: "team1",
			role: "admin",
		};

		it("should enforce both single and compound constraints", async () => {
			// Test 1: Violate single-field constraint (email)
			const emailViolation = await Effect.runPromise(
				Effect.gen(function* () {
					const membersRef = yield* makeRef<Member>([existingMember]);
					const stateRefs = yield* makeStateRefs({ members: [existingMember] });

					const doCreate = create(
						"members",
						MemberSchema,
						noRelationships,
						membersRef,
						stateRefs,
						undefined,
						undefined,
						memberUniqueFields,
					);

					return yield* doCreate({
						name: "Duplicate Email",
						email: "alice@example.com", // conflicts with existingMember
						teamId: "team2", // different team
						role: "member", // different role
					}).pipe(Effect.flip);
				}),
			);

			expect(emailViolation._tag).toBe("UniqueConstraintError");
			if (emailViolation._tag === "UniqueConstraintError") {
				expect(emailViolation.constraint).toBe("unique_email");
				expect(emailViolation.fields).toEqual(["email"]);
			}

			// Test 2: Violate compound constraint (teamId + role)
			const compoundViolation = await Effect.runPromise(
				Effect.gen(function* () {
					const membersRef = yield* makeRef<Member>([existingMember]);
					const stateRefs = yield* makeStateRefs({ members: [existingMember] });

					const doCreate = create(
						"members",
						MemberSchema,
						noRelationships,
						membersRef,
						stateRefs,
						undefined,
						undefined,
						memberUniqueFields,
					);

					return yield* doCreate({
						name: "Duplicate Role",
						email: "different@example.com", // unique email
						teamId: "team1", // same as existingMember
						role: "admin", // same as existingMember → compound violation
					}).pipe(Effect.flip);
				}),
			);

			expect(compoundViolation._tag).toBe("UniqueConstraintError");
			if (compoundViolation._tag === "UniqueConstraintError") {
				expect(compoundViolation.constraint).toBe("unique_teamId_role");
				expect(compoundViolation.fields).toEqual(["teamId", "role"]);
			}

			// Test 3: All unique → succeeds
			const success = await Effect.runPromise(
				Effect.gen(function* () {
					const membersRef = yield* makeRef<Member>([existingMember]);
					const stateRefs = yield* makeStateRefs({ members: [existingMember] });

					const doCreate = create(
						"members",
						MemberSchema,
						noRelationships,
						membersRef,
						stateRefs,
						undefined,
						undefined,
						memberUniqueFields,
					);

					return yield* doCreate({
						name: "New Member",
						email: "new@example.com", // unique email
						teamId: "team1", // same team
						role: "member", // different role → no compound violation
					});
				}),
			);

			expect(success.name).toBe("New Member");
			expect(success.email).toBe("new@example.com");
			expect(success.teamId).toBe("team1");
			expect(success.role).toBe("member");
		});
	});
});
