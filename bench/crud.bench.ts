/**
 * CRUD Operation Throughput Benchmarks
 *
 * Measures ops/sec and latency percentiles for CRUD operations.
 * Uses a 10K-entity baseline collection for consistent measurements.
 */

import { Schema } from "effect";
import { Bench } from "tinybench";
import {
	attachTaskMetadata,
	checksumBenchmarkValue,
	createEngineTaskName,
} from "./comparison.js";
import { selectBenchEngines, type BenchEngine } from "./engines.js";
import { generateUsers, type User } from "./generators.js";
import {
	type BenchSchemaConfig,
	buildBenchOptions,
	closeAll,
	createTaskInstrumentation,
	formatResultsTable,
	measureAsync,
	withFrozenDate,
} from "./utils.js";

const BASELINE_SIZE = 10_000;
const BATCH_SIZE = 100;
const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";
const CHECKSUM_CLOCK_ISO = "2026-01-02T03:04:05.000Z";

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

const dbConfig = {
	users: {
		schema: UserSchema,
		relationships: {},
	},
} as const satisfies BenchSchemaConfig;

const BULK_DECLARATIVE_EMAIL = "bench-bulk-declarative@example.com";
const BULK_PREDICATE_EMAIL = "bench-bulk-predicate@example.com";
const BULK_DELETE_DECLARATIVE_EMAIL =
	"bench-bulk-delete-declarative@example.com";
const BULK_DELETE_PREDICATE_EMAIL = "bench-bulk-delete-predicate@example.com";
const BULK_DECLARATIVE_BASE_NAME = "Declarative Bulk Fixture";
const BULK_PREDICATE_BASE_NAME = "Predicate Bulk Fixture";
const BULK_DELETE_DECLARATIVE_BASE_NAME = "Declarative Bulk Delete Fixture";
const BULK_DELETE_PREDICATE_BASE_NAME = "Predicate Bulk Delete Fixture";
const SINGLE_UPDATE_NAME = "Updated User";
const SINGLE_UPDATE_AGE = 30;
const UPSERT_UPDATE_NAME = "Upserted Update";
const UPSERT_UPDATE_AGE = 44;

const createBulkFixtureUsers = (
	users: ReadonlyArray<User>,
	markerEmail: string,
	name: string,
): ReadonlyArray<User> =>
	users.map((user, index) =>
		index < users.length - BATCH_SIZE
			? user
			: {
					...user,
					name,
					email: markerEmail,
					age: 30,
					role: "user",
					createdAt: FIXED_CREATED_AT,
				},
	);

export const suiteName = "crud";

