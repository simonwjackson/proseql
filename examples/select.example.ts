/**
 * Field Selection Examples
 *
 * This file demonstrates how to use the object-based field selection functionality
 * in the database v2 system.
 */

import {
	applyObjectSelection,
	applySelectionToArray,
	applySelectionSafe,
	createFieldSelector,
	mergeObjectFieldSelections,
} from "@proseql/core";

// Example 1: Basic field selection
function basicSelectionExample() {
	const user = {
		id: "user-1",
		name: "John Doe",
		email: "john@example.com",
		password: "hashed-password",
		age: 30,
		createdAt: new Date("2024-01-01"),
		updatedAt: new Date("2024-01-15"),
	};

	// Select only public fields
	const publicUser = applyObjectSelection(user, {
		id: true,
		name: true,
		email: true,
	});
	console.log("Public user data:", publicUser);
	// Output: { id: "user-1", name: "John Doe", email: "john@example.com" }

	// TypeScript knows the shape
	console.log(publicUser.name); // ✓ Works
	console.log(publicUser.email); // ✓ Works
	// console.log(publicUser.password); // ❌ TypeScript error - property doesn't exist
}

// Example 2: Selection with populated relationships
function relationshipSelectionExample() {
	const employee = {
		id: "emp-1",
		name: "Jane Smith",
		email: "jane@company.com",
		salary: 75000,
		department: {
			id: "dept-1",
			name: "Engineering",
			budget: 1000000,
			headCount: 25,
		},
		manager: {
			id: "emp-2",
			name: "Bob Johnson",
			email: "bob@company.com",
		},
	};

	// Select employee with full department but no salary
	const employeeInfo = applyObjectSelection(employee, {
		id: true,
		name: true,
		email: true,
		department: true,
		manager: true,
	});

	console.log("Employee info:", employeeInfo);
	// The department object is preserved in full
	console.log("Department budget:", employeeInfo.department.budget); // ✓ Works
}

// Example 3: Array selection
function arraySelectionExample() {
	const products = [
		{ id: "prod-1", name: "Laptop", price: 999, stock: 10, sku: "LAP-001" },
		{ id: "prod-2", name: "Mouse", price: 29, stock: 100, sku: "MOU-001" },
		{ id: "prod-3", name: "Keyboard", price: 79, stock: 50, sku: "KEY-001" },
	];

	// Select only display fields for product listing
	const productListing = applySelectionToArray(products, {
		id: true,
		name: true,
		price: true,
	});

	console.log("Product listing:", productListing);
	// Output: Array of { id, name, price } objects
}

// Example 4: Safe selection with null handling
function safeSelectionExample() {
	type User = {
		id: string;
		name: string;
		profile?: {
			bio: string;
			avatar: string;
		} | null;
	};

	const users: Array<User | null> = [
		{
			id: "1",
			name: "Alice",
			profile: { bio: "Developer", avatar: "alice.jpg" },
		},
		null,
		{ id: "2", name: "Bob", profile: null },
		{ id: "3", name: "Charlie" },
	];

	const selectedUsers = users.map((user) =>
		applySelectionSafe(user, { id: true, name: true, profile: true }),
	);

	console.log("Selected users with nulls:", selectedUsers);
}

// Example 5: Creating reusable selectors
function reusableSelectorsExample() {
	// Define common field selections
	const selectPublicUserFields = createFieldSelector({
		id: true,
		name: true,
		email: true,
		avatar: true,
	});

	const selectUserSummary = createFieldSelector({ id: true, name: true });

	// Use them across your application
	const fullUser = {
		id: "1",
		name: "User Name",
		email: "user@example.com",
		avatar: "avatar.jpg",
		password: "secret",
		isAdmin: true,
	};

	const publicView = selectPublicUserFields(fullUser);
	const summaryView = selectUserSummary(fullUser);

	console.log("Public view:", publicView);
	console.log("Summary view:", summaryView);
}

// Example 6: Merging field selections
function mergeSelectionsExample() {
	type Article = {
		id: string;
		title: string;
		content: string;
		author: string;
		tags: string[];
		metadata: Record<string, unknown>;
	};

	// Different parts of the app request different fields
	const uiFields = { id: true, title: true, author: true };
	const apiFields = { title: true, content: true, tags: true };
	const adminFields = { id: true, metadata: true };

	// Merge all requested fields
	const allFields = mergeObjectFieldSelections(
		uiFields,
		apiFields,
		adminFields,
	);
	console.log("Merged fields:", allFields);
	// Output: { id: true, title: true, author: true, content: true, tags: true, metadata: true }

	// Apply the merged selection
	const article: Article = {
		id: "art-1",
		title: "TypeScript Tips",
		content: "Long article content...",
		author: "John Doe",
		tags: ["typescript", "programming"],
		metadata: { views: 1000, likes: 50 },
	};

	// Since allFields could be undefined, we need to handle that case
	if (allFields) {
		const selected = applyObjectSelection(article, allFields);
		console.log("Selected article:", selected);
	}
}

// Example 7: Integration with query system
function queryIntegrationExample() {
	// This shows how field selection could integrate with a query system
	type QueryOptions<T> = {
		where?: Partial<T>;
		select?: Record<string, boolean>;
		populate?: string[];
	};

	function simulateQuery<T extends Record<string, unknown>>(
		data: T[],
		options: QueryOptions<T>,
	): Array<Partial<T>> {
		let results = data;

		// Apply where clause (simplified)
		if (options.where) {
			results = results.filter((item) => {
				return Object.entries(options.where!).every(
					([key, value]) => item[key] === value,
				);
			});
		}

		// Apply field selection
		if (options.select) {
			return applySelectionToArray(results, options.select) as Array<
				Partial<T>
			>;
		}

		return results;
	}

	// Usage
	const users = [
		{ id: "1", name: "Alice", role: "admin", email: "alice@example.com" },
		{ id: "2", name: "Bob", role: "user", email: "bob@example.com" },
		{ id: "3", name: "Charlie", role: "user", email: "charlie@example.com" },
	];

	const admins = simulateQuery(users, {
		where: { role: "admin" },
		select: { id: true, name: true, email: true },
	});

	console.log("Admin users:", admins);
}

// Run all examples
console.log("=== Field Selection Examples ===\n");

console.log("1. Basic Selection:");
basicSelectionExample();

console.log("\n2. Relationship Selection:");
relationshipSelectionExample();

console.log("\n3. Object-based Array Selection:");
arraySelectionExample();

console.log("\n4. Safe Selection:");
safeSelectionExample();

console.log("\n5. Reusable Selectors:");
reusableSelectorsExample();

console.log("\n6. Merge Object-based Selections:");
mergeSelectionsExample();

console.log("\n7. Object-based Query Integration:");
queryIntegrationExample();
