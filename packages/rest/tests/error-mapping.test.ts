/**
 * Tests for REST error mapping — verifies each tagged error maps to correct HTTP status.
 *
 * Task 11.17: Test each tagged error maps to correct HTTP status.
 * Task 11.18: Test unknown error maps to 500.
 */

import { describe, expect, it } from "vitest";
import { mapErrorToResponse } from "../src/error-mapping.js";
import {
	NotFoundError,
	ValidationError,
	DuplicateKeyError,
	UniqueConstraintError,
	ForeignKeyError,
	HookError,
	TransactionError,
	ConcurrencyError,
	OperationError,
	DanglingReferenceError,
	CollectionNotFoundError,
	PopulationError,
	StorageError,
	SerializationError,
	UnsupportedFormatError,
	MigrationError,
	PluginError,
} from "@proseql/core";

// ============================================================================
// Task 11.17: Test each tagged error maps to correct HTTP status
// ============================================================================

describe("Error mapping — CRUD errors (task 11.17)", () => {
	it("should map NotFoundError to 404", () => {
		const error = new NotFoundError({
			collection: "books",
			id: "123",
			message: "Book not found",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(404);
		expect(response.body._tag).toBe("NotFoundError");
		expect(response.body.error).toBe("Not found");
		expect(response.body.details).toBeDefined();
		expect((response.body.details as Record<string, unknown>).collection).toBe("books");
		expect((response.body.details as Record<string, unknown>).id).toBe("123");
	});

	it("should map ValidationError to 400", () => {
		const error = new ValidationError({
			message: "Validation failed",
			issues: [
				{ field: "year", message: "Expected number", expected: "number", received: "string" },
			],
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(400);
		expect(response.body._tag).toBe("ValidationError");
		expect(response.body.error).toBe("Validation error");
		expect(response.body.details).toBeDefined();
		const issues = (response.body.details as Record<string, unknown>).issues as ReadonlyArray<unknown>;
		expect(issues).toBeDefined();
		expect(issues.length).toBe(1);
	});

	it("should map DuplicateKeyError to 409", () => {
		const error = new DuplicateKeyError({
			collection: "books",
			field: "id",
			value: "123",
			existingId: "123",
			message: "Duplicate key",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(409);
		expect(response.body._tag).toBe("DuplicateKeyError");
		expect(response.body.error).toBe("Duplicate key");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.field).toBe("id");
		expect(details.value).toBe("123");
		expect(details.existingId).toBe("123");
	});

	it("should map UniqueConstraintError to 409", () => {
		const error = new UniqueConstraintError({
			collection: "books",
			constraint: "isbn_unique",
			fields: ["isbn"],
			values: { isbn: "978-0441172719" },
			existingId: "456",
			message: "Unique constraint violation",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(409);
		expect(response.body._tag).toBe("UniqueConstraintError");
		expect(response.body.error).toBe("Unique constraint violation");
		expect(response.body.details).toBeDefined();
		expect((response.body.details as Record<string, unknown>).constraint).toBe("isbn_unique");
	});

	it("should map ForeignKeyError to 422", () => {
		const error = new ForeignKeyError({
			collection: "books",
			field: "authorId",
			value: "nonexistent-author",
			targetCollection: "authors",
			message: "Foreign key violation",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(422);
		expect(response.body._tag).toBe("ForeignKeyError");
		expect(response.body.error).toBe("Foreign key violation");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.field).toBe("authorId");
		expect(details.value).toBe("nonexistent-author");
		expect(details.targetCollection).toBe("authors");
	});

	it("should map HookError to 422", () => {
		const error = new HookError({
			hook: "beforeCreate",
			collection: "books",
			operation: "create",
			reason: "Year cannot be in the future",
			message: "Hook rejected the operation",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(422);
		expect(response.body._tag).toBe("HookError");
		expect(response.body.error).toBe("Hook error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.hook).toBe("beforeCreate");
		expect(details.collection).toBe("books");
		expect(details.operation).toBe("create");
		expect(details.reason).toBe("Year cannot be in the future");
	});

	it("should map TransactionError to 500", () => {
		const error = new TransactionError({
			operation: "commit",
			reason: "Commit failed",
			message: "Transaction error",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("TransactionError");
		expect(response.body.error).toBe("Transaction error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.operation).toBe("commit");
		expect(details.reason).toBe("Commit failed");
	});

	it("should map ConcurrencyError to 409", () => {
		const error = new ConcurrencyError({
			collection: "books",
			id: "123",
			message: "Concurrent modification detected",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(409);
		expect(response.body._tag).toBe("ConcurrencyError");
		expect(response.body.error).toBe("Concurrency error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.id).toBe("123");
	});

	it("should map OperationError to 400", () => {
		const error = new OperationError({
			operation: "update",
			reason: "Cannot update append-only collection",
			message: "Operation not allowed",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(400);
		expect(response.body._tag).toBe("OperationError");
		expect(response.body.error).toBe("Operation error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.operation).toBe("update");
		expect(details.reason).toBe("Cannot update append-only collection");
	});
});

describe("Error mapping — Query errors (task 11.17)", () => {
	it("should map DanglingReferenceError to 422", () => {
		const error = new DanglingReferenceError({
			collection: "books",
			field: "authorId",
			targetId: "deleted-author",
			message: "Dangling reference",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(422);
		expect(response.body._tag).toBe("DanglingReferenceError");
		expect(response.body.error).toBe("Dangling reference");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.field).toBe("authorId");
		expect(details.targetId).toBe("deleted-author");
	});

	it("should map CollectionNotFoundError to 404", () => {
		const error = new CollectionNotFoundError({
			collection: "nonexistent",
			message: "Collection not found",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(404);
		expect(response.body._tag).toBe("CollectionNotFoundError");
		expect(response.body.error).toBe("Collection not found");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("nonexistent");
	});

	it("should map PopulationError to 422", () => {
		const error = new PopulationError({
			collection: "books",
			relationship: "author",
			message: "Failed to populate relationship",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(422);
		expect(response.body._tag).toBe("PopulationError");
		expect(response.body.error).toBe("Population error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.relationship).toBe("author");
	});
});

describe("Error mapping — Storage errors (task 11.17)", () => {
	it("should map StorageError to 500", () => {
		const error = new StorageError({
			path: "./data/books.yaml",
			operation: "write",
			message: "Failed to write file",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("StorageError");
		expect(response.body.error).toBe("Storage error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.path).toBe("./data/books.yaml");
		expect(details.operation).toBe("write");
	});

	it("should map SerializationError to 500", () => {
		const error = new SerializationError({
			format: "yaml",
			message: "Invalid YAML syntax",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("SerializationError");
		expect(response.body.error).toBe("Serialization error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.format).toBe("yaml");
	});

	it("should map UnsupportedFormatError to 400", () => {
		const error = new UnsupportedFormatError({
			format: "xml",
			message: "Unsupported format",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(400);
		expect(response.body._tag).toBe("UnsupportedFormatError");
		expect(response.body.error).toBe("Unsupported format");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.format).toBe("xml");
	});
});

describe("Error mapping — Migration errors (task 11.17)", () => {
	it("should map MigrationError to 500", () => {
		const error = new MigrationError({
			collection: "books",
			fromVersion: 1,
			toVersion: 2,
			step: 0,
			reason: "Transform failed",
			message: "Migration error",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("MigrationError");
		expect(response.body.error).toBe("Migration error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.collection).toBe("books");
		expect(details.fromVersion).toBe(1);
		expect(details.toVersion).toBe(2);
		expect(details.step).toBe(0);
		expect(details.reason).toBe("Transform failed");
	});
});

describe("Error mapping — Plugin errors (task 11.17)", () => {
	it("should map PluginError to 500", () => {
		const error = new PluginError({
			plugin: "custom-operators",
			reason: "Conflicting operator name",
			message: "Plugin error",
		});

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("PluginError");
		expect(response.body.error).toBe("Plugin error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.plugin).toBe("custom-operators");
		expect(details.reason).toBe("Conflicting operator name");
	});
});

describe("Error mapping — response body structure (task 11.17)", () => {
	it("should include _tag in response body", () => {
		const error = new NotFoundError({
			collection: "books",
			id: "123",
			message: "Not found",
		});

		const response = mapErrorToResponse(error);

		expect(response.body).toHaveProperty("_tag");
		expect(response.body._tag).toBe("NotFoundError");
	});

	it("should include error message in response body", () => {
		const error = new ValidationError({
			message: "Validation failed",
			issues: [],
		});

		const response = mapErrorToResponse(error);

		expect(response.body).toHaveProperty("error");
		expect(typeof response.body.error).toBe("string");
	});

	it("should include details with error fields", () => {
		const error = new ForeignKeyError({
			collection: "books",
			field: "authorId",
			value: "invalid",
			targetCollection: "authors",
			message: "Foreign key violation",
		});

		const response = mapErrorToResponse(error);

		expect(response.body).toHaveProperty("details");
		expect(response.body.details).toBeDefined();
	});

	it("should omit details when error has no additional fields", () => {
		// Create a minimal tagged error object to test edge case
		const minimalError = { _tag: "SomeError" };

		const response = mapErrorToResponse(minimalError);

		// Details should be undefined when there are no additional fields
		expect(response.body.details).toBeUndefined();
	});
});

// ============================================================================
// Task 11.18: Test unknown error maps to 500
// ============================================================================

describe("Error mapping — Unknown errors (task 11.18)", () => {
	it("should map standard Error to 500", () => {
		const error = new Error("Something went wrong");

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.message).toBe("Something went wrong");
		expect(details.name).toBe("Error");
	});

	it("should map TypeError to 500 with correct name", () => {
		const error = new TypeError("Cannot read property 'foo' of undefined");

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.message).toBe("Cannot read property 'foo' of undefined");
		expect(details.name).toBe("TypeError");
	});

	it("should map RangeError to 500 with correct name", () => {
		const error = new RangeError("Maximum call stack size exceeded");

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.message).toBe("Maximum call stack size exceeded");
		expect(details.name).toBe("RangeError");
	});

	it("should map plain string to 500 without details", () => {
		const error = "A plain string error";

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map number to 500 without details", () => {
		const error = 42;

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map null to 500 without details", () => {
		const error = null;

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map undefined to 500 without details", () => {
		const error = undefined;

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map plain object without _tag to 500 without details", () => {
		const error = { message: "Some error", code: 123 };

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map array to 500 without details", () => {
		const error = ["error1", "error2"];

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeUndefined();
	});

	it("should map custom Error subclass to 500 with correct name", () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CustomError";
			}
		}
		const error = new CustomError("Custom error occurred");

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("UnknownError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.message).toBe("Custom error occurred");
		expect(details.name).toBe("CustomError");
	});

	it("should map unrecognized tagged error to 500", () => {
		// A tagged error with a _tag that isn't in the ERROR_STATUS_MAP
		const error = { _tag: "SomeUnknownTaggedError", foo: "bar" };

		const response = mapErrorToResponse(error);

		expect(response.status).toBe(500);
		expect(response.body._tag).toBe("SomeUnknownTaggedError");
		expect(response.body.error).toBe("Internal server error");
		expect(response.body.details).toBeDefined();
		const details = response.body.details as Record<string, unknown>;
		expect(details.foo).toBe("bar");
	});
});
