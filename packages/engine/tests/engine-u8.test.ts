import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DuplicateKeyError,
	HookError,
	OperationError,
	SerializationError,
	StorageError,
	TransactionError,
	ValidationError,
} from "@proseql/core";
import { Effect, Ref, Stream } from "effect";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import { applyPagination } from "../../core/src/operations/query/paginate-stream.js";
import { sortData } from "../../core/src/operations/query/sort.js";
import { applyPopulate } from "../../core/src/operations/relationships/populate-stream.js";
import { decodeBoundaryValueForHost } from "../src/boundary-values.js";
import { reconstructBoundaryError } from "../src/errors.js";
import {
	createEngineDatabase,
	createNodeEngineStorageHost,
	createPersistentEngineDatabase,
	makeEngineStorageLayer,
	type NodeEngineStorageHost,
	WasmEngineDefectError,
} from "../src/index.js";

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
	check: () => Promise<void> | void,
	timeoutMs = 1000,
	stepMs = 25,
) {
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

const createPromiseWrapperDatabase = async () => {
	let customOperatorCalls = 0;
	let computedCalls = 0;
	const db = await createEngineDatabase(
		{
			users: {
				schema: UserSchema,
				relationships: {},
				computed: {
					displayName: (user: unknown) => {
						computedCalls += 1;
						if (
							typeof user === "object" &&
							user !== null &&
							"name" in user &&
							typeof (user as { readonly name?: unknown }).name === "string"
						) {
							return `${(user as { readonly name: string }).name}!`;
						}
						return "unknown!";
					},
				},
			},
		} as const,
		{ users: [{ id: "u1", name: "Alice" }] },
		{
			plugins: [
				{
					name: "promise-wrapper-plugin",
					operators: [
						{
							name: "$wrapperStartsWith",
							types: ["string"] as const,
							evaluate: (fieldValue: unknown, operand: unknown) => {
								customOperatorCalls += 1;
								return (
									typeof fieldValue === "string" &&
									typeof operand === "string" &&
									fieldValue.startsWith(operand)
								);
							},
						},
					],
				},
			],
		},
	);
	return {
		db,
		getCounts: () => ({ customOperatorCalls, computedCalls }),
	};
};

type PublicWasmRuntime = {
	register_default(id: string, callback: () => unknown): void;
	register_predicate(
		id: string,
		callback: (payloadJson: string) => unknown,
	): void;
	register_computed(
		id: string,
		callback: (payloadJson: string) => unknown,
	): void;
	register_collator(callback: (left: string, right: string) => unknown): void;
	register_id_generator(name: string, callback: () => unknown): void;
	register_custom_operator(
		name: string,
		supportedTypesJson: string,
		callback: (fieldJson: string, operandJson: string) => unknown,
	): string;
	create_database(inputJson: string): string;
	dispatch(handle: number, method: string, payloadJson?: string): string;
};

type PublicWasmRuntimeModule = {
	readonly WasmRuntime: new (
		setTimeoutFn: typeof globalThis.setTimeout,
		clearTimeoutFn: typeof globalThis.clearTimeout,
	) => PublicWasmRuntime;
};

type RawBridgeOk<T> = { readonly kind: "ok"; readonly value: T };

type RawBridgeError = { readonly kind: "error"; readonly error: unknown };

type RawBridgeDefect = { readonly kind: "defect"; readonly message: string };

type RawBridgeResponse<T> = RawBridgeOk<T> | RawBridgeError | RawBridgeDefect;

const loadPublicWasmRuntimeModule =
	async (): Promise<PublicWasmRuntimeModule> =>
		(await import(
			`${pathToFileURL(resolve(WORKTREE_ROOT, "packages/engine/dist/wasm/proseql_wasm.js")).href}?t=${Date.now()}`
		)) as PublicWasmRuntimeModule;

const parsePublicWasmResponse = <T>(raw: string): T => {
	const parsed = JSON.parse(raw) as RawBridgeResponse<T>;
	switch (parsed.kind) {
		case "ok":
			return decodeBoundaryValueForHost(parsed.value);
		case "error":
			throw reconstructBoundaryError(decodeBoundaryValueForHost(parsed.error));
		case "defect":
			throw new WasmEngineDefectError(parsed.message);
		default:
			throw new Error(`Unknown public WASM bridge response: ${raw}`);
	}
};

const runPublicWasm = <T>(fn: () => string): Promise<T> =>
	Promise.resolve().then(() => parsePublicWasmResponse<T>(fn()));

const createPublicWasmRuntime = async () => {
	const wasmModule = await loadPublicWasmRuntimeModule();
	return new wasmModule.WasmRuntime(
		globalThis.setTimeout,
		globalThis.clearTimeout,
	);
};

const createRawCollectionDescriptor = (options: {
	readonly schema: Record<string, unknown>;
	readonly idStrategy?:
		| { readonly kind: "provided" }
		| { readonly kind: "namedGenerator"; readonly name: string };
	readonly computedFields?: ReadonlyArray<{
		readonly name: string;
		readonly callback_id: string;
	}>;
}) => ({
	name: "users",
	schema: options.schema,
	id_strategy: options.idStrategy ?? { kind: "provided" },
	relationships: [],
	indexes: [],
	unique_fields: [],
	before_create_hooks: [],
	after_create_hooks: [],
	before_update_hooks: [],
	after_update_hooks: [],
	before_delete_hooks: [],
	after_delete_hooks: [],
	on_change_hooks: [],
	computed_fields: options.computedFields ?? [],
	search_index: [],
	migrations: [],
	append_only: false,
	validation_mode: "strict",
});

const createRawDatabase = (
	runtime: PublicWasmRuntime,
	collection: ReturnType<typeof createRawCollectionDescriptor>,
	initialCollections: Record<string, unknown> = {},
): Promise<number> =>
	runPublicWasm(() =>
		runtime.create_database(
			JSON.stringify({
				descriptor: { collections: [collection], sources: [] },
				initialCollections,
			}),
		),
	);

const dispatchRaw = <T>(
	runtime: PublicWasmRuntime,
	handle: number,
	method: string,
	payload: Record<string, unknown>,
): Promise<T> =>
	runPublicWasm(() =>
		runtime.dispatch(handle, method, JSON.stringify(payload)),
	);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 120_000);

type ControlledHost = NodeEngineStorageHost & {
	readonly writes: Array<{ readonly path: string; readonly data: string }>;
	readonly maxConcurrentWrites: () => number;
	readonly failNextWrite: (path: string, count?: number) => void;
	readonly setWriteDelay: (path: string, delayMs: number) => void;
};

type TriggerableFileWatchHost = ControlledHost & {
	readonly watchCallbackFor: (path: string) => (() => void) | undefined;
	readonly blockNextRead: (path: string) => {
		readonly started: Promise<void>;
		readonly release: () => void;
	};
	readonly readCountFor: (path: string) => number;
};

function createControlledHost(root: string): ControlledHost {
	const base = createNodeEngineStorageHost();
	const writes: Array<{ path: string; data: string }> = [];
	const failures = new Map<string, number>();
	const delays = new Map<string, number>();
	let activeWrites = 0;
	let maxConcurrentWrites = 0;
	const wrapWrite = async (
		path: string,
		data: string,
		mode: "write" | "append",
	) => {
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

function createTriggerableFileWatchHost(
	root: string,
): TriggerableFileWatchHost {
	const base = createControlledHost(root);
	const watchCallbacks = new Map<string, () => void>();
	const readCounts = new Map<string, number>();
	const blockedReads = new Map<
		string,
		{
			readonly started: Promise<void>;
			readonly release: () => void;
			resolveStarted: () => void;
			waitForRelease: Promise<void>;
		}
	>();
	return {
		...base,
		read: async (path) => {
			readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
			const blocked = blockedReads.get(path);
			if (blocked) {
				blocked.resolveStarted();
				blockedReads.delete(path);
				await blocked.waitForRelease;
			}
			return base.read(path);
		},
		watch: async (path, onChange) => {
			watchCallbacks.set(path, onChange);
			return () => {
				if (watchCallbacks.get(path) === onChange) {
					watchCallbacks.delete(path);
				}
			};
		},
		watchCallbackFor: (path) => watchCallbacks.get(path),
		blockNextRead: (path) => {
			let resolveStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				resolveStarted = resolve;
			});
			let release!: () => void;
			const waitForRelease = new Promise<void>((resolve) => {
				release = resolve;
			});
			blockedReads.set(path, {
				started,
				release,
				resolveStarted,
				waitForRelease,
			});
			return { started, release };
		},
		readCountFor: (path) => readCounts.get(path) ?? 0,
	};
}

