import { Data, Effect, Schema, Stream } from "effect";
import { createEffectDatabase, type ValidationError } from "./index.js";

const CompanySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	companyId: Schema.String,
});

const config = {
	users: {
		schema: UserSchema,
		relationships: {
			company: {
				type: "ref" as const,
				target: "companies",
				foreignKey: "companyId",
			},
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {},
	},
} as const;

class TestBusinessError extends Data.TaggedError("TestBusinessError")<{
	readonly message: string;
}> {}

const program = Effect.gen(function* () {
	const db = yield* createEffectDatabase(config, {
		users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
		companies: [{ id: "c1", name: "Acme" }],
	});

	const rows = yield* Stream.runCollect(
		db.users.query({ select: ["name"] } as const),
	);
	rows[0]?.name;
	// @ts-expect-error select should narrow query rows
	rows[0]?.age;

	const populated = yield* Stream.runCollect(
		db.users.query({
			populate: { company: true },
			select: { company: { name: true } },
		} as const),
	);
	populated[0]?.company?.name;
	// @ts-expect-error nested populated select should hide omitted fields
	populated[0]?.company?.id;

	const watch = yield* db.users.watch({ select: ["name"] } as const);
	const watchRows = yield* Stream.runCollect(Stream.take(watch, 1));
	watchRows[0]?.[0]?.name;

	const byId = yield* db.users.watchById("u1");
	const watchedEntity = yield* Stream.runCollect(Stream.take(byId, 1));
	watchedEntity[0]?.name;

	const txResult = yield* db.$transaction((tx) =>
		Effect.gen(function* () {
			const created = yield* tx.users.create({
				id: "u2",
				name: "Bob",
				age: 40,
				companyId: "c1",
			});
			return created.id;
		}),
	);
	const txId: string = txResult;
	void txId;

	yield* db.$transaction(() =>
		Effect.fail(new TestBusinessError({ message: "boom" })),
	);
});

const invalidInitialDataProgram = createEffectDatabase(config, {
	users: [{ id: "u1", name: "Alice", age: "old" as never, companyId: "c1" }],
	companies: [{ id: "c1", name: "Acme" }],
}).pipe(
	Effect.catchTag("ValidationError", (error) => {
		const typed: ValidationError = error;
		void typed;
		return Effect.succeed(error.issues[0]?.field ?? "unknown");
	}),
);

void invalidInitialDataProgram;

void program;
