import * as Schema from "effect/Schema";
import { createEngineDatabase } from "./index.js";

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
			company: { type: "ref" as const, target: "companies", foreignKey: "companyId" },
		},
	},
	companies: {
		schema: CompanySchema,
		relationships: {},
	},
} as const;

async function assertTypes() {
	const db = await createEngineDatabase(config, {
		users: [{ id: "u1", name: "Alice", age: 30, companyId: "c1" }],
		companies: [{ id: "c1", name: "Acme" }],
	});

	const selected = await db.users.query({ select: ["name"] } as const);
	selected[0]?.name;
	// @ts-expect-error selected rows should not expose age
	selected[0]?.age;

	const stream = db.users.watch({ select: ["name"] } as const);
	for await (const emission of stream) {
		emission[0]?.name;
		// @ts-expect-error watch select should narrow like query select
		emission[0]?.age;
		break;
	}

	const populated = await db.users.query({
		populate: { company: true },
		select: { name: true, company: { name: true } },
	} as const);
	const populatedCompanyName: string | undefined = populated[0]?.company?.name;
	void populatedCompanyName;
	// @ts-expect-error populated select should not expose omitted scalar fields
	populated[0]?.age;
	// @ts-expect-error populated nested select should not expose omitted company id
	populated[0]?.company?.id;

	const populatedWatch = db.users.watch({
		populate: { company: true },
		select: { company: { name: true } },
	} as const);
	for await (const emission of populatedWatch) {
		const watchCompanyName: string | undefined = emission[0]?.company?.name;
		void watchCompanyName;
		// @ts-expect-error watch populate/select should not collapse to never or expose omitted fields
		emission[0]?.company?.id;
		break;
	}

	await db.$transaction(async (tx) => {
		const created = await tx.users.create({
			id: "u2",
			name: "Bob",
			age: 40,
			companyId: "c1",
		});
		created.name;
		const rows = await tx.users.query({ select: ["name"] } as const);
		rows[0]?.name;
		// @ts-expect-error transaction query select should narrow rows
		rows[0]?.age;
		return created.id;
	});

	// @ts-expect-error relationship delete options intentionally exclude returnDeleted in the engine facade
	await db.users.deleteWithRelationships("u1", { returnDeleted: true });
}

void assertTypes;
