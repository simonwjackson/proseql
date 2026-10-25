import { OperationError } from "@proseql/core";
import { loadWasmBindings } from "../loader.js";

export interface RawJsonlRow {
	readonly bytes: Uint8Array;
	readonly partition: number;
	readonly offset: bigint;
	readonly ordinal: bigint;
	readonly finalUnterminated: boolean;
}

export interface BlobScanOptions {
	readonly chunkBytes?: number;
	/** Must be a physical line boundary. */
	readonly startOffset?: number;
	readonly firstOrdinal?: bigint;
	readonly partition?: number;
}

export interface BlobScanStats {
	readonly rows: number;
	readonly bytesRead: number;
	readonly maxChunkBytes: number;
	readonly maxFramerBytes: number;
	readonly nextOrdinal: bigint;
}

const safeInteger = (name: string, value: number, minimum: number): void => {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
	}
};

/**
 * Additive raw-row host path for browser File/Blob inputs. Reads only slices,
 * never text() or a whole-file arrayBuffer(). The Rust RowSource handles UTF-8
 * splits, CRLF and final-line classification. The synchronous visitor owns its
 * row bytes; retaining rows costs caller memory. This does not decode, validate
 * or query records, and does not enable native-only lazy partitions in WASM.
 */
export const scanJsonlBlob = async (
	blob: Blob,
	onRow: (row: RawJsonlRow) => void,
	options: BlobScanOptions = {},
): Promise<BlobScanStats> => {
	const chunkBytes = options.chunkBytes ?? 64 * 1024;
	const startOffset = options.startOffset ?? 0;
	const partition = options.partition ?? 0;
	const firstOrdinal = options.firstOrdinal ?? 0n;
	safeInteger("chunkBytes", chunkBytes, 1);
	safeInteger("startOffset", startOffset, 0);
	safeInteger("blob.size", blob.size, 0);
	safeInteger("partition", partition, 0);
	if (partition > 0xffff_ffff) {
		throw new RangeError("partition must fit u32");
	}
	if (firstOrdinal < 0n || firstOrdinal > 0xffff_ffff_ffff_ffffn) {
		throw new RangeError("firstOrdinal must fit u64");
	}
	const bindings = await loadWasmBindings();
	const Scanner = bindings.JsonlChunkScanner;
	if (Scanner === undefined) {
		throw new OperationError({
			operation: "scan-jsonl-blob",
			reason: "wasm-chunk-scanner-unavailable",
			message: "Rebuild WASM bindings to use the additive JSONL chunk path",
		});
	}
	const scanner = new Scanner(partition, BigInt(startOffset), firstOrdinal);
	let rows = 0;
	let bytesRead = 0;
	let maxChunkBytes = 0;
	let maxFramerBytes = 0;
	const visit = (
		bytes: Uint8Array,
		rowPartition: number,
		offset: bigint,
		ordinal: bigint,
		finalUnterminated: boolean,
	): void =>
		onRow({
			bytes,
			partition: rowPartition,
			offset,
			ordinal,
			finalUnterminated,
		});
	try {
		for (let offset = startOffset; offset < blob.size; ) {
			const end = offset + Math.min(chunkBytes, blob.size - offset);
			const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
			if (chunk.byteLength !== end - offset) {
				throw new Error("Blob slice returned an unexpected byte length");
			}
			rows += scanner.push(chunk, false, visit);
			bytesRead += chunk.byteLength;
			maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
			maxFramerBytes = Math.max(maxFramerBytes, scanner.buffered_bytes());
			offset = end;
		}
		rows += scanner.push(new Uint8Array(), true, visit);
		maxFramerBytes = Math.max(maxFramerBytes, scanner.buffered_bytes());
		return {
			rows,
			bytesRead,
			maxChunkBytes,
			maxFramerBytes,
			nextOrdinal: scanner.next_ordinal(),
		};
	} finally {
		scanner.free();
	}
};
