import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	CollectionNotFoundError,
	ConcurrencyError,
	DanglingReferenceError,
	DuplicateKeyError,
	ForeignKeyError,
	NotFoundError,
	OperationError,
	PopulationError,
	SerializationError,
	StorageError,
	TransactionError,
	UniqueConstraintError,
	UnsupportedFormatError,
	ValidationError,
} from "../src/errors/index.js";

describe("CRUD error creation and _tag discrimination", () => {
	it("NotFoundError has correct _tag and fields", () => {
		const err = new NotFoundError({
			collection: "users",
			id: "123",
			message: "not found",
		});
		expect(err._tag).toBe("NotFoundError");
		expect(err.collection).toBe("users");
		expect(err.id).toBe("123");
		expect(err.message).toBe("not found");
	});

	it("DuplicateKeyError has correct _tag and fields", () => {
		const err = new DuplicateKeyError({
			collection: "users",
			field: "email",
			value: "a@b.com",
			existingId: "456",
			message: "duplicate",
		});
		expect(err._tag).toBe("DuplicateKeyError");
		expect(err.collection).toBe("users");
		expect(err.field).toBe("email");
		expect(err.value).toBe("a@b.com");
		expect(err.existingId).toBe("456");
	});

	it("ForeignKeyError has correct _tag and fields", () => {
		const err = new ForeignKeyError({
			collection: "users",
			field: "companyId",
			value: "999",
			targetCollection: "companies",
			message: "fk violation",
		});
		expect(err._tag).toBe("ForeignKeyError");
		expect(err.targetCollection).toBe("companies");
	});

	it("ValidationError has correct _tag and issues", () => {
		const err = new ValidationError({
			message: "validation failed",
			issues: [
				{ field: "name", message: "is required" },
				{
					field: "age",
					message: "must be a number",
					expected: "number",
					received: "string",
				},
			],
		});
		expect(err._tag).toBe("ValidationError");
		expect(err.issues).toHaveLength(2);
		expect(err.issues[0].field).toBe("name");
		expect(err.issues[1].expected).toBe("number");
	});

	it("UniqueConstraintError has correct _tag and fields", () => {
		const err = new UniqueConstraintError({
			collection: "users",
			constraint: "unique_email",
			fields: ["email"],
			values: { email: "a@b.com" },
			existingId: "789",
			message: "unique constraint violated",
		});
		expect(err._tag).toBe("UniqueConstraintError");
		expect(err.constraint).toBe("unique_email");
		expect(err.fields).toEqual(["email"]);
	});

	it("ConcurrencyError has correct _tag and fields", () => {
		const err = new ConcurrencyError({
			collection: "users",
			id: "123",
			message: "concurrent modification",
		});
		expect(err._tag).toBe("ConcurrencyError");
		expect(err.collection).toBe("users");
	});

	it("OperationError has correct _tag and fields", () => {
		const err = new OperationError({
			operation: "bulkDelete",
			reason: "too many items",
			message: "operation failed",
		});
		expect(err._tag).toBe("OperationError");
		expect(err.operation).toBe("bulkDelete");
		expect(err.reason).toBe("too many items");
	});

	it("TransactionError has correct _tag and fields", () => {
		const err = new TransactionError({
			operation: "commit",
			reason: "conflict",
			message: "transaction failed",
		});
		expect(err._tag).toBe("TransactionError");
		expect(err.operation).toBe("commit");
	});
});

describe("Query error creation and _tag discrimination", () => {
	it("DanglingReferenceError has correct _tag and fields", () => {
		const err = new DanglingReferenceError({
			collection: "users",
			field: "companyId",
			targetId: "nonexistent",
			message: "dangling reference",
		});
		expect(err._tag).toBe("DanglingReferenceError");
		expect(err.targetId).toBe("nonexistent");
	});

	it("CollectionNotFoundError has correct _tag and fields", () => {
		const err = new CollectionNotFoundError({
			collection: "unknown",
			message: "collection not found",
		});
		expect(err._tag).toBe("CollectionNotFoundError");
		expect(err.collection).toBe("unknown");
	});

	it("PopulationError has correct _tag and fields", () => {
		const err = new PopulationError({
			collection: "users",
			relationship: "company",
			message: "population failed",
			cause: new Error("underlying issue"),
		});
		expect(err._tag).toBe("PopulationError");
		expect(err.relationship).toBe("company");
		expect(err.cause).toBeInstanceOf(Error);
	});
});

describe("Storage error creation and _tag discrimination", () => {
	it("StorageError has correct _tag and fields", () => {
		const err = new StorageError({
			path: "/data/users.yaml",
			operation: "read",
			message: "file not found",
		});
		expect(err._tag).toBe("StorageError");
		expect(err.path).toBe("/data/users.yaml");
		expect(err.operation).toBe("read");
	});

	it("SerializationError has correct _tag and fields", () => {
		const err = new SerializationError({
			format: "yaml",
			message: "invalid yaml syntax",
			cause: new SyntaxError("bad yaml"),
		});
		expect(err._tag).toBe("SerializationError");
		expect(err.format).toBe("yaml");
	});

	it("UnsupportedFormatError has correct _tag and fields", () => {
		const err = new UnsupportedFormatError({
			format: ".xlsx",
			message: "unsupported format",
		});
		expect(err._tag).toBe("UnsupportedFormatError");
		expect(err.format).toBe(".xlsx");
	});
});

