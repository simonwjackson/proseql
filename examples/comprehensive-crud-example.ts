/**
 * Comprehensive CRUD Example - E-commerce Domain
 *
 * This example demonstrates ALL database v2 features including:
 * - Complete CRUD operations with error handling
 * - Update operators (numeric, string, array, boolean)
 * - Advanced querying with all filter operators
 * - Relationship operations and deep population
 * - Field selection with array and object syntax
 * - Real-world scenarios and best practices
 * - Type safety demonstrations
 */

import { z } from "zod";
import type {
	Result,
	CrudError,
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	UniqueConstraintError,
} from "../core/errors/crud-errors";
import {
	isOk,
	isErr,
	isNotFoundError,
	isDuplicateKeyError,
	isForeignKeyError,
	isValidationError,
	isUniqueConstraintError,
	handleCrudError,
} from "../core/errors/crud-errors";
import { createDatabase } from "../core/factories/database";
import type { UpdateWithOperators } from "../core/types/crud-types";

// ============================================================================
// 1. SCHEMA SETUP - E-COMMERCE DOMAIN
// ============================================================================

// User schema with soft delete support
const UserSchema = z.object({
	id: z.string(),
	email: z.string().email(),
	username: z.string().min(3).max(30),
	password: z.string().min(8), // In real app, this would be hashed
	firstName: z.string(),
	lastName: z.string(),
	role: z.enum(["customer", "admin", "vendor"]),
	isActive: z.boolean().default(true),
	emailVerified: z.boolean().default(false),
	tags: z.array(z.string()).default([]), // For demonstrating array operators
	metadata: z.record(z.unknown()).optional(), // Flexible metadata
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	deletedAt: z.string().datetime().optional(), // Soft delete support
});

