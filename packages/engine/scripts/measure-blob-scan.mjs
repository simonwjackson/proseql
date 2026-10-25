// Synthetic text only. Run with Node --expose-gc after building the WASM/TS
// package. This measures the browser-compatible Blob slice path in Node, not a
// native query or a real browser. The file is never loaded in full.
import { openAsBlob } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJsonlBlob } from "../dist/host/blob-chunks.js";
import { getLoadedWasmMemoryByteLength } from "../dist/loader.js";

const directory = await mkdtemp(join(tmpdir(), "proseql-blob-scan-"));
try {
	const path = join(directory, "synthetic.jsonl");
	const line = `{"id":"${"x".repeat(1014)}"}\n`;
	const block = line.repeat(64);
	const file = await open(path, "w");
	try {
		for (let i = 0; i < 1600; i++) await file.write(block);
	} finally {
		await file.close();
	}
	// Initialize once before measuring the scan, just as an open browser host.
	await scanJsonlBlob(new Blob(), () => {});
	globalThis.gc?.();
	const before = process.memoryUsage();
	const wasmBefore = await getLoadedWasmMemoryByteLength();
	const peak = { ...before };
	const blob = await openAsBlob(path);
	let rows = 0;
	const sample = () => {
		const memory = process.memoryUsage();
		for (const key of Object.keys(peak))
			peak[key] = Math.max(peak[key], memory[key]);
	};
	const stats = await scanJsonlBlob(blob, (row) => {
		if (row.bytes.byteLength !== 1023)
			throw new Error("unexpected line length");
		rows++;
		if (rows % 1024 === 0) sample();
	});
	sample();
	const wasmAfter = await getLoadedWasmMemoryByteLength();
	await new Promise((resolve) => setTimeout(resolve, 1000));
	globalThis.gc?.();
	const after = process.memoryUsage();
	if (rows !== 102400 || stats.bytesRead !== 104857600)
		throw new Error("incomplete scan");
	console.log(
		JSON.stringify(
			{
				runtime: process.version,
				path: "Node openAsBlob -> Blob.slice.arrayBuffer -> WASM shared RowSource (not query execution)",
				stats: { ...stats, nextOrdinal: stats.nextOrdinal.toString() },
				before,
				peakSampled: peak,
				afterOneSecondAndGc: after,
				wasmLinearBytes: { before: wasmBefore, after: wasmAfter },
			},
			null,
			2,
		),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
