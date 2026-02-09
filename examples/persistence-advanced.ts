/**
 * Advanced persistence example showing multiple file formats, shared files,
 * and mixed memory/persistent collections.
 */

import { z } from "zod";
import { createDatabase } from "../core/factories/database.js";
import { createNodeStorageAdapter } from "../core/storage/node-adapter.js";
import { createJsonSerializer } from "../core/serializers/json.js";
import { createYamlSerializer } from "../core/serializers/yaml.js";
import { createMessagePackSerializer } from "../core/serializers/messagepack.js";
import { createSerializerRegistry } from "../core/utils/file-extensions.js";
import { collect } from "../core/utils/async-iterable.js";
import type { Result } from "../core/errors/crud-errors.js";

// ============================================================================
// Schema Definitions
// ============================================================================

const UserSchema = z.object({
	id: z.string(),
	username: z.string(),
	email: z.string().email(),
	profile: z.object({
		firstName: z.string(),
		lastName: z.string(),
		bio: z.string().optional(),
		avatar: z.string().url().optional(),
	}),
	preferences: z.object({
		theme: z.enum(["light", "dark"]).default("light"),
		notifications: z.boolean().default(true),
		language: z.string().default("en"),
	}),
	createdAt: z.date().default(() => new Date()),
});

const ProductSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	price: z.number().positive(),
	category: z.string(),
	inStock: z.boolean().default(true),
	metadata: z.record(z.unknown()).default({}),
});

const OrderSchema = z.object({
	id: z.string(),
	userId: z.string(),
	productIds: z.array(z.string()),
	total: z.number().positive(),
	status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled"]),
	createdAt: z.date().default(() => new Date()),
	shippingAddress: z.object({
		street: z.string(),
		city: z.string(),
		state: z.string(),
		zipCode: z.string(),
		country: z.string(),
	}),
});

const SessionSchema = z.object({
	id: z.string(),
	userId: z.string(),
	token: z.string(),
	expiresAt: z.date(),
	createdAt: z.date().default(() => new Date()),
});

type User = z.infer<typeof UserSchema>;
type Product = z.infer<typeof ProductSchema>;
type Order = z.infer<typeof OrderSchema>;
type Session = z.infer<typeof SessionSchema>;

// ============================================================================
// Advanced Database Configuration
// ============================================================================

