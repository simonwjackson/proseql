declare module "./browser-wasm/proseql_wasm.js" {
	export default function init(
		input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module,
	): Promise<unknown>;

	export function __proseql_wasm_memory(): WebAssembly.Memory | undefined;

	export class WasmRuntime {
		constructor(
			setTimeoutFn: typeof globalThis.setTimeout,
			clearTimeoutFn: typeof globalThis.clearTimeout,
		);
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
		dispatch_projected(handle: number, method: string, payloadJson?: string): string;
		fast_find_by_id(
			handle: number,
			collectionIndex: number,
			id: string,
			expectedSlot: number,
			expectedGeneration: number,
			expectedRevision: number,
		): number;
		projection_handles(handle: number): string;
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
		dry_run_migrations(inputJson: string): string;
	}
}
