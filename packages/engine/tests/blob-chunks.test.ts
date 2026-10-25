import { describe, expect, it } from "bun:test";
import { type RawJsonlRow, scanJsonlBlob } from "../src/browser.js";

const text = new TextDecoder();

describe("browser Blob chunk path through the WASM RowSource", () => {
	it("frames UTF-8, CRLF, blanks and a torn suffix at every chunk size", async () => {
		const input = new TextEncoder().encode(
			'{"id":"é🚀"}\r\n \n{"id":"b"}\n{"id":"',
		);
		const blob = new Blob([input, new Uint8Array([0xc3])]);
		for (const chunkBytes of [1, 2, 3, 7, 64, blob.size + 1]) {
			const rows: RawJsonlRow[] = [];
			const stats = await scanJsonlBlob(blob, (row) => rows.push(row), {
				chunkBytes,
				firstOrdinal: 10n,
				partition: 3,
			});
			expect(
				rows.map((row) => ({ ...row, bytes: text.decode(row.bytes) })),
			).toEqual([
				{
					bytes: '{"id":"é🚀"}',
					partition: 3,
					offset: 0n,
					ordinal: 10n,
					finalUnterminated: false,
				},
				{
					bytes: '{"id":"b"}',
					partition: 3,
					offset: 19n,
					ordinal: 11n,
					finalUnterminated: false,
				},
				{
					bytes: '{"id":"�',
					partition: 3,
					offset: 30n,
					ordinal: 12n,
					finalUnterminated: true,
				},
			]);
			expect(rows[2].bytes.at(-1)).toBe(0xc3);
			expect(stats.rows).toBe(3);
			expect(stats.nextOrdinal).toBe(13n);
			expect(stats.bytesRead).toBe(blob.size);
			expect(stats.maxChunkBytes).toBeLessThanOrEqual(chunkBytes);
		}
	});

	it("keeps absolute offsets when starting at a seek boundary", async () => {
		const rows: RawJsonlRow[] = [];
		const stats = await scanJsonlBlob(
			new Blob(["a\r\n\nb\nlast"]),
			(row) => rows.push(row),
			{
				startOffset: 4,
				firstOrdinal: 20n,
				chunkBytes: 1,
			},
		);
		expect(
			rows.map((row) => [
				text.decode(row.bytes),
				row.offset,
				row.ordinal,
				row.finalUnterminated,
			]),
		).toEqual([
			["b", 4n, 20n, false],
			["last", 6n, 21n, true],
		]);
		expect(stats.nextOrdinal).toBe(22n);
	});

	it("handles empty input and rejects invalid boundary arguments before loading", async () => {
		const stats = await scanJsonlBlob(new Blob(), () => {
			throw new Error("no rows");
		});
		expect(stats.rows).toBe(0);
		for (const chunkBytes of [
			0,
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			await expect(
				scanJsonlBlob(new Blob(), () => {}, { chunkBytes }),
			).rejects.toBeInstanceOf(RangeError);
		}
		await expect(
			scanJsonlBlob(new Blob(), () => {}, { firstOrdinal: -1n }),
		).rejects.toBeInstanceOf(RangeError);
		await expect(
			scanJsonlBlob(new Blob(), () => {}, { partition: 2 ** 32 }),
		).rejects.toBeInstanceOf(RangeError);
	});

	it("propagates visitor failures and releases its scanner for later calls", async () => {
		const failure = new Error("visitor failed");
		await expect(
			scanJsonlBlob(new Blob(["a\nb\n"]), () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect((await scanJsonlBlob(new Blob(["ok"]), () => {})).rows).toBe(1);
	});
});