describe("_tag discrimination in union types", () => {
	it("discriminates CRUD errors by _tag", () => {
		const errors = [
			new NotFoundError({ collection: "users", id: "1", message: "not found" }),
			new DuplicateKeyError({
				collection: "users",
				field: "email",
				value: "a@b.com",
				existingId: "2",
				message: "dup",
			}),
			new ValidationError({ message: "invalid", issues: [] }),
		];

		const tags = errors.map((e) => e._tag);
		expect(tags).toEqual([
			"NotFoundError",
			"DuplicateKeyError",
			"ValidationError",
		]);
	});

	it("discriminates across all error categories", () => {
		const errors = [
			new NotFoundError({ collection: "users", id: "1", message: "not found" }),
			new DanglingReferenceError({
				collection: "users",
				field: "companyId",
				targetId: "x",
				message: "dangling",
			}),
			new StorageError({
				path: "/data",
				operation: "write",
				message: "failed",
			}),
		];

		const tags = errors.map((e) => e._tag);
		expect(tags).toEqual([
			"NotFoundError",
			"DanglingReferenceError",
			"StorageError",
		]);
	});
});

describe("Effect.catchTag pattern matching", () => {
	it("catches NotFoundError", async () => {
		const effect = Effect.fail(
			new NotFoundError({ collection: "users", id: "1", message: "not found" }),
		).pipe(
			Effect.catchTag("NotFoundError", (err) =>
				Effect.succeed(`caught NotFoundError for ${err.collection}:${err.id}`),
			),
		);
		const result = await Effect.runPromise(effect);
		expect(result).toBe("caught NotFoundError for users:1");
	});

	it("catches DuplicateKeyError and lets other errors through", async () => {
		const makeFailing = (tag: "dup" | "notfound") =>
			tag === "dup"
				? Effect.fail(
						new DuplicateKeyError({
							collection: "users",
							field: "email",
							value: "a@b.com",
							existingId: "2",
							message: "dup",
						}),
					)
				: Effect.fail(
						new NotFoundError({
							collection: "users",
							id: "1",
							message: "not found",
						}),
					);

		const withCatch = makeFailing("dup").pipe(
			Effect.catchTag("DuplicateKeyError", (err) =>
				Effect.succeed(`caught dup on ${err.field}`),
			),
		);
		expect(await Effect.runPromise(withCatch)).toBe("caught dup on email");

		const uncaught = makeFailing("notfound").pipe(
			Effect.catchTag("DuplicateKeyError", () =>
				Effect.succeed("should not happen"),
			),
		);
		const either = await Effect.runPromise(Effect.either(uncaught));
		expect(either._tag).toBe("Left");
		if (either._tag === "Left") {
			expect(either.left._tag).toBe("NotFoundError");
		}
	});

	it("catches ValidationError in a pipeline", async () => {
		const validate = (data: Record<string, unknown>) =>
			typeof data.name === "string"
				? Effect.succeed(data)
				: Effect.fail(
						new ValidationError({
							message: "bad name",
							issues: [{ field: "name", message: "must be a string" }],
						}),
					);

		const effect = validate({ name: 42 }).pipe(
			Effect.catchTag("ValidationError", (err) =>
				Effect.succeed({ error: true, issueCount: err.issues.length }),
			),
		);
		const result = await Effect.runPromise(effect);
		expect(result).toEqual({ error: true, issueCount: 1 });
	});

	it("catches StorageError", async () => {
		const effect = Effect.fail(
			new StorageError({
				path: "/data/users.yaml",
				operation: "read",
				message: "ENOENT",
			}),
		).pipe(
			Effect.catchTag("StorageError", (err) =>
				Effect.succeed(`storage ${err.operation} failed at ${err.path}`),
			),
		);
		const result = await Effect.runPromise(effect);
		expect(result).toBe("storage read failed at /data/users.yaml");
	});

	it("catches DanglingReferenceError", async () => {
		const effect = Effect.fail(
			new DanglingReferenceError({
				collection: "users",
				field: "companyId",
				targetId: "x",
				message: "dangling",
			}),
		).pipe(
			Effect.catchTag("DanglingReferenceError", (err) =>
				Effect.succeed(`dangling: ${err.field} -> ${err.targetId}`),
			),
		);
		const result = await Effect.runPromise(effect);
		expect(result).toBe("dangling: companyId -> x");
	});

	it("chains multiple catchTag for different error types", async () => {
		const failing: Effect.Effect<string, NotFoundError | ValidationError> =
			Effect.fail(
				new ValidationError({
					message: "bad",
					issues: [{ field: "x", message: "required" }],
				}),
			);

		const effect = failing.pipe(
			Effect.catchTag("NotFoundError", () => Effect.succeed("was not found")),
			Effect.catchTag("ValidationError", (err) =>
				Effect.succeed(`validation: ${err.issues.length}`),
			),
		);
		const result = await Effect.runPromise(effect);
		expect(result).toBe("validation: 1");
	});
});

describe("errors are instances of Error", () => {
	it("TaggedErrors extend Error", () => {
		const err = new NotFoundError({
			collection: "users",
			id: "1",
			message: "not found",
		});
		expect(err).toBeInstanceOf(Error);
	});

	it("TaggedErrors have a stack trace", () => {
		const err = new StorageError({
			path: "/data",
			operation: "read",
			message: "failed",
		});
		expect(err.stack).toBeDefined();
	});
});
