/**
 * Query Pipeline Stage Benchmarks
 *
 * Measures ops/sec and latency percentiles for query pipeline stages.
 */

import { Schema } from "effect";
import { Bench } from "tinybench";
import {
	attachTaskMetadata,
	checksumBenchmarkValue,
	createEngineTaskName,
} from "./comparison.js";
import { type BenchDatabaseHandle, selectBenchEngines } from "./engines.js";
import {
	generateProducts,
	generateUsers,
	type Product,
	type User,
} from "./generators.js";
import {
	type BenchSchemaConfig,
	buildBenchOptions,
	closeAll,
	createCounterDeltaTracker,
	createTaskInstrumentation,
	formatResultsTable,
	measureAsync,
} from "./utils.js";

const BASELINE_SIZE = 10_000;

type QueryConfig = Record<string, unknown>;
type QueryRunner = { readonly runPromise: Promise<unknown> };
type QueryableDb = Record<
	string,
	{ readonly query: (config: QueryConfig) => QueryRunner }
>;

const buildRoleAgeSortUsers = (count: number): ReadonlyArray<User> => {
	const roles = ["admin", "moderator", "user"] as const;
	return Array.from({ length: count }, (_, index) => {
		const roleIndex = index % roles.length;
		const roleCount = Math.floor(index / roles.length);
		return {
			id: `sort-role-age-${String(index + 1).padStart(5, "0")}`,
			name: `Role Age ${index + 1}`,
			email: `sort-role-age-${index + 1}@example.com`,
			age: 10_000 - roleCount,
			role: roles[roleIndex]!,
			createdAt: new Date(Date.UTC(2024, 0, 1 + (index % 365))).toISOString(),
		};
	});
};

const buildRoleAgeNameSortUsers = (count: number): ReadonlyArray<User> => {
	const roles = ["admin", "moderator", "user"] as const;
	return Array.from({ length: count }, (_, index) => {
		const roleIndex = index % roles.length;
		const group = Math.floor(index / roles.length);
		return {
			id: `sort-role-age-name-${String(index + 1).padStart(5, "0")}`,
			name: `Name ${String(group).padStart(5, "0")}-${String(index).padStart(5, "0")}`,
			email: `sort-role-age-name-${index + 1}@example.com`,
			age: 100 - (group % 100),
			role: roles[roleIndex]!,
			createdAt: new Date(Date.UTC(2024, 0, 1 + (index % 365))).toISOString(),
		};
	});
};

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	role: Schema.Union([
		Schema.Literal("admin"),
		Schema.Literal("moderator"),
		Schema.Literal("user"),
	]),
	createdAt: Schema.String,
});

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.Union([
		Schema.Literal("electronics"),
		Schema.Literal("clothing"),
		Schema.Literal("books"),
		Schema.Literal("home"),
		Schema.Literal("sports"),
		Schema.Literal("toys"),
	]),
	stock: Schema.Number,
	supplierId: Schema.String,
});

const OrderSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	productId: Schema.String,
	quantity: Schema.Number,
	total: Schema.Number,
	status: Schema.Union([
		Schema.Literal("pending"),
		Schema.Literal("completed"),
		Schema.Literal("cancelled"),
	]),
	createdAt: Schema.String,
});

const SupplierSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	country: Schema.String,
});

const basicDbConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role", "age"] as ReadonlyArray<string>,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

