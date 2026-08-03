export type WasmBindingsModule = {
	default?: (
		input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module,
	) => Promise<unknown>;
	__proseql_wasm_memory?: () => WebAssembly.Memory | undefined;
	WasmRuntime: new (
		setTimeoutFn: typeof globalThis.setTimeout,
		clearTimeoutFn: typeof globalThis.clearTimeout,
	) => WasmRuntimeBinding;
};

export interface WasmRuntimeBinding {
	register_default(id: string, callback: () => string): void;
	register_predicate(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_computed(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_collator(callback: (a: string, b: string) => number): void;
	register_migration(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_id_generator(name: string, callback: () => string): void;
	register_before_create_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_before_update_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_before_delete_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_after_create_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_after_update_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_after_delete_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_on_change_hook(
		id: string,
		callback: (payloadJson: string) => string,
	): void;
	register_custom_operator(
		name: string,
		supportedTypesJson: string,
		callback: (fieldJson: string, operandJson: string) => number | boolean,
	): string;
	create_database(inputJson: string): string;
	drop_database(handle: number): string;
	dispatch(handle: number, method: string, payloadJson?: string): string;
	dispatch_projected(
		handle: number,
		method: string,
		payloadJson?: string,
	): string;
	begin_transaction(handle: number): string;
	transaction_step(
		sessionHandle: number,
		method: string,
		payloadJson?: string,
	): string;
	synchronize_transaction_projection(
		sessionHandle: number,
		rowsJson: string,
	): string;
	transaction_projection_handles(sessionHandle: number): string;
	commit_transaction(sessionHandle: number): string;
	rollback_transaction(sessionHandle: number): string;
	compact_create_many(
		handle: number,
		collectionIndex: number,
		itemsJson: string,
		single: boolean,
	): unknown;
	authorized_bulk_update(
		handle: number,
		collectionIndex: number,
		slots: Uint32Array,
		tokens: Float64Array,
		updatesJson: string,
	): unknown;
	authorized_bulk_delete(
		handle: number,
		collectionIndex: number,
		slots: Uint32Array,
		tokens: Float64Array,
		equalityField?: string,
		equalityJson?: string,
	): unknown;
	fast_find_by_id(
		handle: number,
		expectedSlot: number,
		authorizationToken: number,
	): number;
	fast_find_by_id_descriptor(
		handle: number,
		collectionIndex: number,
		id: string,
	): unknown;
	fast_query_range(
		handle: number,
		collectionIndex: number,
		expectedRevision: number,
		offset: number,
		len: number,
	): number;
	fast_projected_query_slots(
		handle: number,
		commandJson: string,
		collectionIndex: number,
		field: string,
		value: string,
		offset: number,
		limit: number,
	): unknown;
	take_callback_defect(): string | undefined;
	fast_index_query_revision(
		handle: number,
		collectionIndex: number,
		expectedRevision: number,
	): number;
	fast_selected_primitive_query(handle: number, commandJson: string): unknown;
	projection_handles(handle: number): string;
	projection_handles_preserving_materializations(handle: number): string;
	synchronize_projection(handle: number, rowsJson: string): string;
	subscribe_watch(
		handle: number,
		commandJson: string,
		callback: (payloadJson: string) => void,
	): string;
	subscribe_watch_by_id(
		handle: number,
		commandJson: string,
		callback: (payloadJson: string) => void,
	): string;
	unsubscribe(handle: number, subscriptionId: number): string;
}

export const WASM_RUNTIME_ABI_METHODS = [
	"register_default",
	"register_predicate",
	"register_computed",
	"register_collator",
	"register_migration",
	"register_id_generator",
	"register_before_create_hook",
	"register_before_update_hook",
	"register_before_delete_hook",
	"register_after_create_hook",
	"register_after_update_hook",
	"register_after_delete_hook",
	"register_on_change_hook",
	"register_custom_operator",
	"create_database",
	"drop_database",
	"dispatch",
	"dispatch_projected",
	"begin_transaction",
	"transaction_step",
	"synchronize_transaction_projection",
	"transaction_projection_handles",
	"commit_transaction",
	"rollback_transaction",
	"compact_create_many",
	"authorized_bulk_update",
	"authorized_bulk_delete",
	"fast_find_by_id",
	"fast_find_by_id_descriptor",
	"fast_query_range",
	"fast_projected_query_slots",
	"take_callback_defect",
	"fast_index_query_revision",
	"fast_selected_primitive_query",
	"projection_handles",
	"projection_handles_preserving_materializations",
	"synchronize_projection",
	"subscribe_watch",
	"subscribe_watch_by_id",
	"unsubscribe",
] as const satisfies ReadonlyArray<keyof WasmRuntimeBinding>;

const WASM_REBUILD_INSTRUCTION = "bun run --cwd packages/engine build:wasm";

export class WasmBindingsAbiError extends Error {
	readonly missingMethods: ReadonlyArray<string>;

	constructor(missingMethods: ReadonlyArray<string>) {
		super(
			`Stale or incompatible proseql-wasm bindings: missing WasmRuntime method(s): ${missingMethods.join(", ")}. Rebuild with \`${WASM_REBUILD_INSTRUCTION}\`.`,
		);
		this.name = "WasmBindingsAbiError";
		this.missingMethods = missingMethods;
	}
}

export const assertWasmBindingsAbi: (
	module: unknown,
) => asserts module is WasmBindingsModule = (module) => {
	const runtime =
		typeof module === "object" && module !== null && "WasmRuntime" in module
			? (module as { readonly WasmRuntime?: unknown }).WasmRuntime
			: undefined;
	if (typeof runtime !== "function") {
		throw new WasmBindingsAbiError(["WasmRuntime constructor"]);
	}
	const prototype = runtime.prototype as Record<string, unknown> | undefined;
	const missingMethods = WASM_RUNTIME_ABI_METHODS.filter(
		(method) => typeof prototype?.[method] !== "function",
	);
	if (missingMethods.length > 0) {
		throw new WasmBindingsAbiError(missingMethods);
	}
};

let initPromise: Promise<WasmBindingsModule> | undefined;

export const getLoadedWasmMemoryByteLength = async (): Promise<
	number | undefined
> => {
	if (!initPromise) {
		return undefined;
	}
	const module = await initPromise;
	return module.__proseql_wasm_memory?.()?.buffer.byteLength;
};

export const loadWasmBindings = async (): Promise<WasmBindingsModule> => {
	if (!initPromise) {
		initPromise = isBrowserRuntime()
			? loadBrowserBindings()
			: loadNodeBindings();
	}
	return initPromise;
};

const isBrowserRuntime = (): boolean =>
	typeof window !== "undefined" && typeof window.document !== "undefined";

export const initializeBrowserWasmBindings = async (
	module: unknown,
	wasmUrl: URL,
): Promise<WasmBindingsModule> => {
	assertWasmBindingsAbi(module);
	if (typeof module.default === "function") {
		await module.default(wasmUrl);
	}
	return module;
};

const loadBrowserBindings = async (): Promise<WasmBindingsModule> => {
	const wasmModule: unknown = await import(
		// @ts-expect-error generated at build time by packages/engine/scripts/build-wasm.mjs
		"./browser-wasm/proseql_wasm.js"
	);
	return initializeBrowserWasmBindings(
		wasmModule,
		new URL("./browser-wasm/proseql_wasm_bg.wasm", import.meta.url),
	);
};

const loadNodeBindings = async (): Promise<WasmBindingsModule> => {
	const [{ access }, pathModule, urlModule] = await Promise.all([
		importNode("fs/promises") as Promise<typeof import("node:fs/promises")>,
		importNode("path") as Promise<typeof import("node:path")>,
		importNode("url") as Promise<typeof import("node:url")>,
	]);
	const { dirname, join, resolve } = pathModule;
	const { pathToFileURL, fileURLToPath } = urlModule;
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(currentDir, "wasm"),
		resolve(currentDir, "..", "dist", "wasm"),
	];
	let importFailure: unknown;
	for (const candidate of candidates) {
		try {
			await access(join(candidate, "proseql_wasm.js"));
			await access(join(candidate, "proseql_wasm_bg.wasm"));
		} catch {
			continue;
		}
		let module: unknown;
		try {
			module = await import(
				/* @vite-ignore */ pathToFileURL(join(candidate, "proseql_wasm.js"))
					.href
			);
		} catch (error) {
			importFailure = error;
			continue;
		}
		// Compatibility failures are actionable and must not be hidden by trying
		// another generated-artifact directory.
		assertWasmBindingsAbi(module);
		return module;
	}
	if (importFailure !== undefined) {
		throw new Error(
			`Failed to import proseql-wasm artifacts. Rebuild with \`${WASM_REBUILD_INSTRUCTION}\`.`,
			{ cause: importFailure },
		);
	}
	throw new Error(
		`Missing proseql-wasm artifacts. Run \`${WASM_REBUILD_INSTRUCTION}\` first.`,
	);
};

const importNode = async (specifier: string): Promise<unknown> =>
	import(/* @vite-ignore */ `node:${specifier}` as string);