const computeCrudChecksum = async (
	engine: BenchEngine,
	caseName: string,
	users: ReadonlyArray<User>,
): Promise<string> => {
	const handle = await engine.createDatabase(dbConfig, {
		users: [...users],
	});
	try {
		switch (caseName) {
			case "create (single)": {
				return await withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
					const id = "checksum_create_single";
					const created = await handle.db.users.create({
						id,
						name: "Checksum Create",
						email: "checksum-create-single@example.com",
						age: 30,
						role: "user",
						createdAt: FIXED_CREATED_AT,
					}).runPromise;
					return checksumBenchmarkValue({
						created,
						stored: await handle.db.users.findById(id).runPromise,
					});
				});
			}
			case "createMany (batch of 100)": {
				return await withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
					const batch = Array.from({ length: BATCH_SIZE }, (_, index) => ({
						id: `checksum_create_many_${index}`,
						name: `Checksum Batch ${index}`,
						email: `checksum-create-many-${index}@example.com`,
						age: 20 + (index % 10),
						role: "user" as const,
						createdAt: FIXED_CREATED_AT,
					}));
					await handle.db.users.createMany(batch).runPromise;
					return checksumBenchmarkValue(
						await handle.db.users.query({
							where: { email: { $contains: "checksum-create-many-" } },
							sort: { id: "asc" },
						}).runPromise,
					);
				});
			}
			case "update (single)": {
				const target = users[0]!;
				await handle.db.users.update(target.id, {
					name: "Checksum Updated User",
					age: 77,
				}).runPromise;
				return checksumBenchmarkValue(
					await handle.db.users.findById(target.id).runPromise,
				);
			}
			case "updateMany (declarative batch ~100)": {
				await handle.collectionMutationAdapter.updateManyEquality(
					handle.db.users,
					{ email: BULK_DECLARATIVE_EMAIL },
					{ name: "Checksum Declarative Update" },
				);
				return checksumBenchmarkValue(
					await handle.db.users.query({
						where: { email: BULK_DECLARATIVE_EMAIL },
						select: ["id", "name", "email"],
						sort: { id: "asc" },
					}).runPromise,
				);
			}
			case "updateMany (predicate batch ~100)": {
				await handle.db.users.updateMany(
					(user) => user.email === BULK_PREDICATE_EMAIL,
					{ name: "Checksum Predicate Update" },
				).runPromise;
				return checksumBenchmarkValue(
					await handle.db.users.query({
						where: { email: BULK_PREDICATE_EMAIL },
						select: ["id", "name", "email"],
						sort: { id: "asc" },
					}).runPromise,
				);
			}
			case "delete (single)": {
				const target = users.at(-1)!;
				await handle.db.users.delete(target.id).runPromise;
				return checksumBenchmarkValue({
					exists: await handle.db.users.exists(target.id).runPromise,
					remainingCount: (await handle.db.users.query().runPromise).length,
				});
			}
			case "deleteMany (declarative batch ~100)": {
				await handle.collectionMutationAdapter.deleteManyEquality(
					handle.db.users,
					{ email: BULK_DELETE_DECLARATIVE_EMAIL },
				);
				return checksumBenchmarkValue({
					remaining: await handle.db.users.query({
						where: { email: BULK_DELETE_DECLARATIVE_EMAIL },
					}).runPromise,
					remainingCount: (await handle.db.users.query().runPromise).length,
				});
			}
			case "deleteMany (predicate batch ~100)": {
				await handle.db.users.deleteMany(
					(user) => user.email === BULK_DELETE_PREDICATE_EMAIL,
				).runPromise;
				return checksumBenchmarkValue({
					remaining: await handle.db.users.query({
						where: { email: BULK_DELETE_PREDICATE_EMAIL },
					}).runPromise,
					remainingCount: (await handle.db.users.query().runPromise).length,
				});
			}
			case "upsert (create path)": {
				return await withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
					const id = "checksum_upsert_create";
					await handle.db.users.upsert({
						where: { id },
						create: {
							id,
							name: "Checksum Upsert Create",
							email: "checksum-upsert-create@example.com",
							age: 34,
							role: "user",
							createdAt: FIXED_CREATED_AT,
						},
						update: { name: "unused" },
					}).runPromise;
					return checksumBenchmarkValue(
						await handle.db.users.findById(id).runPromise,
					);
				});
			}
			case "upsert (update path)": {
				const target = users[0]!;
				await handle.db.users.upsert({
					where: { id: target.id },
					create: target,
					update: { name: "Checksum Upsert Update", age: 61 },
				}).runPromise;
				return checksumBenchmarkValue(
					await handle.db.users.findById(target.id).runPromise,
				);
			}
			default:
				throw new Error(`Unsupported CRUD checksum case: ${caseName}`);
		}
	} finally {
		await handle.close();
	}
};

