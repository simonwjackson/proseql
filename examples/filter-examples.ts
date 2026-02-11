/**
 * Examples of using conditional logic operators in the database v2 filter system
 */

import { filterData } from "@proseql/core";

// Example data
const users = [
	{
		id: 1,
		name: "John",
		age: 25,
		role: "admin",
		active: true,
		email: "john@company.com",
	},
	{
		id: 2,
		name: "Jane",
		age: 30,
		role: "user",
		active: false,
		email: "jane@example.com",
	},
	{
		id: 3,
		name: "Bob",
		age: 35,
		role: "admin",
		active: false,
		email: "bob@spam.com",
	},
	{
		id: 4,
		name: "Alice",
		age: 17,
		role: "user",
		active: true,
		email: "alice@company.com",
	},
];

// Example 1: OR operator
// Find users who are either admins or under 20 years old
const adminsOrYoung = filterData(users, {
	$or: [{ role: "admin" }, { age: { $lt: 20 } }],
});
console.log("Admins or young users:", adminsOrYoung);

// Example 2: AND operator
// Find active admins
const activeAdmins = filterData(users, {
	$and: [{ role: "admin" }, { active: true }],
});
console.log("Active admins:", activeAdmins);

// Example 3: NOT operator
// Find users who are not from spam domains
const notSpam = filterData(users, {
	$not: { email: { $endsWith: "@spam.com" } },
});
console.log("Non-spam users:", notSpam);

// Example 4: Complex nested conditions
// Find users who are either:
// - Active admins
// - OR young users (under 25) from company domain
const complexFilter = filterData(users, {
	$or: [
		{
			$and: [{ role: "admin" }, { active: true }],
		},
		{
			$and: [{ age: { $lt: 25 } }, { email: { $endsWith: "@company.com" } }],
		},
	],
});
console.log("Complex filter result:", complexFilter);

// Example 5: Combining regular filters with logical operators
// Find company email users who are either admins or active
const companyUsersWithConditions = filterData(users, {
	email: { $contains: "@company.com" },
	$or: [{ role: "admin" }, { active: true }],
});
console.log(
	"Company users who are admins or active:",
	companyUsersWithConditions,
);

// Example 6: Double negation (finding active users in a different way)
const activeUsers = filterData(users, {
	$not: { active: false },
});
console.log("Active users (using NOT):", activeUsers);

// Example 7: Empty arrays behavior
// Empty $or array returns no results
const emptyOr = filterData(users, { $or: [] });
console.log("Empty OR:", emptyOr); // []

// Empty $and array returns all results (vacuous truth)
const emptyAnd = filterData(users, { $and: [] });
console.log("Empty AND:", emptyAnd); // all users
