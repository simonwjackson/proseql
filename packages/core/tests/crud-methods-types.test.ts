import { describe, it, expect } from "vitest"
import { Schema, Effect, Stream } from "effect"
import type { CrudMethods } from "../core/factories/crud-factory"
import type { CrudMethodsWithRelationships } from "../core/factories/crud-factory-with-relationships"
import type { RunnableEffect } from "../core/factories/database-effect"
import type { RelationshipDef } from "../core/types/types"
import type {
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	OperationError,
} from "../core/errors/crud-errors"

// ============================================================================
// Test schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
})

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
})

type User = Schema.Schema.Type<typeof UserSchema>
type Company = Schema.Schema.Type<typeof CompanySchema>

// Helper: assert type compatibility at compile time
type Assert<T extends true> = T
type IsAssignable<T, U> = T extends U ? true : false

describe("CrudMethods returns Effect-based types", () => {
	it("create returns RunnableEffect with proper error types", () => {
		type CreateReturn = ReturnType<CrudMethods<User>["create"]>

		// Should be an Effect (RunnableEffect extends Effect)
		type _check1 = Assert<
			IsAssignable<CreateReturn, Effect.Effect<User, ValidationError | DuplicateKeyError | ForeignKeyError>>
		>

		// Should have runPromise
		type _check2 = Assert<
			IsAssignable<CreateReturn, { readonly runPromise: Promise<User> }>
		>

		expect(true).toBe(true)
	})

	it("update returns RunnableEffect with NotFoundError", () => {
		type UpdateReturn = ReturnType<CrudMethods<User>["update"]>

		type _check = Assert<
			IsAssignable<UpdateReturn, Effect.Effect<User, ValidationError | NotFoundError | ForeignKeyError>>
		>

		expect(true).toBe(true)
	})

	it("delete returns RunnableEffect with OperationError", () => {
		type DeleteReturn = ReturnType<CrudMethods<User>["delete"]>

		type _check = Assert<
			IsAssignable<DeleteReturn, Effect.Effect<User, NotFoundError | OperationError | ForeignKeyError>>
		>

		expect(true).toBe(true)
	})

	it("upsert returns RunnableEffect", () => {
		type UpsertReturn = ReturnType<CrudMethods<User>["upsert"]>

		type _check = Assert<
			IsAssignable<UpsertReturn, { readonly runPromise: Promise<User & { __action: "created" | "updated" }> }>
		>

		expect(true).toBe(true)
	})
})

describe("CrudMethodsWithRelationships extends CrudMethods with relationship operations", () => {
	type UserRelations = {
		company: RelationshipDef<Company, "ref", "companies">
	}

	it("inherits all base CRUD methods from CrudMethods", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>

		// Should have create from CrudMethods
		type _check1 = Assert<
			IsAssignable<Methods["create"], CrudMethods<User>["create"]>
		>

		// Should have update from CrudMethods
		type _check2 = Assert<
			IsAssignable<Methods["update"], CrudMethods<User>["update"]>
		>

		// Should have delete from CrudMethods
		type _check3 = Assert<
			IsAssignable<Methods["delete"], CrudMethods<User>["delete"]>
		>

		expect(true).toBe(true)
	})

	it("createWithRelationships returns RunnableEffect", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>
		type CreateWithRelsReturn = ReturnType<Methods["createWithRelationships"]>

		type _check = Assert<
			IsAssignable<CreateWithRelsReturn, Effect.Effect<User, ValidationError | ForeignKeyError | OperationError>>
		>

		expect(true).toBe(true)
	})

	it("updateWithRelationships returns RunnableEffect", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>
		type UpdateWithRelsReturn = ReturnType<Methods["updateWithRelationships"]>

		type _check = Assert<
			IsAssignable<
				UpdateWithRelsReturn,
				Effect.Effect<User, ValidationError | NotFoundError | ForeignKeyError | OperationError>
			>
		>

		expect(true).toBe(true)
	})

	it("deleteWithRelationships returns RunnableEffect", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>
		type DeleteWithRelsReturn = ReturnType<Methods["deleteWithRelationships"]>

		type _check = Assert<
			IsAssignable<
				DeleteWithRelsReturn,
				Effect.Effect<{ deleted: User; cascaded?: Record<string, unknown> }, NotFoundError | ValidationError | OperationError>
			>
		>

		expect(true).toBe(true)
	})

	it("deleteManyWithRelationships returns RunnableEffect", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>
		type DeleteManyWithRelsReturn = ReturnType<Methods["deleteManyWithRelationships"]>

		type _check = Assert<
			IsAssignable<
				DeleteManyWithRelsReturn,
				Effect.Effect<
					{ readonly count: number; readonly deleted: ReadonlyArray<User> },
					ValidationError | OperationError
				>
			>
		>

		expect(true).toBe(true)
	})

	it("all methods have runPromise convenience property", () => {
		type Methods = CrudMethodsWithRelationships<User, UserRelations>

		type _check1 = Assert<
			IsAssignable<ReturnType<Methods["create"]>, { readonly runPromise: Promise<User> }>
		>
		type _check2 = Assert<
			IsAssignable<ReturnType<Methods["createWithRelationships"]>, { readonly runPromise: Promise<User> }>
		>
		type _check3 = Assert<
			IsAssignable<ReturnType<Methods["updateWithRelationships"]>, { readonly runPromise: Promise<User> }>
		>

		expect(true).toBe(true)
	})
})