export async function createSuite(options?: {
	readonly includeStress?: boolean;
	readonly benchOptions?: Parameters<typeof buildBenchOptions>[0];
	readonly engines?: ReadonlyArray<BenchEngine["id"]>;
}): Promise<{
	readonly bench: Bench;
	readonly teardown: () => Promise<void>;
}> {
	const bench = new Bench(buildBenchOptions(options?.benchOptions));
	const baselineUsers = generateUsers(BASELINE_SIZE);
	const usersArray = [...baselineUsers];
	const updateManyDeclarativeUsers = createBulkFixtureUsers(
		usersArray,
		BULK_DECLARATIVE_EMAIL,
		BULK_DECLARATIVE_BASE_NAME,
	);
	const updateManyPredicateUsers = createBulkFixtureUsers(
		usersArray,
		BULK_PREDICATE_EMAIL,
		BULK_PREDICATE_BASE_NAME,
	);
	const deleteManyDeclarativeUsers = createBulkFixtureUsers(
		usersArray,
		BULK_DELETE_DECLARATIVE_EMAIL,
		BULK_DELETE_DECLARATIVE_BASE_NAME,
	);
	const deleteManyPredicateUsers = createBulkFixtureUsers(
		usersArray,
		BULK_DELETE_PREDICATE_EMAIL,
		BULK_DELETE_PREDICATE_BASE_NAME,
	);
	const deleteSingleTarget = usersArray.at(-1)!;
	const updateSingleTarget = usersArray[0]!;
	const upsertUpdateTarget = usersArray[0]!;
	const closers: Array<() => Promise<void>> = [];

	try {
		for (const engine of selectBenchEngines(options?.engines)) {
			const createSingleChecksum = await computeCrudChecksum(
				engine,
				"create (single)",
				usersArray,
			);
			const { value: createHandle, durationMs: createInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(dbConfig, {
						users: usersArray,
					}),
				);
			closers.push(createHandle.close);
			let createCounter = 0;
			let lastCreatedId: string | undefined;
			bench.add(
				createEngineTaskName(engine.id, "create (single)"),
				async () => {
					const uniqueId = `bench_user_${createCounter++}`;
					lastCreatedId = uniqueId;
					await createHandle.db.users.create({
						id: uniqueId,
						name: "Benchmark User",
						email: `benchmark${createCounter}@test.com`,
						age: 30,
						role: "user" as const,
						createdAt: FIXED_CREATED_AT,
					}).runPromise;
				},
				{
					afterEach: async () => {
						if (!lastCreatedId) return;
						await createHandle.db.users.delete(lastCreatedId).runPromise;
						lastCreatedId = undefined;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "create (single)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: createSingleChecksum,
				checksumProbe: () =>
					withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
						const id = "checksum_probe_create_single";
						const created = await createHandle.db.users.create({
							id,
							name: "Checksum Create",
							email: "checksum-create-single@example.com",
							age: 30,
							role: "user",
							createdAt: FIXED_CREATED_AT,
						}).runPromise;
						const checksum = checksumBenchmarkValue({
							created,
							stored: await createHandle.db.users.findById(id).runPromise,
						});
						await createHandle.db.users.delete(id).runPromise;
						return checksum;
					}),
				instrumentation: createTaskInstrumentation({
					initializationMs: createInitializationMs,
					commandPayload: {
						name: "Benchmark User",
						email: "benchmark@example.com",
					},
					resultPayload: { checksum: createSingleChecksum },
				}),
			});

			const createManyChecksum = await computeCrudChecksum(
				engine,
				"createMany (batch of 100)",
				usersArray,
			);
			const {
				value: createManyHandle,
				durationMs: createManyInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: usersArray,
				}),
			);
			closers.push(createManyHandle.close);
			let createManyCounter = 0;
			let lastBatchIds: ReadonlyArray<string> = [];
			bench.add(
				createEngineTaskName(engine.id, "createMany (batch of 100)"),
				async () => {
					const batchStartIndex = createManyCounter;
					createManyCounter += BATCH_SIZE;
					const batch: Array<User> = [];
					for (let index = 0; index < BATCH_SIZE; index++) {
						const current = batchStartIndex + index;
						batch.push({
							id: `batch_user_${current}`,
							name: `Batch User ${current}`,
							email: `batch${current}@test.com`,
							age: 25 + (current % 50),
							role: "user",
							createdAt: FIXED_CREATED_AT,
						});
					}
					lastBatchIds = batch.map((user) => user.id);
					await createManyHandle.db.users.createMany(batch).runPromise;
				},
				{
					afterEach: async () => {
						if (lastBatchIds.length === 0) return;
						await createManyHandle.db.users.deleteMany((user) =>
							lastBatchIds.includes(user.id),
						).runPromise;
						lastBatchIds = [];
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "createMany (batch of 100)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: false,
				checksum: createManyChecksum,
				checksumProbe: () =>
					withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
						const batch = Array.from({ length: BATCH_SIZE }, (_, index) => ({
							id: `checksum_probe_create_many_${index}`,
							name: `Checksum Batch ${index}`,
							email: `checksum-create-many-${index}@example.com`,
							age: 20 + (index % 10),
							role: "user" as const,
							createdAt: FIXED_CREATED_AT,
						}));
						await createManyHandle.db.users.createMany(batch).runPromise;
						const checksum = checksumBenchmarkValue(
							await createManyHandle.db.users.query({
								where: { email: { $contains: "checksum-create-many-" } },
								sort: { id: "asc" },
							}).runPromise,
						);
						await createManyHandle.db.users.deleteMany((user) =>
							batch.some((row) => row.id === user.id),
						).runPromise;
						return checksum;
					}),
				instrumentation: createTaskInstrumentation({
					initializationMs: createManyInitializationMs,
					commandPayload: { batchSize: BATCH_SIZE },
					resultPayload: { checksum: createManyChecksum },
				}),
			});

			const updateSingleChecksum = await computeCrudChecksum(
				engine,
				"update (single)",
				usersArray,
			);
			const { value: updateHandle, durationMs: updateInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(dbConfig, {
						users: usersArray,
					}),
				);
			closers.push(updateHandle.close);
			bench.add(
				createEngineTaskName(engine.id, "update (single)"),
				async () => {
					await updateHandle.db.users.update(updateSingleTarget.id, {
						name: SINGLE_UPDATE_NAME,
						age: SINGLE_UPDATE_AGE,
					}).runPromise;
				},
				{
					afterEach: async () => {
						const updated = await updateHandle.db.users.findById(
							updateSingleTarget.id,
						).runPromise;
						if (
							updated?.name !== SINGLE_UPDATE_NAME ||
							updated.age !== SINGLE_UPDATE_AGE
						) {
							throw new Error(
								"update (single) did not update the observable target row",
							);
						}
						await updateHandle.db.users.update(updateSingleTarget.id, {
							name: updateSingleTarget.name,
							age: updateSingleTarget.age,
						}).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "update (single)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: updateSingleChecksum,
				checksumProbe: async () => {
					await updateHandle.db.users.update(updateSingleTarget.id, {
						name: "Checksum Updated User",
						age: 77,
					}).runPromise;
					const checksum = checksumBenchmarkValue(
						await updateHandle.db.users.findById(updateSingleTarget.id)
							.runPromise,
					);
					await updateHandle.db.users.update(updateSingleTarget.id, {
						name: updateSingleTarget.name,
						age: updateSingleTarget.age,
					}).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: updateInitializationMs,
					commandPayload: {
						id: updateSingleTarget.id,
						updates: { name: SINGLE_UPDATE_NAME, age: SINGLE_UPDATE_AGE },
					},
					resultPayload: { checksum: updateSingleChecksum },
				}),
			});

			const updateManyDeclarativeChecksum = await computeCrudChecksum(
				engine,
				"updateMany (declarative batch ~100)",
				updateManyDeclarativeUsers,
			);
			const {
				value: updateManyDeclarativeHandle,
				durationMs: updateManyDeclarativeInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: updateManyDeclarativeUsers,
				}),
			);
			closers.push(updateManyDeclarativeHandle.close);
			bench.add(
				createEngineTaskName(engine.id, "updateMany (declarative batch ~100)"),
				async () => {
					await updateManyDeclarativeHandle.collectionMutationAdapter.updateManyEquality(
						updateManyDeclarativeHandle.db.users,
						{ email: BULK_DECLARATIVE_EMAIL },
						{ name: "Declarative Bulk Updated" },
					);
				},
				{
					afterEach: async () => {
						const updatedRows =
							await updateManyDeclarativeHandle.db.users.query({
								where: { email: BULK_DECLARATIVE_EMAIL },
								sort: { id: "asc" },
							}).runPromise;
						if (
							updatedRows.length !== BATCH_SIZE ||
							updatedRows.some(
								(user) => user.name !== "Declarative Bulk Updated",
							)
						) {
							throw new Error(
								"updateMany (declarative batch ~100) did not update the expected cohort",
							);
						}
						await updateManyDeclarativeHandle.collectionMutationAdapter.updateManyEquality(
							updateManyDeclarativeHandle.db.users,
							{ email: BULK_DECLARATIVE_EMAIL },
							{ name: BULK_DECLARATIVE_BASE_NAME },
						);
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "updateMany (declarative batch ~100)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: updateManyDeclarativeChecksum,
				checksumProbe: async () => {
					await updateManyDeclarativeHandle.collectionMutationAdapter.updateManyEquality(
						updateManyDeclarativeHandle.db.users,
						{ email: BULK_DECLARATIVE_EMAIL },
						{ name: "Checksum Declarative Update" },
					);
					const checksum = checksumBenchmarkValue(
						await updateManyDeclarativeHandle.db.users.query({
							where: { email: BULK_DECLARATIVE_EMAIL },
							select: ["id", "name", "email"],
							sort: { id: "asc" },
						}).runPromise,
					);
					await updateManyDeclarativeHandle.collectionMutationAdapter.updateManyEquality(
						updateManyDeclarativeHandle.db.users,
						{ email: BULK_DECLARATIVE_EMAIL },
						{ name: BULK_DECLARATIVE_BASE_NAME },
					);
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: updateManyDeclarativeInitializationMs,
					commandPayload: {
						where: { email: BULK_DECLARATIVE_EMAIL },
						updates: { name: "Declarative Bulk Updated" },
					},
					resultPayload: { checksum: updateManyDeclarativeChecksum },
				}),
			});

			const updateManyPredicateChecksum = await computeCrudChecksum(
				engine,
				"updateMany (predicate batch ~100)",
				updateManyPredicateUsers,
			);
			const {
				value: updateManyPredicateHandle,
				durationMs: updateManyPredicateInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: updateManyPredicateUsers,
				}),
			);
			closers.push(updateManyPredicateHandle.close);
			bench.add(
				createEngineTaskName(engine.id, "updateMany (predicate batch ~100)"),
				async () => {
					await updateManyPredicateHandle.db.users.updateMany(
						(user) => user.email === BULK_PREDICATE_EMAIL,
						{ name: "Predicate Bulk Updated" },
					).runPromise;
				},
				{
					afterEach: async () => {
						const updatedRows = await updateManyPredicateHandle.db.users.query({
							where: { email: BULK_PREDICATE_EMAIL },
							sort: { id: "asc" },
						}).runPromise;
						if (
							updatedRows.length !== BATCH_SIZE ||
							updatedRows.some((user) => user.name !== "Predicate Bulk Updated")
						) {
							throw new Error(
								"updateMany (predicate batch ~100) did not update the expected cohort",
							);
						}
						await updateManyPredicateHandle.db.users.updateMany(
							(user) => user.email === BULK_PREDICATE_EMAIL,
							{ name: BULK_PREDICATE_BASE_NAME },
						).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "updateMany (predicate batch ~100)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: updateManyPredicateChecksum,
				checksumProbe: async () => {
					await updateManyPredicateHandle.db.users.updateMany(
						(user) => user.email === BULK_PREDICATE_EMAIL,
						{ name: "Checksum Predicate Update" },
					).runPromise;
					const checksum = checksumBenchmarkValue(
						await updateManyPredicateHandle.db.users.query({
							where: { email: BULK_PREDICATE_EMAIL },
							select: ["id", "name", "email"],
							sort: { id: "asc" },
						}).runPromise,
					);
					await updateManyPredicateHandle.db.users.updateMany(
						(user) => user.email === BULK_PREDICATE_EMAIL,
						{ name: BULK_PREDICATE_BASE_NAME },
					).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: updateManyPredicateInitializationMs,
					commandPayload: {
						predicate: `user.email === ${JSON.stringify(BULK_PREDICATE_EMAIL)}`,
						updates: { name: "Predicate Bulk Updated" },
					},
					resultPayload: { checksum: updateManyPredicateChecksum },
				}),
			});

			const deleteSingleChecksum = await computeCrudChecksum(
				engine,
				"delete (single)",
				usersArray,
			);
			const { value: deleteHandle, durationMs: deleteInitializationMs } =
				await measureAsync(() =>
					engine.createDatabase(dbConfig, {
						users: usersArray,
					}),
				);
			closers.push(deleteHandle.close);
			bench.add(
				createEngineTaskName(engine.id, "delete (single)"),
				async () => {
					await deleteHandle.db.users.delete(deleteSingleTarget.id).runPromise;
				},
				{
					afterEach: async () => {
						const exists = await deleteHandle.db.users.exists(
							deleteSingleTarget.id,
						).runPromise;
						if (exists) {
							throw new Error(
								"delete (single) did not remove the fixed tail row",
							);
						}
						await deleteHandle.db.users.create(deleteSingleTarget).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "delete (single)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: deleteSingleChecksum,
				checksumProbe: async () => {
					await deleteHandle.db.users.delete(deleteSingleTarget.id).runPromise;
					const checksum = checksumBenchmarkValue({
						exists: await deleteHandle.db.users.exists(deleteSingleTarget.id)
							.runPromise,
						remainingCount: (await deleteHandle.db.users.query().runPromise)
							.length,
					});
					await deleteHandle.db.users.create(deleteSingleTarget).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: deleteInitializationMs,
					commandPayload: { id: deleteSingleTarget.id },
					resultPayload: { checksum: deleteSingleChecksum },
				}),
			});

			const deleteManyDeclarativeChecksum = await computeCrudChecksum(
				engine,
				"deleteMany (declarative batch ~100)",
				deleteManyDeclarativeUsers,
			);
			const {
				value: deleteManyDeclarativeHandle,
				durationMs: deleteManyDeclarativeInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: deleteManyDeclarativeUsers,
				}),
			);
			closers.push(deleteManyDeclarativeHandle.close);
			const deleteManyDeclarativeTargets = deleteManyDeclarativeUsers.slice(
				-BATCH_SIZE,
			);
			bench.add(
				createEngineTaskName(engine.id, "deleteMany (declarative batch ~100)"),
				async () => {
					await deleteManyDeclarativeHandle.collectionMutationAdapter.deleteManyEquality(
						deleteManyDeclarativeHandle.db.users,
						{ email: BULK_DELETE_DECLARATIVE_EMAIL },
					);
				},
				{
					afterEach: async () => {
						const remaining = await deleteManyDeclarativeHandle.db.users.query({
							where: { email: BULK_DELETE_DECLARATIVE_EMAIL },
						}).runPromise;
						if (remaining.length !== 0) {
							throw new Error(
								"deleteMany (declarative batch ~100) left rows in the deleted cohort",
							);
						}
						await deleteManyDeclarativeHandle.db.users.createMany(
							deleteManyDeclarativeTargets,
						).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "deleteMany (declarative batch ~100)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: deleteManyDeclarativeChecksum,
				checksumProbe: async () => {
					await deleteManyDeclarativeHandle.collectionMutationAdapter.deleteManyEquality(
						deleteManyDeclarativeHandle.db.users,
						{ email: BULK_DELETE_DECLARATIVE_EMAIL },
					);
					const checksum = checksumBenchmarkValue({
						remaining: await deleteManyDeclarativeHandle.db.users.query({
							where: { email: BULK_DELETE_DECLARATIVE_EMAIL },
						}).runPromise,
						remainingCount: (
							await deleteManyDeclarativeHandle.db.users.query().runPromise
						).length,
					});
					await deleteManyDeclarativeHandle.db.users.createMany(
						deleteManyDeclarativeTargets,
					).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: deleteManyDeclarativeInitializationMs,
					commandPayload: { where: { email: BULK_DELETE_DECLARATIVE_EMAIL } },
					resultPayload: { checksum: deleteManyDeclarativeChecksum },
				}),
			});

			const deleteManyPredicateChecksum = await computeCrudChecksum(
				engine,
				"deleteMany (predicate batch ~100)",
				deleteManyPredicateUsers,
			);
			const {
				value: deleteManyPredicateHandle,
				durationMs: deleteManyPredicateInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: deleteManyPredicateUsers,
				}),
			);
			closers.push(deleteManyPredicateHandle.close);
			const deleteManyPredicateTargets = deleteManyPredicateUsers.slice(
				-BATCH_SIZE,
			);
			bench.add(
				createEngineTaskName(engine.id, "deleteMany (predicate batch ~100)"),
				async () => {
					await deleteManyPredicateHandle.db.users.deleteMany(
						(user) => user.email === BULK_DELETE_PREDICATE_EMAIL,
					).runPromise;
				},
				{
					afterEach: async () => {
						const remaining = await deleteManyPredicateHandle.db.users.query({
							where: { email: BULK_DELETE_PREDICATE_EMAIL },
						}).runPromise;
						if (remaining.length !== 0) {
							throw new Error(
								"deleteMany (predicate batch ~100) left rows in the deleted cohort",
							);
						}
						await deleteManyPredicateHandle.db.users.createMany(
							deleteManyPredicateTargets,
						).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "deleteMany (predicate batch ~100)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: true,
				checksum: deleteManyPredicateChecksum,
				checksumProbe: async () => {
					await deleteManyPredicateHandle.db.users.deleteMany(
						(user) => user.email === BULK_DELETE_PREDICATE_EMAIL,
					).runPromise;
					const checksum = checksumBenchmarkValue({
						remaining: await deleteManyPredicateHandle.db.users.query({
							where: { email: BULK_DELETE_PREDICATE_EMAIL },
						}).runPromise,
						remainingCount: (
							await deleteManyPredicateHandle.db.users.query().runPromise
						).length,
					});
					await deleteManyPredicateHandle.db.users.createMany(
						deleteManyPredicateTargets,
					).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: deleteManyPredicateInitializationMs,
					commandPayload: {
						predicate: `user.email === ${JSON.stringify(BULK_DELETE_PREDICATE_EMAIL)}`,
					},
					resultPayload: { checksum: deleteManyPredicateChecksum },
				}),
			});

			const upsertCreateChecksum = await computeCrudChecksum(
				engine,
				"upsert (create path)",
				usersArray,
			);
			const {
				value: upsertCreateHandle,
				durationMs: upsertCreateInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: usersArray,
				}),
			);
			closers.push(upsertCreateHandle.close);
			let upsertCreateCounter = 0;
			let lastUpsertCreateId: string | undefined;
			bench.add(
				createEngineTaskName(engine.id, "upsert (create path)"),
				async () => {
					const uniqueId = `upsert_new_${upsertCreateCounter++}`;
					lastUpsertCreateId = uniqueId;
					await upsertCreateHandle.db.users.upsert({
						where: { id: uniqueId },
						create: {
							id: uniqueId,
							name: `Upserted User ${upsertCreateCounter}`,
							email: `upsert_create${upsertCreateCounter}@test.com`,
							age: 30,
							role: "user" as const,
							createdAt: FIXED_CREATED_AT,
						},
						update: {
							name: `Should Not Be Used ${upsertCreateCounter}`,
						},
					}).runPromise;
				},
				{
					afterEach: async () => {
						if (!lastUpsertCreateId) return;
						await upsertCreateHandle.db.users.delete(lastUpsertCreateId)
							.runPromise;
						lastUpsertCreateId = undefined;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "upsert (create path)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: false,
				checksum: upsertCreateChecksum,
				checksumProbe: () =>
					withFrozenDate(CHECKSUM_CLOCK_ISO, async () => {
						const id = "checksum_probe_upsert_create";
						await upsertCreateHandle.db.users.upsert({
							where: { id },
							create: {
								id,
								name: "Checksum Upsert Create",
								email: "checksum-upsert-create@example.com",
								age: 34,
								role: "user",
								createdAt: FIXED_CREATED_AT,
							},
							update: { name: "unused" },
						}).runPromise;
						const checksum = checksumBenchmarkValue(
							await upsertCreateHandle.db.users.findById(id).runPromise,
						);
						await upsertCreateHandle.db.users.delete(id).runPromise;
						return checksum;
					}),
				instrumentation: createTaskInstrumentation({
					initializationMs: upsertCreateInitializationMs,
					commandPayload: { where: { id: "new-upsert-id" } },
					resultPayload: { checksum: upsertCreateChecksum },
				}),
			});

			const upsertUpdateChecksum = await computeCrudChecksum(
				engine,
				"upsert (update path)",
				usersArray,
			);
			const {
				value: upsertUpdateHandle,
				durationMs: upsertUpdateInitializationMs,
			} = await measureAsync(() =>
				engine.createDatabase(dbConfig, {
					users: usersArray,
				}),
			);
			closers.push(upsertUpdateHandle.close);
			bench.add(
				createEngineTaskName(engine.id, "upsert (update path)"),
				async () => {
					await upsertUpdateHandle.db.users.upsert({
						where: { id: upsertUpdateTarget.id },
						create: upsertUpdateTarget,
						update: {
							name: UPSERT_UPDATE_NAME,
							age: UPSERT_UPDATE_AGE,
						},
					}).runPromise;
				},
				{
					afterEach: async () => {
						const updated = await upsertUpdateHandle.db.users.findById(
							upsertUpdateTarget.id,
						).runPromise;
						if (
							updated?.name !== UPSERT_UPDATE_NAME ||
							updated.age !== UPSERT_UPDATE_AGE
						) {
							throw new Error(
								"upsert (update path) did not update the observable target row",
							);
						}
						await upsertUpdateHandle.db.users.update(upsertUpdateTarget.id, {
							name: upsertUpdateTarget.name,
							age: upsertUpdateTarget.age,
						}).runPromise;
					},
				},
			);
			attachTaskMetadata(bench.tasks[bench.tasks.length - 1]!, {
				benchmarkName: "upsert (update path)",
				engineId: engine.id,
				category: "write-transaction",
				caseType: "required",
				datasetSize: BASELINE_SIZE,
				normalInteraction: false,
				checksum: upsertUpdateChecksum,
				checksumProbe: async () => {
					await upsertUpdateHandle.db.users.upsert({
						where: { id: upsertUpdateTarget.id },
						create: upsertUpdateTarget,
						update: { name: "Checksum Upsert Update", age: 61 },
					}).runPromise;
					const checksum = checksumBenchmarkValue(
						await upsertUpdateHandle.db.users.findById(upsertUpdateTarget.id)
							.runPromise,
					);
					await upsertUpdateHandle.db.users.update(upsertUpdateTarget.id, {
						name: upsertUpdateTarget.name,
						age: upsertUpdateTarget.age,
					}).runPromise;
					return checksum;
				},
				instrumentation: createTaskInstrumentation({
					initializationMs: upsertUpdateInitializationMs,
					commandPayload: { where: { id: upsertUpdateTarget.id } },
					resultPayload: { checksum: upsertUpdateChecksum },
				}),
			});
		}

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
	console.log("Running CRUD Operation Benchmarks\n");

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