const relationshipDbConfig = {
	users: {
		schema: UserSchema,
		indexes: ["role"] as ReadonlyArray<string>,
		relationships: {
			orders: {
				type: "inverse" as const,
				target: "orders" as const,
				foreignKey: "userId",
			},
		},
	},
	products: {
		schema: ProductSchema,
		indexes: ["category"] as ReadonlyArray<string>,
		relationships: {
			supplier: {
				type: "ref" as const,
				target: "suppliers" as const,
				foreignKey: "supplierId",
			},
		},
	},
	orders: {
		schema: OrderSchema,
		relationships: {
			user: {
				type: "ref" as const,
				target: "users" as const,
				foreignKey: "userId",
			},
			product: {
				type: "ref" as const,
				target: "products" as const,
				foreignKey: "productId",
			},
		},
	},
	suppliers: {
		schema: SupplierSchema,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

function generateSuppliers(count: number): ReadonlyArray<{
	readonly id: string;
	readonly name: string;
	readonly country: string;
}> {
	const countries = ["USA", "China", "Germany", "Japan", "UK", "France"];
	const suppliers: Array<{
		readonly id: string;
		readonly name: string;
		readonly country: string;
	}> = [];

	for (let index = 0; index < count; index++) {
		suppliers.push({
			id: `supplier_${String(index + 1).padStart(4, "0")}`,
			name: `Supplier ${index + 1}`,
			country: countries[index % countries.length]!,
		});
	}

	return suppliers;
}

function generateOrders(
	users: ReadonlyArray<User>,
	products: ReadonlyArray<Product>,
	count: number,
): ReadonlyArray<{
	readonly id: string;
	readonly userId: string;
	readonly productId: string;
	readonly quantity: number;
	readonly total: number;
	readonly status: "pending" | "completed" | "cancelled";
	readonly createdAt: string;
}> {
	const statuses = ["pending", "completed", "cancelled"] as const;
	const orders: Array<{
		readonly id: string;
		readonly userId: string;
		readonly productId: string;
		readonly quantity: number;
		readonly total: number;
		readonly status: "pending" | "completed" | "cancelled";
		readonly createdAt: string;
	}> = [];

	for (let orderIndex = 0; orderIndex < count; orderIndex++) {
		const user = users[orderIndex % users.length]!;
		const product = products[orderIndex % products.length]!;
		const quantity = (orderIndex % 5) + 1;
		orders.push({
			id: `order_${String(orderIndex + 1).padStart(6, "0")}`,
			userId: user.id,
			productId: product.id,
			quantity,
			total: product.price * quantity,
			status: statuses[orderIndex % statuses.length]!,
			createdAt: new Date(2024, 0, 1 + (orderIndex % 365)).toISOString(),
		});
	}

	return orders;
}

export const suiteName = "query-pipeline";

export async function createSuite(options?: {
	readonly includeStress?: boolean;
	readonly benchOptions?: Parameters<typeof buildBenchOptions>[0];
	readonly engines?: ReadonlyArray<"typescript" | "wasm">;
}): Promise<{
	readonly bench: Bench;
	readonly teardown: () => Promise<void>;
}> {
	const bench = new Bench(buildBenchOptions(options?.benchOptions));
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];
	const roleAgeSortUsers = buildRoleAgeSortUsers(BASELINE_SIZE);
	const roleAgeNameSortUsers = buildRoleAgeNameSortUsers(BASELINE_SIZE);
	const relationshipUsers = generateUsers(BASELINE_SIZE);
	const relationshipProducts = generateProducts(BASELINE_SIZE);
	const suppliers = generateSuppliers(100);
	const orders = generateOrders(
		relationshipUsers,
		relationshipProducts,
		BASELINE_SIZE,
	);
	const relationshipInitialData = {
		users: [...relationshipUsers],
		products: [...relationshipProducts],
		suppliers: [...suppliers],
		orders: [...orders],
	} as const;
	const closers: Array<() => Promise<void>> = [];
	const databaseHandles = new Map<
		string,
		{
			readonly handle: BenchDatabaseHandle<unknown>;
			readonly initializationMs: number;
		}
	>();
	const objectIds = new WeakMap<object, number>();
	let nextObjectId = 1;
	const objectId = (value: object): number => {
		const existing = objectIds.get(value);
		if (existing !== undefined) {
			return existing;
		}
		const id = nextObjectId++;
		objectIds.set(value, id);
		return id;
	};
	const databaseKey = (
		engineId: string,
		config: BenchSchemaConfig,
		initialData: Readonly<
			Record<string, ReadonlyArray<Record<string, unknown>>>
		>,
	): string =>
		[
			engineId,
			`config:${objectId(config)}`,
			...Object.entries(initialData)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([collection, rows]) => `${collection}:${objectId(rows)}`),
		].join("|");

	try {
		const registerQueryTask = async <T extends BenchSchemaConfig>(taskOptions: {
			readonly name: string;
			readonly config: T;
			readonly initialData: {
				readonly [K in keyof T]?: ReadonlyArray<Record<string, unknown>>;
			};
			readonly collection: keyof T & string;
			readonly query: QueryConfig;
			readonly datasetSize: number;
			readonly normalInteraction: boolean;
		}) => {
			for (const engine of selectBenchEngines(options?.engines)) {
				const key = databaseKey(
					engine.id,
					taskOptions.config,
					taskOptions.initialData,
				);
				let cached = databaseHandles.get(key);
				if (cached === undefined) {
					const created = await measureAsync(() =>
						engine.createDatabase(taskOptions.config, taskOptions.initialData),
					);
					cached = {
						handle: created.value as BenchDatabaseHandle<unknown>,
						initializationMs: created.durationMs,
					};
					databaseHandles.set(key, cached);
					closers.push(cached.handle.close);
				}
				const { handle, initializationMs } = cached;
				const resultPayload = await (handle.db as QueryableDb)[
					taskOptions.collection
				]!.query(taskOptions.query).runPromise;
				const checksum = checksumBenchmarkValue(resultPayload);
				const projectionDeltas = createCounterDeltaTracker(
					handle.projectionMaterialization,
				);
				bench.add(
					createEngineTaskName(engine.id, taskOptions.name),
					async () => {
						await (handle.db as unknown as QueryableDb)[
							taskOptions.collection
						]!.query(taskOptions.query).runPromise;
					},
					{
						beforeEach: projectionDeltas.beforeEach,
						afterEach: projectionDeltas.afterEach,
					},
				);
				attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
					benchmarkName: taskOptions.name,
					engineId: engine.id,
					category: "read-query",
					caseType: "required",
					datasetSize: taskOptions.datasetSize,
					operationCount: 1,
					normalInteraction: taskOptions.normalInteraction,
					checksum,
					checksumProbe: async () =>
						checksumBenchmarkValue(
							await (handle.db as unknown as QueryableDb)[
								taskOptions.collection
							]!.query(taskOptions.query).runPromise,
						),
					instrumentation: createTaskInstrumentation({
						initializationMs,
						commandPayload: taskOptions.query,
						resultPayload,
						projectionMaterialization: projectionDeltas.snapshot,
					}),
				});
			}
		};

		await registerQueryTask({
			name: "filter: equality (role = 'admin')",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { where: { role: "admin" } },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "filter: range (age > 30 AND age < 50)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { where: { age: { $gt: 30, $lt: 50 } } },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "filter: compound ($and with 3 conditions)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: {
				where: {
					$and: [
						{ role: { $in: ["admin", "moderator"] } },
						{ age: { $gte: 25, $lte: 60 } },
						{ name: { $contains: "a" } },
					],
				},
			},
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});

		await registerQueryTask({
			name: "sort: single-field (age asc)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { sort: { age: "asc" } },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "sort: single-field (age desc)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { sort: { age: "desc" } },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "sort: multi-field (role asc, age desc)",
			config: basicDbConfig,
			initialData: { users: roleAgeSortUsers },
			collection: "users",
			query: { sort: { role: "asc", age: "desc" } },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "sort: multi-field (role asc, age desc, name asc)",
			config: basicDbConfig,
			initialData: { users: roleAgeNameSortUsers },
			collection: "users",
			query: {
				sort: { role: "asc", age: "desc", name: "asc" },
			},
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});

		await registerQueryTask({
			name: "populate: single ref (order → user)",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: { where: { status: "completed" }, populate: { user: true } },
			datasetSize: relationshipUsers.length,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "populate: inverse (user → orders)",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "users",
			query: { where: { role: "admin" }, populate: { orders: true } },
			datasetSize: relationshipUsers.length,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "populate: nested 2-level (order → user → orders)",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: { status: "completed" },
				populate: { user: { orders: true } },
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "populate: multiple refs (order → user, product)",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: { status: "completed" },
				populate: { user: true, product: true },
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "populate: nested 3-level (order → product → supplier)",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: { status: "pending" },
				populate: { product: { supplier: true } },
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: false,
		});

		await registerQueryTask({
			name: "select: single field (name)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { select: ["name"] },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "select: two fields (id, name)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { select: ["id", "name"] },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "select: three fields (id, name, email)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { select: ["id", "name", "email"] },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "select: most fields (id, name, email, age, role)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { select: ["id", "name", "email", "age", "role"] },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "select: no projection (all fields)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: {},
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});
		await registerQueryTask({
			name: "select: with filter (name, email WHERE role='admin')",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { where: { role: "admin" }, select: ["name", "email"] },
			datasetSize: BASELINE_SIZE,
			normalInteraction: false,
		});

		await registerQueryTask({
			name: "paginate: limit 10 from beginning",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { limit: 10 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "paginate: limit 10, offset 5000 (middle)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { offset: 5000, limit: 10 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "paginate: limit 10, offset 9990 (end)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { offset: 9990, limit: 10 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "paginate: limit 100, offset 500",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { offset: 500, limit: 100 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "paginate: limit 10, offset 1000 with sort",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { sort: { age: "desc" }, offset: 1000, limit: 10 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "paginate: limit 10, offset 500 with filter",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: { where: { role: "admin" }, offset: 500, limit: 10 },
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});

		await registerQueryTask({
			name: "combined: filter + sort + select + paginate (no populate)",
			config: basicDbConfig,
			initialData: { users: usersArray },
			collection: "users",
			query: {
				where: {
					role: { $in: ["admin", "moderator"] },
					age: { $gte: 25, $lte: 55 },
				},
				sort: { age: "desc", name: "asc" },
				select: ["id", "name", "email", "role"],
				offset: 100,
				limit: 20,
			},
			datasetSize: BASELINE_SIZE,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "combined: filter + sort + populate + select + paginate",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: {
					status: { $in: ["completed", "pending"] },
					quantity: { $gte: 2 },
				},
				sort: { total: "desc", createdAt: "asc" },
				populate: { user: true, product: true },
				select: ["id", "quantity", "total", "status"],
				offset: 50,
				limit: 25,
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "combined: filter + nested populate + sort + paginate",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: { status: "completed" },
				sort: { total: "desc" },
				populate: { product: { supplier: true } },
				offset: 20,
				limit: 15,
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: true,
		});
		await registerQueryTask({
			name: "combined: complex filter + multi-populate + sort + select + paginate",
			config: relationshipDbConfig,
			initialData: relationshipInitialData,
			collection: "orders",
			query: {
				where: {
					$and: [
						{ status: { $in: ["completed", "pending"] } },
						{ quantity: { $gte: 1, $lte: 4 } },
						{ total: { $gt: 50 } },
					],
				},
				sort: { total: "desc", createdAt: "desc" },
				populate: { user: true, product: { supplier: true } },
				select: ["id", "quantity", "total", "status", "createdAt"],
				offset: 10,
				limit: 20,
			},
			datasetSize: relationshipUsers.length,
			normalInteraction: true,
		});

		return {
			bench,
			teardown: async () => {
				await closeAll(closers);
			},
		};
	} catch (error) {
		await closeAll(closers);
		throw error;
	}
}

export async function run(): Promise<void> {
	console.log("Running Query Pipeline Benchmarks\n");

	const { bench, teardown } = await createSuite();
	try {
		await bench.run();
		console.log("\nResults:\n");
		console.log(formatResultsTable(bench.tasks));
	} finally {
		await teardown();
	}
}

if (import.meta.main) {
	run();
}
