import type * as BrowserShim from "@proseql/browser";
import type * as WorkerShim from "@proseql/browser/worker";
import type * as Browser from "@proseql/effect/browser";
import type * as Worker from "@proseql/effect/browser/worker";
import type * as Node from "@proseql/effect/node";
import type * as NodeShim from "@proseql/node";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Assert<T extends true> = T;

/** Checked by the existing support typecheck, including type-only public names. */
export type ShimContracts = readonly [
	Assert<Equal<typeof NodeShim, typeof Node>>,
	Assert<Equal<typeof BrowserShim, typeof Browser>>,
	Assert<Equal<typeof WorkerShim, typeof Worker>>,
	Assert<Equal<NodeShim.NodeAdapterConfig, Node.NodeAdapterConfig>>,
	Assert<
		Equal<
			BrowserShim.BrowserEngineStorageHost,
			Browser.BrowserEngineStorageHost
		>
	>,
	Assert<
		Equal<
			BrowserShim.BrowserStorageHostConfig,
			Browser.BrowserStorageHostConfig
		>
	>,
	Assert<Equal<BrowserShim.EngineStorageHost, Browser.EngineStorageHost>>,
	Assert<
		Equal<BrowserShim.EngineStorageWatchEvent, Browser.EngineStorageWatchEvent>
	>,
	Assert<
		Equal<
			BrowserShim.IndexedDBEngineHostConfig,
			Browser.IndexedDBEngineHostConfig
		>
	>,
	Assert<
		Equal<
			BrowserShim.LocalStorageEngineStorageHostConfig,
			Browser.LocalStorageEngineStorageHostConfig
		>
	>,
	Assert<
		Equal<
			BrowserShim.SessionStorageEngineStorageHostConfig,
			Browser.SessionStorageEngineStorageHostConfig
		>
	>,
	Assert<
		Equal<
			BrowserShim.WebStorageEngineHostConfig,
			Browser.WebStorageEngineHostConfig
		>
	>,
	Assert<Equal<BrowserShim.IndexedDBConfig, Browser.IndexedDBConfig>>,
	Assert<Equal<BrowserShim.WatchImplementation, Browser.WatchImplementation>>,
	Assert<Equal<BrowserShim.WebStorageConfig, Browser.WebStorageConfig>>,
	Assert<
		Equal<
			WorkerShim.ServiceWorkerIndexedDBEngineHostConfig,
			Worker.ServiceWorkerIndexedDBEngineHostConfig
		>
	>,
];
