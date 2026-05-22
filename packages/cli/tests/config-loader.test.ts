import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../src/config/loader";

describe("Config Loader", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-loader-test-"));
	});

	afterEach(() => {
		if (fs.existsSync(tempRoot)) {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("should validate source-oriented configs without treating sources as a collection", async () => {
		const configPath = path.join(tempRoot, "proseql.config.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify(
				{
					collections: {
						books: {
							schema: "BookSchema",
							id: { kind: "derivedFromKey", field: "id" },
							relationships: {},
						},
					},
					sources: [
						{
							id: "library",
							kind: "documents",
							root: "./data",
							include: "**/*.yaml",
							format: "yaml",
							collections: "all",
							outbox: "generated.yaml",
						},
					],
				},
				null,
				2,
			),
		);

		const config = await Effect.runPromise(loadConfig(configPath));

		expect("collections" in config).toBe(true);
		expect("sources" in config).toBe(true);
	});

	it("should reject invalid source-oriented configs", async () => {
		const configPath = path.join(tempRoot, "proseql.config.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify(
				{
					collections: {
						books: {
							schema: "BookSchema",
							id: { kind: "derivedFromKey", field: "id" },
							relationships: {},
						},
					},
					sources: [
						{
							id: "library",
							kind: "documents",
							root: "./data",
							include: "**/*.yaml",
							format: "yaml",
							collections: ["authors"],
							outbox: "generated.yaml",
						},
					],
				},
				null,
				2,
			),
		);

		const error = await Effect.runPromise(
			loadConfig(configPath).pipe(Effect.flip),
		);

		expect(error).toBeInstanceOf(ConfigValidationError);
		expect(error.message).toContain("authors");
		expect(error.message).toContain("source");
	});
});
