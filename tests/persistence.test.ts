import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database.js";
import { createNodeStorageAdapter } from "../core/storage/node-adapter.js";
import { createJsonSerializer } from "../core/serializers/json.js";
import { createYamlSerializer } from "../core/serializers/yaml.js";
import { createMessagePackSerializer } from "../core/serializers/messagepack.js";
import { createSerializerRegistry } from "../core/utils/file-extensions.js";
import { isOk, isErr } from "../core/errors/crud-errors.js";
import { collect } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types.js";
import type { StorageAdapter } from "../core/storage/types.js";

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	age: z.number().min(0),
	isActive: z.boolean().default(true),
	createdAt: z.date().default(() => new Date()),
	preferences: z
		.object({
			theme: z.enum(["light", "dark"]).default("light"),
			notifications: z.boolean().default(true),
		})
		.default({}),
});

const PostSchema = z.object({
	id: z.string(),
	title: z.string(),
	content: z.string(),
	authorId: z.string(),
	publishedAt: z.date().optional(),
	tags: z.array(z.string()).default([]),
	metadata: z.record(z.unknown()).default({}),
});

const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	parentId: z.string().optional(),
});

const SessionSchema = z.object({
	id: z.string(),
	userId: z.string(),
	token: z.string(),
	expiresAt: z.date(),
	createdAt: z.date().default(() => new Date()),
});

type User = z.infer<typeof UserSchema>;
type Post = z.infer<typeof PostSchema>;
type Category = z.infer<typeof CategorySchema>;
type Session = z.infer<typeof SessionSchema>;

// ============================================================================
// Test Configurations
// ============================================================================

const basicPersistentConfig = {
	users: {
		schema: UserSchema,
		file: "./test-data/users.json",
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./test-data/posts.json",
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

const mixedPersistenceConfig = {
	users: {
		schema: UserSchema,
		file: "./test-data/users.yaml", // YAML format
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
			sessions: {
				type: "inverse" as const,
				target: "sessions",
				foreignKey: "userId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		file: "./test-data/shared.json", // Shared file
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
	categories: {
		schema: CategorySchema,
		file: "./test-data/shared.json", // Shared file with posts
		relationships: {},
	},
	sessions: {
		schema: SessionSchema,
		// No file = in-memory only
		relationships: {
			user: {
				type: "ref" as const,
				target: "users",
				foreignKey: "userId",
			},
		},
	},
} as const;

const inMemoryConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			posts: {
				type: "inverse" as const,
				target: "posts",
				foreignKey: "authorId",
			},
		},
	},
	posts: {
		schema: PostSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "users",
				foreignKey: "authorId",
			},
		},
	},
} as const;

// ============================================================================
// Mock Storage Adapter for Testing
// ============================================================================

type MockStorage = Record<string, string | Buffer>;

