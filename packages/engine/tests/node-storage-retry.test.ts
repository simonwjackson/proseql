import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createNodeEngineStorageHost } from "../src/storage-host.js";

describe("Node engine storage retries", () => {
	it("retries a missing-file read within the configured limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-host-retry-"));
		const path = join(root, "eventual.txt");
		const host = createNodeEngineStorageHost({ maxRetries: 1, baseDelay: 100 });
		const createFile = setTimeout(() => void writeFile(path, "ready"), 20);
		try {
			expect(await host.read(path)).toBe("ready");
		} finally {
			clearTimeout(createFile);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retries write, append, remove and ensureDir failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-host-retry-"));
		const host = createNodeEngineStorageHost({
			maxRetries: 1,
			baseDelay: 100,
			createMissingDirectories: false,
		});
		try {
			await mkdir(join(root, "blocked"));
			await writeFile(join(root, "blocked", "parent"), "not a directory");
			const recovery = async () => {
				await sleep(20);
				await mkdir(join(root, "write"));
				await mkdir(join(root, "append"));
				await writeFile(join(root, "remove.txt"), "remove me");
				await rm(join(root, "blocked", "parent"));
			};
			// Keep every operation observed until recovery finishes, including
			// when a missing retry causes an early rejection.
			const results = await Promise.allSettled([
				host.write(join(root, "write", "data.txt"), "written"),
				host.append(join(root, "append", "data.txt"), "appended"),
				host.remove(join(root, "remove.txt")),
				host.ensureDir(join(root, "blocked", "parent", "data.txt")),
				recovery(),
			]);
			expect(results.map((result) => result.status)).toEqual(
				Array(5).fill("fulfilled"),
			);
			expect(await readFile(join(root, "write", "data.txt"), "utf8")).toBe(
				"written",
			);
			expect(await readFile(join(root, "append", "data.txt"), "utf8")).toBe(
				"appended",
			);
			expect(await host.exists(join(root, "remove.txt"))).toBe(false);
			expect(await host.exists(join(root, "blocked", "parent"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not retry when maxRetries is zero", async () => {
		const root = await mkdtemp(join(tmpdir(), "proseql-host-retry-"));
		const host = createNodeEngineStorageHost({ maxRetries: 0 });
		try {
			await expect(host.read(join(root, "missing.txt"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(
				host.remove(join(root, "missing.txt")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(await host.exists(join(root, "missing.txt"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