const advancedConfig = {
	// Users stored in YAML for human readability
	users: {
		schema: UserSchema,
		file: "./data/users.yaml",
		relationships: {
			orders: {
				type: "inverse" as const,
				target: "orders",
				foreignKey: "userId",
			},
			sessions: {
				type: "inverse" as const,
				target: "sessions",
				foreignKey: "userId",
			},
		},
	},

	// Products and orders share a JSON file for related data
	products: {
		schema: ProductSchema,
		file: "./data/catalog.json",
		relationships: {
			orders: {
				type: "inverse" as const,
				target: "orders",
				foreignKey: "productIds",
			},
		},
	},

	orders: {
		schema: OrderSchema,
		file: "./data/catalog.json", // Shared with products
		relationships: {
			user: {
				type: "ref" as const,
				target: "users",
				foreignKey: "userId",
			},
			products: {
				type: "ref" as const,
				target: "products",
				foreignKey: "productIds",
			},
		},
	},

	// Sessions are in-memory only (no file specified)
	sessions: {
		schema: SessionSchema,
		// No file = in-memory only for security
		relationships: {
			user: {
				type: "ref" as const,
				target: "users",
				foreignKey: "userId",
			},
		},
	},
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Unwraps a Result type, throwing an error if the operation failed
 */
function unwrapResult<T>(result: Result<T>): T {
	if (result.success) {
		return result.data;
	}
	throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
}

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Advanced Persistence Example
// ============================================================================

async function advancedPersistenceExample(): Promise<void> {
	console.log("🚀 Advanced Persistence Example");
	console.log("================================");

	// Create multiple serializers for different formats
	const jsonSerializer = createJsonSerializer({ indent: 2 });
	const yamlSerializer = createYamlSerializer({ indent: 2 });
	const msgpackSerializer = createMessagePackSerializer();

	// Create registry supporting multiple formats
	const serializerRegistry = createSerializerRegistry([
		jsonSerializer,
		yamlSerializer,
		msgpackSerializer,
	]);

	console.log(
		"📦 Configured serializers:",
		Object.keys(serializerRegistry).join(", "),
	);

	// Create database with advanced persistence options
	const db = await createDatabase(advancedConfig, undefined, {
		persistence: {
			adapter: createNodeStorageAdapter({
				createMissingDirectories: true,
				maxRetries: 3,
			}),
			serializerRegistry,
			writeDebounce: 200, // Slightly longer debounce for batch operations
			watchFiles: true,
		},
	});

	console.log("✅ Database created with multi-format persistence");
	console.log("   • Users: YAML format (./data/users.yaml)");
	console.log("   • Products & Orders: JSON format (./data/catalog.json)");
	console.log("   • Sessions: In-memory only");

	// ============================================================================
	// Create Sample Data
	// ============================================================================

	console.log("\n📝 Creating sample data...");

	// Create users (saved to YAML)
	const user1 = unwrapResult(
		await db.users.create({
			username: "alice_dev",
			email: "alice@techcorp.com",
			profile: {
				firstName: "Alice",
				lastName: "Johnson",
				bio: "Full-stack developer passionate about TypeScript",
				avatar: "https://example.com/avatars/alice.jpg",
			},
			preferences: {
				theme: "dark",
				notifications: true,
				language: "en",
			},
		}),
	);

	const user2 = unwrapResult(
		await db.users.create({
			username: "bob_designer",
			email: "bob@designco.com",
			profile: {
				firstName: "Bob",
				lastName: "Smith",
				bio: "UI/UX designer with a love for minimalism",
			},
			preferences: {
				theme: "light",
				notifications: false,
				language: "es",
			},
		}),
	);

	console.log(`✅ Created ${2} users (saved to YAML)`);

	// Create products (saved to JSON, shared file with orders)
	const products = await Promise.all(
		[
			db.products.create({
				name: "TypeScript Handbook",
				description: "Comprehensive guide to TypeScript programming",
				price: 29.99,
				category: "Books",
				metadata: { author: "Microsoft", pages: 400, format: "PDF" },
			}),
			db.products.create({
				name: "Wireless Headphones",
				description: "Premium noise-cancelling wireless headphones",
				price: 199.99,
				category: "Electronics",
				metadata: { brand: "AudioTech", color: "Black", warranty: "2 years" },
			}),
			db.products.create({
				name: "Ergonomic Keyboard",
				description: "Mechanical keyboard designed for comfort",
				price: 129.99,
				category: "Electronics",
				metadata: { switches: "Cherry MX Blue", backlight: true },
			}),
		].map(async (productPromise) => unwrapResult(await productPromise)),
	);

	console.log(`✅ Created ${products.length} products (saved to JSON)`);

	// Create orders (saved to JSON, shared file with products)
	const order1 = unwrapResult(
		await db.orders.create({
			userId: user1.id,
			productIds: [products[0].id, products[2].id],
			total: 159.98,
			status: "confirmed",
			shippingAddress: {
				street: "123 Developer St",
				city: "San Francisco",
				state: "CA",
				zipCode: "94105",
				country: "USA",
			},
		}),
	);

	const order2 = unwrapResult(
		await db.orders.create({
			userId: user2.id,
			productIds: [products[1].id],
			total: 199.99,
			status: "pending",
			shippingAddress: {
				street: "456 Design Ave",
				city: "New York",
				state: "NY",
				zipCode: "10001",
				country: "USA",
			},
		}),
	);

	console.log(`✅ Created ${2} orders (saved to JSON, shared file)`);

	// Create sessions (in-memory only)
	const session1 = unwrapResult(
		await db.sessions.create({
			userId: user1.id,
			token: "jwt_token_abc123",
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
		}),
	);

	const session2 = unwrapResult(
		await db.sessions.create({
			userId: user2.id,
			token: "jwt_token_xyz789",
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
		}),
	);

	console.log(`✅ Created ${2} sessions (in-memory only, not persisted)`);

	// ============================================================================
	// Complex Queries with Relationships
	// ============================================================================

	console.log("\n🔍 Running complex queries...");

	// Get users with their orders and order products (simplified query for now)
	const usersWithOrderDetails = await collect(
		db.users.query({
			populate: {
				orders: true,
			},
		}),
	);

	console.log("📊 Users with order details:");
	for (const user of usersWithOrderDetails) {
		console.log(
			`   👤 ${user.profile.firstName} ${user.profile.lastName} (@${user.username})`,
		);
		if (user.orders && user.orders.length > 0) {
			for (const order of user.orders) {
				console.log(`      💰 Order: $${order.total} (${order.status})`);
				console.log(`         📦 Products: ${order.productIds.join(", ")}`);
			}
		} else {
			console.log("      📭 No orders");
		}
	}

	// Query products by category with order information
	const electronicsWithOrders = await collect(
		db.products.query({
			where: {
				category: "Electronics",
				inStock: true,
			},
			populate: {
				orders: {
					user: true,
				},
			},
			sort: {
				price: "desc",
			},
		}),
	);

	console.log("\n📱 Electronics products (by price, descending):");
	for (const product of electronicsWithOrders) {
		console.log(`   💻 ${product.name} - $${product.price}`);
		if (product.orders && product.orders.length > 0) {
			console.log(`      📦 ${product.orders.length} orders`);
		} else {
			console.log("      📭 No orders yet");
		}
	}

	// ============================================================================
	// In-Memory vs Persistent Data Demonstration
	// ============================================================================

	console.log("\n🧠 Memory vs Persistence demonstration:");

	const allUsers = await collect(db.users.query());
	const allProducts = await collect(db.products.query());
	const allOrders = await collect(db.orders.query());
	const allSessions = await collect(db.sessions.query());

	console.log("📊 Data summary:");
	console.log(`   👥 Users: ${allUsers.length} (persisted to YAML)`);
	console.log(`   📦 Products: ${allProducts.length} (persisted to JSON)`);
	console.log(
		`   📋 Orders: ${allOrders.length} (persisted to JSON, shared file)`,
	);
	console.log(`   🔐 Sessions: ${allSessions.length} (in-memory only)`);

	// ============================================================================
	// Batch Operations
	// ============================================================================

	console.log("\n⚡ Performing batch operations...");

	// Update multiple products at once
	for (const product of products) {
		await db.products.update(product.id, {
			metadata: {
				...product.metadata,
				lastUpdated: new Date().toISOString(),
			},
		});
	}

	console.log("✅ Updated all products with timestamps");

	// Update user preferences
	await db.users.update(user1.id, {
		preferences: {
			...user1.preferences,
			notifications: false, // Alice turns off notifications
		},
	});

	console.log("✅ Updated user preferences");

	// ============================================================================
	// File Format Verification
	// ============================================================================

	console.log("\n📁 File storage summary:");
	console.log("   📄 ./data/users.yaml - User data in YAML format");
	console.log("   📄 ./data/catalog.json - Products and orders in JSON format");
	console.log("   🧠 Sessions stored in memory only (for security)");

	// ============================================================================
	// Cleanup
	// ============================================================================

	console.log("\n🧹 Cleaning up...");

	if ("cleanup" in db && typeof db.cleanup === "function") {
		db.cleanup();
	}

	console.log("✅ Cleanup complete");
	console.log("\n🎉 Advanced persistence example complete!");
	console.log("\n💡 Key features demonstrated:");
	console.log("   ✨ Multiple file formats (JSON, YAML)");
	console.log("   ✨ Shared files for related collections");
	console.log("   ✨ Mixed persistent/in-memory storage");
	console.log("   ✨ Complex relationships and queries");
	console.log("   ✨ Automatic serialization and persistence");
}

// ============================================================================
// Error Handling and Execution
// ============================================================================

async function runAdvancedExample(): Promise<void> {
	try {
		await advancedPersistenceExample();
	} catch (error) {
		console.error("❌ Advanced example failed:", error);
		process.exit(1);
	}
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
	runAdvancedExample();
}

export { advancedPersistenceExample };