function createMockStorageAdapter(storage: MockStorage = {}): StorageAdapter {
	const watchers = new Map<string, (() => void)[]>();

	return {
		async read(path: string): Promise<Buffer | string> {
			if (!(path in storage)) {
				throw new Error(`File not found: ${path}`);
			}
			return storage[path];
		},

		async write(path: string, data: Buffer | string): Promise<void> {
			storage[path] = data;
			// Notify watchers
			const pathWatchers = watchers.get(path);
			if (pathWatchers) {
				pathWatchers.forEach((callback) => callback());
			}
		},

		async exists(path: string): Promise<boolean> {
			return path in storage;
		},

		watch(path: string, callback: () => void): () => void {
			if (!watchers.has(path)) {
				watchers.set(path, []);
			}
			watchers.get(path)!.push(callback);

			// Return unwatch function
			return () => {
				const pathWatchers = watchers.get(path);
				if (pathWatchers) {
					const index = pathWatchers.indexOf(callback);
					if (index > -1) {
						pathWatchers.splice(index, 1);
					}
				}
			};
		},

		async ensureDir(path: string): Promise<void> {
			// Mock implementation - no-op
		},
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function createSampleData(): DatasetFor<typeof basicPersistentConfig> {
	const users: User[] = [
		{
			id: generateId(),
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 28,
			isActive: true,
			createdAt: new Date("2024-01-15"),
			preferences: {
				theme: "dark",
				notifications: true,
			},
		},
		{
			id: generateId(),
			name: "Bob Smith",
			email: "bob@example.com",
			age: 35,
			isActive: true,
			createdAt: new Date("2024-01-20"),
			preferences: {
				theme: "light",
				notifications: false,
			},
		},
	];

	const posts: Post[] = [
		{
			id: generateId(),
			title: "Introduction to TypeScript",
			content: "TypeScript is a powerful superset of JavaScript...",
			authorId: users[0].id,
			publishedAt: new Date("2024-02-01"),
			tags: ["typescript", "javascript", "programming"],
			metadata: { featured: true, readTime: 5 },
		},
		{
			id: generateId(),
			title: "Database Design Patterns",
			content: "When designing databases, consider these patterns...",
			authorId: users[1].id,
			publishedAt: new Date("2024-02-05"),
			tags: ["database", "design", "patterns"],
			metadata: { difficulty: "intermediate" },
		},
	];

	return { users, posts };
}

// ============================================================================
// Tests
// ============================================================================

describe("Persistence System", () => {
	let mockStorage: MockStorage;
	let storageAdapter: StorageAdapter;

	beforeEach(() => {
		mockStorage = {};
		storageAdapter = createMockStorageAdapter(mockStorage);
	});

	afterEach(() => {
		// Cleanup any real files if tests somehow created them
		// This is a safety measure for the mock tests
	});

	describe("Basic Persistence", () => {
		it("should create database with persistence and save initial data", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);
			const sampleData = createSampleData();

			const db = await createDatabase(basicPersistentConfig, sampleData, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 10, // Low debounce for testing
					watchFiles: false,
				},
			});

			// Give debounced writes time to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify files were created
			expect(await storageAdapter.exists("./test-data/users.json")).toBe(true);
			expect(await storageAdapter.exists("./test-data/posts.json")).toBe(true);

			// Verify data was saved correctly
			const usersData = JSON.parse(
				(await storageAdapter.read("./test-data/users.json")) as string,
			);
			const postsData = JSON.parse(
				(await storageAdapter.read("./test-data/posts.json")) as string,
			);

			expect(Object.keys(usersData.users)).toHaveLength(2);
			expect(Object.keys(postsData.posts)).toHaveLength(2);

			// Verify data structure (object format for O(1) lookups)
			const firstUserId = Object.keys(usersData.users)[0];
			expect(usersData.users[firstUserId]).toHaveProperty("id", firstUserId);
			expect(usersData.users[firstUserId]).toHaveProperty("name");
			expect(usersData.users[firstUserId]).toHaveProperty("email");
		});

		it("should load existing data on database creation", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			// Pre-populate mock storage
			const existingUsers = {
				users: {
					"user-1": {
						id: "user-1",
						name: "Existing User",
						email: "existing@example.com",
						age: 30,
						isActive: true,
						createdAt: new Date("2024-01-01").toISOString(),
						preferences: { theme: "light", notifications: true },
					},
				},
			};

			const existingPosts = {
				posts: {
					"post-1": {
						id: "post-1",
						title: "Existing Post",
						content: "This post already exists",
						authorId: "user-1",
						tags: ["existing"],
						metadata: {},
					},
				},
			};

			mockStorage["./test-data/users.json"] = JSON.stringify(existingUsers);
			mockStorage["./test-data/posts.json"] = JSON.stringify(existingPosts);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					watchFiles: false,
				},
			});

			// Verify data was loaded
			const allUsers = await collect(db.users.query());
			const allPosts = await collect(db.posts.query());

			expect(allUsers).toHaveLength(1);
			expect(allPosts).toHaveLength(1);
			expect(allUsers[0].name).toBe("Existing User");
			expect(allPosts[0].title).toBe("Existing Post");
		});

		it("should persist CRUD operations automatically", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 10,
					watchFiles: false,
				},
			});

			// Create a user
			const userResult = await db.users.create({
				name: "Test User",
				email: "test@example.com",
				age: 25,
			});

			expect(isOk(userResult)).toBe(true);
			if (!isOk(userResult)) return;

			const user = userResult.data;

			// Create a post
			const postResult = await db.posts.create({
				title: "Test Post",
				content: "This is a test post",
				authorId: user.id,
				tags: ["test"],
			});

			expect(isOk(postResult)).toBe(true);
			if (!isOk(postResult)) return;

			const post = postResult.data;

			// Wait for debounced writes
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify persistence
			const usersData = JSON.parse(
				(await storageAdapter.read("./test-data/users.json")) as string,
			);
			const postsData = JSON.parse(
				(await storageAdapter.read("./test-data/posts.json")) as string,
			);

			expect(usersData.users[user.id]).toBeDefined();
			expect(usersData.users[user.id].name).toBe("Test User");
			expect(postsData.posts[post.id]).toBeDefined();
			expect(postsData.posts[post.id].title).toBe("Test Post");

			// Update the user
			await db.users.update(user.id, { age: 26 });

			// Wait for debounced writes
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify update was persisted
			const updatedUsersData = JSON.parse(
				(await storageAdapter.read("./test-data/users.json")) as string,
			);
			expect(updatedUsersData.users[user.id].age).toBe(26);

			// Delete the post
			await db.posts.delete(post.id);

			// Wait for debounced writes
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify deletion was persisted
			const updatedPostsData = JSON.parse(
				(await storageAdapter.read("./test-data/posts.json")) as string,
			);
			expect(updatedPostsData.posts[post.id]).toBeUndefined();
		});
	});

	describe("Multiple File Formats", () => {
		it("should support JSON serialization", async () => {
			const jsonSerializer = createJsonSerializer({ indent: 2 });
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(
				basicPersistentConfig,
				createSampleData(),
				{
					persistence: {
						adapter: storageAdapter,
						serializerRegistry,
						writeDebounce: 10,
						watchFiles: false,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 50));

			const usersContent = (await storageAdapter.read(
				"./test-data/users.json",
			)) as string;

			// Should be valid JSON
			expect(() => JSON.parse(usersContent)).not.toThrow();

			// Should be formatted (indented)
			expect(usersContent).toContain("  ");
			expect(usersContent).toContain("\n");
		});

		it("should support YAML serialization", async () => {
			const yamlSerializer = createYamlSerializer();
			const serializerRegistry = createSerializerRegistry([yamlSerializer]);

			const yamlConfig = {
				users: {
					schema: UserSchema,
					file: "./test-data/users.yaml",
					relationships: {},
				},
			} as const;

			const db = await createDatabase(
				yamlConfig,
				{ users: createSampleData().users },
				{
					persistence: {
						adapter: storageAdapter,
						serializerRegistry,
						writeDebounce: 10,
						watchFiles: false,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 50));

			const yamlContent = (await storageAdapter.read(
				"./test-data/users.yaml",
			)) as string;

			// Should contain YAML syntax
			expect(yamlContent).toContain("users:");
			expect(yamlContent).toMatch(/^\s+\w+:/m); // Indented properties
		});

		it("should support MessagePack serialization", async () => {
			const msgpackSerializer = createMessagePackSerializer();
			const serializerRegistry = createSerializerRegistry([msgpackSerializer]);

			const msgpackConfig = {
				users: {
					schema: UserSchema,
					file: "./test-data/users.msgpack",
					relationships: {},
				},
			} as const;

			const db = await createDatabase(
				msgpackConfig,
				{ users: createSampleData().users },
				{
					persistence: {
						adapter: storageAdapter,
						serializerRegistry,
						writeDebounce: 10,
						watchFiles: false,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 50));

			const msgpackContent = await storageAdapter.read(
				"./test-data/users.msgpack",
			);

			// Should be binary data
			expect(msgpackContent).toBeInstanceOf(Buffer);
			expect((msgpackContent as Buffer).length).toBeGreaterThan(0);
		});

		it("should handle file extension validation", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const invalidConfig = {
				users: {
					schema: UserSchema,
					file: "./test-data/users.yaml", // YAML extension but only JSON serializer
					relationships: {},
				},
			} as const;

			// Should throw error due to unsupported file extension
			await expect(
				createDatabase(invalidConfig, undefined, {
					persistence: {
						adapter: storageAdapter,
						serializerRegistry,
					},
				}),
			).rejects.toThrow();
		});
	});

	describe("Shared Files", () => {
		it("should handle multiple collections in shared files", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const sharedFileConfig = {
				posts: {
					schema: PostSchema,
					file: "./test-data/content.json",
					relationships: {},
				},
				categories: {
					schema: CategorySchema,
					file: "./test-data/content.json", // Same file
					relationships: {},
				},
			} as const;

			const initialData = {
				posts: [
					{
						id: "post-1",
						title: "Test Post",
						content: "Content",
						authorId: "user-1",
						tags: [],
						metadata: {},
					},
				],
				categories: [
					{
						id: "cat-1",
						name: "Technology",
						description: "Tech category",
					},
				],
			};

			const db = await createDatabase(sharedFileConfig, initialData, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 10,
					watchFiles: false,
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify shared file contains both collections
			const sharedData = JSON.parse(
				(await storageAdapter.read("./test-data/content.json")) as string,
			);

			expect(sharedData).toHaveProperty("posts");
			expect(sharedData).toHaveProperty("categories");
			expect(Object.keys(sharedData.posts)).toHaveLength(1);
			expect(Object.keys(sharedData.categories)).toHaveLength(1);

			// Add data to both collections
			await db.posts.create({
				title: "Second Post",
				content: "More content",
				authorId: "user-1",
				tags: ["shared"],
			});

			await db.categories.create({
				name: "Science",
				description: "Science category",
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify both collections were updated in shared file
			const updatedSharedData = JSON.parse(
				(await storageAdapter.read("./test-data/content.json")) as string,
			);
			expect(Object.keys(updatedSharedData.posts)).toHaveLength(2);
			expect(Object.keys(updatedSharedData.categories)).toHaveLength(2);
		});
	});

	describe("Mixed Persistence", () => {
		it("should handle mixed persistent and in-memory collections", async () => {
			const jsonSerializer = createJsonSerializer();
			const yamlSerializer = createYamlSerializer();
			const serializerRegistry = createSerializerRegistry([
				jsonSerializer,
				yamlSerializer,
			]);

			const sampleData = {
				users: createSampleData().users,
				posts: createSampleData().posts,
				categories: [
					{
						id: "cat-1",
						name: "Technology",
					},
				],
				sessions: [
					{
						id: "session-1",
						userId: createSampleData().users[0].id,
						token: "token123",
						expiresAt: new Date(Date.now() + 86400000), // 24 hours
						createdAt: new Date(),
					},
				],
			};

			const db = await createDatabase(mixedPersistenceConfig, sampleData, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 10,
					watchFiles: false,
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify persistent collections were saved
			expect(await storageAdapter.exists("./test-data/users.yaml")).toBe(true);
			expect(await storageAdapter.exists("./test-data/shared.json")).toBe(true);

			// Verify shared file contains posts and categories
			const sharedData = JSON.parse(
				(await storageAdapter.read("./test-data/shared.json")) as string,
			);
			expect(sharedData).toHaveProperty("posts");
			expect(sharedData).toHaveProperty("categories");

			// Verify in-memory sessions are not persisted
			expect(await storageAdapter.exists("./test-data/sessions.json")).toBe(
				false,
			);

			// Verify all collections are queryable
			const users = await collect(db.users.query());
			const posts = await collect(db.posts.query());
			const categories = await collect(db.categories.query());
			const sessions = await collect(db.sessions.query());

			expect(users).toHaveLength(2);
			expect(posts).toHaveLength(2);
			expect(categories).toHaveLength(1);
			expect(sessions).toHaveLength(1);

			// Create new session (should not be persisted)
			await db.sessions.create({
				userId: users[0].id,
				token: "new-token",
				expiresAt: new Date(Date.now() + 86400000),
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Session file should still not exist
			expect(await storageAdapter.exists("./test-data/sessions.json")).toBe(
				false,
			);

			// But session should be in memory
			const allSessions = await collect(db.sessions.query());
			expect(allSessions).toHaveLength(2);
		});
	});

	describe("File Watching and External Changes", () => {
		it("should detect external file changes when watching is enabled", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			let changeDetected = false;
			const mockAdapterWithWatching = {
				...storageAdapter,
				watch: (path: string, callback: () => void) => {
					// Simulate external change after a delay
					setTimeout(() => {
						changeDetected = true;
						callback();
					}, 20);
					return () => {}; // unwatch function
				},
			};

			const db = await createDatabase(
				basicPersistentConfig,
				createSampleData(),
				{
					persistence: {
						adapter: mockAdapterWithWatching,
						serializerRegistry,
						writeDebounce: 10,
						watchFiles: true,
					},
				},
			);

			// Wait for simulated external change
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(changeDetected).toBe(true);
		});
	});

	describe("Error Handling", () => {
		it("should handle storage adapter read errors", async () => {
			const errorAdapter: StorageAdapter = {
				...storageAdapter,
				read: async () => {
					throw new Error("Storage read error");
				},
			};

			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			// Should not throw during database creation, should handle gracefully
			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: errorAdapter,
					serializerRegistry,
					watchFiles: false,
				},
			});

			// Database should still be usable (in-memory mode)
			const result = await db.users.create({
				name: "Test User",
				email: "test@example.com",
				age: 25,
			});

			expect(isOk(result)).toBe(true);
		});

		it("should handle storage adapter write errors", async () => {
			const errorAdapter: StorageAdapter = {
				...storageAdapter,
				write: async () => {
					throw new Error("Storage write error");
				},
			};

			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: errorAdapter,
					serializerRegistry,
					writeDebounce: 10,
					watchFiles: false,
				},
			});

			// CRUD operations should still work (data stays in memory)
			const result = await db.users.create({
				name: "Test User",
				email: "test@example.com",
				age: 25,
			});

			expect(isOk(result)).toBe(true);

			// Data should be queryable from memory
			const users = await collect(db.users.query());
			expect(users).toHaveLength(1);
		});

		it("should handle invalid JSON data gracefully", async () => {
			const invalidJsonAdapter: StorageAdapter = {
				...storageAdapter,
				read: async (path: string) => {
					if (path.endsWith(".json")) {
						return "invalid json content {";
					}
					return storageAdapter.read(path);
				},
			};

			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			// Should handle invalid JSON gracefully and fall back to empty data
			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: invalidJsonAdapter,
					serializerRegistry,
					watchFiles: false,
				},
			});

			// Should start with empty collections
			const users = await collect(db.users.query());
			const posts = await collect(db.posts.query());

			expect(users).toHaveLength(0);
			expect(posts).toHaveLength(0);
		});
	});

	describe("Performance and Cleanup", () => {
		it("should debounce multiple rapid writes", async () => {
			let writeCount = 0;
			const countingAdapter: StorageAdapter = {
				...storageAdapter,
				write: async (path: string, data: Buffer | string) => {
					writeCount++;
					return storageAdapter.write(path, data);
				},
			};

			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: countingAdapter,
					serializerRegistry,
					writeDebounce: 100, // Higher debounce for this test
					watchFiles: false,
				},
			});

			// Perform multiple rapid operations
			await Promise.all([
				db.users.create({
					name: "User 1",
					email: "user1@example.com",
					age: 25,
				}),
				db.users.create({
					name: "User 2",
					email: "user2@example.com",
					age: 26,
				}),
				db.users.create({
					name: "User 3",
					email: "user3@example.com",
					age: 27,
				}),
			]);

			// Should not have written yet due to debouncing
			expect(writeCount).toBe(0);

			// Wait for debounced write
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should have written once (debounced)
			expect(writeCount).toBe(1);
		});

		it("should properly cleanup resources", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					watchFiles: true,
				},
			});

			// Database should have cleanup method
			expect(typeof (db as unknown as { cleanup?: () => void }).cleanup).toBe(
				"function",
			);

			// Cleanup should not throw
			expect(() =>
				(db as unknown as { cleanup: () => void }).cleanup(),
			).not.toThrow();
		});
	});

	describe("Backward Compatibility", () => {
		it("should work without persistence options (pure in-memory)", async () => {
			const db = await createDatabase(inMemoryConfig, createSampleData());

			const users = await collect(db.users.query());
			const posts = await collect(db.posts.query());

			expect(users).toHaveLength(2);
			expect(posts).toHaveLength(2);

			// Should work exactly like before
			const result = await db.users.create({
				name: "New User",
				email: "new@example.com",
				age: 30,
			});

			expect(isOk(result)).toBe(true);

			const allUsers = await collect(db.users.query());
			expect(allUsers).toHaveLength(3);
		});

		it("should work with collections that have no file config", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const partialPersistenceConfig = {
				users: {
					schema: UserSchema,
					file: "./test-data/users.json", // Persistent
					relationships: {},
				},
				sessions: {
					schema: SessionSchema,
					// No file = in-memory
					relationships: {},
				},
			} as const;

			const db = await createDatabase(partialPersistenceConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					writeDebounce: 10,
					watchFiles: false,
				},
			});

			// Both collections should work
			await db.users.create({
				name: "Persistent User",
				email: "persistent@example.com",
				age: 30,
			});

			await db.sessions.create({
				userId: "user-1",
				token: "session-token",
				expiresAt: new Date(Date.now() + 86400000),
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Only users should be persisted
			expect(await storageAdapter.exists("./test-data/users.json")).toBe(true);
			expect(await storageAdapter.exists("./test-data/sessions.json")).toBe(
				false,
			);

			// Both should be queryable
			const users = await collect(db.users.query());
			const sessions = await collect(db.sessions.query());

			expect(users).toHaveLength(1);
			expect(sessions).toHaveLength(1);
		});
	});

	describe("Type Safety", () => {
		it("should maintain type safety with persistence", async () => {
			const jsonSerializer = createJsonSerializer();
			const serializerRegistry = createSerializerRegistry([jsonSerializer]);

			const db = await createDatabase(basicPersistentConfig, undefined, {
				persistence: {
					adapter: storageAdapter,
					serializerRegistry,
					watchFiles: false,
				},
			});

			// Create operations should maintain type safety
			const userResult = await db.users.create({
				name: "Type Safe User",
				email: "typesafe@example.com",
				age: 25,
				// TypeScript should enforce required fields
			});

			expect(isOk(userResult)).toBe(true);
			if (!isOk(userResult)) return;

			// Query results should be properly typed
			const users = await collect(
				db.users.query({
					where: { age: { $gte: 20 } },
					select: { name: true, email: true, age: true },
				}),
			);

			// TypeScript should know the shape of users
			expect(users[0].name).toBeDefined();
			expect(users[0].email).toBeDefined();
			expect(users[0].age).toBeDefined();

			// Populate operations should maintain type safety
			const userWithPosts = await collect(
				db.users.query({
					populate: { posts: true },
				}),
			);

			if (userWithPosts[0] && userWithPosts[0].posts) {
				// TypeScript should know posts is an array of Post objects
				expect(Array.isArray(userWithPosts[0].posts)).toBe(true);
			}
		});
	});
});
