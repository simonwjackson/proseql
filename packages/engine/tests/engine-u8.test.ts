import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DuplicateKeyError,
	HookError,
	OperationError,
	SerializationError,
	StorageError,
	TransactionError,
	ValidationError,
} from "@proseql/core";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createEngineDatabase,
	createNodeEngineStorageHost,
	createPersistentEngineDatabase,
	makeEngineStorageLayer,
	type NodeEngineStorageHost,
} from "../src/index.js";

const WORKTREE_ROOT = "/home/simonwjackson/code/github/simonwjackson/proseql/.worktrees/refactor-rust-engine-conversion";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<void> | void, timeoutMs = 1000, stepMs = 25) {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() <= deadline) {
		try {
			await check();
			return;
		} catch (error) {
			lastError = error;
			await sleep(stepMs);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const TeamSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const SettingSchema = Schema.Struct({
	id: Schema.String,
	value: Schema.String,
});

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

const AutoUserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 60_000);

type ControlledHost = NodeEngineStorageHost & {
	readonly writes: Array<{ readonly path: string; readonly data: string }>;
	readonly maxConcurrentWrites: () => number;
	readonly failNextWrite: (path: string, count?: number) => void;
	readonly setWriteDelay: (path: string, delayMs: number) => void;
};

function createControlledHost(root: string): ControlledHost {
	const base = createNodeEngineStorageHost();
	const writes: Array<{ path: string; data: string }> = [];
	const failures = new Map<string, number>();
	const delays = new Map<string, number>();
	let activeWrites = 0;
	let maxConcurrentWrites = 0;
	const wrapWrite = async (path: string, data: string, mode: "write" | "append") => {
		activeWrites += 1;
		maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
		try {
			const delay = delays.get(path) ?? 0;
			if (delay > 0) await sleep(delay);
			const remainingFailures = failures.get(path) ?? 0;
			if (remainingFailures > 0) {
				failures.set(path, remainingFailures - 1);
				throw new Error(`Injected durability failure for ${path}`);
			}
			if (mode === "write") {
				await base.write(path, data);
			} else {
				await base.append(path, data);
			}
			writes.push({ path, data });
		} finally {
			activeWrites -= 1;
		}
	};
	return {
		...base,
		write: (path, data) => wrapWrite(path, data, "write"),
		append: (path, data) => wrapWrite(path, data, "append"),
		writes,
		maxConcurrentWrites: () => maxConcurrentWrites,
		failNextWrite: (path, count = 1) => {
			failures.set(path, count);
		},
		setWriteDelay: (path, delayMs) => {
			delays.set(path, delayMs);
		},
	};
}

describe("@proseql/engine U8 fixes", () => {
	it("merges existing storage with initialData and lets initialData win for file, directory, and shared path", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-merge-"));
		try {
			await mkdir(join(root, "teams"), { recursive: true });
			await writeFile(
				join(root, "users.json"),
				JSON.stringify({ u1: { id: "u1", name: "disk-user" } }),
			);
			await writeFile(
				join(root, "teams", "t1.json"),
				JSON.stringify({ id: "t1", name: "disk-team" }),
			);
			await writeFile(
				join(root, "config.json"),
				JSON.stringify({ nested: { settings: { s1: { id: "s1", value: "disk-setting" } } } }),
			);
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file: join(root, "users.json"),
						relationships: {},
					},
					teams: {
						schema: TeamSchema,
						directory: join(root, "teams"),
						format: "json",
						relationships: {},
					},
					settings: {
						schema: SettingSchema,
						file: join(root, "config.json"),
						path: "nested.settings",
						relationships: {},
					},
				} as const,
				{
					users: [
						{ id: "u1", name: "seed-user" },
						{ id: "u2", name: "new-user" },
					],
					teams: [{ id: "t1", name: "seed-team" }],
					settings: [{ id: "s1", value: "seed-setting" }],
				},
			);
			expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "seed-user" });
			expect(await db.users.findById("u2")).toEqual({ id: "u2", name: "new-user" });
			expect(await db.teams.findById("t1")).toEqual({ id: "t1", name: "seed-team" });
			expect(await db.settings.findById("s1")).toEqual({ id: "s1", value: "seed-setting" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("seeds directory ids from current state so the first delete persists", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-dir-"));
		try {
			const db = await createPersistentEngineDatabase(
				{
					teams: {
						schema: TeamSchema,
						directory: join(root, "teams"),
						format: "json",
						relationships: {},
					},
				} as const,
				{ teams: [{ id: "t1", name: "Seed" }] },
				{ writeDebounce: 5 },
			);
			await db.flush();
			expect(await createNodeEngineStorageHost().exists(join(root, "teams", "t1.json"))).toBe(true);
			await db.teams.delete("t1");
			await db.flush();
			const reloaded = await createPersistentEngineDatabase(
				{
					teams: {
						schema: TeamSchema,
						directory: join(root, "teams"),
						format: "json",
						relationships: {},
					},
				} as const,
			);
			expect(await reloaded.teams.query()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("updates watched directory delete baselines after external adds so API deletes remove added files", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-dir-baseline-"));
		try {
			const teamsDir = join(root, "teams");
			await mkdir(teamsDir, { recursive: true });
			await writeFile(join(teamsDir, "t1.json"), JSON.stringify({ id: "t1", name: "Alpha" }));
			const db = await createPersistentEngineDatabase(
				{
					teams: {
						schema: TeamSchema,
						directory: teamsDir,
						format: "json",
						relationships: {},
					},
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			await writeFile(join(teamsDir, "t2.json"), JSON.stringify({ id: "t2", name: "Beta" }));
			await waitFor(async () => {
				expect(await db.teams.findById("t2")).toEqual({ id: "t2", name: "Beta" });
			});
			await db.teams.delete("t2");
			await db.flush();
			await expect(createNodeEngineStorageHost().read(join(teamsDir, "t2.json"))).rejects.toBeInstanceOf(Error);
			await db.close();
			const reopened = await createPersistentEngineDatabase(
				{
					teams: {
						schema: TeamSchema,
						directory: teamsDir,
						format: "json",
						relationships: {},
					},
				} as const,
			);
			expect(await reopened.teams.query()).toEqual([{ id: "t1", name: "Alpha" }]);
			await reopened.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("serializes shared-file persistence through one physical debounce lane and writes the latest state", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-shared-"));
		try {
			const sharedPath = join(root, "db.json");
			const host = createControlledHost(root);
			host.setWriteDelay(sharedPath, 50);
			const db = await createPersistentEngineDatabase(
				{
					authors: {
						schema: AuthorSchema,
						file: sharedPath,
						relationships: {},
					},
					books: {
						schema: BookSchema,
						file: sharedPath,
						relationships: {},
					},
				} as const,
				undefined,
				{
					writeDebounce: 5,
					storageHost: host,
					storageLayer: makeEngineStorageLayer(host),
				},
			);
			await db.authors.create({ id: "a1", name: "Frank Herbert" });
			await db.books.create({ id: "b1", title: "Dune", year: 1965 });
			await sleep(10);
			await db.books.update("b1", { year: { $increment: 1 } });
			await sleep(160);
			const stored = JSON.parse(await readFile(sharedPath, "utf8")) as Record<string, any>;
			expect(host.maxConcurrentWrites()).toBe(1);
			expect(stored.authors.a1.name).toBe("Frank Herbert");
			expect(stored.books.b1.year).toBe(1966);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains background durability errors until a successful retry and flush rejects durability failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-durability-"));
		try {
			const file = join(root, "users.json");
			const host = createControlledHost(root);
			host.failNextWrite(file, 2);
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file,
						relationships: {},
					},
				} as const,
				{ users: [{ id: "u1", name: "Alice" }] },
				{
					writeDebounce: 5,
					storageHost: host,
					storageLayer: makeEngineStorageLayer(host),
				},
			);
			await db.users.update("u1", { name: { $set: "Updated" } });
			await sleep(30);
			await expect(db.flush()).rejects.toBeInstanceOf(StorageError);
			await db.flush();
			expect(JSON.parse(await readFile(file, "utf8")).u1.name).toBe("Updated");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("commits transaction snapshots without replaying id generators or hooks", async () => {
		let generatedCount = 0;
		let beforeCreateCount = 0;
		const db = await createEngineDatabase(
			{
				users: {
					schema: AutoUserSchema,
					idGenerator: "tx-seq",
					relationships: {},
					hooks: {
						beforeCreate: [
							(ctx) =>
								Effect.sync(() => {
									beforeCreateCount += 1;
									return {
										...ctx.data,
										name: String(ctx.data.name).toUpperCase(),
									};
								}),
						],
					},
				},
			} as const,
			undefined,
			{
				plugins: [
					{
						name: "tx-plugin",
						idGenerators: [
							{
								name: "tx-seq",
								generate: () => `tx-${++generatedCount}`,
							},
						],
					},
				],
			},
		);
		const created = await db.$transaction(async (tx) =>
			tx.users.create({ name: "alice" } as any),
		);
		expect(created).toEqual({ id: "tx-1", name: "ALICE" });
		expect(await db.users.findById("tx-1")).toEqual(created);
		expect(generatedCount).toBe(1);
		expect(beforeCreateCount).toBe(1);
		await db.close();
	});

	it("provides Promise-first $transaction with read-own-writes and rollback on original errors", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		const name = await db.$transaction(async (tx) => {
			await tx.users.create({ id: "u2", name: "Bob" });
			const rows = await tx.users.query({ where: { id: "u2" } });
			expect(rows).toEqual([{ id: "u2", name: "Bob" }]);
			return rows[0]!.name;
		});
		expect(name).toBe("Bob");
		expect(await db.users.findById("u2")).toEqual({ id: "u2", name: "Bob" });
		await expect(
			db.$transaction(async (tx) => {
				await tx.users.create({ id: "u3", name: "Charlie" });
				await tx.users.create({ id: "u1", name: "Duplicate" });
			}),
		).rejects.toBeInstanceOf(DuplicateKeyError);
		await expect(db.users.findById("u3")).rejects.toBeInstanceOf(Error);
	});

	it("rejects overlapping $transaction calls immediately without losing committed state", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = db.$transaction(async (tx) => {
			await tx.users.update("u1", { name: { $set: "First" } });
			await firstBlocked;
			return tx.users.findById("u1");
		});
		await waitFor(async () => {
			expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Alice" });
		});
		const second = db.$transaction(async (tx) => {
			await tx.users.update("u1", { name: { $set: "Second" } });
			return tx.users.findById("u1");
		});
		await expect(second).rejects.toMatchObject({
			_tag: "TransactionError",
			operation: "begin",
			reason: "another transaction is already active",
		});
		releaseFirst();
		expect(await first).toEqual({ id: "u1", name: "First" });
		expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "First" });
		const after = await db.$transaction(async (tx) => tx.users.findById("u1"));
		expect(after).toEqual({ id: "u1", name: "First" });
	});

	it("rolls back nested $transaction attempts and releases the guard in finally", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			db.$transaction(async (tx) => {
				await tx.users.create({ id: "u2", name: "Bob" });
				await db.$transaction(async (inner) => inner.users.create({ id: "u3", name: "Charlie" }));
			}),
		).rejects.toMatchObject({
			_tag: "TransactionError",
			operation: "begin",
			reason: "nested transactions not supported",
		});
		await expect(db.users.findById("u2")).rejects.toBeInstanceOf(Error);
		await expect(db.users.findById("u3")).rejects.toBeInstanceOf(Error);
		const created = await db.$transaction(async (tx) => tx.users.create({ id: "u4", name: "Dana" }));
		expect(created).toEqual({ id: "u4", name: "Dana" });
		expect(await db.users.findById("u4")).toEqual(created);
	});

	it("surfaces invalid query failures as Promise rejections instead of synchronous throws", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			db.users.query({ cursor: { key: "id", limit: 1 }, sort: { name: "asc" } } as any),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(db.users.aggregate({ groupBy: ["missing"] } as any)).resolves.toBeTruthy();
	});

	it("reports real dry-run migration status for persistent files", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-dry-run-"));
		try {
			const currentFile = join(root, "users.json");
			const missingFile = join(root, "teams.json");
			await writeFile(currentFile, JSON.stringify({ _version: 1, u1: { id: "u1", name: "Alice" } }));
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file: currentFile,
						version: 1,
						migrations: [
							{ from: 0, to: 1, description: "noop", transform: (data) => data },
						],
						relationships: {},
					},
					teams: {
						schema: TeamSchema,
						file: missingFile,
						version: 2,
						migrations: [
							{ from: 0, to: 1, description: "step-1", transform: (data) => data },
							{ from: 1, to: 2, description: "step-2", transform: (data) => data },
						],
						relationships: {},
					},
				} as const,
			);
			expect(await db.$dryRunMigrations()).toEqual({
				collections: [
					{
						name: "users",
						filePath: currentFile,
						status: "up-to-date",
						currentVersion: 1,
						targetVersion: 1,
						migrationsToApply: [],
					},
					{
						name: "teams",
						filePath: missingFile,
						status: "no-file",
						currentVersion: 0,
						targetVersion: 2,
						migrationsToApply: [],
					},
				],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts source reload when the pre-reload flush fails and keeps the active runtime state", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-source-flush-"));
		try {
			const docsRoot = join(root, "docs");
			const basePath = join(docsRoot, "base.yaml");
			await mkdir(docsRoot, { recursive: true });
			await writeFile(basePath, "users:\n  u1:\n    id: u1\n    name: Disk\n");
			const host = createControlledHost(root);
			const db = await createPersistentEngineDatabase(
				{
					collections: {
						users: { schema: UserSchema, relationships: {} },
					},
					sources: [
						{
							id: "docs",
							kind: "documents",
							root: docsRoot,
							include: "**/*.yaml",
							format: "yaml",
							collections: ["users"],
							outbox: join(docsRoot, "generated.yaml"),
						},
					],
				} as const,
				undefined,
				{
					writeDebounce: 1000,
					storageHost: host,
					storageLayer: makeEngineStorageLayer(host),
				},
			);
			host.failNextWrite(basePath, 2);
			await db.users.update("u1", { name: { $set: "Local" } });
			await writeFile(basePath, "users:\n  u1:\n    id: u1\n    name: External\n");
			await sleep(250);
			expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Local" });
			await expect(db.flush()).rejects.toBeInstanceOf(StorageError);
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("prevents self-write watch loops by flushing only dirty lanes and skipping identical reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-self-loop-"));
		try {
			const file = join(root, "users.json");
			const host = createControlledHost(root);
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file,
						relationships: {},
					},
				} as const,
				{ users: [{ id: "u1", name: "Alice" }] },
				{
					writeDebounce: 5,
					storageHost: host,
					storageLayer: makeEngineStorageLayer(host),
				},
			);
			await db.flush();
			host.writes.length = 0;
			const watch = db.users.watch();
			await watch.next();
			await db.users.update("u1", { name: { $set: "Updated" } });
			await db.flush();
			await sleep(250);
			expect(host.writes.filter((entry) => entry.path === file)).toHaveLength(1);
			expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Updated" });
			await watch.unsubscribe();
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reloads legacy file and shared-file collections on external edits and emits watch updates", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-legacy-files-"));
		try {
			const usersFile = join(root, "users.json");
			const sharedFile = join(root, "shared.json");
			await writeFile(usersFile, JSON.stringify({ u1: { id: "u1", name: "Alice" } }));
			await writeFile(
				sharedFile,
				JSON.stringify({
					authors: { a1: { id: "a1", name: "Frank Herbert" } },
					books: { b1: { id: "b1", title: "Dune", year: 1965 } },
				}),
			);
			const db = await createPersistentEngineDatabase(
				{
					users: { schema: UserSchema, file: usersFile, relationships: {} },
					authors: { schema: AuthorSchema, file: sharedFile, relationships: {} },
					books: { schema: BookSchema, file: sharedFile, relationships: {} },
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			const userWatch = db.users.watch();
			const bookWatch = db.books.watch();
			await userWatch.next();
			await bookWatch.next();
			await writeFile(usersFile, JSON.stringify({ u1: { id: "u1", name: "Updated" } }));
			await waitFor(async () => {
				expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Updated" });
			});
			expect((await userWatch.next()).value?.[0]?.name).toBe("Updated");
			await writeFile(
				sharedFile,
				JSON.stringify({
					authors: { a1: { id: "a1", name: "Frank Herbert" } },
					books: { b1: { id: "b1", title: "Dune Messiah", year: 1969 } },
				}),
			);
			await waitFor(async () => {
				expect(await db.books.findById("b1")).toEqual({ id: "b1", title: "Dune Messiah", year: 1969 });
			});
			expect((await bookWatch.next()).value?.[0]?.title).toBe("Dune Messiah");
			await userWatch.unsubscribe();
			await bookWatch.unsubscribe();
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reloads legacy directories, preserves last known good on invalid edits, and cleans up watchers on close", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-legacy-dir-"));
		try {
			const teamsDir = join(root, "teams");
			await mkdir(teamsDir, { recursive: true });
			await writeFile(join(teamsDir, "t1.json"), JSON.stringify({ id: "t1", name: "Alpha" }));
			const db = await createPersistentEngineDatabase(
				{
					teams: {
						schema: TeamSchema,
						directory: teamsDir,
						format: "json",
						relationships: {},
					},
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			const watch = db.teams.watch();
			await watch.next();
			await writeFile(join(teamsDir, "t1.json"), JSON.stringify({ id: "t1", name: "Beta" }));
			await sleep(250);
			expect(await db.teams.findById("t1")).toEqual({ id: "t1", name: "Beta" });
			expect((await watch.next()).value?.[0]?.name).toBe("Beta");
			await writeFile(join(teamsDir, "t1.json"), "{ bad json");
			await sleep(250);
			expect(await db.teams.findById("t1")).toEqual({ id: "t1", name: "Beta" });
			let invalidReloadDelivered = false;
			const nextEmission = watch.next().then((value) => {
				invalidReloadDelivered = true;
				return value;
			});
			await sleep(100);
			expect(invalidReloadDelivered).toBe(false);
			await expect(db.flush()).resolves.toBeUndefined();
			await writeFile(join(teamsDir, "t1.json"), JSON.stringify({ id: "t1", name: "Gamma" }));
			await sleep(250);
			expect(await db.teams.findById("t1")).toEqual({ id: "t1", name: "Gamma" });
			expect((await nextEmission).value?.[0]?.name).toBe("Gamma");
			await db.close();
			await writeFile(join(teamsDir, "t1.json"), JSON.stringify({ id: "t1", name: "Delta" }));
			await sleep(250);
			const raced = await Promise.race([
				watch.next(),
				sleep(100).then(() => ({ done: true } as IteratorResult<ReadonlyArray<{ id: string; name: string }>>)),
			]);
			expect(raced.done).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("supports document sources writeback/outbox and documentGraph read-only metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-sources-"));
		try {
			const docsRoot = join(root, "docs");
			const graphA = join(root, "graph-a");
			const graphB = join(root, "graph-b");
			await mkdir(docsRoot, { recursive: true });
			await mkdir(graphA, { recursive: true });
			await mkdir(graphB, { recursive: true });
			await writeFile(
				join(docsRoot, "base.yaml"),
				"users:\n  u1:\n    id: u1\n    name: Disk\n",
			);
			await writeFile(
				join(graphA, "base.yaml"),
				"books:\n  b1:\n    id: b1\n    title: Base\n    year: 1965\n",
			);
			await writeFile(
				join(graphB, "overlay.yaml"),
				"books:\n  b1:\n    id: b1\n    title: Overlay\n    year: 1966\n",
			);
			const db = await createPersistentEngineDatabase(
				{
					collections: {
						users: { schema: UserSchema, relationships: {} },
						posts: {
							schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
							relationships: {},
						},
						books: { schema: BookSchema, relationships: {} },
					},
					sources: [
						{
							id: "docs",
							kind: "documents",
							root: docsRoot,
							include: "**/*.yaml",
							format: "yaml",
							collections: ["users", "posts"],
							outbox: join(docsRoot, "generated.yaml"),
						},
						{
							id: "graph",
							kind: "documentGraph",
							collections: ["books"],
							include: "**/*.yaml",
							roots: [{ root: graphA }, { root: graphB }],
						},
					],
				} as const,
				{ users: [{ id: "u1", name: "Seed" }] },
				{ writeDebounce: 5 },
			);
			await db.users.update("u1", { name: { $set: "Updated" } });
			await db.posts.create({ id: "p1", title: "Post" });
			await db.flush();
			expect(await readFile(join(docsRoot, "base.yaml"), "utf8")).toContain("name: Updated");
			expect(await readFile(join(docsRoot, "generated.yaml"), "utf8")).toContain("posts:");
			expect(await readFile(join(docsRoot, "generated.yaml"), "utf8")).toContain("p1:");
			expect(await db.books.findById("b1")).toEqual({ id: "b1", title: "Overlay", year: 1966 });
			expect(await db.$documentGraph.getRecordProvenance("books", "b1")).toBeTruthy();
			await expect(db.books.create({ id: "b2", title: "Nope", year: 2000 })).rejects.toBeInstanceOf(
				OperationError,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("publishes declarations through core root exports and compiles in an exports-aware consumer", async () => {
		execFileSync("bunx", ["tsc", "--build", "packages/core", "packages/engine"], {
			cwd: WORKTREE_ROOT,
			stdio: "inherit",
		});
		const distTypes = await readFile(join(WORKTREE_ROOT, "packages/engine/dist/types.d.ts"), "utf8");
		expect(distTypes.includes("@proseql/core/")).toBe(false);
		const consumerRoot = await mkdtemp(join(WORKTREE_ROOT, ".tmp-engine-consumer-"));
		try {
			await mkdir(join(consumerRoot, "node_modules", "@proseql"), { recursive: true });
			await symlink(join(WORKTREE_ROOT, "packages/core"), join(consumerRoot, "node_modules", "@proseql", "core"));
			await symlink(join(WORKTREE_ROOT, "packages/engine"), join(consumerRoot, "node_modules", "@proseql", "engine"));
			await writeFile(
				join(consumerRoot, "tsconfig.json"),
				JSON.stringify(
					{
						compilerOptions: {
							target: "ES2022",
							module: "ESNext",
							moduleResolution: "Bundler",
							strict: true,
							noEmit: true,
							skipLibCheck: true,
						},
					},
					null,
					2,
				),
			);
			await writeFile(
				join(consumerRoot, "index.ts"),
				[
					'import * as Schema from "effect/Schema";',
					'import { createEngineDatabase, type GenerateEngineDatabase } from "@proseql/engine";',
					"const config = { users: { schema: Schema.Struct({ id: Schema.String, name: Schema.String }), relationships: {} } } as const;",
					"type Db = GenerateEngineDatabase<typeof config>;",
					"declare const db: Db;",
					"void db.users.query();",
					"void createEngineDatabase(config);",
				].join("\n"),
			);
			execFileSync("bunx", ["tsc", "--project", "tsconfig.json"], {
				cwd: consumerRoot,
				stdio: "inherit",
			});
		} finally {
			await rm(consumerRoot, { recursive: true, force: true });
		}
	});

	it("initializes plugins exactly once for persistent databases and exposes async hook suspension as a typed error", async () => {
		let initializeCount = 0;
		const plugin = {
			name: "count-init",
			initialize: () => Effect.sync(() => {
				initializeCount += 1;
			}),
		} as const;
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-plugin-"));
		try {
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: Schema.Struct({
							id: Schema.String,
							name: Schema.String,
							role: Schema.Literal("admin", "user"),
							marker: Schema.Null,
						}),
						file: join(root, "users.json"),
						relationships: {},
						hooks: {
							beforeCreate: [
								(ctx) =>
									Effect.promise(async () => ({
										...ctx.data,
										name: String(ctx.data.name).toUpperCase(),
									})),
							],
						},
					},
				} as const,
				undefined,
				undefined,
				{ plugins: [plugin] },
			);
			expect(initializeCount).toBe(1);
			await db.flush();
			expect(initializeCount).toBe(1);
			await expect(
				db.users.create({ id: "u1", name: "Alice", role: "guest", marker: null } as any),
			).rejects.toBeInstanceOf(ValidationError);
			await expect(
				db.users.create({ id: "u2", name: "Alice", role: "admin", marker: "x" } as any),
			).rejects.toBeInstanceOf(ValidationError);
			await expect(
				db.users.create({ id: "u3", name: "Alice", role: "admin", marker: null }),
			).rejects.toBeInstanceOf(HookError);
			const literalDb = await createEngineDatabase({
				users: {
					schema: Schema.Struct({
						id: Schema.String,
						name: Schema.String,
						role: Schema.Literal("admin", "user"),
						marker: Schema.Null,
					}),
					relationships: {},
				},
			} as const);
			expect(
				await literalDb.users.create({ id: "u4", name: "Carol", role: "admin", marker: null }),
			).toEqual({ id: "u4", name: "Carol", role: "admin", marker: null });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