describe("@proseql/engine U8 fixes", () => {
	it("materializes every read from Rust-authored handles with stable revision-safe identity", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "Alice" },
					{ id: "u2", name: "Bob" },
				],
			},
		);
		try {
			const first = await db.users.findById("u1");
			const repeated = await db.users.findById("u1");
			await expect(db.users.findById("missing")).rejects.toMatchObject({
				_tag: "NotFoundError",
				id: "missing",
			});
			const ordered = await db.users.query({ sort: { id: "desc" } });
			expect(repeated).toBe(first);
			expect(ordered.map((row) => row.id)).toEqual(["u2", "u1"]);
			expect(ordered[1]).toBe(first);
			(first as { name: string }).name = "Caller mutation";
			expect((await db.users.findById("u1")).name).toBe("Caller mutation");

			const updated = await db.users.update("u1", { name: "Updated" });
			const afterUpdate = await db.users.findById("u1");
			expect(afterUpdate).not.toBe(first);
			expect(afterUpdate).toBe(updated);

			await db.users.delete("u1");
			await db.users.create({ id: "u1", name: "Recreated" });
			const recreated = await db.users.findById("u1");
			expect(recreated).not.toBe(first);
			expect(recreated).not.toBe(afterUpdate);
			expect(recreated.name).toBe("Recreated");
			const diagnostics = (
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => {
						cacheHits: number;
						descriptorBytes: number;
						compactDescriptors: number;
						fastFindHits: number;
						fastFindFallbacks: number;
					};
				}
			).__proseqlMaterializationDiagnostics();
			expect(diagnostics.cacheHits).toBeGreaterThan(0);
			expect(diagnostics.descriptorBytes).toBeGreaterThan(0);
			expect(diagnostics.compactDescriptors).toBeGreaterThan(0);
			expect(diagnostics.fastFindHits).toBeGreaterThan(0);
			expect(diagnostics.fastFindFallbacks).toBeGreaterThan(0);
			expect(Object.keys(db)).not.toContain(
				"__proseqlMaterializationDiagnostics",
			);
		} finally {
			await db.close();
		}
	});

	it("authorizes contiguous queries while preserving fresh arrays and stable row identity", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "Alice" },
					{ id: "u2", name: "Bob" },
				],
			},
		);
		try {
			const first = await db.users.query();
			const second = await db.users.query();
			expect(second).not.toBe(first);
			expect(second[0]).toBe(first[0]);
			first.pop();
			expect((await db.users.query()).map((row) => row.id)).toEqual([
				"u1",
				"u2",
			]);

			(first[0] as { name: string }).name = "Caller";
			expect((await db.users.query({ offset: 0, limit: 1 }))[0]).toBe(first[0]);
			await db.users.create({ id: "u3", name: "Cara" });
			expect((await db.users.query()).map((row) => row.id)).toEqual([
				"u1",
				"u2",
				"u3",
			]);
		} finally {
			await db.close();
		}
	});

	it("materializes nested dangerous JSON keys as ordinary own data properties", async () => {
		const DangerousSchema = Schema.Struct({
			id: Schema.String,
			payload: Schema.Unknown,
		});
		const payload = JSON.parse(
			'{"__proto__":{"constructor":{"prototype":{"polluted":true}}},"constructor":"own-constructor","prototype":{"__proto__":"nested"}}',
		) as Record<string, unknown>;
		const db = await createEngineDatabase(
			{ rows: { schema: DangerousSchema, relationships: {} } } as const,
			{ rows: [{ id: "r1", payload }] },
		);
		try {
			const row = await db.rows.findById("r1");
			const actual = row.payload as Record<string, unknown>;
			for (const key of ["__proto__", "constructor", "prototype"]) {
				expect(Object.hasOwn(actual, key)).toBe(true);
				const descriptor = Object.getOwnPropertyDescriptor(actual, key);
				expect(descriptor).toMatchObject({
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			const nested = actual.__proto__ as Record<string, unknown>;
			expect(Object.hasOwn(nested, "constructor")).toBe(true);
			const constructorValue = nested.constructor as Record<string, unknown>;
			expect(Object.hasOwn(constructorValue, "prototype")).toBe(true);
			expect(
				(constructorValue.prototype as Record<string, unknown>).polluted,
			).toBe(true);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	it("preserves scalar locale comparator traces and the first throwing comparison", async () => {
		const LocaleTraceSchema = Schema.Struct({
			id: Schema.String,
			label: Schema.String,
			group: Schema.Number,
		});
		const rows = [
			{ id: "r1", label: "b", group: 1 },
			{ id: "r2", label: "a", group: 1 },
			{ id: "r3", label: "c", group: 1 },
			{ id: "r4", label: "A", group: 2 },
			{ id: "r5", label: "ä", group: 2 },
			{ id: "r6", label: "aa", group: 2 },
			{ id: "r7", label: "a", group: 3 },
		];
		const originalLocaleCompare = String.prototype.localeCompare;
		let trace: string[] = [];
		let call = 0;
		let throwPair: string | undefined;
		Object.defineProperty(String.prototype, "localeCompare", {
			configurable: true,
			writable: true,
			value(this: string, other: string) {
				call += 1;
				const pair = `${this}:${other}`;
				trace.push(pair);
				if (pair === throwPair) throw new Error(`locale-pair-${pair}`);
				const ordinary = originalLocaleCompare.call(this, other);
				return call % 2 === 0 ? ordinary : -ordinary;
			},
		});
		try {
			for (const size of [2, 3, rows.length]) {
				const input = rows.slice(0, size);
				const db = await createEngineDatabase(
					{ rows: { schema: LocaleTraceSchema, relationships: {} } } as const,
					{ rows: input },
				);
				try {
					let expectedTrace: string[] = [];
					for (let attempt = 0; attempt < 4; attempt += 1) {
						trace = [];
						call = 0;
						const expected = sortData([...input], { label: "asc" });
						expectedTrace = [...trace];
						trace = [];
						call = 0;
						const actual = await db.rows.query({ sort: { label: "asc" } });
						expect(trace, `comparison trace attempt ${attempt + 1}`).toEqual(
							expectedTrace,
						);
						expect(actual.map((row) => row.id)).toEqual(
							expected.map((row) => row.id),
						);
					}

					// Throw by comparison identity, not call number, after repeated sorts.
					throwPair = expectedTrace[Math.min(1, expectedTrace.length - 1)];
					trace = [];
					call = 0;
					expect(() => sortData([...input], { label: "asc" })).toThrow(
						`locale-pair-${throwPair}`,
					);
					const repeatedFailureTrace = [...trace];
					trace = [];
					call = 0;
					await expect(
						db.rows.query({ sort: { label: "asc" } }),
					).rejects.toBeInstanceOf(WasmEngineDefectError);
					expect(trace).toEqual(repeatedFailureTrace);
					throwPair = undefined;
				} finally {
					await db.close();
				}
			}

			const db = await createEngineDatabase(
				{ rows: { schema: LocaleTraceSchema, relationships: {} } } as const,
				{ rows },
			);
			try {
				trace = [];
				call = 0;
				[...rows].sort((left, right) => left.label.localeCompare(right.label));
				throwPair = trace[1] ?? trace[0];
				trace = [];
				call = 0;
				expect(() =>
					[...rows].sort((left, right) =>
						left.label.localeCompare(right.label),
					),
				).toThrow(`locale-pair-${throwPair}`);
				const expectedTrace = [...trace];
				trace = [];
				call = 0;
				await expect(
					db.rows.query({
						sort: { label: "asc" },
						select: ["id", "label"],
					}),
				).rejects.toBeInstanceOf(WasmEngineDefectError);
				expect(trace).toEqual(expectedTrace);
				throwPair = undefined;
			} finally {
				await db.close();
			}
		} finally {
			Object.defineProperty(String.prototype, "localeCompare", {
				configurable: true,
				writable: true,
				value: originalLocaleCompare,
			});
		}
	});

	it("keeps mixed-field sorted full and selected projections in canonical order", async () => {
		const MixedSortSchema = Schema.Struct({
			id: Schema.String,
			label: Schema.optional(Schema.Unknown),
			age: Schema.Number,
		});
		const input = [
			{ id: "r1", label: "2", age: 3 },
			{ id: "r2", label: 10, age: 1 },
			{ id: "r3", label: "2", age: 1 },
			{ id: "r4", label: 2, age: 2 },
			{ id: "r5", label: null, age: 9 },
			{ id: "r6", age: 8 },
			{ id: "r7", label: true, age: 4 },
			{ id: "r8", label: [2], age: 5 },
		];
		const db = await createEngineDatabase(
			{ rows: { schema: MixedSortSchema, relationships: {} } } as const,
			{ rows: input },
		);
		try {
			const sort = { label: "asc", age: "desc" } as const;
			const expected = sortData([...input], sort).map((row) => row.id);
			const full = await db.rows.query({ sort });
			const selected = await db.rows.query({ sort, select: ["id", "label"] });
			expect(full.map((row) => row.id)).toEqual(expected);
			expect(selected.map((row) => row.id)).toEqual(full.map((row) => row.id));
			expect(selected).toEqual(
				full.map((row) =>
					"label" in row ? { id: row.id, label: row.label } : { id: row.id },
				),
			);
		} finally {
			await db.close();
		}
	});

	it("caches locale ordering while keeping query shells, row identity, and invalidation exact", async () => {
		const LocaleRowSchema = Schema.Struct({
			id: Schema.String,
			label: Schema.optional(Schema.NullOr(Schema.String)),
			age: Schema.Number,
		});
		const initial = [
			{ id: "r1", label: "ä", age: 2 },
			{ id: "r2", label: "a", age: 1 },
			{ id: "r3", label: "A", age: 3 },
			{ id: "r4", label: null, age: 4 },
			{ id: "r5", age: 5 },
		];
		const db = await createEngineDatabase(
			{ rows: { schema: LocaleRowSchema, relationships: {} } } as const,
			{ rows: initial },
		);
		try {
			const expected = [...initial]
				.sort((left, right) => {
					if (left.label == null && right.label == null) return 0;
					if (left.label == null) return 1;
					if (right.label == null) return -1;
					return left.label.localeCompare(right.label);
				})
				.map((row) => row.id);
			const first = await db.rows.query({ sort: { label: "asc" } });
			const second = await db.rows.query({ sort: { label: "asc" } });
			expect(first.map((row) => row.id)).toEqual(expected);
			expect(second).not.toBe(first);
			expect(second.every((row, index) => row === first[index])).toBe(true);
			first.reverse();
			expect(
				(await db.rows.query({ sort: { label: "asc" } })).map((row) => row.id),
			).toEqual(expected);

			const mutable = second.find((row) => row.id === "r2");
			if (mutable === undefined) throw new Error("missing locale row");
			mutable.label = "zzzz";
			expect((await db.rows.query({ sort: { label: "asc" } })).at(-3)).toBe(
				mutable,
			);

			await db.$transaction(async (tx) => {
				await tx.rows.update("r3", { label: "000" });
			});
			expect((await db.rows.query({ sort: { label: "asc" } }))[0]?.id).toBe(
				"r3",
			);
		} finally {
			await db.close();
		}
	});

	it("packs primitive selections and keeps stale-index mutable-reference semantics", async () => {
		const IndexedUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			role: Schema.String,
			note: Schema.optional(Schema.NullOr(Schema.String)),
		});
		const db = await createEngineDatabase(
			{
				users: {
					schema: IndexedUserSchema,
					indexes: ["role"],
					relationships: {},
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "雪🚀", age: -0, role: "admin" },
					{ id: "u2", name: "Bob", age: 2, role: "user", note: null },
				],
			},
		);
		try {
			// The first read materializes the sparse row; the second establishes
			// the same-turn authorized indexed-result cache.
			await db.users.query({ where: { role: "admin" } });
			const firstAdminRows = await db.users.query({ where: { role: "admin" } });
			firstAdminRows.push({
				id: "poison",
				name: "Poison",
				age: 99,
				role: "admin",
			});
			firstAdminRows.splice(0, 1);
			firstAdminRows.reverse();
			firstAdminRows.length = 0;
			const secondAdminRows = await db.users.query({
				where: { role: "admin" },
			});
			expect(secondAdminRows).not.toBe(firstAdminRows);
			expect(secondAdminRows.map((row) => row.id)).toEqual(["u1"]);

			const selected = await db.users.query({ select: ["id", "name", "age"] });
			const firstSelected = selected[0];
			expect(firstSelected).toBeDefined();
			if (firstSelected === undefined) throw new Error("missing selected row");
			expect(Object.keys(firstSelected)).toEqual(["id", "name", "age"]);
			expect(firstSelected.name).toBe("雪🚀");
			expect(Object.is(firstSelected.age, -0)).toBe(true);
			firstSelected.name = "caller-poison";
			const selectedAgain = await db.users.query({
				select: ["id", "name", "age"],
			});
			expect(selectedAgain).not.toBe(selected);
			expect(selectedAgain[0]).not.toBe(firstSelected);
			expect(selectedAgain[0]?.name).toBe("雪🚀");
			const optional = await db.users.query({ select: ["id", "note"] });
			expect(optional).toEqual([{ id: "u1" }, { id: "u2", note: null }]);

			const admin = await db.users.query({ where: { role: "admin" } });
			(admin[0] as { role: string }).role = "user";
			expect(await db.users.query({ where: { role: "admin" } })).toEqual([]);
			expect(
				(await db.users.query({ where: { role: "user" } })).map(
					(row) => row.id,
				),
			).toEqual(["u2"]);
		} finally {
			await db.close();
		}
	});

	it("decodes homogeneous boolean primitive columns and falls back for mixed optional values", async () => {
		const BooleanSchema = Schema.Struct({
			id: Schema.String,
			enabled: Schema.Boolean,
			mixed: Schema.optional(Schema.NullOr(Schema.Boolean)),
		});
		const db = await createEngineDatabase(
			{ flags: { schema: BooleanSchema, relationships: {} } } as const,
			{
				flags: [
					{ id: "f1", enabled: false, mixed: true },
					{ id: "f2", enabled: true, mixed: null },
					{ id: "f3", enabled: false },
					{ id: "f4", enabled: true, mixed: undefined },
				],
			},
		);
		try {
			expect(await db.flags.query({ select: ["id", "enabled"] })).toEqual([
				{ id: "f1", enabled: false },
				{ id: "f2", enabled: true },
				{ id: "f3", enabled: false },
				{ id: "f4", enabled: true },
			]);
			expect(await db.flags.query({ select: ["id", "mixed"] })).toEqual([
				{ id: "f1", mixed: true },
				{ id: "f2", mixed: null },
				{ id: "f3" },
				{ id: "f4", mixed: undefined },
			]);
			expect(
				await db.flags.query({ select: { enabled: true } } as never),
			).toEqual([
				{ enabled: false },
				{ enabled: true },
				{ enabled: false },
				{ enabled: true },
			]);
		} finally {
			await db.close();
		}
	});

	it("filters every condition not covered by an exact equality posting", async () => {
		const IndexedSchema = Schema.Struct({
			id: Schema.String,
			role: Schema.String,
			team: Schema.String,
			score: Schema.Number,
		});
		const db = await createEngineDatabase(
			{
				users: {
					schema: IndexedSchema,
					indexes: ["role", ["role", "team"]],
					relationships: {},
				},
			} as const,
			{
				users: [
					{ id: "u1", role: "admin", team: "a", score: 1 },
					{ id: "u2", role: "admin", team: "b", score: 5 },
					{ id: "u3", role: "user", team: "a", score: 9 },
				],
			},
		);
		try {
			expect(
				(
					await db.users.query({
						where: { role: "admin", score: { $gt: 2 } },
					})
				).map((row) => row.id),
			).toEqual(["u2"]);
			expect(
				(
					await db.users.query({
						where: { role: "admin", team: "a" },
					})
				).map((row) => row.id),
			).toEqual(["u1"]);
			expect(
				(
					await db.users.query({
						where: { role: "admin", team: "a", score: { $gt: 2 } },
					})
				).map((row) => row.id),
			).toEqual([]);

			const escaped = await db.users.findById("u1");
			if (escaped === null) throw new Error("missing indexed row");
			(escaped as { role: string }).role = "user";
			expect(
				(await db.users.query({ where: { role: "admin" } })).map(
					(row) => row.id,
				),
			).toEqual(["u2"]);
		} finally {
			await db.close();
		}
	});

	it("normalizes offset and limit exactly like the direct TypeScript stream", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u0", name: "Zero" },
					{ id: "u1", name: "One" },
					{ id: "u2", name: "Two" },
					{ id: "u3", name: "Three" },
				],
			},
		);
		const ids = async (offset: unknown, limit: unknown, slowPath = false) =>
			(
				await db.users.query({
					offset,
					limit,
					...(slowPath ? { sort: { id: "asc" } } : {}),
				} as never)
			).map((row) => row.id);
		const scenarios: ReadonlyArray<readonly [unknown, unknown]> = [
			[-2, undefined],
			[1.8, 1.8],
			[Number.NaN, Number.NaN],
			[Number.POSITIVE_INFINITY, undefined],
			[0, Number.POSITIVE_INFINITY],
			["2", "2"],
			["bad", "bad"],
			[null, null],
		];
		try {
			for (const [offset, limit] of scenarios) {
				const direct = Array.from(
					await Effect.runPromise(
						Stream.runCollect(
							applyPagination(
								offset as number,
								limit as number,
							)(Stream.fromIterable(["u0", "u1", "u2", "u3"])),
						),
					),
				);
				expect(await ids(offset, limit)).toEqual(direct);
				expect(await ids(offset, limit, true)).toEqual(direct);
			}
		} finally {
			await db.close();
		}
	});

	it("uses canonical boundary encoding before native query exports", async () => {
		const BoundarySchema = Schema.Struct({
			id: Schema.String,
			value: Schema.Number,
			role: Schema.optional(Schema.String),
			sentinel: Schema.Struct({ __proseqlArrayHole__: Schema.Number }),
		});
		const db = await createEngineDatabase(
			{ rows: { schema: BoundarySchema, relationships: {} } } as const,
			{
				rows: [
					{
						id: "r1",
						value: -0,
						role: undefined,
						sentinel: { __proseqlArrayHole__: 1 },
					},
					{
						id: "r2",
						value: 1,
						role: "admin",
						sentinel: { __proseqlArrayHole__: 2 },
					},
				],
			},
		);
		try {
			expect(
				(await db.rows.query({ where: { value: -0 } })).map((row) => row.id),
			).toEqual(["r1"]);
			expect(
				(
					await db.rows.query({
						where: { sentinel: { __proseqlArrayHole__: 1 } },
					} as never)
				).map((row) => row.id),
			).toEqual(["r1"]);
			expect(
				(await db.rows.query({ where: { role: undefined } } as never)).map(
					(row) => row.id,
				),
			).toEqual(["r1"]);
			const sparse = new Array<unknown>(2);
			sparse[1] = "admin";
			expect(
				(
					await db.rows.query({
						where: { role: { $in: sparse } },
					} as never)
				).map((row) => row.id),
			).toEqual(["r2"]);
		} finally {
			await db.close();
		}
	});

	it("materializes returned batch mutation rows without projecting unreturned rows", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const created = await db.users.createMany([
				{ id: "u2", name: "Bob" },
				{ id: "u3", name: "Cara" },
			]);
			expect(await db.users.findById("u2")).toBe(created.created[0]);
			const updated = await db.users.updateMany(
				{ name: "Bob" },
				{ name: "Updated" },
			);
			expect(await db.users.findById("u2")).toBe(updated.updated[0]);
			const diagnostics = (
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => {
						peakMaterializedRows: number;
					};
				}
			).__proseqlMaterializationDiagnostics();
			expect(diagnostics.peakMaterializedRows).toBeLessThanOrEqual(3);
		} finally {
			await db.close();
		}
	});

	it("falls back from compact createMany when decoding coerces values", async () => {
		const DecodedSchema = Schema.Struct({
			id: Schema.String,
			amount: Schema.NumberFromString,
		});
		const db = await createEngineDatabase({
			rows: { schema: DecodedSchema, relationships: {} },
		} as const);
		try {
			const created = await db.rows.createMany([
				{ id: "r1", amount: "41" },
				{ id: "r2", amount: "42" },
			] as never);
			expect(created.created).toEqual([
				{ id: "r1", amount: 41 },
				{ id: "r2", amount: 42 },
			]);
			expect(await db.rows.query({ sort: { id: "asc" } })).toEqual(
				created.created,
			);
		} finally {
			await db.close();
		}
	});

	it("falls back from direct compact createMany preparation for boundary numbers", async () => {
		const NumberSchema = Schema.Struct({
			id: Schema.String,
			amount: Schema.Number,
		});
		const db = await createEngineDatabase({
			rows: { schema: NumberSchema, relationships: {} },
		} as const);
		try {
			const created = await db.rows.createMany([
				{ id: "negative-zero", amount: -0 },
			]);
			expect(Object.is(created.created[0]?.amount, -0)).toBe(true);
			expect(
				Object.is((await db.rows.findById("negative-zero"))?.amount, -0),
			).toBe(true);
		} finally {
			await db.close();
		}
	});

	it("retains a reused 10K shell through the current event-loop turn and releases it on the next turn", async () => {
		const count = 10_000;
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: Array.from({ length: count }, (_, index) => ({
					id: `u${index}`,
					name: `User ${index}`,
				})),
			},
		);
		try {
			const diagnostics = () =>
				(
					db as unknown as {
						__proseqlMaterializationDiagnostics: () => {
							peakMaterializedRows: number;
							retainedStrongRows: number;
							retainedStrongProxies: number;
							strongStructureReleaseScheduled: boolean;
						};
					}
				).__proseqlMaterializationDiagnostics();
			let first: ReadonlyArray<{ id: string; name: string }> | undefined =
				await db.users.query();
			for (let phase = 0; phase < 64; phase += 1) await Promise.resolve();
			let second: ReadonlyArray<{ id: string; name: string }> | undefined =
				await db.users.query();
			const retained = first[0];
			expect(second[0]).toBe(retained);
			expect(diagnostics().peakMaterializedRows).toBe(count);
			expect(diagnostics().retainedStrongRows).toBe(count);
			expect(diagnostics().strongStructureReleaseScheduled).toBe(true);

			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(diagnostics().strongStructureReleaseScheduled).toBe(false);
			expect(diagnostics().retainedStrongRows).toBe(0);
			expect(diagnostics().retainedStrongProxies).toBe(0);
			expect(first[0]).toBe(retained);
			expect(second[0]).toBe(retained);

			first = undefined;
			second = undefined;
			(globalThis as { Bun?: { gc(full?: boolean): void } }).Bun?.gc(true);
			expect(diagnostics().retainedStrongRows).toBe(0);
		} finally {
			await db.close();
		}
	});

	it("keeps mutation result identity while idle release and close clear structural owners", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: Array.from({ length: 100 }, (_, index) => ({
					id: `u${index}`,
					name: `User ${index}`,
				})),
			},
		);
		let closed = false;
		try {
			const diagnostics = () =>
				(
					db as unknown as {
						__proseqlMaterializationDiagnostics: () => {
							retainedStrongRows: number;
						};
					}
				).__proseqlMaterializationDiagnostics();
			const rows = await db.users.query();
			const updated = await db.users.updateMany(
				{ id: { $in: ["u0"] } },
				{ name: "Updated" },
			);
			expect(updated.updated[0]).toBe(rows[0]);
			expect(rows[0]?.name).toBe("Updated");
			expect(diagnostics().retainedStrongRows).toBe(100);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(diagnostics().retainedStrongRows).toBe(0);
			expect(updated.updated[0]).toBe(rows[0]);

			await db.users.query();
			expect(diagnostics().retainedStrongRows).toBe(100);
			const closing = db.close();
			closed = true;
			expect(diagnostics().retainedStrongRows).toBe(0);
			await closing;
		} finally {
			if (!closed) await db.close();
		}
	});

	it("isolates event-turn shell leases between databases", async () => {
		const create = () =>
			createEngineDatabase(
				{ users: { schema: UserSchema, relationships: {} } } as const,
				{
					users: Array.from({ length: 100 }, (_, index) => ({
						id: `u${index}`,
						name: `User ${index}`,
					})),
				},
			);
		const first = await create();
		const second = await create();
		const diagnostics = (db: typeof first) =>
			(
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => {
						retainedStrongRows: number;
					};
				}
			).__proseqlMaterializationDiagnostics();
		const retainedRows = (db: typeof first) =>
			diagnostics(db).retainedStrongRows;
		try {
			await first.users.query();
			await second.users.query();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(retainedRows(first)).toBe(0);
			expect(retainedRows(second)).toBe(0);

			await first.users.query();
			expect(retainedRows(first)).toBe(100);
			expect(retainedRows(second)).toBe(0);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(retainedRows(first)).toBe(0);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("resynchronizes scalar bulk deletes lazily without replacing surviving or retained identities", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "Alice" },
					{ id: "u2", name: "Bob" },
					{ id: "u3", name: "Cara" },
				],
			},
		);
		const watch = db.users.watch({ debounceMs: 0 });
		try {
			await watch.next();
			const snapshot = await db.users.query();
			const deleted = await db.users.deleteMany({
				id: { $in: ["u2", "u3"] },
			} as never);
			expect(deleted.deleted[0]).toBe(snapshot[1]);
			expect(deleted.deleted[1]).toBe(snapshot[2]);
			expect(snapshot.map((row) => row.id)).toEqual(["u1", "u2", "u3"]);

			await expect(db.users.findById("u2")).rejects.toMatchObject({
				_tag: "NotFoundError",
				id: "u2",
			});
			const survivors = await db.users.query();
			expect(survivors).toHaveLength(1);
			expect(survivors[0]).toBe(snapshot[0]);
			expect((await watch.next()).value?.map((row) => row.id)).toEqual(["u1"]);

			const recreated = await db.users.create({ id: "u2", name: "Recreated" });
			expect(recreated).not.toBe(deleted.deleted[0]);
			expect(await db.users.findById("u2")).toBe(recreated);
			await db.$transaction(async (tx) => {
				expect((await tx.users.query()).map((row) => row.id)).toEqual([
					"u1",
					"u2",
				]);
			});
		} finally {
			await watch.return();
			await db.close();
		}
	});

	it("revalidates cached equality cohorts in Rust before an authorized delete writes", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "keep" },
					{ id: "u2", name: "drop" },
					{ id: "u3", name: "drop" },
				],
			},
		);
		try {
			await db.users.query();
			expect((await db.users.deleteMany({ name: "drop" })).count).toBe(2);
			await db.users.createMany([
				{ id: "u2", name: "drop" },
				{ id: "u3", name: "drop" },
				{ id: "u4", name: "drop" },
			]);
			const deleted = await db.users.deleteMany({ name: "drop" });
			expect(deleted.count).toBe(3);
			expect(deleted.deleted.map((row) => row.id)).toEqual(["u2", "u3", "u4"]);
			expect((await db.users.query()).map((row) => row.id)).toEqual(["u1"]);
		} finally {
			await db.close();
		}
	});

	it("recreates a 100-row tail after repeated authorized deletes without leaving stale storage ids", async () => {
		const count = 10_000;
		const targets = Array.from({ length: 100 }, (_, index) => ({
			id: `u${count - 100 + index}`,
			name: "drop",
		}));
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: Array.from({ length: count }, (_, index) => ({
					id: `u${index}`,
					name: index >= count - 100 ? "drop" : "keep",
				})),
			},
		);
		try {
			for (let iteration = 0; iteration < 5; iteration += 1) {
				await db.users.query();
				const deleted = await db.users.deleteMany({ name: "drop" });
				expect(deleted.count).toBe(100);
				expect(await db.users.query({ where: { name: "drop" } })).toEqual([]);
				const recreated = await db.users.createMany(targets);
				expect(recreated.created).toHaveLength(100);
			}
		} finally {
			await db.close();
		}
	});

	it("keeps transformed create results identical to their stable storage-key lookup", async () => {
		const db = await createEngineDatabase({
			users: {
				schema: UserSchema,
				relationships: {},
				hooks: {
					beforeCreate: [
						(ctx: { data: { id: string; name: string } }) =>
							Effect.succeed({ ...ctx.data, id: "visible-id" }),
					],
				},
			},
		} as const);
		try {
			const created = await db.users.create({
				id: "storage-id",
				name: "Alice",
			});
			const found = await db.users.findById("storage-id");
			expect(created.id).toBe("visible-id");
			expect(found).toBe(created);
		} finally {
			await db.close();
		}
	});

	it("keeps caller-mutated storage identity, stale indexes, and hook context aligned with direct mutable rows", async () => {
		let hookPrevious: unknown;
		let hookCurrent: unknown;
		const db = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					indexes: ["name"],
					hooks: {
						beforeUpdate: [
							(ctx: { update: unknown }) => Effect.succeed(ctx.update),
						],
						afterUpdate: [
							(ctx: { previous: unknown; current: unknown }) => {
								hookPrevious = ctx.previous;
								hookCurrent = ctx.current;
								return Effect.void;
							},
						],
					},
				},
			} as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const row = await db.users.findById("u1");
			(row as { id: string; name: string }).id = "caller-id";
			(row as { id: string; name: string }).name = "Caller mutation";
			expect(await db.users.findById("u1")).toBe(row);
			expect(await db.users.query({ where: { name: "Alice" } })).toEqual([]);
			expect(
				await db.users.query({ where: { name: "Caller mutation" } }),
			).toEqual([]);
			await db.users.update("u1", { name: "Formal" });
			expect(hookPrevious).toMatchObject({
				id: "caller-id",
				name: "Caller mutation",
			});
			expect(hookCurrent).toMatchObject({
				id: "caller-id",
				name: "Formal",
			});
		} finally {
			await db.close();
		}
	});

	it("preserves exact boundary values through dirty projection synchronization", async () => {
		const PayloadSchema = Schema.Struct({
			id: Schema.String,
			missing: Schema.optional(Schema.String),
			nullable: Schema.NullOr(Schema.String),
			negativeZero: Schema.Number,
			unicode: Schema.String,
			values: Schema.Array(Schema.NullOr(Schema.String)),
			sentinel: Schema.Struct({ __proseqlArrayHole__: Schema.Number }),
		});
		const db = await createEngineDatabase(
			{ payloads: { schema: PayloadSchema, relationships: {} } } as const,
			{
				payloads: [
					{
						id: "p1",
						nullable: null,
						negativeZero: 0,
						unicode: "雪🚀",
						values: ["a", "b", "c"],
						sentinel: { __proseqlArrayHole__: 1 },
					},
				],
			},
		);
		try {
			const row = await db.payloads.findById("p1");
			const mutable = row as unknown as {
				missing?: string;
				nullable: string | null;
				negativeZero: number;
				unicode: string;
				values: Array<string | null | undefined>;
				sentinel: { __proseqlArrayHole__: number };
			};
			mutable.missing = undefined;
			mutable.nullable = null;
			mutable.negativeZero = -0;
			mutable.unicode = "漢字✨";
			delete mutable.values[0];
			mutable.values[1] = undefined;
			mutable.values[2] = null;
			mutable.sentinel = { __proseqlArrayHole__: 1 };
			const found = (await db.payloads.findById(
				"p1",
			)) as unknown as typeof mutable;
			expect(found).toBe(row);
			expect(Object.hasOwn(found, "missing")).toBe(true);
			expect(found.missing).toBeUndefined();
			expect(found.nullable).toBeNull();
			expect(Object.is(found.negativeZero, -0)).toBe(true);
			expect(found.unicode).toBe("漢字✨");
			expect(0 in found.values).toBe(false);
			expect(1 in found.values).toBe(true);
			expect(found.values[1]).toBeUndefined();
			expect(found.values[2]).toBeNull();
			expect(found.sentinel).toEqual({ __proseqlArrayHole__: 1 });
		} finally {
			await db.close();
		}
	});

	it("materializes unchanged upsertMany rows for identity and caller mutation sync", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const result = await db.users.upsertMany([
				{
					where: { id: "u1" },
					create: { name: "unused" },
					update: { name: "Alice" },
				},
			]);
			const unchanged = result.unchanged[0];
			expect(unchanged).toBeDefined();
			expect(await db.users.findById("u1")).toBe(unchanged);
			(unchanged as { name: string }).name = "Caller mutation";
			expect((await db.users.findById("u1")).name).toBe("Caller mutation");
		} finally {
			await db.close();
		}
	});

	it("replaces materialized identity after same-id transaction snapshots", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const before = await db.users.findById("u1");
			await db.$transaction(async (tx) => {
				await tx.users.update("u1", { name: "Committed" });
			});
			const after = await db.users.findById("u1");
			expect(after).not.toBe(before);
			expect(after.name).toBe("Committed");
		} finally {
			await db.close();
		}
	});

	it("materializes every applicable mutation result with direct TypeScript identity semantics", async () => {
		const DeletableUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			deletedAt: Schema.optional(Schema.NullOr(Schema.String)),
			updatedAt: Schema.optional(Schema.String),
		});
		const db = await createEngineDatabase(
			{ users: { schema: DeletableUserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const createdWithRelationships = await db.users.createWithRelationships({
				id: "u2",
				name: "Bob",
			});
			expect(await db.users.findById("u2")).toBe(createdWithRelationships);
			(createdWithRelationships as { name: string }).name = "Caller Bob";
			expect((await db.users.findById("u2")).name).toBe("Caller Bob");

			const updatedWithRelationships = await db.users.updateWithRelationships(
				"u2",
				{ name: "Updated Bob" },
			);
			expect(await db.users.findById("u2")).toBe(updatedWithRelationships);

			const upsertOutcome = await db.users.upsert({
				where: { id: "u2" },
				create: { name: "Unused" },
				update: { name: "Upserted Bob" },
			});
			// Direct TypeScript spreads __action onto a result clone rather than
			// adding metadata to the canonical stored entity.
			expect(await db.users.findById("u2")).not.toBe(upsertOutcome);
			expect(upsertOutcome.__action).toBe("updated");

			const upsertMany = await db.users.upsertMany([
				{
					where: { id: "u2" },
					create: { name: "Unused" },
					update: { name: "Batch Bob" },
				},
				{
					where: { id: "u3" },
					create: { name: "Cara" },
					update: { name: "Unused" },
				},
			]);
			expect(await db.users.findById("u2")).toBe(upsertMany.updated[0]);
			expect(await db.users.findById("u3")).toBe(upsertMany.created[0]);

			const softDeleted = await db.users.delete("u2", { soft: true });
			expect(await db.users.findById("u2")).toBe(softDeleted);

			const beforeHardDelete = await db.users.findById("u3");
			const hardDeleted = await db.users.delete("u3");
			expect(hardDeleted).toBe(beforeHardDelete);

			await db.users.create({ id: "u4", name: "Dora" });
			const beforeRelationshipDelete = await db.users.findById("u4");
			const relationshipDelete = await db.users.deleteWithRelationships("u4");
			expect(relationshipDelete.deleted).toBe(beforeRelationshipDelete);

			const softRelationshipRow = await db.users.create({
				id: "u7",
				name: "Gia",
			});
			const softRelationshipDelete = await db.users.deleteWithRelationships(
				"u7",
				{
					soft: true,
				},
			);
			expect(softRelationshipDelete.deleted).not.toBe(softRelationshipRow);
			expect(await db.users.findById("u7")).toBe(
				softRelationshipDelete.deleted,
			);

			await db.users.createMany([
				{ id: "u5", name: "Eve" },
				{ id: "u6", name: "Finn" },
			]);
			const beforeBatchDelete = await db.users.findById("u5");
			const deletedMany = await db.users.deleteMany({ id: "u5" });
			expect(deletedMany.deleted[0]).toBe(beforeBatchDelete);

			const beforeRelationshipBatchDelete = await db.users.findById("u6");
			const deletedManyWithRelationships =
				await db.users.deleteManyWithRelationships({ id: "u6" });
			expect(deletedManyWithRelationships.deleted[0]).toBe(
				beforeRelationshipBatchDelete,
			);
		} finally {
			await db.close();
		}
	});

	it("keeps duplicate caller-mutated values on distinct Rust storage handles", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "Alice" },
					{ id: "u2", name: "Bob" },
				],
			},
		);
		try {
			const first = await db.users.findById("u1");
			const second = await db.users.findById("u2");
			Object.assign(first as { id: string; name: string }, {
				id: "visible-id",
				name: "Same",
			});
			Object.assign(second as { id: string; name: string }, {
				id: "visible-id",
				name: "Same",
			});
			const rows = await db.users.query({ sort: { id: "asc" } });
			expect(rows).toHaveLength(2);
			expect(rows[0]).not.toBe(rows[1]);
			expect(rows).toEqual([
				{ id: "visible-id", name: "Same" },
				{ id: "visible-id", name: "Same" },
			]);
		} finally {
			await db.close();
		}
	});

	it("keeps a 10K projection sparse until a row is actually read", async () => {
		const users = Array.from({ length: 10_000 }, (_, index) => ({
			id: `u${index.toString().padStart(5, "0")}`,
			name: `User ${index}`,
		}));
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users },
		);
		try {
			const diagnostics = () =>
				(
					db as unknown as {
						__proseqlMaterializationDiagnostics: () => {
							materializedRows: number;
							trackedProxies: number;
						};
					}
				).__proseqlMaterializationDiagnostics();
			expect(diagnostics()).toMatchObject({
				materializedRows: 0,
				trackedProxies: 0,
			});
			await db.users.findById("u05000");
			expect(diagnostics()).toMatchObject({
				materializedRows: 1,
				trackedProxies: 1,
			});
		} finally {
			await db.close();
		}
	});

	it("decodes exact boundary values embedded in typed validation errors", async () => {
		const db = await createEngineDatabase({
			users: { schema: UserSchema, relationships: {} },
		} as const);
		try {
			const sparse = ["first", "second"] as Array<unknown>;
			delete sparse[0];
			const invalidName = {
				explicitUndefined: undefined,
				negativeZero: -0,
				sparse,
				reserved: { __proseqlArrayHole__: 1 },
			};
			let caught: unknown;
			try {
				await db.users.create({ id: "u1", name: invalidName as never });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ValidationError);
			const issueValue = (caught as ValidationError).issues[0]
				?.value as typeof invalidName;
			expect(Object.hasOwn(issueValue, "explicitUndefined")).toBe(true);
			expect(issueValue.explicitUndefined).toBeUndefined();
			expect(Object.is(issueValue.negativeZero, -0)).toBe(true);
			expect(0 in issueValue.sparse).toBe(false);
			expect(issueValue.sparse[1]).toBe("second");
			expect(issueValue.reserved).toEqual({ __proseqlArrayHole__: 1 });
		} finally {
			await db.close();
		}
	});

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
				JSON.stringify({
					nested: { settings: { s1: { id: "s1", value: "disk-setting" } } },
				}),
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
			expect(await db.users.findById("u1")).toEqual({
				id: "u1",
				name: "seed-user",
			});
			expect(await db.users.findById("u2")).toEqual({
				id: "u2",
				name: "new-user",
			});
			expect(await db.teams.findById("t1")).toEqual({
				id: "t1",
				name: "seed-team",
			});
			expect(await db.settings.findById("s1")).toEqual({
				id: "s1",
				value: "seed-setting",
			});
			await db.close();
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
			expect(
				await createNodeEngineStorageHost().exists(
					join(root, "teams", "t1.json"),
				),
			).toBe(true);
			await db.teams.delete("t1");
			await db.flush();
			await db.close();
			const reloaded = await createPersistentEngineDatabase({
				teams: {
					schema: TeamSchema,
					directory: join(root, "teams"),
					format: "json",
					relationships: {},
				},
			} as const);
			expect(await reloaded.teams.query()).toEqual([]);
			await reloaded.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("persists predicate bulk successes and callback side effects across flush and reload", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "proseql-engine-u8-predicate-persistence-"),
		);
		const file = join(root, "users.json");
		const config = {
			users: {
				schema: UserSchema,
				file,
				format: "json",
				relationships: {},
			},
		} as const;
		const predicateBulk = Symbol.for(
			"@proseql/engine/predicate-bulk-operation",
		);
		const invoke = (
			collection: unknown,
			method: "updateMany" | "deleteMany",
			selectIds: (
				rows: ReadonlyArray<Record<string, unknown>>,
			) => ReadonlyArray<string>,
			data?: unknown,
		) =>
			(
				collection as Record<
					symbol,
					(
						method: "updateMany" | "deleteMany",
						selectIds: (
							rows: ReadonlyArray<Record<string, unknown>>,
						) => ReadonlyArray<string>,
						data: unknown,
					) => Promise<unknown>
				>
			)[predicateBulk](method, selectIds, data);
		try {
			let db = await createPersistentEngineDatabase(
				config,
				{
					users: [
						{ id: "u1", name: "One" },
						{ id: "u2", name: "Two" },
					],
				},
				{ writeDebounce: 5 },
			);
			await db.users.query();
			const predicateDefect = new Error("persistent predicate defect");
			await expect(
				invoke(db.users, "updateMany", (rows) => {
					(rows[1] as { name: string }).name = "Callback Side Effect";
					throw predicateDefect;
				}),
			).rejects.toBe(predicateDefect);
			await db.flush();
			await db.close();

			db = await createPersistentEngineDatabase(config);
			expect(await db.users.findById("u2")).toMatchObject({
				name: "Callback Side Effect",
			});
			await db.users.query();
			await invoke(
				db.users,
				"updateMany",
				(rows) => {
					const nonmatching = rows.find((row) => row.id === "u2") as
						| { name: string }
						| undefined;
					if (nonmatching !== undefined) {
						nonmatching.name = "Successful Callback Side Effect";
					}
					return rows
						.filter((row) => row.id === "u1")
						.map((row) => String(row.id));
				},
				{ name: "Formal Update" },
			);
			await db.flush();
			await db.close();

			db = await createPersistentEngineDatabase(config);
			expect(await db.users.findById("u1")).toMatchObject({
				name: "Formal Update",
			});
			expect(await db.users.findById("u2")).toMatchObject({
				name: "Successful Callback Side Effect",
			});
			await db.users.query();
			await invoke(db.users, "deleteMany", (rows) =>
				rows.filter((row) => row.id === "u1").map((row) => String(row.id)),
			);
			await db.flush();
			await db.close();

			const reloaded = await createPersistentEngineDatabase(config);
			await expect(reloaded.users.findById("u1")).rejects.toMatchObject({
				_tag: "NotFoundError",
			});
			expect(await reloaded.users.findById("u2")).toMatchObject({
				name: "Successful Callback Side Effect",
			});
			await reloaded.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("updates watched directory delete baselines after external adds so API deletes remove added files", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "proseql-engine-u8-dir-baseline-"),
		);
		try {
			const teamsDir = join(root, "teams");
			await mkdir(teamsDir, { recursive: true });
			await writeFile(
				join(teamsDir, "t1.json"),
				JSON.stringify({ id: "t1", name: "Alpha" }),
			);
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
			await writeFile(
				join(teamsDir, "t2.json"),
				JSON.stringify({ id: "t2", name: "Beta" }),
			);
			await waitFor(async () => {
				expect(await db.teams.findById("t2")).toEqual({
					id: "t2",
					name: "Beta",
				});
			});
			await db.teams.delete("t2");
			await db.flush();
			await expect(
				createNodeEngineStorageHost().read(join(teamsDir, "t2.json")),
			).rejects.toBeInstanceOf(Error);
			await db.close();
			const reopened = await createPersistentEngineDatabase({
				teams: {
					schema: TeamSchema,
					directory: teamsDir,
					format: "json",
					relationships: {},
				},
			} as const);
			expect(await reopened.teams.query()).toEqual([
				{ id: "t1", name: "Alpha" },
			]);
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
			const stored = JSON.parse(await readFile(sharedPath, "utf8")) as Record<
				string,
				any
			>;
			expect(host.maxConcurrentWrites()).toBe(1);
			expect(stored.authors.a1.name).toBe("Frank Herbert");
			expect(stored.books.b1.year).toBe(1966);
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("persists identity-safe formal mutations through the active serializer and falls back after caller mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u11-mirror-"));
		const file = join(root, "users.json");
		let serializeCalls = 0;
		const serializerRegistry = {
			supportedExtensions: () => ["json"],
			serialize: (data: unknown, extension: string) =>
				Effect.sync(() => {
					serializeCalls += 1;
					expect(extension).toBe("json");
					return JSON.stringify(data, null, 2);
				}),
			deserialize: (content: string) => Effect.sync(() => JSON.parse(content)),
		};
		try {
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file,
						relationships: {},
					},
				},
				undefined,
				{
					storageHost: createNodeEngineStorageHost(),
					serializerRegistry,
					writeDebounce: 60_000,
					_suppressInitialWrites: true,
				},
			);
			const first = await db.users.create({ id: "u1", name: "Alice" });
			await db.users.create({ id: "u2", name: "Bob" });
			await db.flush();
			expect(serializeCalls).toBe(1);
			expect(await readFile(file, "utf8")).toBe(
				JSON.stringify(
					{
						u1: { id: "u1", name: "Alice" },
						u2: { id: "u2", name: "Bob" },
					},
					null,
					2,
				),
			);

			(first as { name: unknown }).name = 42;
			await db.users.update("u2", { name: "Scheduled" });
			await expect(db.flush()).rejects.toBeInstanceOf(ValidationError);
			expect(serializeCalls).toBe(1);
			(first as { name: unknown }).name = "Recovered";
			await db.users.update("u2", { name: "Recovered Too" });
			await db.flush();
			expect(serializeCalls).toBe(2);
			expect(JSON.parse(await readFile(file, "utf8")).u1.name).toBe(
				"Recovered",
			);
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refreshes the persistence mirror after an external file reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u11-mirror-watch-"));
		const file = join(root, "users.json");
		const host = createTriggerableFileWatchHost(root);
		const serializerRegistry = {
			supportedExtensions: () => ["json"],
			serialize: (data: unknown) => Effect.succeed(JSON.stringify(data, null, 2)),
			deserialize: (content: string) => Effect.sync(() => JSON.parse(content)),
		};
		try {
			await writeFile(file, JSON.stringify({ u1: { id: "u1", name: "Alice" } }));
			const db = await createPersistentEngineDatabase(
				{
					users: { schema: UserSchema, file, relationships: {} },
				},
				undefined,
				{
					storageHost: host,
					serializerRegistry,
					writeDebounce: 60_000,
					_suppressInitialWrites: true,
				},
			);
			await writeFile(
				file,
				JSON.stringify({
					u1: { id: "u1", name: "External" },
					u2: { id: "u2", name: "External Only" },
				}),
			);
			host.watchCallbackFor(file)?.();
			await waitFor(async () => {
				expect((await db.users.findById("u2"))?.name).toBe("External Only");
			});
			await db.users.update("u1", { name: "Local" });
			await db.flush();
			const stored = JSON.parse(await readFile(file, "utf8"));
			expect(stored).toEqual({
				u1: { id: "u1", name: "Local" },
				u2: { id: "u2", name: "External Only" },
			});
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the configured storage layer when it differs from the storage host", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u11-mirror-layer-"));
		const file = join(root, "users.json");
		const host = createControlledHost(root);
		const layerHost = createControlledHost(root);
		try {
			const db = await createPersistentEngineDatabase(
				{
					users: { schema: UserSchema, file, relationships: {} },
				},
				undefined,
				{
					storageHost: host,
					storageLayer: makeEngineStorageLayer(layerHost),
					serializerRegistry: {
						supportedExtensions: () => ["json"],
						serialize: (data: unknown) => Effect.succeed(JSON.stringify(data)),
						deserialize: (content: string) => Effect.sync(() => JSON.parse(content)),
					},
					writeDebounce: 60_000,
					_suppressInitialWrites: true,
				},
			);
			await db.users.create({ id: "u1", name: "Layer" });
			await db.flush();
			expect(host.writes).toHaveLength(0);
			expect(layerHost.writes).toHaveLength(1);
			expect(JSON.parse(layerHost.writes[0]!.data)).toEqual({
				u1: { id: "u1", name: "Layer" },
			});
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retries mirror serializer and storage failures without losing dirty rows", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u11-mirror-retry-"));
		const file = join(root, "users.json");
		const host = createControlledHost(root);
		let serializerFailures = 1;
		let serializeCalls = 0;
		const serializerRegistry = {
			supportedExtensions: () => ["json"],
			serialize: (data: unknown) =>
				serializerFailures-- > 0
					? Effect.fail(
							new SerializationError({
								format: "json",
								message: "Injected serializer failure",
							}),
						)
					: Effect.sync(() => {
						serializeCalls += 1;
						return JSON.stringify(data);
					}),
			deserialize: (content: string) => Effect.sync(() => JSON.parse(content)),
		};
		try {
			const db = await createPersistentEngineDatabase(
				{
					users: { schema: UserSchema, file, relationships: {} },
				},
				undefined,
				{
					storageHost: host,
					serializerRegistry,
					writeDebounce: 60_000,
					_suppressInitialWrites: true,
				},
			);
			await db.users.create({ id: "u1", name: "Retry" });
			await expect(db.flush()).rejects.toBeInstanceOf(SerializationError);
			expect(host.writes).toHaveLength(0);
			await db.flush();
			expect(serializeCalls).toBe(1);
			expect(host.writes).toHaveLength(1);
			expect(JSON.parse(host.writes[0]!.data)).toEqual({
				u1: { id: "u1", name: "Retry" },
			});

			host.failNextWrite(file);
			await db.users.update("u1", { name: "Storage Retry" });
			await expect(db.flush()).rejects.toBeInstanceOf(StorageError);
			expect(host.writes).toHaveLength(1);
			await db.flush();
			expect(host.writes).toHaveLength(2);
			expect(JSON.parse(host.writes[1]!.data)).toEqual({
				u1: { id: "u1", name: "Storage Retry" },
			});
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses canonical schema encoding for transforming schemas", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u11-transform-"));
		const file = join(root, "events.json");
		try {
			const db = await createPersistentEngineDatabase(
				{
					events: {
						schema: Schema.Struct({
							id: Schema.String,
							count: Schema.NumberFromString,
						}),
						file,
						relationships: {},
					},
				},
				undefined,
				{
					storageHost: createNodeEngineStorageHost(),
					serializerRegistry: {
						supportedExtensions: () => ["json"],
						serialize: (data: unknown) =>
							Effect.succeed(JSON.stringify(data)),
						deserialize: (content: string) =>
							Effect.sync(() => JSON.parse(content)),
					},
					writeDebounce: 60_000,
					_suppressInitialWrites: true,
				},
			);
			await db.events.create({ id: "e1", count: "777" });
			await db.flush();
			expect(JSON.parse(await readFile(file, "utf8")).e1.count).toBe(
				"777",
			);
			await db.close();
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
			await db.close();
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

	it("rolls back without publishing a projection delta or replacing prior identity", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		const before = await db.users.findById("u1");
		const failure = new Error("rollback identity");
		await expect(
			db.$transaction(async (tx) => {
				await tx.users.update("u1", { name: "Changed" });
				throw failure;
			}),
		).rejects.toBe(failure);
		const after = await db.users.findById("u1");
		expect(after).toBe(before);
		expect(after).toEqual({ id: "u1", name: "Alice" });
		await db.close();
	});

	it("uses a transaction-local projection for identity and caller mutation without leaking rollback state", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		const mainBefore = await db.users.findById("u1");
		const failure = new Error("rollback local projection");
		await expect(
			db.$transaction(async (tx) => {
				const first = await tx.users.findById("u1");
				const repeated = await tx.users.findById("u1");
				expect(repeated).toBe(first);
				first.name = "Caller changed";
				const synchronized = await tx.users.findById("u1");
				expect(synchronized).toBe(first);
				expect(synchronized.name).toBe("Caller changed");
				const updated = await tx.users.update("u1", { name: "Updated" });
				expect(await tx.users.findById("u1")).toBe(updated);
				expect(mainBefore.name).toBe("Alice");
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(await db.users.findById("u1")).toBe(mainBefore);
		expect(mainBefore.name).toBe("Alice");
		await db.close();
	});

	it("rebuilds equality, compound, and search indexes after a net-zero projected rollback", async () => {
		const IndexedUserSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
		});
		const db = await createEngineDatabase(
			{
				users: {
					schema: IndexedUserSchema,
					relationships: {},
					indexes: ["name", ["name", "id"]],
					searchIndex: ["name"],
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "Alice" },
					{ id: "u2", name: "Alice" },
				],
			},
		);
		try {
			const mainBefore = await db.users.findById("u1");
			const failure = new Error("net-zero rollback");
			await expect(
				db.$transaction(async (tx) => {
					const updated = await tx.users.update("u1", { name: "Bob" });
					updated.name = "Alice";
					await tx.users.findById("u1");

					expect(
						(await tx.users.query({ where: { name: "Alice" } })).map(
							(row) => row.id,
						),
					).toEqual(["u2"]);
					expect(
						(
							await tx.users.query({
								where: {
									$search: { query: "alice", fields: ["name"] },
								},
							})
						).map((row) => row.id),
					).toEqual(["u2"]);
					throw failure;
				}),
			).rejects.toBe(failure);

			expect(await db.users.findById("u1")).toBe(mainBefore);
			expect(await db.users.query({ where: { name: "Alice" } })).toEqual([
				{ id: "u1", name: "Alice" },
				{ id: "u2", name: "Alice" },
			]);
			expect(
				await db.users.query({ where: { name: "Alice", id: "u1" } }),
			).toEqual([{ id: "u1", name: "Alice" }]);
			expect(await db.users.query({ where: { name: "Bob" } })).toEqual([]);
			expect(
				(
					await db.users.query({
						where: {
							$search: { query: "alice", fields: ["name"] },
						},
					})
				).map((row) => row.id),
			).toEqual(["u1", "u2"]);
			expect(
				await db.users.query({
					where: { $search: { query: "bob", fields: ["name"] } },
				}),
			).toEqual([]);
		} finally {
			await db.close();
		}
	});

	it("flushes final transaction-local caller mutations with exact boundary values before commit", async () => {
		const PayloadSchema = Schema.Struct({
			id: Schema.String,
			missing: Schema.optional(Schema.String),
			negativeZero: Schema.Number,
			values: Schema.Array(Schema.NullOr(Schema.String)),
			sentinel: Schema.Struct({ __proseqlArrayHole__: Schema.Number }),
		});
		const db = await createEngineDatabase(
			{ payloads: { schema: PayloadSchema, relationships: {} } } as const,
			{
				payloads: [
					{
						id: "p1",
						negativeZero: 0,
						values: ["a", "b", "c"],
						sentinel: { __proseqlArrayHole__: 1 },
					},
				],
			},
		);
		try {
			const mainBefore = await db.payloads.findById("p1");
			const local = await db.$transaction(async (tx) => {
				const row = await tx.payloads.findById("p1");
				const mutable = row as unknown as {
					missing?: string;
					negativeZero: number;
					values: Array<string | null | undefined>;
					sentinel: { __proseqlArrayHole__: number };
				};
				mutable.missing = undefined;
				mutable.negativeZero = -0;
				delete mutable.values[0];
				mutable.values[1] = undefined;
				mutable.values[2] = null;
				mutable.sentinel = { __proseqlArrayHole__: 1 };
				return row;
			});
			const committed = await db.payloads.findById("p1");
			expect(committed).not.toBe(mainBefore);
			expect(committed).not.toBe(local);
			expect(Object.hasOwn(committed, "missing")).toBe(true);
			expect(committed.missing).toBeUndefined();
			expect(Object.is(committed.negativeZero, -0)).toBe(true);
			expect(0 in committed.values).toBe(false);
			expect(1 in committed.values).toBe(true);
			expect(committed.values[1]).toBeUndefined();
			expect(committed.values[2]).toBeNull();
			expect(committed.sentinel).toEqual({ __proseqlArrayHole__: 1 });
		} finally {
			await db.close();
		}
	});

	it("rolls back and preserves main identity when final dirty synchronization fails", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			const mainBefore = await db.users.findById("u1");
			const syncFailure = new Error("final dirty sync failed");
			await expect(
				db.$transaction(async (tx) => {
					const row = await tx.users.findById("u1");
					Object.defineProperty(row, "explodes", {
						configurable: true,
						enumerable: true,
						get: () => {
							throw syncFailure;
						},
					});
					return row;
				}),
			).rejects.toBe(syncFailure);
			const after = await db.users.findById("u1");
			expect(after).toBe(mainBefore);
			expect(after).toEqual({ id: "u1", name: "Alice" });
		} finally {
			await db.close();
		}
	});

	it("rejects same-context parent operations and close instead of self-deadlocking", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await db.$transaction(async (tx) => {
			await expect(db.users.findById("u1")).rejects.toMatchObject({
				_tag: "TransactionError",
				reason: "transaction is active; use transaction context",
			});
			await expect(db.close()).rejects.toMatchObject({
				_tag: "TransactionError",
				reason: "transaction is active; use transaction context",
			});
			return tx.users.findById("u1");
		});
		expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Alice" });
		await db.close();
	});

	it("keeps existing and newly requested watches isolated across commit and rollback", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		const existing = db.users.watch({ debounceMs: 5 });
		expect((await existing.next()).value?.[0]?.name).toBe("Alice");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transaction = db.$transaction(async (tx) => {
			await tx.users.update("u1", { name: "Committed" });
			await blocked;
		});
		await sleep(20);
		let existingSettled = false;
		const existingNext = existing.next().then((value) => {
			existingSettled = true;
			return value;
		});
		const queued = db.users.watch({ debounceMs: 5 });
		await sleep(20);
		expect(existingSettled).toBe(false);
		release();
		await transaction;
		expect((await existingNext).value?.[0]?.name).toBe("Committed");
		expect((await queued.next()).value?.[0]?.name).toBe("Committed");

		const rollbackFailure = new Error("watch rollback");
		await expect(
			db.$transaction(async (tx) => {
				await tx.users.update("u1", { name: "Rolled back" });
				await sleep(20);
				throw rollbackFailure;
			}),
		).rejects.toBe(rollbackFailure);
		let rollbackEmission = false;
		const pending = existing.next().then((value) => {
			rollbackEmission = true;
			return value;
		});
		await sleep(20);
		expect(rollbackEmission).toBe(false);
		await existing.unsubscribe();
		await queued.unsubscribe();
		await pending;
		await db.close();
	});

	it("poisons a transaction after a caught defect and rolls it back instead of committing", async () => {
		const db = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					hooks: {
						beforeCreate: [
							() => {
								throw new Error("transaction defect");
							},
						],
					},
				},
			} as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			db.$transaction(async (tx) => {
				await expect(
					tx.users.create({ id: "u2", name: "Bob" }),
				).rejects.toBeInstanceOf(WasmEngineDefectError);
				await expect(tx.users.findById("u1")).rejects.toMatchObject({
					_tag: "OperationError",
					reason: "session-poisoned",
				});
			}),
		).rejects.toMatchObject({
			_tag: "OperationError",
			reason: "session-poisoned",
		});
		expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "Alice" });
		await db.close();
	});

	it("uses stateful transaction crossings without snapshot or temporary-runtime transfers", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		const diagnostics = () =>
			(
				db as unknown as {
					__proseqlMaterializationDiagnostics: () => Record<string, number>;
				}
			).__proseqlMaterializationDiagnostics();
		const before = diagnostics();
		await db.$transaction(async (tx) => {
			await tx.users.create({ id: "u2", name: "Bob" });
			await tx.users.update("u2", { name: "Bobby" });
			await tx.users.delete("u2");
		});
		const after = diagnostics();
		expect(after.transactionBegins - before.transactionBegins).toBe(1);
		expect(after.transactionSteps - before.transactionSteps).toBe(3);
		expect(after.transactionCommits - before.transactionCommits).toBe(1);
		expect(after.transactionRollbacks - before.transactionRollbacks).toBe(0);
		expect(
			after.transactionSnapshotTransfers - before.transactionSnapshotTransfers,
		).toBe(0);
		expect(
			after.temporaryTransactionRuntimes - before.temporaryTransactionRuntimes,
		).toBe(0);
		await db.close();
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
		let outsideReadSettled = false;
		const outsideRead = db.users.findById("u1").then((value) => {
			outsideReadSettled = true;
			return value;
		});
		await Promise.resolve();
		expect(outsideReadSettled).toBe(false);
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
		expect(await outsideRead).toEqual({ id: "u1", name: "First" });
		expect(await db.users.findById("u1")).toEqual({ id: "u1", name: "First" });
		const after = await db.$transaction(async (tx) => tx.users.findById("u1"));
		expect(after).toEqual({ id: "u1", name: "First" });
	});

	it("keeps queued reads and close behind rollback restoration", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const failure = new Error("rollback callback");
		const transaction = db.$transaction(async (tx) => {
			await tx.users.create({ id: "u2", name: "Bob" });
			await blocked;
			throw failure;
		});
		let readSettled = false;
		const queuedRead = db.users.findById("u2").finally(() => {
			readSettled = true;
		});
		const queuedReadOutcome = queuedRead.then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		let closeSettled = false;
		const close = db.close().then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(readSettled).toBe(false);
		expect(closeSettled).toBe(false);
		release();
		await expect(transaction).rejects.toBe(failure);
		expect((await queuedReadOutcome).error).toMatchObject({
			_tag: "NotFoundError",
			id: "u2",
		});
		await close;
		expect(closeSettled).toBe(true);
	});

	it("rolls back nested $transaction attempts and releases the guard in finally", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			db.$transaction(async (tx) => {
				await tx.users.create({ id: "u2", name: "Bob" });
				await db.$transaction(async (inner) =>
					inner.users.create({ id: "u3", name: "Charlie" }),
				);
			}),
		).rejects.toMatchObject({
			_tag: "TransactionError",
			operation: "begin",
			reason: "nested transactions not supported",
		});
		await expect(db.users.findById("u2")).rejects.toBeInstanceOf(Error);
		await expect(db.users.findById("u3")).rejects.toBeInstanceOf(Error);
		const created = await db.$transaction(async (tx) =>
			tx.users.create({ id: "u4", name: "Dana" }),
		);
		expect(created).toEqual({ id: "u4", name: "Dana" });
		expect(await db.users.findById("u4")).toEqual(created);
	});

	it("dispatches computed and custom-operator callbacks immediately while still returning a Promise", async () => {
		const { db, getCounts } = await createPromiseWrapperDatabase();
		try {
			const promise = db.users.query({
				where: { name: { $wrapperStartsWith: "Al" } },
				select: { id: true, displayName: true },
			} as const);
			expect(promise).toBeInstanceOf(Promise);
			expect(getCounts()).toEqual({ customOperatorCalls: 1, computedCalls: 1 });
			let settled = false;
			void promise.then(() => {
				settled = true;
			});
			expect(settled).toBe(false);
			await expect(promise).resolves.toEqual([
				{ id: "u1", displayName: "Alice!" },
			]);
			expect(settled).toBe(true);
		} finally {
			await db.close();
		}
	});

	it("materializes Rust-authored populated graphs with TypeScript reference identity", async () => {
		const LinkedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const db = await createEngineDatabase(
			{
				authors: { schema: AuthorSchema, relationships: {} },
				books: {
					schema: LinkedBookSchema,
					relationships: {
						author: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
						creditedAuthor: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
					},
				},
			} as const,
			{
				authors: [{ id: "__proto__", name: "Original" }],
				books: [{ id: "book/😀", title: "Boundary", authorId: "__proto__" }],
			},
		);
		try {
			const author = await db.authors.findById("__proto__");
			const canonicalBook = await db.books.findById("book/😀");
			const first = (await db.books.query({
				populate: { author: true, creditedAuthor: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			const second = (await db.books.query({
				populate: { author: true, creditedAuthor: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(first[0]).not.toBe(second[0]);
			expect(first[0]).not.toBe(canonicalBook);
			expect(first[0]?.author).toBe(author);
			expect(first[0]?.creditedAuthor).toBe(author);
			const firstBook = first[0];
			expect(firstBook).toBeDefined();
			if (firstBook === undefined) throw new Error("expected populated book");
			firstBook.title = "shell-only";
			expect((await db.books.findById("book/😀"))?.title).toBe("Boundary");
			(author as { name: string }).name = "Mutated through target";
			const afterMutation = (await db.books.query({
				populate: { author: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(afterMutation[0]?.author).toBe(author);
			expect((afterMutation[0]?.author as { name: string }).name).toBe(
				"Mutated through target",
			);
		} finally {
			await db.close();
		}
	});

	it("uses stable storage keys and shared live references for compact population", async () => {
		const LinkedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const db = await createEngineDatabase(
			{
				authors: { schema: AuthorSchema, relationships: {} },
				books: {
					schema: LinkedBookSchema,
					relationships: {
						author: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
					},
				},
			} as const,
			{
				authors: [
					{ id: "u1", name: "First" },
					{ id: "u2", name: "Second" },
				],
				books: [
					{ id: "b1", title: "One", authorId: "u1" },
					{ id: "b2", title: "Two", authorId: "u1" },
				],
			},
		);
		try {
			const first = await db.authors.findById("u1");
			const second = await db.authors.findById("u2");
			(first as { id: string }).id = "u2";
			const firstBook = await db.books.findById("b1");
			(firstBook as { id: string }).id = "b2";
			const rows = (await db.books.query({
				populate: { author: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(rows.map((row) => row.title)).toEqual(["One", "Two"]);
			expect(rows[0]?.author).toBe(first);
			expect(rows[1]?.author).toBe(first);
			expect(rows[0]?.author).not.toBe(second);
			(rows[0]?.author as { name: string }).name = "Shared";
			expect((rows[1]?.author as { name: string }).name).toBe("Shared");
			expect((await db.authors.findById("u1"))?.name).toBe("Shared");
		} finally {
			await db.close();
		}
	});

	it("materializes inverse arrays as shared canonical rows and explicit undefined refs", async () => {
		const ParentSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
		});
		const ChildSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			parentId: Schema.optional(Schema.NullOr(Schema.String)),
		});
		const db = await createEngineDatabase(
			{
				parents: {
					schema: ParentSchema,
					relationships: {
						children: {
							type: "inverse" as const,
							target: "children",
							foreignKey: "parentId",
						},
					},
				},
				children: {
					schema: ChildSchema,
					relationships: {
						parent: {
							type: "ref" as const,
							target: "parents",
							foreignKey: "parentId",
						},
					},
				},
			} as const,
			{
				parents: [{ id: "p1", name: "Parent" }],
				children: [
					{ id: "c1", name: "One", parentId: "p1" },
					{ id: "c2", name: "Two", parentId: "p1" },
					{ id: "c-null", name: "Null", parentId: null },
					{ id: "c-missing", name: "Missing" },
				],
			},
		);
		try {
			const canonicalOne = await db.children.findById("c1");
			const parents = (await db.parents.query({
				populate: { children: true },
			} as never)) as unknown as Array<{ children: Array<{ name: string }> }>;
			expect(parents[0]?.children.map((child: any) => child.id)).toEqual([
				"c1",
				"c2",
			]);
			expect(parents[0]?.children[0]).toBe(canonicalOne);
			parents[0]!.children[0]!.name = "Shared inverse";
			expect((await db.children.findById("c1"))?.name).toBe("Shared inverse");

			const unowned = (await db.children.query({
				where: { id: { $in: ["c-null", "c-missing"] } },
				populate: { parent: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			for (const row of unowned) {
				expect(Object.hasOwn(row, "parent")).toBe(true);
				expect(row.parent).toBeUndefined();
				expect(Object.keys(row).at(-1)).toBe("parent");
			}
			const selected = (await db.children.query({
				where: { id: "c1" },
				populate: { parent: true },
				select: { parent: { name: true }, name: true },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(Object.keys(selected[0] ?? {})).toEqual(["parent", "name"]);
			expect(Object.keys((selected[0]?.parent as object) ?? {})).toEqual([
				"name",
			]);
		} finally {
			await db.close();
		}
	});

	it("applies ordered nested selection after forward, inverse, and nested population", async () => {
		const CompanySchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			["__proto__"]: Schema.String,
		});
		const NestedAuthorSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			companyId: Schema.String,
		});
		const NestedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const company = Object.fromEntries([
			["id", "co1"],
			["name", "Company"],
			["__proto__", "ordinary-data"],
		]);
		const db = await createEngineDatabase(
			{
				companies: {
					schema: CompanySchema,
					relationships: {
						authors: {
							type: "inverse" as const,
							target: "authors",
							foreignKey: "companyId",
						},
					},
				},
				authors: {
					schema: NestedAuthorSchema,
					relationships: {
						company: {
							type: "ref" as const,
							target: "companies",
							foreignKey: "companyId",
						},
						books: {
							type: "inverse" as const,
							target: "books",
							foreignKey: "authorId",
						},
					},
				},
				books: {
					schema: NestedBookSchema,
					relationships: {
						author: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
					},
				},
			} as const,
			{
				companies: [company as { id: string; name: string; __proto__: string }],
				authors: [{ id: "a1", name: "Author", companyId: "co1" }],
				books: [{ id: "b1", title: "Book", authorId: "a1" }],
			},
		);
		try {
			const canonicalAuthor = await db.authors.findById("a1");
			const canonicalBook = await db.books.findById("b1");
			const select = Object.fromEntries([
				[
					"authors",
					Object.fromEntries([
						["books", { title: true }],
						["name", true],
					]),
				],
				["__proto__", true],
				["name", true],
			]);
			const rows = (await db.companies.query({
				populate: { authors: { books: true } },
				select,
			} as never)) as unknown as Array<Record<string, unknown>>;
			const selectedCompany = rows[0];
			if (selectedCompany === undefined) throw new Error("expected company");
			const selectedAuthor = (
				selectedCompany.authors as Array<Record<string, unknown>>
			)[0];
			if (selectedAuthor === undefined) throw new Error("expected author");
			const selectedBook = (
				selectedAuthor.books as Array<Record<string, unknown>>
			)[0];
			if (selectedBook === undefined) throw new Error("expected book");
			expect(Object.keys(selectedCompany)).toEqual([
				"authors",
				"__proto__",
				"name",
			]);
			expect(Object.keys(selectedAuthor)).toEqual(["books", "name"]);
			expect(Object.keys(selectedBook)).toEqual(["title"]);
			expect(selectedCompany).toEqual({
				authors: [{ books: [{ title: "Book" }], name: "Author" }],
				["__proto__"]: "ordinary-data",
				name: "Company",
			});
			expect(selectedCompany.id).toBeUndefined();
			expect(selectedAuthor.id).toBeUndefined();
			expect(selectedBook.id).toBeUndefined();
			expect(selectedAuthor).not.toBe(canonicalAuthor);
			expect(selectedBook).not.toBe(canonicalBook);

			const nestedRelationSelect = (await db.books.query({
				populate: { author: { company: { select: ["id"] } } },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(
				(nestedRelationSelect[0]?.author as Record<string, unknown>).company,
			).toEqual(company);

			const forward = (await db.books.query({
				populate: { author: { company: true } },
				select: { author: { company: { name: true }, name: true } },
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(forward).toEqual([
				{ author: { company: { name: "Company" }, name: "Author" } },
			]);

			const empty = (await db.companies.query({
				populate: { authors: { books: true } },
				select: {},
			} as never)) as unknown as Array<Record<string, unknown>>;
			expect(
				(empty[0]?.authors as Array<Record<string, unknown>>)[0]?.books,
			).toEqual([expect.objectContaining({ id: "b1", title: "Book" })]);
		} finally {
			await db.close();
		}
	});

	it("ignores relation-local select exactly like the direct TypeScript population stream", async () => {
		const LinkedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const config = {
			authors: { schema: AuthorSchema, relationships: {} },
			books: {
				schema: LinkedBookSchema,
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors",
						foreignKey: "authorId",
					},
				},
			},
		} as const;
		const initialData = {
			authors: [{ id: "a1", name: "Alice" }],
			books: [{ id: "b1", title: "Book", authorId: "a1" }],
		};
		const db = await createEngineDatabase(config, initialData);
		try {
			for (const select of [["id"], { id: true }] as const) {
				const direct = Array.from(
					await Effect.runPromise(
						Effect.gen(function* () {
							const authors = yield* Ref.make(
								new Map(initialData.authors.map((row) => [row.id, row])),
							);
							const books = yield* Ref.make(
								new Map(initialData.books.map((row) => [row.id, row])),
							);
							return yield* Stream.runCollect(
								Stream.fromIterable(initialData.books).pipe(
									applyPopulate(
										{ author: { select } } as never,
										{ authors, books },
										config as never,
										"books",
									),
								),
							);
						}),
					),
				);
				const wasm = (await db.books.query({
					populate: { author: { select } },
				} as never)) as unknown as Array<Record<string, unknown>>;
				expect(wasm).toEqual(direct);
				expect(wasm[0]?.author).toEqual({ id: "a1", name: "Alice" });
			}
		} finally {
			await db.close();
		}
	});

	it("keeps populated targets transaction-local and synchronizes them on commit", async () => {
		const LinkedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const db = await createEngineDatabase(
			{
				authors: { schema: AuthorSchema, relationships: {} },
				books: {
					schema: LinkedBookSchema,
					relationships: {
						author: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
					},
				},
			} as const,
			{
				authors: [{ id: "u1", name: "Before" }],
				books: [{ id: "b1", title: "One", authorId: "u1" }],
			},
		);
		try {
			await db.$transaction(async (tx) => {
				const rows = (await tx.books.query({
					populate: { author: true },
				} as never)) as unknown as Array<Record<string, unknown>>;
				const author = rows[0]?.author as { name: string };
				expect(author).toBe(await tx.authors.findById("u1"));
				author.name = "Committed";
				expect(
					(
						(await tx.books.query({
							populate: { author: true },
						} as never)) as unknown as Array<Record<string, unknown>>
					)[0]?.author,
				).toBe(author);
			});
			expect((await db.authors.findById("u1"))?.name).toBe("Committed");

			const failure = new Error("rollback populate");
			await expect(
				db.$transaction(async (tx) => {
					const rows = (await tx.books.query({
						populate: { author: true },
					} as never)) as unknown as Array<Record<string, unknown>>;
					(rows[0]?.author as { name: string }).name = "Rolled back";
					throw failure;
				}),
			).rejects.toBe(failure);
			expect((await db.authors.findById("u1"))?.name).toBe("Committed");
		} finally {
			await db.close();
		}
	});

	it("characterizes scalar callback order, edge values, query stages, and watches", async () => {
		const callbackTrace: string[] = [];
		const ComputedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
		});
		const db = await createEngineDatabase(
			{
				authors: { schema: AuthorSchema, relationships: {} },
				books: {
					schema: ComputedBookSchema,
					relationships: {
						author: {
							type: "ref" as const,
							target: "authors",
							foreignKey: "authorId",
						},
					},
					computed: {
						edgeValue: (book: { readonly id: string }) => {
							callbackTrace.push(`${book.id}:edgeValue`);
							switch (book.id) {
								case "b1":
									return undefined;
								case "b2":
									return { __proseqlUndefined__: 1 };
								case "b3":
									return 3.5;
								default:
									return "mixed";
							}
						},
						authorLabel: (book: {
							readonly id: string;
							readonly title: string;
							readonly author?: { readonly name?: string };
						}) => {
							callbackTrace.push(`${book.id}:authorLabel`);
							return `${book.id}:${book.author?.name ?? "missing"}:${book.title}`;
						},
					},
				},
			} as const,
			{
				authors: [{ id: "a1", name: "Author" }],
				books: [
					{ id: "b1", title: "One", authorId: "a1" },
					{ id: "b2", title: "Two", authorId: "a1" },
					{ id: "b3", title: "Three", authorId: "a1" },
					{ id: "b4", title: "Four", authorId: "a1" },
				],
			},
		);
		try {
			callbackTrace.length = 0;
			const rows = (await db.books.query({
				populate: { author: true },
				sort: { id: "asc" },
				offset: 1,
				limit: 2,
				select: ["id", "edgeValue", "authorLabel"],
			} as never)) as unknown as ReadonlyArray<Record<string, unknown>>;
			expect(callbackTrace).toEqual([
				"b1:edgeValue",
				"b1:authorLabel",
				"b2:edgeValue",
				"b2:authorLabel",
				"b3:edgeValue",
				"b3:authorLabel",
				"b4:edgeValue",
				"b4:authorLabel",
			]);
			expect(rows).toEqual([
				{
					id: "b2",
					edgeValue: { __proseqlUndefined__: 1 },
					authorLabel: "b2:Author:Two",
				},
				{ id: "b3", edgeValue: 3.5, authorLabel: "b3:Author:Three" },
			]);

			callbackTrace.length = 0;
			expect(
				await db.books.query({ select: { id: true, title: true } } as never),
			).toEqual([
				{ id: "b1", title: "One" },
				{ id: "b2", title: "Two" },
				{ id: "b3", title: "Three" },
				{ id: "b4", title: "Four" },
			]);
			expect(callbackTrace).toEqual([]);

			callbackTrace.length = 0;
			expect(await db.books.query({ select: ["id"] } as never)).toEqual([
				{ id: "b1" },
				{ id: "b2" },
				{ id: "b3" },
				{ id: "b4" },
			]);
			expect(callbackTrace).toEqual([
				"b1:edgeValue",
				"b1:authorLabel",
				"b2:edgeValue",
				"b2:authorLabel",
				"b3:edgeValue",
				"b3:authorLabel",
				"b4:edgeValue",
				"b4:authorLabel",
			]);

			callbackTrace.length = 0;
			const undefinedRow = (await db.books.query({
				populate: { author: true },
				where: { id: "b1" },
			} as never)) as unknown as ReadonlyArray<Record<string, unknown>>;
			expect(Object.hasOwn(undefinedRow[0] ?? {}, "edgeValue")).toBe(true);
			expect(undefinedRow[0]?.edgeValue).toBeUndefined();

			callbackTrace.length = 0;
			const edgeWatch = db.books.watch({
				sort: { id: "asc" },
				select: ["id", "edgeValue"],
			} as never);
			const edgeInitial = (await edgeWatch.next()).value;
			expect(edgeInitial).toEqual([
				{ id: "b1", edgeValue: undefined },
				{ id: "b2", edgeValue: { __proseqlUndefined__: 1 } },
				{ id: "b3", edgeValue: 3.5 },
				{ id: "b4", edgeValue: "mixed" },
			]);
			expect(Object.hasOwn(edgeInitial?.[0] ?? {}, "edgeValue")).toBe(true);
			await edgeWatch.unsubscribe();

			callbackTrace.length = 0;
			const watch = db.books.watch({
				where: { id: "b4" },
				select: ["id", "authorLabel"],
				debounceMs: 5,
			} as never);
			expect((await watch.next()).value).toEqual([
				{ id: "b4", authorLabel: "b4:missing:Four" },
			]);
			callbackTrace.length = 0;
			await db.books.update("b4", { title: "Changed" });
			expect((await watch.next()).value).toEqual([
				{ id: "b4", authorLabel: "b4:missing:Changed" },
			]);
			expect(callbackTrace).toEqual([
				"b1:edgeValue",
				"b1:authorLabel",
				"b2:edgeValue",
				"b2:authorLabel",
				"b3:edgeValue",
				"b3:authorLabel",
				"b4:edgeValue",
				"b4:authorLabel",
			]);
			await watch.unsubscribe();
		} finally {
			await db.close();
		}
	});

	it("stops computed and custom-operator callbacks at the first throwing row", async () => {
		const computedTrace: string[] = [];
		const computedDb = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					computed: {
						marker: (user: { readonly id: string }) => {
							computedTrace.push(user.id);
							if (user.id === "u3") throw new Error("computed-u3");
							return user.id;
						},
					},
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "one" },
					{ id: "u2", name: "two" },
					{ id: "u3", name: "three" },
					{ id: "u4", name: "four" },
				],
			},
		);
		try {
			await expect(computedDb.users.query()).rejects.toMatchObject({
				name: "WasmEngineDefectError",
				message: "unexpected defect: computedCallback: computed-u3",
			});
			expect(computedTrace).toEqual(["u1", "u2", "u3"]);
		} finally {
			await computedDb.close().catch(() => undefined);
		}

		const operatorTrace: string[] = [];
		const operatorDb = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{
				users: [
					{ id: "u1", name: "one" },
					{ id: "u2", name: "two" },
					{ id: "u3", name: "boom" },
					{ id: "u4", name: "four" },
				],
			},
			{
				plugins: [
					{
						name: "throwing-operator",
						operators: [
							{
								name: "$trace",
								types: ["string"] as const,
								evaluate: (fieldValue: unknown) => {
									operatorTrace.push(String(fieldValue));
									if (fieldValue === "boom") throw new Error("operator-u3");
									return true;
								},
							},
						],
					},
				],
			},
		);
		try {
			await expect(
				operatorDb.users.query({ where: { name: { $trace: true } } } as never),
			).rejects.toMatchObject({
				name: "WasmEngineDefectError",
				message: "unexpected defect: customOperatorCallback: operator-u3",
			});
			expect(operatorTrace).toEqual(["one", "two", "boom"]);
		} finally {
			await operatorDb.close().catch(() => undefined);
		}
	});

	it("keeps custom-operator bulk defects entirely pre-write", async () => {
		const operatorTrace: string[] = [];
		const db = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					indexes: ["name"],
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "one" },
					{ id: "u2", name: "two" },
					{ id: "u3", name: "boom" },
					{ id: "u4", name: "four" },
				],
			},
			{
				plugins: [
					{
						name: "throwing-bulk-operator",
						operators: [
							{
								name: "$traceBulk",
								types: ["string"] as const,
								evaluate: (fieldValue: unknown) => {
									operatorTrace.push(String(fieldValue));
									if (fieldValue === "boom") {
										throw new Error("bulk-operator-u3");
									}
									return true;
								},
							},
						],
					},
				],
			},
		);
		const watch = db.users.watch({ debounceMs: 0 });
		try {
			expect((await watch.next()).value?.map((row) => row.name)).toEqual([
				"one",
				"two",
				"boom",
				"four",
			]);
			let watchSettled = false;
			const pendingWatch = watch.next().finally(() => {
				watchSettled = true;
			});

			await expect(
				db.users.updateMany({ name: { $traceBulk: true } } as never, {
					name: "changed",
				}),
			).rejects.toEqual(
				new WasmEngineDefectError(
					"unexpected defect: customOperatorCallback: bulk-operator-u3",
				),
			);
			expect(operatorTrace).toEqual(["one", "two", "boom"]);
			expect((await db.users.query()).map((row) => [row.id, row.name])).toEqual(
				[
					["u1", "one"],
					["u2", "two"],
					["u3", "boom"],
					["u4", "four"],
				],
			);
			expect(
				(await db.users.query({ where: { name: "one" } })).map((row) => row.id),
			).toEqual(["u1"]);
			await sleep(10);
			expect(watchSettled).toBe(false);

			operatorTrace.length = 0;
			await expect(
				db.users.deleteManyWithRelationships(
					{ name: { $traceBulk: true } } as never,
					{},
				),
			).rejects.toEqual(
				new WasmEngineDefectError(
					"unexpected defect: customOperatorCallback: bulk-operator-u3",
				),
			);
			expect(operatorTrace).toEqual(["one", "two", "boom"]);
			expect((await db.users.query()).map((row) => row.id)).toEqual([
				"u1",
				"u2",
				"u3",
				"u4",
			]);

			operatorTrace.length = 0;
			await expect(
				db.users.deleteMany({ name: { $traceBulk: true } } as never),
			).rejects.toEqual(
				new WasmEngineDefectError(
					"unexpected defect: customOperatorCallback: bulk-operator-u3",
				),
			);
			expect(operatorTrace).toEqual(["one", "two", "boom"]);
			expect((await db.users.query()).map((row) => row.id)).toEqual([
				"u1",
				"u2",
				"u3",
				"u4",
			]);
			await sleep(10);
			expect(watchSettled).toBe(false);
			await watch.unsubscribe();
			await pendingWatch;
		} finally {
			await watch.unsubscribe().catch(() => undefined);
			await db.close().catch(() => undefined);
		}
	});

	it("terminates computed watches with the original initial and update callback defect", async () => {
		const initialTrace: string[] = [];
		const initialDb = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					computed: {
						marker: (user: { readonly id: string }) => {
							initialTrace.push(user.id);
							if (user.id === "u2") throw new Error("watch-initial-u2");
							return user.id;
						},
					},
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "one" },
					{ id: "u2", name: "two" },
				],
			},
		);
		try {
			const watch = initialDb.users.watch({ debounceMs: 0 } as never);
			const firstFailure = await watch.next().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(firstFailure).toBeInstanceOf(WasmEngineDefectError);
			expect((firstFailure as Error).name).toBe("WasmEngineDefectError");
			expect((firstFailure as Error).message).toBe(
				"unexpected defect: computedCallback: watch-initial-u2",
			);
			expect(initialTrace).toEqual(["u1", "u2"]);
			const firstStack = (firstFailure as Error).stack;
			(firstFailure as Error).message = "consumer-mutated";
			const secondFailure = await watch.next().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(secondFailure).not.toBe(firstFailure);
			expect(secondFailure).toBeInstanceOf(WasmEngineDefectError);
			expect((secondFailure as Error).name).toBe("WasmEngineDefectError");
			expect((secondFailure as Error).message).toBe(
				"unexpected defect: computedCallback: watch-initial-u2",
			);
			expect((secondFailure as Error).stack).toBe(firstStack);
			await watch.unsubscribe();
		} finally {
			await initialDb.close().catch(() => undefined);
		}

		const updateTrace: string[] = [];
		const updateDb = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					computed: {
						marker: (user: { readonly id: string; readonly name: string }) => {
							updateTrace.push(`${user.id}:${user.name}`);
							if (user.name === "boom") throw new Error("watch-update-u2");
							return user.id;
						},
					},
				},
			} as const,
			{
				users: [
					{ id: "u1", name: "one" },
					{ id: "u2", name: "two" },
				],
			},
		);
		try {
			const watch = updateDb.users.watch({ debounceMs: 0 } as never);
			const queuedWatch = updateDb.users.watch({ debounceMs: 0 } as never);
			expect((await watch.next()).done).toBe(false);
			const pendingFailure = watch.next();
			await updateDb.users.update("u2", { name: "boom" });
			const pendingError = await pendingFailure.then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(pendingError).toBeInstanceOf(WasmEngineDefectError);
			expect((pendingError as Error).name).toBe("WasmEngineDefectError");
			expect((pendingError as Error).message).toBe(
				"unexpected defect: computedCallback: watch-update-u2",
			);
			expect((await queuedWatch.next()).value).toEqual([
				{ id: "u1", name: "one", marker: "u1" },
				{ id: "u2", name: "two", marker: "u2" },
			]);
			const queuedError = await queuedWatch.next().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(queuedError).toBeInstanceOf(WasmEngineDefectError);
			expect((queuedError as Error).name).toBe("WasmEngineDefectError");
			expect((queuedError as Error).message).toBe(
				"unexpected defect: computedCallback: watch-update-u2",
			);
			expect(updateTrace).toEqual([
				"u1:one",
				"u2:two",
				"u1:one",
				"u2:two",
				"u1:one",
				"u2:boom",
				"u1:one",
				"u2:boom",
			]);
			await watch.unsubscribe();
			await queuedWatch.unsubscribe();
		} finally {
			await updateDb.close().catch(() => undefined);
		}
	});

	it("authorizes numeric fast finds by descriptor order and current storage token", async () => {
		const db = await createEngineDatabase(
			{
				users: { schema: UserSchema, relationships: {} },
				posts: {
					schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
					relationships: {},
				},
			} as const,
			{
				users: [{ id: "u1", name: "Alice" }],
				posts: [{ id: "p1", title: "Hello" }],
			},
		);
		try {
			const post = await db.posts.findById("p1");
			expect(await db.posts.findById("p1")).toBe(post);

			const user = await db.users.findById("u1");
			user.id = "caller-mutated";
			expect(await db.users.findById("u1")).toBe(user);

			expect(await db.users.delete("u1")).toBe(user);
			const replacement = await db.users.create({ id: "u2", name: "Bob" });
			expect(await db.users.findById("u2")).toBe(replacement);
			await expect(db.users.findById("u1")).rejects.toMatchObject({
				_tag: "NotFoundError",
				id: "u1",
			});
		} finally {
			await db.close();
		}
	});

	it("contains reentrant fast-find export failures behind the canonical defect bridge", async () => {
		let reentrantRead:
			| (() => Promise<{ id: string; name: string }>)
			| undefined;
		let nestedRead: Promise<{ id: string; name: string }> | undefined;
		const db = await createEngineDatabase(
			{
				users: { schema: UserSchema, relationships: {} },
			} as const,
			{ users: [{ id: "u1", name: "Alice" }] },
			{
				plugins: [
					{
						name: "reentrant-fast-find",
						operators: [
							{
								name: "$reentrantMatch",
								types: ["string"] as const,
								evaluate: () => {
									nestedRead = reentrantRead?.();
									void nestedRead?.catch(() => undefined);
									return true;
								},
							},
						],
					},
				],
			},
		);
		try {
			reentrantRead = () => db.users.findById("u1");
			await db.users.findById("u1");
			await expect(
				db.users.query({
					where: { name: { $reentrantMatch: true } },
				} as never),
			).resolves.toHaveLength(1);
			expect(nestedRead).toBeDefined();
			await expect(nestedRead).rejects.toBeInstanceOf(WasmEngineDefectError);
		} finally {
			await db.close();
		}
	});

	it("surfaces malformed cursor input as rejected Promises for normal and transaction queries", async () => {
		const { db } = await createPromiseWrapperDatabase();
		try {
			let queryPromise: ReturnType<typeof db.users.query> | undefined;
			expect(() => {
				queryPromise = db.users.query({
					cursor: { key: "id", limit: 0 },
					sort: { id: "asc" },
				} as never);
			}).not.toThrow();
			await expect(queryPromise).rejects.toBeInstanceOf(ValidationError);
			await expect(
				db.$transaction(async (tx) => {
					let txQueryPromise: ReturnType<typeof tx.users.query> | undefined;
					expect(() => {
						txQueryPromise = tx.users.query({
							cursor: { key: "id", limit: 0 },
							sort: { id: "asc" },
						} as never);
					}).not.toThrow();
					await expect(txQueryPromise).rejects.toBeInstanceOf(ValidationError);
				}),
			).resolves.toBeUndefined();
		} finally {
			await db.close();
		}
	});

	it("keeps real tagged engine errors tagged and callback defects in the defect channel", async () => {
		const { db } = await createPromiseWrapperDatabase();
		try {
			await expect(
				db.users.create({ id: "u1", name: "Again" }),
			).rejects.toBeInstanceOf(DuplicateKeyError);
			await expect(
				db.users.create({ id: "u1", name: "Again" }),
			).rejects.toMatchObject({
				_tag: "DuplicateKeyError",
				existingId: "u1",
			});
		} finally {
			await db.close();
		}

		const defectDb = await createEngineDatabase(
			{
				users: {
					schema: UserSchema,
					relationships: {},
					hooks: {
						beforeCreate: [
							() => {
								throw new Error("hook defect: boom");
							},
						],
						beforeDelete: [
							() => {
								throw new Error("delete hook defect: boom");
							},
						],
					},
				},
			} as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		try {
			await expect(
				defectDb.users.create({ id: "u2", name: "Bob" }),
			).rejects.toBeInstanceOf(WasmEngineDefectError);
			await expect(
				defectDb.users.create({ id: "u2", name: "Bob" }),
			).rejects.toMatchObject({
				name: "WasmEngineDefectError",
				message: expect.stringContaining("hook defect: boom"),
			});
			await expect(defectDb.users.delete("u1")).rejects.toMatchObject({
				name: "WasmEngineDefectError",
				message: expect.stringContaining("delete hook defect: boom"),
			});
			await expect(defectDb.users.findById("u1")).resolves.toMatchObject({
				id: "u1",
			});
		} finally {
			await defectDb.close();
		}
	});

	it("preserves legitimate null defaults across the public WASM callback boundary", async () => {
		const runtime = await createPublicWasmRuntime();
		runtime.register_default("users.nickname.default", () => "null");
		const handle = await createRawDatabase(
			runtime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{
							name: "nickname",
							schema: {
								kind: "optionalWithDefault",
								inner: { kind: "nullOr", inner: { kind: "str" } },
								defaultCallbackId: "users.nickname.default",
							},
						},
					],
				},
			}),
		);
		await expect(
			dispatchRaw<Record<string, unknown>>(runtime, handle, "create", {
				collection: "users",
				data: { id: "u1" },
			}),
		).resolves.toEqual({ id: "u1", nickname: null });
		await expect(
			dispatchRaw<{ created: ReadonlyArray<Record<string, unknown>> }>(
				runtime,
				handle,
				"createMany",
				{
					collection: "users",
					items: [{ id: "u2" }, { id: "u3", nickname: "explicit" }],
				},
			),
		).resolves.toEqual({
			created: [
				{ id: "u2", nickname: null },
				{ id: "u3", nickname: "explicit" },
			],
			skipped: [],
		});
	});

	it("rejects invalid default and id-generator callback returns via WasmEngineDefectError", async () => {
		const defaultRuntime = await createPublicWasmRuntime();
		defaultRuntime.register_default("users.nickname.default", () => 42);
		const defaultHandle = await createRawDatabase(
			defaultRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{
							name: "nickname",
							schema: {
								kind: "optionalWithDefault",
								inner: { kind: "str" },
								defaultCallbackId: "users.nickname.default",
							},
						},
					],
				},
			}),
		);
		await expect(
			dispatchRaw<Record<string, unknown>>(
				defaultRuntime,
				defaultHandle,
				"create",
				{
					collection: "users",
					data: { id: "u1" },
				},
			),
		).rejects.toBeInstanceOf(WasmEngineDefectError);

		const idRuntime = await createPublicWasmRuntime();
		idRuntime.register_id_generator("generated", () => 42);
		const idHandle = await createRawDatabase(
			idRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
				idStrategy: { kind: "namedGenerator", name: "generated" },
			}),
		);
		await expect(
			dispatchRaw<Record<string, unknown>>(idRuntime, idHandle, "create", {
				collection: "users",
				data: { name: "Alice" },
			}),
		).rejects.toBeInstanceOf(WasmEngineDefectError);
	});

	it("preserves legitimate false predicate and custom-operator results across the public WASM boundary", async () => {
		const predicateRuntime = await createPublicWasmRuntime();
		predicateRuntime.register_predicate("remove-none", () => "false");
		const predicateHandle = await createRawDatabase(
			predicateRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{
							name: "scores",
							schema: { kind: "array", item: { kind: "num" } },
						},
					],
				},
			}),
			{ users: [{ id: "u1", scores: [1, 2, 3] }] },
		);
		await expect(
			dispatchRaw(predicateRuntime, predicateHandle, "updateMany", {
				collection: "users",
				where: {},
				data: { scores: { $removeBy: "remove-none" } },
			}),
		).resolves.toMatchObject({ count: 1 });
		await expect(
			dispatchRaw<ReadonlyArray<{ readonly scores: ReadonlyArray<number> }>>(
				predicateRuntime,
				predicateHandle,
				"dumpCollection",
				{ collection: "users" },
			),
		).resolves.toEqual([{ id: "u1", scores: [1, 2, 3] }]);

		const operatorRuntime = await createPublicWasmRuntime();
		await expect(
			runPublicWasm(() =>
				operatorRuntime.register_custom_operator(
					"$never",
					JSON.stringify(["string"]),
					() => false,
				),
			),
		).resolves.toEqual(true);
		const operatorHandle = await createRawDatabase(
			operatorRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
			}),
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			dispatchRaw<ReadonlyArray<unknown>>(
				operatorRuntime,
				operatorHandle,
				"query",
				{
					collection: "users",
					query: { where: { name: { $never: "Al" } } },
				},
			),
		).resolves.toEqual([]);
	});

	it("rejects invalid predicate and custom-operator callback returns via WasmEngineDefectError", async () => {
		const predicateRuntime = await createPublicWasmRuntime();
		predicateRuntime.register_predicate("broken-predicate", () => "nope");
		const predicateHandle = await createRawDatabase(
			predicateRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{
							name: "scores",
							schema: { kind: "array", item: { kind: "num" } },
						},
					],
				},
			}),
			{ users: [{ id: "u1", scores: [1, 2, 3] }] },
		);
		await expect(
			dispatchRaw(predicateRuntime, predicateHandle, "updateMany", {
				collection: "users",
				where: {},
				data: { scores: { $removeBy: "broken-predicate" } },
			}),
		).rejects.toBeInstanceOf(WasmEngineDefectError);

		const operatorRuntime = await createPublicWasmRuntime();
		await expect(
			runPublicWasm(() =>
				operatorRuntime.register_custom_operator(
					"$broken",
					JSON.stringify(["string"]),
					() => "false",
				),
			),
		).resolves.toEqual(true);
		const operatorHandle = await createRawDatabase(
			operatorRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
			}),
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			dispatchRaw<ReadonlyArray<unknown>>(
				operatorRuntime,
				operatorHandle,
				"query",
				{
					collection: "users",
					query: { where: { name: { $broken: "Al" } } },
				},
			),
		).rejects.toBeInstanceOf(WasmEngineDefectError);
	});

	it("preserves legitimate empty computed results and equal collator results across the public WASM boundary", async () => {
		const computedRuntime = await createPublicWasmRuntime();
		computedRuntime.register_computed("users.tags", () => "[]");
		const computedHandle = await createRawDatabase(
			computedRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
				computedFields: [{ name: "tags", callback_id: "users.tags" }],
			}),
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			dispatchRaw<ReadonlyArray<Record<string, unknown>>>(
				computedRuntime,
				computedHandle,
				"query",
				{
					collection: "users",
					query: {},
				},
			),
		).resolves.toEqual([{ id: "u1", name: "Alice", tags: [] }]);

		const collatorRuntime = await createPublicWasmRuntime();
		collatorRuntime.register_collator(() => 0);
		const collatorHandle = await createRawDatabase(
			collatorRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
			}),
			{
				users: [
					{ id: "u2", name: "Beta" },
					{ id: "u1", name: "Alpha" },
				],
			},
		);
		await expect(
			dispatchRaw<ReadonlyArray<Record<string, unknown>>>(
				collatorRuntime,
				collatorHandle,
				"query",
				{
					collection: "users",
					query: { sort: { name: "asc" } },
				},
			),
		).resolves.toEqual([
			{ id: "u2", name: "Beta" },
			{ id: "u1", name: "Alpha" },
		]);
	});

	it("does not invoke later query callbacks after the first callback defect", async () => {
		const computedTrace: string[] = [];
		const computedRuntime = await createPublicWasmRuntime();
		computedRuntime.register_computed("users.early", (payloadJson) => {
			const row = JSON.parse(payloadJson) as { readonly id: string };
			computedTrace.push(`early:${row.id}`);
			throw new Error("first-computed-defect");
		});
		computedRuntime.register_computed("users.later", (payloadJson) => {
			const row = JSON.parse(payloadJson) as { readonly id: string };
			computedTrace.push(`later:${row.id}`);
			return JSON.stringify(row.id);
		});
		computedRuntime.register_collator((left, right) => {
			computedTrace.push(`collator:${left}:${right}`);
			return left.localeCompare(right);
		});
		const computedHandle = await createRawDatabase(
			computedRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
				computedFields: [
					{ name: "early", callback_id: "users.early" },
					{ name: "later", callback_id: "users.later" },
				],
			}),
			{
				users: [
					{ id: "u1", name: "Beta" },
					{ id: "u2", name: "Alpha" },
				],
			},
		);
		await expect(
			dispatchRaw(computedRuntime, computedHandle, "query", {
				collection: "users",
				query: { sort: { name: "asc" } },
			}),
		).rejects.toMatchObject({
			name: "WasmEngineDefectError",
			message: "unexpected defect: computedCallback: first-computed-defect",
		});
		expect(computedTrace).toEqual(["early:u1"]);

		const operatorTrace: string[] = [];
		const operatorRuntime = await createPublicWasmRuntime();
		await runPublicWasm(() =>
			operatorRuntime.register_custom_operator(
				"$traceThenThrow",
				JSON.stringify(["string"]),
				(fieldJson) => {
					const field = JSON.parse(fieldJson) as string;
					operatorTrace.push(`operator:${field}`);
					if (field === "boom") throw new Error("first-operator-defect");
					return true;
				},
			),
		);
		operatorRuntime.register_collator((left, right) => {
			operatorTrace.push(`collator:${left}:${right}`);
			return left.localeCompare(right);
		});
		const operatorHandle = await createRawDatabase(
			operatorRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
			}),
			{
				users: [
					{ id: "u1", name: "Beta" },
					{ id: "u2", name: "Alpha" },
					{ id: "u3", name: "boom" },
					{ id: "u4", name: "Later" },
				],
			},
		);
		await expect(
			dispatchRaw(operatorRuntime, operatorHandle, "query", {
				collection: "users",
				query: {
					where: { name: { $traceThenThrow: true } },
					sort: { name: "asc" },
				},
			}),
		).rejects.toMatchObject({
			name: "WasmEngineDefectError",
			message:
				"unexpected defect: customOperatorCallback: first-operator-defect",
		});
		expect(operatorTrace).toEqual([
			"operator:Beta",
			"operator:Alpha",
			"operator:boom",
		]);
	});

	it("rejects invalid computed and collator callback returns via WasmEngineDefectError", async () => {
		const computedRuntime = await createPublicWasmRuntime();
		computedRuntime.register_computed("users.tags", () => "not-json");
		const computedHandle = await createRawDatabase(
			computedRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
				computedFields: [{ name: "tags", callback_id: "users.tags" }],
			}),
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			dispatchRaw<ReadonlyArray<Record<string, unknown>>>(
				computedRuntime,
				computedHandle,
				"query",
				{
					collection: "users",
					query: {},
				},
			),
		).rejects.toBeInstanceOf(WasmEngineDefectError);

		const collatorRuntime = await createPublicWasmRuntime();
		collatorRuntime.register_collator(() => "equal");
		const collatorHandle = await createRawDatabase(
			collatorRuntime,
			createRawCollectionDescriptor({
				schema: {
					kind: "struct",
					fields: [
						{ name: "id", schema: { kind: "str" } },
						{ name: "name", schema: { kind: "str" } },
					],
				},
			}),
			{
				users: [
					{ id: "u2", name: "Beta" },
					{ id: "u1", name: "Alpha" },
				],
			},
		);
		await expect(
			dispatchRaw<ReadonlyArray<Record<string, unknown>>>(
				collatorRuntime,
				collatorHandle,
				"query",
				{
					collection: "users",
					query: { sort: { name: "asc" } },
				},
			),
		).rejects.toBeInstanceOf(WasmEngineDefectError);
	});

	it("returns a defect response when a production-profile WASM artifact hits a Rust panic", async () => {
		const productionModule = (await import(
			`${pathToFileURL(resolve(WORKTREE_ROOT, "packages/engine/dist/wasm/proseql_wasm.js")).href}?t=${Date.now()}`
		)) as Record<string, unknown>;
		expect(productionModule).not.toHaveProperty("__proseql_test_panic_bridge");

		const panicTestModule = (await import(
			`${pathToFileURL(resolve(WORKTREE_ROOT, "packages/engine/build/wasm-panic-test/proseql_wasm.js")).href}?t=${Date.now()}`
		)) as {
			readonly __proseql_test_panic_bridge: () => string;
		};
		expect(typeof panicTestModule.__proseql_test_panic_bridge).toBe("function");
		expect(
			JSON.parse(panicTestModule.__proseql_test_panic_bridge()),
		).toMatchObject({
			kind: "defect",
			message: expect.stringContaining("proseql wasm panic integration"),
		});
	});

	it("surfaces invalid query failures as Promise rejections instead of synchronous throws", async () => {
		const db = await createEngineDatabase(
			{ users: { schema: UserSchema, relationships: {} } } as const,
			{ users: [{ id: "u1", name: "Alice" }] },
		);
		await expect(
			db.users.query({
				cursor: { key: "id", limit: 1 },
				sort: { name: "asc" },
			} as any),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			db.users.aggregate({ groupBy: ["missing"] } as any),
		).resolves.toBeTruthy();
	});

	it("reports real dry-run migration status for persistent files", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-engine-u8-dry-run-"));
		try {
			const currentFile = join(root, "users.json");
			const missingFile = join(root, "teams.json");
			await writeFile(
				currentFile,
				JSON.stringify({ _version: 1, u1: { id: "u1", name: "Alice" } }),
			);
			const db = await createPersistentEngineDatabase({
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
						{
							from: 0,
							to: 1,
							description: "step-1",
							transform: (data) => data,
						},
						{
							from: 1,
							to: 2,
							description: "step-2",
							transform: (data) => data,
						},
					],
					relationships: {},
				},
			} as const);
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
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts source reload when the pre-reload flush fails and keeps the active runtime state", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "proseql-engine-u8-source-flush-"),
		);
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
			await writeFile(
				basePath,
				"users:\n  u1:\n    id: u1\n    name: External\n",
			);
			await sleep(250);
			expect(await db.users.findById("u1")).toEqual({
				id: "u1",
				name: "Local",
			});
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
			expect(host.writes.filter((entry) => entry.path === file)).toHaveLength(
				1,
			);
			expect(await db.users.findById("u1")).toEqual({
				id: "u1",
				name: "Updated",
			});
			await watch.unsubscribe();
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reloads legacy file and shared-file collections on external edits and emits watch updates", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "proseql-engine-u8-legacy-files-"),
		);
		try {
			const usersFile = join(root, "users.json");
			const sharedFile = join(root, "shared.json");
			await writeFile(
				usersFile,
				JSON.stringify({ u1: { id: "u1", name: "Alice" } }),
			);
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
					authors: {
						schema: AuthorSchema,
						file: sharedFile,
						relationships: {},
					},
					books: { schema: BookSchema, file: sharedFile, relationships: {} },
				} as const,
				undefined,
				{ writeDebounce: 5 },
			);
			const userWatch = db.users.watch();
			const bookWatch = db.books.watch();
			await userWatch.next();
			await bookWatch.next();
			const beforeReload = await db.users.findById("u1");
			await writeFile(
				usersFile,
				JSON.stringify({ u1: { id: "u1", name: "Updated" } }),
			);
			await waitFor(async () => {
				expect(await db.users.findById("u1")).toEqual({
					id: "u1",
					name: "Updated",
				});
			});
			const afterReload = await db.users.findById("u1");
			expect(afterReload).not.toBe(beforeReload);
			expect((await userWatch.next()).value?.[0]?.name).toBe("Updated");
			await writeFile(
				sharedFile,
				JSON.stringify({
					authors: { a1: { id: "a1", name: "Frank Herbert" } },
					books: { b1: { id: "b1", title: "Dune Messiah", year: 1969 } },
				}),
			);
			await waitFor(async () => {
				expect(await db.books.findById("b1")).toEqual({
					id: "b1",
					title: "Dune Messiah",
					year: 1969,
				});
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
			await writeFile(
				join(teamsDir, "t1.json"),
				JSON.stringify({ id: "t1", name: "Alpha" }),
			);
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
			await writeFile(
				join(teamsDir, "t1.json"),
				JSON.stringify({ id: "t1", name: "Beta" }),
			);
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
			await writeFile(
				join(teamsDir, "t1.json"),
				JSON.stringify({ id: "t1", name: "Gamma" }),
			);
			await sleep(250);
			expect(await db.teams.findById("t1")).toEqual({
				id: "t1",
				name: "Gamma",
			});
			expect((await nextEmission).value?.[0]?.name).toBe("Gamma");
			await db.close();
			await writeFile(
				join(teamsDir, "t1.json"),
				JSON.stringify({ id: "t1", name: "Delta" }),
			);
			await sleep(250);
			const raced = await Promise.race([
				watch.next(),
				sleep(100).then(
					() =>
						({ done: true }) as IteratorResult<
							ReadonlyArray<{ id: string; name: string }>
						>,
				),
			]);
			expect(raced.done).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("awaits in-flight external reloads during close and ignores stale watcher callbacks after shutdown", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "proseql-engine-u8-close-drain-"),
		);
		try {
			const file = join(root, "users.json");
			await writeFile(
				file,
				JSON.stringify({ u1: { id: "u1", name: "Alice" } }),
			);
			const host = createTriggerableFileWatchHost(root);
			const db = await createPersistentEngineDatabase(
				{
					users: {
						schema: UserSchema,
						file,
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
			const watchCallback = host.watchCallbackFor(file);
			expect(watchCallback).toBeTypeOf("function");
			const gate = host.blockNextRead(file);
			watchCallback?.();
			await gate.started;
			let closed = false;
			const closePromise = db.close().then(() => {
				closed = true;
			});
			await sleep(25);
			expect(closed).toBe(false);
			gate.release();
			await closePromise;
			const readsAfterClose = host.readCountFor(file);
			watchCallback?.();
			await sleep(25);
			expect(host.readCountFor(file)).toBe(readsAfterClose);
			await rm(root, { recursive: true, force: true });
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
							schema: Schema.Struct({
								id: Schema.String,
								title: Schema.String,
							}),
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
			const predicateBulk = Symbol.for(
				"@proseql/engine/predicate-bulk-operation",
			);
			const invokePredicateBulk = (
				collection: unknown,
				method: "updateMany" | "deleteMany",
				selectIds: (
					rows: ReadonlyArray<Record<string, unknown>>,
				) => ReadonlyArray<string>,
				data?: unknown,
			) =>
				(
					collection as Record<
						symbol,
						(
							method: "updateMany" | "deleteMany",
							selectIds: (
								rows: ReadonlyArray<Record<string, unknown>>,
							) => ReadonlyArray<string>,
							data: unknown,
						) => Promise<unknown>
					>
				)[predicateBulk](method, selectIds, data);

			await db.users.query();
			await invokePredicateBulk(
				db.users,
				"updateMany",
				(rows) =>
					rows.filter((row) => row.id === "u1").map((row) => String(row.id)),
				{ name: "Predicate Updated" },
			);
			await db.posts.create({ id: "p1", title: "Post" });
			await db.flush();
			expect(await readFile(join(docsRoot, "base.yaml"), "utf8")).toContain(
				"name: Predicate Updated",
			);
			expect(
				await readFile(join(docsRoot, "generated.yaml"), "utf8"),
			).toContain("posts:");
			expect(
				await readFile(join(docsRoot, "generated.yaml"), "utf8"),
			).toContain("p1:");
			expect(await db.books.findById("b1")).toEqual({
				id: "b1",
				title: "Overlay",
				year: 1966,
			});
			expect(
				await db.$documentGraph.getRecordProvenance("books", "b1"),
			).toBeTruthy();
			await expect(
				db.books.create({ id: "b2", title: "Nope", year: 2000 }),
			).rejects.toBeInstanceOf(OperationError);
			let readOnlyPredicateCalls = 0;
			await expect(
				invokePredicateBulk(
					db.books,
					"updateMany",
					(rows) => {
						readOnlyPredicateCalls += rows.length;
						return rows.map((row) => String(row.id));
					},
					{ title: "Nope" },
				),
			).rejects.toMatchObject({ reason: "read-only-source" });
			await expect(
				invokePredicateBulk(db.books, "deleteMany", (rows) => {
					readOnlyPredicateCalls += rows.length;
					return rows.map((row) => String(row.id));
				}),
			).rejects.toMatchObject({ reason: "read-only-source" });
			expect(readOnlyPredicateCalls).toBe(0);

			await invokePredicateBulk(db.users, "deleteMany", (rows) =>
				rows.filter((row) => row.id === "u1").map((row) => String(row.id)),
			);
			await db.flush();
			expect(await readFile(join(docsRoot, "base.yaml"), "utf8")).not.toContain(
				"u1:",
			);
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("publishes declarations through core root exports and compiles in an exports-aware consumer", async () => {
		execFileSync(
			"bunx",
			["tsc", "--build", "packages/core", "packages/engine"],
			{
				cwd: WORKTREE_ROOT,
				stdio: "inherit",
			},
		);
		const distTypes = await readFile(
			join(WORKTREE_ROOT, "packages/engine/dist/types.d.ts"),
			"utf8",
		);
		expect(distTypes.includes("@proseql/core/")).toBe(false);
		const consumerRoot = await mkdtemp(
			join(WORKTREE_ROOT, ".tmp-engine-consumer-"),
		);
		try {
			await mkdir(join(consumerRoot, "node_modules", "@proseql"), {
				recursive: true,
			});
			await symlink(
				join(WORKTREE_ROOT, "packages/core"),
				join(consumerRoot, "node_modules", "@proseql", "core"),
			);
			await symlink(
				join(WORKTREE_ROOT, "packages/engine"),
				join(consumerRoot, "node_modules", "@proseql", "engine"),
			);
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
			initialize: () =>
				Effect.sync(() => {
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
				db.users.create({
					id: "u1",
					name: "Alice",
					role: "guest",
					marker: null,
				} as any),
			).rejects.toBeInstanceOf(ValidationError);
			await expect(
				db.users.create({
					id: "u2",
					name: "Alice",
					role: "admin",
					marker: "x",
				} as any),
			).rejects.toBeInstanceOf(ValidationError);
			await expect(
				db.users.create({
					id: "u3",
					name: "Alice",
					role: "admin",
					marker: null,
				}),
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
				await literalDb.users.create({
					id: "u4",
					name: "Carol",
					role: "admin",
					marker: null,
				}),
			).toEqual({ id: "u4", name: "Carol", role: "admin", marker: null });
			await literalDb.close();
			await db.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
