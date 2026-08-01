export type WasmBindingsModule = {
	default?: (input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module) => Promise<unknown>;
	__proseql_wasm_memory?: () => WebAssembly.Memory | undefined;
	WasmRuntime: new (
		setTimeoutFn: typeof globalThis.setTimeout,
		clearTimeoutFn: typeof globalThis.clearTimeout,
	) => WasmRuntimeBinding;
};

export interface WasmRuntimeBinding {
	register_default(id: string, callback: () => string): void;
	register_predicate(id: string, callback: (payloadJson: string) => string): void;
	register_computed(id: string, callback: (payloadJson: string) => string): void;
	register_collator(callback: (a: string, b: string) => number): void;
	register_migration(id: string, callback: (payloadJson: string) => string): void;
	register_id_generator(name: string, callback: () => string): void;
	register_before_create_hook(id: string, callback: (payloadJson: string) => string): void;
	register_before_update_hook(id: string, callback: (payloadJson: string) => string): void;
	register_before_delete_hook(id: string, callback: (payloadJson: string) => string): void;
	register_after_create_hook(id: string, callback: (payloadJson: string) => string): void;
	register_after_update_hook(id: string, callback: (payloadJson: string) => string): void;
	register_after_delete_hook(id: string, callback: (payloadJson: string) => string): void;
	register_on_change_hook(id: string, callback: (payloadJson: string) => string): void;
	register_custom_operator(
		name: string,
		supportedTypesJson: string,
		callback: (fieldJson: string, operandJson: string) => number | boolean,
	): string;
	create_database(inputJson: string): string;
	drop_database(handle: number): string;
	dispatch(handle: number, method: string, payloadJson?: string): string;
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
	dry_run_migrations(inputJson: string): string;
}

let initPromise: Promise<WasmBindingsModule> | undefined;

export const getLoadedWasmMemoryByteLength = async (): Promise<number | undefined> => {
	if (!initPromise) {
		return undefined;
	}
	const module = await initPromise;
	return module.__proseql_wasm_memory?.()?.buffer.byteLength;
};

export const loadWasmBindings = async (): Promise<WasmBindingsModule> => {
	if (!initPromise) {
		initPromise = isBrowserRuntime() ? loadBrowserBindings() : loadNodeBindings();
	}
	return initPromise;
};

const isBrowserRuntime = (): boolean =>
	typeof window !== "undefined" && typeof window.document !== "undefined";

const loadBrowserBindings = async (): Promise<WasmBindingsModule> => {
	// @ts-expect-error generated at build time by packages/engine/scripts/build-wasm.mjs
	const wasmModule = (await import("./browser-wasm/proseql_wasm.js")) as WasmBindingsModule;
	if (typeof wasmModule.default === "function") {
		await wasmModule.default(new URL("./browser-wasm/proseql_wasm_bg.wasm", import.meta.url));
	}
	return wasmModule;
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
	const candidates = [join(currentDir, "wasm"), resolve(currentDir, "..", "dist", "wasm")];
	for (const candidate of candidates) {
		try {
			await access(join(candidate, "proseql_wasm.js"));
			await access(join(candidate, "proseql_wasm_bg.wasm"));
			return (await import(
				/* @vite-ignore */ pathToFileURL(join(candidate, "proseql_wasm.js")).href
			)) as WasmBindingsModule;
		} catch {
			continue;
		}
	}
	throw new Error(
		"Missing proseql-wasm artifacts. Run `bun run --cwd packages/engine build:wasm` first.",
	);
};

const importNode = async (specifier: string): Promise<unknown> =>
	import(/* @vite-ignore */ (`node:${specifier}` as string));