// Product schema with inventory tracking
const ProductSchema = z.object({
	id: z.string(),
	sku: z.string(),
	name: z.string(),
	description: z.string(),
	price: z.number().positive(),
	compareAtPrice: z.number().positive().optional(),
	cost: z.number().nonnegative().optional(),
	inventory: z.number().int().nonnegative().default(0),
	lowStockThreshold: z.number().int().default(10),
	isPublished: z.boolean().default(false),
	tags: z.array(z.string()).default([]),
	features: z.array(z.string()).default([]),
	categoryId: z.string(),
	vendorId: z.string().optional(),
	images: z
		.array(
			z.object({
				url: z.string().url(),
				alt: z.string(),
				isPrimary: z.boolean().default(false),
			}),
		)
		.default([]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// Order schema with status tracking
const OrderSchema = z.object({
	id: z.string(),
	orderNumber: z.string(),
	userId: z.string(),
	status: z.enum([
		"pending",
		"processing",
		"shipped",
		"delivered",
		"cancelled",
		"refunded",
	]),
	subtotal: z.number().nonnegative(),
	tax: z.number().nonnegative(),
	shipping: z.number().nonnegative(),
	total: z.number().nonnegative(),
	notes: z.string().optional(),
	shippingAddress: z.object({
		street: z.string(),
		city: z.string(),
		state: z.string(),
		zip: z.string(),
		country: z.string(),
	}),
	billingAddress: z
		.object({
			street: z.string(),
			city: z.string(),
			state: z.string(),
			zip: z.string(),
			country: z.string(),
		})
		.optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	shippedAt: z.string().datetime().optional(),
	deliveredAt: z.string().datetime().optional(),
});

// OrderItem junction table
const OrderItemSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	productId: z.string(),
	quantity: z.number().int().positive(),
	price: z.number().positive(), // Price at time of purchase
	total: z.number().positive(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// Review schema
const ReviewSchema = z.object({
	id: z.string(),
	productId: z.string(),
	userId: z.string(),
	rating: z.number().int().min(1).max(5),
	title: z.string(),
	comment: z.string(),
	isVerifiedPurchase: z.boolean().default(false),
	helpful: z.number().int().default(0),
	notHelpful: z.number().int().default(0),
	images: z.array(z.string().url()).default([]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// Category schema
const CategorySchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	description: z.string().optional(),
	parentId: z.string().optional(), // For nested categories
	isActive: z.boolean().default(true),
	sortOrder: z.number().int().default(0),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// Inventory tracking schema
const InventorySchema = z.object({
	id: z.string(),
	productId: z.string(),
	warehouseId: z.string().default("main"),
	quantity: z.number().int().nonnegative(),
	reservedQuantity: z.number().int().nonnegative().default(0),
	lastRestockedAt: z.string().datetime().optional(),
	notes: z.string().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// ============================================================================
// 2. DATABASE CONFIGURATION
// ============================================================================

const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {
			orders: {
				type: "inverse" as const,
				target: "orders",
				foreignKey: "userId",
			},
			reviews: {
				type: "inverse" as const,
				target: "reviews",
				foreignKey: "userId",
			},
		},
	},
	products: {
		schema: ProductSchema,
		relationships: {
			category: {
				type: "ref" as const,
				target: "categories",
				foreignKey: "categoryId",
			},
			vendor: { type: "ref" as const, target: "users", foreignKey: "vendorId" },
			orderItems: {
				type: "inverse" as const,
				target: "orderItems",
				foreignKey: "productId",
			},
			reviews: {
				type: "inverse" as const,
				target: "reviews",
				foreignKey: "productId",
			},
			inventory: {
				type: "inverse" as const,
				target: "inventory",
				foreignKey: "productId",
			},
		},
	},
	orders: {
		schema: OrderSchema,
		relationships: {
			user: { type: "ref" as const, target: "users", foreignKey: "userId" },
			items: {
				type: "inverse" as const,
				target: "orderItems",
				foreignKey: "orderId",
			},
		},
	},
	orderItems: {
		schema: OrderItemSchema,
		relationships: {
			order: { type: "ref" as const, target: "orders", foreignKey: "orderId" },
			product: {
				type: "ref" as const,
				target: "products",
				foreignKey: "productId",
			},
		},
	},
	reviews: {
		schema: ReviewSchema,
		relationships: {
			product: {
				type: "ref" as const,
				target: "products",
				foreignKey: "productId",
			},
			user: { type: "ref" as const, target: "users", foreignKey: "userId" },
		},
	},
	categories: {
		schema: CategorySchema,
		relationships: {
			parent: {
				type: "ref" as const,
				target: "categories",
				foreignKey: "parentId",
			},
			children: {
				type: "inverse" as const,
				target: "categories",
				foreignKey: "parentId",
			},
			products: {
				type: "inverse" as const,
				target: "products",
				foreignKey: "categoryId",
			},
		},
	},
	inventory: {
		schema: InventorySchema,
		relationships: {
			product: {
				type: "ref" as const,
				target: "products",
				foreignKey: "productId",
			},
		},
	},
} as const;

// Initial data
const initialData = {
	users: [],
	products: [],
	orders: [],
	orderItems: [],
	reviews: [],
	categories: [],
	inventory: [],
};

// Create database instance
const db = createDatabase(dbConfig, initialData);

// ============================================================================
// 3. HELPER FUNCTIONS
// ============================================================================

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function getCurrentTimestamp(): string {
	return new Date().toISOString();
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of iterable) {
		results.push(item);
	}
	return results;
}

// ============================================================================
// 4. CRUD OPERATIONS WITH ERROR HANDLING
// ============================================================================

async function demonstrateCrudOperations() {
	console.log("\n=== CRUD OPERATIONS DEMO ===\n");

	// ------------------------------------------------------------------------
	// CREATE OPERATIONS
	// ------------------------------------------------------------------------
	console.log("--- Create Operations ---");

	// Single entity creation with validation
	const userResult = await db.users.create({
		email: "john.doe@example.com",
		username: "johndoe",
		password: "securepassword123",
		firstName: "John",
		lastName: "Doe",
		role: "customer",
		tags: ["premium", "early-adopter"],
	});

	if (isOk(userResult)) {
		console.log("✓ User created:", userResult.data.id);
	} else {
		console.error("✗ Failed to create user:", userResult.error);
	}

	// Create categories
	const electronicsCategory = await db.categories.create({
		name: "Electronics",
		slug: "electronics",
		description: "Electronic devices and accessories",
	});

	const phonesCategory = await db.categories.create({
		name: "Phones",
		slug: "phones",
		parentId: isOk(electronicsCategory)
			? electronicsCategory.data.id
			: undefined,
	});

	// Batch creation with skipDuplicates
	const productsResult = await db.products.createMany(
		[
			{
				sku: "PHONE-001",
				name: "Smartphone Pro Max",
				description: "Latest flagship smartphone",
				price: 999.99,
				compareAtPrice: 1199.99,
				inventory: 50,
				categoryId: isOk(phonesCategory) ? phonesCategory.data.id : "",
				tags: ["smartphone", "flagship", "5g"],
				features: ["5G", "OLED Display", "Triple Camera"],
			},
			{
				sku: "PHONE-002",
				name: "Budget Phone",
				description: "Affordable smartphone option",
				price: 299.99,
				inventory: 100,
				categoryId: isOk(phonesCategory) ? phonesCategory.data.id : "",
				tags: ["smartphone", "budget"],
				features: ["4G", "Dual Camera"],
			},
		],
		{ skipDuplicates: true },
	);

	if (isOk(productsResult)) {
		console.log(`✓ Created ${productsResult.data.created.length} products`);
		if (productsResult.data.skipped && productsResult.data.skipped.length > 0) {
			console.log(`  Skipped ${productsResult.data.skipped.length} duplicates`);
		}
	}

	// Handle duplicate key error
	const duplicateUserResult = await db.users.create({
		email: "john.doe@example.com", // Same email - will cause error
		username: "johndoe2",
		password: "anotherpassword",
		firstName: "John",
		lastName: "Smith",
		role: "customer",
	});

	if (
		isErr(duplicateUserResult) &&
		isDuplicateKeyError(duplicateUserResult.error)
	) {
		console.log(
			"✓ Duplicate key error handled correctly:",
			duplicateUserResult.error.field,
			duplicateUserResult.error.value,
		);
	}

	// ------------------------------------------------------------------------
	// UPDATE OPERATIONS WITH OPERATORS
	// ------------------------------------------------------------------------
	console.log("\n--- Update Operations with Operators ---");

	if (isOk(userResult)) {
		// String operators
		const updateWithStringOps = await db.users.update(userResult.data.id, {
			firstName: { $prepend: "Dr. " },
			lastName: { $append: " Jr." },
		});

		if (isOk(updateWithStringOps)) {
			console.log(
				"✓ String operators applied:",
				updateWithStringOps.data.firstName,
				updateWithStringOps.data.lastName,
			);
		}

		// Array operators
		const updateWithArrayOps = await db.users.update(userResult.data.id, {
			tags: { $append: ["vip", "newsletter-subscriber"] },
		});

		if (isOk(updateWithArrayOps)) {
			console.log("✓ Array append:", updateWithArrayOps.data.tags);
		}

		// Remove from array
		const removeFromArray = await db.users.update(userResult.data.id, {
			tags: { $remove: "early-adopter" },
		});

		if (isOk(removeFromArray)) {
			console.log("✓ Array remove:", removeFromArray.data.tags);
		}

		// Boolean toggle
		const toggleActive = await db.users.update(userResult.data.id, {
			isActive: { $toggle: true },
		});

		if (isOk(toggleActive)) {
			console.log("✓ Boolean toggled:", toggleActive.data.isActive);
		}
	}

	// Numeric operators on products
	if (isOk(productsResult) && productsResult.data.created.length > 0) {
		const product = productsResult.data.created[0];

		// Increment inventory
		const incrementResult = await db.products.update(product.id, {
			inventory: { $increment: 10 },
			price: { $multiply: 0.9 }, // 10% discount
		});

		if (isOk(incrementResult)) {
			console.log(
				"✓ Numeric operators:",
				`inventory: ${incrementResult.data.inventory}`,
				`price: ${incrementResult.data.price}`,
			);
		}
	}

	// Batch update with complex conditions
	const updateManyResult = await db.products.updateMany(
		{
			$and: [
				{ price: { $lt: 500 } },
				{ inventory: { $gt: 0 } },
				{ tags: { $contains: "budget" } },
			],
		},
		{
			isPublished: { $set: true },
			tags: { $append: "on-sale" },
			price: { $multiply: 0.85 }, // 15% off
		},
	);

	if (isOk(updateManyResult)) {
		console.log(`✓ Batch updated ${updateManyResult.data.count} products`);
	}

	// ------------------------------------------------------------------------
	// DELETE OPERATIONS
	// ------------------------------------------------------------------------
	console.log("\n--- Delete Operations ---");

	// Create a test user for deletion
	const testUserResult = await db.users.create({
		email: "test.delete@example.com",
		username: "testdelete",
		password: "testpass123",
		firstName: "Test",
		lastName: "Delete",
		role: "customer",
	});

	if (isOk(testUserResult)) {
		// Soft delete (if entity has deletedAt field)
		const softDeleteResult = await db.users.delete(testUserResult.data.id, {
			soft: true,
			returnDeleted: true,
		});

		if (isOk(softDeleteResult)) {
			console.log("✓ Soft deleted user:", softDeleteResult.data.deletedAt);
		}

		// Query excludes soft deleted by default
		const allUsers = await collect(db.users.query());
		const foundDeleted = allUsers.find((u) => u.id === testUserResult.data.id);
		console.log("✓ Soft deleted user excluded from queries:", !foundDeleted);
	}

	// Batch delete with conditions
	const deleteManyResult = await db.products.deleteMany(
		{
			$and: [{ inventory: { $eq: 0 } }, { isPublished: { $eq: false } }],
		},
		{ limit: 5 }, // Safety limit
	);

	if (isOk(deleteManyResult)) {
		console.log(`✓ Batch deleted ${deleteManyResult.data.count} products`);
	}

	// ------------------------------------------------------------------------
	// UPSERT OPERATIONS
	// ------------------------------------------------------------------------
	console.log("\n--- Upsert Operations ---");

	// Single upsert - will create
	const upsertCreateResult = await db.users.upsert({
		where: { id: "non-existent-id" },
		create: {
			email: "upsert.create@example.com",
			username: "upsertcreate",
			password: "upsertpass123",
			firstName: "Upsert",
			lastName: "Create",
			role: "vendor",
		},
		update: {
			firstName: { $set: "Updated" },
			updatedAt: { $set: getCurrentTimestamp() },
		},
	});

	if (isOk(upsertCreateResult)) {
		console.log(
			"✓ Upsert created new user:",
			upsertCreateResult.data.__action,
			upsertCreateResult.data.id,
		);
	}

	// Single upsert - will update
	if (isOk(upsertCreateResult)) {
		const upsertUpdateResult = await db.users.upsert({
			where: { id: upsertCreateResult.data.id },
			create: {
				email: "should.not.create@example.com",
				username: "shouldnotcreate",
				password: "shouldnotcreate",
				firstName: "Should",
				lastName: "NotCreate",
				role: "customer",
			},
			update: {
				firstName: { $set: "Actually Updated" },
				tags: { $append: "upserted" },
			},
		});

		if (isOk(upsertUpdateResult)) {
			console.log(
				"✓ Upsert updated existing user:",
				upsertUpdateResult.data.__action,
				upsertUpdateResult.data.firstName,
			);
		}
	}

	// Batch upsert
	const upsertManyResult = await db.categories.upsertMany([
		{
			where: { id: "cat-1" },
			create: { name: "Books", slug: "books" },
			update: { sortOrder: { $increment: 1 } },
		},
		{
			where: { id: "cat-2" },
			create: { name: "Clothing", slug: "clothing" },
			update: { isActive: { $set: true } },
		},
	]);

	if (isOk(upsertManyResult)) {
		console.log(
			"✓ Batch upsert results:",
			`created: ${upsertManyResult.data.created.length}`,
			`updated: ${upsertManyResult.data.updated.length}`,
			`unchanged: ${upsertManyResult.data.unchanged.length}`,
		);
	}
}

// ============================================================================
// 5. ADVANCED QUERYING
// ============================================================================

async function demonstrateAdvancedQuerying() {
	console.log("\n=== ADVANCED QUERYING DEMO ===\n");

	// Setup some test data
	await setupTestData();

	// ------------------------------------------------------------------------
	// FILTER OPERATORS
	// ------------------------------------------------------------------------
	console.log("--- Filter Operators ---");

	// Comparison operators
	const expensiveProducts = await collect(
		db.products.query({
			where: { price: { $gte: 500 } },
			sort: { price: "desc" },
		}),
	);
	console.log(`✓ Products >= $500: ${expensiveProducts.length}`);

	// String operators
	const proProducts = await collect(
		db.products.query({
			where: { name: { $contains: "Pro" } },
		}),
	);
	console.log(`✓ Products containing "Pro": ${proProducts.length}`);

	// Array operators - contains
	const smartphoneProducts = await collect(
		db.products.query({
			where: { tags: { $contains: "smartphone" } },
		}),
	);
	console.log(`✓ Products tagged "smartphone": ${smartphoneProducts.length}`);

	// Array operators - all
	const premiumSmartphones = await collect(
		db.products.query({
			where: { tags: { $all: ["smartphone", "flagship"] } },
		}),
	);
	console.log(
		`✓ Products with all tags [smartphone, flagship]: ${premiumSmartphones.length}`,
	);

	// Array operators - size
	const multiTaggedProducts = await collect(
		db.products.query({
			where: { tags: { $size: 3 } },
		}),
	);
	console.log(`✓ Products with exactly 3 tags: ${multiTaggedProducts.length}`);

	// ------------------------------------------------------------------------
	// LOGICAL OPERATORS
	// ------------------------------------------------------------------------
	console.log("\n--- Logical Operators ---");

	// Complex AND query
	const inStockExpensiveProducts = await collect(
		db.products.query({
			where: {
				$and: [
					{ price: { $gte: 500 } },
					{ inventory: { $gt: 0 } },
					{ isPublished: true },
				],
			},
		}),
	);
	console.log(
		`✓ In-stock expensive published products: ${inStockExpensiveProducts.length}`,
	);

	// OR query
	const discountedOrLowStock = await collect(
		db.products.query({
			where: {
				$or: [
					{ compareAtPrice: { $ne: undefined } },
					{ inventory: { $lte: 10 } },
				],
			},
		}),
	);
	console.log(
		`✓ Discounted or low stock products: ${discountedOrLowStock.length}`,
	);

	// Nested logical operators
	const complexQuery = await collect(
		db.products.query({
			where: {
				$and: [
					{
						$or: [{ price: { $lt: 300 } }, { tags: { $contains: "budget" } }],
					},
					{ isPublished: true },
					{ inventory: { $gt: 0 } },
				],
			},
			sort: { price: "asc" },
			limit: 5,
		}),
	);
	console.log(`✓ Complex nested query results: ${complexQuery.length}`);

	// ------------------------------------------------------------------------
	// RELATIONSHIP FILTERING
	// ------------------------------------------------------------------------
	console.log("\n--- Relationship Filtering ---");

	// Filter through populated relationships
	const electronicsWithProducts = await collect(
		db.categories.query({
			where: { slug: "electronics" },
			populate: {
				products: {
					where: { isPublished: true },
					sort: { price: "desc" },
					limit: 3,
				},
			},
		}),
	);

	if (electronicsWithProducts.length > 0) {
		const category =
			electronicsWithProducts[0] as (typeof electronicsWithProducts)[0] & {
				products?: Array<{ name: string; price: number }>;
			};
		if (category.products) {
			console.log(
				`✓ Electronics category has ${category.products.length} published products`,
			);
		}
	}

	// Deep relationship filtering
	const ordersWithExpensiveItems = await collect(
		db.orders.query({
			populate: {
				items: true,
			},
		}),
	);
	console.log(
		`✓ Orders containing expensive items: ${ordersWithExpensiveItems.length}`,
	);

	// ------------------------------------------------------------------------
	// SORTING AND PAGINATION
	// ------------------------------------------------------------------------
	console.log("\n--- Sorting and Pagination ---");

	// Multi-field sorting
	const sortedProducts = await collect(
		db.products.query({
			sort: { isPublished: "desc", price: "asc", name: "asc" },
			limit: 10,
		}),
	);
	console.log(`✓ Multi-field sorted products: ${sortedProducts.length}`);

	// Pagination example
	const pageSize = 5;
	let totalProducts = 0;
	for (let page = 0; page < 3; page++) {
		const pageResults = await collect(
			db.products.query({
				sort: { createdAt: "desc" },
				limit: pageSize,
				offset: page * pageSize,
			}),
		);
		totalProducts += pageResults.length;
		console.log(`✓ Page ${page + 1}: ${pageResults.length} products`);
	}
}

// ============================================================================
// 6. FIELD SELECTION
// ============================================================================

async function demonstrateFieldSelection() {
	console.log("\n=== FIELD SELECTION DEMO ===\n");

	// Array syntax - simple field selection
	const usersBasicInfo = await collect(
		db.users.query({
			select: ["id", "email", "username", "role"],
			limit: 5,
		}),
	);
	console.log(
		"✓ Array syntax selection:",
		Object.keys(usersBasicInfo[0] || {}),
	);

	// Object syntax - nested selection
	const productsWithSelection = await collect(
		db.products.query({
			select: {
				id: true,
				name: true,
				price: true,
				category: {
					id: true,
					name: true,
					slug: true,
				},
				reviews: {
					rating: true,
					title: true,
					user: {
						username: true,
					},
					limit: 3,
				},
			},
			populate: {
				category: true,
				reviews: {
					populate: {
						user: true,
					},
				},
			},
			limit: 2,
		}),
	);

	if (productsWithSelection.length > 0) {
		console.log("✓ Object syntax with nested selection:");
		console.log("  Product fields:", Object.keys(productsWithSelection[0]));
		// Check if category is populated (it should be when using populate: { category: true })
		const firstProduct =
			productsWithSelection[0] as (typeof productsWithSelection)[0] & {
				category?: unknown;
			};
		if (
			firstProduct.category &&
			typeof firstProduct.category === "object" &&
			firstProduct.category !== null
		) {
			console.log("  Category fields:", Object.keys(firstProduct.category));
		}
	}

	// Combining select with populate
	const ordersWithSelectedFields = await collect(
		db.orders.query({
			select: {
				id: true,
				orderNumber: true,
				total: true,
				status: true,
				user: {
					email: true,
					firstName: true,
					lastName: true,
				},
				items: {
					quantity: true,
					price: true,
					product: {
						name: true,
						sku: true,
					},
				},
			},
			populate: {
				user: true,
				items: true,
			},
			where: {
				$or: [{ status: "pending" }, { status: "processing" }],
			},
		}),
	);

	console.log(
		`✓ Orders with selected fields: ${ordersWithSelectedFields.length}`,
	);
}

// ============================================================================
// 7. RELATIONSHIP OPERATIONS
// ============================================================================

async function demonstrateRelationshipOperations() {
	console.log("\n=== RELATIONSHIP OPERATIONS DEMO ===\n");

	// Deep nested population (3+ levels)
	const deepPopulation = await collect(
		db.orders.query({
			populate: {
				user: {
					populate: {
						reviews: {
							populate: {
								product: {
									populate: {
										category: true,
									},
								},
							},
							limit: 2,
						},
					},
				},
				items: {
					populate: {
						product: {
							populate: {
								category: {
									populate: {
										parent: true,
									},
								},
								vendor: true,
							},
						},
					},
				},
			},
			limit: 1,
		}),
	);

	if (deepPopulation.length > 0) {
		console.log("✓ Deep population successful:");
		console.log("  Order -> User -> Reviews -> Product -> Category");
		console.log("  Order -> Items -> Product -> Category -> Parent");
	}

	// Foreign key validation examples
	console.log("\n--- Foreign Key Validation ---");

	// Invalid foreign key
	const invalidFKResult = await db.products.create({
		sku: "INVALID-FK",
		name: "Product with Invalid Category",
		description: "This should fail",
		price: 99.99,
		categoryId: "non-existent-category-id",
	});

	if (isErr(invalidFKResult) && isForeignKeyError(invalidFKResult.error)) {
		console.log(
			"✓ Foreign key validation working:",
			invalidFKResult.error.field,
			invalidFKResult.error.targetCollection,
		);
	}

	// Cascade behavior simulation (manual since DB doesn't auto-cascade)
	const categoryToDelete = await db.categories.create({
		name: "Temporary Category",
		slug: "temp-category",
	});

	if (isOk(categoryToDelete)) {
		// Create product in this category
		const tempProduct = await db.products.create({
			sku: "TEMP-PROD",
			name: "Temporary Product",
			description: "Will be affected by category deletion",
			price: 50,
			categoryId: categoryToDelete.data.id,
		});

		if (isOk(tempProduct)) {
			// Check for dependent products before deleting category
			const dependentProducts = await collect(
				db.products.query({
					where: { categoryId: categoryToDelete.data.id },
				}),
			);

			console.log(
				`✓ Found ${dependentProducts.length} products dependent on category`,
			);

			// Would need to handle deletion manually
			// In a real app, you might:
			// 1. Prevent deletion if products exist
			// 2. Set products' categoryId to null
			// 3. Move products to a default category
		}
	}
}

// ============================================================================
// 8. ERROR HANDLING PATTERNS
// ============================================================================

async function demonstrateErrorHandling() {
	console.log("\n=== ERROR HANDLING PATTERNS DEMO ===\n");

	// Using Result type with pattern matching
	const result = await db.users.create({
		email: "error.demo@example.com",
		username: "er", // Too short - will fail validation
		password: "pass", // Too short - will fail validation
		firstName: "Error",
		lastName: "Demo",
		role: "customer",
	});

	if (isErr(result)) {
		// Type-safe error handling
		handleCrudError(result.error, {
			notFound: (error) => {
				console.log(`Not found: ${error.entity} ${error.id}`);
			},
			duplicateKey: (error) => {
				console.log(`Duplicate: ${error.field} = ${error.value}`);
			},
			foreignKey: (error) => {
				console.log(
					`FK violation: ${error.field} -> ${error.targetCollection}`,
				);
			},
			validation: (error) => {
				console.log("✓ Validation errors caught:");
				error.errors.forEach((e) => {
					console.log(`  - ${e.field}: ${e.message}`);
				});
			},
			uniqueConstraint: (error) => {
				console.log(`Unique constraint: ${error.constraint}`);
			},
			operationNotAllowed: (error) => {
				console.log(`Not allowed: ${error.operation} - ${error.reason}`);
			},
			transaction: (error) => {
				console.log(`Transaction error: ${error.operation} - ${error.reason}`);
			},
			unknown: (error) => {
				console.log(`Unknown error: ${error.message}`);
			},
		});
	}

	// Type guards for specific handling
	const anotherResult = await db.products.create({
		sku: "ERR-002",
		name: "", // Empty name - validation error
		description: "Test",
		price: -10, // Negative price - validation error
		categoryId: "invalid-category",
	});

	if (isErr(anotherResult)) {
		if (isValidationError(anotherResult.error)) {
			console.log("\n✓ Specific validation error handling:");
			console.log(`  Total errors: ${anotherResult.error.errors.length}`);
			console.log(
				`  Fields with errors: ${anotherResult.error.errors.map((e) => e.field).join(", ")}`,
			);
		} else if (isForeignKeyError(anotherResult.error)) {
			console.log("\n✓ Foreign key error:", anotherResult.error.message);
		}
	}
}

// ============================================================================
// 9. REAL-WORLD SCENARIOS
// ============================================================================

async function demonstrateRealWorldScenarios() {
	console.log("\n=== REAL-WORLD SCENARIOS DEMO ===\n");

	// ------------------------------------------------------------------------
	// User Registration with Email Uniqueness
	// ------------------------------------------------------------------------
	console.log("--- User Registration Flow ---");

	async function registerUser(
		email: string,
		username: string,
		password: string,
	) {
		// Check if email already exists
		const existingUsers = await collect(
			db.users.query({
				where: { email },
				limit: 1,
			}),
		);

		if (existingUsers.length > 0) {
			console.log("✗ Registration failed: Email already exists");
			return null;
		}

		// Create new user
		const result = await db.users.create({
			email,
			username,
			password, // In real app: hash the password
			firstName: "New",
			lastName: "User",
			role: "customer",
			emailVerified: false,
			tags: ["new-user", "pending-verification"],
		});

		if (isOk(result)) {
			console.log("✓ User registered successfully:", result.data.email);
			// In real app: Send verification email
			return result.data;
		} else {
			console.log("✗ Registration failed:", result.error.message);
			return null;
		}
	}

	await registerUser("newuser@example.com", "newuser123", "securepass123");

	// ------------------------------------------------------------------------
	// Order Placement with Inventory Updates
	// ------------------------------------------------------------------------
	console.log("\n--- Order Placement Flow ---");

	async function placeOrder(
		userId: string,
		items: Array<{ productId: string; quantity: number }>,
	) {
		// Validate all products exist and have sufficient inventory
		const validationResults = await Promise.all(
			items.map(async (item) => {
				const products = await collect(
					db.products.query({
						where: { id: item.productId },
						limit: 1,
					}),
				);

				if (products.length === 0) {
					return {
						valid: false,
						reason: `Product ${item.productId} not found`,
					};
				}

				const product = products[0];
				if ((product.inventory ?? 0) < item.quantity) {
					return {
						valid: false,
						reason: `Insufficient inventory for ${product.name}`,
					};
				}

				return { valid: true, product };
			}),
		);

		const invalid = validationResults.find((r) => !r.valid);
		if (invalid) {
			console.log("✗ Order validation failed:", invalid.reason);
			return null;
		}

		// Calculate totals
		let subtotal = 0;
		const orderItems: Array<{
			productId: string;
			quantity: number;
			price: number;
			total: number;
		}> = [];

		for (let i = 0; i < items.length; i++) {
			const result = validationResults[i];
			if (result.valid && result.product) {
				const itemTotal = result.product.price * items[i].quantity;
				subtotal += itemTotal;

				orderItems.push({
					productId: items[i].productId,
					quantity: items[i].quantity,
					price: result.product.price,
					total: itemTotal,
				});
			}
		}

		const tax = subtotal * 0.08; // 8% tax
		const shipping = subtotal > 100 ? 0 : 10; // Free shipping over $100
		const total = subtotal + tax + shipping;

		// Create order
		const orderResult = await db.orders.create({
			orderNumber: `ORD-${Date.now()}`,
			userId,
			status: "pending",
			subtotal,
			tax,
			shipping,
			total,
			shippingAddress: {
				street: "123 Main St",
				city: "Anytown",
				state: "CA",
				zip: "12345",
				country: "USA",
			},
		});

		if (isErr(orderResult)) {
			console.log("✗ Failed to create order:", orderResult.error.message);
			return null;
		}

		// Create order items and update inventory
		const orderItemResults = await Promise.all(
			orderItems.map(async (item) => {
				// Create order item
				const itemResult = await db.orderItems.create({
					orderId: orderResult.data.id,
					...item,
				});

				// Update product inventory
				if (isOk(itemResult)) {
					await db.products.update(item.productId, {
						inventory: { $decrement: item.quantity },
					});
				}

				return itemResult;
			}),
		);

		const failedItems = orderItemResults.filter(isErr);
		if (failedItems.length > 0) {
			console.log("✗ Some order items failed to create");
			// In real app: Rollback the order
			return null;
		}

		console.log("✓ Order placed successfully:", orderResult.data.orderNumber);
		console.log(`  Items: ${orderItems.length}`);
		console.log(`  Total: $${total.toFixed(2)}`);

		return orderResult.data;
	}

	// Place an order
	const users = await collect(db.users.query({ limit: 1 }));
	const products = await collect(
		db.products.query({
			where: { inventory: { $gt: 0 } },
			limit: 2,
		}),
	);

	if (users.length > 0 && products.length >= 2) {
		await placeOrder(users[0].id, [
			{ productId: products[0].id, quantity: 1 },
			{ productId: products[1].id, quantity: 2 },
		]);
	}

	// ------------------------------------------------------------------------
	// Product Search with Filters
	// ------------------------------------------------------------------------
	console.log("\n--- Product Search ---");

	async function searchProducts(params: {
		query?: string;
		minPrice?: number;
		maxPrice?: number;
		categories?: string[];
		tags?: string[];
		inStock?: boolean;
		sortBy?: "price" | "name" | "rating";
		sortOrder?: "asc" | "desc";
		page?: number;
		pageSize?: number;
	}) {
		const conditions: Array<Record<string, unknown>> = [];

		// Text search (simple contains)
		if (params.query) {
			conditions.push({
				$or: [
					{ name: { $contains: params.query } },
					{ description: { $contains: params.query } },
				],
			});
		}

		// Price range
		if (params.minPrice !== undefined) {
			conditions.push({ price: { $gte: params.minPrice } });
		}
		if (params.maxPrice !== undefined) {
			conditions.push({ price: { $lte: params.maxPrice } });
		}

		// Categories
		if (params.categories && params.categories.length > 0) {
			conditions.push({ categoryId: { $in: params.categories } });
		}

		// Tags
		if (params.tags && params.tags.length > 0) {
			conditions.push({ tags: { $all: params.tags } });
		}

		// Stock status
		if (params.inStock === true) {
			conditions.push({ inventory: { $gt: 0 } });
		}

		// Build where clause
		const where =
			conditions.length > 0
				? conditions.length === 1
					? conditions[0]
					: { $and: conditions }
				: undefined;

		// Sorting
		const sort = params.sortBy
			? { [params.sortBy]: params.sortOrder || "asc" }
			: undefined;

		// Pagination
		const page = params.page || 1;
		const pageSize = params.pageSize || 10;
		const offset = (page - 1) * pageSize;

		const results = await collect(
			db.products.query({
				where,
				sort,
				limit: pageSize,
				offset,
				populate: {
					category: true,
					reviews: true,
				},
			} as Parameters<typeof db.products.query>[0]),
		);

		console.log(`✓ Search results: ${results.length} products found`);
		if (params.query) console.log(`  Query: "${params.query}"`);
		if (params.minPrice || params.maxPrice) {
			console.log(
				`  Price range: $${params.minPrice || 0} - $${params.maxPrice || "∞"}`,
			);
		}

		return results;
	}

	await searchProducts({
		query: "phone",
		minPrice: 100,
		maxPrice: 1000,
		tags: ["smartphone"],
		inStock: true,
		sortBy: "price",
		sortOrder: "asc",
	});

	// ------------------------------------------------------------------------
	// Soft Delete and Restore
	// ------------------------------------------------------------------------
	console.log("\n--- Soft Delete and Restore ---");

	// Create a user to demonstrate soft delete
	const softDeleteDemo = await db.users.create({
		email: "soft.delete@example.com",
		username: "softdelete",
		password: "password123",
		firstName: "Soft",
		lastName: "Delete",
		role: "customer",
	});

	if (isOk(softDeleteDemo)) {
		// Soft delete the user
		const deleteResult = await db.users.delete(softDeleteDemo.data.id, {
			soft: true,
			returnDeleted: true,
		} as Parameters<typeof db.users.delete>[1]);

		if (isOk(deleteResult)) {
			console.log("✓ User soft deleted at:", deleteResult.data.deletedAt);

			// Try to find the user (should not appear in normal queries)
			const normalQuery = await collect(
				db.users.query({
					where: { id: softDeleteDemo.data.id },
				}),
			);
			console.log(
				"✓ Soft deleted user hidden from queries:",
				normalQuery.length === 0,
			);

			// Restore the user (unset deletedAt)
			const restoreResult = await db.users.update(softDeleteDemo.data.id, {
				deletedAt: { $set: undefined },
			});

			if (isOk(restoreResult)) {
				console.log("✓ User restored successfully");

				// Verify restoration
				const restoredQuery = await collect(
					db.users.query({
						where: { id: softDeleteDemo.data.id },
					}),
				);
				console.log(
					"✓ Restored user visible again:",
					restoredQuery.length === 1,
				);
			}
		}
	}
}

// ============================================================================
// 10. TYPE SAFETY DEMONSTRATIONS
// ============================================================================

async function demonstrateTypeSafety() {
	console.log("\n=== TYPE SAFETY DEMONSTRATIONS ===\n");

	// The following would cause TypeScript compile errors:

	// ❌ Invalid field in create
	// await db.users.create({
	//   email: "test@example.com",
	//   invalidField: "This field doesn't exist", // Error!
	// });

	// ❌ Wrong type for field
	// await db.products.create({
	//   name: "Product",
	//   price: "not a number", // Error! price must be number
	// });

	// ❌ Invalid operator for field type
	// await db.users.update("id", {
	//   email: { $increment: 5 }, // Error! Can't increment string
	// });

	// ❌ Invalid filter operator
	// await db.products.query({
	//   where: {
	//     name: { $gt: 10 } // Error! Can't compare string with number
	//   }
	// });

	// ✅ Type inference examples
	const user = await db.users.create({
		email: "type.safe@example.com",
		username: "typesafe",
		password: "supersafe123",
		firstName: "Type",
		lastName: "Safe",
		role: "admin", // Only "customer" | "admin" | "vendor" allowed
	});

	if (isOk(user)) {
		// user.data is fully typed
		console.log("✓ Type inference working:");
		console.log(`  User role: ${user.data.role} (enum constraint)`);
		console.log(`  Created at: ${user.data.createdAt} (auto-generated)`);
	}

	// Relationship type safety
	const orderWithItems = await collect(
		db.orders.query({
			populate: {
				items: {
					populate: {
						product: true,
					},
				},
				user: true,
			},
			limit: 1,
		}),
	);

	if (orderWithItems.length > 0) {
		const order = orderWithItems[0] as (typeof orderWithItems)[0] & {
			user?: { email: string; firstName: string; lastName: string };
			items?: Array<{ product?: { name: string } }>;
		};
		// TypeScript knows the shape of populated data
		if (order.user) {
			console.log("✓ Populated user type:", order.user.email);
		}
		if (order.items && order.items.length > 0) {
			console.log("✓ Nested population type:", order.items[0].product?.name);
		}
	}

	console.log("\n✓ All type safety checks passed!");
}

// ============================================================================
// SETUP TEST DATA
// ============================================================================

async function setupTestData() {
	// Clear existing data
	initialData.users = [];
	initialData.products = [];
	initialData.orders = [];
	initialData.orderItems = [];
	initialData.reviews = [];
	initialData.categories = [];
	initialData.inventory = [];

	// Create categories
	const electronics = await db.categories.create({
		name: "Electronics",
		slug: "electronics",
		description: "Electronic devices and accessories",
	});

	const phones = await db.categories.create({
		name: "Phones",
		slug: "phones",
		parentId: isOk(electronics) ? electronics.data.id : undefined,
	});

	const accessories = await db.categories.create({
		name: "Accessories",
		slug: "accessories",
		parentId: isOk(electronics) ? electronics.data.id : undefined,
	});

	// Create users
	const users = await db.users.createMany([
		{
			email: "alice@example.com",
			username: "alice",
			password: "password123",
			firstName: "Alice",
			lastName: "Smith",
			role: "customer",
			tags: ["premium", "newsletter"],
		},
		{
			email: "bob@example.com",
			username: "bob",
			password: "password123",
			firstName: "Bob",
			lastName: "Jones",
			role: "vendor",
			tags: ["vendor", "verified"],
		},
		{
			email: "admin@example.com",
			username: "admin",
			password: "adminpass123",
			firstName: "Admin",
			lastName: "User",
			role: "admin",
			tags: ["admin", "staff"],
		},
	]);

	if (isOk(users) && isOk(phones) && isOk(accessories)) {
		// Create products
		const products = await db.products.createMany([
			{
				sku: "PHONE-001",
				name: "Smartphone Pro Max",
				description: "Latest flagship smartphone with advanced features",
				price: 999.99,
				compareAtPrice: 1199.99,
				inventory: 50,
				isPublished: true,
				categoryId: phones.data.id,
				vendorId: users.data.created[1]?.id, // Bob
				tags: ["smartphone", "flagship", "5g", "premium"],
				features: ["5G", "OLED Display", "Triple Camera", "Wireless Charging"],
			},
			{
				sku: "PHONE-002",
				name: "Budget Phone",
				description: "Affordable smartphone for everyday use",
				price: 299.99,
				inventory: 100,
				isPublished: true,
				categoryId: phones.data.id,
				vendorId: users.data.created[1]?.id, // Bob
				tags: ["smartphone", "budget", "4g"],
				features: ["4G", "Dual Camera", "Long Battery Life"],
			},
			{
				sku: "ACC-001",
				name: "Premium Phone Case",
				description: "Protective case with premium materials",
				price: 49.99,
				inventory: 200,
				isPublished: true,
				categoryId: accessories.data.id,
				tags: ["accessory", "case", "premium"],
				features: ["Drop Protection", "Wireless Charging Compatible"],
			},
			{
				sku: "ACC-002",
				name: "Wireless Earbuds Pro",
				description: "High-quality wireless earbuds",
				price: 199.99,
				compareAtPrice: 249.99,
				inventory: 75,
				isPublished: true,
				categoryId: accessories.data.id,
				tags: ["accessory", "audio", "wireless"],
				features: ["Active Noise Cancellation", "30hr Battery", "IPX4"],
			},
			{
				sku: "PHONE-003",
				name: "Smartphone Pro",
				description: "Professional smartphone",
				price: 799.99,
				inventory: 30,
				isPublished: true,
				categoryId: phones.data.id,
				tags: ["smartphone", "professional", "5g"],
				features: ["5G", "Pro Camera", "Fast Charging"],
			},
		]);

		if (isOk(products)) {
			// Create some reviews
			await db.reviews.createMany([
				{
					productId: products.data.created[0].id,
					userId: users.data.created[0].id, // Alice
					rating: 5,
					title: "Amazing phone!",
					comment: "Best smartphone I've ever owned. The camera is incredible.",
					isVerifiedPurchase: true,
				},
				{
					productId: products.data.created[0].id,
					userId: users.data.created[2].id, // Admin
					rating: 4,
					title: "Great but expensive",
					comment: "Excellent features but the price is a bit high.",
					isVerifiedPurchase: true,
				},
				{
					productId: products.data.created[1].id,
					userId: users.data.created[0].id, // Alice
					rating: 4,
					title: "Good value",
					comment: "Perfect for basic use. Great battery life.",
					isVerifiedPurchase: true,
				},
			]);

			// Create some orders
			const order1 = await db.orders.create({
				orderNumber: "ORD-001",
				userId: users.data.created[0].id, // Alice
				status: "delivered",
				subtotal: 1049.98,
				tax: 84.0,
				shipping: 0,
				total: 1133.98,
				shippingAddress: {
					street: "123 Main St",
					city: "San Francisco",
					state: "CA",
					zip: "94105",
					country: "USA",
				},
				deliveredAt: getCurrentTimestamp(),
			});

			if (isOk(order1)) {
				await db.orderItems.createMany([
					{
						orderId: order1.data.id,
						productId: products.data.created[0].id,
						quantity: 1,
						price: 999.99,
						total: 999.99,
					},
					{
						orderId: order1.data.id,
						productId: products.data.created[2].id,
						quantity: 1,
						price: 49.99,
						total: 49.99,
					},
				]);
			}
		}
	}

	console.log("✓ Test data setup complete");
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
	console.log("=".repeat(60));
	console.log("COMPREHENSIVE DATABASE V2 EXAMPLE - E-COMMERCE");
	console.log("=".repeat(60));

	try {
		await demonstrateCrudOperations();
		await demonstrateAdvancedQuerying();
		await demonstrateFieldSelection();
		await demonstrateRelationshipOperations();
		await demonstrateErrorHandling();
		await demonstrateRealWorldScenarios();
		await demonstrateTypeSafety();

		console.log("\n" + "=".repeat(60));
		console.log("ALL DEMONSTRATIONS COMPLETED SUCCESSFULLY!");
		console.log("=".repeat(60));
	} catch (error) {
		console.error("\n❌ Unexpected error:", error);
	}
}

// Run the example (conditionally based on being the main module)
// main().catch(console.error);

// Export for testing or external use
export { db, generateId, getCurrentTimestamp, collect, setupTestData };
