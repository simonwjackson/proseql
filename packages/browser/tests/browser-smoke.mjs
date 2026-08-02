#!/usr/bin/env node

import { createServer as createViteServer } from "vite";
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const viteRoot = join(__dirname, "fixtures", "vite-app");
const staticRoot = join(__dirname, "fixtures", "plain-module");

const mimeTypes = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".ts": "application/typescript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
};

const createStaticServer = (rootDir, repoDir) =>
	http.createServer(async (req, res) => {
		try {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			const requested = pathname === "/" ? "/index.html" : pathname;
			const baseDir =
				requested.startsWith("/packages/") || requested.startsWith("/node_modules/")
					? repoDir
					: rootDir;
			const filePath = normalize(join(baseDir, requested));
			if (!filePath.startsWith(baseDir)) {
				res.writeHead(403).end("forbidden");
				return;
			}
			const body = await readFile(filePath);
			res.writeHead(200, {
				"content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
			});
			res.end(body);
		} catch (error) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end(String(error));
		}
	});

const listen = (server) =>
	new Promise((resolveListen) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				resolveListen(`http://127.0.0.1:${address.port}`);
			}
		});
	});

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const installPageLogging = (label, page) => {
	page.on("pageerror", (error) => console.error(`[${label}-pageerror]`, error));
	page.on("console", (message) => console.error(`[${label}-console:${message.type()}]`, message.text()));
};

const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROMIUM_EXECUTABLE_PATH
		? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
		: {}),
});
const vite = await createViteServer({
	root: viteRoot,
	server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const viteBase = vite.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ?? "http://127.0.0.1:5173";
const staticServer = createStaticServer(staticRoot, repoRoot);
const staticBase = await listen(staticServer);

try {
	const appPage = await browser.newPage();
	installPageLogging("vite", appPage);
	await appPage.goto(viteBase, { waitUntil: "networkidle" });
	await appPage.waitForFunction(() => Boolean(window.__PROSEQL_BROWSER_HARNESS__));

	const localResult = await appPage.evaluate(async () =>
		window.__PROSEQL_BROWSER_HARNESS__.localRoundTrip("vite-local-smoke:"),
	);
	assert(localResult.queried.length === 1, "Vite localStorage query should return one record");
	assert(localResult.reloaded.length === 1, "Vite localStorage reload should return one record");

	const indexedResult = await appPage.evaluate(async () =>
		window.__PROSEQL_BROWSER_HARNESS__.indexedDbRoundTrip(
			"vite-indexeddb-smoke",
			"vite-indexeddb-smoke:",
		),
	);
	assert(indexedResult.queried.length === 1, "Vite IndexedDB query should return one record");
	assert(indexedResult.reloaded.length === 1, "Vite IndexedDB reload should return one record");

	const localWatch = await appPage.evaluate(async () => {
		await window.__PROSEQL_BROWSER_HARNESS__.startLocalWatch("vite-local-watch:");
		await window.__PROSEQL_BROWSER_HARNESS__.createLocalRecord("vite-local-watch:", "Watcher Local");
		return window.__PROSEQL_BROWSER_HARNESS__.waitForLocalWatchRows(
			"vite-local-watch:",
			["book-3"],
		);
	});
	assert(localWatch.at(-1)?.length === 1, "Vite local watch should converge to one record");

	const indexedWatch = await appPage.evaluate(async () => {
		await window.__PROSEQL_BROWSER_HARNESS__.startIndexedDbWatch(
			"vite-indexeddb-watch",
			"vite-indexeddb-watch:",
		);
		await window.__PROSEQL_BROWSER_HARNESS__.createIndexedDbRecord(
			"vite-indexeddb-watch",
			"vite-indexeddb-watch:",
			"Watcher IndexedDB",
		);
		return window.__PROSEQL_BROWSER_HARNESS__.waitForIndexedDbWatchRows(
			"vite-indexeddb-watch",
			"vite-indexeddb-watch:",
			["book-4"],
		);
	});
	assert(indexedWatch.at(-1)?.length === 1, "Vite IndexedDB watch should converge to one record");

	const localRace = await appPage.evaluate(async () =>
		window.__PROSEQL_BROWSER_HARNESS__.localConcurrentRace("vite-local-race:"),
	);
	assert(localRace.reloaded.length === 2, "LocalStorage concurrent race should retain both records");
	assert(localRace.emissionsA.at(-1)?.length === 2, "LocalStorage watch A should converge");
	assert(localRace.emissionsB.at(-1)?.length === 2, "LocalStorage watch B should converge");

	const browserFifo = await appPage.evaluate(async () =>
		window.__PROSEQL_BROWSER_HARNESS__.browserOutsideTransactionFifo(
			"vite-browser-transaction-fifo:",
		),
	);
	assert(
		browserFifo.queuedBeforeRelease,
		"Browser root reads from outside the callback should remain FIFO queued",
	);
	assert(
		browserFifo.title === "Committed",
		"Browser FIFO read should observe committed transaction state",
	);

	const indexedRace = await appPage.evaluate(async () =>
		window.__PROSEQL_BROWSER_HARNESS__.indexedDbConcurrentRace(
			"vite-indexeddb-race",
			"vite-indexeddb-race:",
		),
	);
	assert(indexedRace.reloaded.length === 2, "IndexedDB concurrent race should retain both records");
	assert(indexedRace.emissionsA.at(-1)?.length === 2, "IndexedDB watch A should converge");
	assert(indexedRace.emissionsB.at(-1)?.length === 2, "IndexedDB watch B should converge");

	await appPage.evaluate(async () => window.__PROSEQL_BROWSER_HARNESS__.closeAll());
	await appPage.close();

	const plainPage = await browser.newPage();
	installPageLogging("plain", plainPage);
	await plainPage.goto(staticBase, { waitUntil: "networkidle" });
	await plainPage.waitForFunction(() => Boolean(window.__PROSEQL_PLAIN_MODULE_RESULT__));
	const plainResult = await plainPage.evaluate(() => window.__PROSEQL_PLAIN_MODULE_RESULT__);
	assert(plainResult.key === "plain-module:books.json", "Plain-module smoke should use the built import-map alias");
	assert(plainResult.defaultKey === "proseql:books.json", "Plain-module smoke should resolve built dist exports");
	await plainPage.close();
} finally {
	await browser.close();
	await vite.close();
	await new Promise((resolveClose, rejectClose) =>
		staticServer.close((error) => (error ? rejectClose(error) : resolveClose(undefined))),
	);
}
