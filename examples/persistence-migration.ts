/**
 * Migration example showing how to transition from in-memory to persistent storage
 * and how to migrate existing data to the new persistence system.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database.js";
import { createNodeStorageAdapter } from "../core/storage/node-adapter.js";
import { createJsonSerializer } from "../core/serializers/json.js";
import { createSerializerRegistry } from "../core/utils/file-extensions.js";
import { collect } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types.js";
import type { Result } from "../core/errors/legacy.js";

/**
 * Unwraps a Result type, throwing an error if the operation failed
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
}

// ============================================================================
// Schema Definitions
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
	role: z.enum(["admin", "user", "moderator"]).default("user"),
	createdAt: z.date().default(() => new Date()),
	lastLoginAt: z.date().optional(),
});

const TaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(["todo", "in-progress", "done"]).default("todo"),
	assigneeId: z.string().optional(),
	priority: z.enum(["low", "medium", "high"]).default("medium"),
	dueDate: z.date().optional(),
	createdAt: z.date().default(() => new Date()),
	completedAt: z.date().optional(),
});

type User = z.infer<typeof UserSchema>;
type Task = z.infer<typeof TaskSchema>;

// ============================================================================
// Original In-Memory Configuration
// ============================================================================

const inMemoryConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			tasks: {
				type: "inverse" as const,
				target: "tasks",
				foreignKey: "assigneeId",
			},
		},
	},
	tasks: {
		schema: TaskSchema,
		relationships: {
			assignee: {
				type: "ref" as const,
				target: "users",
				foreignKey: "assigneeId",
			},
		},
	},
} as const;

// ============================================================================
// New Persistent Configuration
// ============================================================================

const persistentConfig = {
	users: {
		schema: UserSchema,
		file: "./data/users.json", // Now persistent
		relationships: {
			tasks: {
				type: "inverse" as const,
				target: "tasks",
				foreignKey: "assigneeId",
			},
		},
	},
	tasks: {
		schema: TaskSchema,
		file: "./data/tasks.json", // Now persistent
		relationships: {
			assignee: {
				type: "ref" as const,
				target: "users",
				foreignKey: "assigneeId",
			},
		},
	},
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Sample Data Generation
// ============================================================================

function generateSampleData(): DatasetFor<typeof inMemoryConfig> {
	const users: User[] = [
		{
			id: generateId(),
			name: "Alice Admin",
			email: "alice@company.com",
			role: "admin",
			createdAt: new Date("2024-01-15"),
			lastLoginAt: new Date("2024-02-14"),
		},
		{
			id: generateId(),
			name: "Bob Developer",
			email: "bob@company.com",
			role: "user",
			createdAt: new Date("2024-01-20"),
			lastLoginAt: new Date("2024-02-13"),
		},
		{
			id: generateId(),
			name: "Carol Moderator",
			email: "carol@company.com",
			role: "moderator",
			createdAt: new Date("2024-01-25"),
			lastLoginAt: new Date("2024-02-12"),
		},
	];

	const tasks: Task[] = [
		{
			id: generateId(),
			title: "Setup database persistence",
			description:
				"Implement file-based persistence for the task management system",
			status: "in-progress",
			assigneeId: users[1].id, // Bob
			priority: "high",
			dueDate: new Date("2024-02-20"),
			createdAt: new Date("2024-02-01"),
		},
		{
			id: generateId(),
			title: "Create user management UI",
			description: "Build interface for managing users and permissions",
			status: "todo",
			assigneeId: users[0].id, // Alice
			priority: "medium",
			dueDate: new Date("2024-02-25"),
			createdAt: new Date("2024-02-05"),
		},
		{
			id: generateId(),
			title: "Write documentation",
			description: "Document the new persistence features",
			status: "todo",
			assigneeId: users[2].id, // Carol
			priority: "low",
			dueDate: new Date("2024-03-01"),
			createdAt: new Date("2024-02-10"),
		},
		{
			id: generateId(),
			title: "Fix login bug",
			description: "Resolve issue with password reset flow",
			status: "done",
			assigneeId: users[1].id, // Bob
			priority: "high",
			createdAt: new Date("2024-01-30"),
			completedAt: new Date("2024-02-05"),
		},
	];

	return { users, tasks };
}

// ============================================================================
// Migration Example
// ============================================================================

async function migrationExample(): Promise<void> {
	console.log("🚀 Database Migration Example");
	console.log("==============================");

	// ============================================================================
	// Step 1: Start with In-Memory Database
	// ============================================================================

	console.log("\n📋 Step 1: Creating in-memory database with sample data");

	const sampleData = generateSampleData();
	console.log(
		`   Generated ${sampleData.users.length} users and ${sampleData.tasks.length} tasks`,
	);

	// Create in-memory database (original approach)
	const inMemoryDb = await createDatabase(inMemoryConfig, sampleData);

	console.log("✅ In-memory database created and populated");

	// Verify data in memory
	const memoryUsers = await collect(inMemoryDb.users.query());
	const memoryTasks = await collect(inMemoryDb.tasks.query());

	console.log(
		`📊 In-memory data: ${memoryUsers.length} users, ${memoryTasks.length} tasks`,
	);

	// Show some sample data
	console.log("\n📝 Sample data in memory:");
	for (const user of memoryUsers) {
		const userTasks = await collect(
			inMemoryDb.tasks.query({
				where: { assigneeId: user.id },
			}),
		);
		console.log(
			`   👤 ${user.name} (${user.role}) - ${userTasks.length} tasks`,
		);
	}

	// ============================================================================
	// Step 2: Extract Data for Migration
	// ============================================================================

	console.log("\n📤 Step 2: Extracting data for migration");

	// Get all current data
	const currentUsers = await collect(inMemoryDb.users.query());
	const currentTasks = await collect(inMemoryDb.tasks.query());

	const extractedData: DatasetFor<typeof persistentConfig> = {
		users: currentUsers,
		tasks: currentTasks,
	};

	console.log("✅ Data extracted successfully");
	console.log(
		`   📊 Extracted: ${extractedData.users.length} users, ${extractedData.tasks.length} tasks`,
	);

	// ============================================================================
	// Step 3: Create Persistent Database with Migrated Data
	// ============================================================================

	console.log("\n💾 Step 3: Creating persistent database with migrated data");

	// Setup persistence
	const storageAdapter = createNodeStorageAdapter({
		createMissingDirectories: true,
	});
	const jsonSerializer = createJsonSerializer({ indent: 2 });
	const serializerRegistry = createSerializerRegistry([jsonSerializer]);

	// Create persistent database with the extracted data
	const persistentDb = await createDatabase(persistentConfig, extractedData, {
		persistence: {
			adapter: storageAdapter,
			serializerRegistry,
			writeDebounce: 100,
			watchFiles: false, // Disable during migration
		},
	});

	console.log("✅ Persistent database created with migrated data");
	console.log("   📄 Users saved to: ./data/users.json");
	console.log("   📄 Tasks saved to: ./data/tasks.json");

	// ============================================================================
	// Step 4: Verify Migration Success
	// ============================================================================

	console.log("\n✅ Step 4: Verifying migration");

	const persistentUsers = await collect(persistentDb.users.query());
	const persistentTasks = await collect(persistentDb.tasks.query());

	console.log(
		`📊 Persistent data: ${persistentUsers.length} users, ${persistentTasks.length} tasks`,
	);

	// Verify data integrity
	let migrationSuccess = true;

	if (persistentUsers.length !== currentUsers.length) {
		console.error(
			`❌ User count mismatch: ${persistentUsers.length} vs ${currentUsers.length}`,
		);
		migrationSuccess = false;
	}

	if (persistentTasks.length !== currentTasks.length) {
		console.error(
			`❌ Task count mismatch: ${persistentTasks.length} vs ${currentTasks.length}`,
		);
		migrationSuccess = false;
	}

	// Verify relationships still work
	const usersWithTasks = await collect(
		persistentDb.users.query({
			populate: {
				tasks: true,
			},
		}),
	);

	console.log("\n🔗 Verifying relationships:");
	for (const user of usersWithTasks) {
		const taskCount = user.tasks ? user.tasks.length : 0;
		console.log(`   👤 ${user.name}: ${taskCount} tasks`);
	}

	// ============================================================================
	// Step 5: Test Persistent Operations
	// ============================================================================

	console.log("\n🧪 Step 5: Testing persistent operations");

	// Add new data to verify persistence works
	const newUser = unwrapResult(
		await persistentDb.users.create({
			name: "David NewUser",
			email: "david@company.com",
			role: "user",
		}),
	);

	const newTask = unwrapResult(
		await persistentDb.tasks.create({
			title: "Test persistence",
			description: "Verify that new data is automatically saved",
			status: "todo",
			assigneeId: newUser.id,
			priority: "medium",
			dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
		}),
	);

	console.log("✅ Created new user and task (automatically persisted)");
	console.log(`   👤 New user: ${newUser.name}`);
	console.log(`   📋 New task: ${newTask.title}`);

	// Update existing data
	await persistentDb.tasks.update(newTask.id, {
		status: "in-progress",
	});

	console.log("✅ Updated task status (automatically persisted)");

	// ============================================================================
	// Step 6: Simulate Application Restart
	// ============================================================================

	console.log("\n🔄 Step 6: Simulating application restart");

	// Cleanup current database
	if ("cleanup" in persistentDb && typeof persistentDb.cleanup === "function") {
		persistentDb.cleanup();
	}

	// Create new database instance (simulating restart)
	// This should load data from the persisted files
	const restartedDb = await createDatabase(persistentConfig, undefined, {
		persistence: {
			adapter: storageAdapter,
			serializerRegistry,
			writeDebounce: 100,
			watchFiles: true,
		},
	});

	console.log("✅ Database restarted and data loaded from files");

	// Verify data survived the restart
	const reloadedUsers = await collect(restartedDb.users.query());
	const reloadedTasks = await collect(restartedDb.tasks.query());

	console.log(
		`📊 After restart: ${reloadedUsers.length} users, ${reloadedTasks.length} tasks`,
	);

	// Verify the new data we created is still there
	const davidUser = reloadedUsers.find((u) => u.name === "David NewUser");
	if (davidUser) {
		console.log("✅ New user data survived restart");

		const davidTasks = await collect(
			restartedDb.tasks.query({
				where: { assigneeId: davidUser.id },
			}),
		);
		console.log(`   📋 David has ${davidTasks.length} task(s)`);
	} else {
		console.error("❌ New user data lost during restart");
		migrationSuccess = false;
	}

	// ============================================================================
	// Migration Summary
	// ============================================================================

	console.log("\n📋 Migration Summary");
	console.log("====================");

	if (migrationSuccess) {
		console.log("✅ Migration completed successfully!");
		console.log("   ✨ All data migrated from in-memory to persistent storage");
		console.log("   ✨ Relationships preserved and working");
		console.log("   ✨ New operations automatically persisted");
		console.log("   ✨ Data survives application restarts");
		console.log("   ✨ Files created:");
		console.log("      📄 ./data/users.json");
		console.log("      📄 ./data/tasks.json");
	} else {
		console.error("❌ Migration encountered errors");
	}

	// Cleanup
	if ("cleanup" in restartedDb && typeof restartedDb.cleanup === "function") {
		restartedDb.cleanup();
	}

	console.log("\n🎉 Migration example complete!");
}

// ============================================================================
// Error Handling and Execution
// ============================================================================

async function runMigrationExample(): Promise<void> {
	try {
		await migrationExample();
	} catch (error) {
		console.error("❌ Migration example failed:", error);
		process.exit(1);
	}
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
	runMigrationExample();
}

export { migrationExample };
