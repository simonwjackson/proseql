// Real Chromium evidence for the additive raw-row path. A File selected from
// synthetic text on disk supplies slices; the source is not a resident Blob.
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = await mkdtemp(join(tmpdir(), "proseql-browser-blob-scan-"));
let browser;
let server;
try {
	const path = join(directory, "synthetic.jsonl");
	const block = `{"id":"${"x".repeat(1014)}"}\n`.repeat(64);
	const file = await open(path, "w");
	try {
		for (let i = 0; i < 1600; i++) await file.write(block);
	} finally {
		await file.close();
	}
	server = await createServer({
		root,
		server: { host: "127.0.0.1", port: 0 },
		plugins: [
			{
				name: "synthetic-blob-scan",
				configureServer(vite) {
					vite.middlewares.use("/__blob_scan", (_request, response) => {
						response.setHeader("Content-Type", "text/html");
						response.end('<!doctype html><input type="file" id="source">');
					});
				},
			},
		],
	});
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		args: ["--enable-precise-memory-info"],
		...(process.env.CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
			: {}),
	});
	const page = await browser.newPage();
	await page.goto(`${server.resolvedUrls.local[0]}__blob_scan`);
	await page.setInputFiles("#source", path);
	await page.evaluate(async () => {
		const { scanJsonlBlob } = await import("/packages/engine/dist/browser.js");
		await scanJsonlBlob(new Blob(), () => {});
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.collectGarbage");
	const evidence = await page.evaluate(async () => {
		const { scanJsonlBlob } = await import("/packages/engine/dist/browser.js");
		const { getLoadedWasmMemoryByteLength } = await import(
			"/packages/engine/dist/loader.js"
		);
		const file = document.getElementById("source").files[0];
		const before = performance.memory.usedJSHeapSize;
		const wasmBefore = await getLoadedWasmMemoryByteLength();
		let peak = before;
		let rows = 0;
		const stats = await scanJsonlBlob(file, (row) => {
			if (row.bytes.byteLength !== 1023)
				throw new Error("unexpected line length");
			rows++;
			if (rows % 1024 === 0)
				peak = Math.max(peak, performance.memory.usedJSHeapSize);
		});
		peak = Math.max(peak, performance.memory.usedJSHeapSize);
		const wasmAfter = await getLoadedWasmMemoryByteLength();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		if (rows !== 102400 || stats.bytesRead !== 104857600)
			throw new Error("incomplete scan");
		return {
			stats: { ...stats, nextOrdinal: stats.nextOrdinal.toString() },
			jsHeapBytes: {
				before,
				peakSampled: peak,
				afterOneSecond: performance.memory.usedJSHeapSize,
			},
			wasmLinearBytes: { before: wasmBefore, after: wasmAfter },
		};
	});
	await cdp.send("HeapProfiler.collectGarbage");
	const afterGc = await cdp.send("Runtime.getHeapUsage");
	console.log(
		JSON.stringify(
			{
				runtime: await browser.version(),
				path: "Chromium File -> Blob.slice.arrayBuffer -> WASM shared RowSource (not query execution)",
				...evidence,
				jsHeapAfterGc: afterGc.usedSize,
			},
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	await server?.close();
	await rm(directory, { recursive: true, force: true });
}
