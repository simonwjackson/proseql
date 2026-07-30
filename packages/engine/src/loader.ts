import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export type WasmBindingsModule = {
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

export const loadWasmBindings = async (): Promise<WasmBindingsModule> => {
	if (!initPromise) {
		initPromise = (async () => {
			const wasmDir = await resolveWasmDir();
			return (await import(
				pathToFileURL(join(wasmDir, "proseql_wasm.js")).href
			)) as WasmBindingsModule;
		})();
	}
	return initPromise;
};

async function resolveWasmDir(): Promise<string> {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(currentDir, "wasm"), resolve(currentDir, "..", "dist", "wasm")];
	for (const candidate of candidates) {
		try {
			await access(join(candidate, "proseql_wasm.js"));
			await access(join(candidate, "proseql_wasm_bg.wasm"));
			return candidate;
		} catch {
			continue;
		}
	}
	throw new Error(
		"Missing proseql-wasm artifacts. Run `bun run --cwd packages/engine build:wasm` first.",
	);
}
